import { useConversationLogStore } from '../stores/conversationLogStore'

/**
 * 两种窗口 frame 形态之间的切换入口（主进程会重建窗口、重载渲染进程）。
 * 三种状态的定义与迁移规则见 src/utils/windowStates.ts。
 *
 * - avatar_ball / mini_ball：无边框透明，只露圆形头像（mini_ball 是 210×210 贴右下角）
 * - window：原生带框窗口，聊天面板 + 系统标题栏
 *
 * 切换前先把会话落库，新窗口启动时由 Sidebar 从 `alice:restore-session` 恢复。
 */

const RESTORE_KEY = 'alice:restore-session'

async function persistSessionBeforeRebuild(): Promise<void> {
  try {
    const logStore = useConversationLogStore()
    await logStore.flush()
    window.localStorage.setItem(RESTORE_KEY, logStore.sessionId)
  } catch (error) {
    console.warn('[WindowState] rebuild 前保存会话失败:', error)
  }
}

/** 聊天窗口 → 头像球（收起） */
export async function collapseToAvatar(): Promise<void> {
  await persistSessionBeforeRebuild()
  await window.aliceIPC?.invoke('window:set-mode', { mode: 'avatar_ball' })
}

/** 聊天窗口 → 迷你球（重建窗口，但直接落在迷你尺寸上） */
export async function shrinkToMiniBall(): Promise<void> {
  await persistSessionBeforeRebuild()
  await window.aliceIPC?.invoke('window:set-mode', {
    mode: 'avatar_ball',
    miniBall: true,
  })
}

/** 头像球 / 迷你球 → 聊天窗口 */
export async function expandToChatWindow(): Promise<void> {
  await window.aliceIPC?.invoke('window:set-mode', { mode: 'window' })
}
