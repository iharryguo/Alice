import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * 设置保存的回归测试。
 *
 * 这里保护两件曾经真出过事故的事：
 * 1. 密钥按字段合并——清空一个字段不能顺手把其它密钥全删了；
 * 2. 未提及的字段保持原样，避免"保存一次就丢配置"。
 */

let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    getVersion: () => 'test',
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf-8'),
    decryptString: (buffer: Buffer) =>
      buffer.toString('utf-8').replace(/^enc:/, ''),
  },
}))

async function loadModule() {
  vi.resetModules()
  return import('../../electron/main/settingsManager')
}

function secretsPath(): string {
  return path.join(userDataDir, 'alice-secrets.bin')
}

function readSecrets(): Record<string, string> {
  const raw = readFileSync(secretsPath(), 'utf-8')
  return JSON.parse(raw.replace(/^enc:/, '')) as Record<string, string>
}

describe('settingsManager.saveSettings', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(path.join(tmpdir(), 'alice-settings-'))
    writeFileSync(path.join(userDataDir, 'alice-settings.json'), '{}', 'utf-8')
    writeFileSync(
      secretsPath(),
      'enc:' + JSON.stringify({ VITE_DEEPSEEK_API_KEY: 'deepseek-key' }),
      'utf-8'
    )
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('keeps other secrets when one key is saved', async () => {
    const { saveSettings } = await loadModule()

    await saveSettings({
      VOLCENGINE_TTS_API_KEY: 'volc-key',
    } as never)

    expect(readSecrets()).toMatchObject({
      VITE_DEEPSEEK_API_KEY: 'deepseek-key',
      VOLCENGINE_TTS_API_KEY: 'volc-key',
    })
  })

  it('clears only the field that was explicitly emptied', async () => {
    const { saveSettings } = await loadModule()

    await saveSettings({
      VITE_DEEPSEEK_API_KEY: '',
      VOLCENGINE_TTS_API_KEY: 'volc-key',
    } as never)

    const secrets = readSecrets()
    expect(secrets.VITE_DEEPSEEK_API_KEY).toBeUndefined()
    expect(secrets.VOLCENGINE_TTS_API_KEY).toBe('volc-key')
  })

  it('leaves secrets untouched when the payload mentions none', async () => {
    const { saveSettings } = await loadModule()

    await saveSettings({ aiProvider: 'deepseek' } as never)

    expect(readSecrets()).toEqual({ VITE_DEEPSEEK_API_KEY: 'deepseek-key' })
  })

  it('writes non-secret fields to the public file', async () => {
    const { saveSettings } = await loadModule()

    await saveSettings({
      aiProvider: 'deepseek',
      volcengineTtsSpeaker: 'ICL_uranus_en_male_the_grinch_tob',
      VOLCENGINE_TTS_API_KEY: 'volc-key',
    } as never)

    const publicSettings = JSON.parse(
      readFileSync(path.join(userDataDir, 'alice-settings.json'), 'utf-8')
    )
    expect(publicSettings.volcengineTtsSpeaker).toBe(
      'ICL_uranus_en_male_the_grinch_tob'
    )
    // 密钥不能留在明文文件里
    expect(publicSettings.VOLCENGINE_TTS_API_KEY).toBeUndefined()
  })
})
