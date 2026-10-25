<template>
  <div class="cockpit">
    <header class="cockpit-head">
      <div class="head-left">
        <span class="head-title">对话</span>
        <span class="head-state" :class="`state-${audioState.toLowerCase()}`">
          <span class="state-dot"></span>{{ stateLabel }}
        </span>
        <span v-if="englishMode" class="head-badge">EN</span>
        <button
          v-if="inLesson"
          class="head-teaching"
          title="回到正在进行的课堂"
          @click="openTeaching"
        >
          课堂进行中 · 返回
        </button>
      </div>
      <div class="head-actions">
        <button class="head-btn" title="英语课堂" @click="openTeaching">
          📖 课堂
        </button>
        <button class="head-btn" title="设置" @click="openSettings">⚙</button>
        <button class="head-btn" title="记忆管理" @click="openMemories">
          🧠 记忆
        </button>
        <button class="head-btn" title="历史对话（搜索/恢复）" @click="openHistory">
          🕘 历史
        </button>
        <button class="head-btn" title="开始新对话" @click="handleNewSession">
          ＋
        </button>
      </div>

      <button
        class="head-btn head-btn-collapse"
        title="收起为圆形头像"
        @click="collapseToBall"
      >
        ⌄ 收起
      </button>
    </header>

    <div ref="scrollEl" class="cockpit-body" @scroll="handleScroll">
      <div v-if="items.length === 0" class="empty-state">
        <div class="empty-avatar">◕‿◕</div>
        <div class="empty-title">我在这儿。</div>
        <div class="empty-sub">
          打字、说话都行；我还能看屏幕、读文件、替你操作电脑。
        </div>
        <div class="empty-hints">
          <button
            v-for="hint in hints"
            :key="hint"
            class="hint-chip"
            @click="useHint(hint)"
          >
            {{ hint }}
          </button>
        </div>
      </div>

      <template v-for="item in items">
        <MessageBubble
          v-if="item.kind === 'message'"
          :key="item.key"
          :item="item"
          :is-speaking="speakingKey === item.key"
          @speak="handleSpeak(item)"
        />
        <ToolCallCard
          v-else-if="item.kind === 'tool'"
          :key="item.key"
          :tool="item.tool"
        />
        <div v-else :key="item.key" class="activity-line">
          <span class="activity-dot"></span>{{ item.text }}
        </div>
      </template>
    </div>

    <ApprovalCard />

    <Composer
      :disabled="disabled"
      :is-busy="isBusy"
      @send="handleSend"
      @toggle-recording="handleToggleRecording"
      @toggle-tts="handleToggleTts"
      @toggle-english="handleToggleEnglish"
      @stop="handleStop"
    />

    <HistoryPanel
      v-if="showHistory"
      @close="showHistory = false"
      @restored="handleAfterRestore"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import MessageBubble from './MessageBubble.vue'
import ToolCallCard from './ToolCallCard.vue'
import Composer from './Composer.vue'
import ApprovalCard from './ApprovalCard.vue'
import HistoryPanel from './HistoryPanel.vue'
import { useGeneralStore } from '../../stores/generalStore'
import { useConversationStore } from '../../stores/conversationStore'
import { useConversationLogStore } from '../../stores/conversationLogStore'
import { useApprovalStore } from '../../stores/approvalStore'
import eventBus from '../../utils/eventBus'
import { useTeachingStore } from '../../stores/teachingStore'
import { collapseToAvatar } from '../../utils/windowModeActions'
import {
  buildChatDisplayItems,
  type MessageDisplayItem,
} from '../../utils/chatDisplay'

const props = defineProps<{ disabled?: boolean }>()

const emit = defineEmits<{ (e: 'send', text: string): void }>()

const generalStore = useGeneralStore()
const conversationStore = useConversationStore()
const logStore = useConversationLogStore()
const approvalStore = useApprovalStore()

const { chatHistory, audioState, englishMode } = storeToRefs(generalStore)

const scrollEl = ref<HTMLElement | null>(null)
const shouldAutoScroll = ref(true)
const showHistory = ref(false)
const speakingKey = ref<string | null>(null)
let disposeMaximizedListener: (() => void) | null = null

/** 最大化状态同步到 store：侧栏与头像区据此切换布局 */
const applyMaximized = (maximized: boolean) => {
  generalStore.setWindowMaximized(maximized)
}

/** 收起：落库会话后让主进程把窗口切回"只露圆形头像" */
const collapseToBall = () => {
  void collapseToAvatar()
}

const refreshMaximizedState = async () => {
  try {
    const result = await window.electron?.isMaximized?.()
    if (result && typeof result.maximized === 'boolean') {
      applyMaximized(result.maximized)
    }
  } catch (error) {
    console.warn('[ChatCockpit] 读取窗口最大化状态失败:', error)
  }
}

const hints = [
  '帮我看看屏幕上是什么',
  '整理一下我的下载文件夹',
  '陪我练两分钟英语',
]

const items = computed(() => buildChatDisplayItems(chatHistory.value))

const isBusy = computed(
  () =>
    audioState.value === 'WAITING_FOR_RESPONSE' ||
    audioState.value === 'PROCESSING_AUDIO' ||
    audioState.value === 'GENERATING_IMAGE'
)

const stateLabel = computed(() => {
  switch (audioState.value) {
    case 'LISTENING':
      return '聆听中'
    case 'PROCESSING_AUDIO':
      return '识别中'
    case 'WAITING_FOR_RESPONSE':
      return '思考中'
    case 'SPEAKING':
      return '说话中'
    case 'GENERATING_IMAGE':
      return '画图中'
    case 'CONFIG':
      return '待配置'
    case 'IDLE':
    default:
      return audioState.value === 'IDLE' && isRecordingBusy.value
        ? '麦克风已开'
        : '待命'
  }
})

const isRecordingBusy = computed(() => generalStore.isRecordingRequested)

const scrollToBottom = (smooth = true) => {
  requestAnimationFrame(() => {
    const el = scrollEl.value
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    shouldAutoScroll.value = true
  })
}

const handleScroll = () => {
  const el = scrollEl.value
  if (!el) return
  shouldAutoScroll.value =
    el.scrollHeight - el.scrollTop - el.clientHeight <= 120
}

watch(
  () => chatHistory.value.length,
  () => {
    if (shouldAutoScroll.value) scrollToBottom()
  }
)

// 流式增量不会改变长度，单独订阅最后一条消息的文本长度
watch(
  () => {
    const last = chatHistory.value[0]
    if (!last) return 0
    if (typeof last.content === 'string') return last.content.length
    if (Array.isArray(last.content)) {
      return last.content.reduce(
        (sum, part) => sum + ((part as any).text?.length || 0),
        0
      )
    }
    return 0
  },
  () => {
    if (shouldAutoScroll.value) scrollToBottom(false)
  }
)

// 聊天记录变化 → 防抖写入本地会话库
watch(
  () => chatHistory.value.length,
  () => {
    if (chatHistory.value.length > 0) logStore.scheduleSync()
  },
  { deep: false }
)

watch(audioState, (state, previous) => {
  if (
    (state === 'IDLE' || state === 'LISTENING') &&
    (previous === 'WAITING_FOR_RESPONSE' ||
      previous === 'GENERATING_IMAGE' ||
      previous === 'SPEAKING')
  ) {
    logStore.scheduleSync(400)
  }
})

watch(audioState, state => {
  if (state !== 'SPEAKING') speakingKey.value = null
})

const handleSend = (text: string) => {
  shouldAutoScroll.value = true
  emit('send', text)
}

const useHint = (hint: string) => {
  shouldAutoScroll.value = true
  emit('send', hint)
}

const handleToggleRecording = () => {
  generalStore.toggleRecordingRequest()
}

const handleToggleTts = () => {
  // 复用 Main.vue 已注册的播放控制链路，避免重复实例化播放队列
  eventBus.emit('mute-playback-toggle')
}

const handleToggleEnglish = () => {
  generalStore.toggleEnglishMode()
}

const handleStop = () => {
  conversationStore.cancelCurrentTurn()
}

const handleSpeak = (item: MessageDisplayItem) => {
  if (speakingKey.value === item.key) {
    conversationStore.stopSpeaking()
    speakingKey.value = null
    return
  }
  speakingKey.value = item.key
  void conversationStore.speakText(item.text.replace(/[#*`>]/g, ''))
}

const openHistory = () => {
  showHistory.value = true
  void logStore.refreshSessions()
}

const openMemories = () => {
  generalStore.sideBarView = 'memories'
}

const openSettings = () => {
  window.aliceIPC
    ?.invoke('settings-window:open')
    .catch(error => console.warn('[ChatCockpit] 打开设置失败:', error))
}

const openTeaching = () => {
  eventBus.emit('open-teaching')
}

const teachingStore = useTeachingStore()
const inLesson = computed(() => teachingStore.inLesson)

const handleNewSession = async () => {
  await logStore.startNewSession()
  handleAfterRestore()
}

const handleAfterRestore = () => {
  shouldAutoScroll.value = true
  nextTick(() => scrollToBottom(false))
}

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && isBusy.value) {
    event.preventDefault()
    handleStop()
  }
}

onMounted(() => {
  approvalStore.ensureListener()
  window.addEventListener('keydown', handleKeydown)
  void logStore.refreshSessions()
  void refreshMaximizedState()
  disposeMaximizedListener =
    window.electron?.onMaximizedChanged?.(maximized => {
      applyMaximized(maximized)
    }) ?? null
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  disposeMaximizedListener?.()
  disposeMaximizedListener = null
  void logStore.flush()
})
</script>

<style scoped>
.cockpit {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  /* 面板高度由窗口决定，内部只允许消息区滚动，输入区永远钉在底部 */
  overflow: hidden;
  background: rgb(2 6 23 / 0.55);
}

.cockpit-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid rgb(148 163 184 / 0.16);
  background: rgb(15 23 42 / 0.85);
}

.head-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.head-title {
  font-size: 12px;
  font-weight: 600;
  color: rgb(226 232 240);
}

.head-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: rgb(148 163 184);
}

.state-dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: rgb(100 116 139);
}

.state-listening .state-dot,
.state-processing_audio .state-dot {
  background: rgb(52 211 153);
  box-shadow: 0 0 6px rgb(52 211 153 / 0.8);
}

.state-waiting_for_response .state-dot,
.state-generating_image .state-dot {
  background: rgb(56 189 248);
  animation: blink 1s ease-in-out infinite;
}

.state-speaking .state-dot {
  background: rgb(250 204 21);
}

@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.head-badge {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: rgb(69 26 3);
  background: rgb(250 204 21);
  border-radius: 4px;
  padding: 0 4px;
}

.head-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

.head-btn-collapse {
  margin-left: 6px;
  border-color: rgb(56 189 248 / 0.35);
  color: rgb(125 211 252);
}

.head-btn-collapse:hover {
  background: rgb(56 189 248 / 0.14);
  color: rgb(224 242 254);
}

.head-btn {
  font-size: 11px;
  color: rgb(148 163 184);
  background: transparent;
  border: 1px solid rgb(148 163 184 / 0.22);
  border-radius: 6px;
  padding: 2px 7px;
  cursor: pointer;
  white-space: nowrap;
}

.head-btn:hover {
  color: rgb(226 232 240);
  background: rgb(148 163 184 / 0.12);
}

.cockpit-body {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 10px 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scrollbar-width: thin;
}

.cockpit-body::-webkit-scrollbar {
  width: 6px;
}
.cockpit-body::-webkit-scrollbar-thumb {
  background: rgb(71 85 105 / 0.7);
  border-radius: 3px;
}

.empty-state {
  margin: auto;
  text-align: center;
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
}

.empty-avatar {
  font-size: 22px;
  color: rgb(125 211 252);
  letter-spacing: 0.1em;
}

.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: rgb(226 232 240);
}

.empty-sub {
  font-size: 11px;
  color: rgb(100 116 139);
  max-width: 260px;
  line-height: 1.6;
}

.empty-hints {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
  margin-top: 6px;
}

.hint-chip {
  font-size: 11px;
  color: rgb(203 213 225);
  background: rgb(30 41 59 / 0.8);
  border: 1px solid rgb(148 163 184 / 0.22);
  border-radius: 999px;
  padding: 3px 9px;
  cursor: pointer;
}

.hint-chip:hover {
  border-color: rgb(56 189 248 / 0.5);
  color: rgb(224 242 254);
}

.activity-line {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: rgb(100 116 139);
  padding-left: 2px;
}

.activity-dot {
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: rgb(100 116 139);
}
.head-teaching {
  font-size: 11px;
  color: #1d4ed8;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 999px;
  padding: 2px 8px;
  cursor: pointer;
}
</style>
