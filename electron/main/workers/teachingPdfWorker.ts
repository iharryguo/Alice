import { parentPort, workerData } from 'node:worker_threads'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  getDocument,
  GlobalWorkerOptions,
} from 'pdfjs-dist/legacy/build/pdf.mjs'

/**
 * 教学材料 PDF 解析 worker。
 *
 * 与 RAG 用的 pdfParserWorker 的区别：这里必须保留每行的坐标，
 * 课程锚点、页面高亮、断点恢复都依赖"这句话在第几页的哪个位置"，
 * 所以不能只输出纯文本。
 */

if (!parentPort) {
  throw new Error('[Teaching] PDF worker started without a parent port.')
}

const resolveWorkerSrc = (): string => {
  const appPath = workerData?.appPath || process.cwd()
  const candidates = [
    path.join(appPath, 'dist-electron', 'main', 'workers', 'pdf.worker.mjs'),
    path.join(
      appPath,
      'node_modules',
      'pdfjs-dist',
      'legacy',
      'build',
      'pdf.worker.mjs'
    ),
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'pdf.worker.mjs'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return pathToFileURL(candidate).toString()
    }
  }
  return pathToFileURL(
    path.join(
      appPath,
      'node_modules',
      'pdfjs-dist',
      'legacy',
      'build',
      'pdf.worker.mjs'
    )
  ).toString()
}

GlobalWorkerOptions.workerSrc = resolveWorkerSrc()

interface RawTextItem {
  str?: string
  transform?: number[]
  width?: number
  height?: number
}

interface OutputLine {
  text: string
  x: number
  y: number
  width: number
  height: number
}

const LINE_TOLERANCE = 3

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function buildLines(
  items: RawTextItem[],
  viewport: { convertToViewportPoint: (x: number, y: number) => number[] }
): OutputLine[] {
  interface PositionedItem {
    text: string
    x: number
    y: number
    width: number
    height: number
  }

  const positioned: PositionedItem[] = []

  for (const item of items) {
    const text = String(item.str ?? '')
    if (!text.trim()) continue
    const transform = item.transform
    if (!transform || transform.length < 6) continue

    const rawX = toNumber(transform[4])
    const rawY = toNumber(transform[5])
    const [viewX, viewY] = viewport.convertToViewportPoint(rawX, rawY)

    const fontHeight = Math.abs(toNumber(transform[3])) || 10
    const height = toNumber(item.height, fontHeight) || fontHeight
    const width = toNumber(item.width, text.length * fontHeight * 0.5)

    positioned.push({
      text,
      x: viewX,
      y: viewY - height,
      width,
      height,
    })
  }

  // 同一基线上的文本块归为一行；容差 3pt 足以容纳中英混排的基线抖动
  const buckets: Array<{ baseline: number; items: PositionedItem[] }> = []
  for (const item of positioned) {
    const bucket = buckets.find(
      entry => Math.abs(entry.baseline - item.y) <= LINE_TOLERANCE
    )
    if (bucket) {
      bucket.items.push(item)
    } else {
      buckets.push({ baseline: item.y, items: [item] })
    }
  }

  buckets.sort((a, b) => a.baseline - b.baseline)

  const lines: OutputLine[] = []
  for (const bucket of buckets) {
    const ordered = bucket.items.sort((a, b) => a.x - b.x)
    let text = ''
    let lastEnd = -Infinity
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const item of ordered) {
      const gap = item.x - lastEnd
      if (text && gap > 1.5) text += ' '
      text += item.text
      lastEnd = item.x + item.width
      minX = Math.min(minX, item.x)
      minY = Math.min(minY, item.y)
      maxX = Math.max(maxX, item.x + item.width)
      maxY = Math.max(maxY, item.y + item.height)
    }

    const trimmed = text.trim()
    if (!trimmed) continue

    lines.push({
      text: trimmed,
      x: Math.max(0, minX),
      y: Math.max(0, minY),
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    })
  }

  return lines
}

parentPort.on('message', async message => {
  const filePath = message?.filePath
  if (!filePath || typeof filePath !== 'string') {
    parentPort?.postMessage({
      success: false,
      error: 'Teaching PDF worker missing file path.',
    })
    return
  }

  try {
    const buffer = await fs.readFile(filePath)
    const data = new Uint8Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength
    )
    // 不传 standardFontDataUrl：pdfjs-dist v5 随包只有 .pfb 标准字体，
    // 指定路径反而会报找不到 .ttf。实测宽度估算不依赖它，行框够用。
    const pdf = await getDocument({ data, disableWorker: true } as any).promise
    const pages = []

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const content = await page.getTextContent()
      const lines = buildLines(
        content.items as RawTextItem[],
        viewport as unknown as {
          convertToViewportPoint: (x: number, y: number) => number[]
        }
      )

      pages.push({
        pageIndex: pageNumber,
        width: viewport.width,
        height: viewport.height,
        lines,
      })

      page.cleanup()
    }

    parentPort?.postMessage({ success: true, pages })
  } catch (error) {
    parentPort?.postMessage({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
