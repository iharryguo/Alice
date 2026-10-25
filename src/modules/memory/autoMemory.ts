import { useGeneralStore } from '../../stores/generalStore'
import { useSettingsStore } from '../../stores/settingsStore'
import * as api from '../../services/apiService'
import { logEvent } from '../../utils/logger'
import {
  createMemorySettler,
  type MemorySettler,
  type SettleMessage,
} from './memorySettler'

/**
 * 把记忆整理器接到真实环境：模型、向量、SQLite 都走现有链路。
 * 单独一层是为了让 memorySettler 保持无副作用、可单测。
 */

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      if ((part as any).type === 'app_text') return String((part as any).text || '')
      if ((part as any).type === 'app_image_uri') return '[图片]'
      return ''
    })
    .filter(Boolean)
    .join(' ')
}

function collectMessages(): SettleMessage[] {
  const generalStore = useGeneralStore()
  return generalStore.chatHistory
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => ({
      role: message.role,
      text: messageText(message.content),
    }))
}

let settler: MemorySettler | null = null

function ensureSettler(): MemorySettler {
  if (settler) return settler

  settler = createMemorySettler({
    isEnabled: () => {
      const settings = useSettingsStore().config
      return settings.memoryAutoExtract !== false
    },
    getModel: () => {
      const settings = useSettingsStore().config
      return (
        settings.memoryExtractModel?.trim() ||
        settings.assistantModel?.trim() ||
        'deepseek-v4-flash'
      )
    },
    getMessages: collectMessages,
    getExistingMemories: async () => {
      try {
        if (!window.aliceIPC) return []
        const result = await window.aliceIPC.invoke('memory:get', {
          limit: 300,
        })
        if (!result?.success || !Array.isArray(result.data)) return []
        return result.data
          .map((item: any) => String(item?.content || ''))
          .filter(Boolean)
      } catch {
        return []
      }
    },
    complete: ({ transcript, systemPrompt, model }) =>
      api.createSummarizationResponse(
        [{ role: 'user', content: transcript }],
        model,
        systemPrompt
      ),
    embed: text => api.createDualEmbeddings(text),
    saveMemory: async ({ content, memoryType, embedding }) => {
      if (!window.aliceIPC) return false
      const result = await window.aliceIPC.invoke('memory:save', {
        content,
        memoryType,
        embeddingDoubao: embedding.doubao,
        embeddingOpenai: embedding.openai,
        embeddingLocal: embedding.local,
      })
      return !!result?.success
    },
    log: (level, event, data) => logEvent('memory', event, data, level),
  })

  return settler
}

export function settleMemories(
  reason: string,
  options?: {
    messages?: SettleMessage[]
    force?: boolean
    timeoutMs?: number
  }
): Promise<{ saved: number; skipped?: string }> {
  try {
    return ensureSettler().settle(reason, options)
  } catch (error) {
    logEvent(
      'memory',
      'settle.crashed',
      { reason, error: error instanceof Error ? error.message : String(error) },
      'error'
    )
    return Promise.resolve({ saved: 0, skipped: 'error' })
  }
}

/** 当前会话消息快照，切换会话前先抓一份，避免清空后无从整理 */
export function snapshotConversation(): SettleMessage[] {
  try {
    return collectMessages()
  } catch {
    return []
  }
}

/** 仅供测试：丢弃单例，让下一次调用重新装配 */
export function resetMemorySettler(): void {
  settler = null
}
