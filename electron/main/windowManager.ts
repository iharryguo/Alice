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

function notifyMaximizedState(): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('window:maximized-changed', isMainWindowMaximized())
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
    // 用 Windows 原生窗口：系统菜单、双击标题栏最大化/还原、贴边分屏、
    // 任务栏右键菜单里的"最大化"全部由系统提供，不再自己模拟。
    transparent: false,
    frame: true,
    backgroundColor: '#070c17',
    // 有原生标题栏了，客户区比窗口少一条标题栏的高度，所以默认给高一点，
    // 保证 480px 的头像不会被裁掉
    width: 520,
    height: 560,
    minWidth: 360,
    minHeight: 380,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    alwaysOnTop: shouldAlwaysBeOnTop,
    hasShadow: true,
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
  })

  // 最大化状态变化（系统按钮、双击标题栏、Win+方向键）同步给渲染进程
  win.on('maximize', notifyMaximizedState)
  win.on('unmaximize', notifyMaximizedState)

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
  // 最大化状态下改尺寸会先还原，这是 Windows 的正常语义
  if (win.isMaximized()) {
    win.unmaximize()
  }
  win.setSize(width, height)
}

export function minimizeMainWindow(minimize: boolean): void {
  if (!win) return
  if (win.isMaximized()) {
    win.unmaximize()
  }

  const display = screen.getPrimaryDisplay()
  if (minimize) {
    const x = display.bounds.width - 260
    const y = display.bounds.height - 300
    win.setPosition(x, y)
    win.setSize(240, 265)
  } else {
    const x = Math.round(display.bounds.width / 2 - 260)
    const y = Math.round(display.bounds.height / 2 - 280)
    win.setPosition(x, y)
    win.setSize(520, 560)
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
 * 窗口现在是标准 Windows 窗口，直接用原生 maximize/unmaximize：
 * 双击标题栏、任务栏系统菜单、Win+方向键贴边分屏全部由系统负责。
 */
export function toggleMaximizeMainWindow(): boolean {
  if (!win || win.isDestroyed()) return false
  if (win.isMaximized()) {
    win.unmaximize()
  } else {
    win.maximize()
  }
  notifyMaximizedState()
  return win.isMaximized()
}

export function isMainWindowMaximized(): boolean {
  if (!win || win.isDestroyed()) return false
  return win.isMaximized()
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
