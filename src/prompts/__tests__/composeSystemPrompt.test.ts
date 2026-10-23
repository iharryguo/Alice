import { describe, expect, it } from 'vitest'
import { composeAssistantSystemPrompt } from '../composeSystemPrompt'

const PERSONA = 'You are Alice, a warm and witty AI companion.'

describe('composeAssistantSystemPrompt', () => {
  it('英语模式：语言锁排在最前面，并带上人格与教练规则', () => {
    const prompt = composeAssistantSystemPrompt(PERSONA, {
      englishMode: true,
    })

    expect(prompt.startsWith('[LANGUAGE LOCK')).toBe(true)
    expect(prompt).toContain('MUST write every reply in English')
    expect(prompt).toContain(PERSONA)
    expect(prompt).toContain('[English coach behaviour]')
    expect(prompt).toContain('At most ONE correction per turn')
    expect(prompt).toContain('Correction:')

    // 语言锁必须出现在人格之前
    expect(prompt.indexOf('[LANGUAGE LOCK')).toBeLessThan(
      prompt.indexOf(PERSONA)
    )
  })

  it('非英语模式：完全不含语言锁与教练规则', () => {
    const prompt = composeAssistantSystemPrompt(PERSONA, {
      englishMode: false,
    })

    expect(prompt).not.toContain('LANGUAGE LOCK')
    expect(prompt).not.toContain('[English coach behaviour]')
    expect(prompt).toContain(PERSONA)
  })

  it('没有人格文本时仍然返回核心提示词', () => {
    const prompt = composeAssistantSystemPrompt('', { englishMode: false })
    expect(prompt.trim().length).toBeGreaterThan(0)
    expect(prompt).toContain('CORE_BEHAVIOR')
  })

  it('英语模式保留唯一的显式中文逃生口', () => {
    const prompt = composeAssistantSystemPrompt(PERSONA, {
      englishMode: true,
    })
    expect(prompt).toContain('用中文回答')
    expect(prompt).toContain('single turn')
  })
})
