import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
}))

import { buildAsrSubmitPayload } from '../../electron/main/asr/volcengineAsr'

describe('volcengine ASR payload', () => {
  it('sends audio as base64 data, which is the only way for local mic recordings', () => {
    const body = JSON.parse(
      buildAsrSubmitPayload({
        audioBase64: 'QUJD',
        format: 'wav',
        rate: 16000,
        bits: 16,
        channel: 1,
      })
    )

    expect(body.audio.data).toBe('QUJD')
    expect(body.audio.format).toBe('wav')
    expect(body.audio.rate).toBe(16000)
    // 官方文档只写了 url，但本地录音没有公网地址，实测 data 可用
    expect(body.audio.url).toBeUndefined()
  })

  it('enables auto language detection when no language is given', () => {
    const body = JSON.parse(
      buildAsrSubmitPayload({
        audioBase64: 'QUJD',
        format: 'wav',
        rate: 16000,
        bits: 16,
        channel: 1,
      })
    )

    expect(body.request.enable_auto_lang).toBe(true)
    expect(body.request.language).toBeUndefined()
    // 这两项不能同时出现，接口会拒绝
    expect(body.request.enable_auto_lang && body.request.language).toBeFalsy()
  })

  it('uses the explicit language and drops auto detection when configured', () => {
    const body = JSON.parse(
      buildAsrSubmitPayload({
        audioBase64: 'QUJD',
        format: 'wav',
        rate: 16000,
        bits: 16,
        channel: 1,
        language: 'en-US',
      })
    )

    expect(body.request.language).toBe('en-US')
    expect(body.request.enable_auto_lang).toBeUndefined()
  })
})
