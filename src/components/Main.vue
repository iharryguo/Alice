<template>
  <div class="h-screen flex w-full items-center justify-start relative">
    <!-- 聊天窗口形态：自绘标题栏（窗口是永久无边框的，见 windowManager.ts） -->
    <TitleBar v-if="generalStore.windowMode === 'window'" />
    <!-- 最大化 / 聊天窗口形态下铺一层不透明底色：头像浮在这层之上，
         不再让桌面从左侧透出来 -->
    <div
      v-if="windowMaximized || generalStore.windowMode === 'window'"
      class="max-backdrop"
    ></div>
    <!-- 聊天窗口形态：头像固定在左上角，下方留给后续 UI；
         头像球 / 迷你球：始终居中（这是一个"浮在桌面上的脸"） -->
    <div
      class="avatar-wrapper flex w-full h-full relative z-2"
      :class="{
        'mini-ball': isMiniBall,
        'avatar-top': generalStore.windowMode === 'window',
        'items-center': generalStore.windowMode !== 'window',
        'items-start': generalStore.windowMode === 'window',
        'justify-start': openSidebar,
        'justify-center': !openSidebar,
      }"
    >
      <div
        class="avatar"
        :class="{
          open: openSidebar,
          'avatar-max': windowMaximized || generalStore.windowMode === 'window',
        }"
        @mousedown="handleAvatarMouseDown"
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
              :ui-scale="avatarPixelSize / ACTIONS_DESIGN_SIZE"
            />
          </div>
        </div>
      </div>
      <Sidebar @processRequest="processRequestFromSidebar" />
    </div>
    <!-- 课堂只在聊天窗口形态里铺开：切到球态就收起面板，但课堂本身不停 -->
    <TeachingMode v-if="generalStore.windowMode === 'window'" />
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onMounted,
  onUnmounted,
  ref as vueRef,
} from 'vue'
import type { CSSProperties } from 'vue'
import { storeToRefs } from 'pinia'
import Actions from './Actions.vue'
import Sidebar from './Sidebar.vue'
import TitleBar from './TitleBar.vue'

import { useGeneralStore } from '../stores/generalStore'
import { useConversationStore } from '../stores/conversationStore'
import { useTeachingStore } from '../stores/teachingStore'
// 课堂按需加载：pdfjs 有自己的 worker 与近 1MB 的代码，
// 不该因为一次课程库打不开就把整个聊天界面拖下去
const TeachingMode = defineAsyncComponent(
  () => import('./teaching/TeachingMode.vue')
)
import {
  indexMessageForThoughts,
  uploadFileToOpenAI,
} from '../services/apiService'
import type { ChatMessage, AppChatMessageContentPart } from '../types/chat'
import { useAudioProcessing } from '../composables/useAudioProcessing'
import { useAudioPlayback } from '../composables/useAudioPlayback'
import { useScreenshot } from '../composables/useScreenshot'
import eventBus from '../utils/eventBus'
import { getConversationSessionId } from '../utils/conversationSession'

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
const teachingStore = useTeachingStore()

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

// 聊天窗口里（含最大化 / 还原）头像固定这个尺寸；迷你球固定 200
const WINDOW_MODE_AVATAR_SIZE = 320

const avatarPixelSize = computed(() => {
  if (isMiniBall.value) return 200
  // 聊天窗口里头像固定 320：最大化 / 还原之间尺寸保持不变
  if (generalStore.windowMode === 'window') return WINDOW_MODE_AVATAR_SIZE
  return isElectron ? 480 : 430
})

const avatarSizeStyle = computed<CSSProperties>(() => ({
  width: `${avatarPixelSize.value}px`,
  height: `${avatarPixelSize.value}px`,
}))

const avatarVideoStyle = computed<CSSProperties>(() => ({
  height: `${avatarPixelSize.value}px`,
}))

/**
 * 拖头像移动窗口。
 * 不用 -webkit-app-region: drag —— 拖动区会被系统当成标题栏，把 hover 事件一起吞掉，
 * 结果侧边按钮永远不出现。这里改成手动拖动：mousedown 记录起点，mousemove 算绝对坐标，
 * 通过 IPC 调 win.setPosition，按钮区域（button/indicator/dropdown/link）不参与。
 */
let dragSession: {
  startScreenX: number
  startScreenY: number
  winX: number
  winY: number
} | null = null
let dragFrame = 0
let pendingDragPosition: { x: number; y: number } | null = null

const flushDragPosition = () => {
  dragFrame = 0
  const next = pendingDragPosition
  pendingDragPosition = null
  if (next) window.aliceIPC?.invoke('window:set-position', next)
}

const handleDragMove = (event: MouseEvent) => {
  if (!dragSession) return
  pendingDragPosition = {
    x: dragSession.winX + (event.screenX - dragSession.startScreenX),
    y: dragSession.winY + (event.screenY - dragSession.startScreenY),
  }
  if (!dragFrame) dragFrame = window.requestAnimationFrame(flushDragPosition)
}

const handleDragEnd = () => {
  dragSession = null
  if (dragFrame) {
    window.cancelAnimationFrame(dragFrame)
    dragFrame = 0
  }
  pendingDragPosition = null
  window.removeEventListener('mousemove', handleDragMove)
}

const handleAvatarMouseDown = async (event: MouseEvent) => {
  if (event.button !== 0) return
  if (typeof window.aliceIPC === 'undefined') return
  // 最大化状态下不允许拖动（Windows 的语义是"拖标题栏先还原"，这里不做）
  if (generalStore.windowMaximized) return

  const target = event.target as HTMLElement | null
  if (target?.closest('button, .indicator, .dropdown, a, input, textarea')) return

  const position = (await window.aliceIPC.invoke(
    'window:get-position'
  )) as { x: number; y: number } | null
  if (!position) return

  event.preventDefault()
  dragSession = {
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    winX: position.x,
    winY: position.y,
  }
  window.addEventListener('mousemove', handleDragMove)
  window.addEventListener('mouseup', handleDragEnd, { once: true })
}

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

const applyModeFromMain = (payload: {
  mode?: string
  miniBall?: boolean
}) => {
  const mode = payload?.mode === 'window' ? 'window' : 'avatar_ball'
  const asMiniBall = mode === 'avatar_ball' && !!payload?.miniBall
  generalStore.setWindowMode(mode)
  generalStore.isMiniBall = asMiniBall
  // 窗口形态展开聊天面板；收回头像球时面板一并收起（同一个页面，不再重载）
  generalStore.openSidebar = mode === 'window'
  if (mode !== 'window') {
    generalStore.windowMaximized = false
  }
}

onMounted(async () => {
  // 启动时主进程通过 hash 告知当前形态（定义见 src/utils/windowStates.ts）：
  // #window = 聊天窗口， #mini-ball = 迷你球，其余为头像球。
  // 之后的形态切换不重载页面，主进程发 'window:mode-changed' 事件，这里就地换布局。
  const hash = window.location.hash
  const framedMode = hash.includes('window')
  generalStore.setWindowMode(framedMode ? 'window' : 'avatar_ball')
  generalStore.isMiniBall = !framedMode && hash.includes('mini-ball')
  if (framedMode) {
    generalStore.openSidebar = true
  }

  if (window.aliceIPC) {
    window.aliceIPC.on('window:mode-changed', applyModeFromMain)
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
  eventBus.on('open-teaching', teachingStore.open)
})

onUnmounted(() => {
  if (isElectron) {
    cleanupScreenshotListeners()
  }
  handleDragEnd()
  window.aliceIPC?.off('window:mode-changed', applyModeFromMain)
  aiVideo.value = null
  eventBus.off('processing-complete', handleProcessingComplete)
  eventBus.off('mute-playback-toggle', handleToggleTTS)
  eventBus.off('take-screenshot', handleTakeScreenshot)
  eventBus.off('open-teaching', teachingStore.open)
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

  // 上课时学生的话属于课堂，不进普通聊天链路：
  // 交给自己判断意图（提问/控制/跑题），而不是让 ChatOrchestrator 回答。
  if (teachingStore.isInClass) {
    if (meaningfulTranscription) {
      generalStore.recognizedText = transcription
      void teachingStore.handleUtterance(transcription)
    }
    return
  }

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
  // 上课期间任何输入都属于课堂：绝不允许掉进普通聊天，
  // 否则学生会发现自己"说一句话就被踢出课堂"。
  if (teachingStore.inLesson) {
    await teachingStore.handleUtterance(text)
    return
  }

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
      const conversationIdForThought = getConversationSessionId()
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

/* 不要给圆环/视频加 -webkit-app-region: drag。
   拖动区会被系统当成标题栏，hover 事件直接吞掉 —— 侧边按钮靠 .avatar:hover 显示，
   一旦圆内是拖动区，鼠标放在脸上就永远等不到 hover，按钮再也不出现。
   现在只有状态条（.dragable）能拖动窗口。 */

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

/* 缩放层不做 pointer-events 处理：一旦父层 none，子弹层只要有一条规则没生效，
   整个头像上的按钮就全点不动。缩放层和圆环同尺寸，本身也不挡别的东西。 */

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

/* 聊天窗口里的头像：离窗口左沿留一点呼吸 */
.avatar-max {
  margin-left: 24px;
}

/* 聊天窗口形态：头像靠上摆放（下方预留给后续 UI），不再上下居中 */
.avatar-wrapper.avatar-top {
  padding-top: 48px;
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

