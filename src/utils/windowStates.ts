/**
 * Alice 主窗口的三种形态 —— 这是主窗口最核心的状态机，改窗口相关的代码前先读这里。
 *
 * ┌──────────────┬──────────┬──────────────────────┬────────────────────────────────────┐
 * │ state        │ 中文名    │ 窗口                  │ 说明                                │
 * ├──────────────┼──────────┼──────────────────────┼────────────────────────────────────┤
 * │ avatar_ball  │ 头像球    │ 无边框 + 透明，500×500 │ 只露圆形头像 + 悬浮按钮，默认形态      │
 * │ mini_ball    │ 迷你球    │ 无边框 + 透明，210×210 │ 贴屏幕右下角常驻，可一键扩大回头像球    │
 * │ window       │ 聊天窗口  │ 无边框 + 透明，1200×760│ 头像缩到左侧 320 + 聊天面板 +         │
 * │              │          │                      │ 自绘标题栏（TitleBar.vue）           │
 * └──────────────┴──────────┴──────────────────────┴────────────────────────────────────┘
 *
 * 实现方式（见 windowManager.ts 的 applyWindowMode / setMiniBallMode）：
 * 整个应用只有一个 BrowserWindow 外壳（永久无边框 + 透明），三种形态
 * 全部靠就地改窗口尺寸 + 通知渲染层换布局完成，永远不重建窗口、
 * 不重载渲染进程 —— 所以任意两种形态之间的切换都是"行云流水"级。
 * Electron 的 frame/transparent 是创建期一次性属性，别想运行时改它们；
 * 也不要在这里引入"重建窗口"的逻辑，会退回到旧方案的重载卡顿。
 *
 * 状态迁移规则：
 *
 *   avatar_ball ──点聊天按钮 / 头像上的聊天图标──▶ window        （就地切换）
 *   window      ──点「⌄ 收起」/ 再点聊天按钮 ────▶ avatar_ball   （就地切换）
 *   avatar_ball ──点头像上的迷你按钮────────────▶ mini_ball     （同一个窗口改尺寸）
 *   mini_ball   ──点顶部的扩大按钮──────────────▶ avatar_ball   （同一个窗口改尺寸）
 *   window      ──点头像上的迷你按钮────────────▶ mini_ball     （就地切换，直接迷你尺寸）
 *
 * 注意：
 * - window 形态的标题栏由渲染层自绘（TitleBar.vue，32px 拖拽区 + 三键），
 *   最小化/最大化/关闭走 window:minimize / window:toggle-maximize / window:hide-to-tray
 * - 形态切换时主进程通过 setMinimumSize 动态放宽/收紧尺寸下限
 *   （window 900×560，ball 180×180），顺序是"先放宽再 setBounds"
 * - 三种形态的窗口矩形都比圆形大一圈（500/480、210/200），那圈 5~10px 会吃掉
 *   点击。不做鼠标穿透（试过 setIgnoreMouseEvents，一旦开启就再也收不到真实点击，
 *   整窗变成穿透），保持窗口矩形 = 可点击区域
 * - 真正的窗口最小化是 window:minimize → minimizeMainWindowToTaskbar()，
 *   和 mini_ball 完全是两回事，命名上不要混
 */

export type WindowState = 'avatar_ball' | 'mini_ball' | 'window'

export const WINDOW_STATE_LABELS: Record<
  WindowState,
  { zh: string; en: string }
> = {
  avatar_ball: { zh: '头像球', en: 'Avatar Ball' },
  mini_ball: { zh: '迷你球', en: 'Mini Ball' },
  window: { zh: '聊天窗口', en: 'Chat Window' },
}

/** 只有这两种形态是"只有一个圆形头像"的透明窗口 */
export function isAvatarOnlyState(state: WindowState): boolean {
  return state === 'avatar_ball' || state === 'mini_ball'
}

export function windowStateLabel(state: WindowState): string {
  return `${WINDOW_STATE_LABELS[state].zh} / ${WINDOW_STATE_LABELS[state].en}`
}
