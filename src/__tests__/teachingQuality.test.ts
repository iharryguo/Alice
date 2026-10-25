import { describe, expect, it } from 'vitest'
import {
  buildPagesAndAnchors,
  buildTranscriptionForCompiler,
  evaluateMaterialQuality,
  type ExtractedPage,
} from '../../electron/main/teaching/quality'

function page(
  pageIndex: number,
  lines: Array<{ text: string; x: number; y: number; width: number; height: number }>
): ExtractedPage {
  return { pageIndex, width: 600, height: 800, lines }
}

describe('buildPagesAndAnchors', () => {
  it('keeps character offsets aligned with the page text', () => {
    const { pages, anchors } = buildPagesAndAnchors('mat-1', [
      page(1, [
        { text: 'Hello', x: 60, y: 80, width: 120, height: 20 },
        { text: 'world', x: 200, y: 80, width: 100, height: 20 },
      ]),
    ])

    expect(pages).toHaveLength(1)
    expect(pages[0].text).toBe('Hello\nworld\n')
    expect(pages[0].charCount).toBe(10)

    expect(anchors).toHaveLength(2)
    expect(anchors[0].charStart).toBe(0)
    expect(anchors[0].charEnd).toBe(5)
    expect(anchors[1].charStart).toBe(6)
    expect(anchors[1].charEnd).toBe(11)
    expect(pages[0].text.slice(anchors[1].charStart, anchors[1].charEnd)).toBe(
      'world'
    )
  })

  it('normalises coordinates so the renderer can scale the page freely', () => {
    const { anchors } = buildPagesAndAnchors('mat-1', [
      page(2, [{ text: 'Anchor', x: 60, y: 80, width: 120, height: 40 }]),
    ])

    expect(anchors[0].x).toBeCloseTo(0.1, 4)
    expect(anchors[0].y).toBeCloseTo(0.1, 4)
    expect(anchors[0].width).toBeCloseTo(0.2, 4)
    expect(anchors[0].height).toBeCloseTo(0.05, 4)
  })

  it('marks pages without text as needing vision', () => {
    const { pages } = buildPagesAndAnchors('mat-1', [page(1, [])])
    expect(pages[0].textSource).toBe('none')
    expect(pages[0].charCount).toBe(0)
  })
})

describe('evaluateMaterialQuality', () => {
  const textPage = (index: number) => ({
    materialId: 'mat-1',
    pageIndex: index,
    width: 600,
    height: 800,
    text: 'x'.repeat(300),
    charCount: 300,
    textSource: 'text-layer' as const,
    textCoverage: 0.2,
  })

  const imagePage = (index: number) => ({
    materialId: 'mat-1',
    pageIndex: index,
    width: 600,
    height: 800,
    text: '',
    charCount: 0,
    textSource: 'none' as const,
    textCoverage: 0,
  })

  it('passes a normal text document', () => {
    const report = evaluateMaterialQuality([textPage(1), textPage(2)], {
      sourceType: 'pdf',
    })
    expect(report.verdict).toBe('ready')
    expect(report.pageCount).toBe(2)
    expect(report.lowTextPages).toEqual([])
  })

  it('blocks a scan without text layer', () => {
    const report = evaluateMaterialQuality([imagePage(1), imagePage(2)], {
      sourceType: 'pdf',
    })
    expect(report.verdict).toBe('blocked')
    expect(report.reasons[0]).toContain('扫描件')
  })

  it('asks for review when image pages dominate', () => {
    const report = evaluateMaterialQuality(
      [textPage(1), imagePage(2), imagePage(3)],
      { sourceType: 'pdf' }
    )
    expect(report.verdict).toBe('needs_review')
    expect(report.lowTextPages).toEqual([2, 3])
    expect(report.needsVisionPages).toEqual([2, 3])
  })

  it('accepts an image material but flags it for vision', () => {
    const report = evaluateMaterialQuality([imagePage(1)], {
      sourceType: 'image',
    })
    expect(report.verdict).toBe('needs_review')
    expect(report.needsVisionPages).toEqual([1])
  })
})

describe('buildTranscriptionForCompiler', () => {
  it('labels pages so the compiler can cite page numbers', () => {
    const text = buildTranscriptionForCompiler([
      {
        materialId: 'mat-1',
        pageIndex: 1,
        width: 600,
        height: 800,
        text: 'Lesson objective',
        charCount: 16,
        textSource: 'text-layer',
        textCoverage: 0.1,
      },
      {
        materialId: 'mat-1',
        pageIndex: 2,
        width: 600,
        height: 800,
        text: '',
        charCount: 0,
        textSource: 'none',
        textCoverage: 0,
      },
    ])

    expect(text).toContain('[第 1 页]')
    expect(text).toContain('Lesson objective')
    expect(text).toContain('[第 2 页]（本页为图片，无文字层）')
  })
})
