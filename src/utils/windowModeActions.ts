import { useConversationLogStore } from '../stores/conversationLogStore'

/**
 * 两种窗口形态的切换入口（主进程会重建窗口、重载渲染进程）：
 * - ball：无边框透明，只露圆形头像
 * - window：原生带框窗口，聊天面板 + 系统标题栏
 *
 * 切换前先把会话落库，新窗口启动时由 Sidebar 从 `alice:restore-session` 恢复。
 */

const RESTORE_KEY = 'alice:restore-session'

export async function collapseToAvatar(): Promise<void> {
  try {
    const logStore = useConversationLogStore()
    await logStore.flush()
    window.localStorage.setItem(RESTORE_KEY, logStore.sessionId)
  } catch (error) {
    console.warn('[WindowMode] 收起前保存会话失败:', error)
  }

  await window.aliceIPC?.invoke('window:set-mode', { mode: 'ball' })
}

export async function expandToChatWindow(): Promise<void> {
  await window.aliceIPC?.invoke('window:set-mode', { mode: 'window' })
}
