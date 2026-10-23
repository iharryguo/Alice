import { app, desktopCapturer, ipcMain, screen } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 主动抓屏（给 take_screenshot 工具用）。
 *
 * 与 ipcManager 里的旧 `screenshot` 通道不同：
 * - 旧通道固定缩到 1200x1200，读不清屏幕文字
 * - 这里按显示器物理分辨率抓取，再把长边压到 1600 并转 JPEG，
 *   既保证文字可读，又把 base64 体积控制在几百 KB
 */

export type CaptureTarget = 'cursor' | 'primary' | 'all'

export interface ScreenCaptureShot {
  dataUrl: string
  width: number
  height: number
  savedPath: string
  displayName: string
  scaleFactor: number
}

export interface ScreenCaptureResult {
  success: boolean
  shots?: ScreenCaptureShot[]
  error?: string
}

const MAX_EDGE_PX = 1600
const JPEG_QUALITY = 82
const MAX_SAVED_FILES = 20
const SCREENSHOT_DIR_NAME = 'screenshots'

let handlersRegistered = false

function getScreenshotDir(): string {
  return path.join(app.getPath('userData'), SCREENSHOT_DIR_NAME)
}

function pickDisplays(target: CaptureTarget): Electron.Display[] {
  if (target === 'all') return screen.getAllDisplays()

  if (target === 'primary') return [screen.getPrimaryDisplay()]

  try {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    if (display) return [display]
  } catch (error) {
    console.warn('[ScreenCapture] 定位鼠标所在屏幕失败，回退到主屏:', error)
  }
  return [screen.getPrimaryDisplay()]
}

function shrinkToMaxEdge(image: Electron.NativeImage): Electron.NativeImage {
  const size = image.getSize()
  const longest = Math.max(size.width, size.height)
  if (longest <= MAX_EDGE_PX) return image

  const ratio = MAX_EDGE_PX / longest
  return image.resize({
    width: Math.max(1, Math.round(size.width * ratio)),
    height: Math.max(1, Math.round(size.height * ratio)),
    quality: 'good',
  })
}

function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

async function pruneScreenshots(directory: string): Promise<void> {
  try {
    const entries = await fs.readdir(directory)
    const images = entries.filter(name => name.toLowerCase().endsWith('.jpg'))
    if (images.length <= MAX_SAVED_FILES) return

    const withTime = await Promise.all(
      images.map(async name => {
        const filePath = path.join(directory, name)
        try {
          const stat = await fs.stat(filePath)
          return { filePath, mtime: stat.mtimeMs }
        } catch {
          return { filePath, mtime: 0 }
        }
      })
    )

    withTime.sort((a, b) => b.mtime - a.mtime)
    await Promise.all(
      withTime.slice(MAX_SAVED_FILES).map(item =>
        fs.unlink(item.filePath).catch(() => undefined)
      )
    )
  } catch (error) {
    console.warn('[ScreenCapture] 清理历史截图失败:', error)
  }
}

async function captureDisplay(
  display: Electron.Display,
  displayIndex: number
): Promise<ScreenCaptureShot> {
  const scaleFactor = display.scaleFactor || 1
  const thumbnailSize = {
    width: Math.max(1, Math.round(display.size.width * scaleFactor)),
    height: Math.max(1, Math.round(display.size.height * scaleFactor)),
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize,
  })

  if (!sources.length) {
    throw new Error(
      '未能获取任何屏幕画面（可能被系统权限拦截，或当前处于锁屏状态）'
    )
  }

  const matched =
    sources.find(source => source.display_id === String(display.id)) ??
    sources[displayIndex] ??
    sources[0]

  const raw = matched.thumbnail
  if (!raw || raw.isEmpty()) {
    throw new Error('抓到的屏幕画面是空的')
  }

  const finalImage = shrinkToMaxEdge(raw)
  const size = finalImage.getSize()
  const buffer = finalImage.toJPEG(JPEG_QUALITY)

  const directory = getScreenshotDir()
  await fs.mkdir(directory, { recursive: true })
  const fileName = `screen-${formatStamp(new Date())}-${displayIndex + 1}.jpg`
  const savedPath = path.join(directory, fileName)
  await fs.writeFile(savedPath, buffer)
  await pruneScreenshots(directory)

  return {
    dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`,
    width: size.width,
    height: size.height,
    savedPath,
    displayName: display.label || `屏幕 ${displayIndex + 1}`,
    scaleFactor,
  }
}

export async function captureScreens(
  target: CaptureTarget = 'cursor'
): Promise<ScreenCaptureResult> {
  try {
    const displays = pickDisplays(target)
    if (!displays.length) {
      return { success: false, error: '没有检测到可用显示器' }
    }

    const shots: ScreenCaptureShot[] = []
    const errors: string[] = []

    for (let index = 0; index < displays.length; index += 1) {
      try {
        shots.push(await captureDisplay(displays[index], index))
      } catch (error) {
        errors.push(
          `屏幕 ${index + 1}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }

    if (!shots.length) {
      return {
        success: false,
        error: errors.join('；') || '抓屏失败',
      }
    }

    return { success: true, shots }
  } catch (error) {
    console.error('[ScreenCapture] 抓屏失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function registerScreenCaptureHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true

  ipcMain.handle('screen:capture', async (_event, payload) => {
    const target = (payload?.target || 'cursor') as CaptureTarget
    const normalized: CaptureTarget =
      target === 'all' || target === 'primary' || target === 'cursor'
        ? target
        : 'cursor'
    return captureScreens(normalized)
  })
}
