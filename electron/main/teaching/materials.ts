import { app } from 'electron'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  buildPagesAndAnchors,
  evaluateMaterialQuality,
  type ExtractedPage,
} from './quality'
import {
  getMaterialByHash,
  insertMaterial,
  replaceAnchors,
  replacePages,
  updateMaterial,
} from './store'
import type {
  ContentAnchor,
  DocumentPage,
  MaterialRecord,
  MaterialSourceType,
} from './types'

const execFileAsync = promisify(execFile)

const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_PAGES = 200
const CONVERT_TIMEOUT_MS = 180_000
const EXTRACT_TIMEOUT_MS = 120_000

const EXTENSION_TO_TYPE: Record<string, MaterialSourceType> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
}

export interface ImportResult {
  success: boolean
  material?: MaterialRecord
  reused?: boolean
  error?: string
}

function materialsRoot(): string {
  return path.join(app.getPath('userData'), 'teaching', 'materials')
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const buffer = await fs.readFile(filePath)
  hash.update(buffer)
  return hash.digest('hex')
}

function getTeachingWorkerUrl(): URL {
  const appPath = app.getAppPath()
  const candidates = [
    path.join(
      appPath,
      'dist-electron',
      'main',
      'workers',
      'teachingPdfWorker.js'
    ),
    path.join(appPath, 'workers', 'teachingPdfWorker.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return pathToFileURL(candidate)
  }
  return new URL('./workers/teachingPdfWorker.js', import.meta.url)
}

async function extractPdfPages(pdfPath: string): Promise<ExtractedPage[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(getTeachingWorkerUrl(), {
      workerData: { appPath: app.getAppPath() },
    })

    const timeout = setTimeout(() => {
      worker.terminate().catch(() => undefined)
      reject(new Error('PDF 解析超时'))
    }, EXTRACT_TIMEOUT_MS)

    const cleanup = () => {
      clearTimeout(timeout)
      worker.removeAllListeners()
    }

    worker.once('message', message => {
      cleanup()
      worker.terminate().catch(() => undefined)
      if (message?.success) {
        resolve((message.pages || []) as ExtractedPage[])
        return
      }
      reject(new Error(message?.error || 'PDF 解析失败'))
    })

    worker.once('error', error => {
      cleanup()
      worker.terminate().catch(() => undefined)
      reject(error)
    })

    worker.postMessage({ filePath: pdfPath })
  })
}

const WORD_SCRIPT = `
param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Target)
$ErrorActionPreference = 'Stop'
$word = $null
$doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($Source, $false, $true)
  $doc.SaveAs([ref]$Target, [ref]17)
} finally {
  if ($doc -ne $null) { $doc.Close(0) }
  if ($word -ne $null) { $word.Quit() }
}
`

const POWERPOINT_SCRIPT = `
param([Parameter(Mandatory=$true)][string]$Source, [Parameter(Mandatory=$true)][string]$Target)
$ErrorActionPreference = 'Stop'
$ppt = $null
$pres = $null
try {
  $ppt = New-Object -ComObject PowerPoint.Application
  $pres = $ppt.Presentations.Open($Source, $true, $false, $false)
  $pres.SaveAs($Target, 32)
} finally {
  if ($pres -ne $null) { $pres.Close() }
  if ($ppt -ne $null) { $ppt.Quit() }
}
`

/**
 * 用本机 Office 把 docx/pptx 转成 PDF，拿到稳定页序与页锚点。
 *
 * 没有 Office 时不做"假装成功"的降级：直接把错误抛给用户，
 * 让人自己导一份 PDF 进来，比让课堂在错页上讲课要好。
 */
async function convertWithOffice(
  sourcePath: string,
  sourceType: 'docx' | 'pptx',
  targetPath: string
): Promise<void> {
  const script = sourceType === 'docx' ? WORD_SCRIPT : POWERPOINT_SCRIPT
  const scriptPath = path.join(
    os.tmpdir(),
    `alice-convert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`
  )

  await fs.writeFile(scriptPath, script, { encoding: 'utf-8' })

  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-Source',
        sourcePath,
        '-Target',
        targetPath,
      ],
      { timeout: CONVERT_TIMEOUT_MS, windowsHide: true }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Office 转换失败（需要本机安装 Word/PowerPoint，或先手工另存为 PDF）：${message}`
    )
  } finally {
    fs.unlink(scriptPath).catch(() => undefined)
  }

  if (!existsSync(targetPath)) {
    throw new Error('Office 转换没有生成 PDF，请先手工另存为 PDF 再导入')
  }
}

/** 读取 PNG/JPEG 的像素尺寸，图片材料需要它来做页面坐标归一化 */
async function readImageSize(
  filePath: string
): Promise<{ width: number; height: number }> {
  const buffer = await fs.readFile(filePath)

  if (buffer.length > 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    }
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      const length = buffer.readUInt16BE(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        }
      }
      offset += 2 + length
    }
  }

  return { width: 1000, height: 1400 }
}

export async function importTeachingMaterial(input: {
  filePath: string
  title?: string
}): Promise<ImportResult> {
  const sourcePath = input.filePath
  const extension = path.extname(sourcePath).toLowerCase()
  const sourceType = EXTENSION_TO_TYPE[extension]

  if (!sourceType) {
    return {
      success: false,
      error: `暂不支持 ${extension || '该'} 格式，可用 PDF、DOCX、PPTX 或图片`,
    }
  }

  let stat
  try {
    stat = await fs.stat(sourcePath)
  } catch {
    return { success: false, error: '找不到这个文件' }
  }

  if (stat.size > MAX_FILE_BYTES) {
    return {
      success: false,
      error: `文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过 32MB 上限，请拆分或压缩后再导入`,
    }
  }

  const sourceHash = await sha256OfFile(sourcePath)
  const existing = getMaterialByHash(sourceHash)
  if (existing && (existing.status === 'READY' || existing.status === 'NEEDS_REVIEW')) {
    return { success: true, material: existing, reused: true }
  }

  const id = `mat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const dir = path.join(materialsRoot(), id)
  await fs.mkdir(dir, { recursive: true })

  const storedSource = path.join(dir, `source${extension}`)
  await fs.copyFile(sourcePath, storedSource)

  const now = new Date().toISOString()
  const material: MaterialRecord = {
    id,
    title: input.title?.trim() || path.basename(sourcePath, extension),
    sourceType,
    sourcePath: storedSource,
    documentPath: null,
    sourceHash,
    pageCount: 0,
    status: 'PARSING',
    quality: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  }
  insertMaterial(material)

  try {
    let pdfPath: string | null = null

    if (sourceType === 'pdf') {
      pdfPath = storedSource
    } else if (sourceType === 'docx' || sourceType === 'pptx') {
      pdfPath = path.join(dir, 'converted.pdf')
      await convertWithOffice(storedSource, sourceType, pdfPath)
    }

    let pages: DocumentPage[] = []
    let anchors: ContentAnchor[] = []

    if (pdfPath) {
      const extracted = await extractPdfPages(pdfPath)
      if (extracted.length > MAX_PAGES) {
        throw new Error(
          `共 ${extracted.length} 页，超过 ${MAX_PAGES} 页上限，请拆分后再导入`
        )
      }
      const built = buildPagesAndAnchors(id, extracted)
      pages = built.pages
      anchors = built.anchors
    } else {
      const size = await readImageSize(storedSource)
      pages = [
        {
          materialId: id,
          pageIndex: 1,
          width: size.width,
          height: size.height,
          text: '',
          charCount: 0,
          textSource: 'none',
          textCoverage: 0,
        },
      ]
    }

    const quality = evaluateMaterialQuality(pages, { sourceType })

    replacePages(id, pages)
    replaceAnchors(id, anchors)
    updateMaterial(id, {
      status:
        quality.verdict === 'blocked'
          ? 'NEEDS_REVIEW'
          : quality.verdict === 'ready'
            ? 'READY'
            : 'NEEDS_REVIEW',
      documentPath: pdfPath,
      pageCount: pages.length,
      quality,
    })

    return { success: true, material: { ...material, ...{ quality } } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateMaterial(id, { status: 'IMPORT_FAILED', errorMessage: message })
    return { success: false, error: message }
  }
}

/** 测试与排障用：把页面与锚点重新算一遍，不改数据库以外的行为 */
export async function reparseMaterial(
  materialId: string,
  documentPath: string
): Promise<{ pages: number; anchors: number }> {
  const extracted = await extractPdfPages(documentPath)
  const { pages, anchors } = buildPagesAndAnchors(materialId, extracted)
  replacePages(materialId, pages)
  replaceAnchors(materialId, anchors)
  return { pages: pages.length, anchors: anchors.length }
}
