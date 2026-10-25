import { describe, expect, it } from 'vitest'
import { buildEmotionInstruction } from '../services/ttsEmotion'

describe('buildEmotionInstruction', () => {
  it('combines the global tone with the per-sentence emotion', () => {
    const text = buildEmotionInstruction('语气强烈', 'angry')
    expect(text).toContain('语气强烈')
    expect(text).toContain('愤怒')
  })

  it('falls back to the global tone when the sentence is neutral or unknown', () => {
    expect(buildEmotionInstruction('语气强烈', 'neutral')).toBe('语气强烈')
    expect(buildEmotionInstruction('语气强烈', 'whatever')).toBe('语气强烈')
    expect(buildEmotionInstruction('语气强烈')).toBe('语气强烈')
  })

  it('works with only an emotion and no global tone', () => {
    expect(buildEmotionInstruction('', 'happy')).toContain('开心')
  })
})
