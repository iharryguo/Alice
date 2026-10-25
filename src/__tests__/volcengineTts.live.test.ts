import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * 真实联调用的集成测试。
 *
 * 默认不跑：只有设置了 VOLCENGINE_TTS_API_KEY 才会执行，避免把密钥写进仓库、
 * 也避免每次跑单测都产生一次计费与网络请求。
 *
 *   VOLCENGINE_TTS_API_KEY=xxx npx vitest run src/__tests__/volcengineTts.live.test.ts
 */

const userDataDir = mkdtempSync(path.join(tmpdir(), 'alice-volc-tts-'))

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir, getVersion: () => 'test' },
}))

import { synthesizeVolcengineTts } from '../../electron/main/tts/volcengineTts'

const apiKey = process.env.VOLCENGINE_TTS_API_KEY?.trim()

/** 有指定目录就把样音留在那儿，方便人耳确认音色；否则放临时目录 */
function sampleDir(): string {
  return process.env.VOLCENGINE_TTS_SAMPLE_DIR?.trim() || userDataDir
}

describe.skipIf(!apiKey)('volcengine tts (live)', () => {
  it(
    'synthesizes speech and returns real audio bytes',
    async () => {
      const result = await synthesizeVolcengineTts({
        text: 'Hello, this is Alice. Let us look at the first picture together.',
        apiKey: apiKey!,
        speaker: process.env.VOLCENGINE_TTS_SPEAKER || 'zh_female_vv_uranus_bigtts',
        resourceId: process.env.VOLCENGINE_TTS_RESOURCE_ID || 'seed-tts-2.0',
        emotion: '这一句要说得非常开心，语调上扬，情绪饱满。',
        format: 'mp3',
        sampleRate: 24000,
      })

      const out = path.join(sampleDir(), 'volc-sample-english.mp3')
      writeFileSync(out, result.audio)

      console.log(
        `[live] bytes=${result.audio.length} mime=${result.mime} saved=${out}`
      )

      expect(result.audio.length).toBeGreaterThan(1000)
    },
    60000
  )

  it(
    'synthesizes a multi-sentence paragraph in one session',
    async () => {
      const result = await synthesizeVolcengineTts({
        text:
          'Look at this picture. There are four people in the family. ' +
          'The mother is cooking, and the two children are doing their homework.',
        apiKey: apiKey!,
        speaker: process.env.VOLCENGINE_TTS_SPEAKER || 'zh_female_vv_uranus_bigtts',
        resourceId: process.env.VOLCENGINE_TTS_RESOURCE_ID || 'seed-tts-2.0',
        emotion: '这一句要说得兴奋、有感染力，情绪饱满。',
        format: 'mp3',
        sampleRate: 24000,
      })

      console.log(`[live] long bytes=${result.audio.length}`)
      expect(result.audio.length).toBeGreaterThan(20000)
    },
    90000
  )

  it(
    'falls back to the bilingual voice when an English-only voice gets Chinese text',
    async () => {
      const result = await synthesizeVolcengineTts({
        text: '你好，我是 Alice，今天我们一起看这张图片。',
        apiKey: apiKey!,
        speaker: 'en_female_dacey_uranus_bigtts',
        resourceId: 'seed-tts-2.0',
        format: 'mp3',
        sampleRate: 24000,
      })

      const out = path.join(sampleDir(), 'volc-sample-chinese-fallback.mp3')
      writeFileSync(out, result.audio)
      console.log(`[live] fallback bytes=${result.audio.length} saved=${out}`)
      expect(result.audio.length).toBeGreaterThan(1000)
    },
    90000
  )

  it(
    'rejects a bad api key with a readable message instead of a timeout',
    async () => {
      await expect(
        synthesizeVolcengineTts({
          text: 'Hello.',
          apiKey: '00000000-0000-0000-0000-000000000000',
          speaker: 'zh_female_vv_uranus_bigtts',
          resourceId: 'seed-tts-2.0',
        })
      ).rejects.toThrow(/401|鉴权失败/)
    },
    45000
  )
})
