import type {
  ClassContract,
  ClassSession,
  CourseVersionRecord,
  LessonNode,
  TeachingActionType,
  TeachingStepRecord,
  TurnState,
} from '../../../electron/main/teaching/types'

/**
 * 课堂运行时。
 *
 * 刻意不依赖 Vue / Pinia：课堂状态必须能被单测覆盖，也必须能在没有界面的情况下
 * 推演（比如恢复课堂、跑评测集）。界面只订阅 onState，不直接改状态。
 *
 * 三条时间线的处理：生成、音频、视觉各自由 deps 执行，运行时只保证顺序与原子提交。
 * 学生开口时先写快照再发取消，所以旧音频不会复活，新学生输入也不会被误删。
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
  pacePrompt: string | null
  finished: boolean
}

export interface LessonRuntimeDeps {
  course: CourseVersionRecord
  contract: ClassContract
  now?: () => number
  speak: (text: string, teacherTurnId: string) => Promise<void>
  stopSpeaking: () => void
  showPage: (pageIndex: number) => void
  highlight: (anchorIds: string[]) => void
  poster: (patch: Partial<ClassSession>) => void
  persistStep: (step: TeachingStepRecord) => void
  classify?: (text: string, context: string) => Promise<IntentResult | null>
  answer?: (text: string, context: string) => Promise<string | null>
  evaluate?: (
    answer: string,
    prompt: string,
    rubric: Array<{ criterion: string; weight: number }>
  ) => Promise<{ status: 'passed' | 'needs-review' | 'skipped'; feedback: string }>
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

const CONTROL_PATTERNS: Array<{ control: NonNullable<IntentResult['control']>; patterns: RegExp[] }> = [
  { control: 'pause', patterns: [/^(暂停|停一下|先停|等一下|hold on|pause)/i] },
  { control: 'resume', patterns: [/^(继续|接着讲|往下|go on|continue|resume)/i] },
  {
    control: 'repeat',
    patterns: [/(再说一遍|重复|没听清|再说一次|repeat|say that again)/i],
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

export function classifyByHeuristic(text: string): IntentResult {
  const cleaned = String(text || '').trim()
  const lower = cleaned.toLowerCase()

  if (!cleaned) return { kind: 'filler', confidence: 0.6 }

  if (/(累|难受|不舒服|头疼|想休息|休息一下|too tired|exhausted)/i.test(cleaned)) {
    return { kind: 'distress', confidence: 0.8 }
  }

  for (const entry of CONTROL_PATTERNS) {
    if (entry.patterns.some(pattern => pattern.test(lower))) {
      return { kind: 'control', confidence: 0.9, control: entry.control }
    }
  }

  const normalized = lower.replace(/[.,!?，。！？、\s]/g, '')
  if (FILLERS.includes(normalized) || normalized.length <= 2) {
    return { kind: 'filler', confidence: 0.7 }
  }

  return { kind: 'question', confidence: 0.4 }
}

/** 明显无关的话题在本地先筛一层，避免每条输入都调一次模型 */
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

export class LessonRuntime {
  private deps: LessonRuntimeDeps
  private course: CourseVersionRecord
  private contract: ClassContract
  private startedAt: number
  private nodeIndex = 0
  private sentenceIndex = 0
  private sentenceCommitted = false
  private teacherTurnSeq = 0
  private currentTeacherTurnId: string | null = null
  private studentTurnSeq = 0
  private cancelled = false
  private paused = false
  private finished = false
  private awaitingAnswer = false
  private wanderEvents: number[] = []
  private parkedTopics: Array<{ text: string; at: number }> = []
  private transcript: Array<{ role: 'teacher' | 'student' | 'system'; text: string }> = []
  private phase: ClassSession['phase'] = 'OPENING'
  private turnState: TurnState = 'IDLE'
  private presentationState: ClassSession['presentationState'] = 'FOLLOW_LESSON'
  private currentPage = 1
  private currentAnchorIds: string[] = []
  private pacePrompt: string | null = null
  private completedPlannedSec = 0

  constructor(
    deps: LessonRuntimeDeps,
    resume?: { nodeIndex: number; sentenceIndex: number; committed: boolean }
  ) {
    this.deps = deps
    this.course = deps.course
    this.contract = deps.contract
    this.startedAt = this.now()
    const anchorSource = resume
      ? this.course.nodes[resume.nodeIndex]?.anchorIds ?? []
      : this.course.nodes[0]?.anchorIds ?? []
    if (anchorSource.length > 0) this.currentAnchorIds = anchorSource
    if (resume) {
      this.nodeIndex = Math.max(0, Math.min(resume.nodeIndex, this.course.nodes.length - 1))
      this.sentenceIndex = Math.max(0, resume.sentenceIndex)
      this.sentenceCommitted = resume.committed
      this.completedPlannedSec = this.course.nodes
        .slice(0, this.nodeIndex)
        .reduce((sum, node) => sum + node.plannedDurationSec, 0)
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private get node(): LessonNode | undefined {
    return this.course.nodes[this.nodeIndex]
  }

  private get sentences(): string[] {
    const node = this.node
    if (!node) return []
    return node.talkingPoints.flatMap(point =>
      splitSentences(point.text).filter(Boolean)
    )
  }

  private get totalPlannedSec(): number {
    return this.course.nodes.reduce((sum, node) => sum + node.plannedDurationSec, 0)
  }

  private actualElapsedSec(): number {
    return Math.round((this.now() - this.startedAt) / 1000)
  }

  private plannedElapsedSec(): number {
    return this.completedPlannedSec + Math.round(
      (this.node?.plannedDurationSec ?? 0) *
        (this.sentences.length > 0
          ? Math.min(1, this.sentenceIndex / this.sentences.length)
          : 0)
    )
  }

  private timeDebtSec(): number {
    return this.actualElapsedSec() - this.plannedElapsedSec()
  }

  snapshot(): LessonViewState {
    const sentences = this.sentences
    return {
      phase: this.phase,
      turnState: this.turnState,
      presentationState: this.presentationState,
      nodeIndex: this.nodeIndex,
      nodeObjective: this.node?.objective ?? '',
      sentenceIndex: this.sentenceIndex,
      sentenceText: sentences[this.sentenceIndex] ?? '',
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
      sentenceIndex?: number
      committed?: boolean
      payload?: Record<string, unknown>
      studentTurnId?: string | null
      playbackState?: TeachingStepRecord['playbackState']
    } = {}
  ): void {
    const step: TeachingStepRecord = {
      stepId: `step-${this.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sessionId: '',
      nodeId: this.node?.nodeId ?? null,
      action,
      teacherTurnId: this.currentTeacherTurnId,
      studentTurnId: options.studentTurnId ?? null,
      sentenceIndex: options.sentenceIndex ?? this.sentenceIndex,
      sentenceCommitted: options.committed ?? false,
      playbackState: options.playbackState ?? 'completed',
      payload: options.payload ?? {},
      committedAt: new Date(this.now()).toISOString(),
    }
    this.deps.persistStep(step)
  }

  /**
   * 从快照继续：恢复节点与句子位置，先说明一句再按"已提交则下一句、未提交则本句开头"
   * 的规则接着讲。不从半个词拼接，也不重复已经讲过并提交的句子。
   */
  async continueFromSnapshot(): Promise<void> {
    this.phase = 'NARRATING'
    this.turnState = 'TEACHER_SPEAKING'
    this.persist({
      phase: this.phase,
      status: 'IN_SESSION',
      currentNodeId: this.node?.nodeId ?? null,
    })
    this.emit()

    await this.speak('我们接着上次的地方继续。')
    await this.resumeAfterInterruption()
  }

  async start(): Promise<void> {
    this.phase = 'OPENING'
    this.turnState = 'TEACHER_SPEAKING'
    this.persist({ phase: this.phase, turnState: this.turnState, status: 'IN_SESSION' })
    this.emit()

    const opening = [
      `我们开始上课。这一节的目标是：${this.course.objectives[0] || this.node?.objective || '完成本课内容'}。`,
      `计划用时 ${this.contract.targetDurationMin} 分钟，一共 ${this.course.nodes.length} 个环节。`,
      '随时可以打断我提问，也可以说"慢一点""再说一遍"或者"跳过"。',
    ].join('')

    await this.speak(opening)
    await this.enterNode(0)
  }

  private async speak(text: string): Promise<void> {
    const turnId = `tt-${this.now()}-${++this.teacherTurnSeq}`
    this.currentTeacherTurnId = turnId
    this.turnState = 'TEACHER_SPEAKING'
    this.transcript.push({ role: 'teacher', text })
    this.persist({ teacherTurnId: turnId, turnState: this.turnState })
    this.emit()

    try {
      await this.deps.speak(text, turnId)
    } finally {
      if (this.currentTeacherTurnId === turnId) {
        this.currentTeacherTurnId = null
        this.turnState = 'IDLE'
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
    this.sentenceIndex = 0
    this.sentenceCommitted = false
    this.phase = index === 0 ? 'REVIEW' : 'NARRATING'

    const node = this.course.nodes[index]
    const anchorIds = node.anchorIds
    if (anchorIds.length > 0) {
      this.currentAnchorIds = anchorIds
      this.deps.highlight(anchorIds)
    }

    this.persist({
      phase: this.phase,
      currentNodeId: node.nodeId,
      lessonAnchor: anchorIds.length > 0 ? { pageIndex: this.currentPage, anchorId: anchorIds[0] } : null,
    })
    this.emit()

    await this.narrateFrom(this.sentenceIndex)
  }

  private async narrateFrom(startIndex: number): Promise<void> {
    const sentences = this.sentences
    for (let index = startIndex; index < sentences.length; index += 1) {
      if (this.cancelled || this.paused || this.finished) return

      this.sentenceIndex = index
      this.sentenceCommitted = false
      const sentence = sentences[index]

      this.commitStep('NARRATE', {
        sentenceIndex: index,
        committed: false,
        playbackState: 'playing',
        payload: { text: sentence },
      })

      await this.speak(sentence)

      if (this.cancelled) return

      this.sentenceCommitted = true
      this.commitStep('NARRATE', {
        sentenceIndex: index,
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

    const debt = this.timeDebtSec()
    if (debt > 120) {
      this.pacePrompt = `已经超出计划 ${Math.round(debt / 60)} 分钟`
      this.turnState = 'REDIRECTING'
      this.emit()
      await this.speak(
        `提醒一下，我们比计划慢了 ${Math.round(debt / 60)} 分钟。是继续讲完，还是把剩下的内容留到下次？`
      )
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
    this.persist({ phase: this.phase })
    this.emit()

    await this.speak(`我们来练一下。${exercise.prompt}`)
  }

  private async nextNode(): Promise<void> {
    this.awaitingAnswer = false
    this.phase = 'NARRATING'
    this.emit()
    await this.enterNode(this.nodeIndex + 1)
  }

  /** VAD 检测到学生开口：先停音频、再立新代次，旧生成一律作废 */
  onUserSpeechStart(): void {
    if (this.finished) return
    this.cancelled = true
    this.teacherTurnSeq += 1
    this.currentTeacherTurnId = null
    this.turnState = 'STUDENT_SPEAKING'
    this.deps.stopSpeaking()
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

    this.studentTurnSeq += 1
    this.transcript.push({ role: 'student', text: cleaned })
    this.cancelled = false
    this.paused = false

    let intent = classifyByHeuristic(cleaned)

    if (intent.confidence < 0.6 && this.deps.classify) {
      const context = [
        `当前目标：${this.node?.objective ?? ''}`,
        `正在讲：${this.sentences[this.sentenceIndex] ?? ''}`,
      ].join('\n')
      const classified = await this.deps.classify(cleaned, context).catch(() => null)
      if (classified) intent = classified
    }

    if (intent.kind === 'filler') {
      await this.resumeAfterInterruption()
      return
    }

    if (intent.kind === 'control' && intent.control) {
      await this.handleControl(intent.control)
      return
    }

    if (intent.kind === 'distress') {
      this.phase = 'NARRATING'
      this.turnState = 'PAUSED'
      this.paused = true
      this.persist({ phase: this.phase, turnState: 'PAUSED', status: 'PAUSED' })
      this.emit()
      await this.speak('那我们先停一下，你休息好了再说继续。')
      return
    }

    const offTopic = intent.kind === 'off-topic' || (intent.kind === 'question' && looksOffTopic(cleaned))

    if (offTopic) {
      await this.handleOffTopic(cleaned)
      return
    }

    await this.answerQuestion(cleaned)
  }

  private async handleControl(
    control: NonNullable<IntentResult['control']>
  ): Promise<void> {
    switch (control) {
      case 'pause':
        this.paused = true
        this.persist({ status: 'PAUSED', turnState: 'PAUSED' })
        this.emit()
        await this.speak('好，先停在这里。说"继续"我就接着讲。')
        return
      case 'resume':
        await this.resumeAfterInterruption()
        return
      case 'repeat': {
        const sentence = this.sentences[Math.max(0, this.sentenceIndex)] ?? ''
        await this.speak(sentence || '我再说一遍刚才的重点。')
        await this.resumeAfterInterruption()
        return
      }
      case 'slower':
        this.contract = { ...this.contract, correctionPolicy: 'gentle' }
        await this.speak('好，我放慢一点。')
        await this.resumeAfterInterruption()
        return
      case 'chinese':
        this.contract = { ...this.contract, languagePolicy: 'english-with-chinese-rescue' }
        await this.speak(
          `这一句的意思是：${this.sentences[this.sentenceIndex] ?? '我们刚才讲的内容'}。我用中文再解释一遍，然后继续。`
        )
        await this.resumeAfterInterruption()
        return
      case 'skip':
        this.commitStep('PARK_TOPIC', {
          payload: { skippedNode: this.node?.nodeId, objective: this.node?.objective },
        })
        this.transcript.push({ role: 'system', text: `跳过：${this.node?.objective ?? ''}（记为未掌握）` })
        await this.speak('好，这一节先跳过，我把它记成还没掌握。')
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
    const lead =
      strict === 'firm'
        ? '这个和现在的课没关系。'
        : strict === 'gentle'
          ? '这个我们记下来，'
          : '这个问题我先记下，'

    await this.speak(
      `${lead}现在还在讲「${this.node?.objective ?? '当前内容'}」，我先把它放到课后，我们回到课上。`
    )

    if (strikes >= this.contract.wanderThreshold.strikes) {
      this.paused = true
      this.persist({ status: 'PAUSED', turnState: 'PAUSED' })
      this.emit()
      await this.speak(
        '我们已经连着跑题几次了。现在有两个选择：继续上课，或者今天先到这里。你说一个。'
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
      `正在讲：${this.sentences[this.sentenceIndex] ?? ''}`,
      `后一句：${this.sentences[this.sentenceIndex + 1] ?? ''}`,
    ].join('\n')

    const answer = this.deps.answer
      ? await this.deps.answer(text, context).catch(() => null)
      : null

    await this.speak(
      answer?.trim() ||
        `这个问题很好。按我们现在讲的内容，${this.node?.objective ?? ''}这一点先记住，细节我们后面展开。`
    )

    if (this.awaitingAnswer) {
      await this.evaluateAnswer(text)
      return
    }

    await this.resumeAfterInterruption()
  }

  private async evaluateAnswer(text: string): Promise<void> {
    const node = this.node
    const exercise = node?.exercises[0]
    if (!node || !exercise) {
      await this.nextNode()
      return
    }

    const result = this.deps.evaluate
      ? await this.deps
          .evaluate(text, exercise.prompt, exercise.rubric)
          .catch(() => ({ status: 'needs-review' as const, feedback: '我先记下你的回答。' }))
      : { status: 'needs-review' as const, feedback: '我先记下你的回答。' }

    this.deps.saveAttempt?.({
      exerciseId: exercise.exerciseId,
      studentInput: text,
      score: { status: result.status, feedback: result.feedback },
    })

    this.awaitingAnswer = false
    this.commitStep('PRACTICE', {
      payload: { exerciseId: exercise.exerciseId, status: result.status },
    })

    if (result.status === 'passed') {
      await this.speak(result.feedback || '很好，这一节过了。')
      await this.nextNode()
      return
    }

    await this.speak(result.feedback || '这里还需要再看一下，我换个说法。')
    await this.narrateFrom(0)
  }

  private async resumeAfterInterruption(): Promise<void> {
    if (this.finished) return
    if (this.paused) {
      this.emit()
      return
    }

    const sentences = this.sentences
    const resumeAt = this.sentenceCommitted
      ? this.sentenceIndex + 1
      : this.sentenceIndex

    if (resumeAt >= sentences.length) {
      await this.completeNode()
      return
    }

    this.phase = 'NARRATING'
    this.turnState = 'TEACHER_SPEAKING'
    this.commitStep('RESUME', {
      sentenceIndex: resumeAt,
      payload: { from: this.sentenceIndex, committed: this.sentenceCommitted },
    })
    this.emit()

    await this.narrateFrom(resumeAt)
  }

  /** 学生自由翻页：只改视口，不动课程锚点 */
  setViewport(pageIndex: number): void {
    this.presentationState = 'FREE_BROWSE'
    this.persist({ presentationState: 'FREE_BROWSE', viewport: { pageIndex } })
    this.emit()
  }

  followLesson(): void {
    this.presentationState = 'FOLLOW_LESSON'
    this.persist({ presentationState: 'FOLLOW_LESSON', viewport: { pageIndex: this.currentPage } })
    this.deps.showPage(this.currentPage)
    this.deps.highlight(this.currentAnchorIds)
    this.emit()
  }

  async resumeLesson(): Promise<void> {
    this.paused = false
    this.persist({ status: 'IN_SESSION', turnState: 'TEACHER_SPEAKING' })
    await this.resumeAfterInterruption()
  }

  async finish(): Promise<void> {
    this.finished = true
    this.phase = 'COMPLETED'
    this.turnState = 'IDLE'
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
    await this.speak('好，今天先到这里。我把这节课的完成情况和需要复习的地方整理一下。')
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
  } {
    return {
      nodesCompleted: Math.min(this.nodeIndex, this.course.nodes.length),
      totalNodes: this.course.nodes.length,
      plannedMinutes: Math.round(this.totalPlannedSec / 60),
      actualMinutes: Math.round(this.actualElapsedSec() / 60),
      timeDebtSec: this.timeDebtSec(),
      parkedTopics: [...this.parkedTopics],
      skippedObjectives: this.transcript
        .filter(item => item.role === 'system' && item.text.startsWith('跳过：'))
        .map(item => item.text.replace('跳过：', '').replace('（记为未掌握）', '')),
    }
  }
}

export function splitSentences(text: string): string[] {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？])\s*/)
    .map(sentence => sentence.trim())
    .filter(Boolean)
}
