import { ref, watch, onUnmounted } from 'vue'
import { useGeneralStore } from '../stores/generalStore'
import { storeToRefs } from 'pinia'

export function useAudioPlayback() {
  const generalStore = useGeneralStore()
  const {
    audioState,
    audioPlayer,
    audioQueue,
    isTTSEnabled,
    isRecordingRequested,
    playbackEpoch,
  } = storeToRefs(generalStore)
  const { setAudioState } = generalStore

  const isProcessingQueue = ref(false)
  // “自然播空”标志：队列暂时播完（后续句子还在合成）时的状态回落。
  // 这不是打断/取消，绝不能触发清理，否则会 abort 掉正在合成的下一句，
  // 并让代次自增把刚返回的音频判为过期 —— 长回答会因此丢段落。
  const isNaturalDrain = ref(false)

  const playNextAudio = async () => {
    if (isProcessingQueue.value) {
      console.log('[Playback] playNextAudio skipped: Already processing queue.')
      return
    }
    if (audioState.value !== 'SPEAKING' || !isTTSEnabled.value) {
      console.log(
        `[Playback] playNextAudio skipped: State is ${audioState.value} or TTS disabled.`
      )
      isProcessingQueue.value = false
      return
    }
    if (audioQueue.value.length === 0) {
      console.log('[Playback] Queue empty, transitioning state.')
      isNaturalDrain.value = true
      setAudioState(isRecordingRequested.value ? 'LISTENING' : 'IDLE')
      isProcessingQueue.value = false
      return
    }
    if (!audioPlayer.value) {
      console.error('[Playback] Audio player element not available.')
      setAudioState(isRecordingRequested.value ? 'LISTENING' : 'IDLE')
      isProcessingQueue.value = false
      return
    }

    isProcessingQueue.value = true
    const epoch = playbackEpoch.value
    const audioResponse = audioQueue.value.shift()
    console.log(
      `[Playback] Processing next audio chunk. Queue size: ${audioQueue.value.length}`
    )

    if (!audioResponse) {
      console.warn('[Playback] Dequeued undefined audio response.')
      isProcessingQueue.value = false
      playNextAudio()
      return
    }

    // 代次已变化，说明这块音频属于已被真正停止的一轮播放，直接丢弃
    if (epoch !== playbackEpoch.value) {
      console.log('[Playback] Discarding stale audio chunk (epoch changed).')
      isProcessingQueue.value = false
      return
    }

    let audioUrl: string | null = null
    try {
      const blob = await audioResponse.blob()
      audioUrl = URL.createObjectURL(blob)

      // blob 转换期间可能发生了真正的停止，此时绝不能再启动播放
      if (epoch !== playbackEpoch.value) {
        console.log(
          '[Playback] Discarding audio chunk after await (epoch changed).'
        )
        URL.revokeObjectURL(audioUrl)
        isProcessingQueue.value = false
        return
      }

      if (audioPlayer.value.src) {
        URL.revokeObjectURL(audioPlayer.value.src)
      }
      audioPlayer.value.src = audioUrl

      audioPlayer.value.onended = null
      audioPlayer.value.onerror = null

      const currentAudioUrl = audioUrl
      audioPlayer.value.onended = () => {
        if (epoch !== playbackEpoch.value) {
          // 该块属于已被停止的一轮播放，不要继续预约下一块
          URL.revokeObjectURL(currentAudioUrl)
          return
        }
        console.log('[Playback] Audio chunk finished playing.')
        URL.revokeObjectURL(currentAudioUrl)
        isProcessingQueue.value = false
        requestAnimationFrame(playNextAudio)
      }

      audioPlayer.value.onerror = e => {
        if (epoch !== playbackEpoch.value) {
          URL.revokeObjectURL(currentAudioUrl)
          return
        }
        console.error(
          '[Playback] Error playing audio:',
          e,
          audioPlayer.value?.error
        )
        URL.revokeObjectURL(currentAudioUrl)
        isProcessingQueue.value = false
        requestAnimationFrame(playNextAudio)
      }

      await audioPlayer.value.play()
      console.log('[Playback] Audio play() called.')
    } catch (error: any) {
      console.error('[Playback] Error setting up or playing audio:', error)
      isProcessingQueue.value = false
      if (audioUrl && audioUrl.startsWith('blob:')) {
        URL.revokeObjectURL(audioUrl)
      }
      requestAnimationFrame(playNextAudio)
    }
  }

  const stopPlaybackAndClearQueue = () => {
    console.log('[Playback Control] Stopping playback and clearing queue.')
    isNaturalDrain.value = false
    isProcessingQueue.value = false
    generalStore.stopPlaybackAndClearQueue()
  }

  watch(audioState, (newState, oldState) => {
    console.log(
      `[Playback Watcher] Audio state changed from ${oldState} to ${newState}`
    )
    if (newState === 'SPEAKING') {
      if (!isProcessingQueue.value && audioQueue.value.length > 0) {
        console.log('[Playback Watcher] State is SPEAKING, starting playback.')
        playNextAudio()
      } else {
        console.log(
          '[Playback Watcher] State is SPEAKING, but already processing or queue empty.'
        )
      }
    } else if (oldState === 'SPEAKING') {
      if (isNaturalDrain.value) {
        // 队列暂时播空（下一句还在合成）：不做任何清理，
        // 后续音频入队时会自动重新进入 SPEAKING 继续播放
        console.log(
          '[Playback Watcher] State left SPEAKING by natural drain, keeping pending synthesis.'
        )
        isNaturalDrain.value = false
        return
      }
      console.log('[Playback Watcher] State left SPEAKING, stopping playback.')
      stopPlaybackAndClearQueue()
    }
  })

  // 任何一次真正的停止（代次自增）都会重置调度状态
  watch(playbackEpoch, () => {
    isProcessingQueue.value = false
  })

  const toggleTTSPreference = () => {
    const newState = !isTTSEnabled.value
    isTTSEnabled.value = newState
    console.log(`TTS preference toggled via UI: ${newState}`)

    if (!newState) {
      if (audioState.value === 'SPEAKING') {
        console.log('TTS disabled while speaking - stopping playback.')
        stopPlaybackAndClearQueue()
        setAudioState(isRecordingRequested.value ? 'LISTENING' : 'IDLE')
      } else if (audioQueue.value.length > 0) {
        console.log('TTS disabled - clearing pending audio queue.')
        audioQueue.value = []
      }
    }
  }

  const initiatePlaybackIfNeeded = () => {
    if (
      audioState.value !== 'SPEAKING' &&
      !isProcessingQueue.value &&
      audioQueue.value.length > 0 &&
      isTTSEnabled.value
    ) {
      console.log(
        '[Playback Initiator] Queue has items and mic is on, setting state to SPEAKING.'
      )
      setAudioState('SPEAKING')
    }
  }

  watch(
    () => audioQueue.value.length,
    (newLength, oldLength) => {
      if (newLength > oldLength) {
        initiatePlaybackIfNeeded()
      }
    }
  )

  onUnmounted(() => {
    console.log('[Audio Playback] Component unmounted, ensuring cleanup.')
    stopPlaybackAndClearQueue()
  })

  return {
    toggleTTSPreference,
  }
}
