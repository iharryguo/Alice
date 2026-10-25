import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERSONA_ID,
  PERSONAS,
  buildPersonaPrompt,
  getPersona,
} from '../personas'
import { composeAssistantSystemPrompt } from '../composeSystemPrompt'

describe('personas', () => {
  it('has Alice as the default identity', () => {
    expect(DEFAULT_PERSONA_ID).toBe('alice')
    expect(getPersona(undefined).id).toBe('alice')
    expect(getPersona('nobody').id).toBe('alice')
  })

  it('describes Felix as a 45-year-old Nebraska farmer who never left home', () => {
    const felix = getPersona('felix')
    expect(felix.displayName).toBe('Felix')
    expect(felix.avatarFile).toBe('felix.mp4')
    expect(felix.prompt).toContain('45 years old')
    expect(felix.prompt).toContain('Nebraska')
    expect(felix.prompt).toContain('farmer')
    expect(felix.prompt).toContain('never flown')
    expect(felix.prompt).toContain('Karen')
    expect(felix.summary).toContain('45')
  })


  it('describes Curtis as a 55-year-old construction project manager', () => {
    const curtis = getPersona('curtis')
    expect(curtis.displayName).toBe('Curtis')
    expect(curtis.avatarFile).toBe('curtis.mp4')
    expect(curtis.prompt).toContain('55 years old')
    expect(curtis.prompt).toContain('project manager')
    expect(curtis.prompt).toContain('Halbrook Construction')
    expect(curtis.summary).toContain('55')
  })

  it('supports more than two personas without id collisions', () => {
    const ids = PERSONAS.map(persona => persona.id)
    expect(ids).toContain('alice')
    expect(ids).toContain('felix')
    expect(ids).toContain('curtis')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps ids and avatar files short and stable', () => {
    for (const persona of PERSONAS) {
      expect(persona.id).toMatch(/^[a-z]+$/)
      if (persona.avatarFile) {
        expect(persona.avatarFile).toBe(`${persona.id}.mp4`)
      }
    }
  })
})

describe('buildPersonaPrompt', () => {
  it('injects established notes and user additions', () => {
    const prompt = buildPersonaPrompt(getPersona('felix'), {
      notes: ['My dog is a border collie named Shep.'],
      extra: '他说话更慢一点。',
    })
    expect(prompt).toContain('ESTABLISHED ABOUT MYSELF')
    expect(prompt).toContain('border collie named Shep')
    expect(prompt).toContain('USER NOTES ABOUT THIS PERSONA')
    expect(prompt).toContain('他说话更慢一点')
    expect(prompt).toContain('remember_self_fact')
  })

  it('caps the number of notes to protect the context window', () => {
    const notes = Array.from({ length: 40 }, (_, i) => `note ${i}`)
    const prompt = buildPersonaPrompt(getPersona('alice'), {
      notes,
      maxNotes: 5,
    })
    expect(prompt).toContain('note 39')
    expect(prompt).not.toContain('note 34')
  })
})

describe('composeAssistantSystemPrompt with personas', () => {
  it('uses Felix when he is selected and leaves Alice out', () => {
    const prompt = composeAssistantSystemPrompt('', {
      englishMode: false,
      personaId: 'felix',
      personaNotes: ['My truck is a 1998 Ford F-150.'],
    })
    expect(prompt).toContain('Felix Ward')
    expect(prompt).toContain('1998 Ford F-150')
    expect(prompt).not.toContain('greenish-blue hair')
    expect(prompt).toContain('CORE_BEHAVIOR')
  })

  it('keeps the language lock ahead of the identity block', () => {
    const prompt = composeAssistantSystemPrompt('', {
      englishMode: true,
      personaId: 'felix',
    })
    expect(prompt.indexOf('[LANGUAGE LOCK')).toBeLessThan(
      prompt.indexOf('Felix Ward')
    )
  })
})
