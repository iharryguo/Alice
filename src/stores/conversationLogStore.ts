import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { ChatMessage } from '../types/chat'
import { useGeneralStore } from './generalStore'
import { useConversationStore } from './conversationStore'

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

function createSessionId(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function hasBridge(): boolean {
  return typeof window !== 'undefined' && !!window.aliceIPC
}

/**
 * 入库前把内联图片（截图是 base64 data URL，动辄几百 KB）换成一句占位，
 * 否则会话库会被截图撑爆。历史消息本来也不会把旧图再发给模型。
 */
function sanitizeContentForStorage(content: unknown): unknown {
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
    return part
  })
}

/**
 * 会话历史的渲染侧门面：
 * - 把聊天记录同步到主进程 SQLite（防抖，关掉窗口也不丢）
 * - 列会话 / 搜索 / 恢复 / 删除
 */
export const useConversationLogStore = defineStore('conversationLog', () => {
  const sessionId = ref<string>(createSessionId())
  const sessions = ref<SessionSummary[]>([])
  const searchResults = ref<SessionSearchHit[]>([])
  const isLoading = ref(false)
  const lastSyncedAt = ref<number>(0)
  const error = ref<string | null>(null)

  let syncTimer: number | null = null

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

  const syncNow = async () => {
    if (!hasBridge()) return
    const messages = collectMessages()
    if (messages.length === 0) return

    try {
      await window.aliceIPC.invoke('conversation-log:sync', {
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
      lastSyncedAt.value = Date.now()
      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      console.error('[ConversationLog] 同步失败:', err)
    }
  }

  const scheduleSync = (delay = 1200) => {
    if (syncTimer !== null) window.clearTimeout(syncTimer)
    syncTimer = window.setTimeout(() => {
      syncTimer = null
      void syncNow()
    }, delay)
  }

  const flush = async () => {
    if (syncTimer !== null) {
      window.clearTimeout(syncTimer)
      syncTimer = null
    }
    await syncNow()
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
    await flush()
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
          tool_calls: Array.isArray(message.toolCalls)
            ? (message.toolCalls as any[])
            : undefined,
        }))

      const generalStore = useGeneralStore()
      const conversationStore = useConversationStore()

      sessionId.value = id
      generalStore.chatHistory = restored.reverse()
      conversationStore.currentResponseId = null
      generalStore.setAudioState(
        generalStore.isRecordingRequested ? 'LISTENING' : 'IDLE'
      )
      generalStore.statusMessage = `已恢复会话（${restored.length} 条消息）`
      return true
    } catch (err) {
      console.error('[ConversationLog] 恢复会话失败:', err)
      return false
    }
  }

  const startNewSession = async () => {
    await flush()
    sessionId.value = createSessionId()
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

  return {
    sessionId,
    sessions,
    searchResults,
    isLoading,
    lastSyncedAt,
    error,
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
