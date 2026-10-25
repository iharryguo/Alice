import { createSummarizationResponse } from '../../services/apiService'
import { useSettingsStore } from '../../stores/settingsStore'
import type { IntentResult } from './lessonRuntime'

/**
 * 课堂里的三个模型调用：意图分类、答疑、练评估。
 *
 * 都走非流式的一次性请求：课堂要的是"快而短"的判断，不需要流式朗读；
 * 真正的朗读交给 TTS 那一层。模型沿用设置里选的那家（DeepSeek）。
 */

function model(): string {
  const config = useSettingsStore().config
  return config.assistantModel || config.SUMMARIZATION_MODEL
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(body.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

export async function classifyIntent(
  text: string,
  context: string
): Promise<IntentResult | null> {
  const systemPrompt = [
    '你是英语课堂的意图分类器。只输出 JSON。',
    'question：与当前课程内容有关的提问；control：要求暂停/继续/重复/慢讲/跳过/下课；',
    'off-topic：与课程无关的请求或闲聊；filler：附和、语气词、噪声；distress：身体或情绪不适。',
    '课程内的追问不能判成 off-topic；拿不准时给 question 并降低 confidence。',
  ].join('\n')

  const raw = await createSummarizationResponse(
    [
      {
        role: 'user',
        content: `课堂上下文：\n${context}\n\n学生说：${text}\n\n输出：{"kind":"question|control|off-topic|filler|distress","confidence":0.0,"control":"pause|resume|repeat|slower|chinese|skip|end|null"}`,
      },
    ],
    model(),
    systemPrompt
  )

  const parsed = parseJson<{
    kind?: string
    confidence?: number
    control?: string | null
  }>(raw)

  if (!parsed?.kind) return null

  const kinds = ['filler', 'question', 'control', 'off-topic', 'distress']
  if (!kinds.includes(parsed.kind)) return null

  return {
    kind: parsed.kind as IntentResult['kind'],
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
    control:
      parsed.control && parsed.control !== 'null'
        ? (parsed.control as IntentResult['control'])
        : undefined,
  }
}

export async function answerInClass(
  question: string,
  context: string
): Promise<string | null> {
  const systemPrompt = [
    '你是正在上课的英语老师，学生刚刚打断你提问。',
    '用两三句话回答，先直接回答，再回扣到当前教学目标。',
    '英语为主，必要时用一句中文解释；不要跑题，不要长篇大论。',
    '回答里不要出现"如图所示"这类无法朗读的描述。',
  ].join('\n')

  return createSummarizationResponse(
    [{ role: 'user', content: `课堂现场：\n${context}\n\n学生提问：${question}` }],
    model(),
    systemPrompt
  )
}

export async function evaluateAnswer(
  answer: string,
  prompt: string,
  rubric: Array<{ criterion: string; weight: number }>
): Promise<{ status: 'passed' | 'needs-review' | 'skipped'; feedback: string }> {
  const systemPrompt = [
    '你是英语老师，正在按量规判一次课堂练习。只输出 JSON。',
    'passed 表示达到量规；needs-review 表示还需要再讲一次；skipped 表示没有作答。',
    'feedback 用一到两句中文加英文示范，语气直接、不夸张。',
  ].join('\n')

  const raw = await createSummarizationResponse(
    [
      {
        role: 'user',
        content: `练习题目：${prompt}\n量规：${JSON.stringify(
          rubric
        )}\n学生作答：${answer}\n\n输出：{"status":"passed|needs-review|skipped","feedback":"..."}`,
      },
    ],
    model(),
    systemPrompt
  )

  const parsed = parseJson<{ status?: string; feedback?: string }>(raw)
  const status =
    parsed?.status === 'passed' || parsed?.status === 'skipped'
      ? parsed.status
      : 'needs-review'

  return {
    status,
    feedback: parsed?.feedback?.trim() || '我先记下你的回答。',
  }
}
