import type {
  ClassContract,
  ClassSession,
  CourseVersionRecord,
  LessonExerciseDraft,
  LessonNode,
  TeachingActionType,
  TeachingStepRecord,
  TurnState,
} from '../../../electron/main/teaching/types'

/**
 * 课堂运行时。
 *
 * 三条原则：
 * 1) 说什么由课堂契约决定（全英文 / 中文救场 / 中文讲解），所以讲解句从
 *    composeNarration 现场生成，不念编译阶段的中文要点。
 * 2) 每个讲解段都绑定它来自哪个 talkingPoint，据此翻页与高亮——这是自动翻页的依据。
 * 3) 学生答不上来走脚手架（提示→示范→记待复习），不评判人格、不让"休息一下"。
 *
 * 不依赖 Vue / Pinia，便于单测与恢复推演。
 */

export type IntentKind =
  | 'filler'
  | 'question'
  | 'control'
  | 'off-topic'
  | 'distress'

export interface IntentResult {
  kind: IntentKind
  confidence: number
  control?: 'pause' | 'resume' | 'repeat' | 'slower' | 'chinese' | 'skip' | 'end'
  reason?: string
}

export interface LessonViewState {
  phase: ClassSession['phase']
  turnState: TurnState
  presentationState: ClassSession['presentationState']
  nodeIndex: number
  nodeObjective: string
  sentenceIndex: number
  sentenceText: string
  totalNodes: number
  plannedElapsedSec: number
  actualElapsedSec: number
  timeDebtSec: number
  wanderStrikes: number
  parkedTopics: Array<{ text: string; at: number }>
  transcript: Array<{ role: 'teacher' | 'student' | 'system'; text: string }>
  currentAnchorIds: string[]
  currentPage: number
  awaitingAnswer: boolean
  listening: boolean
  pacePrompt: string | null
  finished: boolean
}

export interface NarrationSegment {
  text: string
  /** 对应 node.talkingPoints 的下标，没有来源时为 -1 */
  pointIndex: number
}

export interface LessonRuntimeDeps {
  course: CourseVersionRecord
  contract: ClassContract
  now?: () => number
  speak: (text: string, teacherTurnId: string) => Promise<void>
  stopSpeaking: () => void
  /** 展示某段对应的页面与高亮；运行时只给锚点，具体怎么渲染由界面决定 */
  showAnchor: (anchorIds: string[], pointIndex: number) => void
  /** 老师此刻是否在收音（界面上要能看到） */
  setListening?: (listening: boolean) => void
  poster: (patch: Partial<ClassSession>) => void
  persistStep: (step: TeachingStepRecord) => void
  composeNarration?: (
    node: LessonNode
  ) => Promise<{ opening: string; segments: NarrationSegment[] } | null>
  scaffold?: (args: {
    node: LessonNode
    exercise: LessonExerciseDraft
    attempt: number
    studentSaid: string
  }) => Promise<{ say: string; giveUp: boolean }>
  classify?: (text: string, context: string) => Promise<IntentResult | null>
  answer?: (text: string, context: string) => Promise<string | null>
  evaluate?: (
    answer: string,
    prompt: string,
    rubric: Array<{ criterion: string; weight: number }>
  ) => Promise<{ status: 'passed' | 'needs-review' | 'skipped'; feedback: string }>
  phrase?: (key: 'paused' | 'resumed' | 'skipped' | 'timeDebt' | 'end') => string
  saveAttempt?: (attempt: {
    exerciseId: string
    studentInput: string
    score: { status: string; feedback?: string }
  }) => void
  onState?: (state: LessonViewState) => void
}

const FILLERS = [
  '嗯',
  '恩',
  '哦',
  '啊',
  '好',
  '好的',
  'ok',
  'okay',
  'yes',
  'yeah',
  'mhm',
  'uh-huh',
  'right',
  '对',
  '是的',
]

const UNKNOWN_PHRASES = [
  /i\s*(don't|do not)\s*know/i,
  /no\s*idea/i,
  /not\s*sure/i,
  /不知道/,
  /不会/,
  /不清楚/,
  /不懂/,
]

const CONTROL_PATTERNS: Array<{
  control: NonNullable<IntentResult['control']>
  patterns: RegExp[]
}> = [
  { control: 'pause', patterns: [/^(暂停|停一下|先停|等一下|hold on|pause)/i] },
  { control: 'resume', patterns: [/^(继续|接着讲|往下|go on|continue|resume)/i] },
  {
    control: 'repeat',
    patterns: [/(再说一遍|重复|没听清|再说一次|repeat|say that again|again)/i],
  },
  { control: 'slower', patterns: [/(慢一点|慢点|讲慢|slow down|slower)/i] },
  {
    control: 'chinese',
    patterns: [/(用中文|讲中文|中文解释|in chinese|explain in chinese)/i],
  },
  { control: 'skip', patterns: [/(跳过|下一节|next section|skip)/i] },
  {
    control: 'end',
    patterns: [/(下课|结束这节课|不上了|stop the lesson|end the lesson)/i],
  },
]

export function isUnknownAnswer(text: string): boolean {
  const cleaned = String(text || '').trim()
  if (!cleaned) return true
  return UNKNOWN_PHRASES.some(pattern => pattern.test(cleaned))
}

export function classifyByHeuristic(text: string): IntentResult {
  const cleaned = String(text || '').trim()
  const lower = cleaned.toLowerCase()

  if (!cleaned) return { kind: 'filler', confidence: 0.6 }

  if (
    /(我累了|有点累|难受|不舒服|头疼|想休息|need a break|too tired)/i.test(
      cleaned
    )
  ) {
    return { kind: 'distress', confidence: 0.8 }
  }

  for (const entry of CONTROL_PATTERNS) {
    if (entry.patterns.some(pattern => pattern.test(lower))) {
      return { kind: 'control', confidence: 0.9, control: entry.control }
    }
  }

  const normalized = lower.replace(/[.,!?，。！？、\s]/g, '')
  if (FILLERS.includes(normalized)) {
    return { kind: 'filler', confidence: 0.7 }
  }

  return { kind: 'question', confidence: 0.4 }
}

const OFF_TOPIC_HINTS = [
  /天气/,
  /股票/,
  /新闻/,
  /吃什么/,
  /几点/,
  /游戏/,
  /微信/,
  /电影/,
  /weather/,
  /stock/,
  /movie/,
]

export function looksOffTopic(text: string): boolean {
  return OFF_TOPIC_HINTS.some(pattern => pattern.test(text))
}

export function splitSentences(text: string): string[] {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？])\s*/)
    .map(sentence => sentence.trim())
    .filter(Boolean)
}

export class LessonRuntime {
  private deps: LessonRuntimeDeps
  private contract: ClassContract
  private course: CourseVersionRecord
  private startedAt: number

  private nodeIndex = 0
  private segmentIndex = 0
  private segmentCommitted = false
  private segments: NarrationSegment[] = []

  private teacherTurnSeq = 0
  private currentTeacherTurnId: string | null = null
  private cancelled = false
  private paused = false
  private finished = false

  private awaitingAnswer = false
  private exerciseAttempts = 0

  private wanderEvents: number[] = []
  private parkedTopics: Array<{ text: string; at: number }> = []
  private transcript: Array<{ role: 'teacher' | 'student' | 'system'; text: string }> =
    []

  private phase: ClassSession['phase'] = 'OPENING'
  private turnState: TurnState = 'IDLE'
  private presentationState: ClassSession['presentationState'] = 'FOLLOW_LESSON'
  private currentAnchorIds: string[] = []
  private currentPage = 1
  private pacePrompt: string | null = null
  private completedPlannedSec = 0

  constructor(
    deps: LessonRuntimeDeps,
    resume?: { nodeIndex: number; segmentIndex: number; committed: boolean }
  ) {
    this.deps = deps
    this.course = deps.course
    this.contract = deps.contract
    this.startedAt = this.now()

    if (resume) {
      this.nodeIndex = Math.max(
        0,
        Math.min(resume.nodeIndex, this.course.nodes.length - 1)
      )
      this.segmentIndex = Math.max(0, resume.segmentIndex)
      this.segmentCommitted = resume.committed
      this.completedPlannedSec = this.course.nodes
        .slice(0, this.nodeIndex)
        .reduce((sum, node) => sum + node.plannedDurationSec, 0)
    }

    this.segments = this.fallbackSegments(this.node)
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private get node(): LessonNode | undefined {
    return this.course.nodes[this.nodeIndex]
  }

  private phrase(key: 'paused' | 'resumed' | 'skipped' | 'timeDebt' | 'end'): string {
    return this.deps.phrase ? this.deps.phrase(key) : ''
  }

  /** 没有口语化生成时的兜底：把编译阶段的要点原样切成句子 */
  private fallbackSegments(node: LessonNode | undefined): NarrationSegment[] {
    if (!node) return []
    const result: NarrationSegment[] = []
    node.talkingPoints.forEach((point, index) => {
      for (const sentence of splitSentences(point.text)) {
        result.push({ text: sentence, pointIndex: index })
      }
    })
    return result
  }

  private anchorIdsForSegment(segment: NarrationSegment): string[] {
    const node = this.node
    if (!node) return []
    if (segment.pointIndex < 0) return node.anchorIds
    return node.talkingPoints[segment.pointIndex]?.anchorIds ?? node.anchorIds
  }

  private totalPlannedSec(): number {
    return this.course.nodes.reduce((sum, node) => sum + node.plannedDurationSec, 0)
  }

  private actualElapsedSec(): number {
    return Math.round((this.now() - this.startedAt) / 1000)
  }

  private plannedElapsedSec(): number {
    const nodePlanned = this.node?.plannedDurationSec ?? 0
    const ratio =
      this.segments.length > 0
        ? Math.min(1, this.segmentIndex / this.segments.length)
        : 0
    return this.completedPlannedSec + Math.round(nodePlanned * ratio)
  }

  private timeDebtSec(): number {
    return this.actualElapsedSec() - this.plannedElapsedSec()
  }

  snapshot(): LessonViewState {
    return {
      phase: this.phase,
      turnState: this.turnState,
      presentationState: this.presentationState,
      nodeIndex: this.nodeIndex,
      nodeObjective: this.node?.objective ?? '',
      sentenceIndex: this.segmentIndex,
      sentenceText: this.segments[this.segmentIndex]?.text ?? '',
      totalNodes: this.course.nodes.length,
      plannedElapsedSec: this.plannedElapsedSec(),
      actualElapsedSec: this.actualElapsedSec(),
      timeDebtSec: this.timeDebtSec(),
      wanderStrikes: this.wanderEvents.length,
      parkedTopics: [...this.parkedTopics],
      transcript: [...this.transcript],
      currentAnchorIds: [...this.currentAnchorIds],
      currentPage: this.currentPage,
      awaitingAnswer: this.awaitingAnswer,
      listening: this.turnState !== 'TEACHER_SPEAKING',
      pacePrompt: this.pacePrompt,
      finished: this.finished,
    }
  }

  private emit(): void {
    this.deps.onState?.(this.snapshot())
  }

  private persist(patch: Partial<ClassSession>): void {
    this.deps.poster(patch)
  }

  private commitStep(
    action: TeachingActionType,
    options: {
      segmentIndex?: number
      committed?: boolean
      payload?: Record<string, unknown>
      studentTurnId?: string | null
      playbackState?: TeachingStepRecord['playbackState']
    } = {}
  ): void {
    this.deps.persistStep({
      stepId: `step-${this.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sessionId: '',
      nodeId: this.node?.nodeId ?? null,
      action,
      teacherTurnId: this.currentTeacherTurnId,
      studentTurnId: options.studentTurnId ?? null,
      sentenceIndex: options.segmentIndex ?? this.segmentIndex,
      sentenceCommitted: options.committed ?? false,
      playbackState: options.playbackState ?? 'completed',
      payload: options.payload ?? {},
      committedAt: new Date(this.now()).toISOString(),
    })
  }

  async start(): Promise<void> {
    this.phase = 'OPENING'
    this.turnState = 'TEACHER_SPEAKING'
    this.deps.setListening?.(false)
    this.persist({ phase: this.phase, turnState: this.turnState, status: 'IN_SESSION' })
    this.emit()

    await this.enterNode(0)
  }

  private async speak(text: string): Promise<void> {
    const trimmed = String(text || '').trim()
    if (!trimmed) return

    const turnId = `tt-${this.now()}-${++this.teacherTurnSeq}`
    this.currentTeacherTurnId = turnId
    this.turnState = 'TEACHER_SPEAKING'
    this.deps.setListening?.(false)
    this.transcript.push({ role: 'teacher', text: trimmed })
    this.persist({ teacherTurnId: turnId, turnState: this.turnState })
    this.emit()

    try {
      await this.deps.speak(trimmed, turnId)
    } finally {
      if (this.currentTeacherTurnId === turnId) {
        this.currentTeacherTurnId = null
        this.turnState = 'IDLE'
        this.deps.setListening?.(true)
        this.emit()
      }
    }
  }

  private async enterNode(index: number): Promise<void> {
    if (index >= this.course.nodes.length) {
      await this.finish()
      return
    }

    this.nodeIndex = index
    this.segmentIndex = 0
    this.segmentCommitted = false
    this.exerciseAttempts = 0
    this.phase = index === 0 ? 'REVIEW' : 'NARRATING'

    const node = this.course.nodes[index]
    this.persist({ phase: this.phase, currentNodeId: node.nodeId })
    this.emit()

    // 讲解句按契约现场生成；生成不出来就退回编译阶段的要点，保证课上得下去
    const composed = this.deps.composeNarration
      ? await this.deps.composeNarration(node).catch(() => null)
      : null

    this.segments = composed?.segments?.length
      ? composed.segments
      : this.fallbackSegments(node)

    if (composed?.opening) {
      await this.speak(composed.opening)
      if (this.cancelled || this.paused || this.finished) return
    }

    await this.narrateFrom(0)
  }

  private async narrateFrom(start: number): Promise<void> {
    for (let index = start; index < this.segments.length; index += 1) {
      if (this.cancelled || this.paused || this.finished) return

      this.segmentIndex = index
      this.segmentCommitted = false
      const segment = this.segments[index]
      const anchorIds = this.anchorIdsForSegment(segment)

      if (anchorIds.length > 0) {
        this.currentAnchorIds = anchorIds
        this.deps.showAnchor(anchorIds, segment.pointIndex)
      }

      this.commitStep('NARRATE', {
        segmentIndex: index,
        committed: false,
        playbackState: 'playing',
        payload: { text: segment.text, pointIndex: segment.pointIndex },
      })

      await this.speak(segment.text)
      if (this.cancelled) return

      this.segmentCommitted = true
      this.commitStep('NARRATE', {
        segmentIndex: index,
        committed: true,
        playbackState: 'completed',
      })
      this.emit()
    }

    await this.completeNode()
  }

  private async completeNode(): Promise<void> {
    const node = this.node
    if (!node) return

    this.completedPlannedSec += node.plannedDurationSec
    this.phase = 'CHECKING'
    this.persist({ phase: this.phase })
    this.emit()

    if (this.timeDebtSec() > 120) {
      this.pacePrompt = `超出计划 ${Math.round(this.timeDebtSec() / 60)} 分钟`
      this.turnState = 'REDIRECTING'
      this.emit()
      await this.speak(this.phrase('timeDebt'))
      this.pacePrompt = null
    }

    await this.runExercise(node)
  }

  private async runExercise(node: LessonNode): Promise<void> {
    const exercise = node.exercises[0]
    if (!exercise) {
      await this.nextNode()
      return
    }

    this.phase = 'PRACTICING'
    this.awaitingAnswer = true
    this.exerciseAttempts = 0
    this.persist({ phase: this.phase })
    this.emit()

    await this.speak(exercise.prompt)
  }

  private async nextNode(): Promise<void> {
    this.awaitingAnswer = false
    this.phase = 'NARRATING'
    this.emit()
    await this.enterNode(this.nodeIndex + 1)
  }

  /** VAD 检测到学生开口：先停音频、再立新代次；旧生成一律作废 */
  onUserSpeechStart(): void {
    if (this.finished) return
    this.cancelled = true
    this.teacherTurnSeq += 1
    this.currentTeacherTurnId = null
    this.turnState = 'STUDENT_SPEAKING'
    this.deps.stopSpeaking()
    this.deps.setListening?.(true)
    this.persist({
      turnState: this.turnState,
      cancelTeacherTurnId: `tt-cancel-${this.now()}`,
      status: 'IN_SESSION',
    })
    this.emit()
  }

  async onUserUtterance(text: string): Promise<void> {
    if (this.finished) return
    const cleaned = String(text || '').trim()
    if (!cleaned) return

    this.transcript.push({ role: 'student', text: cleaned })
    this.cancelled = false
    this.paused = false

    // 控制指令与身体不适优先于"这是不是答案"：
    // 等练习答案时学生说"跳过"或"下课"，不能被当成一个错误答案。
    const heuristic = classifyByHeuristic(cleaned)

    if (heuristic.kind === 'control' && heuristic.control) {
      await this.handleControl(heuristic.control)
      return
    }

    if (heuristic.kind === 'distress') {
      this.paused = true
      this.persist({ turnState: 'PAUSED', status: 'PAUSED' })
      this.emit()
      await this.speak(this.phrase('paused'))
      return
    }

    // 等答案时冒出一句明显无关的话（问天气、问股票），仍然按跑题处理，
    // 不然老师会把"今天天气怎么样"当成一个错误答案。
    if (this.awaitingAnswer && looksOffTopic(cleaned)) {
      await this.handleOffTopic(cleaned)
      return
    }

    // 其余输入在等答案时一律按答案处理，不再做意图分类——
    // 否则 "I don't know" 会被当成别的意图，冒出"那你休息一下"这种回答。
    if (this.awaitingAnswer) {
      await this.handleExerciseAnswer(cleaned)
      return
    }

    if (heuristic.kind === 'filler') {
      await this.resumeAfterInterruption()
      return
    }

    let intent = heuristic

    if (intent.confidence < 0.6 && this.deps.classify) {
      const context = [
        `当前目标：${this.node?.objective ?? ''}`,
        `正在讲：${this.segments[this.segmentIndex]?.text ?? ''}`,
      ].join('\n')
      const classified = await this.deps.classify(cleaned, context).catch(() => null)
      if (classified) intent = classified
    }

    const offTopic =
      intent.kind === 'off-topic' ||
      (intent.kind === 'question' && looksOffTopic(cleaned))

    if (offTopic) {
      await this.handleOffTopic(cleaned)
      return
    }

    await this.answerQuestion(cleaned)
  }

  private async handleExerciseAnswer(answer: string): Promise<void> {
    const node = this.node
    const exercise = node?.exercises[0]
    if (!node || !exercise) {
      await this.nextNode()
      return
    }

    this.exerciseAttempts += 1

    const unknown = isUnknownAnswer(answer)
    const result = unknown
      ? { status: 'needs-review' as const, feedback: '' }
      : this.deps.evaluate
        ? await this.deps
            .evaluate(answer, exercise.prompt, exercise.rubric)
            .catch(() => ({ status: 'needs-review' as const, feedback: '' }))
        : { status: 'needs-review' as const, feedback: '' }

    this.deps.saveAttempt?.({
      exerciseId: exercise.exerciseId,
      studentInput: answer,
      score: { status: result.status, feedback: result.feedback },
    })

    this.commitStep('PRACTICE', {
      payload: {
        exerciseId: exercise.exerciseId,
        status: result.status,
        attempt: this.exerciseAttempts,
      },
    })

    if (result.status === 'passed') {
      this.awaitingAnswer = false
      this.turnState = 'ANSWERING'
      await this.speak(result.feedback || 'Good.')
      await this.nextNode()
      return
    }

    // 没通过：走脚手架，而不是把同一个问题再念一遍
    this.turnState = 'ANSWERING'
    this.emit()

    const scaffold = this.deps.scaffold
      ? await this.deps
          .scaffold({
            node,
            exercise,
            attempt: this.exerciseAttempts,
            studentSaid: answer,
          })
          .catch(() => null)
      : null

    if (scaffold?.giveUp || this.exerciseAttempts >= 3) {
      this.awaitingAnswer = false
      this.transcript.push({ role: 'system', text: `待复习：${node.objective}` })
      await this.speak(scaffold?.say || result.feedback)
      await this.nextNode()
      return
    }

    await this.speak(
      scaffold?.say ||
        result.feedback ||
        'Let us try it a different way. Start with the first two words.'
    )
  }

  private async handleControl(
    control: NonNullable<IntentResult['control']>
  ): Promise<void> {
    switch (control) {
      case 'pause':
        this.paused = true
        this.persist({ status: 'PAUSED', turnState: 'PAUSED' })
        this.emit()
        await this.speak(this.phrase('paused'))
        return
      case 'resume':
        await this.resumeAfterInterruption()
        return
      case 'repeat': {
        const segment = this.segments[this.segmentIndex]
        if (segment) await this.speak(segment.text)
        await this.resumeAfterInterruption()
        return
      }
      case 'slower':
        this.contract = { ...this.contract, correctionPolicy: 'gentle' }
        await this.resumeAfterInterruption()
        return
      case 'chinese':
        this.contract = {
          ...this.contract,
          languagePolicy: 'english-with-chinese-rescue',
        }
        await this.answerQuestion('用中文解释一下刚才这句')
        return
      case 'skip':
        this.commitStep('PARK_TOPIC', {
          payload: {
            skippedNode: this.node?.nodeId,
            objective: this.node?.objective,
          },
        })
        this.transcript.push({
          role: 'system',
          text: `跳过：${this.node?.objective ?? ''}（记为未掌握）`,
        })
        await this.speak(this.phrase('skipped'))
        await this.nextNode()
        return
      case 'end':
        await this.finish()
        return
      default:
        await this.resumeAfterInterruption()
    }
  }

  private async handleOffTopic(text: string): Promise<void> {
    const now = this.now()
    this.wanderEvents.push(now)

    const windowMs = this.contract.wanderThreshold.windowMinutes * 60 * 1000
    this.wanderEvents = this.wanderEvents.filter(at => now - at <= windowMs)
    const strikes = this.wanderEvents.length

    this.parkedTopics.push({ text, at: now })
    this.commitStep('PARK_TOPIC', { payload: { topic: text } })

    this.turnState = 'REDIRECTING'
    this.phase = 'NARRATING'
    this.emit()

    const strict = this.contract.strictness
    const line =
      this.contract.languagePolicy === 'immersion'
        ? strict === 'firm'
          ? 'That is not part of this lesson. Let us get back to the objective.'
          : 'Let us park that for later and get back to what we are doing.'
        : strict === 'firm'
          ? '这个和现在的课没关系，我们先回到课上。'
          : '这个先记下来，课后再说；我们回到现在的内容。'

    await this.speak(line)

    if (strikes >= this.contract.wanderThreshold.strikes) {
      this.paused = true
      this.persist({ status: 'PAUSED', turnState: 'PAUSED' })
      this.emit()
      await this.speak(
        this.contract.languagePolicy === 'immersion'
          ? 'We have been off track a few times. Do you want to continue, or stop here today?'
          : '我们已经连着跑题几次了。继续上课，还是今天先到这里？'
      )
      return
    }

    await this.resumeAfterInterruption()
  }

  private async answerQuestion(text: string): Promise<void> {
    this.turnState = 'ANSWERING'
    this.phase = 'CHECKING'
    this.emit()

    const context = [
      `课程：${this.course.title}`,
      `当前目标：${this.node?.objective ?? ''}`,
      `正在讲：${this.segments[this.segmentIndex]?.text ?? ''}`,
    ].join('\n')

    const answer = this.deps.answer
      ? await this.deps.answer(text, context).catch(() => null)
      : null

    await this.speak(answer?.trim() || this.phrase('resumed'))
    await this.resumeAfterInterruption()
  }

  private async resumeAfterInterruption(): Promise<void> {
    if (this.finished) return
    if (this.paused) {
      this.emit()
      return
    }

    const resumeAt = this.segmentCommitted
      ? this.segmentIndex + 1
      : this.segmentIndex

    if (resumeAt >= this.segments.length) {
      await this.completeNode()
      return
    }

    this.phase = 'NARRATING'
    this.turnState = 'TEACHER_SPEAKING'
    this.commitStep('RESUME', {
      segmentIndex: resumeAt,
      payload: { from: this.segmentIndex, committed: this.segmentCommitted },
    })
    this.emit()

    await this.narrateFrom(resumeAt)
  }

  setViewport(pageIndex: number): void {
    this.presentationState = 'FREE_BROWSE'
    this.currentPage = pageIndex
    this.persist({ presentationState: 'FREE_BROWSE', viewport: { pageIndex } })
    this.emit()
  }

  followLesson(): void {
    this.presentationState = 'FOLLOW_LESSON'
    const segment = this.segments[this.segmentIndex]
    const anchorIds = segment ? this.anchorIdsForSegment(segment) : this.currentAnchorIds
    this.deps.showAnchor(anchorIds, segment?.pointIndex ?? -1)
    this.persist({
      presentationState: 'FOLLOW_LESSON',
      viewport: { pageIndex: this.currentPage },
    })
    this.emit()
  }

  async resumeLesson(): Promise<void> {
    this.paused = false
    this.persist({ status: 'IN_SESSION', turnState: 'TEACHER_SPEAKING' })
    await this.resumeAfterInterruption()
  }

  async continueFromSnapshot(): Promise<void> {
    this.phase = 'NARRATING'
    this.turnState = 'TEACHER_SPEAKING'
    this.persist({
      phase: this.phase,
      status: 'IN_SESSION',
      currentNodeId: this.node?.nodeId ?? null,
    })
    this.emit()
    await this.resumeAfterInterruption()
  }

  async finish(): Promise<void> {
    this.finished = true
    this.phase = 'COMPLETED'
    this.turnState = 'IDLE'
    this.deps.setListening?.(false)
    this.persist({ phase: 'COMPLETED', status: 'COMPLETED', turnState: 'IDLE' })
    this.emit()
    this.commitStep('END_LESSON', {
      payload: {
        nodesCompleted: this.nodeIndex,
        totalNodes: this.course.nodes.length,
        timeDebtSec: this.timeDebtSec(),
      },
    })
  }

  async endByUser(): Promise<void> {
    await this.speak(this.phrase('end'))
    await this.finish()
  }

  report(): {
    nodesCompleted: number
    totalNodes: number
    plannedMinutes: number
    actualMinutes: number
    timeDebtSec: number
    parkedTopics: Array<{ text: string; at: number }>
    skippedObjectives: string[]
    pendingObjectives: string[]
  } {
    const systemLines = this.transcript.filter(item => item.role === 'system')
    return {
      nodesCompleted: Math.min(this.nodeIndex, this.course.nodes.length),
      totalNodes: this.course.nodes.length,
      plannedMinutes: Math.round(this.totalPlannedSec() / 60),
      actualMinutes: Math.round(this.actualElapsedSec() / 60),
      timeDebtSec: this.timeDebtSec(),
      parkedTopics: [...this.parkedTopics],
      skippedObjectives: systemLines
        .filter(item => item.text.startsWith('跳过：'))
        .map(item => item.text.replace('跳过：', '').replace('（记为未掌握）', '')),
      pendingObjectives: systemLines
        .filter(item => item.text.startsWith('待复习：'))
        .map(item => item.text.replace('待复习：', '')),
    }
  }
}
