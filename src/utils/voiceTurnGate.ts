/**
 * "叫名字才算说完"的纯函数判定层。
 *
 * 为什么单独抽出来：语音收句的时序逻辑（定时器、VAD 状态、在途转写）很难测，
 * 而"这句话里有没有叫名字""现在该不该发送"是可以完全脱离 Vue 与定时器判断的。
 * 把可判定的部分放在这里，composable 只负责记录片段、起停计时器。
 *
 * 全部函数无副作用、不读 store，方便直接单测。
 */

import { isMeaninglessFiller, normalizeForCompare } from './bargeInHeuristics'

/** 叫了名字之后，停顿多久算说完 */
export const DEFAULT_VOICE_NAME_PAUSE_MS = 2000
/** 没叫名字时，沉默多久兜底发送（沿用 voiceSilenceMs 的默认值） */
export const DEFAULT_VOICE_NAME_FALLBACK_MS = 10000
/** 剥掉称呼后仍要剩下的最少字符数：避免只有一声"Alice？"就发出去 */
export const DEFAULT_VOICE_TURN_MIN_CHARS = 2

/** CJK 名字只在句首附近才算称呼（避免"爱丽丝梦游仙境"这类内容词误判） */
const CJK_NAME_SCAN_CHARS = 8
/** 整句很短时，名字出现在任何位置都算称呼 */
const SHORT_UTTERANCE_CHARS = 6

/**
 * 人格 id → 可能的说法。ASR 对中国人名的音译不稳定，需要多写几种变体；
 * 新增人格时补一条即可，缺了也不会崩（会退化成用 displayName 匹配）。
 */
export const PERSONA_SPOKEN_ALIASES: Record<string, string[]> = {
  alice: ['alice', 'alise', 'alis', '爱丽丝', '艾丽丝', '爱丽斯', '阿丽丝'],
  felix: [
    'felix',
    'feliks',
    '菲利克斯',
    '菲力克斯',
    '费力克斯',
    '费利克斯',
    '菲力',
  ],
  curtis: ['curtis', 'kurtis', 'curtiss', '柯蒂斯', '科蒂斯', '库蒂斯', '柯蒂'],
}

/** 称呼前常见的语气词/打招呼词，判断"是不是在开头叫人"时先跳过它们 */
const LEADING_FILLERS = [
  'hello',
  'hey',
  'okay',
  'ok',
  'well',
  'um',
  'uh',
  'so',
  'yo',
  'hi',
  'er',
  'ah',
  '那个',
  '就是',
  '然后',
  '嗯',
  '呃',
  '欸',
  '诶',
  '哎',
  '唉',
  '啊',
  '哦',
  '噢',
]

/**
 * 中文名字后面紧跟这些字眼时，基本可以确定是在叫它而不是在念名词短语
 * （"爱丽丝帮我看看" ✓ / "爱丽丝梦游仙境" ✗）。
 */
const CJK_ADDRESS_FOLLOW =
  /[帮请你我请麻能可快看说讲给问今那这咱喂来是对好别先再为怎喂，。！？、,.!?：:；;—…]/

const CJK_CHAR =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/

function isCjkName(alias: string): boolean {
  return CJK_CHAR.test(alias)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 语气词的正则片段（长词优先，避免"hey"抢在"hello"前面匹配） */
const LEADING_FILLER_SRC = [...LEADING_FILLERS]
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join('|')

/**
 * 拉丁名字的匹配基线：小写 + 标点转空格 + 压空格。
 * 这里刻意保留空格，因为拉丁文靠词边界判断，去掉空格后 "malice" 会被当成 "alice"。
 */
function toSpaced(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 前缀里除了语气词什么都没说 → 认为名字出现在开头 */
function prefixIsOnlyFillers(prefix: string): boolean {
  let rest = normalizeForCompare(prefix)
  if (!rest) return true
  let matched = true
  while (matched && rest) {
    matched = false
    for (const filler of LEADING_FILLERS) {
      if (rest.startsWith(filler)) {
        rest = rest.slice(filler.length)
        matched = true
        break
      }
    }
  }
  return rest.length === 0
}

export interface PersonaNameHit {
  /** 命中的那一写法 */
  alias: string
  /** 去掉前导语气词后位于开头，最强信号（只有这种才会剥称呼） */
  atStart: boolean
  /** 在归一化文本中的位置，仅用于日志排查 */
  index: number
}

/**
 * 解析某个称号可能的说法：内置别名表 + 当前 displayName。
 * displayName 兜底，保证新增人格即使忘了补别名表也能被叫到。
 */
export function personaSpokenAliases(
  personaId: string,
  displayName?: string
): string[] {
  const key = String(personaId || '')
    .trim()
    .toLowerCase()
  const aliases = [...(PERSONA_SPOKEN_ALIASES[key] || [])]
  const name = String(displayName || '')
    .trim()
    .toLowerCase()
  if (name && !aliases.includes(name)) aliases.push(name)
  return aliases.filter(Boolean)
}

/**
 * 在文本里找人名。命中要求：
 * - 拉丁名走词边界（`malice` / `alices` 不算）
 * - 中文名只看句首附近，且后面要跟着称呼常见的引导词或标点
 *   （否则"爱丽丝梦游仙境真好看"会被当成在叫人）
 */
export function findPersonaName(
  text: string,
  personaId: string,
  displayName?: string
): PersonaNameHit | null {
  const raw = String(text || '')
  if (!raw.trim()) return null
  const aliases = personaSpokenAliases(personaId, displayName)
  const compact = normalizeForCompare(raw)
  const spaced = toSpaced(raw)
  const lowered = raw.toLowerCase()

  let best: PersonaNameHit | null = null

  for (const alias of aliases) {
    if (isCjkName(alias)) {
      const index = compact.indexOf(alias)
      if (index === -1) continue
      // 句中提到名字不算称呼，除非整句很短
      if (
        index > CJK_NAME_SCAN_CHARS - 1 &&
        compact.length > SHORT_UTTERANCE_CHARS
      ) {
        continue
      }
      const atStart = prefixIsOnlyFillers(compact.slice(0, index))
      if (atStart) {
        // 用原文判断名字后面紧跟什么：标点/空格 = 明确的停顿称呼；
        // 直接连字则要求是称呼引导词，挡掉"爱丽丝梦游仙境"这类名词短语
        const rawAfter = lowered.slice(lowered.indexOf(alias) + alias.length)
        const nextChar = rawAfter.charAt(0)
        const delimiter = !nextChar || /[\s\p{P}\p{S}]/u.test(nextChar)
        if (!delimiter && !CJK_ADDRESS_FOLLOW.test(nextChar)) continue
      }
      const hit: PersonaNameHit = { alias, atStart, index }
      if (!best || hit.index < best.index) best = hit
      continue
    }

    const pattern = new RegExp(
      `(^|[^a-z0-9])${escapeRegExp(alias)}(?![a-z0-9])`
    )
    const match = spaced.match(pattern)
    if (!match || match.index === undefined) continue
    // match[1] 是边界字符（可能为空串），别名本身从它之后开始
    const index = match.index + (match[1] ? match[1].length : 0)
    // 所有格不是称呼："Alice's car" 是在聊"Alice 的车"，不是在叫她。
    // toSpaced 把撇号转成了空格，所以这里看到的是 " s"。
    if (/^\ss(?![a-z0-9])/.test(spaced.slice(index + alias.length))) continue
    const hit: PersonaNameHit = {
      alias,
      atStart: prefixIsOnlyFillers(spaced.slice(0, index)),
      index,
    }
    if (!best || hit.index < best.index) best = hit
  }

  return best
}

/**
 * 只剥掉"开头叫人"的那部分（"Alice, 帮我…" → "帮我…"）。
 *
 * 判定完全复用 findPersonaName：只有它认为"在开头叫这个名字"时才动手，
 * 两个函数的语义因此不会分叉——能判成开头称呼的文本一定剥得掉，
 * 像"爱丽丝梦游仙境真好看"这种内容词既不命中也不会被剥。
 */
export function stripLeadingPersonaAddress(
  text: string,
  personaId: string,
  displayName?: string
): string {
  const raw = String(text || '')
  if (!raw.trim()) return raw

  const hit = findPersonaName(raw, personaId, displayName)
  if (!hit || !hit.atStart) return raw

  const alias = escapeRegExp(hit.alias)
  // 拉丁名保留词边界；中文名没有边界概念
  const body = isCjkName(hit.alias) ? alias : `${alias}(?![a-z0-9])`
  // 一口气吃掉：前导语气词（含其后分隔符）+ 称呼 + 称呼后的分隔符。
  // 分隔符统一用 \p{P}\p{S}，全角逗号/问号/省略号都能覆盖，
  // 这样"嗯，Alice，你在吗"和"hey Alice, ..."走的是同一条规则。
  // 中间的 (?:['’]s)? 只为中文名兜底（拉丁名的所有格已经在 findPersonaName 里排除）。
  const pattern = new RegExp(
    `^[\\s]*(?:(?:${LEADING_FILLER_SRC})[\\s\\p{P}\\p{S}]*)*${body}(?:['’]s)?[\\s\\p{P}\\p{S}]*`,
    'iu'
  )
  // 理论上 atStart 命中必然能匹配上；真匹配不到就原样返回，宁可少剥不改坏
  if (!pattern.test(raw)) return raw
  return raw.replace(pattern, '').trim()
}

/** 中文片段之间不加空格，英文片段之间补一个空格，拼出来的句子才自然 */
function joinFragment(left: string, right: string): string {
  if (!left) return right
  if (!right) return left
  const leftLast = left.charAt(left.length - 1)
  const rightFirst = right.charAt(0)
  const needsSpace =
    /[a-z0-9]$/i.test(leftLast) && /^[a-z0-9]/i.test(rightFirst)
  return needsSpace ? `${left} ${right}` : `${left}${right}`
}

/**
 * 合并一轮里的多个转写片段。
 * 连续完全相同的片段只保留一份：ASR 对短音频偶尔会把同一句重复吐出来。
 */
export function mergeTurnFragments(fragments: string[]): string {
  let merged = ''
  let lastKept = ''
  for (const fragment of fragments || []) {
    const text = String(fragment || '').trim()
    if (!text) continue
    if (text === lastKept) continue
    lastKept = text
    merged = joinFragment(merged, text)
  }
  return merged.trim()
}

export type TurnAction = 'send' | 'wait' | 'ignore'

export interface TurnDecisionInput {
  fragments: string[]
  /** 累积文本里是否出现过人格名 */
  personaHit: boolean
  /** 自"最后一次说话结束"起的静音时长（含 VAD 已经等掉的那段） */
  silenceMs: number
  /** 用于剥掉开头称呼；不传则原样返回文本 */
  personaId?: string
  personaDisplayName?: string
  namePauseMs?: number
  fallbackSilenceMs?: number
  minChars?: number
}

export interface TurnDecision {
  action: TurnAction
  /** action === 'send' 时的最终发送文本（已剥掉开头称呼） */
  text: string
  reason: 'name-hit' | 'fallback-silence' | 'waiting' | 'empty'
}

/** 剥掉称呼之后是否还剩下值得发送的内容 */
function hasMeaningfulContent(text: string, minChars: number): boolean {
  const compact = normalizeForCompare(text)
  if (compact.length < Math.max(1, minChars)) return false
  return !isMeaninglessFiller(text)
}

/**
 * 本轮该不该结束、该发什么。
 * 顺序很重要：先看有没有内容，再看名字/兜底两个时间条件，
 * 否则"只叫了一声名字"会被当成有效句子发出去。
 */
export function decideTurnEnd(input: TurnDecisionInput): TurnDecision {
  const namePauseMs = input.namePauseMs ?? DEFAULT_VOICE_NAME_PAUSE_MS
  const fallbackSilenceMs =
    input.fallbackSilenceMs ?? DEFAULT_VOICE_NAME_FALLBACK_MS
  const minChars = input.minChars ?? DEFAULT_VOICE_TURN_MIN_CHARS

  const merged = mergeTurnFragments(input.fragments)
  if (!merged) return { action: 'ignore', text: '', reason: 'empty' }

  // 只有确实叫了名字才剥称呼，避免把正文里的名字也剥掉
  const body =
    input.personaHit && input.personaId
      ? stripLeadingPersonaAddress(
          merged,
          input.personaId,
          input.personaDisplayName
        )
      : merged

  if (!hasMeaningfulContent(body, minChars)) {
    const reachedEnd = input.personaHit
      ? input.silenceMs >= namePauseMs
      : input.silenceMs >= fallbackSilenceMs
    return reachedEnd
      ? { action: 'ignore', text: '', reason: 'empty' }
      : { action: 'wait', text: '', reason: 'waiting' }
  }

  if (input.personaHit && input.silenceMs >= namePauseMs) {
    return { action: 'send', text: body, reason: 'name-hit' }
  }
  if (input.silenceMs >= fallbackSilenceMs) {
    return { action: 'send', text: body, reason: 'fallback-silence' }
  }
  return { action: 'wait', text: '', reason: 'waiting' }
}
