import type { RealTimeVADOptions } from '@ricky0123/vad-web'

type VadCallbacks = Pick<
  RealTimeVADOptions,
  'onSpeechStart' | 'onSpeechEnd' | 'onSpeechRealStart'
>

function resolveAssetPath(assetPath: string): string {
  if (typeof window === 'undefined') {
    return assetPath
  }

  return new URL(assetPath, window.location.href).href
}

export function createVadOptions(
  assetPath: string,
  callbacks: VadCallbacks
): Partial<RealTimeVADOptions> {
  const resolvedAssetPath = resolveAssetPath(assetPath)

  return {
    ...callbacks,
    baseAssetPath: resolvedAssetPath,
    onnxWASMBasePath: resolvedAssetPath,
    model: 'legacy',
    startOnLoad: false,
    // 覆盖 vad-web 默认阈值（默认 positive 0.3 / negative 0.25），降低误触发：
    // 减少咳嗽、背景噪音、以及 TTS 回声泄漏导致的误打断。
    // 两个值需配合调整，negativeSpeechThreshold 约比 positiveSpeechThreshold 低 0.15。
    // 播放期间由 useAudioProcessing 动态调整（见 SPEAKING_SPEECH_THRESHOLD）。
    positiveSpeechThreshold: 0.65,
    negativeSpeechThreshold: 0.5,
    // 关闭自动增益：AGC 会把环境噪音、以及回声消除后的残余信号一起放大，
    // 是“任何小声音都触发”的主要推手。
    // 代价是远场/偏小的真实语音更难被拾取；这里通过更低的播放期阈值
    // 与 ducking（只压低音量、不打断）来平衡，而不是重新打开 AGC。
    getStream: async () =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: false,
          noiseSuppression: true,
        },
      }),
    ortConfig: ort => {
      ort.env.logLevel = 'error'
      ort.env.wasm.wasmPaths = {
        wasm: `${resolvedAssetPath}ort-wasm-simd-threaded.wasm`,
        mjs: `${resolvedAssetPath}ort-wasm-simd-threaded.mjs`,
      }
    },
  }
}
