import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  vadRuntimeAssetNames,
  vadStaticCopyTargets,
} from '../../build/vadAssets'
import { createVadOptions } from '../composables/vadRuntime'

describe('VAD runtime packaging', () => {
  it('ships every configured local runtime asset', () => {
    for (const target of vadStaticCopyTargets) {
      expect(fs.existsSync(path.resolve(target.src)), target.src).toBe(true)
    }

    expect(vadRuntimeAssetNames).toEqual(
      expect.arrayContaining([
        'vad.worklet.bundle.min.js',
        'silero_vad_legacy.onnx',
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.wasm',
      ])
    )
  })
})

describe('VAD initialization options', () => {
  it('resolves relative assets from the renderer URL', () => {
    vi.stubGlobal('window', {
      location: { href: 'http://localhost:3344/' },
    })

    const options = createVadOptions('./', {
      onSpeechStart: vi.fn(),
      onSpeechEnd: vi.fn(),
      onSpeechRealStart: vi.fn(),
    })

    expect(options.baseAssetPath).toBe('http://localhost:3344/')
    expect(options.onnxWASMBasePath).toBe('http://localhost:3344/')

    vi.unstubAllGlobals()
  })

  it('uses local assets and leaves startup under application control', () => {
    const onSpeechStart = vi.fn()
    const onSpeechEnd = vi.fn()
    const onSpeechRealStart = vi.fn()

    const options = createVadOptions('file:///app/dist/', {
      onSpeechStart,
      onSpeechEnd,
      onSpeechRealStart,
    })

    expect(options).toMatchObject({
      baseAssetPath: 'file:///app/dist/',
      onnxWASMBasePath: 'file:///app/dist/',
      model: 'legacy',
      startOnLoad: false,
      onSpeechStart,
      onSpeechEnd,
      onSpeechRealStart,
    })

    const ort = { env: { logLevel: 'warning', wasm: {} } }
    options.ortConfig?.(ort as never)

    expect(ort).toMatchObject({
      env: {
        logLevel: 'error',
        wasm: {
          wasmPaths: {
            wasm: 'file:///app/dist/ort-wasm-simd-threaded.wasm',
            mjs: 'file:///app/dist/ort-wasm-simd-threaded.mjs',
          },
        },
      },
    })
  })

  it('raises speech thresholds and disables auto gain control', async () => {
    const getUserMedia = vi.fn(async () => ({}))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })

    const options = createVadOptions('./', {
      onSpeechStart: vi.fn(),
      onSpeechEnd: vi.fn(),
      onSpeechRealStart: vi.fn(),
    })

    expect(options.positiveSpeechThreshold).toBe(0.65)
    expect(options.negativeSpeechThreshold).toBe(0.5)

    await options.getStream?.()

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        // 关闭自动增益，避免把环境噪音和回声残余放大后触发误打断；
        // 真实语音的拾取由更低的播放期阈值 + ducking 方案补偿。
        autoGainControl: false,
        noiseSuppression: true,
      },
    })

    vi.unstubAllGlobals()
  })
})
