/**
 * 两种窗口 frame 形态之间的切换入口（主进程就地改窗口尺寸/布局，不重建窗口、
 * 不重载渲染进程，会话与音频等运行时状态全程保留）。
 * 三种状态的定义与迁移规则见 src/utils/windowStates.ts。
 *
 * - avatar_ball / mini_ball：无边框透明，只露圆形头像（mini_ball 是 210×210 贴右下角）
 * - window：无边框 + 渲染层自绘标题栏的聊天窗口
 */

/** 聊天窗口 → 头像球（收起） */
export async function collapseToAvatar(): Promise<void> {
  await window.aliceIPC?.invoke('window:set-mode', { mode: 'avatar_ball' })
}

/** 聊天窗口 → 迷你球（就地切换，直接落在迷你尺寸上） */
export async function shrinkToMiniBall(): Promise<void> {
  await window.aliceIPC?.invoke('window:set-mode', {
    mode: 'avatar_ball',
    miniBall: true,
  })
}

/** 头像球 / 迷你球 → 聊天窗口 */
export async function expandToChatWindow(): Promise<void> {
  await window.aliceIPC?.invoke('window:set-mode', { mode: 'window' })
}
