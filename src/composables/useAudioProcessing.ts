import { ref, watch, onUnmounted, onMounted } from 'vue'
import * as vad from '@ricky0123/vad-web'
import { float32ArrayToWav } from '../utils/audioProcess'
import { createVadOptions } from './vadRuntime'
import { useGeneralStore } from '../stores/generalStore'
import { useConversationStore } from '../stores/conversationStore'
import { useSettingsStore } from '../stores/settingsStore'
import { storeToRefs } from 'pinia'
import eventBus from '../utils/eventBus'
import {
  isLikelyMeaningfulSpeech,
  isMeaninglessFiller,
} from '../utils/bargeInHeuristics'
import type { ChatMessage } from '../types/chat'

let ipcListenersRegistered = false

export function useAudioProcessing() {
  const generalStore = useGeneralStore()
  const conversationStore = useConversationStore()
  const settingsStore = useSettingsStore()

  const {
    audioState,
    isRecordingRequested,
    awaitingWakeWord,
    wakeWordDetected,
  } = storeToRefs(generalStore)
  const { setAudioState } = generalStore

  const myvad = ref<vad.MicVAD | null>(null)
  const isVadInitializing = ref(false)
  const isSpeechDetected = ref(false)
  const vadAssetBasePath = ref<string>('./')
  // 播放期间听到持续语音后进入“待判定”状态：先压低音量继续播放，
  // 等转写结果出来再决定是恢复音量还是真正接管。
  const isBargeInPending = ref(false)
  let ownsIpcListeners = false

  // 打断灵敏度与回声保护相关常量（可按真机体感微调）
  const LISTENING_SPEECH_THRESHOLD = 0.65 // 平时（未播放时）的语音判定阈值
  const SPEAKING_SPEECH_THRESHOLD = 0.75 // 播放期间略严一点，但仍要能听清真人
  const TURN_START_ECHO_GUARD_MS = 700 // 新一轮播放开始后的回声保护窗口
  const FIRST_PLAYBACK_ECHO_GUARD_MS = 1500 // 应用启动后首次播放：AEC 尚未收敛
  const DUCKED_VOLUME = 0.35 // 待判定期间把 TTS 音量压低到 35%
  // 用户持续说话超过这个时长就先暂停 TTS，不再等语音结束、更不等转写
  const BARGE_IN_WATCHDOG_MS = 500
  const SPEAKING_REDEMPTION_MS = 350 // 播放期间快速收句
  const LISTENING_REDEMPTION_MS = 1000 // 普通对话：别把一句话切成两段
  let playbackStartedAt = 0
  let isFirstPlaybackAfterStart = true
  let volumeBeforeDuck = 1
  let bargeInWatchdog: ReturnType<typeof setTimeout> | null = null
  let bargeInOnsetAt = 0
  let isBargeInPaused = false

  // 播放期间提高 VAD 阈值并在播放期快速收句，防止被自己的声音打断
  const applyVadThresholdForState = (state: string) => {
    if (!myvad.value) return
    myvad.value.setOptions({
      positiveSpeechThreshold:
        state === 'SPEAKING'
          ? SPEAKING_SPEECH_THRESHOLD
          : LISTENING_SPEECH_THRESHOLD,
      // vad-web 在判定"语音结束"时才读取这个值，所以按状态切换是生效的
      redemptionMs:
        state === 'SPEAKING'
          ? SPEAKING_REDEMPTION_MS
          : LISTENING_REDEMPTION_MS,
    })
  }

  const clearBargeInWatchdog = () => {
    if (bargeInWatchdog) {
      clearTimeout(bargeInWatchdog)
      bargeInWatchdog = null
    }
  }

  // 是否处于回声保护窗口内（播放刚开始时，回声消除尚未收敛，忽略打断）
  const isWithinEchoGuard = (): boolean => {
    if (audioState.value !== 'SPEAKING') return false
    const guardMs = isFirstPlaybackAfterStart
      ? FIRST_PLAYBACK_ECHO_GUARD_MS
      : TURN_START_ECHO_GUARD_MS
    return Date.now() - playbackStartedAt < guardMs
  }

  // 提取消息里的纯文本（用于和 TTS 文本做回声比对）
  const extractTextFromChatMessage = (message: ChatMessage): string => {
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      return message.content
        .filter(part => part.type === 'app_text' && part.text)
        .map(part => part.text as string)
        .join(' ')
    }
    return ''
  }

  // 最近一条助手回复的文本：TTS 正在朗读的通常就是它
  const getLastAssistantText = (): string => {
    for (let i = generalStore.chatHistory.length - 1; i >= 0; i -= 1) {
      const message = generalStore.chatHistory[i] as ChatMessage
      if (message.role !== 'assistant') continue
      const text = extractTextFromChatMessage(message).trim()
      if (text) return text
    }
    return ''
  }

  // 压低 TTS 音量（不暂停、不丢队列），让“打断判定”期间仍有自然感
  const duckPlayback = () => {
    const player = generalStore.audioPlayer
    if (!player) return
    volumeBeforeDuck = player.volume
    player.volume = Math.min(volumeBeforeDuck, DUCKED_VOLUME)
  }

  const restorePlaybackVolume = () => {
    const player = generalStore.audioPlayer
    if (player) player.volume = volumeBeforeDuck
  }

  /**
   * 看门狗到点：用户已经连续说了 500ms，直接把 TTS 暂停。
   * 只 pause，不动 audioState / playbackEpoch / 队列 —— 万一是咳嗽或回声，
   * 还能原地恢复播放，回答不会丢。
   */
  const pausePlaybackForJudgement = () => {
    const player = generalStore.audioPlayer
    if (!player || isBargeInPaused) return
    try {
      player.pause()
      isBargeInPaused = true
      generalStore.statusMessage = '听到你说话了…'
      console.log(
        `[Barge-In] TTS paused after ${Date.now() - bargeInOnsetAt}ms of speech`
      )
    } catch (error) {
      console.warn('[Barge-In] 暂停播放失败:', error)
    }
  }

  /** 判定为噪音/回声：把刚才暂停的播放原地恢复 */
  const resumePlaybackForJudgement = () => {
    const player = generalStore.audioPlayer
    if (!player || !isBargeInPaused) return
    isBargeInPaused = false
    void player.play().catch(error => {
      console.warn('[Barge-In] 恢复播放失败:', error)
    })
    console.log('[Barge-In] Playback resumed (utterance judged as noise/echo).')
  }

  /**
   * 播放期间收到一段语音后的处理：
   * - 语气词 / 自声回声 / 空转写 → 恢复音量，继续播放
   * - 明确指令或真实用户语音 → 停止原回答，接管对话
   */
  const handleBargeInUtterance = async (audio: Float32Array) => {
    const spokenText = getLastAssistantText()
    clearBargeInWatchdog()

    const giveUpAndResume = () => {
      isBargeInPending.value = false
      isSpeechDetected.value = false
      restorePlaybackVolume()
      resumePlaybackForJudgement()
    }

    try {
      if (!audio || audio.length === 0) {
        giveUpAndResume()
        return
      }

      const wavBuffer = float32ArrayToWav(audio, 16000)
      const rawTranscription =
        await conversationStore.transcribeAudioMessage(wavBuffer)
      const transcription = (rawTranscription || '').trim()

      if (!isLikelyMeaningfulSpeech(transcription, spokenText)) {
        console.log(
          `[Barge-In] Ignoring noise/echo: "${transcription.slice(0, 60)}"`
        )
        if (isMeaninglessFiller(transcription)) {
          console.log('[Barge-In] Utterance classified as filler.')
        }
        giveUpAndResume()
        return
      }

      console.log(
        `[Barge-In] Real user speech detected, taking over: "${transcription.slice(0, 80)}"`
      )
      isBargeInPending.value = false
      isSpeechDetected.value = false
      isBargeInPaused = false
      restorePlaybackVolume()
      eventBus.emit('cancel-llm-stream')
      generalStore.stopPlaybackAndClearQueue()
      setAudioState('PROCESSING_AUDIO')
      generalStore.recognizedText = transcription
      eventBus.emit('processing-complete', transcription)
    } catch (error) {
      console.error(
        '[Barge-In] Failed to process interruption; restoring playback:',
        error
      )
      giveUpAndResume()
    }
  }

  const handleGlobalMicToggle = () => {
    toggleRecordingRequest()
  }

  const handleGlobalMutePlayback = () => {
    eventBus.emit('mute-playback-toggle')
  }

  const handleGlobalTakeScreenshot = () => {
    eventBus.emit('take-screenshot')
  }

  onMounted(async () => {
    if (
      window.location.protocol === 'file:' &&
      window.electronPaths?.getRendererDistPath
    ) {
      try {
        const rendererDistPath =
          await window.electronPaths.getRendererDistPath()
        let fileUrlPath = rendererDistPath.replace(/\\/g, '/')
        if (fileUrlPath.match(/^[A-Za-z]:\//)) {
          fileUrlPath = `/${fileUrlPath}`
        }
        vadAssetBasePath.value = `file://${fileUrlPath}/`
        console.log(
          '[VAD Asset Path] Electron production, IPC derived base path:',
          vadAssetBasePath.value
        )
      } catch (error) {
        console.error(
          'Failed to get rendererDistPath via IPC. Falling back.',
          error
        )
        let path = window.location.href
        path = path.split('#')[0]
        path = path.substring(0, path.lastIndexOf('/') + 1)
        vadAssetBasePath.value = path
        console.warn(
          '[VAD Asset Path] IPC failed, fallback to href derived path:',
          vadAssetBasePath.value
        )
      }
    } else if (window.location.protocol === 'file:') {
      console.warn(
        '[VAD Asset Path] Electron production, but electronPaths API not found. Using relative path "./". This might fail.'
      )
      vadAssetBasePath.value = './'
    } else {
      console.log(
        '[VAD Asset Path] Development/Web, using relative base path "./"'
      )
      vadAssetBasePath.value = './'
    }
    if (window.aliceIPC && !ipcListenersRegistered) {
      window.aliceIPC.on('global-hotkey-mic-toggle', handleGlobalMicToggle)
      window.aliceIPC.on(
        'global-hotkey-mute-playback',
        handleGlobalMutePlayback
      )
      window.aliceIPC.on(
        'global-hotkey-take-screenshot',
        handleGlobalTakeScreenshot
      )
      ipcListenersRegistered = true
      ownsIpcListeners = true
    }
  })

  const initializeVAD = async () => {
    if (myvad.value || isVadInitializing.value) {
      console.log('VAD init skipped: Already initialized or initializing.')
      return
    }
    if (
      vadAssetBasePath.value === './' &&
      window.location.protocol === 'file:'
    ) {
      console.warn(
        '[VAD Manager] Attempting to initialize VAD, but asset path might not be fully resolved yet. Waiting briefly...'
      )
      await new Promise(resolve => setTimeout(resolve, 200))
      if (vadAssetBasePath.value === './') {
        console.error(
          "[VAD Manager] CRITICAL: VAD asset path still './' in file protocol after delay. VAD will likely fail."
        )
      }
    }

    console.log('[VAD Manager] Initializing VAD...')
    isVadInitializing.value = true
    isSpeechDetected.value = false

    await destroyVAD()

    try {
      const assetPath = vadAssetBasePath.value
      console.log(
        `[VAD Manager] Attempting to load VAD with baseAssetPath: ${assetPath}`
      )

      const vadInstance = await vad.MicVAD.new(
        createVadOptions(assetPath, {
          onSpeechStart: () => {
            isSpeechDetected.value = true
            console.log('[VAD Callback] Speech started.')
          },
          // 只在“持续语音”达到 minSpeechMs 后才认定为打断：
          // 咳嗽、键盘声、短促噪音等不会走到这里。
          onSpeechRealStart: () => {
            if (isBargeInPending.value) return

            // 正在等待模型回复（还没有 TTS 可打断）：取消思考，让用户重新说
            if (audioState.value === 'WAITING_FOR_RESPONSE') {
              console.log(
                '[Barge-In] User speech while waiting for response; cancelling LLM stream.'
              )
              eventBus.emit('cancel-llm-stream')
              setAudioState(
                isRecordingRequested.value ? 'LISTENING' : 'IDLE'
              )
              return
            }

            if (audioState.value !== 'SPEAKING') return
            if (isWithinEchoGuard()) {
              console.log(
                '[Barge-In] Ignored utterance within echo guard window (self voice).'
              )
              return
            }

            // 先压低 TTS 音量继续播放，避免“突然暂停”的机器人感；
            // 等转写结果出来再决定恢复音量还是接管。
            isBargeInPending.value = true
            duckPlayback()
            bargeInOnsetAt = Date.now()
            clearBargeInWatchdog()
            // 关键提速：不等这段语音结束、更不等转写；只要用户连续说满
            // BARGE_IN_WATCHDOG_MS 就直接把 TTS 暂停（可恢复）
            bargeInWatchdog = setTimeout(() => {
              bargeInWatchdog = null
              if (!isBargeInPending.value) return
              if (audioState.value !== 'SPEAKING') return
              pausePlaybackForJudgement()
            }, BARGE_IN_WATCHDOG_MS)
            console.log(
              '[Barge-In] Speech during playback detected; ducking TTS for judgement.'
            )
          },
          onSpeechEnd: (audio: Float32Array) => {
            console.log(
              `[VAD Callback] Speech ended. Audio length: ${audio?.length}. Current state: ${audioState.value}`
            )
            if (isBargeInPending.value) {
              clearBargeInWatchdog()
              void handleBargeInUtterance(audio)
              return
            }
            if (audioState.value === 'LISTENING' && isSpeechDetected.value) {
              processAudioRecording(audio)
            } else {
              console.log(
                '[VAD Callback] Speech ended, but not processing (state changed or no speech detected).'
              )
              isSpeechDetected.value = false
            }
          },
        })
      )

      if (!isRecordingRequested.value) {
        console.log(
          '[VAD Manager] Recording was disabled during initialization; destroying the unused VAD instance.'
        )
        await vadInstance.destroy()
        return
      }

      myvad.value = vadInstance
      await myvad.value.start()
      // 新建的麦克风流意味着回声消除又要重新收敛，首次播放需要更长的保护窗口
      isFirstPlaybackAfterStart = true
      applyVadThresholdForState(audioState.value)
      console.log('[VAD Manager] VAD initialized and started successfully.')
    } catch (error) {
      console.error('[VAD Manager] VAD initialization failed:', error)
      await destroyVAD()
      setAudioState('IDLE')
      generalStore.statusMessage = 'Error: Mic/VAD init failed'
      isSpeechDetected.value = false
    } finally {
      isVadInitializing.value = false
    }
  }

  const destroyVAD = async () => {
    if (!myvad.value) {
      return
    }
    clearBargeInWatchdog()
    isBargeInPaused = false
    console.log('[VAD Manager] Destroying VAD instance...')
    const vadInstance = myvad.value
    myvad.value = null
    try {
      await vadInstance.destroy()
      console.log('[VAD Manager] VAD destroyed.')
    } catch (error) {
      console.error('[VAD Manager] Error destroying VAD:', error)
    } finally {
      isSpeechDetected.value = false
      console.log('[VAD Manager] VAD instance reference removed.')
    }
  }

  const checkForWakeWord = (
    transcription: string
  ): { hasWakeWord: boolean; command: string } => {
    if (
      !settingsStore.config.localSttEnabled ||
      !settingsStore.config.localSttWakeWord ||
      settingsStore.config.sttProvider !== 'local'
    ) {
      return { hasWakeWord: true, command: transcription }
    }

    const wakeWord = settingsStore.config.localSttWakeWord.toLowerCase().trim()
    const text = transcription.toLowerCase().trim()

    if (!wakeWord) {
      return { hasWakeWord: true, command: transcription }
    }

    const patterns = [`hey ${wakeWord}`, `ok ${wakeWord}`, `${wakeWord}`]

    for (const pattern of patterns) {
      const index = text.indexOf(pattern)
      if (index !== -1) {
        const afterWakeWord = transcription.slice(index + pattern.length).trim()
        const command = afterWakeWord.replace(/^[,.\s]+/, '').trim()

        return {
          hasWakeWord: true,
          command: command || transcription,
        }
      }
    }

    return { hasWakeWord: false, command: transcription }
  }

  const processAudioRecording = async (audio: Float32Array) => {
    if (audioState.value !== 'LISTENING' || !audio || audio.length === 0) {
      console.warn(
        '[Audio Processing] Processing aborted (invalid state or no audio).'
      )
      isSpeechDetected.value = false
      return
    }

    setAudioState('PROCESSING_AUDIO')

    try {
      const wavBuffer = float32ArrayToWav(audio, 16000)
      const transcription =
        await conversationStore.transcribeAudioMessage(wavBuffer)

      if (transcription && transcription.trim()) {
        if (
          settingsStore.config.localSttEnabled &&
          settingsStore.config.sttProvider === 'local'
        ) {
          const { hasWakeWord, command } = checkForWakeWord(transcription)

          if (hasWakeWord) {
            generalStore.recognizedText = command
            eventBus.emit('processing-complete', command)
          } else {
            console.log(
              '[Audio Processing] Wake word not detected, continuing to listen'
            )
            setAudioState(isRecordingRequested.value ? 'LISTENING' : 'IDLE')
            isSpeechDetected.value = false
          }
        } else {
          generalStore.recognizedText = transcription
          eventBus.emit('processing-complete', transcription)
        }
      } else {
        if (isBargeInPending.value) {
          restorePlaybackVolume()
          isBargeInPending.value = false
        }
        setAudioState(isRecordingRequested.value ? 'LISTENING' : 'IDLE')
        isSpeechDetected.value = false
      }
    } catch (error) {
      console.error('[Audio Processing] Error during transcription:', error)
      generalStore.statusMessage = 'Error: Transcription failed'
      if (isBargeInPending.value) {
        restorePlaybackVolume()
        isBargeInPending.value = false
      }
      setAudioState(isRecordingRequested.value ? 'LISTENING' : 'IDLE')
      isSpeechDetected.value = false
    }
  }

  // 播放状态变化时：动态调整 VAD 阈值并记录本轮播放的起始时间（回声保护用）
  // 任何一次真正的停止（playbackEpoch 自增：点停止、取消本轮、换会话）
  // 都要复位打断标记，否则 isBargeInPaused 卡在 true 会让后续打断静默失效
  watch(
    () => generalStore.playbackEpoch,
    () => {
      isBargeInPaused = false
      clearBargeInWatchdog()
    }
  )

  watch(audioState, (newState, oldState) => {
    if (newState === 'SPEAKING') {
      playbackStartedAt = Date.now()
    } else if (oldState === 'SPEAKING') {
      isFirstPlaybackAfterStart = false
      // 离开播放态：这次打断判定结束，别让看门狗再触发
      clearBargeInWatchdog()
      isBargeInPaused = false
    }
    applyVadThresholdForState(newState)
  })

  watch(isRecordingRequested, isRequested => {
    console.log(
      `[VAD Lifecycle] Mic request changed to: ${isRequested}. Current state: ${audioState.value}`
    )
    if (isRequested) {
      if (!myvad.value && !isVadInitializing.value) {
        initializeVAD()
      }
      if (audioState.value === 'IDLE' || audioState.value === 'CONFIG') {
        setAudioState('LISTENING')
        if (
          settingsStore.config.localSttEnabled &&
          settingsStore.config.sttProvider === 'local'
        ) {
          awaitingWakeWord.value = true
          wakeWordDetected.value = false
        } else {
          awaitingWakeWord.value = false
          wakeWordDetected.value = false
        }
      }
    } else {
      clearBargeInWatchdog()
      isBargeInPaused = false
      destroyVAD()
      if (audioState.value === 'LISTENING') {
        setAudioState('IDLE')
      }

      awaitingWakeWord.value = false
      wakeWordDetected.value = false
    }
  })

  const toggleRecordingRequest = () => {
    isRecordingRequested.value = !isRecordingRequested.value
    console.log(
      `Recording request toggled via UI: ${isRecordingRequested.value}`
    )
  }

  onUnmounted(() => {
    clearBargeInWatchdog()
    isBargeInPaused = false
    if (isBargeInPending.value) {
      restorePlaybackVolume()
      isBargeInPending.value = false
    }
    destroyVAD()
    if (window.aliceIPC && ownsIpcListeners) {
      window.aliceIPC.off('global-hotkey-mic-toggle', handleGlobalMicToggle)
      window.aliceIPC.off(
        'global-hotkey-mute-playback',
        handleGlobalMutePlayback
      )
      window.aliceIPC.off(
        'global-hotkey-take-screenshot',
        handleGlobalTakeScreenshot
      )
      ipcListenersRegistered = false
      ownsIpcListeners = false
    }
  })

  return {
    toggleRecordingRequest,
  }
}
