import { afterEach, describe, expect, it } from 'vitest'
import {
  configureLogger,
  getLoggerConfig,
  isLevelEnabled,
} from '../utils/logger'

afterEach(() => {
  configureLogger({ minLevel: 'debug', moduleLevels: {}, enabled: true })
})

describe('renderer logger', () => {
  it('outputs everything by default', () => {
    expect(isLevelEnabled('audio', 'debug')).toBe(true)
    expect(isLevelEnabled('chat', 'error')).toBe(true)
  })

  it('filters by global level', () => {
    configureLogger({ minLevel: 'warn' })
    expect(isLevelEnabled('audio', 'debug')).toBe(false)
    expect(isLevelEnabled('audio', 'info')).toBe(false)
    expect(isLevelEnabled('audio', 'warn')).toBe(true)
    expect(isLevelEnabled('audio', 'error')).toBe(true)
  })

  it('lets one module override the global level', () => {
    configureLogger({ minLevel: 'warn' })
    configureLogger({ moduleLevels: { audio: 'debug' } })

    expect(isLevelEnabled('audio', 'debug')).toBe(true)
    expect(isLevelEnabled('chat', 'debug')).toBe(false)
    expect(getLoggerConfig().moduleLevels.audio).toBe('debug')
  })

  it('can be switched off entirely without touching business code', () => {
    configureLogger({ enabled: false })
    expect(isLevelEnabled('audio', 'error')).toBe(false)

    configureLogger({ enabled: true })
    expect(isLevelEnabled('audio', 'error')).toBe(true)
  })
})
