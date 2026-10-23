/**
 * Alice 主窗口的三种形态 —— 这是主窗口最核心的状态机，改窗口相关的代码前先读这里。
 *
 * ┌───────────┬──────────────┬────────────────────────┬────────────────────────────────────┐
 * │ state     │ 中文名        │ 窗口                    │ 说明                                │
 * ├───────────┼──────────────┼────────────────────────┼────────────────────────────────────┤
 * │ ball      │ 头像球        │ 无边框 + 透明，500×500   │ 只露圆形头像 + 悬浮按钮，默认形态      │
 * │ mini      │ 迷你球        │ 无边框 + 透明，210×210   │ 贴屏幕右下角常驻，圆形之外点击穿透      │
 * │ window    │ 聊天窗口      │ 原生带框，1200×760      │ 头像缩到左侧 320 + 聊天面板，系统标题栏 │
 * └───────────┴──────────────┴────────────────────────┴────────────────────────────────────┘
 *
 * 状态迁移规则（实现见 windowManager.ts 的 switchWindowMode / minimizeMainWindow）：
 *
 *   ball ──点聊天按钮/点悬浮聊天图标──▶ window      （重建窗口，frame:true）
 *   window ──点「⌄ 收起」/再点聊天按钮──▶ ball      （重建窗口，frame:false）
 *   ball ──点悬浮的迷你按钮──▶ mini                （同一个 ball 窗口改尺寸，不重建）
 *   mini ──点悬浮的还原按钮──▶ ball
 *   window ──点迷你按钮──▶ ball（先退出聊天窗口，迷你只在 ball 下有意义）
 *
 * 注意：
 * - ball 与 window 之间必须"重建窗口"，Electron 不能运行时改 frame
 * - mini 只是 ball 的尺寸/位置变体，靠 win.setSize/ setPosition 完成
 * - ball / mini 的窗口矩形比圆形大一圈（500/480、210/200），那圈 5~10px
 *   会吃掉点击。不做鼠标穿透（试过 setIgnoreMouseEvents，一旦开启就再也收不到
 *   真实点击，整窗变成穿透），保持窗口矩形 = 可点击区域
 * - 真正的窗口最小化是 window:minimize → minimizeMainWindowToTaskbar()，
 *   和迷你球（mini）是两回事
 */

export type WindowState = 'ball' | 'mini' | 'window'

export const WINDOW_STATE_LABELS: Record<
  WindowState,
  { zh: string; en: string }
> = {
  ball: { zh: '头像球', en: 'Avatar Ball' },
  mini: { zh: '迷你球', en: 'Mini Ball' },
  window: { zh: '聊天窗口', en: 'Chat Window' },
}

/** 只有这两种形态是"只有一个圆形头像"的透明窗口 */
export function isAvatarOnlyState(state: WindowState): boolean {
  return state === 'ball' || state === 'mini'
}

export function windowStateLabel(state: WindowState): string {
  return `${WINDOW_STATE_LABELS[state].zh} / ${WINDOW_STATE_LABELS[state].en}`
}
