/**
 * 当前对话的会话标识。
 *
 * 为什么单独放一个模块：会话 id 同时被三处使用——会话库（conversation-log）、
 * 摘要与 thoughts 索引（conversationStore）、聊天视图（Main.vue）。如果两处各存一份，
 * 摘要就会跨会话串味：索引写的是 A 会话的 id，读的时候却按 B 会话查。
 *
 * 这里用模块级变量而不是 Pinia store，是为了避免 conversationStore 与
 * conversationLogStore 互相 import 造成循环依赖。
 */

function generateSessionId(): string {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

let currentSessionId = generateSessionId()

/**
 * 当前会话是不是从历史里恢复出来的。
 *
 * 恢复出来的会话，"最近 10 条"这种窗口毫无意义——用户就是来接着上次聊的，
 * 前文必须一起带上；真正该管的是字符预算，不是条数。
 */
let sessionRestored = false

export function createConversationSessionId(): string {
  return generateSessionId()
}

export function getConversationSessionId(): string {
  return currentSessionId
}

/** 恢复历史会话时同步，保证后续摘要与索引落到同一个会话上 */
export function setConversationSessionId(id: string): void {
  const trimmed = String(id || '').trim()
  if (trimmed) currentSessionId = trimmed
}

/** 新建对话时轮换，旧会话的摘要与 thoughts 不会被新对话读到 */
export function rotateConversationSessionId(): string {
  currentSessionId = generateSessionId()
  sessionRestored = false
  return currentSessionId
}

export function markSessionRestored(restored: boolean): void {
  sessionRestored = restored
}

export function isSessionRestored(): boolean {
  return sessionRestored
}
