import { describe, expect, it } from 'vitest'
import {
  LessonRuntime,
  isMetaFeedback,
  isUnknownAnswer,
  splitSentences,
} from '../lessonRuntime'
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
  narration?: Record<
    string,
    Array<string | { text: string; kind?: 'say' | 'ask'; page?: number }>
  >
  interruptAtCall?: number
  clock?: { value: number }
  clockStepMs?: number
}

function createHarness(options: HarnessOptions) {
  const course = makeCourse(options.nodes)
  const spoken: string[] = []
  const states: LessonViewState[] = []
  const anchorsShown: Array<{
    anchorIds: string[]
    pointIndex: number
    page?: number
  }> = []
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
    showAnchor: (anchorIds, pointIndex, page) => {
      anchorsShown.push({ anchorIds, pointIndex, page })
    },
    setListening: () => undefined,
    poster: () => undefined,
    persistStep: () => undefined,
    composeNarration: async node => {
      const lines = options.narration?.[node.nodeId]
      if (!lines) return null
      return {
        opening: 'Today we look at families.',
        segments: lines.map((line, pointIndex) =>
          typeof line === 'string'
            ? { text: line, pointIndex, kind: 'say' as const }
            : {
                text: line.text,
                pointIndex,
                kind: line.kind ?? ('say' as const),
                page: line.page,
              }
        ),
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

  /** 讲解在后台推进，断言前把微任务与零延迟定时器放完 */
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  return { runtime, spoken, states, anchorsShown, scaffoldCalls, settle }
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

describe('isMetaFeedback', () => {
  it('treats Chinese comments about the lesson itself as questions, not off-topic', () => {
    expect(isMetaFeedback('你看这里又出现中文了，这是个 bug')).toBe(true)
    expect(isMetaFeedback('他问了我一个问题，应该等我回答')).toBe(true)
    expect(isMetaFeedback('今天天气怎么样')).toBe(false)
    expect(isMetaFeedback('It is Samir.')).toBe(false)
  })
})

describe('splitSentences', () => {
  it('keeps ellipsis and quoted patterns whole instead of leaving punctuation fragments', () => {
    const parts = splitSentences(
      "Use the pattern 'The family in picture one is...' or '...has...' to describe a photo."
    )

    // 每个片段都必须有可朗读的内容，不能再出现 "." "'" 这种碎片
    expect(parts.every(part => /[A-Za-z0-9]/.test(part))).toBe(true)
    expect(parts.join(' ')).toContain('...')
  })
})

describe('LessonRuntime', () => {
  it('stops right away when the pause button is pressed, even mid-narration', async () => {
    const course = makeCourse([makeNode(0, ['A.', 'B.', 'C.'], ['a1', 'a2', 'a3'])])
    const spoken: string[] = []
    let release: (() => void) | null = null
    let speakCalls = 0

    const runtime = new LessonRuntime({
      course,
      contract: makeContract(),
      speak: async text => {
        spoken.push(text)
        speakCalls += 1
        // 第二句开口后卡住，模拟"老师正在讲"
        if (speakCalls === 2) {
          await new Promise<void>(resolve => {
            release = resolve
          })
        }
      },
      stopSpeaking: () => {
        release?.()
      },
      showAnchor: () => undefined,
      poster: () => undefined,
      persistStep: () => undefined,
      composeNarration: async () => ({
        opening: 'Opening.',
        segments: [
          { text: 'First line.', pointIndex: 0, kind: 'say' as const },
          { text: 'Second line.', pointIndex: 1, kind: 'say' as const },
          { text: 'Third line.', pointIndex: 2, kind: 'say' as const },
        ],
      }),
      onState: () => undefined,
    })

    await runtime.start()
    // 等讲解真正开口
    for (let i = 0; i < 10 && speakCalls < 2; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(speakCalls).toBe(2)

    runtime.pauseByUser()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(runtime.snapshot().turnState).toBe('PAUSED')
    // 暂停后不能继续往下讲第三句
    expect(spoken).not.toContain('Third line.')
  })

  it('answers a question during practice without counting it as a wrong answer', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['A.'], ['a1'])],
      narration: { 'node-0': ['First line.'] },
    })

    await harness.runtime.start()
    await harness.settle()
    expect(harness.states.at(-1)?.phase).toBe('PRACTICING')

    await harness.runtime.onUserUtterance('这一题是什么意思？')
    await harness.settle()

    // 仍然停在练习环节等答案，没有被当成一次错误作答
    expect(harness.states.at(-1)?.phase).toBe('PRACTICING')
    expect(harness.states.at(-1)?.awaitingAnswer).toBe(true)
    expect(harness.spoken.some(text => text.includes('Good question'))).toBe(true)
  })

  it('speaks the composed narration and switches the page per segment', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['Point one.', 'Point two.'], ['anc-p1', 'anc-p2'])],
      narration: {
        'node-0': ['Look at this family.', 'Now this one has two children.'],
      },
    })

    await harness.runtime.start()
    await harness.settle()

    expect(harness.spoken[0]).toBe('Today we look at families.')
    expect(harness.spoken).toContain('Look at this family.')
    expect(harness.spoken).toContain('Now this one has two children.')

    // 每个讲解段都换一次锚点，这就是自动翻页的依据
    expect(harness.anchorsShown[0]).toMatchObject({
      anchorIds: ['anc-p1'],
      pointIndex: 0,
    })
    expect(harness.anchorsShown[1]).toMatchObject({
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
    await harness.settle()
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
    await harness.settle()
    await harness.runtime.onUserUtterance('不知道')
    await harness.runtime.onUserUtterance('不知道')
    await harness.runtime.onUserUtterance('不知道')
    await harness.settle()

    expect(harness.runtime.report().pendingObjectives).toEqual(['第 1 节目标'])
    expect(harness.states.at(-1)?.nodeIndex).toBe(1)
  })

  it('continues with the next segment after a barge-in instead of replaying the interrupted line', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['A.', 'B.', 'C.'], ['a1', 'a2', 'a3'])],
      narration: { 'node-0': ['First line.', 'Second line.', 'Third line.'] },
      // 1 = 开场，2 = 第一句，3 = 第二句：在第二句开口时被打断
      interruptAtCall: 3,
    })

    await harness.runtime.start()
    await harness.settle()
    harness.spoken.length = 0

    await harness.runtime.onUserUtterance('继续')
    await harness.settle()

    const resumed = harness.spoken.filter(text => text.includes('line.'))
    expect(resumed[0]).toBe('Third line.')
    expect(resumed).not.toContain('Second line.')
  })

  it('replays the current line only when the student asks for it', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['A.', 'B.'], ['a1', 'a2'])],
      narration: { 'node-0': ['First line.', 'Second line.'] },
    })

    await harness.runtime.start()
    await harness.settle()
    harness.spoken.length = 0

    await harness.runtime.onUserUtterance('再说一遍')

    expect(harness.spoken).toContain('Second line.')
  })

  it('feeds the page of each segment to the stage instead of sending page one twice', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['P1.', 'P2.', 'P3.'], ['a1', 'a2', 'a3'])],
      narration: {
        'node-0': [
          { text: 'Look at the first photo.', page: 2 },
          { text: 'This one has two children.', page: 3 },
          { text: 'And here is the last family.', page: 4 },
        ],
      },
    })

    await harness.runtime.start()
    await harness.settle()

    const pages = harness.anchorsShown
      .map(item => item.page)
      .filter((page): page is number => typeof page === 'number')
    expect(pages).toEqual([2, 3, 4])
  })

  it('does not speak the same line twice when a barge-in races the narration loop', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['A.', 'B.', 'C.'], ['a1', 'a2', 'a3'])],
      narration: { 'node-0': ['First line.', 'Second line.', 'Third line.'] },
      // 第二句开口时被打断：这条路径过去会拉起第二条讲解循环，导致同一句被念两遍
      interruptAtCall: 3,
    })

    await harness.runtime.start()
    await harness.runtime.onUserUtterance('继续')
    await harness.runtime.onUserUtterance('继续')

    const lines = harness.spoken.filter(text => text.includes('line.'))
    for (let index = 1; index < lines.length; index += 1) {
      expect(lines[index]).not.toBe(lines[index - 1])
    }
  })

  it('stops and waits after a question segment', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['A.', 'B.'], ['a1', 'a2'])],
      narration: {
        'node-0': [
          { text: 'Who is that?', kind: 'ask' },
          'Next line.',
        ],
      },
    })

    await harness.runtime.start()
    await harness.settle()

    expect(harness.spoken).toContain('Who is that?')
    expect(harness.spoken).not.toContain('Next line.')
    expect(harness.states.at(-1)?.awaitingAnswer).toBe(true)

    await harness.runtime.onUserUtterance('It is Samir.')
    await harness.settle()

    expect(harness.spoken).toContain('Next line.')
    // 讲完之后进入练习环节，又在等练习答案了
    expect(harness.states.at(-1)?.phase).toBe('PRACTICING')
  })

  it('asks before ending, and only ends after the student confirms', async () => {
    const course = makeCourse([makeNode(0, ['A.'], ['a1'])])
    const states: LessonViewState[] = []
    const spoken: string[] = []

    const runtime = new LessonRuntime({
      course,
      contract: makeContract(),
      speak: async text => {
        spoken.push(text)
      },
      stopSpeaking: () => undefined,
      showAnchor: () => undefined,
      poster: () => undefined,
      persistStep: () => undefined,
      // 模型显式给出指令，而不是靠关键词
      answer: async () => ({
        say: 'Okay, let us stop here for today.',
        directive: 'END_LESSON',
      }),
      onState: state => states.push(state),
    })

    await runtime.start()
    await runtime.onUserUtterance("I'd like to stop now")

    // 第一次只是提出下课：先问一句，不能立刻结束
    expect(states.at(-1)?.finished).toBe(false)
    expect(spoken.some(line => line.includes('stop here for today'))).toBe(true)

    await runtime.onUserUtterance('yes')

    expect(states.at(-1)?.finished).toBe(true)
    expect(states.at(-1)?.phase).toBe('COMPLETED')
  })

  it('keeps teaching when the model returns no directive', async () => {
    const course = makeCourse([makeNode(0, ['A.', 'B.'], ['a1', 'a2'])])
    const states: LessonViewState[] = []

    const runtime = new LessonRuntime({
      course,
      contract: makeContract(),
      speak: async () => undefined,
      stopSpeaking: () => undefined,
      showAnchor: () => undefined,
      poster: () => undefined,
      persistStep: () => undefined,
      answer: async () => ({ say: 'Good question.', directive: 'NONE' }),
      onState: state => states.push(state),
    })

    await runtime.start()
    await runtime.onUserUtterance('Why is B correct?')

    expect(states.at(-1)?.finished).toBe(false)
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

  it('advances on skip only after confirmation, and records it as not mastered', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['A.'], ['a1']), makeNode(1, ['B.'], ['a2'])],
      narration: { 'node-0': ['First line.'], 'node-1': ['Second line.'] },
    })

    await harness.runtime.start()
    await harness.runtime.onUserUtterance('跳过')

    // 还没有跳：先确认
    expect(harness.states.at(-1)?.nodeIndex).toBe(0)

    await harness.runtime.onUserUtterance('跳过')
    expect(harness.states.at(-1)?.nodeIndex).toBe(1)
    expect(harness.runtime.report().skippedObjectives).toEqual(['第 1 节目标'])
  })

  it('keeps teaching when the student declines the confirmation', async () => {
    const harness = createHarness({
      nodes: [makeNode(0, ['A.', 'B.'], ['a1', 'a2'])],
      narration: { 'node-0': ['First line.', 'Second line.'] },
    })

    await harness.runtime.start()
    harness.spoken.length = 0

    await harness.runtime.onUserUtterance('下课')
    expect(harness.states.at(-1)?.finished).toBe(false)

    await harness.runtime.onUserUtterance('不要，继续')
    expect(harness.states.at(-1)?.finished).toBe(false)
    // 拒绝之后要真的继续上课：先应一句，再离开暂停态
    expect(harness.spoken.some(text => text.includes('we keep going'))).toBe(true)
    expect(harness.states.at(-1)?.turnState).not.toBe('PAUSED')
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
    await harness.settle()

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
