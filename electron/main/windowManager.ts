import { BrowserWindow, screen, shell, protocol } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  resolvePathWithinRoot,
  validateExternalOpenUrl,
} from './securityBoundaries'
import { loadSettings } from './settingsManager'

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
let customMaximized = false
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

export async function createMainWindow(): Promise<BrowserWindow> {
  // Always-on-top is user-configurable (default: off) so the companion window
  // does not permanently cover other applications.
  let shouldAlwaysBeOnTop = false
  try {
    const appSettings = await loadSettings()
    shouldAlwaysBeOnTop = !!appSettings?.alwaysOnTop
  } catch {
    // Fall back to the default (off) when settings cannot be read.
  }

  win = new BrowserWindow({
    title: 'Alice',
    icon: path.join(getVitePublic(), 'app_logo.png'),
    // 默认状态只显示圆形头像，所以窗口必须是无边框 + 透明：
    // 系统标题栏会和"只露一个圆"互斥，只能自己画标题栏（见 ChatCockpit 头部）。
    transparent: true,
    frame: false,
    width: 500,
    height: 500,
    minWidth: 320,
    minHeight: 320,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    alwaysOnTop: shouldAlwaysBeOnTop,
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

  installNavigationGuards(win)

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
    // 开发模式下自动打开 DevTools（独立窗口模式）。
    // Alice 主窗口只有 500x500 且无边框，停靠(dock)模式会把界面挤坏，
    // 所以用 detach 独立窗口。打包发布版本不会打开。
    win.webContents.once('did-finish-load', () => {
      win?.webContents.openDevTools({ mode: 'detach' })
    })
  } else {
    win.loadFile(getIndexHtmlPath())
  }

  win.on('closed', () => {
    win = null
    clearCustomMaximized()
  })

  win.on('maximize', notifyMaximizedState)
  win.on('unmaximize', notifyMaximizedState)

  // 用户手动拖边/移动窗口 → 退出自定义最大化，图标与真实状态保持一致
  const scheduleDriftCheck = () => {
    if (!customMaximized) return
    if (driftTimer) clearTimeout(driftTimer)
    driftTimer = setTimeout(() => {
      driftTimer = null
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

export function minimizeMainWindow(minimize: boolean): void {
  if (!win) return
  if (customMaximized) {
    clearCustomMaximized()
    notifyMaximizedState()
  }

  const display = screen.getPrimaryDisplay()
  if (minimize) {
    const x = display.bounds.width - 230
    const y = display.bounds.height - 260
    win.setPosition(x, y)
    win.setSize(210, 210)
  } else {
    const x = Math.round(display.bounds.width / 2 - 250)
    const y = Math.round(display.bounds.height / 2 - 250)
    win.setPosition(x, y)
    win.setSize(500, 500)
  }
}

/** 系统级最小化（不是收成头像小球的那种迷你模式） */
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
 */
export function toggleMaximizeMainWindow(): boolean {
  if (!win || win.isDestroyed()) return false

  if (customMaximized) {
    const previous = restoreBounds
    clearCustomMaximized()
    if (previous) {
      try {
        win.setBounds(previous)
      } catch (error) {
        console.warn('[WindowManager] 还原窗口尺寸失败:', error)
      }
    }
    notifyMaximizedState()
    return false
  }

  const currentBounds = win.getBounds()
  const workArea = screen.getDisplayMatching(currentBounds).workArea

  restoreBounds = currentBounds
  expectedMaxBounds = workArea
  customMaximized = true
  maximizeAppliedAt = Date.now()

  try {
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
