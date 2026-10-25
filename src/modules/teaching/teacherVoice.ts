import { createSummarizationResponse } from '../../services/apiService'
import { useSettingsStore } from '../../stores/settingsStore'
import type {
  ClassContract,
  CourseVersionRecord,
  LessonExerciseDraft,
  LessonNode,
} from '../../../electron/main/teaching/types'

/**
 * 课堂口语层。
 *
 * 编译阶段只产出"教什么"（要点、锚点、练习），不下判断"怎么说"——
 * 因为课堂契约是独立版本，同一份课程可能这节全英文、下节中文救场。
 * 所以真正开口的句子必须在这里按契约现场生成：短句、口语、像老师说话，
 * 而不是把教案要点原样念出来。
 */

function model(): string {
  const config = useSettingsStore().config
  return config.assistantModel || config.SUMMARIZATION_MODEL
}

function languageDirective(contract: ClassContract): string {
  switch (contract.languagePolicy) {
    case 'immersion':
      return '全英文授课：所有讲解、提问、反馈都用英文，除非学生明确要求中文解释，否则不要出现中文。'
    case 'chinese-led':
      return '中文讲解为主：讲解和课堂管理用中文，英文只用于例句、目标句型和跟读。'
    default:
      return '英文为主、中文救场：讲解用简单英文，只在解释抽象概念或学生听不懂时补一句中文。'
  }
}

export function controlPhrase(
  contract: ClassContract,
  key: 'paused' | 'resumed' | 'skipped' | 'timeDebt' | 'end'
): string {
  const english = contract.languagePolicy === 'immersion'
  const table: Record<typeof key, { zh: string; en: string }> = {
    paused: { zh: '好，先停在这里。说“继续”我就接着讲。', en: 'Okay, we pause here. Say "continue" when you are ready.' },
    resumed: { zh: '好，我们接着刚才的地方。', en: 'Alright, let us pick up where we stopped.' },
    skipped: { zh: '好，这一节先跳过，我记成还没掌握。', en: 'Okay, we skip this part. I will mark it as not mastered yet.' },
    timeDebt: { zh: '我们比计划慢了，要不要延长几分钟？', en: 'We are running behind. Do you want to extend the lesson?' },
    end: { zh: '好，今天先到这里。', en: 'Alright, let us stop here for today.' },
  }
  return english ? table[key].en : table[key].zh
}

function stripFence(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return (fenced ? fenced[1] : raw).trim()
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  const body = stripFence(raw)
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(body.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

export interface NarrationSegment {
  text: string
  /** 对应 node.talkingPoints 的下标，用来决定展示哪一页、亮哪一段 */
  pointIndex: number
  /** say = 陈述；ask = 提问，说完必须停下来等回答 */
  kind: 'say' | 'ask'
  /** 学生此刻应该看到的页码 */
  page?: number
}

export interface NarrationResult {
  opening: string
  segments: NarrationSegment[]
}

/**
 * 按课堂契约生成这一节真正要说的话。
 *
 * pointIndex 必须回填，它是自动翻页的唯一依据：讲到第二个要点就翻到第二个要点
 * 所在的那一页，而不是整节课停在第一页。
 */
export async function composeNarration(params: {
  course: CourseVersionRecord
  node: LessonNode
  contract: ClassContract
  /** 是否本课第一个节点：只有第一次才允许问好 */
  isFirstNode?: boolean
}): Promise<NarrationResult | null> {
  const { node, contract, course } = params

  const systemPrompt = [
    '你是一位一对一英语老师，正在给学生上课，你说的话会被直接朗读出来。',
    languageDirective(contract),
    '口语化：短句，每句不超过 18 个词；可以用 "So"、"Right"、"Look at this" 这类真实的课堂用语。',
    '不要念教材、不要写教案腔（禁止"本节的教学目标是""通过本课学习"这类句子）。',
    '不要描述图片内容之外的排版，不要出现"如图所示"这种读出来没意义的词。',
    params.isFirstNode
      ? '这是本课第一段，可以简单问好并说明今天做什么。'
      : '这已经不是第一次开口了：绝对不要再说 Hello / Good to see you / 又见面了，用一个过渡句直接进入这一节。',
    '每个 segment 必须标明 kind：陈述用 say，向学生提问用 ask。',
    '每个 segment 必须标明 page：讲这一段时学生应该看材料第几页，只能取给你的页码范围。',
    '如果讲到新的图片、表格或另一页的内容，page 必须跟着往后走；不要整节都用第一页。',
    'ask 只能是一句问句，而且这句话说完老师会停下来等学生回答，所以 ask 后面不要接别的内容。',
    '每个节点最多两个 ask；不要让所有段落都变成提问。',
    '只输出 JSON。',
  ].join('\n')

  const points = node.talkingPoints
    .map(
      (point, index) =>
        `${index}. （第 ${point.page ?? '?'} 页）${point.text}`
    )
    .join('\n')

  const userPrompt = [
    `课程：${course.title}`,
    `这一节的 objective：${node.objective}`,
    '要讲的要点（编号即 pointIndex）：',
    points,
    '',
    `课时长度：${contract.targetDurationMin} 分钟。`,
    '输出结构：',
    '{"opening":"开场的一两句话","segments":[{"text":"要说的一到两句话","pointIndex":0,"kind":"say|ask","page":1}]}',
    '要求：segments 覆盖全部要点，顺序不变；每个要点 1—2 段；开场要像老师真的在跟学生打招呼并说明今天做什么。',
  ].join('\n')

  const raw = await createSummarizationResponse(
    [{ role: 'user', content: userPrompt }],
    model(),
    systemPrompt
  )

  const parsed = parseJson<{
    opening?: string
    segments?: Array<{
      text?: string
      pointIndex?: number
      kind?: string
      page?: number
    }>
  }>(raw)

  if (!parsed?.segments?.length) return null

  const segments = parsed.segments
    .map((segment, index) => ({
      text: String(segment.text || '').trim(),
      pointIndex: Number.isFinite(Number(segment.pointIndex))
        ? Number(segment.pointIndex)
        : Math.min(index, node.talkingPoints.length - 1),
      kind: segment.kind === 'ask' ? ('ask' as const) : ('say' as const),
      page: Number(segment.page) > 0 ? Number(segment.page) : undefined,
    }))
    .filter(segment => segment.text.length > 0)

  if (segments.length === 0) return null

  return {
    opening: String(parsed.opening || '').trim(),
    segments,
  }
}

/**
 * "确定要下课/跳过吗"的问句。
 * 这句话的语气比内容重要：不能像系统弹窗，也不能借机挽留。
 */
export async function confirmAction(params: {
  kind: 'end' | 'skip'
  contract: ClassContract
  context: string
}): Promise<string | null> {
  const { kind, contract, context } = params

  const systemPrompt = [
    '你是正在上课的英语老师，学生刚说想结束或跳过，你要先确认一次。',
    languageDirective(contract),
    kind === 'end'
      ? '用一句话问清楚：今天这节课就到这里吗？'
      : '用一句话问清楚：这一节要跳过吗？',
    '只要一句，不超过 20 个词。不要挽留，不要解释，不要道别。',
    '问句必须能用一个 yes / no 回答。',
    '只输出这句话本身，不要引号，不要 JSON。',
  ].join('\n')

  const raw = await createSummarizationResponse(
    [{ role: 'user', content: context }],
    model(),
    systemPrompt
  )

  const line = stripFence(raw || '').replace(/^["'“”]+|["'“”]+$/g, '').trim()
  return line || null
}

/** 老师回复里携带的控制指令。由模型显式给出，不靠关键词猜。 */
export type TeacherDirective =
  | 'NONE'
  | 'END_LESSON'
  | 'PAUSE'
  | 'RESUME'
  | 'REPEAT'
  | 'SLOWER'
  | 'CHINESE'
  | 'SKIP'

export interface ClassReply {
  say: string
  directive: TeacherDirective
}

const DIRECTIVES: TeacherDirective[] = [
  'NONE',
  'END_LESSON',
  'PAUSE',
  'RESUME',
  'REPEAT',
  'SLOWER',
  'CHINESE',
  'SKIP',
]

function normalizeDirective(raw: unknown): TeacherDirective {
  const value = String(raw || '').trim().toUpperCase()
  return (DIRECTIVES as string[]).includes(value)
    ? (value as TeacherDirective)
    : 'NONE'
}

/**
 * 课堂提问的回答。
 *
 * 关键点：意图不靠关键词匹配，而是要求模型在回复里额外给出 directive 字段。
 * 学生说 "I'd like to stop"、"咱们今天就到这吧"、"能不能换中文"，
 * 模型必须把这些映射成 END_LESSON / CHINESE，运行时照指令执行。
 * 正则只在"暂停/继续"这种要立刻响应的极短命令上做快速通道。
 */
export async function answerInClass(
  question: string,
  context: string,
  contract: ClassContract
): Promise<ClassReply | null> {
  const systemPrompt = [
    '你是正在上课的英语老师，学生刚刚打断你说话。',
    languageDirective(contract),
    '两到三句话：先直接回答，再拉回当前教学目标。口语化，不要书面语。',
    '还要判断学生是不是在下达课堂控制指令，并把它写进 directive 字段：',
    'END_LESSON = 明确要结束这节课（不学了、就到这、I want to stop、let us stop here）；',
    'PAUSE = 要求暂停；RESUME = 要求继续；REPEAT = 要求再说一遍；',
    'SLOWER = 要求讲慢；CHINESE = 要求用中文；SKIP = 要求跳过当前内容；',
    '都不是就填 NONE。拿不准时填 NONE，不要猜。',
    '即使 directive 不是 NONE，say 也要用一句自然的话回应学生。',
    '只输出 JSON：{"say":"...","directive":"NONE"}。',
  ].join('\n')

  const raw = await createSummarizationResponse(
    [
      {
        role: 'user',
        content: `课堂现场：\n${context}\n\n学生说：${question}`,
      },
    ],
    model(),
    systemPrompt
  )

  if (!raw?.trim()) return null

  const parsed = parseJson<{ say?: string; directive?: string }>(raw)
  if (parsed?.say?.trim()) {
    return { say: parsed.say.trim(), directive: normalizeDirective(parsed.directive) }
  }

  // 模型没按 JSON 回：把正文当回答，指令按 NONE 处理，不能因此不回应
  return { say: stripFence(raw), directive: 'NONE' }
}

export interface ScaffoldResult {
  say: string
  /** 是否到此为止、标记待复习后进入下一节 */
  giveUp: boolean
}

/**
 * 学生答不出来时的脚手架。
 *
 * 真实老师不会说"那你休息一下"，也不会把同一个问题再念一遍：
 * 第一次给提示，第二次给示范让跟读，第三次才承认这一节先过、记成待复习。
 */
export async function scaffoldAnswer(params: {
  node: LessonNode
  exercise: LessonExerciseDraft
  attempt: number
  studentSaid: string
  contract: ClassContract
}): Promise<ScaffoldResult> {
  const { exercise, attempt, contract, studentSaid } = params

  if (attempt >= 3) {
    return {
      say:
        contract.languagePolicy === 'immersion'
          ? `No problem. Let me give you the answer: ${exercise.expected || exercise.prompt}. We will come back to it next time.`
          : `没关系，我直接给你答案：${exercise.expected || exercise.prompt}。这一条我们先记下来，下次再练。`,
      giveUp: true,
    }
  }

  const systemPrompt = [
    '你是英语老师，学生没答上来。你要给的是"能让他开口"的帮助，不是安慰。',
    languageDirective(contract),
    '第一次：把问题拆小、给句型开头或关键词提示，仍然要求学生回答。',
    '第二次：给一个示范答案，让学生跟着说一遍。',
    '只输出 JSON：{"say":"你要说的话"}。不要长篇解释，不要重复原题。',
  ].join('\n')

  const userPrompt = [
    `题目：${exercise.prompt}`,
    `参考/期望答案：${exercise.expected || '（无固定答案）'}`,
    `学生说：${studentSaid || '（没有作答）'}`,
    `这是第 ${attempt} 次尝试。`,
  ].join('\n')

  const raw = await createSummarizationResponse(
    [{ role: 'user', content: userPrompt }],
    model(),
    systemPrompt
  )

  const parsed = parseJson<{ say?: string }>(raw)
  const say = String(parsed?.say || '').trim()

  if (say) return { say, giveUp: false }

  // 模型没给出可用内容时的兜底，也要保持语言策略
  const fallback =
    contract.languagePolicy === 'immersion'
      ? attempt === 1
        ? `Let us make it easier. Just start with: "${firstWords(exercise.prompt)}"`
        : `Listen and repeat after me: "${exercise.expected || exercise.prompt}"`
      : attempt === 1
        ? `我们把它拆小一点，你先说这句的开头：“${firstWords(exercise.prompt)}”`
        : `听我说一遍，你跟着读：“${exercise.expected || exercise.prompt}”`

  return { say: fallback, giveUp: false }
}

function firstWords(text: string): string {
  return String(text || '')
    .split(/\s+/)
    .slice(0, 3)
    .join(' ')
}
