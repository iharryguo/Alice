import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ChatMessage } from '../types/chat'
import { useGeneralStore } from './generalStore'
import { useConversationStore } from './conversationStore'
import { logEvent } from '../utils/logger'
import { settleMemories, snapshotConversation } from '../modules/memory/autoMemory'
import {
  getConversationSessionId,
  markSessionRestored,
  rotateConversationSessionId,
  setConversationSessionId,
} from '../utils/conversationSession'

export interface SessionSummary {
  id: string
  title: string
  messageCount: number
  createdAt: number
  updatedAt: number
  preview: string
}

export interface SessionSearchHit {
  sessionId: string
  title: string
  role: string
  createdAt: number
  snippet: string
}

interface StoredMessage {
  id: string
  role: string
  content: unknown
  createdAt: number
  toolCalls?: unknown
  toolCallId?: string | null
  name?: string | null
}

/** 单条消息最多存这么多字，避免一次粘贴几十页 PDF 把会话库撑爆 */
const MAX_TEXT_CHARS = 20000

function hasBridge(): boolean {
  return typeof window !== 'undefined' && !!window.aliceIPC
}

function clipText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text
  return `${text.slice(0, MAX_TEXT_CHARS)}\n…（已截断 ${text.length - MAX_TEXT_CHARS} 字）`
}

/**
 * 入库前把内容变成一定能 JSON 序列化的形状：
 * - 内联图片是 base64 data URL，动辄几百 KB，换成一句占位；
 * - app_error 里的 originalError 是 Error 对象，可能带循环引用，
 *   之前整条消息 JSON.stringify 抛异常，整次同步静默失败；
 * - 超长文本截断。
 */
function sanitizeContentForStorage(content: unknown): unknown {
  if (typeof content === 'string') return clipText(content)
  if (!Array.isArray(content)) return content

  return content.map(part => {
    const type = (part as any)?.type
    const uri = (part as any)?.uri

    if (
      type === 'app_image_uri' &&
      typeof uri === 'string' &&
      uri.startsWith('data:')
    ) {
      return { type: 'app_text', text: '（此前发送过一张截图）' }
    }

    if (type === 'app_error') {
      const text = String((part as any)?.text || '请求失败')
      return { type: 'app_text', text: clipText(`[错误] ${text}`) }
    }

    if (type === 'app_text' && typeof (part as any)?.text === 'string') {
      return { ...(part as any), text: clipText((part as any).text) }
    }

    try {
      // 其他未知 part 只留可序列化的字段，避免把 Error/函数带进 IPC
      return JSON.parse(JSON.stringify(part))
    } catch {
      return { type: 'app_text', text: '[无法保存的内容]' }
    }
  })
}

/**
 * 会话历史的渲染侧门面：
 * - 把聊天记录同步到主进程 SQLite（防抖，关掉窗口也不丢）
 * - 列会话 / 搜索 / 恢复 / 删除
 *
 * 自动同步放在 store 里而不是某个组件里：只要 store 被创建过一次，
 * 不管界面切到记忆、设置还是收起成头像球，聊天记录都会继续落库。
 */
export const useConversationLogStore = defineStore('conversationLog', () => {
  const sessionId = ref<string>(getConversationSessionId())
  const sessions = ref<SessionSummary[]>([])
  const searchResults = ref<SessionSearchHit[]>([])
  const isLoading = ref(false)
  const lastSyncedAt = ref<number>(0)
  const error = ref<string | null>(null)
  const started = ref(false)

  let syncTimer: number | null = null
  /** 串行化：两次同步同时跑时，后一次可能先删后写，把消息写丢 */
  let syncChain: Promise<boolean> = Promise.resolve(true)

  const collectMessages = (): ChatMessage[] => {
    const generalStore = useGeneralStore()
    return generalStore.chatHistory
      .filter(
        message =>
          (message.role === 'user' || message.role === 'assistant') &&
          message.content !== undefined &&
          message.content !== null
      )
      .slice()
      .reverse()
  }

  const syncNow = async (reason = 'auto'): Promise<boolean> => {
    if (!hasBridge()) return false
    const messages = collectMessages()
    if (messages.length === 0) return false

    const run = async (): Promise<boolean> => {
      try {
        const result = await window.aliceIPC.invoke('conversation-log:sync', {
          sessionId: sessionId.value,
          messages: messages.map(message => ({
            id: message.local_id_temp || message.id,
            role: message.role,
            content: sanitizeContentForStorage(message.content),
            created_at: message.created_at,
            tool_calls: message.tool_calls,
            tool_call_id: message.tool_call_id,
            name: message.name,
          })),
        })

        // 以前只 try/catch 网络异常，主进程返回 { success:false } 时当作成功，
        // 于是"历史一直是空的"没有任何痕迹可查。
        if (result && result.success === false) {
          error.value = result.error || '主进程拒绝保存'
          logEvent(
            'history',
            'sync.rejected',
            { reason, error: error.value, count: messages.length },
            'warn'
          )
          return false
        }

        lastSyncedAt.value = Date.now()
        error.value = null
        if (reason !== 'auto') {
          logEvent('history', 'sync.ok', {
            reason,
            count: messages.length,
            sessionId: sessionId.value,
          })
        }
        return true
      } catch (err) {
        error.value = err instanceof Error ? err.message : String(err)
        logEvent(
          'history',
          'sync.failed',
          { reason, error: error.value, count: messages.length },
          'error'
        )
        return false
      }
    }

    syncChain = syncChain.then(run, run)
    return syncChain
  }

  const scheduleSync = (delay = 1200) => {
    if (syncTimer !== null) window.clearTimeout(syncTimer)
    syncTimer = window.setTimeout(() => {
      syncTimer = null
      void syncNow()
    }, delay)
  }

  const flush = async (reason = 'flush'): Promise<boolean> => {
    if (syncTimer !== null) {
      window.clearTimeout(syncTimer)
      syncTimer = null
    }
    return syncNow(reason)
  }

  const refreshSessions = async () => {
    if (!hasBridge()) return
    isLoading.value = true
    try {
      const result = await window.aliceIPC.invoke(
        'conversation-log:list-sessions',
        { limit: 200 }
      )
      sessions.value = Array.isArray(result) ? result : []
    } catch (err) {
      console.error('[ConversationLog] 读取会话列表失败:', err)
    } finally {
      isLoading.value = false
    }
  }

  const search = async (query: string) => {
    if (!hasBridge()) return
    const keyword = query.trim()
    if (!keyword) {
      searchResults.value = []
      return
    }
    isLoading.value = true
    try {
      const result = await window.aliceIPC.invoke('conversation-log:search', {
        query: keyword,
        limit: 60,
      })
      searchResults.value = Array.isArray(result) ? result : []
    } catch (err) {
      console.error('[ConversationLog] 搜索失败:', err)
      searchResults.value = []
    } finally {
      isLoading.value = false
    }
  }

  const loadSession = async (id: string): Promise<boolean> => {
    if (!hasBridge()) return false
    // 切走之前先把当前这段对话的记忆整理掉：历史一旦换成别人的，
    // 这段说过的事就再也没机会进记忆库了。
    const outgoing = snapshotConversation()
    if (outgoing.length > 0) {
      void settleMemories('session-switch', {
        messages: outgoing,
        force: true,
      })
    }
    await flush('before-restore')
    try {
      const stored = (await window.aliceIPC.invoke(
        'conversation-log:get-messages',
        { sessionId: id }
      )) as StoredMessage[]

      if (!Array.isArray(stored) || stored.length === 0) return false

      const restored: ChatMessage[] = stored
        .filter(message => message.role === 'user' || message.role === 'assistant')
        .map(message => ({
          role: message.role as ChatMessage['role'],
          content: message.content as ChatMessage['content'],
          created_at: message.createdAt,
        }))
        .filter(message => {
          // 带 tool_calls 的助手消息已经找不到对应的工具结果（历史里只存了
          // 用户与助手），原样回放会给模型一串没有输出的 function_call，
          // 直接被服务商拒掉。这里只保留有正文的消息。
          if (typeof message.content === 'string') {
            return message.content.trim().length > 0
          }
          if (!Array.isArray(message.content)) return false
          const text = message.content
            .filter((part: any) => part?.type === 'app_text')
            .map((part: any) => String(part.text || ''))
            .join('')
          const hasImage = message.content.some(
            (part: any) => part?.type === 'app_image_uri' && part?.uri
          )
          return text.trim().length > 0 || hasImage
        })

      const generalStore = useGeneralStore()
      const conversationStore = useConversationStore()

      sessionId.value = id
      setConversationSessionId(id)
      // 恢复出来的会话要接得上前文：放宽条数上限，由输入构建按字符预算截断
      markSessionRestored(true)
      generalStore.chatHistory = restored.reverse()
      conversationStore.currentResponseId = null
      generalStore.setAudioState(
        generalStore.isRecordingRequested ? 'LISTENING' : 'IDLE'
      )
      generalStore.statusMessage = `已恢复会话（${restored.length} 条消息）`
      logEvent('history', 'session.restored', { sessionId: id, count: restored.length })
      return true
    } catch (err) {
      console.error('[ConversationLog] 恢复会话失败:', err)
      logEvent(
        'history',
        'session.restore.failed',
        { sessionId: id, error: err instanceof Error ? err.message : String(err) },
        'error'
      )
      return false
    }
  }

  const startNewSession = async () => {
    const outgoing = snapshotConversation()
    if (outgoing.length > 0) {
      void settleMemories('session-switch', {
        messages: outgoing,
        force: true,
      })
    }
    await flush('before-new-session')
    sessionId.value = rotateConversationSessionId()
    markSessionRestored(false)
    const generalStore = useGeneralStore()
    const conversationStore = useConversationStore()
    generalStore.chatHistory = []
    conversationStore.currentResponseId = null
    generalStore.statusMessage = '新的对话'
    await refreshSessions()
  }

  const deleteSessionById = async (id: string) => {
    if (!hasBridge()) return
    try {
      await window.aliceIPC.invoke('conversation-log:delete-session', {
        sessionId: id,
      })
      sessions.value = sessions.value.filter(item => item.id !== id)
      searchResults.value = searchResults.value.filter(
        item => item.sessionId !== id
      )
    } catch (err) {
      console.error('[ConversationLog] 删除会话失败:', err)
    }
  }

  /**
   * 启动自动同步。由 App.vue 在挂载时调用一次；
   * 重复调用无副作用，避免 HMR 或重建组件时挂上多份监听。
   */
  const start = () => {
    if (started.value || !hasBridge()) return
    started.value = true

    const generalStore = useGeneralStore()
    watch(
      () => {
        const list = generalStore.chatHistory
        const newest = list[0]
        let tailLength = 0
        if (newest) {
          if (typeof newest.content === 'string') tailLength = newest.content.length
          else if (Array.isArray(newest.content)) {
            tailLength = newest.content.reduce(
              (sum, part) => sum + ((part as any)?.text?.length || 0),
              0
            )
          }
        }
        // 长度变化 + 最后一条文本增长（流式）都要触发
        return `${list.length}:${tailLength}`
      },
      () => scheduleSync(),
      { flush: 'post' }
    )

    window.addEventListener('beforeunload', handleUnload)
    void refreshSessions()
  }

  function handleUnload() {
    // 关窗口时来不及等异步结果，但 sync 本身很快（本地 SQLite），
    // 主进程的隐藏/退出握手还会再兜一次底。
    void flush('beforeunload')
  }

  const stop = () => {
    if (syncTimer !== null) {
      window.clearTimeout(syncTimer)
      syncTimer = null
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', handleUnload)
    }
    started.value = false
  }

  return {
    sessionId,
    sessions,
    searchResults,
    isLoading,
    lastSyncedAt,
    error,
    started,
    start,
    stop,
    syncNow,
    scheduleSync,
    flush,
    refreshSessions,
    search,
    loadSession,
    startNewSession,
    deleteSessionById,
  }
})
