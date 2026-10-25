import type {
  ContentAnchor,
  DocumentPage,
  MaterialQualityReport,
} from './types'

/** 一页少于这么多字符，基本可以判定"这页主要是图" */
const LOW_TEXT_CHARS = 40
/** 整份材料少于此字符数，且不是图片，直接认为材料不可用 */
const MIN_USEFUL_CHARS = 200
/** 低文本页超过这个比例，要求人工过一遍再上课 */
const LOW_TEXT_PAGE_RATIO = 0.3
/** 文本层给出的锚点默认为高置信，视觉转写另算 */
const TEXT_LAYER_CONFIDENCE = 0.95

export interface ExtractedLine {
  text: string
  /** 页面坐标系（左上原点，单位 pt） */
  x: number
  y: number
  width: number
  height: number
}

export interface ExtractedPage {
  pageIndex: number
  width: number
  height: number
  lines: ExtractedLine[]
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

/**
 * 把 PDF worker 抽出的行转成页面记录与锚点。
 *
 * 文本用换行拼接，字符区间与行一一对应，锚点因此可以回到原文的精确位置；
 * 坐标归一化到 0—1，前端无论怎么缩放页面都能直接乘宽高还原高亮框。
 */
export function buildPagesAndAnchors(
  materialId: string,
  extracted: ExtractedPage[]
): { pages: DocumentPage[]; anchors: ContentAnchor[] } {
  const pages: DocumentPage[] = []
  const anchors: ContentAnchor[] = []

  for (const page of extracted) {
    const safeWidth = page.width > 0 ? page.width : 1
    const safeHeight = page.height > 0 ? page.height : 1
    const lines = page.lines.filter(line => line.text.trim().length > 0)

    let text = ''
    for (const line of lines) {
      const charStart = text.length
      text += line.text
      const charEnd = text.length
      text += '\n'

      anchors.push({
        anchorId: `anc-${materialId}-${page.pageIndex}-${charStart}`,
        materialId,
        pageIndex: page.pageIndex,
        charStart,
        charEnd,
        x: round4(line.x / safeWidth),
        y: round4(line.y / safeHeight),
        width: round4(line.width / safeWidth),
        height: round4(line.height / safeHeight),
        text: line.text,
        confidence: TEXT_LAYER_CONFIDENCE,
      })
    }

    const charCount = text.replace(/\s/g, '').length
    pages.push({
      materialId,
      pageIndex: page.pageIndex,
      width: page.width,
      height: page.height,
      text,
      charCount,
      textSource: charCount > 0 ? 'text-layer' : 'none',
      textCoverage: estimateTextCoverage(lines, safeWidth, safeHeight),
    })
  }

  return { pages, anchors }
}

/**
 * 文字覆盖率只用行框面积估算，不追求精确：它的用途是判断"这页该不该送模型读图"，
 * 以及质量报告里给用户一个可解释的数字，不是排版测量。
 */
function estimateTextCoverage(
  lines: ExtractedLine[],
  pageWidth: number,
  pageHeight: number
): number {
  const pageArea = pageWidth * pageHeight
  if (pageArea <= 0) return 0
  const covered = lines.reduce(
    (total, line) => total + Math.max(0, line.width) * Math.max(0, line.height),
    0
  )
  return round4(Math.min(1, covered / pageArea))
}

export function evaluateMaterialQuality(
  pages: DocumentPage[],
  options: { sourceType: 'pdf' | 'docx' | 'pptx' | 'image' }
): MaterialQualityReport {
  const pageCount = pages.length
  const totalChars = pages.reduce((sum, page) => sum + page.charCount, 0)
  const reasonList: string[] = []

  const lowTextPages = pages
    .filter(page => page.charCount < LOW_TEXT_CHARS)
    .map(page => page.pageIndex)
  const needsVisionPages = pages
    .filter(page => page.textSource === 'none')
    .map(page => page.pageIndex)

  if (pageCount === 0) {
    return {
      verdict: 'blocked',
      pageCount: 0,
      totalChars: 0,
      averageCharsPerPage: 0,
      lowTextPages: [],
      reasons: ['没有解析出任何页面'],
      needsVisionPages: [],
    }
  }

  if (options.sourceType === 'image') {
    reasonList.push('图片材料需要模型读图后才能生成课程')
    return {
      verdict: 'needs_review',
      pageCount,
      totalChars,
      averageCharsPerPage: Math.round(totalChars / pageCount),
      lowTextPages,
      reasons: reasonList,
      needsVisionPages,
    }
  }

  if (totalChars < MIN_USEFUL_CHARS) {
    reasonList.push(
      `整份材料只解析出 ${totalChars} 个字符，可能是扫描件或加密文档，需要先补文字或改用图片读图`
    )
    return {
      verdict: 'blocked',
      pageCount,
      totalChars,
      averageCharsPerPage: Math.round(totalChars / pageCount),
      lowTextPages,
      reasons: reasonList,
      needsVisionPages,
    }
  }

  if (lowTextPages.length > 0) {
    const ratio = lowTextPages.length / pageCount
    reasonList.push(
      `${lowTextPages.length} 页几乎没有文字（第 ${lowTextPages
        .slice(0, 10)
        .join('、')} 页），这些页只能用页码锚点`
    )
    const verdict = ratio > LOW_TEXT_PAGE_RATIO ? 'needs_review' : 'ready'
    return {
      verdict,
      pageCount,
      totalChars,
      averageCharsPerPage: Math.round(totalChars / pageCount),
      lowTextPages,
      reasons: reasonList,
      needsVisionPages,
    }
  }

  return {
    verdict: 'ready',
    pageCount,
    totalChars,
    averageCharsPerPage: Math.round(totalChars / pageCount),
    lowTextPages,
    reasons: reasonList,
    needsVisionPages,
  }
}

/**
 * 课程编译器只吃有文字的部分，这里按页拼成带页码标记的文本，
 * 页码标记让模型能回填锚点，而不是只根据内容猜位置。
 */
export function buildTranscriptionForCompiler(pages: DocumentPage[]): string {
  return pages
    .map(page => {
      const body = page.text.trim()
      if (!body) {
        return `[第 ${page.pageIndex} 页]（本页为图片，无文字层）`
      }
      return `[第 ${page.pageIndex} 页]\n${body}`
    })
    .join('\n\n')
}
