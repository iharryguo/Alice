import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
}))

import {
  buildSessionPayload,
  buildTaskPayload,
  decodeMessage,
  encodeMessage,
} from '../../electron/main/tts/volcengineTts'

/**
 * 火山 TTS 走的是二进制自定义协议，字段错一位整条请求就废掉。
 * 这里按官方 protocols 文档把客户端编码与一个模拟的服务端响应固定下来，
 * 以后改协议相关代码时能立刻发现回归。
 */

describe('volcengine TTS protocol', () => {
  it('encodes StartConnection with event, no session id', () => {
    const buf = encodeMessage({
      type: 0b0001,
      flag: 0b0100,
      event: 1,
      payload: Buffer.from('{}'),
    })

    expect(buf[0]).toBe(0x11) // version 1, header 4 bytes
    expect(buf[1]).toBe(0x14) // FullClientRequest + WithEvent
    expect(buf[2]).toBe(0x10) // JSON, no compression
    expect(buf[3]).toBe(0x00)
    expect(buf.readInt32BE(4)).toBe(1) // StartConnection
    expect(buf.readUInt32BE(8)).toBe(2) // payload size "{}"
    expect(buf.subarray(12).toString()).toBe('{}')
  })

  it('encodes StartSession with session id and JSON payload', () => {
    const payload = buildSessionPayload({
      speaker: 'zh_female_vv_uranus_bigtts',
      format: 'mp3',
      sampleRate: 24000,
      emotion: '语气强烈',
    })

    const buf = encodeMessage({
      type: 0b0001,
      flag: 0b0100,
      event: 100,
      sessionId: 'session-1',
      payload: Buffer.from(payload),
    })

    expect(buf.readInt32BE(4)).toBe(100)
    const sessionSize = buf.readUInt32BE(8)
    expect(sessionSize).toBe('session-1'.length)
    expect(buf.subarray(12, 12 + sessionSize).toString()).toBe('session-1')

    const payloadSize = buf.readUInt32BE(12 + sessionSize)
    const body = JSON.parse(
      buf.subarray(16 + sessionSize, 16 + sessionSize + payloadSize).toString()
    )
    expect(body.req_params.speaker).toBe('zh_female_vv_uranus_bigtts')
    expect(body.req_params.audio_params.sample_rate).toBe(24000)
    // 文本必须留给 TaskRequest：放进 StartSession 会被服务端忽略，
    // 结果是"连上了、会话开了、一个字节音频都没有"
    expect(body.req_params.text).toBeUndefined()
    expect(body.namespace).toBe('BidirectionalTTS')
    expect(body.event).toBe(100)
  })

  it('sends the text in TaskRequest with the required namespace', () => {
    const body = JSON.parse(buildTaskPayload('Look at this photo.'))

    expect(body.req_params.text).toBe('Look at this photo.')
    expect(body.event).toBe(200)
    expect(body.namespace).toBe('BidirectionalTTS')
  })

  it('passes the emotion instruction as context_texts', () => {
    const payload = JSON.parse(
      buildSessionPayload({
        speaker: 'voice',
        format: 'mp3',
        sampleRate: 24000,
        speechRate: 10,
        emotion: '  用非常兴奋的语气  ',
      })
    )

    expect(payload.req_params.context_texts).toEqual(['用非常兴奋的语气'])
    expect(payload.req_params.audio_params.speech_rate).toBe(10)
  })

  it('omits context_texts when the emotion instruction is empty', () => {
    const payload = JSON.parse(
      buildSessionPayload({
        speaker: 'voice',
        format: 'mp3',
        sampleRate: 24000,
        emotion: '   ',
      })
    )

    expect(payload.req_params.context_texts).toBeUndefined()
  })

  it('decodes an audio chunk from the server', () => {
    const audio = Buffer.from([1, 2, 3, 4, 5])
    const header = Buffer.from([0x11, 0xb4, 0x00, 0x00]) // AudioOnlyServer + WithEvent
    const event = Buffer.alloc(4)
    event.writeInt32BE(352, 0)
    const sessionId = Buffer.from('s1')
    const sessionLen = Buffer.alloc(4)
    sessionLen.writeUInt32BE(sessionId.length, 0)
    const payloadLen = Buffer.alloc(4)
    payloadLen.writeUInt32BE(audio.length, 0)

    const message = Buffer.concat([
      header,
      event,
      sessionLen,
      sessionId,
      payloadLen,
      audio,
    ])

    const parsed = decodeMessage(message)
    expect(parsed.event).toBe(352)
    expect(parsed.sessionId).toBe('s1')
    expect(Array.from(parsed.payload)).toEqual([1, 2, 3, 4, 5])
  })

  it('decodes ConnectionStarted with a connect id instead of a session id', () => {
    const connectId = Buffer.from('conn-9')
    const header = Buffer.from([0x11, 0x94, 0x00, 0x00]) // FullServerResponse + WithEvent
    const event = Buffer.alloc(4)
    event.writeInt32BE(50, 0)
    const idLen = Buffer.alloc(4)
    idLen.writeUInt32BE(connectId.length, 0)
    const emptyPayload = Buffer.alloc(4)

    const parsed = decodeMessage(
      Buffer.concat([header, event, idLen, connectId, emptyPayload])
    )

    expect(parsed.event).toBe(50)
    expect(parsed.connectId).toBe('conn-9')
    expect(parsed.sessionId).toBeUndefined()
    expect(parsed.payload.length).toBe(0)
  })
})
