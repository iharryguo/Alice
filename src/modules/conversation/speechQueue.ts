import type { AudioState } from '../../stores/generalStore'
import { isExpectedAbortError } from '../../utils/isAbortError'

export interface SpeechQueueDependencies {
  createAbortController(): AbortController
  setTtsAbortController(controller: AbortController | null): void
  ttsStream(text: string, signal: AbortSignal): Promise<Response>
  queueAudioForPlayback(response: Response): boolean
  getPlaybackEpoch(): number
  getAudioState(): AudioState
  setAudioState(state: AudioState): void
  logError(...args: any[]): void
}

export interface SpeechQueueManager {
  enqueueSpeech(text: string): Promise<void>
}

export function createSpeechQueueManager(
  dependencies: SpeechQueueDependencies
): SpeechQueueManager {
  return {
    async enqueueSpeech(text: string): Promise<void> {
      if (!text.trim()) return

      const epochAtRequestStart = dependencies.getPlaybackEpoch()
      const abortController = dependencies.createAbortController()
      dependencies.setTtsAbortController(abortController)

      try {
        const ttsResponse = await dependencies.ttsStream(
          text,
          abortController.signal
        )

        // A provider may resolve a request after AbortController.abort() has
        // been called. Never let that stale response restart playback after a
        // barge-in or an explicit TTS cancellation.
        if (abortController.signal.aborted) {
          return
        }

        // 请求期间若发生过真正的停止（代次变化），该响应已过期，直接丢弃，
        // 防止它在被打断后"复活"并重新开始播放。
        if (dependencies.getPlaybackEpoch() !== epochAtRequestStart) {
          return
        }

        const enqueued = dependencies.queueAudioForPlayback(ttsResponse)
        if (enqueued && dependencies.getAudioState() !== 'SPEAKING') {
          dependencies.setAudioState('SPEAKING')
        }
      } catch (error: any) {
        if (abortController.signal.aborted || isExpectedAbortError(error)) {
          return
        }
        dependencies.logError('TTS stream creation failed:', error)
      }
    },
  }
}
