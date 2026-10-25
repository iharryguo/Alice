import { describe, expect, it, vi } from 'vitest'
import { LessonRuntime, splitSentences } from '../lessonRuntime'
import type { LessonViewState } from '../lessonRuntime'
import type {
  ClassContract,
  CourseVersionRecord,
  LessonNode,
} from '../../../../electron/main/teaching/types'

function makeCourse(sentences: string[], nodeCount = 1): CourseVersionRecord {
  const courseVersionId = 'cv-test'
  const nodes: LessonNode[] = Array.from({ length: nodeCount }, (_, index) => ({
    nodeId: `node-${index}`,
    courseVersionId,
    sequence: index + 1,
    objective: `目标 ${index + 1}`,
    required: true,
    plannedDurationSec: 60,
    compressible: false,
    minDurationSec: 30,
    maxDurationSec: 90,
    anchorIds: [],
    talkingPoints: [
      { text: sentences.join(' '), source: 'material' as const, anchorIds: [] },
    ],
    exercises: [
      {
        exerciseId: `ex-${index}`,
        type: 'short-answer' as const,
        prompt: '说说你的理解',
        rubric: [{ criterion: '意思正确', weight: 1 }],
        waitMs: 5000,
      },
    ],
    completionRule: 'narration-committed' as const,
    recoveryPolicy: 'restart-sentence' as const,
  }))

  return {
    courseVersionId,
    courseId: 'course-test',
    version: 1,
    title: '测试课程',
    materialId: 'mat-test',
    status: 'CONFIRMED',
    objectives: ['能说出三个例句'],
    prerequisites: [],
    nodes,
    contentHash: 'hash',
    createdAt: '2026-01-01T00:00:00.000Z',
    confirmedAt: '2026-01-01T00:00:00.000Z',
  }
}

const contract: ClassContract = {
  contractVersionId: 'ct-test',
  courseVersionId: 'cv-test',
  version: 1,
  targetDurationMin: 25,
  pacePolicy: 'balanced',
  presentationMode: 'DOCUMENT_SYNC',
  languagePolicy: 'english-with-chinese-rescue',
  correctionPolicy: 'balanced',
  strictness: 'standard',
  wanderThreshold: { windowMinutes: 3, strikes: 2 },
  createdAt: '2026-01-01T00:00:00.000Z',
  confirmedAt: '2026-01-01T00:00:00.000Z',
}

interface Harness {
  runtime: LessonRuntime
  spoken: string[]
  states: LessonViewState[]
  steps: Array<{ action: string; committed: boolean; sentenceIndex: number }>
}

function createHarness(options: {
  sentences: string[]
  nodeCount?: number
  interruptAtCall?: number
  clock?: { value: number }
  clockStepMs?: number
}): Harness {
  const course = makeCourse(options.sentences, options.nodeCount ?? 1)
  const spoken: string[] = []
  const states: LessonViewState[] = []
  const steps: Array<{
    action: string
    committed: boolean
    sentenceIndex: number
  }> = []

  let runtimeRef: LessonRuntime | null = null
  let callCount = 0

  const runtime = new LessonRuntime({
    course,
    contract,
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
    showPage: () => undefined,
    highlight: () => undefined,
    poster: () => undefined,
    persistStep: step => {
      steps.push({
        action: step.action,
        committed: step.sentenceCommitted,
        sentenceIndex: step.sentenceIndex,
      })
    },
    evaluate: async () => ({ status: 'passed', feedback: '很好' }),
    onState: state => states.push(state),
  })

  runtimeRef = runtime
  return { runtime, spoken, states, steps }
}

describe('splitSentences', () => {
  it('splits on sentence punctuation and keeps order', () => {
    expect(splitSentences('One. Two! Three?')).toEqual(['One.', 'Two!', 'Three?'])
  })
})

describe('LessonRuntime', () => {
  it('opens the lesson and narrates the first node', async () => {
    const harness = createHarness({
      sentences: ['First sentence.', 'Second sentence.'],
    })

    await harness.runtime.start()

    expect(harness.spoken[0]).toContain('我们开始上课')
    expect(harness.spoken).toContain('First sentence.')
    expect(harness.spoken).toContain('Second sentence.')
    expect(harness.spoken.at(-1)).toContain('说说你的理解')
    expect(harness.states.at(-1)?.phase).toBe('PRACTICING')
    expect(harness.states.at(-1)?.awaitingAnswer).toBe(true)
  })

  it('resumes from the next sentence when the current one was committed', async () => {
    // 第 1 次是开场白，第 2 次是第一句，第 3 次是第二句：在第二句开口时打断
    const harness = createHarness({
      sentences: ['First sentence.', 'Second sentence.', 'Third sentence.'],
      interruptAtCall: 3,
    })

    await harness.runtime.start()
    harness.spoken.length = 0

    await harness.runtime.onUserUtterance('继续')

    const resumed = harness.spoken.filter(text =>
      text.includes('sentence.')
    )
    expect(resumed[0]).toBe('Second sentence.')
    expect(resumed.some(text => text.includes('Third'))).toBe(true)
  })

  it('replays the interrupted sentence from its start when it was not committed', async () => {
    // 第 2 次说话就是第一句，此时该句还没提交
    const harness = createHarness({
      sentences: ['First sentence.', 'Second sentence.'],
      interruptAtCall: 2,
    })

    await harness.runtime.start()
    harness.spoken.length = 0

    await harness.runtime.onUserUtterance('继续')

    expect(harness.spoken.filter(text => text.includes('sentence.'))[0]).toBe(
      'First sentence.'
    )
  })

  it('parks off-topic input and counts a strike', async () => {
    const harness = createHarness({ sentences: ['First sentence.'] })
    await harness.runtime.start()

    await harness.runtime.onUserUtterance('今天天气怎么样')

    const state = harness.states.at(-1)
    expect(state?.parkedTopics).toHaveLength(1)
    expect(state?.wanderStrikes).toBe(1)
    expect(harness.spoken.some(text => text.includes('课后'))).toBe(true)
  })

  it('advances to the next node on skip and records it', async () => {
    const harness = createHarness({
      sentences: ['First sentence.'],
      nodeCount: 2,
    })
    await harness.runtime.start()

    await harness.runtime.onUserUtterance('跳过')

    const state = harness.states.at(-1)
    expect(state?.nodeIndex).toBe(1)
    expect(harness.runtime.report().skippedObjectives).toEqual(['目标 1'])
  })

  it('warns about time debt when the node overruns', async () => {
    const clock = { value: 0 }
    // 每讲一句推进 200 秒，一个 60 秒的节点必然触发时间债提示
    const harness = createHarness({
      sentences: ['First sentence.'],
      clock,
      clockStepMs: 200_000,
    })

    await harness.runtime.start()

    expect(harness.spoken.some(text => text.includes('比计划慢了'))).toBe(true)
  })

  it('continues from a snapshot without repeating committed sentences', async () => {
    const course = makeCourse(['First sentence.', 'Second sentence.', 'Third sentence.'])
    const spoken: string[] = []

    const runtime = new LessonRuntime(
      {
        course,
        contract,
        speak: async text => {
          spoken.push(text)
        },
        stopSpeaking: () => undefined,
        showPage: () => undefined,
        highlight: () => undefined,
        poster: () => undefined,
        persistStep: () => undefined,
      },
      { nodeIndex: 0, sentenceIndex: 0, committed: true }
    )

    await runtime.continueFromSnapshot()

    expect(spoken[0]).toContain('接着上次')
    expect(spoken).toContain('Second sentence.')
    expect(spoken).not.toContain('First sentence.')
  })
})
