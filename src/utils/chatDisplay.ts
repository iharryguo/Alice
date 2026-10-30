import type { ChatMessage } from '../types/chat'
import { extractMessageText } from './messageRender'

export interface ToolCallDisplay {
  callId: string
  name: string
  args: string
  result: string
  statusText: string
  status: 'success' | 'error' | 'running'
}

export interface MessageDisplayItem {
  kind: 'message'
  key: string
  role: ChatMessage['role']
  message: ChatMessage
  text: string
  time: number | null
  toolNames: string[]
  /** 语音说的、还是打字发的 */
  channel: 'voice' | 'text'
  /** Alice 主动开口（定时提醒 / 主动关心），气泡上要单独标记 */
  isProactive: boolean
  /** 主动消息的来由，例如定时任务名 */
  proactiveReason?: string
}

export interface ToolDisplayItem {
  kind: 'tool'
  key: string
  tool: ToolCallDisplay
}

export interface ActivityDisplayItem {
  kind: 'activity'
  key: string
  text: string
}

export type ChatDisplayItem =
  | MessageDisplayItem
  | ToolDisplayItem
  | ActivityDisplayItem

function messageKey(message: ChatMessage, index: number): string {
  return (
    message.local_id_temp ||
    message.api_message_id ||
    message.id ||
    `msg-${index}`
  )
}

function stringifyArgs(args: unknown): string {
  if (args === undefined || args === null) return ''
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2)
    } catch {
      return args
    }
  }
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

/**
 * 把 chatHistory（最新在前）转换成可直接渲染的展示序列（时间正序）。
 *
 * 规则：
 * - 工具执行前写入的 system 状态消息 → 并入紧随其后的工具卡片，不再单独显示
 * - role=tool 的消息 → 工具卡片，参数从对应 assistant.tool_calls 里回填
 * - 只有工具调用、没有文本的 assistant 消息 → 折叠（信息都在工具卡片里）
 * - 其余消息 → 气泡
 */
export function buildChatDisplayItems(
  history: ChatMessage[]
): ChatDisplayItem[] {
  const chronological = [...history].reverse()
  const callIndex = new Map<string, { name: string; args: string }>()

  for (const message of chronological) {
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue
    for (const call of message.tool_calls) {
      const callId = call?.call_id || call?.id
      if (!callId) continue
      callIndex.set(callId, {
        name: call?.name || 'unknown',
        args: stringifyArgs(call?.arguments),
      })
    }
  }

  const items: ChatDisplayItem[] = []
  let pendingStatus: string | null = null

  const flushPendingStatus = (index: number) => {
    if (pendingStatus) {
      items.push({
        kind: 'activity',
        key: `activity-${index}`,
        text: pendingStatus,
      })
      pendingStatus = null
    }
  }

  chronological.forEach((message, index) => {
    const key = messageKey(message, index)

    if (message.role === 'system') {
      const text = extractMessageText(message)
      if (text) pendingStatus = text
      return
    }

    if (message.role === 'tool') {
      const callId = message.tool_call_id || ''
      const call = callIndex.get(callId)
      const result = extractMessageText(message)
      items.push({
        kind: 'tool',
        key: `tool-${key}`,
        tool: {
          callId,
          name: message.name || call?.name || 'tool',
          args: call?.args || '',
          result,
          statusText: pendingStatus || '',
          status: /^\s*error/i.test(result) ? 'error' : 'success',
        },
      })
      pendingStatus = null
      return
    }

    if (
      message.role !== 'user' &&
      message.role !== 'assistant' &&
      message.role !== 'developer'
    ) {
      return
    }

    const text = extractMessageText(message)
    const hasToolCalls = Boolean(message.tool_calls?.length)

    if (message.role === 'assistant' && hasToolCalls && !text.trim()) {
      return
    }

    flushPendingStatus(index)

    const proactivePart = Array.isArray(message.content)
      ? message.content.find(part => part?.isScheduledReminder)
      : undefined

    items.push({
      kind: 'message',
      key,
      role: message.role,
      message,
      text,
      time: message.created_at ?? null,
      toolNames: hasToolCalls
        ? message.tool_calls!.map(call => call?.name || 'tool')
        : [],
      channel: message.channel === 'voice' ? 'voice' : 'text',
      isProactive:
        message.role === 'assistant' &&
        (Boolean(message.isProactive) || Boolean(proactivePart)),
      proactiveReason: proactivePart?.taskName,
    })
  })

  flushPendingStatus(chronological.length)
  return items
}

export function formatClock(timestamp: number | null | undefined): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * 气泡上的时间：今天只说几点几分，跨天补上日期。
 * 聊天记录常常翻到好几天前，只留一个"09:12"根本分不清是哪天。
 */
export function formatMessageTime(timestamp: number | null | undefined): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const clock = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (sameDay) return clock
  const day = date.toLocaleDateString([], {
    month: '2-digit',
    day: '2-digit',
  })
  return `${day} ${clock}`
}

export function formatDateLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()

  if (sameDay(date, today)) return '今天'
  if (sameDay(date, yesterday)) return '昨天'
  return date.toLocaleDateString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}
