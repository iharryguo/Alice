import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * 火山识别的真实联调：先用火山 TTS 合成一段英文，再把它送进识别，
 * 验证「音频 → 文本」这条链在真实账号下确实通。
 *
 * 默认跳过，需要 VOLCENGINE_TTS_API_KEY：
 *   VOLCENGINE_TTS_API_KEY=xxx npx vitest run src/__tests__/volcengineAsr.live.test.ts
 */

const userDataDir = mkdtempSync(path.join(tmpdir(), 'alice-volc-asr-'))
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir, getVersion: () => 'test' },
}))

import { synthesizeVolcengineTts } from '../../electron/main/tts/volcengineTts'
import { transcribeWithVolcengineAsr } from '../../electron/main/asr/volcengineAsr'

const apiKey = process.env.VOLCENGINE_TTS_API_KEY?.trim()

function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)
  const writeStr = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, pcm.length, true)

  const out = new Uint8Array(44 + pcm.length)
  out.set(header, 0)
  out.set(pcm, 44)
  return out
}

describe.skipIf(!apiKey)('volcengine ASR (live)', () => {
  it(
    'transcribes synthesized speech back to text',
    async () => {
      const spoken = 'The family in picture one has two children.'

      const tts = await synthesizeVolcengineTts({
        text: spoken,
        apiKey: apiKey!,
        speaker: process.env.VOLCENGINE_TTS_SPEAKER || 'en_female_dacey_uranus_bigtts',
        resourceId: 'seed-tts-2.0',
        format: 'pcm',
        sampleRate: 24000,
      })

      // 识别固定按 16k 传；这里把 24k 音频按 16k 声明会失真，
      // 所以显式下采样到 16k 再交给识别。
      const pcm24 = tts.audio
      const samples = Math.floor(pcm24.length / 2)
      const outSamples = Math.floor(samples * (16000 / 24000))
      const pcm16 = new Uint8Array(outSamples * 2)
      const view = new DataView(pcm24.buffer, pcm24.byteOffset, pcm24.byteLength)
      const outView = new DataView(pcm16.buffer)
      for (let i = 0; i < outSamples; i += 1) {
        const src = Math.floor((i * 24000) / 16000)
        outView.setInt16(i * 2, view.getInt16(src * 2, true), true)
      }

      const wav = pcmToWav(pcm16, 16000)
      const result = await transcribeWithVolcengineAsr({
        apiKey: apiKey!,
        audio: wav,
        resourceId: 'volc.seedasr.auc',
      })

      console.log(`[live] asr text="${result.text}" duration=${result.durationMs}ms`)
      expect(result.text.toLowerCase()).toContain('family')
    },
    90000
  )
})
