import { createSummarizationResponse } from '../../services/apiService'
import { useSettingsStore } from '../../stores/settingsStore'
import type {
  ContentAnchor,
  CourseVersionRecord,
  DocumentPage,
  LessonExerciseDraft,
  LessonNode,
  MaterialRecord,
} from '../../../electron/main/teaching/types'

/**
 * 教案 → 课程编译。
 *
 * 分两步走，不是为了好看，而是为了省钱和可控：第一步只用每页开头的一段文字生成
 * 大纲，让用户先确认"教什么、几节课、哪些必学"；确认后才把命中的页面全文送去
 * 生成讲解要点和练习。第一次调用输入约为第二步的三分之一。
 */

const OUTLINE_PAGE_CHARS = 1200
const OUTLINE_TOTAL_CHARS = 24000
const DETAILS_TOTAL_CHARS = 30000

export interface CompileUsage {
  calls: number
  inputChars: number
}

export interface OutlineNode {
  objective: string
  required: boolean
  minutes: number
  pages: number[]
}

export interface CourseOutline {
  title: string
  objectives: string[]
  prerequisites: string[]
  nodes: OutlineNode[]
}

export interface CompiledCourse {
  course: CourseVersionRecord
  anchorCoverage: { nodesWithAnchors: number; totalNodes: number }
  usage: CompileUsage
}

export interface CompileOptions {
  targetMinutes: number
  onProgress?: (stage: string, detail?: string) => void
}

function resolveModel(): string {
  const config = useSettingsStore().config
  return config.assistantModel || config.SUMMARIZATION_MODEL
}

function stripCodeFence(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return body.trim()
  return body.slice(start, end + 1).trim()
}

function parseJsonLoose<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(stripCodeFence(raw)) as T
  } catch (error) {
    console.error('[Teaching] 模型返回的不是合法 JSON:', error)
    return null
  }
}

function clipPages(
  pages: DocumentPage[],
  perPageChars: number,
  totalChars: number
): string {
  let used = 0
  const blocks: string[] = []
  for (const page of pages) {
    if (used >= totalChars) break
    const body = page.text.trim()
    if (!body) {
      blocks.push(`[第 ${page.pageIndex} 页]（图片页，无文字层）`)
      continue
    }
    const clipped = body.slice(0, perPageChars)
    used += clipped.length
    blocks.push(`[第 ${page.pageIndex} 页]\n${clipped}`)
  }
  return blocks.join('\n\n')
}

export async function compileOutline(
  material: MaterialRecord,
  pages: DocumentPage[],
  options: CompileOptions
): Promise<{ outline: CourseOutline; usage: CompileUsage }> {
  options.onProgress?.('正在生成课程大纲')

  const systemPrompt = [
    '你是一位英语教研老师，正在把材料编译成可执行的课程大纲。',
    '只输出 JSON，不要解释，不要代码块以外的文字。',
    '要求：目标具体可检验；节点之间按教学顺序排列；必学节点不要超过 6 个；',
    '每个节点标注它主要依据的页码（必须来自给定文本里的[第 N 页]标记）。',
    '如果材料本身已经是教案，尊重它原有的教学顺序，不要自行改写成另一套。',
  ].join('\n')

  const userPrompt = [
    `材料标题：${material.title}`,
    `计划课时：${options.targetMinutes} 分钟`,
    'JSON 结构：',
    '{"title":"课程标题","objectives":["目标"],"prerequisites":["先备知识"],"nodes":[{"objective":"节点目标","required":true,"minutes":8,"pages":[1,2]}]}',
    '',
    '材料内容：',
    clipPages(pages, OUTLINE_PAGE_CHARS, OUTLINE_TOTAL_CHARS),
  ].join('\n')

  const raw = await createSummarizationResponse(
    [{ role: 'user', content: userPrompt }],
    resolveModel(),
    systemPrompt
  )

  const parsed = parseJsonLoose<CourseOutline>(raw)
  if (!parsed || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new Error('模型没有返回可用的课程大纲，请重试或换一个材料')
  }

  return {
    outline: {
      title: parsed.title?.trim() || material.title,
      objectives: Array.isArray(parsed.objectives) ? parsed.objectives : [],
      prerequisites: Array.isArray(parsed.prerequisites)
        ? parsed.prerequisites
        : [],
      nodes: parsed.nodes.map(node => ({
        objective: String(node.objective || '').trim(),
        required: node.required !== false,
        minutes: Math.max(3, Math.min(30, Number(node.minutes) || 8)),
        pages: Array.isArray(node.pages)
          ? node.pages.map(page => Number(page)).filter(page => page > 0)
          : [],
      })),
    },
    usage: { calls: 1, inputChars: userPrompt.length },
  }
}

interface NodeDetail {
  index: number
  talkingPoints: Array<{ text: string; source: string; page?: number }>
  exercise?: {
    type: string
    prompt: string
    expected?: string
    choices?: string[]
    rubric?: Array<{ criterion: string; weight: number }>
    waitMs?: number
  }
}

export async function compileNodeDetails(
  outline: CourseOutline,
  pages: DocumentPage[],
  options: CompileOptions
): Promise<{
  details: NodeDetail[]
  usage: CompileUsage
}> {
  options.onProgress?.('正在生成讲解要点与练习')

  const pageMap = new Map(pages.map(page => [page.pageIndex, page]))
  const usablePages = outline.nodes
    .flatMap(node => node.pages)
    .filter((page, index, list) => list.indexOf(page) === index)
    .map(page => pageMap.get(page))
    .filter((page): page is DocumentPage => !!page)

  const materialText = clipPages(
    usablePages.length > 0 ? usablePages : pages,
    Number.MAX_SAFE_INTEGER,
    DETAILS_TOTAL_CHARS
  )

  const systemPrompt = [
    '你是英语老师，正在为每个教学节点写可直接朗读的讲解要点。',
    '只输出 JSON。每个要点一到两句，必须能单独朗读，不要出现"如图所示"这类无法朗读的描述。',
    '要点如果来自材料原文，source 填 material 并给出页码；如果是你补充的例子或解释，source 填 teacher-addition。',
    '每个节点配一个练习：跟读用 repeat，问答题用 short-answer，选择题用 multiple-choice。',
  ].join('\n')

  const userPrompt = [
    '课程大纲：',
    JSON.stringify(
      {
        title: outline.title,
        objectives: outline.objectives,
        nodes: outline.nodes.map((node, index) => ({
          index,
          objective: node.objective,
          pages: node.pages,
        })),
      },
      null,
      2
    ),
    '',
    'JSON 结构：',
    '{"nodes":[{"index":0,"talkingPoints":[{"text":"...","source":"material","page":1}],"exercise":{"type":"short-answer","prompt":"...","expected":"...","rubric":[{"criterion":"意思正确","weight":1}],"waitMs":20000}}]}',
    '',
    '材料内容：',
    materialText,
  ].join('\n')

  const raw = await createSummarizationResponse(
    [{ role: 'user', content: userPrompt }],
    resolveModel(),
    systemPrompt
  )

  const parsed = parseJsonLoose<{ nodes?: NodeDetail[] }>(raw)
  if (!parsed?.nodes || !Array.isArray(parsed.nodes)) {
    throw new Error('模型没有返回讲解要点，请重试')
  }

  return {
    details: parsed.nodes,
    usage: { calls: 1, inputChars: userPrompt.length },
  }
}

/** 在给定页里找出与一句话最匹配的锚点：先取文本重叠最高的行，找不到就退回该页首行 */
export function matchAnchor(
  anchors: ContentAnchor[],
  pageIndex: number,
  text: string
): ContentAnchor | null {
  const pageAnchors = anchors.filter(anchor => anchor.pageIndex === pageIndex)
  if (pageAnchors.length === 0) return null

  const needle = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim()
  if (!needle) return pageAnchors[0]

  let best: ContentAnchor | null = null
  let bestScore = 0

  for (const anchor of pageAnchors) {
    const hay = anchor.text
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
      .trim()
    if (!hay) continue
    const score = hay.includes(needle) || needle.includes(hay) ? 1 : overlapScore(needle, hay)
    if (score > bestScore) {
      bestScore = score
      best = anchor
    }
  }

  return bestScore >= 0.5 ? best : pageAnchors[0]
}

/** 按词计算重叠比例，够用来判断"这句话是不是这一行" */
function overlapScore(a: string, b: string): number {
  const aWords = new Set(a.split(/\s+/).filter(word => word.length > 2))
  const bWords = new Set(b.split(/\s+/).filter(word => word.length > 2))
  if (aWords.size === 0 || bWords.size === 0) return 0
  let shared = 0
  for (const word of aWords) if (bWords.has(word)) shared += 1
  return shared / Math.min(aWords.size, bWords.size)
}

export function assembleCourseVersion(params: {
  materialId: string
  outline: CourseOutline
  details: NodeDetail[]
  anchors: ContentAnchor[]
}): {
  course: CourseVersionRecord
  anchorCoverage: { nodesWithAnchors: number; totalNodes: number }
} {
  const { materialId, outline, details, anchors } = params
  const courseId = materialId
  const courseVersionId = `cv-${materialId}-${Date.now()}`
  const now = new Date().toISOString()

  let nodesWithAnchors = 0

  const nodes: LessonNode[] = outline.nodes.map((node, index) => {
    const detail = details.find(item => Number(item.index) === index)
    const fallbackPage = node.pages[0] ?? 1

    const talkingPoints = (detail?.talkingPoints || []).map(point => {
      const page = Number(point.page) || fallbackPage
      const anchor = matchAnchor(anchors, page, String(point.text || ''))
      return {
        text: String(point.text || '').trim(),
        source:
          point.source === 'teacher-addition'
            ? ('teacher-addition' as const)
            : ('material' as const),
        anchorIds: anchor ? [anchor.anchorId] : [],
      }
    })

    if (talkingPoints.length === 0) {
      talkingPoints.push({
        text: `${node.objective}。这一节我们先把这个目标讲清楚，再进入练习。`,
        source: 'teacher-addition',
        anchorIds: [],
      })
    }

    const anchorIds = talkingPoints
      .flatMap(point => point.anchorIds || [])
      .filter((id, idx, list) => list.indexOf(id) === idx)

    if (anchorIds.length > 0) nodesWithAnchors += 1

    const exerciseDraft = detail?.exercise
    const exercise: LessonExerciseDraft = {
      exerciseId: `ex-${courseVersionId}-${index}`,
      type:
        exerciseDraft?.type === 'repeat' || exerciseDraft?.type === 'multiple-choice'
          ? exerciseDraft.type
          : 'short-answer',
      prompt: exerciseDraft?.prompt || `用一句话说明你对「${node.objective}」的理解`,
      expected: exerciseDraft?.expected,
      choices: Array.isArray(exerciseDraft?.choices)
        ? exerciseDraft.choices
        : undefined,
      rubric:
        Array.isArray(exerciseDraft?.rubric) && exerciseDraft.rubric.length > 0
          ? exerciseDraft.rubric
          : [{ criterion: '意思基本正确', weight: 1 }],
      waitMs: Math.max(5000, Math.min(60000, Number(exerciseDraft?.waitMs) || 20000)),
    }

    return {
      nodeId: `node-${courseVersionId}-${index}`,
      courseVersionId,
      sequence: index + 1,
      objective: node.objective,
      required: node.required,
      plannedDurationSec: node.minutes * 60,
      compressible: !node.required,
      minDurationSec: Math.round(node.minutes * 30),
      maxDurationSec: node.minutes * 90,
      anchorIds,
      talkingPoints,
      exercises: [exercise],
      completionRule: 'narration-committed',
      recoveryPolicy: 'restart-sentence',
    }
  })

  const course: CourseVersionRecord = {
    courseVersionId,
    courseId,
    version: 1,
    title: outline.title,
    materialId,
    status: 'DRAFT',
    objectives: outline.objectives,
    prerequisites: outline.prerequisites,
    nodes,
    contentHash: `hash-${Date.now()}`,
    createdAt: now,
    confirmedAt: null,
  }

  return {
    course,
    anchorCoverage: { nodesWithAnchors, totalNodes: nodes.length },
  }
}

export async function compileCourse(params: {
  material: MaterialRecord
  pages: DocumentPage[]
  anchors: ContentAnchor[]
  targetMinutes: number
  onProgress?: (stage: string, detail?: string) => void
}): Promise<CompiledCourse> {
  const options: CompileOptions = {
    targetMinutes: params.targetMinutes,
    onProgress: params.onProgress,
  }

  const outlineResult = await compileOutline(
    params.material,
    params.pages,
    options
  )
  params.onProgress?.('大纲已生成', `${outlineResult.outline.nodes.length} 个节点`)

  const detailsResult = await compileNodeDetails(
    outlineResult.outline,
    params.pages,
    options
  )

  const assembled = assembleCourseVersion({
    materialId: params.material.id,
    outline: outlineResult.outline,
    details: detailsResult.details,
    anchors: params.anchors,
  })

  return {
    course: assembled.course,
    anchorCoverage: assembled.anchorCoverage,
    usage: {
      calls: outlineResult.usage.calls + detailsResult.usage.calls,
      inputChars:
        outlineResult.usage.inputChars + detailsResult.usage.inputChars,
    },
  }
}
