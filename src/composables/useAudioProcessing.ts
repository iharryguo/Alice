import { ref, watch, onUnmounted, onMounted } from 'vue'
import * as vad from '@ricky0123/vad-web'
import { float32ArrayToWav } from '../utils/audioProcess'
import { createVadOptions } from './vadRuntime'
import { useGeneralStore } from '../stores/generalStore'
import { useConversationStore } from '../stores/conversationStore'
import { useSettingsStore } from '../stores/settingsStore'
import { storeToRefs } from 'pinia'
import eventBus from '../utils/eventBus'
import { logEvent } from '../utils/logger'
import {
  isLikelyMeaningfulSpeech,
  isMeaninglessFiller,
} from '../utils/bargeInHeuristics'
import {
  DEFAULT_VOICE_NAME_PAUSE_MS,
  decideTurnEnd,
  findPersonaName,
  mergeTurnFragments,
} from '../utils/voiceTurnGate'
import { getPersona } from '../prompts/personas'
import type { ChatMessage } from '../types/chat'

let ipcListenersRegistered = false

export function useAudioProcessing() {
  const generalStore = useGeneralStore()
  const conversationStore = useConversationStore()
  const settingsStore = useSettingsStore()

  /**
   * 语音分段的合并窗口。
   *
   * VAD 遇到短停就会切一段，一段长回答会被切成三四段。以前后几段在
   * "上一段还在转写"时被直接丢掉，表现就是"我说了一大段英语，完全没识别"。
   * 现在先把相邻片段攒起来，静默 800ms 再合并成一次转写。
   */
  let pendingSegments: Float32Array[] = []
  let mergeTimer: ReturnType<typeof setTimeout> | null = null
  /** 转写串行执行，避免两段同时打后端互相踩 */
  let transcriptionChain: Promise<void> = Promise.resolve()

  function concatAudio(chunks: Float32Array[]): Float32Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const merged = new Float32Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    return merged
  }

  function enqueueSpeechSegment(audio: Float32Array): void {
    if (!audio?.length) return
    pendingSegments.push(audio)
    if (mergeTimer) clearTimeout(mergeTimer)
    mergeTimer = setTimeout(() => {
      mergeTimer = null
      const merged = concatAudio(pendingSegments)
      pendingSegments = []
      if (!merged.length) return
      logEvent('audio', 'stt.segment', { samples: merged.length })
      transcriptionChain = transcriptionChain
        .then(() => processAudioRecording(merged))
        .catch(error => console.warn('[Audio Processing] 转写队列失败:', error))
    }, 800)
  }

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
  // 单轮最多攒这么多片段：约 80 秒语音，防跑飞和上下文爆掉
  const VOICE_TURN_MAX_FRAGMENTS = 40

  // ── 按人格名结束说话：本轮状态 ─────────────────────────────────────
  // 一轮 = 从开口到发送之间的所有转写片段。2 秒收句必然把一句话切成几片，
  // 所以只累积不发送，等"叫了名字"或"兜底静默到点"再一次性发出去。
  let voiceTurnFragments: string[] = []
  let voiceTurnSawName = false
  /** 每轮自增：在途转写回来时序号对不上就丢弃，避免旧结果污染新一轮 */
  let voiceTurnSeq = 0
  let voiceTurnFallbackTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 用户真正停嘴的时刻（估算）。VAD 要等 redemptionMs 才算"说完"，
   * 所以 onSpeechEnd 时其实早就静了这么久，这里先减掉，后面算静音时长才准。
   */
  let voiceTurnSpeechEndedAt = 0
  /** 防重入：兜底计时器和转写返回可能同时到点 */
  let isVoiceTurnSending = false
  /** 兜底到点时还有音频在路上：等它回来再发，且只发一次 */
  let pendingTurnFlush = false
  /** 在途转写数量：判断"是不是还有一段没回来" */
  let inFlightTranscriptions = 0

  const voiceGateEnabled = () =>
    settingsStore.config.voiceNameTurnGateEnabled !== false

  /** 叫名字后的停顿：低于 800ms 会把一句话拦腰截断，按默认值兜住 */
  const voiceNamePauseMs = () => {
    const configured = Number(settingsStore.config.voiceNamePauseMs)
    return Number.isFinite(configured) && configured >= 800
      ? configured
      : DEFAULT_VOICE_NAME_PAUSE_MS
  }

  /** 没叫名字时的兜底静默（原来是"说完停顿判定"） */
  const fallbackSilenceMs = () => {
    const configured = Number(settingsStore.config.voiceSilenceMs)
    return Number.isFinite(configured) && configured >= 300 ? configured : 10000
  }

  /**
   * LISTENING 下 VAD 的收句窗口。
   * - gate 关闭：等于兜底静默，行为与改造前完全一致（回滚开关）
   * - 已叫过名字：用短窗口，叫完名字停一下就发
   * - 还没叫名字：前 3 片仍用短窗口（"嗯…Felix"这种开头还能抓到），
   *   之后放宽到兜底静默，免得一段长独白被切成五六段去反复转写
   */
  const currentListeningRedemptionMs = () => {
    if (!voiceGateEnabled()) return fallbackSilenceMs()
    if (voiceTurnSawName) return voiceNamePauseMs()
    if (voiceTurnFragments.length < 3) return voiceNamePauseMs()
    return fallbackSilenceMs()
  }

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
          : currentListeningRedemptionMs(),
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

      logEvent('audio', 'bargein.transcribed', {
        transcription,
        spokenTextLen: spokenText.length,
      })

      if (!isLikelyMeaningfulSpeech(transcription, spokenText)) {
        console.log(
          `[Barge-In] Ignoring noise/echo: "${transcription.slice(0, 60)}"`
        )
        logEvent('audio', 'bargein.ignored', {
          reason: 'noise-or-echo',
          transcription,
        })
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
      // 接管成功就是新一轮对话：上一轮没发出去的累积必须丢掉
      resetVoiceTurn('barge-in-takeover')
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
    logEvent('audio', 'vad.init.start', { assetPath: vadAssetBasePath.value })
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
            // 用户又开口了：兜底不能按上一段停嘴的时间继续算
            clearVoiceTurnTimer()
            console.log('[VAD Callback] Speech started.')
            eventBus.emit('user-speech-start')
            logEvent('audio', 'vad.speech.start', {
              audioState: audioState.value,
              recording: isRecordingRequested.value,
            })
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
              setAudioState(isRecordingRequested.value ? 'LISTENING' : 'IDLE')
              return
            }

            if (audioState.value !== 'SPEAKING') return
            if (isWithinEchoGuard()) {
              console.log(
                '[Barge-In] Ignored utterance within echo guard window (self voice).'
              )
              return
            }

            logEvent('audio', 'bargein.detected', {
              audioState: audioState.value,
            })
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
            logEvent('audio', 'vad.speech.end', {
              samples: audio?.length ?? 0,
              audioState: audioState.value,
              recording: isRecordingRequested.value,
              bargeInPending: isBargeInPending.value,
            })
            if (isBargeInPending.value) {
              clearBargeInWatchdog()
              void handleBargeInUtterance(audio)
              return
            }
            // 记下"真正停嘴"的时刻：VAD 已经等掉了当前窗口的静音，先补回去
            const gatedTurn =
              voiceGateEnabled() && audioState.value === 'LISTENING'
            if (gatedTurn) {
              voiceTurnSpeechEndedAt =
                Date.now() - currentListeningRedemptionMs()
            }
            // 以前只有 LISTENING 时才收，上一段还在转写时说的话会被整段丢掉。
            // 现在一律入队，由转写队列串行处理。
            if (audio?.length) {
              enqueueSpeechSegment(audio)
            } else {
              isSpeechDetected.value = false
            }
            // 兜底从"最后一次语音结束"起算，而不是等转写返回才起算：
            // 否则 STT 的那 0.5~2 秒会白白加在用户等待上
            if (gatedTurn) armVoiceTurnFallback()
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
      logEvent('audio', 'vad.started', {
        audioState: audioState.value,
        recording: isRecordingRequested.value,
      })
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
    clearVoiceTurnTimer()
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

  /** 这一轮还有音频没走完（还在合并窗口里，或正在转写）：此时发送会漏掉后半句 */
  const isTurnAudioPending = () =>
    inFlightTranscriptions > 0 ||
    pendingSegments.length > 0 ||
    mergeTimer !== null

  const clearVoiceTurnTimer = () => {
    if (voiceTurnFallbackTimer) {
      clearTimeout(voiceTurnFallbackTimer)
      voiceTurnFallbackTimer = null
    }
  }

  /**
   * 挂上兜底计时器：从"最后一次真正停嘴"起算。
   * 已经叫过名字的轮次按名字停顿算，没叫过的才等兜底静默。
   * 减掉 VAD 已经等掉的那段静音，否则实际会等成目标值 + 2 秒。
   */
  const armVoiceTurnFallback = () => {
    if (!voiceGateEnabled()) return
    if (!isTurnAudioPending() && !voiceTurnFragments.length) return
    clearVoiceTurnTimer()
    const elapsed = Date.now() - voiceTurnSpeechEndedAt
    const target = voiceTurnSawName ? voiceNamePauseMs() : fallbackSilenceMs()
    const delay = Math.max(200, target - elapsed)
    voiceTurnFallbackTimer = setTimeout(() => {
      voiceTurnFallbackTimer = null
      flushVoiceTurn(
        voiceTurnSeq,
        voiceTurnSawName ? 'name-hit' : 'fallback-silence'
      )
    }, delay)
  }

  /** 丢掉本轮累积。任何"这一轮不该再发出去"的时刻都要调它 */
  const resetVoiceTurn = (reason: string) => {
    clearVoiceTurnTimer()
    if (voiceTurnFragments.length || voiceTurnSawName) {
      logEvent('audio', 'voice.turn.reset', {
        reason,
        fragments: voiceTurnFragments.length,
        sawName: voiceTurnSawName,
      })
    }
    voiceTurnSeq += 1
    voiceTurnFragments = []
    voiceTurnSawName = false
    isVoiceTurnSending = false
    pendingTurnFlush = false
    // 窗口回到"本轮开头"的短值，下一句话仍能靠名字 2 秒收句
    applyVadThresholdForState(audioState.value)
  }

  /**
   * 尝试收本轮。三道闸分别对应三种"重复发送"来源：
   * 过期轮次（旧转写晚到）、重入（计时器与转写同时到点）、音频未走完（会漏半句）。
   */
  const flushVoiceTurn = (seq: number, reason: string) => {
    if (seq !== voiceTurnSeq) return
    if (isVoiceTurnSending) return
    if (isTurnAudioPending()) {
      pendingTurnFlush = true
      return
    }

    const persona = getPersona(settingsStore.config.assistantPersonaId)
    const decision = decideTurnEnd({
      fragments: voiceTurnFragments,
      personaHit: voiceTurnSawName,
      silenceMs: Date.now() - voiceTurnSpeechEndedAt,
      personaId: persona.id,
      personaDisplayName: persona.displayName,
      namePauseMs: voiceNamePauseMs(),
      fallbackSilenceMs: fallbackSilenceMs(),
    })

    if (decision.action === 'wait') {
      // 被挂起的兜底先到点、但静音还不够：重新挂上计时器，别把这条线断掉
      if (pendingTurnFlush) {
        pendingTurnFlush = false
        armVoiceTurnFallback()
      }
      return
    }

    pendingTurnFlush = false

    if (decision.action === 'ignore') {
      resetVoiceTurn(`ignore-${decision.reason}`)
      return
    }

    const text = decision.text.trim()
    if (!text) {
      resetVoiceTurn('empty-turn')
      return
    }

    // 先清空本轮再发送：Main.vue 也接受 LISTENING 下的转写，
    // 残留片段被二次 flush 就会重复发一条消息。
    isVoiceTurnSending = true
    voiceTurnSeq += 1
    voiceTurnFragments = []
    voiceTurnSawName = false
    clearVoiceTurnTimer()

    logEvent('audio', 'voice.turn.send', {
      reason,
      decision: decision.reason,
      length: text.length,
    })
    // Main.vue 只认 PROCESSING_AUDIO / LISTENING，其他状态下会被静默丢弃
    if (audioState.value !== 'SPEAKING') setAudioState('PROCESSING_AUDIO')
    generalStore.recognizedText = text
    eventBus.emit('processing-complete', text)
    isVoiceTurnSending = false
    applyVadThresholdForState(audioState.value)
  }

  /**
   * gate 模式下的片段处理：只累积，命中名字或兜底到点才发送。
   * 不在这里改 audioState —— 每 2 秒切一次 PROCESSING_AUDIO 会让头像和状态文案乱闪。
   */
  const handleGatedTranscript = (text: string, turnSeq: number) => {
    isSpeechDetected.value = false

    if (audioState.value !== 'LISTENING') {
      // 播放中是打断的独立快路径，等待回复时也不该攒；对齐旧行为直接丢
      logEvent('audio', 'voice.turn.dropped', { audioState: audioState.value })
      return
    }
    if (!text) {
      // 空转写（极短片段、纯语气词）不清累积：那只是同一句话的中间停顿
      return
    }

    voiceTurnFragments.push(text)
    if (voiceTurnFragments.length > VOICE_TURN_MAX_FRAGMENTS) {
      voiceTurnFragments.shift()
    }

    const persona = getPersona(settingsStore.config.assistantPersonaId)
    const merged = mergeTurnFragments(voiceTurnFragments)
    const hit = findPersonaName(merged, persona.id, persona.displayName)
    if (!voiceTurnSawName && hit) {
      voiceTurnSawName = true
      // 命中后立刻把窗口收紧：后面的停顿才能被当成"说完了"
      applyVadThresholdForState(audioState.value)
    }
    logEvent('audio', 'voice.turn.fragment', {
      text: text.slice(0, 80),
      fragments: voiceTurnFragments.length,
      sawName: voiceTurnSawName,
      atStart: hit?.atStart ?? false,
    })

    if (voiceTurnSawName) {
      flushVoiceTurn(turnSeq, 'name-hit')
    } else if (pendingTurnFlush) {
      flushVoiceTurn(turnSeq, 'fallback-silence')
    }
  }

  const processAudioRecording = async (audio: Float32Array) => {
    if (!audio || audio.length === 0) {
      isSpeechDetected.value = false
      return
    }

    const gateOn = voiceGateEnabled()
    // 快照本轮序号：await 回来后对不上，说明这一轮已经结束，结果要丢掉
    const turnSeq = voiceTurnSeq

    // 播放中不要抢状态（打断路径另有处理），其余情况照常进入处理态。
    // gate 模式下不能每片都切 PROCESSING_AUDIO：那会让状态文案和头像一路闪，
    // 也会让 audioState watcher 反复触发，所以状态交给 flush 去改。
    if (!gateOn && audioState.value !== 'SPEAKING') {
      setAudioState('PROCESSING_AUDIO')
    }

    inFlightTranscriptions += 1
    try {
      const startedAt = Date.now()
      const wavBuffer = float32ArrayToWav(audio, 16000)
      const transcription =
        await conversationStore.transcribeAudioMessage(wavBuffer)
      logEvent('audio', 'stt.result', {
        ms: Date.now() - startedAt,
        length: (transcription || '').length,
        text: transcription,
      })

      if (turnSeq !== voiceTurnSeq) {
        // 用户已经点停止、或这一轮已经发出去：这段是过期结果，不能再用
        console.log(
          '[Audio Processing] Dropping stale transcript (turn moved on)'
        )
        logEvent('audio', 'voice.turn.stale', {
          turnSeq,
          current: voiceTurnSeq,
        })
        return
      }

      const recognized = (transcription || '').trim()

      if (gateOn) {
        handleGatedTranscript(recognized, turnSeq)
      } else if (recognized) {
        if (
          settingsStore.config.localSttEnabled &&
          settingsStore.config.sttProvider === 'local'
        ) {
          const { hasWakeWord, command } = checkForWakeWord(recognized)

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
          generalStore.recognizedText = recognized
          eventBus.emit('processing-complete', recognized)
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
    } finally {
      inFlightTranscriptions -= 1
      // 兜底到点时这段还在路上：现在回来了，补一次收句（只发一次）
      if (
        voiceGateEnabled() &&
        pendingTurnFlush &&
        inFlightTranscriptions === 0 &&
        !isTurnAudioPending()
      ) {
        flushVoiceTurn(
          voiceTurnSeq,
          voiceTurnSawName ? 'name-hit' : 'fallback-silence'
        )
      }
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
      // 点停止 / 取消本轮 / 切会话：攒着没发的话属于上一轮，不能留到下一轮
      resetVoiceTurn('playback-epoch')
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
    // 只有"这一轮确定结束了"的状态才清累积。
    // PROCESSING_AUDIO 绝不能清：flush 自己刚把状态置成它，清了就等于自己踩自己。
    if (
      newState === 'SPEAKING' ||
      newState === 'WAITING_FOR_RESPONSE' ||
      newState === 'IDLE' ||
      newState === 'CONFIG'
    ) {
      resetVoiceTurn(`state-${newState}`)
      return
    }
    applyVadThresholdForState(newState)
  })

  // 改设置要立刻生效：以前只靠 audioState 变化才下发 VAD 选项，
  // 所以"改了收句时长却没反应"一直存在（顺手修掉）。
  watch(
    () => [
      settingsStore.config.voiceSilenceMs,
      settingsStore.config.voiceNamePauseMs,
    ],
    () => applyVadThresholdForState(audioState.value)
  )

  watch(
    () => settingsStore.config.voiceNameTurnGateEnabled,
    () => resetVoiceTurn('gate-changed')
  )

  watch(
    () => settingsStore.config.assistantPersonaId,
    () => {
      // 别名表跟着人格变：切人格瞬间攒的旧文本不该按旧人格判定
      resetVoiceTurn('persona-changed')
    }
  )

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
      // 关麦：本轮攒的片段不能再留着，否则重开麦会把旧话发出去
      resetVoiceTurn('mic-off')
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
    clearVoiceTurnTimer()
    // 卸载就彻底丢掉，别让计时器在别的会话里把旧话发出去
    voiceTurnFragments = []
    voiceTurnSawName = false
    pendingTurnFlush = false
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
