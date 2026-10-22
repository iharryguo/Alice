/**
 * 语音打断的本地启发式判断。
 *
 * 设计目标：不调用任何模型/网络，零延迟地判断一段转写是否值得打断 TTS。
 * 关键修复：TTS 自身的回声被转写后，文本往往与上一轮回答高度重合，
 * 必须能识别为“自声”而不是“用户在说话”，否则会自打断。
 */

/** 归一化：去掉空白、标点、符号，统一小写，便于比较中英文 */
export function normalizeForCompare(text: string): string {
  if (!text) return ''
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

const FILLER_PATTERN = /^[嗯啊呃欸哎唉哦噢喔哈嘿诶呀哇唔额嗯哼emuhhierahok]+$/

/** 纯语气词/填充词（嗯、啊、呃、哈哈……），不值得打断 */
export function isMeaninglessFiller(text: string): boolean {
  const cleaned = normalizeForCompare(text)
  if (!cleaned) return true
  return cleaned.length <= 4 && FILLER_PATTERN.test(cleaned)
}

const EXPLICIT_INTERRUPTS = [
  '停',
  '停下',
  '停一下',
  '别说了',
  '别说啦',
  '等一下',
  '等等',
  '等会儿',
  '暂停',
  '闭嘴',
  'stop',
  'wait',
  'holdon',
  'pause',
  'no',
]

/** 明确的打断指令：即使很短也必须生效 */
export function isExplicitInterruptCommand(text: string): boolean {
  const cleaned = normalizeForCompare(text)
  if (!cleaned || cleaned.length > 8) return false
  return EXPLICIT_INTERRUPTS.some(
    command => cleaned === command || cleaned.includes(command)
  )
}

function charBigrams(text: string): string[] {
  const result: string[] = []
  for (let i = 0; i < text.length - 1; i += 1) {
    result.push(text.slice(i, i + 2))
  }
  return result
}

/**
 * 文本相似度（0~1）：Dice 系数 + 子串包含。
 * 用于比较“麦克风转写”与“Alice 正在说的文本”。
 */
export function textSimilarity(a: string, b: string): number {
  const left = normalizeForCompare(a)
  const right = normalizeForCompare(b)
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.length >= 4 && right.includes(left)) {
    return Math.max(0.75, left.length / right.length)
  }
  if (right.length >= 4 && left.includes(right)) {
    return Math.max(0.75, right.length / left.length)
  }
  if (left.length < 2 || right.length < 2) return 0

  const leftBigrams = charBigrams(left)
  const rightBigrams = charBigrams(right)
  const counts = new Map<string, number>()
  for (const gram of leftBigrams) {
    counts.set(gram, (counts.get(gram) || 0) + 1)
  }
  let intersection = 0
  for (const gram of rightBigrams) {
    const count = counts.get(gram) || 0
    if (count > 0) {
      intersection += 1
      counts.set(gram, count - 1)
    }
  }
  return (2 * intersection) / (leftBigrams.length + rightBigrams.length)
}

/**
 * 是否是 Alice 自己的 TTS 回声。
 * 判断依据：转写文本与最近一次助手回复（正在朗读的内容）高度重合。
 */
export function isLikelySelfEcho(
  transcript: string,
  spokenText: string
): boolean {
  const cleaned = normalizeForCompare(transcript)
  if (!cleaned) return false
  if (isExplicitInterruptCommand(transcript)) return false
  if (!spokenText) return false
  if (cleaned.length >= 4 && normalizeForCompare(spokenText).includes(cleaned)) {
    return true
  }
  if (cleaned.length < 6) return false
  return textSimilarity(transcript, spokenText) >= 0.55
}

/**
 * 是否值得作为一次真正的打断来处理。
 * 空/语气词/自声回声 → false；明确指令或较长且非回声的语音 → true。
 */
export function isLikelyMeaningfulSpeech(
  transcript: string,
  spokenText: string
): boolean {
  const cleaned = normalizeForCompare(transcript)
  if (!cleaned || cleaned.length < 1) return false
  if (isExplicitInterruptCommand(transcript)) return true
  if (isMeaninglessFiller(transcript)) return false
  if (isLikelySelfEcho(transcript, spokenText)) return false
  return cleaned.length >= 2
}
