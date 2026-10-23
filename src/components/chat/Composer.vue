<template>
  <div class="composer">
    <div v-if="attachedFile" class="attach-chip">
      <span class="attach-name" :title="attachedFile.name">📎 {{ attachedFile.name }}</span>
      <button class="attach-remove" title="移除附件" @click="clearAttachedFile">✕</button>
    </div>

    <div class="composer-box" :class="{ 'composer-box-busy': isBusy }">
      <textarea
        ref="textareaRef"
        v-model="draft"
        class="composer-input"
        rows="1"
        :placeholder="placeholder"
        :disabled="disabled"
        @keydown="handleKeydown"
        @input="autoGrow"
      ></textarea>

      <div class="composer-bar">
        <div class="composer-left">
          <button
            class="bar-btn"
            title="附加 PDF"
            :disabled="disabled"
            @click="triggerFileUpload"
          >
            📎
          </button>

          <button
            class="bar-btn bar-btn-mic"
            :class="{ 'bar-btn-on': isRecording }"
            :title="isRecording ? '关闭麦克风（VAD 自动断句）' : '开启麦克风（VAD 自动断句）'"
            :disabled="disabled"
            @click="$emit('toggle-recording')"
          >
            <span class="mic-glyph" :class="{ 'mic-live': isRecording }">🎙</span>
            <span class="bar-label">{{ isRecording ? '聆听中' : '语音' }}</span>
          </button>

          <button
            class="bar-btn"
            :class="{ 'bar-btn-on': ttsEnabled }"
            :title="ttsEnabled ? '关闭语音输出' : '开启语音输出'"
            @click="$emit('toggle-tts')"
          >
            {{ ttsEnabled ? '🔊' : '🔇' }}
            <span class="bar-label">语音输出</span>
          </button>

          <button
            class="bar-btn"
            :class="{ 'bar-btn-english': englishMode }"
            :title="englishMode ? '退出英语模式' : '进入英语模式（英文对话 + 纠错）'"
            @click="$emit('toggle-english')"
          >
            {{ englishMode ? 'EN ●' : 'EN' }}
            <span class="bar-label">英语</span>
          </button>
        </div>

        <div class="composer-right">
          <span v-if="statusHint" class="status-hint">{{ statusHint }}</span>
          <button
            v-if="isBusy"
            class="send-btn send-btn-stop"
            title="停止当前回复"
            @click="$emit('stop')"
          >
            停止
          </button>
          <button
            v-else
            class="send-btn"
            :disabled="!canSend"
            title="发送（Enter）"
            @click="submit"
          >
            发送
          </button>
        </div>
      </div>
    </div>

    <input
      ref="fileInput"
      type="file"
      accept=".pdf"
      class="hidden"
      @change="handleFileSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useGeneralStore } from '../../stores/generalStore'

const props = defineProps<{
  disabled?: boolean
  isBusy?: boolean
}>()

const emit = defineEmits<{
  (e: 'send', text: string): void
  (e: 'toggle-recording'): void
  (e: 'toggle-tts'): void
  (e: 'toggle-english'): void
  (e: 'stop'): void
}>()

const generalStore = useGeneralStore()
const { isRecordingRequested, isTTSEnabled, audioState, attachedFile, englishMode } =
  storeToRefs(generalStore)

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const draft = ref('')

const isRecording = computed(
  () =>
    isRecordingRequested.value ||
    audioState.value === 'LISTENING' ||
    audioState.value === 'PROCESSING_AUDIO'
)
const ttsEnabled = computed(() => isTTSEnabled.value)
const canSend = computed(() => draft.value.trim().length > 0 || !!attachedFile.value)

const statusHint = computed(() => {
  if (props.isBusy) return ''
  if (isRecording.value) return '说完会自动断句'
  return ''
})

const placeholder = computed(() =>
  props.disabled
    ? '正在初始化…'
    : englishMode.value
      ? '用英文聊聊，或让 Alice 帮你纠错…（Enter 发送，Shift+Enter 换行）'
      : '说点什么，或让我操作你的电脑…（Enter 发送，Shift+Enter 换行）'
)

const autoGrow = () => {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`
}

const submit = () => {
  if (props.disabled) return
  const text = draft.value.trim()
  if (!text && !attachedFile.value) return
  draft.value = ''
  nextTick(autoGrow)
  emit('send', text)
}

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
  }
}

const triggerFileUpload = () => fileInput.value?.click()

const handleFileSelect = (event: Event) => {
  const target = event.target as HTMLInputElement
  if (target.files && target.files[0]) {
    generalStore.attachedFile = target.files[0]
  }
}

const clearAttachedFile = () => {
  generalStore.attachedFile = null
  if (fileInput.value) fileInput.value.value = ''
}

</script>

<style scoped>
.composer {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 10px;
  background: linear-gradient(to top, rgb(2 6 23 / 0.96), rgb(2 6 23 / 0.7));
  border-top: 1px solid rgb(148 163 184 / 0.18);
}

.attach-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  font-size: 11px;
  color: rgb(203 213 225);
  background: rgb(30 41 59 / 0.9);
  border: 1px solid rgb(148 163 184 / 0.25);
  border-radius: 999px;
  padding: 2px 8px;
  max-width: 100%;
}

.attach-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attach-remove {
  background: transparent;
  border: none;
  color: rgb(148 163 184);
  cursor: pointer;
  font-size: 11px;
  padding: 0;
}

.composer-box {
  border: 1px solid rgb(148 163 184 / 0.25);
  background: rgb(15 23 42 / 0.9);
  border-radius: 12px;
  padding: 6px 8px 4px;
  transition: border-color 0.15s ease;
}

.composer-box:focus-within {
  border-color: rgb(56 189 248 / 0.55);
}

.composer-box-busy {
  border-color: rgb(56 189 248 / 0.3);
}

.composer-input {
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: rgb(241 245 249);
  font-size: 13px;
  line-height: 1.5;
  max-height: 120px;
  padding: 2px 2px 4px;
}

.composer-input::placeholder {
  color: rgb(100 116 139);
}

.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.composer-left {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.bar-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: rgb(148 163 184);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 2px 6px;
  cursor: pointer;
  white-space: nowrap;
}

.bar-btn:hover:not(:disabled) {
  color: rgb(226 232 240);
  background: rgb(148 163 184 / 0.12);
}

.bar-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.bar-btn-on {
  color: rgb(125 211 252);
  background: rgb(56 189 248 / 0.14);
  border-color: rgb(56 189 248 / 0.3);
}

.bar-btn-mic.bar-btn-on {
  color: rgb(110 231 183);
  background: rgb(16 185 129 / 0.16);
  border-color: rgb(16 185 129 / 0.35);
}

.bar-btn-english {
  color: rgb(253 224 71);
  background: rgb(250 204 21 / 0.14);
  border-color: rgb(250 204 21 / 0.3);
}

.mic-live {
  animation: mic-pulse 1.4s ease-in-out infinite;
}

@keyframes mic-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.55;
    transform: scale(1.12);
  }
}

.bar-label {
  font-size: 10px;
}

.composer-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.status-hint {
  font-size: 10px;
  color: rgb(100 116 139);
}

.send-btn {
  font-size: 12px;
  font-weight: 600;
  color: rgb(8 47 73);
  background: rgb(56 189 248);
  border: none;
  border-radius: 8px;
  padding: 4px 12px;
  cursor: pointer;
  transition: filter 0.15s ease;
}

.send-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

.send-btn:disabled {
  background: rgb(51 65 85);
  color: rgb(148 163 184);
  cursor: not-allowed;
}

.send-btn-stop {
  background: rgb(248 113 113);
  color: rgb(69 10 10);
}
</style>
