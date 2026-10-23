import { app, Menu, Tray, nativeImage } from 'electron'
import path from 'node:path'
import {
  getMainWindow,
  getVitePublic,
  markAppQuitting,
  setTrayAvailable,
} from './windowManager'

/**
 * 系统托盘：关闭窗口时收进右下角托盘而不是退出，
 * 托盘菜单可以再唤回来或者真正退出。
 */

let tray: Tray | null = null

function buildTrayIcon(): Electron.NativeImage {
  const iconPath = path.join(getVitePublic(), 'app_logo.png')
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    console.warn('[Tray] 托盘图标为空:', iconPath)
    return image
  }
  return image.resize({ width: 16, height: 16 })
}

function showMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function createTray(): Tray | null {
  if (tray && !tray.isDestroyed()) return tray

  try {
    tray = new Tray(buildTrayIcon())
    tray.setToolTip('Alice')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示 Alice', click: () => showMainWindow() },
        { type: 'separator' },
        {
          label: '退出 Alice',
          click: () => {
            markAppQuitting()
            app.quit()
          },
        },
      ])
    )
    tray.on('click', () => showMainWindow())
    tray.on('double-click', () => showMainWindow())
    setTrayAvailable(true)
    return tray
  } catch (error) {
    console.warn('[Tray] 创建托盘失败:', error)
    setTrayAvailable(false)
    return null
  }
}

export function destroyTray(): void {
  setTrayAvailable(false)
  if (tray && !tray.isDestroyed()) {
    tray.destroy()
  }
  tray = null
}
