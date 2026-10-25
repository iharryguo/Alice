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
  /** 是否处于暂停；界面用它决定按钮显示"暂停"还是"继续" */
  paused: boolean
  /** 正在等学生确认不可逆动作（下课 / 跳过） */
  awaitingConfirmation: 'end' | 'skip' | null
  listening: boolean
  pacePrompt: string | null
  finished: boolean
}

export interface NarrationSegment {
  text: string
  /** 对应 node.talkingPoints 的下标，没有来源时为 -1 */
  pointIndex: number
  /** say = 陈述；ask = 提问，说完必须停下来等回答 */
  kind: 'say' | 'ask'
  /** 讲这一段时学生应该看到的页码；缺省时由锚点决定 */
  page?: number
}

export interface LessonRuntimeDeps {
  course: CourseVersionRecord
  contract: ClassContract
  now?: () => number
  speak: (text: string, teacherTurnId: string) => Promise<void>
  stopSpeaking: () => void
  /** 展示某段对应的页面与高亮；运行时只给锚点，具体怎么渲染由界面决定 */
  showAnchor: (anchorIds: string[], pointIndex: number, page?: number) => void
  /** 老师此刻是否在收音（界面上要能看到） */
  setListening?: (listening: boolean) => void
  poster: (patch: Partial<ClassSession>) => void
  persistStep: (step: TeachingStepRecord) => void
  /** 课堂日志：不进 UI，只落盘，用于复现 bug */
  log?: (event: string, data?: Record<string, unknown>) => void
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
  /** 老师回复：say 是要朗读的话，directive 是模型显式给出的课堂指令 */
  answer?: (
    text: string,
    context: string
  ) => Promise<{ say: string; directive?: string } | null>
  /**
   * 生成"请确认"的话术。
   * 下课、跳过这类不可逆动作第一次触发时不能直接执行，必须先问一句，
   * 这句话由模型现场生成，不用固定模板。
   */
  confirm?: (
    kind: 'end' | 'skip',
    context: string
  ) => Promise<string | null>
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
    patterns: [
      /(下课|结束这节课|结束吧|不上了|不学了|不想学了|就到这)/,
      /(stop the lesson|end the lesson|i\s*(want|'d like|would like)\s*to\s*(stop|end|finish))/i,
      /^(stop|quit|exit)$/i,
    ],
  },
]

export function isQuestionLike(text: string): boolean {
  const cleaned = String(text || '').trim()
  if (!cleaned) return false
  if (/[?？]$/.test(cleaned)) return true
  if (/^(what|why|how|who|when|where|can you|could you|do you|does|is it|are you)\b/i.test(cleaned)) {
    return true
  }
  return /(为什么|怎么|什么|是不是|能不能|可不可以|吗[?？]?$)/.test(cleaned)
}

/**
 * 只用于"老师刚问了一个是/否问题"的场合。
 * 这不是猜意图，而是解析对一个封闭问题的回答，所以可以用固定集合。
 */
const AFFIRMATIVE = /^(yes|yeah|yep|yup|sure|ok|okay|confirm|correct|right|exactly|please do|好|好的|对|是的|确定|确认|嗯|可以|行|就这样|结束吧|下课吧|跳过吧)/i
const NEGATIVE = /^(no|nope|nah|not yet|don't|do not|continue|keep going|carry on|不用|不用了|不是|不要|不对|继续|再上|还没|先不|不)/i

export function isAffirmative(text: string): boolean {
  return AFFIRMATIVE.test(String(text || '').trim())
}

export function isNegative(text: string): boolean {
  const cleaned = String(text || '').trim()
  if (AFFIRMATIVE.test(cleaned) && !/^不/.test(cleaned)) return false
  return NEGATIVE.test(cleaned)
}

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

const META_MARKERS = [
  /bug/i,
  /这里/,
  /等等/,
  /你看/,
  /为什么/,
  /应该/,
  /不对/,
  /错了/,
  /没等/,
  /没有等/,
  /中文/,
  /重复/,
  /听不到/,
  /声音/,
  /翻页/,
  /卡住/,
]

/**
 * 学生用中文对"课上正在发生的事"提意见（哪里不对、为什么没等我、怎么又说中文）。
 * 这类话说的是课堂本身，按跑题处理会累计 strike，最后把老师逼成"要不要下课"。
 */
/** 粗略判断一段话主要是英文（用于兜底分段，不用于正式判定） */
export function isMostlyLatin(text: string): boolean {
  const cleaned = String(text || '')
  const latin = (cleaned.match(/[A-Za-z]/g) || []).length
  const chinese = (cleaned.match(/[\u4e00-\u9fa5]/g) || []).length
  return latin > 6 && latin >= chinese
}

export function isMetaFeedback(text: string): boolean {
  const cleaned = String(text || '')
  if (!/[一-龥]/.test(cleaned)) return false
  return META_MARKERS.some(pattern => pattern.test(cleaned))
}

/**
 * 把一段话切成可朗读的句子。
 *
 * 之前按句号硬切，把 "The family in picture one is...' or '... has...'" 切成了
 * "is." / "." / "'" 这种碎片，占位符和省略号全被拆开。碎片送进 TTS 必然合成失败，
 * 日志里那一串 tts.failed 就是这么来的，听起来就是讲到一半突然没声。
 *
 * 现在的规则：省略号当整体、常见缩写不切、纯标点碎片并回上一句。
 */
export function splitSentences(text: string): string[] {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return []

  // 先用占位符保护省略号和缩写里的句点
  const guarded = cleaned
    .replace(/\.{2,}/g, '\u2026')
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|St|vs|etc)\./gi, '$1\u0000')

  const pieces = guarded.split(/(?<=[.!?。！？])\s+/)

  const result: string[] = []
  for (const piece of pieces) {
    const restored = piece.replace(/\u0000/g, '.').replace(/\u2026/g, '...').trim()
    if (!restored) continue

    // 纯标点、纯引号的碎片没有朗读价值，并回上一句
    if (!/[A-Za-z0-9\u4e00-\u9fa5]/.test(restored) && result.length > 0) {
      result[result.length - 1] = `${result[result.length - 1]} ${restored}`.trim()
      continue
    }
    result.push(restored)
  }

  return result
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
  /** 当前在等什么：练习答案 / 讲解里的提问；null 表示不在等 */
  private answerMode: 'exercise' | 'ask' | null = null
  private pendingAsk: { text: string; segmentIndex: number } | null = null
  /** 跑题次数超阈值后，等学生明确选继续还是停 */
  private awaitingDecision = false
  /** 当前这段是否已经开口（决定被打断后要不要重播） */
  private segmentStarted = false
  /**
   * 讲解代次。
   *
   * 之前同一个节点会出现两条讲解循环并行（一次打断加上一次恢复就容易撞上），
   * 表现就是同一句话被念两遍、两段讲解互相打断。每次进入 narrateFrom 都领一个号，
   * 号一变，旧循环在下一个检查点自行退出。
   */
  private narrateToken = 0
  /**
   * 学生轮次。新一句话一进来就作废上一句还没走完的处理，
   * 否则会出现"两分钟前的回答现在才被采纳"——日志里真发生过。
   */
  private utteranceToken = 0
  private activeUtterance = 0
  /** 正在跑的讲解任务；新讲解必须等旧的退干净，避免同一句念两遍 */
  private narrateRunning: Promise<void> | null = null
  /** 进入节点的代次：下课或被新输入打断后，旧的节点开场不再播 */
  private nodeToken = 0
  /** 等学生确认的不可逆动作（下课 / 跳过） */
  private pendingConfirm: { kind: 'end' | 'skip'; asked: number } | null = null
  /** 打断后迟迟没有转写回来时的兜底，避免课堂永久卡住 */
  private askRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  /** 等确认的超时：没人回答就按"不下课"继续，不能把课堂挂死 */
  private confirmTimer: ReturnType<typeof setTimeout> | null = null
  private askTimer: ReturnType<typeof setTimeout> | null = null
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
        result.push({ text: sentence, pointIndex: index, kind: 'say' })
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
      paused: this.paused,
      awaitingConfirmation: this.pendingConfirm?.kind ?? null,
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

  private log(event: string, data?: Record<string, unknown>): void {
    this.deps.log?.(event, data)
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
    this.log('lesson.start', {
      courseVersionId: this.course.courseVersionId,
      title: this.course.title,
      nodes: this.course.nodes.length,
      languagePolicy: this.contract.languagePolicy,
      strictness: this.contract.strictness,
      presentationMode: this.contract.presentationMode,
      targetDurationMin: this.contract.targetDurationMin,
    })

    // 讲解在后台推进：start() 只负责把课开起来
    this.launch(this.enterNode(0))
  }

  private async speak(text: string): Promise<void> {
    const trimmed = String(text || '').trim()
    if (!trimmed) return
    // 纯标点/纯引号（分句留下的碎片）既没有朗读价值，送进 TTS 还会直接失败
    if (!/[A-Za-z0-9\u4e00-\u9fa5]/.test(trimmed)) {
      this.log('speak.skip', { text: trimmed })
      return
    }

    const turnId = `tt-${this.now()}-${++this.teacherTurnSeq}`
    this.currentTeacherTurnId = turnId
    this.turnState = 'TEACHER_SPEAKING'
    this.deps.setListening?.(false)
    this.transcript.push({ role: 'teacher', text: trimmed })
    this.log('teacher.say', { turnId, text: trimmed })
    this.persist({ teacherTurnId: turnId, turnState: this.turnState })
    this.emit()

    try {
      await this.deps.speak(trimmed, turnId)
    } finally {
      if (this.currentTeacherTurnId === turnId) {
        this.currentTeacherTurnId = null
        // 暂停期间说完"已暂停"这句提示，状态要落回 PAUSED，
        // 否则界面上看起来又自己继续了
        this.turnState = this.paused ? 'PAUSED' : 'IDLE'
        this.deps.setListening?.(!this.paused)
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
    this.log('node.enter', {
      index,
      objective: node.objective,
      required: node.required,
      plannedSec: node.plannedDurationSec,
    })

    // 讲解句按契约现场生成；生成不出来就退回编译阶段的要点，保证课上得下去
    const nodeToken = ++this.nodeToken
    const composed = this.deps.composeNarration
      ? await this.deps.composeNarration(node).catch(() => null)
      : null

    // 等模型的这几秒里可能已经下课
    if (this.finished) {
      this.log('node.abandoned', { index, reason: 'finished' })
      return
    }

    // 被打断：分段还是要留下来，接下来由打断后的流程接着讲这一节；
    // 只是不再由这里开口，避免和学生的回答抢着说话。
    if (nodeToken !== this.nodeToken) {
      if (this.nodeIndex === index && composed?.segments?.length) {
        this.segments = composed.segments
        this.segmentIndex = Math.min(this.segmentIndex, this.segments.length - 1)
      }
      this.log('node.superseded', { index })
      return
    }

    const composedSegments = composed?.segments ?? []
    this.segments = composedSegments.length
      ? composedSegments
      : this.fallbackSegments(node)

    // 兜底分段来自编译阶段的要点，可能是中文笔记。英语课把中文笔记直接念出来，
    // 等于当着学生念教案——宁可只讲一句过场话，也不念。
    if (!composedSegments.length && this.contract.languagePolicy === 'immersion') {
      const englishOnly = this.segments.filter(segment => isMostlyLatin(segment.text))
      this.segments = englishOnly.length
        ? englishOnly
        : [
            {
              text: 'Let us look at this page together, then try it in English.',
              pointIndex: 0,
              kind: 'say',
            },
          ]
    }

    this.log('narration.prepared', {
      composed: composedSegments.length,
      used: this.segments.length,
      first: this.segments[0]?.text?.slice(0, 60) ?? '',
      language: this.contract.languagePolicy,
    })

    if (composed?.opening) {
      await this.speak(composed.opening)
      if (this.cancelled || this.paused || this.finished) return
    }

    await this.narrateFrom(0)
  }

  private async narrateFrom(start: number): Promise<void> {
    const token = ++this.narrateToken
    const run = this.runNarration(start, token)
    this.narrateRunning = run
    try {
      await run
    } finally {
      if (this.narrateRunning === run) this.narrateRunning = null
    }
  }

  private async runNarration(start: number, token: number): Promise<void> {

    for (let index = start; index < this.segments.length; index += 1) {
      // 代次已变：另一条讲解循环接管了，这条必须安静退出
      if (token !== this.narrateToken) return
      if (this.cancelled || this.paused || this.finished) return

      this.segmentIndex = index
      this.segmentCommitted = false
      this.segmentStarted = false
      const segment = this.segments[index]
      const anchorIds = this.anchorIdsForSegment(segment)

      // 页码以编译时从材料里读到的为准；模型现场生成时写的 page 只作兜底。
      // 日志里出现过讲解页是第 4 页、模型却写 page:1，结果屏幕跳回第 1 页。
      const pointPage = this.node?.talkingPoints[segment.pointIndex]?.page
      const page =
        pointPage && pointPage > 0
          ? pointPage
          : segment.page && segment.page > 0
            ? segment.page
            : undefined

      if (anchorIds.length > 0 || page) {
        this.currentAnchorIds = anchorIds
        this.deps.showAnchor(anchorIds, segment.pointIndex, page)
        this.log('slide.show', {
          pointIndex: segment.pointIndex,
          page: page ?? null,
          anchorIds,
          segmentIndex: index,
          kind: segment.kind,
        })
      }

      this.commitStep('NARRATE', {
        segmentIndex: index,
        committed: false,
        playbackState: 'playing',
        payload: { text: segment.text, pointIndex: segment.pointIndex },
      })

      if (token !== this.narrateToken) return
      this.segmentStarted = true
      await this.speak(segment.text)
      this.segmentStarted = false
      if (token !== this.narrateToken) return
      if (this.cancelled) return

      this.segmentCommitted = true
      this.commitStep('NARRATE', {
        segmentIndex: index,
        committed: true,
        playbackState: 'completed',
      })
      this.emit()

      // 讲解里的提问：说完就停下等学生，不再自顾自往下讲。
      // 这是"老师问完问题应该等回答"的唯一实现点。
      if (segment.kind === 'ask') {
        this.awaitAnswerToAsk(segment.text, index)
        return
      }
    }

    if (token !== this.narrateToken) return
    await this.completeNode()
  }

  /** 进入"等学生回答提问"的状态，并安排两次超时兜底 */
  private awaitAnswerToAsk(text: string, segmentIndex: number): void {
    this.answerMode = 'ask'
    this.awaitingAnswer = true
    this.pendingAsk = { text, segmentIndex }
    this.persist({ turnState: 'IDLE' })
    this.emit()
    this.scheduleAskTimeout(1)
  }

  private scheduleAskTimeout(round: 1 | 2): void {
    this.clearAskTimer()
    this.askTimer = setTimeout(async () => {
      this.askTimer = null
      if (this.answerMode !== 'ask' || this.finished) return

      if (round === 1) {
        // 第一轮：给时间，不催；只提示可以慢慢想
        await this.speak(
          this.contract.languagePolicy === 'immersion'
            ? 'Take your time. I am listening.'
            : '不着急，我等你。'
        )
        this.log('ask.timeout', { round: 1, segmentIndex: this.segmentIndex })
        this.scheduleAskTimeout(2)
        return
      }

      // 第二轮还不说，老师自己往下讲，并把这段留作待复习
      this.log('ask.timeout', { round: 2, segmentIndex: this.segmentIndex })
      const ask = this.pendingAsk
      this.pendingAsk = null
      this.answerMode = null
      this.awaitingAnswer = false
      if (ask) {
        this.transcript.push({
          role: 'system',
          text: `待复习：${this.node?.objective ?? ''}`,
        })
      }
      this.emit()
      this.launch(this.narrateFrom(this.segmentIndex + 1))
    }, round === 1 ? 8000 : 10000)
  }

  private clearAskTimer(): void {
    if (this.askTimer) {
      clearTimeout(this.askTimer)
      this.askTimer = null
    }
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
    this.answerMode = 'exercise'
    this.exerciseAttempts = 0
    this.persist({ phase: this.phase })
    this.emit()

    await this.speak(exercise.prompt)
  }

  private nextNode(): void {
    this.awaitingAnswer = false
    this.answerMode = null
    this.pendingAsk = null
    this.phase = 'NARRATING'
    this.emit()
    this.launch(this.enterNode(this.nodeIndex + 1))
  }

  /**
   * VAD 刚检测到有人开口（还没有转写结果）。
   * 只做一件事：把"不着急，我等你"这类催问停掉，别在学生正说的时候插嘴。
   * 真正的打断仍然走 onUserSpeechStart（学生确实插话时）。
   */
  onUserSpeechDetected(): void {
    if (this.finished) return
    if (this.answerMode === 'ask') {
      this.clearAskTimer()
      this.scheduleAskRecovery()
    }
  }

  /** VAD 检测到学生开口：先停音频、再立新代次；旧生成一律作废 */
  onUserSpeechStart(): void {
    if (this.finished) return
    this.cancelled = true
    this.narrateToken += 1
    this.teacherTurnSeq += 1
    this.currentTeacherTurnId = null
    this.turnState = 'STUDENT_SPEAKING'
    // 老师已经开口的句子，被打断后不重播——真实课堂里被插话不会倒带。
    // 想重听请明确说"再说一遍"。
    if (this.segmentStarted) this.segmentCommitted = true
    this.clearAskTimer()
    if (this.answerMode === 'ask') this.scheduleAskRecovery()
    this.log('bargein', {
      nodeIndex: this.nodeIndex,
      segmentIndex: this.segmentIndex,
      committed: this.segmentCommitted,
      text: this.segments[this.segmentIndex]?.text ?? '',
    })
    this.deps.stopSpeaking()
    this.deps.setListening?.(true)
    this.persist({
      turnState: this.turnState,
      cancelTeacherTurnId: `tt-cancel-${this.now()}`,
      status: 'IN_SESSION',
    })
    this.emit()
  }

  /**
   * 学生说话。
   *
   * 所有输入串行处理：上一句还在等模型回复时，下一句排队。
   * 之前两条输入并发处理，会各自拉起一条讲解循环，同一句被念两遍。
   */
  onUserUtterance(text: string): Promise<void> {
    const cleaned = String(text || '').trim()
    if (!cleaned || this.finished) return Promise.resolve()

    // 新的一句话一进来，先让正在讲的立刻停下：
    // 老师不能一边被问问题一边继续念稿，学生也不该等一段讲完才被听见。
    this.interruptNarration()

    // 不再排队：排队会让"上一句在等模型"变成后面所有输入的延迟。
    // 并发跑没关系——只有最新一轮的回复会被播出去，旧的靠 token 作废。
    const token = ++this.utteranceToken
    return this.processUtterance(cleaned, token)
  }

  /**
   * 把讲解放到后台跑。
   * 学生这一轮的处理（听懂、回应）不能等一整段讲完才结束——
   * 日志里出现过回答晚了 58 秒才被采纳，就是被讲解任务堵住的。
   */
  private launch(task: Promise<void>): void {
    void task.catch(error =>
      this.log('task.error', { message: (error as Error)?.message ?? String(error) })
    )
  }

  /** 让当前讲解失效，但不等它退出 */
  private interruptNarration(): void {
    this.cancelled = true
    this.narrateToken += 1
    this.nodeToken += 1
    this.clearAskTimer()
  }

  private isStale(token: number): boolean {
    return token !== this.utteranceToken
  }

  private async processUtterance(text: string, token: number): Promise<void> {
    if (this.finished || this.isStale(token)) return
    const cleaned = String(text || '').trim()
    if (!cleaned) return
    this.activeUtterance = token
    this.clearAskRecovery()

    this.transcript.push({ role: 'student', text: cleaned })
    this.log('student.say', {
      text: cleaned,
      answerMode: this.answerMode,
      awaitingDecision: this.awaitingDecision,
      nodeIndex: this.nodeIndex,
      segmentIndex: this.segmentIndex,
    })
    this.cancelled = false
    if (!this.awaitingDecision) this.paused = false

    const heuristic = classifyByHeuristic(cleaned)

    // 正在等学生确认"是否下课/跳过"：这条优先，别让确认被当成普通提问
    if (this.pendingConfirm) {
      await this.handleConfirmation(cleaned)
      return
    }

    // 老师在等学生"继续还是停"的决定时，只接受这两种，其他一律再问一次，
    // 不能被一段抱怨带着一直重复同一句提醒。
    if (this.awaitingDecision) {
      if (heuristic.kind === 'control' && heuristic.control === 'end') {
        await this.finish()
        return
      }
      if (heuristic.kind === 'control' && heuristic.control === 'resume') {
        this.awaitingDecision = false
        this.paused = false
        await this.resumeAfterInterruption()
        return
      }
      await this.speak(
        this.contract.languagePolicy === 'immersion'
          ? 'Before we go on: continue, or stop here today?'
          : '先说一句：继续，还是今天到这里？'
      )
      return
    }

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

    // 正在等讲解提问的回答：按"回答了一个问题"处理
    if (this.answerMode === 'ask') {
      await this.handleAskAnswer(cleaned)
      return
    }

    // 等练习答案时冒出一句明显无关的话，仍按跑题处理
    if (this.answerMode === 'exercise' && looksOffTopic(cleaned)) {
      await this.handleOffTopic(cleaned)
      return
    }

    // 练习环节里学生问"这题什么意思"、或者吐槽软件，是提问不是错答。
    // 以前这些会被直接判 needs-review，三次就判"不会"，日志里连着中招。
    if (
      this.answerMode === 'exercise' &&
      (isMetaFeedback(cleaned) || isQuestionLike(cleaned))
    ) {
      await this.handleExerciseSideQuestion(cleaned)
      return
    }

    if (this.answerMode === 'exercise') {
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

    // 中文元反馈（吐槽哪里不对、为什么没等我）是"对课上发生的现象提问"，
    // 不是跑题；判成跑题会累计 strike，最后把它逼成"要不要下课"。
    if (isMetaFeedback(cleaned)) {
      await this.answerQuestion(cleaned)
      return
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

  /** 学生在老师提问后反而问了别的问题：先答，再回到原问题继续等 */
  private async handleAskAnswer(answer: string): Promise<void> {
    if (isQuestionLike(answer)) {
      this.clearAskTimer()
      this.turnState = 'ANSWERING'
      this.emit()
      this.log('ask.followup_question', {
        question: answer,
        pending: this.pendingAsk?.text ?? '',
      })
      const context = [
        `课程：${this.course.title}`,
        `当前目标：${this.node?.objective ?? ''}`,
        `老师刚问：${this.pendingAsk?.text ?? ''}`,
      ].join('\n')
      const reply = this.deps.answer
        ? await this.deps.answer(answer, context).catch(() => null)
        : null
      if (reply?.say?.trim()) await this.speak(reply.say.trim())
      const stoppedByReply = await this.applyDirective(reply?.directive)
      if (stoppedByReply) return
      // 问题答完仍然停在原来那个提问上，等学生真正回答
      this.awaitingAnswer = true
      this.answerMode = 'ask'
      this.scheduleAskTimeout(2)
      return
    }

    const ask = this.pendingAsk
    this.clearAskTimer()
    this.pendingAsk = null
    this.answerMode = null
    this.awaitingAnswer = false
    this.turnState = 'ANSWERING'
    this.emit()

    const context = [
      `课程：${this.course.title}`,
      `当前目标：${this.node?.objective ?? ''}`,
      `老师刚问：${ask?.text ?? ''}`,
    ].join('\n')

    const token = this.activeUtterance

    const reply = this.deps.answer
      ? await this.deps.answer(answer, context).catch(() => null)
      : null

    if (this.isStale(token)) {
      this.log('reply.stale', { text: answer })
      return
    }

    const needsConfirm = this.needsConfirmation(reply?.directive)
    if (needsConfirm) {
      await this.askForConfirmation(needsConfirm)
      return
    }

    await this.speak(
      reply?.say?.trim() ||
        (this.contract.languagePolicy === 'immersion'
          ? 'Good. Let us go on.'
          : '好，我们继续。')
    )
    if (this.isStale(token)) return

    const stopped = await this.applyDirective(reply?.directive)
    if (!stopped) this.launch(this.narrateFrom(this.segmentIndex + 1))
  }

  /**
   * 练习环节里的旁问。
   * 回答它，但不算一次作答、不消耗尝试次数，答完继续等原来的答案。
   */
  private async handleExerciseSideQuestion(text: string): Promise<void> {
    this.turnState = 'ANSWERING'
    this.emit()
    this.log('exercise.side_question', { text, attempts: this.exerciseAttempts })

    const context = [
      `课程：${this.course.title}`,
      `当前目标：${this.node?.objective ?? ''}`,
      `你刚问的练习：${this.node?.exercises[0]?.prompt ?? ''}`,
    ].join('\n')

    const token = this.activeUtterance
    const reply = this.deps.answer
      ? await this.deps.answer(text, context).catch(() => null)
      : null
    if (this.isStale(token)) return

    const needsConfirm = this.needsConfirmation(reply?.directive)
    if (needsConfirm) {
      await this.askForConfirmation(needsConfirm)
      return
    }

    await this.speak(
      reply?.say?.trim() ||
        (this.contract.languagePolicy === 'immersion'
          ? 'Good question. Now back to the task.'
          : '好，我们回到这道题。')
    )
    if (this.isStale(token)) return

    // 继续等原来的答案，不算答错
    this.phase = 'PRACTICING'
    this.answerMode = 'exercise'
    this.awaitingAnswer = true
    this.turnState = 'IDLE'
    this.emit()
  }

  private async handleExerciseAnswer(answer: string): Promise<void> {
    const token = this.activeUtterance
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

    // 判定期间学生又说了别的：这次作答已经过期，不记账、不推进
    if (this.isStale(token)) {
      this.log('exercise.stale', { input: answer })
      return
    }

    this.log('exercise.answer', {
      attempt: this.exerciseAttempts,
      input: answer,
      status: result.status,
      unknown,
    })

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
      this.answerMode = null
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
      this.answerMode = null
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
    this.log('control', { control, nodeIndex: this.nodeIndex })
    switch (control) {
      case 'pause':
        this.paused = true
        this.persist({ status: 'PAUSED', turnState: 'PAUSED' })
        this.emit()
        await this.speak(this.phrase('paused'))
        return
      case 'resume':
        // 本来就在讲的时候说"继续"不应该把当前这句重念一遍
        if (!this.paused && this.narrateRunning) {
          this.log('control.ignored', { control: 'resume', reason: 'already-running' })
          return
        }
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
      // 跳过与下课都走同一条确认门：关键词命中不等于学生真的决定了，
      // 这两件事都不可逆，必须先问一句。
      case 'skip':
        await this.applyDirective('SKIP')
        return
      case 'end':
        await this.applyDirective('END_LESSON')
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
    this.log('redirect', { text, strikes })
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
      this.awaitingDecision = true
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

    const token = this.activeUtterance

    const reply = this.deps.answer
      ? await this.deps.answer(text, context).catch(() => null)
      : null

    // 等模型的这几秒里学生又开口了：这句回复已经过期，别再播出去
    if (this.isStale(token)) {
      this.log('reply.stale', { text })
      return
    }

    const needsConfirm = this.needsConfirmation(reply?.directive)
    if (needsConfirm) {
      await this.askForConfirmation(needsConfirm)
      return
    }

    await this.speak(reply?.say?.trim() || this.phrase('resumed'))
    if (this.isStale(token)) return

    const stopped = await this.applyDirective(reply?.directive)
    if (!stopped) await this.resumeAfterInterruption()
  }

  /**
   * 这条回复是不是"要先确认"的不可逆动作。
   * 判断放在开口之前：否则学生会先听到一句"好，今天到这里"，
   * 紧接着又被问"确定吗"，像是老师自问自答。
   */
  private needsConfirmation(raw?: string): 'end' | 'skip' | null {
    const directive = String(raw || 'NONE').toUpperCase()
    if (directive === 'END_LESSON' && this.pendingConfirm?.kind !== 'end') {
      return 'end'
    }
    if (directive === 'SKIP' && this.pendingConfirm?.kind !== 'skip') return 'skip'
    return null
  }

  /** 问一句"确定吗"。话术由模型生成，生成不出来才用兜底句 */
  private async askForConfirmation(kind: 'end' | 'skip'): Promise<void> {
    this.pendingConfirm = { kind, asked: 1 }
    this.answerMode = null
    this.awaitingAnswer = false
    this.clearAskTimer()
    // 先挂起讲解：确认期间老师不能自说自话往下讲
    this.paused = true
    this.turnState = 'IDLE'
    this.persist({ turnState: 'IDLE', status: 'IN_SESSION' })
    this.emit()
    this.log('confirm.ask', { kind, nodeIndex: this.nodeIndex })

    const context = [
      `课程：${this.course.title}`,
      `当前目标：${this.node?.objective ?? ''}`,
      `刚才学生表达了要${kind === 'end' ? '结束这节课' : '跳过这一节'}`,
    ].join('\n')

    this.clearConfirmTimer()
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null
      if (!this.pendingConfirm) return
      this.log('confirm.timeout', { kind })
      this.pendingConfirm = null
      this.paused = false
      void this.speak(
        this.contract.languagePolicy === 'immersion'
          ? 'No answer, so we keep going.'
          : '没听到回复，那我们继续。'
      ).then(() => this.resumeAfterInterruption())
    }, 25000)

    const line = await this.deps.confirm?.(kind, context).catch(() => null)

    await this.speak(
      line?.trim() ||
        (this.contract.languagePolicy === 'immersion'
          ? kind === 'end'
            ? 'Just to be sure — do you want to stop here for today? Yes or no.'
            : 'Just to be sure — do you want to skip this part? Yes or no.'
          : kind === 'end'
            ? '确认一下：今天这节课就到这里吗？'
            : '确认一下：这一节要跳过吗？')
    )
  }

  /** 学生回答"确定吗" */
  private async handleConfirmation(text: string): Promise<void> {
    const pending = this.pendingConfirm
    if (!pending) return
    this.clearConfirmTimer()

    const heuristic = classifyByHeuristic(text)
    this.log('confirm.answer', {
      kind: pending.kind,
      text,
      asked: pending.asked,
    })

    // 明确的"结束/跳过"最优先
    const explicitYes =
      (pending.kind === 'end' &&
        heuristic.kind === 'control' &&
        heuristic.control === 'end') ||
      (pending.kind === 'skip' &&
        heuristic.kind === 'control' &&
        heuristic.control === 'skip')

    // "好的，继续"这种：句首是肯定词，但意思是不停。
    // 只看开头几个字会把它当成确认，所以显式的继续词优先判否。
    const wantsContinue =
      /(继续|接着|往下|别停|先不|continue|keep going|carry on|not yet)/i.test(text)

    const saidYes = explicitYes || (!wantsContinue && isAffirmative(text))

    const saidNo =
      !saidYes &&
      (wantsContinue ||
        (heuristic.kind === 'control' &&
          (heuristic.control === 'resume' || heuristic.control === 'pause')) ||
        isNegative(text))

    if (saidYes) {
      this.pendingConfirm = null
      this.paused = false
      if (pending.kind === 'end') {
        await this.finish()
        return
      }
      this.transcript.push({
        role: 'system',
        text: `跳过：${this.node?.objective ?? ''}（记为未掌握）`,
      })
      await this.nextNode()
      return
    }

    if (saidNo) {
      this.pendingConfirm = null
      this.paused = false
      this.log('confirm.declined', { kind: pending.kind })
      await this.speak(
        this.contract.languagePolicy === 'immersion'
          ? 'Okay, we keep going.'
          : '好，那我们继续。'
      )
      await this.resumeAfterInterruption()
      return
    }

    // 既不像 yes 也不像 no：交给模型判断这句话到底是不是确认，
    // 而不是机械地只认"是/否"两个词。
    this.pendingConfirm = { kind: pending.kind, asked: pending.asked + 1 }
    const expected = pending.kind === 'end' ? 'END_LESSON' : 'SKIP'
    const context = [
      `课程：${this.course.title}`,
      `你刚才问学生是否${pending.kind === 'end' ? '结束这节课' : '跳过这一节'}`,
      `学生这句话是确认、否认，还是在问别的？如果确认，directive 填 ${expected}；否则填 NONE。`,
    ].join('\n')

    const interpreted = this.deps.answer
      ? await this.deps.answer(text, context).catch(() => null)
      : null

    if (interpreted?.directive === expected) {
      this.pendingConfirm = null
      this.paused = false
      if (pending.kind === 'end') {
        await this.finish()
        return
      }
      this.transcript.push({
        role: 'system',
        text: `跳过：${this.node?.objective ?? ''}（记为未掌握）`,
      })
      await this.nextNode()
      return
    }

    // 不是确认：先回应学生那句话，再默认继续上课。
    // 确认只有一次机会，不能把学生困在"请回答是或否"里。
    this.pendingConfirm = null
    this.paused = false
    if (interpreted?.say?.trim()) {
      await this.speak(interpreted.say.trim())
    }
    await this.resumeAfterInterruption()
  }

  /** 学生开口后迟迟没有转写结果：别让课堂卡在等答案上 */
  private scheduleAskRecovery(): void {
    this.clearAskRecovery()
    this.askRecoveryTimer = setTimeout(() => {
      this.askRecoveryTimer = null
      if (this.finished || this.paused) return
      if (this.answerMode !== 'ask') return
      this.log('ask.no_transcript', { segmentIndex: this.segmentIndex })
      this.pendingAsk = null
      this.answerMode = null
      this.awaitingAnswer = false
      this.launch(this.narrateFrom(this.segmentIndex + 1))
    }, 15000)
  }

  private clearConfirmTimer(): void {
    if (this.confirmTimer) {
      clearTimeout(this.confirmTimer)
      this.confirmTimer = null
    }
  }

  private clearAskRecovery(): void {
    if (this.askRecoveryTimer) {
      clearTimeout(this.askRecoveryTimer)
      this.askRecoveryTimer = null
    }
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
      this.launch(this.completeNode())
      return
    }

    this.phase = 'NARRATING'
    this.turnState = 'TEACHER_SPEAKING'
    this.commitStep('RESUME', {
      segmentIndex: resumeAt,
      payload: { from: this.segmentIndex, committed: this.segmentCommitted },
    })
    this.emit()

    this.launch(this.narrateFrom(resumeAt))
  }

  /**
   * 执行模型给出的课堂指令。
   * 返回 true 表示控制权已经交出去（例如下课），调用方不要再继续讲课。
   */
  private async applyDirective(raw?: string): Promise<boolean> {
    const directive = String(raw || 'NONE').toUpperCase()
    if (directive === 'NONE') return false

    this.log('directive', { directive, nodeIndex: this.nodeIndex })
    this.commitStep('PARK_TOPIC', { payload: { directive } })

    switch (directive) {
      case 'END_LESSON':
        // 第一次只是"提出想下课"，必须先问一句；确认后才真的结束。
        // 误识别一次就下课，对上课的人来说代价太大。
        if (this.pendingConfirm?.kind === 'end') {
          this.pendingConfirm = null
          await this.finish()
          return true
        }
        await this.askForConfirmation('end')
        return true
      case 'PAUSE':
        this.paused = true
        this.persist({ status: 'PAUSED', turnState: 'PAUSED' })
        this.emit()
        return true
      case 'SKIP':
        // 跳过会把这一节记成未掌握，同样需要确认一次
        if (this.pendingConfirm?.kind === 'skip') {
          this.pendingConfirm = null
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
          return true
        }
        await this.askForConfirmation('skip')
        return true
      case 'REPEAT': {
        const segment = this.segments[this.segmentIndex]
        if (segment) await this.speak(segment.text)
        return false
      }
      case 'SLOWER':
        this.contract = { ...this.contract, correctionPolicy: 'gentle' }
        return false
      case 'CHINESE':
        this.contract = {
          ...this.contract,
          languagePolicy: 'english-with-chinese-rescue',
        }
        return false
      case 'RESUME':
        this.paused = false
        return false
      default:
        return false
    }
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

  /**
   * 点"暂停"。
   * 必须当场停住，不能排到学生输入队列后面——日志里点暂停没反应就是这个原因。
   */
  pauseByUser(): void {
    if (this.finished) return
    // 作废正在生成的那一轮答复：否则它几秒后返回，会把"已暂停"这句掐掉
    this.utteranceToken += 1
    this.interruptNarration()
    this.deps.stopSpeaking()
    this.paused = true
    this.answerMode = null
    this.awaitingAnswer = false
    this.awaitingDecision = false
    this.pendingConfirm = null
    this.clearAskTimer()
    this.clearAskRecovery()
    this.clearConfirmTimer()
    this.turnState = 'PAUSED'
    this.persist({ status: 'PAUSED', turnState: 'PAUSED' })
    this.emit()
    this.log('control', { control: 'pause', via: 'button' })
    this.launch(
      this.speak(this.phrase('paused')).then(() => {
        this.turnState = 'PAUSED'
        this.persist({ turnState: 'PAUSED' })
        this.emit()
      })
    )
  }

  async resumeLesson(): Promise<void> {
    if (this.finished) return
    if (!this.paused && this.narrateRunning) return
    // pauseByUser 会把 cancelled 置位用来停住讲解；继续时必须复位，
    // 否则 narrateFrom 一进门就返回——这就是"点继续没反应"。
    this.cancelled = false
    this.paused = false
    this.answerMode = null
    this.awaitingAnswer = false
    this.persist({ status: 'IN_SESSION', turnState: 'TEACHER_SPEAKING' })
    this.emit()
    this.log('control', { control: 'resume', via: 'button' })
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

    // 续课必须重新生成这一节的讲法。
    // 只构造时的兜底分段是编译阶段的书面要点，直接念出来就是教科书写法，
    // 而且那些要点没有 page，页码会停在上一节的位置。
    {
      const node = this.node
      if (node && this.deps.composeNarration) {
        const composed = await this.deps
          .composeNarration(node)
          .catch(() => null)
        if (composed?.segments?.length) {
          this.segments = composed.segments
        }
      }
    }

    // 上次停在的那一段可能已经不存在（讲法重新生成后段落数会变）
    this.segmentIndex = Math.max(
      0,
      Math.min(this.segmentIndex, Math.max(0, this.segments.length - 1))
    )

    // 先把屏幕对到这一段，再开口；否则会停在上一节停下的那一页
    const segment = this.segments[this.segmentIndex]
    if (segment) {
      const anchorIds = this.anchorIdsForSegment(segment)
      const page =
        this.node?.talkingPoints[segment.pointIndex]?.page ?? segment.page
      this.deps.showAnchor(anchorIds, segment.pointIndex, page)
      this.log('resume.segment', {
        segmentIndex: this.segmentIndex,
        page: page ?? null,
        anchorIds,
      })
    }

    this.log('lesson.resume.segments', {
      segments: this.segments.length,
      segmentIndex: this.segmentIndex,
    })

    await this.resumeAfterInterruption()
  }

  async finish(): Promise<void> {
    this.finished = true
    this.nodeToken += 1
    this.clearAskTimer()
    this.clearAskRecovery()
    this.clearConfirmTimer()
    this.narrateToken += 1
    this.pendingConfirm = null
    this.answerMode = null
    this.awaitingAnswer = false
    this.awaitingDecision = false
    this.phase = 'COMPLETED'
    this.turnState = 'IDLE'
    this.deps.stopSpeaking()
    this.deps.setListening?.(false)
    this.persist({ phase: 'COMPLETED', status: 'COMPLETED', turnState: 'IDLE' })
    this.emit()
    this.log('lesson.finish', this.report())
    this.commitStep('END_LESSON', {
      payload: {
        nodesCompleted: this.nodeIndex,
        totalNodes: this.course.nodes.length,
        timeDebtSec: this.timeDebtSec(),
      },
    })
  }

  async endByUser(): Promise<void> {
    // 先停掉正在讲的这一节，否则"道别"和讲解会同时出声
    this.interruptNarration()
    this.deps.stopSpeaking()
    this.clearAskTimer()
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
