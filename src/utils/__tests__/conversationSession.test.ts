import { describe, expect, it } from 'vitest'
import {
  getConversationSessionId,
  rotateConversationSessionId,
  setConversationSessionId,
} from '../conversationSession'

describe('conversationSession', () => {
  it('keeps a stable id until it is rotated', () => {
    const first = getConversationSessionId()
    expect(first).toBeTruthy()
    expect(getConversationSessionId()).toBe(first)

    const rotated = rotateConversationSessionId()
    expect(rotated).not.toBe(first)
    expect(getConversationSessionId()).toBe(rotated)
  })

  it('adopts a restored session id and ignores empty values', () => {
    setConversationSessionId('s-restored-1')
    expect(getConversationSessionId()).toBe('s-restored-1')

    setConversationSessionId('   ')
    expect(getConversationSessionId()).toBe('s-restored-1')
  })
})
