import { computed, ref, watch } from 'vue'
import type { WindowState } from '../utils/windowStates'
import { defineStore } from 'pinia'
import eventBus from '../utils/eventBus'
import { isExpectedAbortError } from '../utils/isAbortError'
import type { ChatMessage } from '../types/chat'
import { createHistoryManager } from '../modules/conversation/historyManager'
import { useCustomAvatarsStore } from './customAvatarsStore'

export type AudioState =
  | 'IDLE'
  | 'LISTENING'
  | 'PROCESSING_AUDIO'
  | 'WAITING_FOR_RESPONSE'
  | 'SPEAKING'
  | 'CONFIG'
  | 'GENERATING_IMAGE'

export interface ScreenshotRecord {
  dataUrl: string
  savedPath: string
  width: number
  height: number
  displayName: string
  question?: string
  capturedAt: number
}

const ENGLISH_MODE_STORAGE_KEY = 'alice:english-mode'

function loadEnglishMode(): boolean {
  try {
    return window.localStorage.getItem(ENGLISH_MODE_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export const useGeneralStore = defineStore('general', () => {
  const customAvatarsStore = useCustomAvatarsStore()
  const audioState = ref<AudioState>('IDLE')
  const isRecordingRequested = ref<boolean>(false)
  const isTTSEnabled = ref<boolean>(true)
  const englishMode = ref<boolean>(loadEnglishMode())
  // 窗口是否处于最大化：最大化时把头像区让出来，聊天面板铺满整屏
  const windowMaximized = ref<boolean>(false)
  // 窗口形态：avatar_ball = 只露圆形头像（无边框透明）；window = 原生带框窗口
  // mini_ball 不是独立 mode，它是 avatar_ball + isMiniBall=true（见 windowStates.ts）
  const windowMode = ref<'avatar_ball' | 'window'>('avatar_ball')
  const recognizedText = ref<string>('')
  const chatHistory = ref<ChatMessage[]>([])
  const historyManager = createHistoryManager(chatHistory)
  const {
    addMessageToHistory,
    updateMessageApiIdByTempId,
    appendMessageDeltaByTempId,
    addContentPartToMessageByTempId,
    updateImageContentPartByGenerationId,
    updateMessageContentByTempId,
    updateMessageApiResponseIdByTempId,
    addToolCallToMessageByTempId,
    updateMessageToolCallsByTempId,
  } = historyManager
  const chatInput = ref<string>('')
  const statusMessage = ref<string>('Stand by')
  const openSidebar = ref<boolean>(false)
  // 迷你球（avatar 上迷你按钮点下去的状态），跟 Windows 的窗口最小化无关
  const isMiniBall = ref<boolean>(false)
  const takingScreenShot = ref<boolean>(false)
  const audioPlayer = ref<HTMLAudioElement | null>(null)
  const aiVideo = ref<HTMLVideoElement | null>(null)
  const avatarFallbackImage = ref<string | null>(null)
  const mediaReadyStateThreshold =
    typeof HTMLMediaElement !== 'undefined'
      ? HTMLMediaElement.HAVE_CURRENT_DATA
      : 2
  const videoSource = ref<string>(
    customAvatarsStore.builtInAvatar.stateVideos.standby
  )
  const audioQueue = ref<Response[]>([])
  // 播放代次计数：每次真正停止/清空播放时自增。
  // 在途的 TTS 响应与已预约的播放回调通过比对代次识别自己已过期，从而
  // 修复"被打断后，在途 chunk 复活播放"的竞态问题。
  const playbackEpoch = ref(0)
  const sideBarView = ref<string>('chat')
  const attachedFile = ref<File | null>(null)
  const awaitingWakeWord = ref<boolean>(false)
  const wakeWordDetected = ref<boolean>(false)
  // 工具主动抓屏的临时图片队列：只在本轮对话内注入给模型，不写入聊天历史
  const pendingScreenshots = ref<string[]>([])
  // 最近一次截图（含缩略图），供工具卡片展示"它到底看到了什么"
  const lastScreenshot = ref<ScreenshotRecord | null>(null)
  // 按保存路径索引的截图记录，多屏/多次截图时工具卡片能各自取到自己的图
  const screenshotRecords = ref<Record<string, ScreenshotRecord>>({})

  const setAudioState = (newState: AudioState) => {
    if (audioState.value === newState) return
    audioState.value = newState
    switch (newState) {
      case 'IDLE':
        statusMessage.value = isRecordingRequested.value
          ? 'Mic Ready'
          : 'Stand by'
        break
      case 'LISTENING':
        statusMessage.value = awaitingWakeWord.value
          ? 'Waiting for wake word...'
          : 'Listening...'
        break
      case 'PROCESSING_AUDIO':
        statusMessage.value = 'Processing audio...'
        break
      case 'WAITING_FOR_RESPONSE':
        statusMessage.value = 'Thinking...'
        break
      case 'SPEAKING':
        statusMessage.value = 'Speaking...'
        break
      case 'CONFIG':
        statusMessage.value = 'Setting up...'
        break
      case 'GENERATING_IMAGE':
        statusMessage.value = 'Creating image...'
        break
      default:
        statusMessage.value = 'Unknown state'
        break
    }
  }

  const getVideoForState = (state: AudioState) => {
    const activeAvatar = customAvatarsStore.activeAvatar
    switch (state) {
      case 'SPEAKING':
        return activeAvatar.stateVideos.speaking
      case 'PROCESSING_AUDIO':
      case 'WAITING_FOR_RESPONSE':
      case 'GENERATING_IMAGE':
        return activeAvatar.stateVideos.thinking
      case 'CONFIG':
        return (
          activeAvatar.stateVideos.config ||
          customAvatarsStore.builtInAvatar.stateVideos.config ||
          activeAvatar.stateVideos.standby
        )
      case 'LISTENING':
      case 'IDLE':
      default:
        return activeAvatar.stateVideos.standby
    }
  }

  // Cache the current frame so the avatar circle never flashes empty between state swaps.
  const captureCurrentVideoFrame = (): string | null => {
    if (typeof document === 'undefined') return null
    if (!aiVideo.value) return null
    const videoEl = aiVideo.value
    const width = videoEl.videoWidth
    const height = videoEl.videoHeight
    if (!width || !height) return null

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null

    try {
      context.drawImage(videoEl, 0, 0, width, height)
      return canvas.toDataURL('image/jpeg', 0.85)
    } catch (error) {
      console.warn('Failed to capture avatar frame:', error)
      return null
    }
  }

  const updateAvatarFallbackImage = () => {
    const frame = captureCurrentVideoFrame()
    if (frame) {
      avatarFallbackImage.value = frame
    }
  }

  const syncVideoSource = (state: AudioState) => {
    const newSource = getVideoForState(state)
    if (!aiVideo.value) {
      videoSource.value = newSource
      return
    }
    if (videoSource.value !== newSource) {
      updateAvatarFallbackImage()
      videoSource.value = newSource
      aiVideo.value.load()
    }
    aiVideo.value.play().catch(error => {
      if (!isExpectedAbortError(error)) {
        console.warn('Video play failed:', error)
      }
    })
  }

  const handleVideoLoadedData = () => {
    updateAvatarFallbackImage()
  }

  watch(
    aiVideo,
    (newVideo, oldVideo) => {
      oldVideo?.removeEventListener('loadeddata', handleVideoLoadedData)
      if (newVideo) {
        newVideo.addEventListener('loadeddata', handleVideoLoadedData)
        if (newVideo.readyState >= mediaReadyStateThreshold) {
          updateAvatarFallbackImage()
        }
      }
    },
    { immediate: true }
  )

  watch(
    audioState,
    newState => {
      syncVideoSource(newState)
    },
    { immediate: true }
  )

  watch(
    () => customAvatarsStore.activeAvatarId,
    () => {
      syncVideoSource(audioState.value)
    }
  )

  customAvatarsStore.ensureInitialized().catch(error => {
    console.warn('Failed to initialize custom avatars store:', error)
  })

  const queueAudioForPlayback = (audioResponse: Response): boolean => {
    if (!isTTSEnabled.value) return false
    if (!audioResponse || audioResponse.status === 204) return false
    audioQueue.value.push(audioResponse)
    return true
  }

  const toggleRecordingRequest = () => {
    isRecordingRequested.value = !isRecordingRequested.value
  }

  const setWindowMaximized = (value: boolean) => {
    windowMaximized.value = value
  }

  const setWindowMode = (mode: 'avatar_ball' | 'window') => {
    windowMode.value = mode
  }

  /** 三种窗口形态的唯一读法（定义与迁移规则见 src/utils/windowStates.ts） */
  const windowState = computed<WindowState>(() => {
    if (windowMode.value === 'window') return 'window'
    return isMiniBall.value ? 'mini_ball' : 'avatar_ball'
  })

  const toggleEnglishMode = () => {
    englishMode.value = !englishMode.value
    try {
      window.localStorage.setItem(
        ENGLISH_MODE_STORAGE_KEY,
        englishMode.value ? '1' : '0'
      )
    } catch {
      // localStorage 不可用时只保留内存状态
    }
    statusMessage.value = englishMode.value
      ? 'English mode on — talk to me in English'
      : 'English mode off'
  }

  const addPendingScreenshot = (dataUrl: string) => {
    if (!dataUrl) return
    pendingScreenshots.value = [...pendingScreenshots.value, dataUrl]
  }

  const clearPendingScreenshots = () => {
    pendingScreenshots.value = []
  }

  const setLastScreenshot = (record: ScreenshotRecord | null) => {
    lastScreenshot.value = record
  }

  const addScreenshotRecord = (record: ScreenshotRecord) => {
    if (!record?.savedPath) return
    const key = record.savedPath.replace(/\\+/g, '/').toLowerCase()
    screenshotRecords.value = {
      ...screenshotRecords.value,
      [key]: record,
    }
    lastScreenshot.value = record
  }

  const stopPlaybackAndClearQueue = () => {
    playbackEpoch.value++
    eventBus.emit('cancel-tts')
    if (audioPlayer.value) {
      audioPlayer.value.pause()
      if (audioPlayer.value.src && audioPlayer.value.src.startsWith('blob:')) {
        URL.revokeObjectURL(audioPlayer.value.src)
      }
      audioPlayer.value.src = ''
      audioPlayer.value.onended = null
      audioPlayer.value.onerror = null
    }
    audioQueue.value = []
  }

  return {
    audioState,
    playbackEpoch,
    isRecordingRequested,
    isTTSEnabled,
    recognizedText,
    chatHistory,
    chatInput,
    statusMessage,
    openSidebar,
    isMiniBall,
    takingScreenShot,
    audioPlayer,
    aiVideo,
    videoSource,
    avatarFallbackImage,
    audioQueue,
    sideBarView,
    attachedFile,
    awaitingWakeWord,
    wakeWordDetected,
    setAudioState,
    queueAudioForPlayback,
    addMessageToHistory,
    updateMessageApiIdByTempId,
    appendMessageDeltaByTempId,
    addContentPartToMessageByTempId,
    updateImageContentPartByGenerationId,
    updateMessageContentByTempId,
    updateMessageApiResponseIdByTempId,
    addToolCallToMessageByTempId,
    updateMessageToolCallsByTempId,
    stopPlaybackAndClearQueue,
    englishMode,
    windowMaximized,
    windowMode,
    windowState,
    setWindowMaximized,
    setWindowMode,
    toggleEnglishMode,
    toggleRecordingRequest,
    pendingScreenshots,
    lastScreenshot,
    screenshotRecords,
    addPendingScreenshot,
    clearPendingScreenshots,
    setLastScreenshot,
    addScreenshotRecord,
  }
})
