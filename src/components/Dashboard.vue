<template>
  <div class="dash">
    <header class="dash-head">
      <div class="head-titles">
        <span class="head-title">仪表盘</span>
        <span class="head-sub">连接、感知与状态总览</span>
      </div>
      <div class="head-actions">
        <button
          class="head-btn"
          :disabled="refreshing"
          title="重新读取连接状态、记忆与会话"
          @click="refreshAll"
        >
          {{ refreshing ? '刷新中…' : '⟳ 刷新' }}
        </button>
        <button class="head-btn" title="回到聊天" @click="backToChat">
          ← 返回对话
        </button>
      </div>
    </header>

    <div class="dash-body">
      <div class="stat-grid">
        <DashStat
          v-for="stat in stats"
          :key="stat.label"
          :label="stat.label"
          :value="stat.value"
          :hint="stat.hint"
          :icon="stat.icon"
          :tone="stat.tone"
        />
      </div>

      <div class="card-grid">
        <DashCard title="感知能力" hint="屏幕 / 摄像头 / 麦克风 / 唤醒词">
          <template #actions>
            <span class="pill" :class="perceptionActive ? 'pill-on' : 'pill-off'">
              {{ perceptionActive ? '运行中' : '待命中' }}
            </span>
          </template>

          <div class="sensor-list">
            <div v-for="row in sensorRows" :key="row.key" class="sensor-row">
              <span class="sensor-icon">{{ row.icon }}</span>
              <span class="sensor-label">{{ row.label }}</span>
              <span
                class="sensor-state"
                :class="row.enabled ? 'state-on' : 'state-off'"
              >
                {{ row.state }}
              </span>
              <span class="sensor-last">最近：{{ row.last }}</span>
            </div>
          </div>

          <div class="divider"></div>

          <label class="toggle-row">
            <span class="toggle-text">
              <span class="toggle-label">麦克风监听</span>
              <span class="toggle-hint">
                关闭后不再自动收音；打字、截图、摄像头都还能用
              </span>
            </span>
            <input
              type="checkbox"
              class="toggle"
              :checked="isRecordingRequested"
              @change="handleMicToggle"
            />
          </label>
        </DashCard>

        <DashCard title="运行与节奏" hint="模型、语音与当前状态">
          <div class="kv-list">
            <div v-for="row in runtimeRows" :key="row.key" class="kv-row">
              <span class="kv-key">{{ row.key }}</span>
              <span class="kv-value" :title="row.value">{{ row.value }}</span>
            </div>
          </div>
        </DashCard>

        <DashCard
          title="最近观察"
          :hint="`最多保留 30 条 · 现在 ${observationLabel}`"
        >
          <template #actions>
            <button
              class="mini-btn"
              :disabled="observations.length === 0"
              @click="observationStore.clear()"
            >
              清空
            </button>
          </template>

          <div v-if="observations.length === 0" class="empty">
            还没有观察记录。截个屏、拍张照、说句话，这里就会留下痕迹。
          </div>
          <div v-else class="timeline">
            <div
              v-for="item in observations"
              :key="item.id"
              class="timeline-item"
            >
              <span class="timeline-dot" :class="`kind-${item.kind}`"></span>
              <div class="timeline-main">
                <div class="timeline-head">
                  <span class="kind-chip" :class="`kind-${item.kind}`">
                    {{ KIND_LABELS[item.kind] }}
                  </span>
                  <span class="timeline-time">{{ timeAgo(item.timestamp) }}</span>
                </div>
                <div class="timeline-summary">{{ item.summary }}</div>
              </div>
            </div>
          </div>
        </DashCard>

        <DashCard title="快捷测试" hint="立刻走一次感知或语音流程">
          <div class="test-grid">
            <button
              v-for="action in quickTests"
              :key="action.key"
              class="test-btn"
              :class="{ 'test-btn-on': action.active }"
              :disabled="action.busy"
              @click="action.run"
            >
              <span class="test-icon">{{ action.icon }}</span>
              <span>{{ action.label }}</span>
            </button>
          </div>

          <div class="divider"></div>

          <div class="kv-list">
            <div class="kv-row">
              <span class="kv-key">当前会话</span>
              <span class="kv-value">{{ chatHistory.length }} 条消息</span>
            </div>
            <div class="kv-row">
              <span class="kv-key">待发送画面</span>
              <span class="kv-value">{{ pendingAttachmentCount }} 张</span>
            </div>
            <div class="kv-row">
              <span class="kv-key">记忆总数</span>
              <span class="kv-value">{{ memoryCount }} 条</span>
            </div>
            <div class="kv-row">
              <span class="kv-key">历史对话</span>
              <span class="kv-value">{{ sessions.length }} 段</span>
            </div>
          </div>
        </DashCard>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import DashStat from './dashboard/DashStat.vue'
import DashCard from './dashboard/DashCard.vue'
import { useGeneralStore } from '../stores/generalStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useConversationLogStore } from '../stores/conversationLogStore'
import { useTeachingStore } from '../stores/teachingStore'
import {
  useObservationStore,
  type ObservationKind,
} from '../stores/observationStore'
import { usePerception } from '../composables/usePerception'
import { backendApi, type HealthResponse } from '../services/backendApi'
import { getProviderDisplayName } from '../services/llmProviders/providerCatalog'
import { getPersona } from '../prompts/personas'
import { logEvent } from '../utils/logger'

const KIND_LABELS: Record<ObservationKind, string> = {
  screen: '屏幕',
  camera: '摄像头',
  audio: '声音',
  chat: '对话',
  system: '系统',
}

const generalStore = useGeneralStore()
const settingsStore = useSettingsStore()
const logStore = useConversationLogStore()
const teachingStore = useTeachingStore()
const observationStore = useObservationStore()
const perception = usePerception()

const { audioState, isRecordingRequested, isTTSEnabled, englishMode, chatHistory } =
  storeToRefs(generalStore)
const observations = storeToRefs(observationStore).observations
const sessions = storeToRefs(logStore).sessions

const health = ref<HealthResponse | null>(null)
const healthError = ref<string | null>(null)
const memoryCount = ref(0)
const refreshing = ref(false)
const nowTick = ref(Date.now())
let tickTimer: number | null = null

const startedAt = performance.timeOrigin || Date.now()

const appVersion = import.meta.env.VITE_APP_VERSION || '—'
const assistantTools = computed(() => settingsStore.settings.assistantTools || [])

const audioStateLabels: Record<string, string> = {
  IDLE: '待命',
  LISTENING: '聆听中',
  PROCESSING_AUDIO: '识别中',
  WAITING_FOR_RESPONSE: '思考中',
  SPEAKING: '说话中',
  GENERATING_IMAGE: '画图中',
  CONFIG: '待配置',
}

const providerLabel = computed(() =>
  getProviderDisplayName(settingsStore.settings.aiProvider)
)
const personaName = computed(() =>
  getPersona(settingsStore.settings.assistantPersonaId).displayName
)

const observationLabel = computed(() => `${observations.value.length} 条`)

const backendReady = computed(() => Boolean(health.value))
const readyServices = computed(() => {
  const services = health.value?.services
  if (!services) return 0
  return [services.stt, services.tts, services.embeddings].filter(Boolean)
    .length
})

const stats = computed(() => [
  {
    label: '核心连接',
    icon: '🔌',
    tone: backendReady.value ? ('success' as const) : ('danger' as const),
    value: backendReady.value ? '已连接' : '未连接',
    hint: backendReady.value
      ? `本地后端 v${health.value?.version || '未知'} · ${readyServices.value}/3 服务就绪`
      : healthError.value || '本地后端未启动（云端模型仍可用）',
  },
  {
    label: '对话模型',
    icon: '🧠',
    tone: 'info' as const,
    value: providerLabel.value,
    hint: settingsStore.settings.assistantModel || '未选择模型',
  },
  {
    label: '语音状态',
    icon: '🎙',
    tone:
      audioState.value === 'LISTENING'
        ? ('success' as const)
        : audioState.value === 'SPEAKING'
          ? ('accent' as const)
          : ('neutral' as const),
    value: audioStateLabels[audioState.value] || audioState.value,
    hint: `${isRecordingRequested.value ? '麦克风已开' : '麦克风未开'} · 语音输出${isTTSEnabled.value ? '已开启' : '已关闭'}`,
  },
  {
    label: '记忆与对话',
    icon: '🗂',
    tone: 'accent' as const,
    value: `${memoryCount.value} 条记忆`,
    hint: `${sessions.value.length} 段历史对话 · 当前会话 ${chatHistory.value.length} 条`,
  },
  {
    label: '英语模式',
    icon: '📖',
    tone: englishMode.value ? ('warning' as const) : ('neutral' as const),
    value: englishMode.value ? '已开启' : '关闭',
    hint: teachingStore.inLesson ? '课堂进行中' : '课堂未开始',
  },
  {
    label: '运行时长',
    icon: '⏱',
    tone: 'neutral' as const,
    value: formatUptime(nowTick.value - startedAt),
    hint: `Alice v${appVersion}`,
  },
])

const lastText = (kind: ObservationKind) => {
  const at = observationStore.lastAt(kind)
  return at ? timeAgo(at) : '暂无'
}

const sensorRows = computed(() => [
  {
    key: 'screen',
    icon: '🖥',
    label: '屏幕截图',
    enabled: assistantTools.value.includes('take_screenshot'),
    state: assistantTools.value.includes('take_screenshot') ? '开启' : '关闭',
    last: lastText('screen'),
  },
  {
    key: 'camera',
    icon: '📷',
    label: '摄像头',
    enabled: true,
    state: '手动',
    last: lastText('camera'),
  },
  {
    key: 'mic',
    icon: '🎙',
    label: '麦克风',
    enabled: isRecordingRequested.value,
    state: isRecordingRequested.value ? '开启' : '关闭',
    last: lastText('audio'),
  },
  {
    key: 'wake',
    icon: '✨',
    label: '语音唤醒',
    enabled: Boolean(settingsStore.settings.localSttEnabled),
    state: settingsStore.settings.localSttEnabled ? '开启' : '关闭',
    last: settingsStore.settings.localSttEnabled
      ? `唤醒词「${settingsStore.settings.localSttWakeWord || '—'}」`
      : '暂无',
  },
])

const perceptionActive = computed(
  () =>
    isRecordingRequested.value ||
    sensorRows.value.some(row => row.enabled && row.key !== 'wake')
)

const runtimeRows = computed(() => [
  { key: '当前身份', value: personaName.value },
  {
    key: '对话模型',
    value: settingsStore.settings.assistantModel || '—',
  },
  {
    key: '摘要模型',
    value: settingsStore.settings.SUMMARIZATION_MODEL || '—',
  },
  {
    key: '语音识别',
    value: `${settingsStore.settings.sttProvider} · ${sttModelLabel.value}`,
  },
  {
    key: '语音合成',
    value: `${settingsStore.settings.ttsProvider} · ${settingsStore.settings.volcengineTtsSpeaker || settingsStore.settings.ttsVoice}`,
  },
  {
    key: '本地文档',
    value: settingsStore.settings.ragEnabled
      ? `已开启 · ${settingsStore.settings.ragPaths.length} 个路径`
      : '未开启',
  },
  {
    key: '启用工具',
    value: `${assistantTools.value.length} 个`,
  },
])

const sttModelLabel = computed(() => {
  const settings = settingsStore.settings
  switch (settings.sttProvider) {
    case 'local':
      return settings.localSttModel
    case 'doubao':
      return settings.doubaoSttModel || '—'
    case 'qwen':
      return settings.qwenSttModel || '—'
    case 'openai':
      return settings.openaiSttModel || '—'
    case 'volcengine':
      return settings.volcengineAsrResourceId || '—'
    default:
      return '—'
  }
})

const pendingAttachmentCount = computed(
  () =>
    Number(Boolean(perception.screenShot.value && perception.screenshotReady.value)) +
    Number(Boolean(perception.cameraShot.value && perception.cameraShotReady.value))
)

const quickTests = computed(() => [
  {
    key: 'screen',
    icon: '🖥',
    label: '截图测试',
    active: perception.screenshotReady.value,
    busy: perception.takingScreenShot.value,
    run: () => void perception.captureScreen(),
  },
  {
    key: 'camera',
    icon: '📷',
    label: '摄像头测试',
    active: perception.cameraShotReady.value,
    busy: perception.cameraCaptureBusy.value,
    run: () => void perception.captureCamera(),
  },
  {
    key: 'voice',
    icon: '🎙',
    label: isRecordingRequested.value ? '停止收音' : '录音测试',
    active: isRecordingRequested.value,
    busy: false,
    run: () => perception.toggleVoice(),
  },
  {
    key: 'memory',
    icon: '🧠',
    label: '记忆管理',
    active: false,
    busy: false,
    run: () => (generalStore.sideBarView = 'memories'),
  },
])

const handleMicToggle = () => {
  perception.toggleVoice()
}

const backToChat = () => {
  generalStore.sideBarView = 'chat'
}

const loadMemories = async () => {
  if (!window.aliceIPC?.invoke) return
  try {
    const result = await window.aliceIPC.invoke('memory:get', { limit: 200 })
    if (result?.success && Array.isArray(result.data)) {
      memoryCount.value = result.data.length
    }
  } catch (error) {
    console.warn('[Dashboard] 读取记忆数量失败:', error)
  }
}

const probeBackend = async () => {
  try {
    await backendApi.initialize()
    health.value = await backendApi.getHealth()
    healthError.value = null
  } catch (error: any) {
    health.value = null
    healthError.value = error?.message || '本地后端未响应'
  }
}

const refreshAll = async () => {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await Promise.allSettled([
      probeBackend(),
      loadMemories(),
      logStore.refreshSessions(),
    ])
    logEvent('dashboard', 'refreshed', {
      backend: backendReady.value,
      memories: memoryCount.value,
    })
  } finally {
    refreshing.value = false
  }
}

onMounted(() => {
  void refreshAll()
  tickTimer = window.setInterval(() => {
    nowTick.value = Date.now()
  }, 30_000)
})

onUnmounted(() => {
  if (tickTimer !== null) {
    window.clearInterval(tickTimer)
    tickTimer = null
  }
})

function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString()
}
</script>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: rgb(2 6 23 / 0.55);
}

.dash-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid rgb(148 163 184 / 0.16);
  background: rgb(15 23 42 / 0.85);
}

.head-titles {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.head-title {
  font-size: 12px;
  font-weight: 600;
  color: rgb(226 232 240);
}

.head-sub {
  font-size: 10px;
  color: rgb(100 116 139);
}

.head-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.head-btn {
  font-size: 11px;
  color: rgb(148 163 184);
  background: transparent;
  border: 1px solid rgb(148 163 184 / 0.22);
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}

.head-btn:hover:not(:disabled) {
  color: rgb(226 232 240);
  background: rgb(148 163 184 / 0.12);
}

.head-btn:disabled {
  opacity: 0.5;
  cursor: progress;
}

.dash-body {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scrollbar-width: thin;
  /* 用容器宽度而不是窗口宽度决定列数：侧栏宽了才铺满一行 */
  container-type: inline-size;
}

.dash-body::-webkit-scrollbar {
  width: 6px;
}

.dash-body::-webkit-scrollbar-thumb {
  background: rgb(71 85 105 / 0.7);
  border-radius: 3px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

/* 窗口最大化 / 侧栏够宽时，六张状态卡并排一行 */
@container (min-width: 880px) {
  .stat-grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}

.card-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  align-items: start;
}

@container (min-width: 640px) {
  .card-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.pill {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid transparent;
}

.pill-on {
  color: rgb(167 243 208);
  background: rgb(16 185 129 / 0.16);
  border-color: rgb(16 185 129 / 0.4);
}

.pill-off {
  color: rgb(203 213 225);
  background: rgb(100 116 139 / 0.18);
  border-color: rgb(148 163 184 / 0.3);
}

.sensor-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.sensor-row {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  min-width: 0;
}

.sensor-icon {
  width: 14px;
  text-align: center;
  opacity: 0.85;
}

.sensor-label {
  color: rgb(203 213 225);
  flex: 0 0 auto;
}

.sensor-state {
  font-size: 10px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid transparent;
}

.state-on {
  color: rgb(167 243 208);
  background: rgb(16 185 129 / 0.14);
  border-color: rgb(16 185 129 / 0.35);
}

.state-off {
  color: rgb(148 163 184);
  background: rgb(100 116 139 / 0.14);
  border-color: rgb(148 163 184 / 0.28);
}

.sensor-last {
  margin-left: auto;
  font-size: 10px;
  color: rgb(100 116 139);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.divider {
  height: 1px;
  background: rgb(148 163 184 / 0.14);
  margin: 2px 0;
}

.toggle-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}

.toggle-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.toggle-label {
  font-size: 11px;
  color: rgb(203 213 225);
}

.toggle-hint {
  font-size: 10px;
  color: rgb(100 116 139);
  line-height: 1.5;
}

.toggle {
  margin-left: auto;
  appearance: none;
  width: 34px;
  height: 18px;
  border-radius: 999px;
  background: rgb(51 65 85);
  border: 1px solid rgb(148 163 184 / 0.3);
  position: relative;
  cursor: pointer;
  flex: 0 0 auto;
  transition: background 0.15s ease;
}

.toggle::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: rgb(203 213 225);
  transition: transform 0.15s ease;
}

.toggle:checked {
  background: rgb(56 189 248 / 0.8);
  border-color: rgb(56 189 248 / 0.6);
}

.toggle:checked::after {
  transform: translateX(16px);
  background: rgb(240 249 255);
}

.kv-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.kv-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  min-width: 0;
}

.kv-key {
  color: rgb(148 163 184);
  flex: 0 0 auto;
}

.kv-value {
  margin-left: auto;
  color: rgb(226 232 240);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 65%;
}

.empty {
  font-size: 11px;
  color: rgb(100 116 139);
  line-height: 1.7;
  padding: 6px 0;
}

.timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 260px;
  overflow-y: auto;
  scrollbar-width: thin;
}

.timeline-item {
  display: flex;
  gap: 7px;
  min-width: 0;
}

.timeline-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  margin-top: 5px;
  flex: 0 0 auto;
  background: rgb(100 116 139);
}

.timeline-main {
  min-width: 0;
  flex: 1 1 auto;
}

.timeline-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.kind-chip {
  font-size: 9px;
  padding: 0 5px;
  border-radius: 999px;
  background: rgb(100 116 139 / 0.18);
  border: 1px solid rgb(148 163 184 / 0.28);
  color: rgb(203 213 225);
}

.timeline-time {
  font-size: 10px;
  color: rgb(100 116 139);
}

.timeline-summary {
  font-size: 11px;
  color: rgb(203 213 225);
  line-height: 1.55;
  word-break: break-word;
}

.kind-screen.timeline-dot,
.kind-screen.kind-chip {
  color: rgb(186 230 253);
  border-color: rgb(56 189 248 / 0.45);
  background: rgb(56 189 248 / 0.16);
}
.kind-camera.timeline-dot,
.kind-camera.kind-chip {
  color: rgb(221 214 254);
  border-color: rgb(167 139 250 / 0.45);
  background: rgb(167 139 250 / 0.16);
}
.kind-audio.timeline-dot,
.kind-audio.kind-chip {
  color: rgb(167 243 208);
  border-color: rgb(16 185 129 / 0.45);
  background: rgb(16 185 129 / 0.16);
}
.kind-chat.timeline-dot,
.kind-chat.kind-chip {
  color: rgb(253 230 138);
  border-color: rgb(250 204 21 / 0.45);
  background: rgb(250 204 21 / 0.16);
}
.kind-system.timeline-dot,
.kind-system.kind-chip {
  color: rgb(203 213 225);
  border-color: rgb(148 163 184 / 0.45);
  background: rgb(148 163 184 / 0.16);
}

.test-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.test-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-size: 11px;
  color: rgb(203 213 225);
  background: rgb(30 41 59 / 0.7);
  border: 1px solid rgb(148 163 184 / 0.22);
  border-radius: 8px;
  padding: 6px 8px;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    color 0.15s ease;
}

.test-btn:hover:not(:disabled) {
  color: rgb(224 242 254);
  border-color: rgb(56 189 248 / 0.5);
}

.test-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.test-btn-on {
  color: rgb(125 211 252);
  border-color: rgb(56 189 248 / 0.55);
  background: rgb(56 189 248 / 0.14);
}

.test-icon {
  font-size: 12px;
  line-height: 1;
}

.mini-btn {
  font-size: 10px;
  color: rgb(148 163 184);
  background: transparent;
  border: 1px solid rgb(148 163 184 / 0.22);
  border-radius: 6px;
  padding: 1px 6px;
  cursor: pointer;
}

.mini-btn:hover:not(:disabled) {
  color: rgb(226 232 240);
  background: rgb(148 163 184 / 0.12);
}

.mini-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
