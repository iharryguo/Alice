import { describe, expect, it } from 'vitest'
import { assembleCourseVersion, matchAnchor } from '../courseCompiler'
import type { ContentAnchor } from '../../../../electron/main/teaching/types'

function anchor(
  id: string,
  pageIndex: number,
  text: string,
  charStart: number
): ContentAnchor {
  return {
    anchorId: id,
    materialId: 'mat-1',
    pageIndex,
    charStart,
    charEnd: charStart + text.length,
    x: 0.1,
    y: 0.2,
    width: 0.5,
    height: 0.03,
    text,
    confidence: 0.95,
  }
}

const anchors: ContentAnchor[] = [
  anchor('a1', 1, 'Present perfect connects past and now.', 0),
  anchor('a2', 1, 'I have lived here for five years.', 40),
  anchor('a3', 2, 'Practice: make your own sentence.', 0),
]

describe('matchAnchor', () => {
  it('picks the anchor whose text overlaps most', () => {
    const match = matchAnchor(anchors, 1, 'I have lived here for five years')
    expect(match?.anchorId).toBe('a2')
  })

  it('falls back to the first anchor of the page when nothing matches', () => {
    const match = matchAnchor(anchors, 2, '完全无关的一句话')
    expect(match?.anchorId).toBe('a3')
  })

  it('returns null when the page has no anchors', () => {
    expect(matchAnchor(anchors, 9, 'anything')).toBeNull()
  })
})

describe('assembleCourseVersion', () => {
  it('keeps nodes immutable-friendly and records anchor coverage', () => {
    const { course, anchorCoverage } = assembleCourseVersion({
      materialId: 'mat-1',
      outline: {
        title: 'Present Perfect',
        objectives: ['理解现在完成时'],
        prerequisites: ['一般过去时'],
        nodes: [
          { objective: '理解结构', required: true, minutes: 8, pages: [1] },
          { objective: '自己造句', required: false, minutes: 5, pages: [2] },
        ],
      },
      details: [
        {
          index: 0,
          talkingPoints: [
            { text: 'I have lived here for five years.', source: 'material', page: 1 },
          ],
        },
        {
          index: 1,
          talkingPoints: [
            { text: 'Practice: make your own sentence.', source: 'material', page: 2 },
          ],
          exercise: {
            type: 'short-answer',
            prompt: '写一句自己的现在完成时',
            expected: 'I have finished my homework.',
            rubric: [{ criterion: '结构正确', weight: 1 }],
            waitMs: 20000,
          },
        },
      ],
      anchors,
    })

    expect(course.nodes).toHaveLength(2)
    expect(course.status).toBe('DRAFT')
    expect(course.nodes[0].anchorIds).toEqual(['a2'])
    expect(course.nodes[0].required).toBe(true)
    expect(course.nodes[1].required).toBe(false)
    expect(course.nodes[1].exercises[0].type).toBe('short-answer')
    expect(anchorCoverage).toEqual({ nodesWithAnchors: 2, totalNodes: 2 })
  })

  it('still produces a teachable node when the model returns no talking points', () => {
    const { course } = assembleCourseVersion({
      materialId: 'mat-1',
      outline: {
        title: 'Fallback',
        objectives: [],
        prerequisites: [],
        nodes: [{ objective: '介绍概念', required: true, minutes: 5, pages: [1] }],
      },
      details: [{ index: 0, talkingPoints: [] }],
      anchors,
    })

    expect(course.nodes[0].talkingPoints).toHaveLength(1)
    expect(course.nodes[0].talkingPoints[0].source).toBe('teacher-addition')
  })
})
