/**
 * 教师运行时的领域类型。
 *
 * 命名遵循 PRD 第十章的数据实体，但只保留一期真正会用到的字段：
 * Material / DocumentPage / ContentAnchor / CourseVersion / LessonNode /
 * ClassContract / ClassSession / TeachingStep / Exercise / Attempt / ObjectiveMastery。
 */

export type MaterialStatus =
  | 'DRAFT'
  | 'PARSING'
  | 'NEEDS_REVIEW'
  | 'READY'
  | 'IMPORT_FAILED'

export type MaterialSourceType = 'pdf' | 'docx' | 'pptx' | 'image'

/** 页面文字的来源：原生文本层，还是模型读图后转写 */
export type PageTextSource = 'text-layer' | 'vision' | 'none'

export interface ContentAnchor {
  anchorId: string
  materialId: string
  pageIndex: number
  /** 该锚点在本页纯文本中的字符区间，用于引用与回定位 */
  charStart: number
  charEnd: number
  /** 归一化坐标（0—1，相对页面宽高，原点在左上），用于高亮 */
  x: number
  y: number
  width: number
  height: number
  text: string
  confidence: number
}

export interface DocumentPage {
  materialId: string
  pageIndex: number
  width: number
  height: number
  text: string
  charCount: number
  textSource: PageTextSource
  /** 文字覆盖率，0—1；低于阈值说明这一页主要是图 */
  textCoverage: number
}

export interface MaterialQualityReport {
  verdict: 'ready' | 'needs_review' | 'blocked'
  pageCount: number
  totalChars: number
  averageCharsPerPage: number
  /** 几乎没有文字的页面（1 起始），这些页只能做页码锚点 */
  lowTextPages: number[]
  reasons: string[]
  /** 需要模型读图才能拿到内容的页 */
  needsVisionPages: number[]
}

export interface MaterialRecord {
  id: string
  title: string
  sourceType: MaterialSourceType
  sourcePath: string
  /** 统一后的 PDF 路径；图片独立存放 */
  documentPath: string | null
  sourceHash: string
  pageCount: number
  status: MaterialStatus
  quality: MaterialQualityReport | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export type CourseVersionStatus = 'DRAFT' | 'CONFIRMED' | 'SUPERSEDED'

export interface LessonNode {
  nodeId: string
  courseVersionId: string
  sequence: number
  objective: string
  /** 必学节点不可被压缩或跳过而不留痕 */
  required: boolean
  plannedDurationSec: number
  compressible: boolean
  minDurationSec: number
  maxDurationSec: number
  /** 引用 ContentAnchor.anchorId，允许为空（纯板书节点） */
  anchorIds: string[]
  /** 讲解要点，原文引用与教师补充分开标注 */
  talkingPoints: Array<{
    text: string
    source: 'material' | 'inference' | 'teacher-addition'
    anchorIds?: string[]
  }>
  exercises: LessonExerciseDraft[]
  completionRule: 'narration-committed' | 'exercise-passed' | 'user-confirmed'
  recoveryPolicy: 'restart-sentence' | 'next-sentence'
}

export interface LessonExerciseDraft {
  exerciseId: string
  type: 'repeat' | 'short-answer' | 'multiple-choice' | 'role-play'
  prompt: string
  expected?: string
  choices?: string[]
  rubric: Array<{ criterion: string; weight: number }>
  waitMs: number
}

export interface CourseVersionRecord {
  courseVersionId: string
  courseId: string
  version: number
  title: string
  materialId: string
  status: CourseVersionStatus
  objectives: string[]
  prerequisites: string[]
  nodes: LessonNode[]
  contentHash: string
  createdAt: string
  confirmedAt: string | null
}

export type PacePolicy = 'time-first' | 'mastery-first' | 'balanced'
export type PresentationMode = 'DOCUMENT_SYNC' | 'BOARD_ONLY'
export type Strictness = 'gentle' | 'standard' | 'firm'

export interface ClassContract {
  contractVersionId: string
  courseVersionId: string
  version: number
  targetDurationMin: number
  pacePolicy: PacePolicy
  presentationMode: PresentationMode
  /** 英语为主、中文救场；全英文只绑定到特定输出活动 */
  languagePolicy: 'english-with-chinese-rescue' | 'immersion' | 'chinese-led'
  correctionPolicy: 'gentle' | 'balanced' | 'strict'
  strictness: Strictness
  wanderThreshold: { windowMinutes: number; strikes: number }
  createdAt: string
  confirmedAt: string | null
}

export type LessonPhase =
  | 'OPENING'
  | 'REVIEW'
  | 'NARRATING'
  | 'CHECKING'
  | 'PRACTICING'
  | 'SUMMARIZING'
  | 'COMPLETED'

export type TurnState =
  | 'IDLE'
  | 'TEACHER_SPEAKING'
  | 'STUDENT_SPEAKING'
  | 'ANSWERING'
  | 'REDIRECTING'
  | 'PAUSED'
  | 'ERROR'

export type PresentationState =
  | 'FOLLOW_LESSON'
  | 'FREE_BROWSE'
  | 'REFERENCE_VIEW'
  | 'GENERATED_BOARD'

export type SessionStatus = 'IN_SESSION' | 'PAUSED' | 'COMPLETED' | 'ERROR'

export interface ClassSession {
  sessionId: string
  courseVersionId: string
  contractVersionId: string
  phase: LessonPhase
  turnState: TurnState
  presentationState: PresentationState
  currentNodeId: string | null
  teacherTurnId: string | null
  studentTurnId: string | null
  cancelTeacherTurnId: string | null
  /** 课程锚点（教师讲到哪）与学生视口（学生看到哪）分开存 */
  lessonAnchor: { pageIndex: number; anchorId?: string } | null
  viewport: { pageIndex: number } | null
  timeDebtSec: number
  status: SessionStatus
  createdAt: string
  updatedAt: string
}

export type TeachingActionType =
  | 'SHOW_PAGE'
  | 'HIGHLIGHT'
  | 'NARRATE'
  | 'ASK'
  | 'PRACTICE'
  | 'PARK_TOPIC'
  | 'RESUME'
  | 'END_LESSON'

export interface TeachingStepRecord {
  stepId: string
  sessionId: string
  nodeId: string | null
  action: TeachingActionType
  teacherTurnId: string | null
  studentTurnId: string | null
  sentenceIndex: number
  sentenceCommitted: boolean
  playbackState: 'pending' | 'playing' | 'completed' | 'cancelled'
  payload: Record<string, unknown>
  committedAt: string
}

export interface ExerciseAttempt {
  attemptId: string
  exerciseId: string
  sessionId: string
  studentInput: string
  audioPath: string | null
  score: { status: 'passed' | 'needs-review' | 'skipped' | 'pending'; detail?: string } | null
  feedback: string | null
  createdAt: string
}
