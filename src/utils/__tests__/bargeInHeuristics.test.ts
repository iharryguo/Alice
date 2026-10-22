import { describe, expect, it } from 'vitest'
import {
  isExplicitInterruptCommand,
  isLikelyMeaningfulSpeech,
  isLikelySelfEcho,
  isMeaninglessFiller,
  textSimilarity,
} from '../bargeInHeuristics'

describe('barge-in heuristics', () => {
  it('treats filler words and empty transcripts as meaningless', () => {
    for (const text of ['', '   ', '嗯', '嗯嗯', '啊？', '呃...', '哈哈', 'emmm']) {
      expect(isMeaninglessFiller(text), text).toBe(true)
    }
    expect(isMeaninglessFiller('你好')).toBe(false)
    expect(isMeaninglessFiller('帮我打开文件')).toBe(false)
  })

  it('recognizes explicit interrupt commands even when short', () => {
    for (const text of ['停', '停一下', '别说了', '等一下', 'Stop!', '等等']) {
      expect(isExplicitInterruptCommand(text), text).toBe(true)
      expect(isLikelyMeaningfulSpeech(text, '这是一段正在朗读的很长很长的回答内容'), text).toBe(true)
    }
    expect(isExplicitInterruptCommand('今天天气不错')).toBe(false)
  })

  it('detects TTS self-echo by comparing transcript with spoken text', () => {
    const spoken = '今天天气不错，我们下午出去走走吧，顺便买点水果回来。'
    expect(isLikelySelfEcho('今天天气不错', spoken)).toBe(true)
    expect(isLikelySelfEcho('我们下午出去走走吧', spoken)).toBe(true)
    expect(isLikelySelfEcho('你刚才说什么', spoken)).toBe(false)
  })

  it('does not classify a real user reply as self-echo', () => {
    const spoken = '今天天气不错，我们下午出去走走吧。'
    expect(isLikelyMeaningfulSpeech('那我们去哪儿', spoken)).toBe(true)
    expect(isLikelyMeaningfulSpeech('嗯', spoken)).toBe(false)
    expect(isLikelyMeaningfulSpeech('今天天气不错', spoken)).toBe(false)
  })

  it('scores identical text higher than unrelated text', () => {
    expect(textSimilarity('打开文件', '打开文件')).toBe(1)
    expect(textSimilarity('打开文件', '今天天气不错')).toBeLessThan(0.2)
    expect(textSimilarity('帮我订明天去上海的机票', '帮我订明天去北京的机票')).toBeGreaterThan(0.6)
  })
})
