/**
 * 长期记忆的自动整理。
 *
 * 之前的记忆只有一条：模型某次碰巧调了 save_memory。没有整理环节，
 * 向量库再准也没东西可检索。这里在几个自然的收尾点（一轮说完、切会话、
 * 窗口收起、程序退出）把最近对话过一遍，只留下"以后还用得上"的事实。
 *
 * 纯逻辑与副作用分开：抽取/解析/去重是可以单测的纯函数，
 * 模型调用与落库由调用方注入。
 */

export interface SettleMessage {
  role: string
  text: string
}

export interface MemoryCandidate {
  content: string
  memoryType: string
}

export const MEMORY_TYPES = [
  'personal',
  'preference',
  'project',
  'general',
] as const

export const MEMORY_EXTRACTION_SYSTEM_PROMPT = [
  '你的任务是从一段对话里挑出值得长期记住的事实，供以后检索使用。',
  '',
  '只记录同时满足两条的信息：一是关于用户的、长期有效的；二是以后对话里会用上的。典型有：',
  '- 身份与背景：职业、所在城市、语言习惯、家庭或团队角色；',
  '- 长期偏好：写作风格、技术栈偏好、称呼与禁忌、常用工具；',
  '- 正在推进的事：项目名称、目标、关键人物、已定的决策；',
  '- 用户明确要求记住的内容。',
  '',
  '不要记录：一次性的任务细节、临时情绪、寒暄、你自己的推测、',
  '以及密码、密钥、证件号、银行卡这类凭据（一个字都不要抄）。',
  '',
  '每条一句话，20 到 80 字，用用户本来的语言，不要加"用户"以外的第三人称评论。',
  '最多 3 条，宁缺毋滥；没有值得记的就返回空数组。',
  '',
  '只输出 JSON 数组，不要解释，不要代码块。格式：',
  '[{"content":"……","memoryType":"personal|preference|project|general"}]',
].join('\n')

const MIN_CONTENT_CHARS = 8
const MAX_CONTENT_CHARS = 200

/** 去重用的归一化：忽略空白、标点与大小写差异 */
export function normalizeMemoryKey(content: string): string {
  return String(content || '')
    .toLowerCase()
    .replace(/[\s，。、；;：:！!？?,.、"'"'（）()【】[\]{}<>《》-]/g, '')
}

/**
 * 从模型输出里解析候选记忆。
 * 模型偶尔会裹一层 ```json 或加一句"好的"，所以取第一个 [ 到最后一个 ]，
 * 解析失败就当没有——绝不把半截文本塞进记忆库。
 */
export function parseMemoryCandidates(raw: string | null): MemoryCandidate[] {
  if (!raw) return []
  const text = String(raw)
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const result: MemoryCandidate[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const content = String((item as any).content || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (content.length < MIN_CONTENT_CHARS || content.length > MAX_CONTENT_CHARS) {
      continue
    }
    const rawType = String((item as any).memoryType || 'general').toLowerCase()
    const memoryType = (MEMORY_TYPES as readonly string[]).includes(rawType)
      ? rawType
      : 'general'
    result.push({ content, memoryType })
  }
  return result
}

/**
 * 去掉与既有记忆重复的条目。
 * 除了完全相同的归一化文本，也挡掉"旧句包含新句（或反过来）"的近重复——
 * 模型换个说法把同一件事再存一遍是最常见的污染来源。
 */
export function selectNewMemories(
  candidates: MemoryCandidate[],
  existing: string[],
  limit = 3
): MemoryCandidate[] {
  const existingKeys = existing
    .map(normalizeMemoryKey)
    .filter(key => key.length > 0)
  const accepted: MemoryCandidate[] = []
  const acceptedKeys: string[] = []

  for (const candidate of candidates) {
    if (accepted.length >= limit) break
    const key = normalizeMemoryKey(candidate.content)
    if (key.length < MIN_CONTENT_CHARS) continue

    const duplicated = [...existingKeys, ...acceptedKeys].some(known => {
      if (known === key) return true
      const shorter = Math.min(known.length, key.length)
      const longer = Math.max(known.length, key.length)
      if (shorter === 0 || shorter / longer < 0.72) return false
      return known.includes(key) || key.includes(known)
    })
    if (duplicated) continue

    accepted.push(candidate)
    acceptedKeys.push(key)
  }
  return accepted
}

/** 把最近若干条消息拼成一段紧凑对话，按字数预算从最早处裁剪 */
export function buildMemoryTranscript(
  messages: SettleMessage[],
  options: { maxMessages?: number; perMessage?: number; maxChars?: number } = {}
): string {
  const maxMessages = options.maxMessages ?? 30
  const perMessage = options.perMessage ?? 700
  const maxChars = options.maxChars ?? 6000

  const newestFirst = messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .slice(0, maxMessages)

  const lines = newestFirst
    .slice()
    .reverse()
    .map(message => {
      const label = message.role === 'user' ? '用户' : '助手'
      const text = String(message.text || '')
        .replace(/\s+/g, ' ')
        .trim()
      const clipped =
        text.length > perMessage ? `${text.slice(0, perMessage)}…` : text
      return clipped ? `${label}：${clipped}` : ''
    })
    .filter(Boolean)

  let total = lines.reduce((sum, line) => sum + line.length + 1, 0)
  while (lines.length > 1 && total > maxChars) {
    total -= lines[0].length + 1
    lines.shift()
  }
  return lines.join('\n')
}

export interface MemoryEmbedding {
  doubao?: number[]
  openai?: number[]
  local?: number[]
}

export interface MemorySettlerDependencies {
  isEnabled(): boolean
  getModel(): string
  /** 聊天记录，最新的在前（与 chatHistory 一致） */
  getMessages(): SettleMessage[]
  getExistingMemories(): Promise<string[]>
  complete(input: {
    transcript: string
    systemPrompt: string
    model: string
  }): Promise<string | null>
  embed(text: string): Promise<MemoryEmbedding>
  saveMemory(input: {
    content: string
    memoryType: string
    embedding: MemoryEmbedding
  }): Promise<boolean>
  log(
    level: 'info' | 'warn' | 'error',
    event: string,
    data?: Record<string, unknown>
  ): void
  now?(): number
  /** 两次整理的最小间隔，防止每说一句就调一次模型 */
  minIntervalMs?: number
  /** 至少新增几条消息才值得整理 */
  minNewMessages?: number
  maxMessages?: number
  completeTimeoutMs?: number
}

export interface MemorySettleResult {
  saved: number
  skipped?: string
}

export interface MemorySettler {
  settle(
    reason: string,
    options?: {
      messages?: SettleMessage[]
      force?: boolean
      /** 覆盖默认的模型调用超时；退出前只给很短的时间 */
      timeoutMs?: number
    }
  ): Promise<MemorySettleResult>
}

export function createMemorySettler(
  dependencies: MemorySettlerDependencies
): MemorySettler {
  const minIntervalMs = dependencies.minIntervalMs ?? 45_000
  const minNewMessages = dependencies.minNewMessages ?? 2
  const maxMessages = dependencies.maxMessages ?? 30
  const completeTimeoutMs = dependencies.completeTimeoutMs ?? 15_000
  const now = () => (dependencies.now ? dependencies.now() : Date.now())

  let lastRunAt = 0
  let lastCount = 0
  let running = false

  const withTimeout = async <T>(
    promise: Promise<T>,
    ms: number,
    label: string
  ): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        promise,
        new Promise<null>(resolve => {
          timer = setTimeout(() => {
            dependencies.log('warn', 'settle.timeout', { label, ms })
            resolve(null)
          }, ms)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    async settle(reason, options) {
      if (!dependencies.isEnabled()) return { saved: 0, skipped: 'disabled' }
      if (running) return { saved: 0, skipped: 'busy' }

      const messages = (options?.messages ?? dependencies.getMessages()).filter(
        message => message.role === 'user' || message.role === 'assistant'
      )
      const newMessages = messages.length - lastCount
      if (!options?.force) {
        if (newMessages < minNewMessages) {
          return { saved: 0, skipped: 'nothing-new' }
        }
        if (now() - lastRunAt < minIntervalMs) {
          return { saved: 0, skipped: 'cooldown' }
        }
      }

      const transcript = buildMemoryTranscript(messages, {
        maxMessages,
      })
      if (!transcript.trim()) return { saved: 0, skipped: 'empty' }

      running = true
      const startedAt = now()
      dependencies.log('info', 'settle.start', {
        reason,
        messages: messages.length,
        newMessages,
        chars: transcript.length,
      })

      try {
        const raw = await withTimeout(
          dependencies.complete({
            transcript,
            systemPrompt: MEMORY_EXTRACTION_SYSTEM_PROMPT,
            model: dependencies.getModel(),
          }),
          options?.timeoutMs ?? completeTimeoutMs,
          'complete'
        )
        if (raw === null) return { saved: 0, skipped: 'timeout' }

        const candidates = parseMemoryCandidates(raw)
        if (candidates.length === 0) {
          lastRunAt = now()
          lastCount = messages.length
          dependencies.log('info', 'settle.empty', { reason })
          return { saved: 0, skipped: 'no-candidates' }
        }

        const existing = await dependencies
          .getExistingMemories()
          .catch(() => [] as string[])
        const fresh = selectNewMemories(candidates, existing)
        if (fresh.length === 0) {
          lastRunAt = now()
          lastCount = messages.length
          dependencies.log('info', 'settle.duplicated', {
            reason,
            candidates: candidates.length,
          })
          return { saved: 0, skipped: 'duplicated' }
        }

        let saved = 0
        for (const candidate of fresh) {
          try {
            const embedding = await dependencies.embed(candidate.content)
            const ok = await dependencies.saveMemory({
              content: candidate.content,
              memoryType: candidate.memoryType,
              embedding,
            })
            if (ok) {
              saved += 1
              dependencies.log('info', 'memory.saved', {
                memoryType: candidate.memoryType,
                content: candidate.content.slice(0, 80),
              })
            }
          } catch (error) {
            dependencies.log('warn', 'memory.save.failed', {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }

        lastRunAt = now()
        lastCount = messages.length
        dependencies.log('info', 'settle.done', {
          reason,
          saved,
          candidates: candidates.length,
          ms: now() - startedAt,
        })
        return { saved }
      } catch (error) {
        dependencies.log('error', 'settle.failed', {
          reason,
          error: error instanceof Error ? error.message : String(error),
        })
        return { saved: 0, skipped: 'error' }
      } finally {
        running = false
      }
    },
  }
}
