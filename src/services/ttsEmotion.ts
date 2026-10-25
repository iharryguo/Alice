/**
 * 逐句情绪 → 语音指令。
 *
 * 火山引擎的 context_texts 是自然语言指令，不是枚举，所以这里把
 * 课堂里标出的情绪翻译成一句具体要求，再和用户自己写的总基调拼在一起。
 */

export const EMOTION_HINTS: Record<string, string> = {
  happy: '这一句要说得非常开心，语调上扬，情绪饱满。',
  sad: '这一句要说得难过、低沉，情绪饱满。',
  angry: '这一句要说得愤怒、有力度，情绪饱满。',
  excited: '这一句要说得兴奋、有感染力，情绪饱满。',
}

export function buildEmotionInstruction(
  base: string | undefined,
  emotion?: string
): string {
  const baseText = String(base || '').trim()
  const hint = emotion ? EMOTION_HINTS[String(emotion).toLowerCase()] : ''
  return [baseText, hint].filter(Boolean).join(' ')
}
