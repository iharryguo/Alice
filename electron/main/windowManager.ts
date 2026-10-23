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

// 透明无边框窗口在 Windows 上调用原生 maximize() 不可靠（常常只放大一点点），
// 这里自己按屏幕工作区 setBounds 实现"真最大化"，并记住还原用的 bounds。
let customMaximized = false
let restoreBounds: Electron.Rectangle | null = null
// 最大化时"期望"的窗口 bounds（workArea）。守卫拿它比对，而不是重新查 workArea，
// 避免 DPI 取整/任务栏自动隐藏造成误判。
let expectedMaxBounds: Electron.Rectangle | null = null
let maximizeAppliedAt = 0
let resizeGuardTimer: NodeJS.Timeout | null = null

function notifyMaximizedState(): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('window:maximized-changed', isMainWindowMaximized())
}

function clearCustomMaximized(): void {
  customMaximized = false
  restoreBounds = null
  expectedMaxBounds = null
  if (resizeGuardTimer) {
    clearTimeout(resizeGuardTimer)
    resizeGuardTimer = null
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
    transparent: true,
    frame: false,
    width: 500,
    height: 500,
    resizable: true,
    alwaysOnTop: shouldAlwaysBeOnTop,
    hasShadow: false,
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

  // 最大化状态变化（含系统快捷键、双击标题栏）同步给渲染进程，用于切换按钮图标
  win.on('maximize', notifyMaximizedState)
  win.on('unmaximize', notifyMaximizedState)

  // 用户手动拖拽边缘/移动窗口 → 退出"自定义最大化"状态，保证图标与真实状态一致。
  // 拿到 resize/move 事件后延迟比对，避开 setBounds 与平台钳制带来的抖动。
  const scheduleMaximizedDriftCheck = () => {
    if (!customMaximized) return
    if (resizeGuardTimer) clearTimeout(resizeGuardTimer)
    resizeGuardTimer = setTimeout(() => {
      resizeGuardTimer = null
      if (!customMaximized || !win || win.isDestroyed()) return
      // 刚应用最大化的 400ms 内不判定，避免把 setBounds 的异步结果当成手动拖拽
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

  win.on('resize', scheduleMaximizedDriftCheck)
  win.on('move', scheduleMaximizedDriftCheck)

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
  // 面板开关会改变窗口尺寸，此时"自定义最大化"状态已经不再成立
  if (customMaximized) {
    clearCustomMaximized()
    notifyMaximizedState()
  }
  win.setSize(width, height)
}

export function minimizeMainWindow(minimize: boolean): void {
  if (!win) return

  // 迷你模式会改窗口尺寸，自定义最大化状态随之失效
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
 * 用屏幕工作区 + setBounds 实现，而不是 win.maximize()：
 * transparent + frameless 窗口在 Windows 上原生最大化经常只放大一点点。
 * 工作区（workArea）已经排除任务栏，符合 Windows 的最大化习惯。
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

  try {
    const workArea = screen.getDisplayMatching(currentBounds).workArea
    // 先立状态再改 bounds：resize 事件是异步的，但顺序反了会有一瞬间
    // 出现"窗口已经是工作区尺寸、标志还是 false"的中间态
    restoreBounds = currentBounds
    expectedMaxBounds = workArea
    customMaximized = true
    maximizeAppliedAt = Date.now()
    win.setBounds(workArea)

    // 兜底：个别机器上透明窗口的 setBounds 会"吃"掉一部分（只完成圆角/边框部分），
    // 这里核对两次，仍未到位才退回原生 maximize
    const boundsMatchTarget = (): boolean => {
      if (!win || win.isDestroyed()) return true
      const applied = win.getBounds()
      const target = expectedMaxBounds
      if (!target) return true
      const drifted =
        Math.abs(applied.width - target.width) > 8 ||
        Math.abs(applied.height - target.height) > 8 ||
        Math.abs(applied.x - target.x) > 8 ||
        Math.abs(applied.y - target.y) > 8
      if (drifted) {
        console.warn(
          '[WindowManager] 窗口尺寸与目标工作区不一致:',
          applied,
          '目标:',
          target
        )
      }
      return !drifted
    }

    setTimeout(() => {
      if (!win || win.isDestroyed() || !customMaximized) return
      if (boundsMatchTarget()) return

      // 第二次尝试：再 setBounds 一次（Windows 上第一次有时会被透明窗口吃掉）
      try {
        if (expectedMaxBounds) win.setBounds(expectedMaxBounds)
      } catch (retryError) {
        console.warn('[WindowManager] 第二次 setBounds 失败:', retryError)
      }

      setTimeout(() => {
        if (!win || win.isDestroyed() || !customMaximized) return
        if (boundsMatchTarget()) return
        console.warn('[WindowManager] setBounds 仍未生效，回退原生 maximize')
        try {
          win.maximize()
        } catch (nativeError) {
          console.error('[WindowManager] 原生 maximize 回退失败:', nativeError)
        }
      }, 220)
    }, 250)
  } catch (error) {
    console.warn(
      '[WindowManager] setBounds 最大化失败，回退到原生 maximize:',
      error
    )
    customMaximized = false
    expectedMaxBounds = null
    try {
      win.maximize()
      customMaximized = win.isMaximized()
      restoreBounds = currentBounds
    } catch (nativeError) {
      console.error('[WindowManager] 原生 maximize 也失败:', nativeError)
      clearCustomMaximized()
    }
  }

  notifyMaximizedState()
  return customMaximized
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
