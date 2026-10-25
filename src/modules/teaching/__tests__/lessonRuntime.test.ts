import { describe, expect, it } from 'vitest'
import { LessonRuntime, isUnknownAnswer, splitSentences } from '../lessonRuntime'
import type { LessonViewState } from '../lessonRuntime'
import type {
  ClassContract,
  CourseVersionRecord,
  LessonNode,
} from '../../../../electron/main/teaching/types'

function makeNode(
  index: number,
  sentences: string[],
  anchorIds: string[]
): LessonNode {
  return {
    nodeId: `node-${index}`,
    courseVersionId: 'cv-test',
    sequence: index + 1,
    objective: `第 ${index + 1} 节目标`,
    required: true,
    plannedDurationSec: 60,
    compressible: false,
    minDurationSec: 30,
    maxDurationSec: 90,
    anchorIds,
    talkingPoints: sentences.map((text, pointIndex) => ({
      text,
      source: 'material' as const,
      anchorIds: [anchorIds[pointIndex] ?? anchorIds[0]],
    })),
    exercises: [
      {
        exerciseId: `ex-${index}`,
        type: 'short-answer' as const,
        prompt: 'Which family is most similar to yours?',
        expected:
          'The family in picture one is similar because we have two children.',
        rubric: [{ criterion: '意思正确', weight: 1 }],
        waitMs: 5000,
      },
    ],
    completionRule: 'narration-committed' as const,
    recoveryPolicy: 'restart-sentence' as const,
  }
}

function makeCourse(nodes: LessonNode[]): CourseVersionRecord {
  return {
    courseVersionId: 'cv-test',
    courseId: 'course-test',
    version: 1,
    title: 'Families',
    materialId: 'mat-test',
    status: 'CONFIRMED',
    objectives: ['describe families'],
    prerequisites: [],
    nodes,
    contentHash: 'hash',
    createdAt: '2026-01-01T00:00:00.000Z',
    confirmedAt: '2026-01-01T00:00:00.000Z',
  }
}

function makeContract(overrides: Partial<ClassContract> = {}): ClassContract {
  return {
    contractVersionId: 'ct-test',
    courseVersionId: 'cv-test',
    version: 1,
    targetDurationMin: 25,
    pacePolicy: 'balanced',
    presentationMode: 'DOCUMENT_SYNC',
    languagePolicy: 'immersion',
    correctionPolicy: 'balanced',
    strictness: 'standard',
    wanderThreshold: { windowMinutes: 3, strikes: 2 },
    createdAt: '2026-01-01T00:00:00.000Z',
    confirmedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

interface HarnessOptions {
  nodes: LessonNode[]
  contract?: ClassContract
  narration?: Record<string, string[]>
  interruptAtCall?: number
  clock?: { value: number }
  clockStepMs?: number
}

function createHarness(options: HarnessOptions) {
  const course = makeCourse(options.nodes)
  const spoken: string[] = []
  const states: LessonViewState[] = []
  const anchorsShown: Array<{ anchorIds: string[]; pointIndex: number }> = []
  const scaffoldCalls: number[] = []

  let runtimeRef: LessonRuntime | null = null
  let callCount = 0

  const runtime = new LessonRuntime({
    course,
    contract: options.contract ?? makeContract(),
    now: () => options.clock?.value ?? Date.now(),
    speak: async text => {
      spoken.push(text)
      callCount += 1
      if (options.clock && options.clockStepMs) {
        options.clock.value += options.clockStepMs
      }
      if (options.interruptAtCall && callCount === options.interruptAtCall) {
        runtimeRef?.onUserSpeechStart()
      }
    },
    stopSpeaking: () => undefined,
    showAnchor: (anchorIds, pointIndex) => {
      anchorsShown.push({ anchorIds, pointIndex })
    },
    setListening: () => undefined,
    poster: () => undefined,
    persistStep: () => undefined,
    composeNarration: async node => {
      const lines = options.narration?.[node.nodeId]
      if (!lines) return null
      return {
        opening: 'Today we look at families.',
        segments: lines.map((text, pointIndex) => ({ text, pointIndex })),
      }
    },
    scaffold: async ({ attempt }) => {
      scaffoldCalls.push(attempt)
      const giveUp = attempt >= 3
      return {
        say: giveUp ? 'Here is the answer.' : 'Try the beginning of the sentence.',
        giveUp,
      }
    },
    phrase: key => (key === 'timeDebt' ? 'We are behind schedule.' : key),
    evaluate: async () => ({ status: 'needs-review', feedback: '' }),
    onState: state => states.push(state),
  })

  runtimeRef = runtime
  return { runtime, spoken, states, anchorsShown, scaffoldCalls }
}

describe('splitSentences', () => {
  it('splits on sentence punctuation', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?'])
  })
})

describe('isUnknownAnswer', () => {
  it('recognises the ways a student says they do not know', () => {
    expect(isUnknownAnswer("I don't know!")).toBe(true)
    expect(isUnknownAnswer('我不知道')).toBe(true)
    expect(isUnknownAnswer('no idea')).toBe(true)
    expect(isUnknownAnswer('The family in picture one')).toBe(false)
  })
})

describe('LessonRuntime', () => {
  it('speaks the composed narration and switches the page per segment', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['Point one.', 'Point two.'], ['anc-p1', 'anc-p2'])],
      narration: {
        'node-0': ['Look at this family.', 'Now this one has two children.'],
      },
    })

    await harness.runtime.start()

    expect(harness.spoken[0]).toBe('Today we look at families.')
    expect(harness.spoken).toContain('Look at this family.')
    expect(harness.spoken).toContain('Now this one has two children.')

    // 每个讲解段都换一次锚点，这就是自动翻页的依据
    expect(harness.anchorsShown[0]).toEqual({
      anchorIds: ['anc-p1'],
      pointIndex: 0,
    })
    expect(harness.anchorsShown[1]).toEqual({
      anchorIds: ['anc-p2'],
      pointIndex: 1,
    })
  })

  it('treats "I do not know" as an answer and scaffolds instead of telling the student to rest', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['Point one.'], ['anc-p1'])],
      narration: { 'node-0': ['Look at this family.'] },
    })

    await harness.runtime.start()
    harness.spoken.length = 0

    await harness.runtime.onUserUtterance("I don't know!")

    expect(harness.scaffoldCalls).toEqual([1])
    expect(harness.spoken.some(text => text.includes('Try the beginning'))).toBe(
      true
    )
    expect(harness.spoken.some(text => text.includes('休息'))).toBe(false)
    expect(harness.states.at(-1)?.awaitingAnswer).toBe(true)
  })

  it('marks the objective for review after three failed attempts', async () => {
    const harness = createHarness({
      nodes: [
        makeNode(0, ['Point one.'], ['anc-p1']),
        makeNode(1, ['Point two.'], ['anc-p2']),
      ],
      narration: { 'node-0': ['Look at this family.'], 'node-1': ['Next one.'] },
    })

    await harness.runtime.start()
    await harness.runtime.onUserUtterance('不知道')
    await harness.runtime.onUserUtterance('不知道')
    await harness.runtime.onUserUtterance('不知道')

    expect(harness.runtime.report().pendingObjectives).toEqual(['第 1 节目标'])
    expect(harness.states.at(-1)?.nodeIndex).toBe(1)
  })

  it('resumes from the next segment when the current one was committed', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['A.', 'B.', 'C.'], ['a1', 'a2', 'a3'])],
      narration: { 'node-0': ['First line.', 'Second line.', 'Third line.'] },
      interruptAtCall: 3,
    })

    await harness.runtime.start()
    harness.spoken.length = 0

    await harness.runtime.onUserUtterance('继续')

    const resumed = harness.spoken.filter(text => text.includes('line.'))
    expect(resumed[0]).toBe('Second line.')
  })

  it('replays the interrupted segment when it was not committed', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['A.', 'B.'], ['a1', 'a2'])],
      narration: { 'node-0': ['First line.', 'Second line.'] },
      interruptAtCall: 2,
    })

    await harness.runtime.start()
    harness.spoken.length = 0

    await harness.runtime.onUserUtterance('继续')

    expect(harness.spoken.filter(text => text.includes('line.'))[0]).toBe(
      'First line.'
    )
  })

  it('parks off-topic input and counts a strike', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['A.'], ['a1'])],
      narration: { 'node-0': ['First line.'] },
      contract: makeContract({ languagePolicy: 'english-with-chinese-rescue' }),
    })

    await harness.runtime.start()
    await harness.runtime.onUserUtterance('今天天气怎么样')

    const state = harness.states.at(-1)
    expect(state?.parkedTopics).toHaveLength(1)
    expect(state?.wanderStrikes).toBe(1)
  })

  it('advances on skip and records it as not mastered', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['A.'], ['a1']), makeNode(1, ['B.'], ['a2'])],
      narration: { 'node-0': ['First line.'], 'node-1': ['Second line.'] },
    })

    await harness.runtime.start()
    await harness.runtime.onUserUtterance('跳过')

    expect(harness.states.at(-1)?.nodeIndex).toBe(1)
    expect(harness.runtime.report().skippedObjectives).toEqual(['第 1 节目标'])
  })

  it('announces time debt when a node overruns', async () => {
    const clock = { value: 0 }
    const harness = createHarness({
      nodes: [makeNode(0, ['A.'], ['a1'])],
      narration: { 'node-0': ['First line.'] },
      clock,
      clockStepMs: 200_000,
    })

    await harness.runtime.start()

    expect(harness.spoken).toContain('We are behind schedule.')
  })

  it('continues from a snapshot without repeating committed segments', async () => {
    const spoken: string[] = []
    const runtime = new LessonRuntime(
      {
        course: makeCourse([makeNode(0, ['A.', 'B.', 'C.'], ['a1', 'a2', 'a3'])]),
        contract: makeContract(),
        speak: async text => {
          spoken.push(text)
        },
        stopSpeaking: () => undefined,
        showAnchor: () => undefined,
        poster: () => undefined,
        persistStep: () => undefined,
      },
      { nodeIndex: 0, segmentIndex: 0, committed: true }
    )

    await runtime.continueFromSnapshot()

    expect(spoken).toContain('B.')
    expect(spoken).not.toContain('A.')
  })
})
