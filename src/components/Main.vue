<template>
  <div
    class="h-screen flex w-full items-center justify-start relative"
    @mousemove="handlePointerMove"
  >
    <!-- 最大化 / 原生窗口形态下铺一层不透明底色：头像浮在这层之上，
         不再让桌面从左侧透出来 -->
    <div
      v-if="windowMaximized || generalStore.windowMode === 'window'"
      class="max-backdrop"
    ></div>
    <div
      class="avatar-wrapper flex w-full h-full items-center relative z-2"
      :class="{
        'mini-ball': isMiniBall,
        'justify-start': openSidebar,
        'justify-center': !openSidebar,
      }"
    >
      <div
        class="avatar"
        :class="{ open: openSidebar, 'avatar-max': windowMaximized }"
      >
        <div
          class="avatar-ring"
          :style="[avatarRingStyle, avatarSizeStyle]"
          :class="{
            'ring-green-500!': audioState === 'SPEAKING',
            'ring-cyan-500!':
              audioState === 'PROCESSING_AUDIO' ||
              audioState === 'WAITING_FOR_RESPONSE',
            'ring-blue-500!': audioState === 'LISTENING',
          }"
        >
          <audio ref="audioPlayerElement" class="hidden"></audio>
          <video
            class="max-w-screen-md rounded-full"
            :style="avatarVideoStyle"
            ref="aiVideoElement"
            :src="videoSource"
            loop
            muted
            autoplay
            playsinline
          ></video>
          <!-- 按钮在 480×480 的设计坐标里排版，整体按头像尺寸等比缩放：
               这样头像变小/最大化时按钮跟着缩小，而不是错位或被隐藏 -->
          <div class="actions-layer" :style="actionsLayerStyle">
            <Actions
              @takeScreenShot="handleTakeScreenshot"
              @togglePlaying="handleToggleTTS"
              @toggleRecording="handleToggleRecording"
              :isElectron="isElectron"
              :isTTSEnabled="isTTSEnabled"
              :audioState="audioState"
            />
          </div>
        </div>
      </div>
      <Sidebar @processRequest="processRequestFromSidebar" />
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  onMounted,
  onUnmounted,
  ref as vueRef,
  watch,
} from 'vue'
import type { CSSProperties } from 'vue'
import { storeToRefs } from 'pinia'
import Actions from './Actions.vue'
import Sidebar from './Sidebar.vue'

import { useGeneralStore } from '../stores/generalStore'
import { useConversationStore } from '../stores/conversationStore'
import {
  indexMessageForThoughts,
  uploadFileToOpenAI,
} from '../services/apiService'
import type { ChatMessage, AppChatMessageContentPart } from '../types/chat'
import { useAudioProcessing } from '../composables/useAudioProcessing'
import { useAudioPlayback } from '../composables/useAudioPlayback'
import { useScreenshot } from '../composables/useScreenshot'
import eventBus from '../utils/eventBus'

const audioProcessing = useAudioProcessing()
const { toggleRecordingRequest } = audioProcessing
const { toggleTTSPreference } = useAudioPlayback()
const {
  screenShot,
  screenshotReady,
  takeScreenShot,
  setupScreenshotListeners,
  cleanupScreenshotListeners,
} = useScreenshot()

const generalStore = useGeneralStore()
const conversationStore = useConversationStore()

const {
  audioState,
  aiVideo,
  videoSource,
  audioPlayer,
  chatInput,
  openSidebar,
  isMiniBall,
  isTTSEnabled,
  isRecordingRequested,
  takingScreenShot,
  avatarFallbackImage,
  windowMaximized,
} = storeToRefs(generalStore)
const { setAudioState } = generalStore

const isElectron =
  typeof window !== 'undefined' && Boolean((window as any).electron)
const audioPlayerElement = vueRef<HTMLAudioElement | null>(null)
const aiVideoElement = vueRef<HTMLVideoElement | null>(null)

let isProcessingRequest = false

// 最大化后头像缩成左侧的小圆，给聊天区让出宽度；迷你模式保持 200
const MAXIMIZED_AVATAR_SIZE = 240

const avatarPixelSize = computed(() => {
  if (isMiniBall.value) return 200
  if (windowMaximized.value) return MAXIMIZED_AVATAR_SIZE
  // 原生带框窗口里，头像缩小给聊天区让位
  if (generalStore.windowMode === 'window') return 320
  return isElectron ? 480 : 430
})

const avatarSizeStyle = computed<CSSProperties>(() => ({
  width: `${avatarPixelSize.value}px`,
  height: `${avatarPixelSize.value}px`,
}))

const avatarVideoStyle = computed<CSSProperties>(() => ({
  height: `${avatarPixelSize.value}px`,
}))

// 头像球/迷你球：圆形之外的窗口矩形区域要让鼠标穿透，否则会挡住下面的窗口
let mouseIgnored = false

const setMouseIgnored = (ignore: boolean) => {
  if (mouseIgnored === ignore) return
  mouseIgnored = ignore
  const pending = window.electron?.setIgnoreMouseEvents?.(ignore)
  if (pending) void pending.catch(() => undefined)
}

const handlePointerMove = (event: MouseEvent) => {
  // 聊天窗口形态下整窗都是内容，不需要穿透
  if (generalStore.windowMode !== 'ball') {
    setMouseIgnored(false)
    return
  }

  const ring = document.querySelector('.avatar-ring') as HTMLElement | null
  if (!ring) return
  const rect = ring.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const radius = rect.width / 2 + 6
  const inside =
    Math.hypot(event.clientX - centerX, event.clientY - centerY) <= radius

  setMouseIgnored(!inside)
}

watch(
  () => generalStore.windowMode,
  () => setMouseIgnored(false)
)

// Action 层按 480 的设计尺寸排版，再整体缩放到当前头像大小
const ACTIONS_DESIGN_SIZE = 480

const actionsLayerStyle = computed<CSSProperties>(() => {
  const scale = avatarPixelSize.value / ACTIONS_DESIGN_SIZE
  return {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: `${ACTIONS_DESIGN_SIZE}px`,
    height: `${ACTIONS_DESIGN_SIZE}px`,
    transform: `translate(-50%, -50%) scale(${scale})`,
    transformOrigin: 'center center',
    pointerEvents: 'none',
    zIndex: 30,
  }
})

const avatarRingStyle = computed<CSSProperties>(() => {
  const style: CSSProperties = {
    backgroundColor: '#050505',
  }
  if (avatarFallbackImage.value) {
    style.backgroundImage = `url(${avatarFallbackImage.value})`
    style.backgroundSize = 'cover'
    style.backgroundPosition = 'center'
    style.backgroundRepeat = 'no-repeat'
  }
  return style
})

onMounted(async () => {
  // 主进程通过 hash 告知当前形态：ball 只露圆形头像，window 是原生带框窗口
  const framedMode = window.location.hash.includes('window')
  generalStore.setWindowMode(framedMode ? 'window' : 'ball')
  if (framedMode) {
    generalStore.openSidebar = true
  }

  audioPlayer.value = audioPlayerElement.value
  aiVideo.value = aiVideoElement.value

  if (aiVideo.value) {
    aiVideo.value
      .play()
      .catch(e => console.warn('Initial video play failed:', e))
  }

  if (isElectron) {
    setupScreenshotListeners()
  }

  eventBus.on('processing-complete', handleProcessingComplete)
  eventBus.on('mute-playback-toggle', handleToggleTTS)
  eventBus.on('take-screenshot', handleTakeScreenshot)
})

onUnmounted(() => {
  if (isElectron) {
    cleanupScreenshotListeners()
  }
  aiVideo.value = null
  eventBus.off('processing-complete', handleProcessingComplete)
  eventBus.off('mute-playback-toggle', handleToggleTTS)
  eventBus.off('take-screenshot', handleTakeScreenshot)
})

const handleTakeScreenshot = () => {
  if (isElectron && !takingScreenShot.value) {
    takeScreenShot()
  }
}

const handleToggleTTS = () => {
  toggleTTSPreference()
}

const handleToggleRecording = () => {
  toggleRecordingRequest()
}

const handleProcessingComplete = (transcription: string) => {
  const meaningfulTranscription =
    transcription && transcription.trim().length > 1

  if (isProcessingRequest) {
    return
  }

  if (
    meaningfulTranscription &&
    (audioState.value === 'PROCESSING_AUDIO' ||
      audioState.value === 'LISTENING')
  ) {
    generalStore.recognizedText = transcription
    processRequest(transcription, 'VOICE')
  } else {
    if (
      audioState.value !== 'SPEAKING' &&
      audioState.value !== 'WAITING_FOR_RESPONSE'
    ) {
      setAudioState(isRecordingRequested.value ? 'LISTENING' : 'IDLE')
    }
  }
}

const processRequestFromSidebar = (text: string) => {
  if (isProcessingRequest) {
    generalStore.statusMessage = 'Processing previous request...'
    setTimeout(() => {
      generalStore.setAudioState(audioState.value)
    }, 2000)
    return
  }
  if (text.trim() || generalStore.attachedFile) {
    if (
      audioState.value === 'IDLE' ||
      audioState.value === 'LISTENING' ||
      audioState.value === 'WAITING_FOR_RESPONSE' ||
      audioState.value === 'SPEAKING'
    ) {
      generalStore.recognizedText = ''
      processRequest(text, 'SIDEBAR_TEXT')
    } else {
      generalStore.statusMessage = 'Busy, please wait...'

      setTimeout(() => {
        if (generalStore.statusMessage === 'Busy, please wait...')
          generalStore.setAudioState(audioState.value)
      }, 2000)
    }
  }
}

const processRequest = async (
  text: string,
  source: 'VOICE' | 'SIDEBAR_TEXT'
) => {
  if (isProcessingRequest) {
    return
  }
  isProcessingRequest = true

  setAudioState('WAITING_FOR_RESPONSE')

  const appContentParts: AppChatMessageContentPart[] = []

  const fileToProcess = generalStore.attachedFile
  if (fileToProcess) {
    generalStore.statusMessage = `Uploading ${fileToProcess.name}...`
    try {
      const uploadedFileId = await uploadFileToOpenAI(fileToProcess)
      if (uploadedFileId) {
        appContentParts.push({
          type: 'app_file',
          fileId: uploadedFileId,
          fileName: fileToProcess.name,
        })
      } else {
        generalStore.statusMessage = 'Error: PDF file upload failed.'
        isProcessingRequest = false
        setAudioState(isRecordingRequested.value ? 'LISTENING' : 'IDLE')
        generalStore.attachedFile = null
        return
      }
    } catch (error) {
      console.error('Error uploading file:', error)
      generalStore.statusMessage = 'Error: PDF file upload failed.'
      isProcessingRequest = false
      setAudioState(isRecordingRequested.value ? 'LISTENING' : 'IDLE')
      generalStore.attachedFile = null
      return
    }
    generalStore.attachedFile = null
  }

  if (text) {
    appContentParts.push({ type: 'app_text', text: text })
  }

  if (screenshotReady.value && screenShot.value) {
    appContentParts.push({ type: 'app_image_uri', uri: screenShot.value })
    screenshotReady.value = false
    screenShot.value = ''
  }

  // 诊断日志：确认截图是否真的被附加到了本次请求（只打印类型与 URI 前缀，
  // 避免刷屏 base64）
  console.log(
    '[Main.vue processRequest] Content parts:',
    JSON.stringify(
      appContentParts.map(part => ({
        type: part.type,
        textPreview:
          part.type === 'app_text' ? part.text?.slice(0, 40) : undefined,
        uriPrefix:
          part.type === 'app_image_uri'
            ? part.uri?.slice(0, 30)
            : undefined,
      }))
    )
  )

  if (appContentParts.length === 0) {
    generalStore.statusMessage = 'Nothing to send.'
    isProcessingRequest = false
    setAudioState(isRecordingRequested.value ? 'LISTENING' : 'IDLE')
    return
  }

  const userMessage: ChatMessage = {
    role: 'user',
    content: appContentParts,
  }

  try {
    let userTextForIndexing = ''
    if (Array.isArray(userMessage.content)) {
      const textParts = userMessage.content
        .filter(p => p.type === 'app_text' && p.text)
        .map(p => p.text!)
      userTextForIndexing = textParts.join(' ')
    }

    if (userTextForIndexing) {
      const conversationIdForThought =
        conversationStore.currentResponseId || 'default_conversation'
      await indexMessageForThoughts(conversationIdForThought, 'user', {
        content: appContentParts,
      })
    }
  } catch (e) {
    console.error(
      '[Main.vue] Error calling indexMessageForThoughts for user message:',
      e
    )
  }

  generalStore.addMessageToHistory(userMessage)
  try {
    const chatPromise = conversationStore.chat()

    const timeoutPromise = new Promise((_, reject) => {
      let timeoutId: NodeJS.Timeout
      let hasImageGeneration = false

      const startTimeout = () => {
        timeoutId = setTimeout(() => {
          if (generalStore.audioState === 'GENERATING_IMAGE') {
            console.log(
              '[Timeout] Skipping timeout - image generation in progress'
            )
            startTimeout()
            return
          }
          reject(new Error('Chat request timeout after 90 seconds'))
        }, 90000)
      }

      const stateWatcher = () => {
        if (
          generalStore.audioState === 'GENERATING_IMAGE' &&
          !hasImageGeneration
        ) {
          console.log('[Timeout] Image generation started, disabling timeout')
          clearTimeout(timeoutId)
          hasImageGeneration = true
        }
      }

      startTimeout()
      const intervalId = setInterval(stateWatcher, 500)

      chatPromise.finally(() => {
        clearTimeout(timeoutId)
        clearInterval(intervalId)
      })
    })

    await Promise.race([chatPromise, timeoutPromise])
  } catch (e) {
    console.error(
      `[Main.vue processRequest (${source})] Error during conversationStore.chat():`,
      e
    )

    if (
      generalStore.audioState !== 'IDLE' &&
      generalStore.audioState !== 'LISTENING' &&
      generalStore.audioState !== 'GENERATING_IMAGE'
    ) {
      console.log('[Error Recovery] Resetting audio state to prevent UI lock')
      setAudioState(isRecordingRequested.value ? 'LISTENING' : 'IDLE')
    }
  } finally {
    isProcessingRequest = false

    setTimeout(() => {
      if (
        generalStore.audioState === 'WAITING_FOR_RESPONSE' ||
        generalStore.audioState === 'PROCESSING_AUDIO'
      ) {
        console.log(
          '[Safety Recovery] Detected stuck audio state, resetting to interactive mode'
        )
        setAudioState(isRecordingRequested.value ? 'LISTENING' : 'IDLE')
      }
    }, 2000)
  }
}
</script>

<style scoped lang="postcss">
.avatar-ring {
  transition: ring-color 0.3s ease-in-out;
}

/* 整个头像区域都可以拖动窗口（无边框窗口依赖 -webkit-app-region）。
   注意该属性不会被子元素继承，所以视频和圆环也要显式声明。 */
.avatar-wrapper,
.avatar-wrapper :deep(.avatar-ring),
.avatar-wrapper :deep(video) {
  -webkit-app-region: drag;
}

/* 交互元素必须排除在拖动区域之外，否则点击会被窗口拖动吞掉 */
.avatar-wrapper :deep(.indicator) {
  -webkit-app-region: no-drag;
}

/* 顶部汉堡菜单：dropdown-hover 依赖 :hover 维持展开，但从按钮移动到菜单
   要经过的间隙落在视频的 drag 区域上，hover 事件会被窗口拖动系统吞掉导致
   菜单闪没。这里把整个 dropdown 标为 no-drag，并用伪元素桥接间隙。 */
.avatar-wrapper :deep(.dropdown) {
  -webkit-app-region: no-drag;
}
.avatar-wrapper :deep(.dropdown::after) {
  content: '';
  position: absolute;
  left: -8px;
  right: -8px;
  top: 100%;
  height: 16px;
  -webkit-app-region: no-drag;
}

/* 聊天侧栏整体不可拖动，保证输入框/滚动条/按钮正常工作 */
.avatar-wrapper :deep(.sidebar-wrapper) {
  -webkit-app-region: no-drag;
}

/* 缩放层本身不吃点击，只有里面的按钮/状态条吃 */
.actions-layer > * {
  pointer-events: auto;
}

/* 最大化时的整窗底色：让窗口看起来真的铺满，而不是中间一块、四周透明 */
.max-backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  background:
    radial-gradient(
      120% 90% at 8% 45%,
      rgba(29, 78, 116, 0.55) 0%,
      rgba(8, 15, 30, 0) 55%
    ),
    #070c17;
}

/* 最大化后露在左侧的小头像：离窗口左沿留一点呼吸 */
.avatar-max {
  margin-left: 24px;
}

/* 最大化后露在左侧的小头像：给个柔和的过渡，尺寸变化不突兀 */
.avatar-ring {
  transition:
    width 0.18s ease-out,
    height 0.18s ease-out;
}

.avatar video {
  transition: height 0.18s ease-out;
}
</style>

