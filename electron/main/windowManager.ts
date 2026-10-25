import { app, BrowserWindow, screen, shell, protocol } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  resolvePathWithinRoot,
  validateExternalOpenUrl,
} from './securityBoundaries'
import { loadSettings, saveSettings } from './settingsManager'
import { writeAppLog } from './teaching/logger'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

if (!process.env.APP_ROOT) {
  process.env.APP_ROOT = path.join(__dirname, '../..')
}

export function getMainDist(): string {
  return path.join(process.env.APP_ROOT!, 'dist-electron')
}

export function getRendererDist(): string {
  return path.join(process.env.APP_ROOT!, 'dist')
}

export function getVitePublic(): string {
  return process.env.VITE_DEV_SERVER_URL
    ? path.join(process.env.APP_ROOT!, 'public')
    : getRendererDist()
}

export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

const IS_DEV = !!VITE_DEV_SERVER_URL

function getPreloadPath(): string {
  return path.join(__dirname, '../preload/index.mjs')
}

function getIndexHtmlPath(): string {
  return path.join(getRendererDist(), 'index.html')
}

let win: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

// 透明无边框窗口不能靠系统标题栏最大化（没有标题栏，系统菜单里也是灰的），
// 所以最大化仍然由主进程按工作区 setBounds 实现，并记录还原用的 bounds。
// 贴靠（Aero Snap 半屏）同理：无边框窗口拿不到系统的 HTCAPTION 贴靠，
// 由 TitleBar 的手动拖拽在松手时调用 endWindowDrag 就地贴半屏。
let customMaximized = false
let snapZone: 'left' | 'right' | null = null
let restoreBounds: Electron.Rectangle | null = null
let expectedMaxBounds: Electron.Rectangle | null = null
let maximizeAppliedAt = 0
let driftTimer: NodeJS.Timeout | null = null

function notifyMaximizedState(): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('window:maximized-changed', isMainWindowMaximized())
}

function clearCustomMaximized(): void {
  customMaximized = false
  snapZone = null
  restoreBounds = null
  expectedMaxBounds = null
  if (driftTimer) {
    clearTimeout(driftTimer)
    driftTimer = null
  }
}

function installNavigationGuards(window: BrowserWindow): void {
  const openExternal = (url: string) => {
    try {
      void shell
        .openExternal(validateExternalOpenUrl(url))
        .catch(error =>
          console.warn('[Window Security] Could not open external URL:', error)
        )
    } catch (error) {
      console.warn('[Window Security] Blocked external URL:', url, error)
    }
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    try {
      const candidate = new URL(url)
      if (VITE_DEV_SERVER_URL) {
        if (candidate.origin === new URL(VITE_DEV_SERVER_URL).origin) return
      } else if (
        candidate.protocol === 'file:' &&
        path.resolve(fileURLToPath(candidate)) ===
          path.resolve(getIndexHtmlPath())
      ) {
        return
      }
    } catch {
      // Invalid renderer navigation is blocked below.
    }
    event.preventDefault()
    openExternal(url)
  })
}

export function getMainWindow(): BrowserWindow | null {
  return win
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow
}

// 三种窗口形态共用同一个"无边框 + 透明"的窗口外壳，只换尺寸和渲染层布局，
// 永远不重建窗口（切换性能与 mini_ball 同级）。三种状态的完整定义见
// src/utils/windowStates.ts。window 形态的标题栏由渲染层自绘（TitleBar.vue）。
export type WindowMode = 'avatar_ball' | 'window'

let windowMode: WindowMode = 'avatar_ball'
/** 是否处于迷你球形态（与 windowMode 组合成 mini_ball） */
let miniBallActive = false

// 点右上角关闭 = 收到托盘，不退出程序；只有真正 quit 时才放行关闭
let appQuitting = false
// 托盘没建起来时不能隐藏窗口，否则应用会变成"看不见也找不回"
let trayAvailable = false

export function markAppQuitting(): void {
  appQuitting = true
}

export function setTrayAvailable(available: boolean): void {
  trayAvailable = available
}

export function isAppQuitting(): boolean {
  return appQuitting
}

app.once('before-quit', () => {
  appQuitting = true
})

export function getWindowMode(): WindowMode {
  return windowMode
}

export function isMiniBallMode(): boolean {
  return miniBallActive
}

/**
 * 主窗口只有一种外壳：无边框 + 透明，创建后终身不重建。
 * - ball（avatar_ball / mini_ball）：透出圆形头像
 * - window：渲染层自绘标题栏（TitleBar.vue）+ 不透明底色，系统标题栏不存在
 * 形态切换走 applyWindowMode（就地改尺寸/布局，不重建窗口）。
 */
export async function createMainWindow(
  mode: WindowMode = windowMode,
  options: { miniBall?: boolean } = {}
): Promise<BrowserWindow> {
  windowMode = mode
  const isFramed = mode === 'window'
  const startAsMiniBall = !isFramed && !!options.miniBall
  miniBallActive = startAsMiniBall
  // Always-on-top is user-configurable (default: off) so the companion window
  // does not permanently cover other applications.
  let shouldAlwaysBeOnTop = false
  try {
    const appSettings = await loadSettings()
    shouldAlwaysBeOnTop = !!appSettings?.alwaysOnTop
  } catch {
    // Fall back to the default (off) when settings cannot be read.
  }

  const created = new BrowserWindow({
    title: 'Alice',
    icon: path.join(getVitePublic(), 'app_logo.png'),
    // 始终无边框 + 透明：ball 直接透出圆形头像；window 模式由渲染层铺不透明底色。
    // transparent/frame 是创建期一次性属性，为了不重建窗口，只能统一取透明。
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    width: isFramed ? 1200 : 500,
    height: isFramed ? 760 : 500,
    // 同一个窗口要在 ball(210/500) 与 window(1200×760) 之间来回变，
    // 下限按最小需求写死，window 形态的更大下限在创建后动态设置
    minWidth: 180,
    minHeight: 180,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    alwaysOnTop: shouldAlwaysBeOnTop,
    // 透明窗口没有系统阴影可谈，统一关掉，避免 Windows 下的残影
    hasShadow: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      offscreen: false,
      backgroundThrottling: false,
    },
  })

  // 聊天窗口形态下限制更严的最小尺寸（形态切换前会先放宽，见 applyWindowMode）
  if (isFramed) {
    created.setMinimumSize(900, 560)
  }

  win = created
  installNavigationGuards(created)

  // 通过 hash 告诉渲染进程当前处于哪种形态（命名见 src/utils/windowStates.ts）
  const stateHash = isFramed
    ? '#window'
    : startAsMiniBall
      ? '#mini-ball'
      : '#avatar-ball'

  if (VITE_DEV_SERVER_URL) {
    created.loadURL(`${VITE_DEV_SERVER_URL}${stateHash}`)
    // 开发模式不自动弹 DevTools：它会在页面右上角挂一个视口尺寸角标，
    // 干扰 UI 实测。需要调试时按 F12 手动开关。
    created.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        event.preventDefault()
        if (created.webContents.isDevToolsOpened()) {
          created.webContents.closeDevTools()
        } else {
          created.webContents.openDevTools({ mode: 'detach' })
        }
      }
    })
  } else {
    created.loadFile(getIndexHtmlPath(), { hash: stateHash.slice(1) })
  }

  created.on('closed', () => {
    // 形态切换不销毁窗口（applyWindowMode 就地切换），这里只在窗口真正关闭时清理
    if (win === created) {
      win = null
      clearCustomMaximized()
    }
  })

  // 点右上角关闭 → 收进系统托盘（而不是退出程序）
  created.on('close', event => {
    if (appQuitting || !trayAvailable) return
    event.preventDefault()
    created.hide()
  })

  created.on('maximize', notifyMaximizedState)
  created.on('unmaximize', notifyMaximizedState)

  // 用户手动拖边/移动窗口 → 退出自定义最大化，图标与真实状态保持一致
  const scheduleDriftCheck = () => {
    if (win !== created) return
    if (!customMaximized) return
    if (driftTimer) clearTimeout(driftTimer)
    driftTimer = setTimeout(() => {
      driftTimer = null
      if (win !== created) return
      if (!customMaximized || !win || win.isDestroyed()) return
      if (Date.now() - maximizeAppliedAt < 400) return
      const target = expectedMaxBounds
      if (!target) return
      const bounds = win.getBounds()
      const drifted =
        Math.abs(bounds.width - target.width) > 4 ||
        Math.abs(bounds.height - target.height) > 4 ||
        Math.abs(bounds.x - target.x) > 4 ||
        Math.abs(bounds.y - target.y) > 4
      if (drifted) {
        clearCustomMaximized()
        notifyMaximizedState()
      }
    }, 150)
  }

  win.on('resize', scheduleDriftCheck)
  win.on('move', scheduleDriftCheck)

  win.webContents.on('did-finish-load', () => {
    win?.webContents.send(
      'main-process-message',
      `Alice ready at ${new Date().toLocaleString()}`
    )
  })

  return win
}

/**
 * 切换窗口形态：同一个窗口就地改尺寸 + 通知渲染层换布局，不重建窗口、
 * 不重载渲染进程（会话/音频等运行时状态全部保留，切换耗时与 mini_ball 同级）。
 * 渲染层收到 'window:mode-changed' 后自行切换布局（见 Main.vue）。
 */
export async function applyWindowMode(
  mode: WindowMode,
  options: { miniBall?: boolean } = {}
): Promise<boolean> {
  if (!win || win.isDestroyed()) return false

  const previous = windowMode
  writeAppLog({
    module: 'window',
    event: 'mode.request',
    data: {
      from: previous,
      to: mode,
      miniBall: !!options.miniBall,
      bounds: win.getBounds(),
    },
  })

  const willBeMini = mode === 'avatar_ball' && options.miniBall === true

  // 不做"形态没变就直接返回"的短路：窗口尺寸可能已经被上次异常重载弄乱，
  // 而用户点"展开成窗口"正是想修好它。这里永远按目标形态重设尺寸并通知渲染层。
  windowMode = mode
  const startAsMiniBall = willBeMini
  miniBallActive = startAsMiniBall

  // 坐标规则统一为"同一台显示器 + 居中/贴角"，不做随机偏移。
  // 注意先放宽最小尺寸约束再 setBounds，否则从 window(900+) 收回 ball(500) 会被钳住。
  const display = screen.getDisplayMatching(win.getBounds())
  const area = display.workArea

  if (mode === 'window') {
    setMinimumSizeForState('window')
    const width = Math.min(1200, area.width)
    const height = Math.min(760, area.height)
    const target = {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height,
    }
    win.setBounds(target)
  } else {
    win.setMinimumSize(180, 180)
    if (startAsMiniBall) {
      // 就地贴到当前显示器右下角（内部会清掉自定义最大化状态）
      setMiniBallMode(true)
    } else {
      // 离开聊天窗口形态：最大化状态就地清掉（不再有"重建窗口"兜底）
      if (customMaximized) {
        clearCustomMaximized()
        notifyMaximizedState()
      }
      win.setBounds({
        x: area.x + Math.round((area.width - 500) / 2),
        y: area.y + Math.round((area.height - 500) / 2),
        width: 500,
        height: 500,
      })
    }
  }

  win.webContents.send('window:mode-changed', {
    mode,
    miniBall: startAsMiniBall,
  })

  writeAppLog({
    module: 'window',
    event: 'mode.changed.main',
    data: { from: previous, to: mode, miniBall: startAsMiniBall, bounds: win.getBounds() },
  })

  // 记住形态：下次启动直接回到这里，不用再从球展开
  void (async () => {
    try {
      const settings = await loadSettings()
      await saveSettings({ ...settings, windowMode: mode })
    } catch (error) {
      writeAppLog({
        module: 'window',
        event: 'mode.persist_failed',
        level: 'warn',
        data: { message: (error as Error)?.message ?? String(error) },
      })
    }
  })()

  return true
}

export async function createOverlayWindow(): Promise<BrowserWindow> {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  overlayWindow = new BrowserWindow({
    width,
    height,
    transparent: false,
    frame: false,
    alwaysOnTop: true,
    fullscreen: false,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    backgroundColor: '#000000',
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      offscreen: false,
      backgroundThrottling: false,
    },
  })

  installNavigationGuards(overlayWindow)

  const arg = 'overlay'
  if (VITE_DEV_SERVER_URL) {
    await overlayWindow.loadURL(`${VITE_DEV_SERVER_URL}#${arg}`)
  } else {
    await overlayWindow.loadFile(getIndexHtmlPath(), { hash: arg })
  }

  overlayWindow.hide()

  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  return overlayWindow
}

export async function showOverlay(): Promise<boolean> {
  if (!overlayWindow) {
    await createOverlayWindow()
  }

  const currentOverlayWindow = overlayWindow
  if (!currentOverlayWindow) return false

  currentOverlayWindow.setOpacity(0.35)
  currentOverlayWindow.show()
  currentOverlayWindow.focus()
  currentOverlayWindow.webContents.send('overlay-shown')

  return true
}

export function hideOverlay(): boolean {
  overlayWindow?.hide()
  win?.webContents.send('overlay-closed')
  return true
}

export function setOverlayOpacity(opacity: number): boolean {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return false
  }
  overlayWindow.setOpacity(opacity)
  return true
}

export function resizeMainWindow(width: number, height: number): void {
  if (!win) return
  if (customMaximized) {
    clearCustomMaximized()
    notifyMaximizedState()
  }
  win.setSize(width, height)
}

/**
 * 迷你球（Mini Ball）：avatar 上 mini 按钮的产物 —— 把窗口缩成 210×210 贴到右下角。
 * 这不是 Windows 的窗口最小化，那个是 minimizeMainWindowToTaskbar()。
 * 形态定义见 src/utils/windowStates.ts。
 */
export function setMiniBallMode(enabled: boolean): void {
  if (!win || win.isDestroyed()) return
  miniBallActive = enabled
  if (customMaximized) {
    clearCustomMaximized()
    notifyMaximizedState()
  }

  // 坐标规则（保持"人眼不用重新找"的直觉）：
  // - mini_ball：停靠在当前窗口所在显示器的右下角，留 20px 边距
  // - avatar_ball：在同一台显示器上居中
  const display = screen.getDisplayMatching(win.getBounds())
  const area = display.workArea

  if (enabled) {
    win.setBounds({
      x: area.x + area.width - 210 - 20,
      y: area.y + area.height - 210 - 20,
      width: 210,
      height: 210,
    })
  } else {
    win.setBounds({
      x: area.x + Math.round((area.width - 500) / 2),
      y: area.y + Math.round((area.height - 500) / 2),
      width: 500,
      height: 500,
    })
  }
}

/** 系统级窗口最小化（任务栏），跟迷你球（setMiniBallMode）完全不同 */
export function minimizeMainWindowToTaskbar(): boolean {
  if (!win || win.isDestroyed()) return false
  win.minimize()
  return true
}

/**
 * 最大化 / 还原，返回切换后的状态。
 *
 * 无边框透明窗口没有系统标题栏，`win.maximize()` 在 Windows 上不可靠，
 * 所以按当前显示器的工作区 setBounds（保留任务栏），并记住还原前的 bounds。
 * 从贴靠（半屏）状态点最大化时，保留"贴靠之前"的 bounds 作为还原目标
 * （Windows 语义：还原按钮永远回到最近一次的正常尺寸，而不是半屏尺寸）。
 */
export function toggleMaximizeMainWindow(): boolean {
  if (!win || win.isDestroyed()) return false

  // 必须先查自定义状态再查系统状态：把窗口 setBounds 成工作区大小后，
  // Windows 会把窗口标记为 IsZoomed（isMaximized()=true），如果先走
  // unmaximize()，系统会把窗口"还原"到它自己记的默认矩形（900×560@0,0），
  // 而不是我们的 restoreBounds —— 这正是"还原按钮位置不对"的根因。
  if (customMaximized) {
    const previous = restoreBounds
    clearCustomMaximized()
    // 清掉系统层面的"已最大化"样式，紧接着 setBounds 覆盖系统还原矩形
    if (win.isMaximized()) {
      win.unmaximize()
    }
    if (previous) {
      try {
        win.setBounds(previous)
      } catch (error) {
        console.warn('[WindowManager] 还原窗口尺寸失败:', error)
      }
    }
    setMinimumSizeForState('window')
    notifyMaximizedState()
    return false
  }

  // 原生带框窗口可能被系统标题栏/贴边最大化，这种情况直接交回系统还原
  if (win.isMaximized()) {
    win.unmaximize()
    setMinimumSizeForState('window')
    notifyMaximizedState()
    return false
  }

  const currentBounds = win.getBounds()
  const workArea = screen.getDisplayMatching(currentBounds).workArea

  // 贴靠状态下 maximize：还原目标用"贴靠之前"的 bounds，不用当前半屏
  if (!snapZone || !restoreBounds) {
    restoreBounds = currentBounds
  }
  snapZone = null
  expectedMaxBounds = workArea
  customMaximized = true
  maximizeAppliedAt = Date.now()

  try {
    setMinimumSizeForState('window')
    win.setBounds(workArea)
  } catch (error) {
    console.warn('[WindowManager] 最大化 setBounds 失败:', error)
    clearCustomMaximized()
    notifyMaximizedState()
    return false
  }

  // 透明窗口偶尔会"吃"掉第一次 setBounds，核对一次并补一次
  setTimeout(() => {
    if (!win || win.isDestroyed() || !customMaximized) return
    const target = expectedMaxBounds
    if (!target) return
    const applied = win.getBounds()
    const drifted =
      Math.abs(applied.width - target.width) > 8 ||
      Math.abs(applied.height - target.height) > 8
    if (drifted) {
      try {
        win.setBounds(target)
      } catch (error) {
        console.warn('[WindowManager] 补一次 setBounds 失败:', error)
      }
    }
  }, 220)

  notifyMaximizedState()
  return true
}

export function isMainWindowMaximized(): boolean {
  if (!win || win.isDestroyed()) return false
  return customMaximized || win.isMaximized()
}

export function closeMainWindow(): void {
  if (win && !win.isDestroyed()) {
    win.close()
  }
}

/** 供渲染进程实现"拖头像移动窗口"（不用 app-region: drag，否则 hover 会被吞） */
export function getMainWindowPosition(): { x: number; y: number } | null {
  if (!win || win.isDestroyed()) return null
  const [x, y] = win.getPosition()
  return { x, y }
}

export function setMainWindowPosition(x: number, y: number): void {
  if (!win || win.isDestroyed()) return
  if (win.isMaximized() || customMaximized || snapZone) return
  win.setPosition(Math.round(x), Math.round(y))
  // 正常状态下移动窗口 = 更新"最近一次正常位置"，还原按钮以此为基准
  const b = win.getBounds()
  restoreBounds = { x: b.x, y: b.y, width: b.width, height: b.height }
}

/** 自绘标题栏的拖拽高度，与 TitleBar.vue 的 32px 保持一致 */
const TITLEBAR_HEIGHT = 32

// 窗口形态的正常最小尺寸；贴靠半屏时会临时放宽（半屏可能比它窄，见 endWindowDrag）
const WINDOW_MODE_MIN = { width: 900, height: 560 }

function setMinimumSizeForState(state: 'window' | 'relaxed'): void {
  if (!win || win.isDestroyed()) return
  if (state === 'window') {
    win.setMinimumSize(WINDOW_MODE_MIN.width, WINDOW_MODE_MIN.height)
  } else {
    win.setMinimumSize(180, 180)
  }
}

/**
 * 标题栏拖拽开始（TitleBar.vue 手动拖拽，不走 app-region: drag —— 那种拖法
 * 在 Windows 上拿不到双击最大化/边缘贴靠/像样的系统菜单）。
 * 如果当前处于最大化/贴靠状态，按 Windows 语义"拖动即还原"：
 * 恢复到贴靠/最大化之前的尺寸，并把窗口放到光标下（水平按抓住比例、垂直对齐标题栏）。
 * 返回还原后窗口左上角坐标，渲染层以此为起点继续拖动。
 */
export function beginWindowDrag(cursor: { x: number; y: number }): {
  x: number
  y: number
} {
  if (!win || win.isDestroyed()) return { x: 0, y: 0 }

  const bounds = win.getBounds()

  if (customMaximized || snapZone) {
    // 先清掉系统的 IsZoomed 样式（自定义最大化会触发它），否则 unmaximize
    // 的系统还原矩形会和我们 setBounds 的目标位置打架
    if (win.isMaximized()) {
      win.unmaximize()
    }
    const pre = restoreBounds ?? { ...bounds }
    const grabRatio = bounds.width
      ? Math.min(1, Math.max(0, (cursor.x - bounds.x) / bounds.width))
      : 0.5
    const area = screen.getDisplayNearestPoint(cursor).workArea
    const x = Math.round(cursor.x - grabRatio * pre.width)
    const y = Math.round(cursor.y - TITLEBAR_HEIGHT / 2)
    // Windows 语义：还原瞬间窗口跟随光标，允许水平方向部分出屏（用户可以
    // 继续拖回来）。只保证光标附近的一段窗口可见，不能硬夹进工作区 ——
    // 否则抓住贴靠窗口边缘拖动时会被钳到完全错误的位置。
    const VISIBILITY = 100
    const clampedX = Math.min(
      Math.max(x, Math.round(cursor.x - pre.width) + VISIBILITY),
      Math.round(cursor.x) - VISIBILITY
    )
    // 垂直方向必须留在屏幕内，且标题栏可见（不然窗口就拿不回来了）
    const clampedY = Math.min(Math.max(y, area.y), area.y + area.height - TITLEBAR_HEIGHT)
    try {
      win.setBounds({
        x: clampedX,
        y: clampedY,
        width: pre.width,
        height: pre.height,
      })
    } catch (error) {
      console.warn('[WindowManager] 拖拽还原窗口失败:', error)
    }
    setMinimumSizeForState('window')
    if (customMaximized) {
      customMaximized = false
      expectedMaxBounds = null
      notifyMaximizedState()
    }
    snapZone = null
    if (driftTimer) {
      clearTimeout(driftTimer)
      driftTimer = null
    }
    const restored = win.getBounds()
    // 拖出即还原：窗口此刻回到"正常状态"，位置就是最近一次正常位置，
    // 后续上边缘最大化 / 还原按钮都应以它为基准（不能清空，否则
    // 拖出后立即最大化，还原会找不到回不去的位置）
    restoreBounds = {
      x: restored.x,
      y: restored.y,
      width: restored.width,
      height: restored.height,
    }
    return { x: restored.x, y: restored.y }
  }

  if (win.isMaximized()) {
    // 罕见的原生最大化路径：交还系统还原
    win.unmaximize()
    notifyMaximizedState()
  }

  return { x: bounds.x, y: bounds.y }
}

/**
 * 标题栏拖拽结束：光标落在屏幕工作区边缘时按 Windows 语义贴靠 ——
 * 上边缘 → 最大化，左/右边缘 → 半屏贴靠。返回实际发生的贴靠动作。
 */
export function endWindowDrag(cursor: { x: number; y: number }): {
  snapped: 'left' | 'right' | 'maximize' | null
} {
  if (!win || win.isDestroyed()) return { snapped: null }

  const area = screen.getDisplayNearestPoint(cursor).workArea
  const EDGE = 8
  let zone: 'left' | 'right' | 'maximize' | null = null
  if (cursor.y <= area.y + EDGE) {
    zone = 'maximize'
  } else if (cursor.x <= area.x + EDGE) {
    zone = 'left'
  } else if (cursor.x >= area.x + area.width - EDGE) {
    zone = 'right'
  }
  if (!zone) return { snapped: null }

  if (zone === 'maximize') {
    toggleMaximizeMainWindow()
    return { snapped: 'maximize' }
  }

  // 半屏可能比窗口模式的正常最小尺寸（900×560）还窄，先放宽再贴
  setMinimumSizeForState('relaxed')

  // 半屏贴靠：记住贴靠前的 bounds（已在最大化/贴靠状态下则沿用更早的记忆）
  if (!customMaximized && !snapZone) {
    restoreBounds = win.getBounds()
  }
  if (customMaximized) {
    customMaximized = false
    expectedMaxBounds = null
    if (driftTimer) {
      clearTimeout(driftTimer)
      driftTimer = null
    }
    notifyMaximizedState()
  }
  snapZone = zone

  const width = Math.floor(area.width / 2)
  try {
    win.setBounds({
      x: zone === 'left' ? area.x : area.x + (area.width - width),
      y: area.y,
      width,
      height: area.height,
    })
  } catch (error) {
    console.warn('[WindowManager] 贴靠 setBounds 失败:', error)
    snapZone = null
    return { snapped: null }
  }
  return { snapped: zone }
}



export function focusMainWindow(): boolean {
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    win.moveTop()
    console.log('[WindowManager] Main window focused')
    return true
  }
  return false
}

export async function createSettingsWindow(): Promise<BrowserWindow> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }

  settingsWindow = new BrowserWindow({
    title: 'Alice Settings',
    icon: path.join(getVitePublic(), 'app_logo.png'),
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    frame: false,
    resizable: true,
    alwaysOnTop: false,
    parent: win || undefined,
    modal: false,
    backgroundColor: '#1f2937',
    show: false,
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      offscreen: false,
      backgroundThrottling: false,
    },
  })

  installNavigationGuards(settingsWindow)

  const arg = 'settings'
  if (VITE_DEV_SERVER_URL) {
    await settingsWindow.loadURL(`${VITE_DEV_SERVER_URL}#${arg}`)
  } else {
    await settingsWindow.loadFile(getIndexHtmlPath(), { hash: arg })
  }

  settingsWindow.show()
  settingsWindow.focus()

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  return settingsWindow
}

export function closeSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close()
  }
}

export function cleanupWindows(): void {
  clearCustomMaximized()
  win = null
  overlayWindow = null
  settingsWindow = null
}

export function registerCustomProtocol(
  generatedImagesPath: string,
  customAvatarsPath?: string
): void {
  protocol.registerFileProtocol('alice-image', (request, callback) => {
    try {
      const url = request.url.substring('alice-image://'.length)
      const decodedUrlPath = decodeURIComponent(url)
      const filePath = resolvePathWithinRoot(
        generatedImagesPath,
        decodedUrlPath
      )
      callback({ path: filePath })
    } catch {
      console.error(
        `[Protocol] Denied access to unsafe image path from URL: ${request.url}`
      )
      callback({ error: -6 })
    }
  })

  if (customAvatarsPath) {
    protocol.registerFileProtocol('alice-avatar', (request, callback) => {
      try {
        const url = request.url.substring('alice-avatar://'.length)
        const decodedUrlPath = decodeURIComponent(url)
        const filePath = resolvePathWithinRoot(
          customAvatarsPath,
          decodedUrlPath
        )
        callback({ path: filePath })
      } catch {
        console.error(
          `[Protocol] Denied access to unsafe avatar path from URL: ${request.url}`
        )
        callback({ error: -6 })
      }
    })
  }
}
