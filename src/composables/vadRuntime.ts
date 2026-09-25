import type { RealTimeVADOptions } from '@ricky0123/vad-web'

type VadCallbacks = Pick<RealTimeVADOptions, 'onSpeechStart' | 'onSpeechEnd'>

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
    positiveSpeechThreshold: 0.6,
    negativeSpeechThreshold: 0.45,
    ortConfig: ort => {
      ort.env.logLevel = 'error'
      ort.env.wasm.wasmPaths = {
        wasm: `${resolvedAssetPath}ort-wasm-simd-threaded.wasm`,
        mjs: `${resolvedAssetPath}ort-wasm-simd-threaded.mjs`,
      }
    },
  }
}
