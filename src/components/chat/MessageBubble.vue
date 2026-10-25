<template>
  <div
    class="msg-row group flex w-full"
    :class="isUser ? 'justify-end' : 'justify-start'"
  >
    <div class="msg-stack" :class="isUser ? 'items-end' : 'items-start'">
      <div class="msg-meta" :class="isUser ? 'justify-end' : 'justify-start'">
        <span class="msg-role">{{ roleLabel }}</span>
        <span v-if="clock" class="msg-time">{{ clock }}</span>
      </div>

      <div
        class="msg-bubble"
        :class="isUser ? 'msg-bubble-user' : 'msg-bubble-assistant'"
      >
        <div
          class="msg-content"
          v-html="html"
          @click="handleContentClick"
        ></div>
      </div>

      <div v-if="item.toolNames.length" class="msg-tools">
        <span
          v-for="(name, index) in item.toolNames"
          :key="`${name}-${index}`"
          class="tool-chip"
        >
          {{ toolLabel(name) }}
        </span>
      </div>

      <div class="msg-actions" :class="isUser ? 'justify-end' : 'justify-start'">
        <button
          v-if="item.text"
          class="msg-action"
          :class="{ 'msg-action-active': isSpeaking }"
          :title="isSpeaking ? '停止朗读' : '朗读这条消息'"
          @click="$emit('speak', item.text)"
        >
          <span class="i-speaker" aria-hidden="true">{{ isSpeaking ? '◼' : '🔊' }}</span>
          <span>{{ isSpeaking ? '停止' : '朗读' }}</span>
        </button>
        <button
          v-if="item.text"
          class="msg-action"
          title="复制全文"
          @click="copyText"
        >
          <span aria-hidden="true">{{ copied ? '✓' : '⧉' }}</span>
          <span>{{ copied ? '已复制' : '复制' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MessageDisplayItem } from '../../utils/chatDisplay'
import { formatClock } from '../../utils/chatDisplay'
import { renderMessageContent } from '../../utils/messageRender'
import { toolLabel } from '../../utils/toolLabels'
import { useSettingsStore } from '../../stores/settingsStore'
import { getPersona } from '../../prompts/personas'

const props = defineProps<{
  item: MessageDisplayItem
  isSpeaking?: boolean
}>()

defineEmits<{ (e: 'speak', text: string): void }>()

const copied = ref(false)

const isUser = computed(() => props.item.role === 'user')
const clock = computed(() => formatClock(props.item.time))
const html = computed(() => renderMessageContent(props.item.message))

const settingsStore = useSettingsStore()
const roleLabel = computed(() => {
  if (props.item.role === 'user') return '你'
  if (props.item.role === 'assistant') {
    // 换了身份还显示 Alice，等于当场穿帮
    return getPersona(settingsStore.settings.assistantPersonaId).displayName
  }
  return props.item.role
})

const copyText = async () => {
  try {
    await navigator.clipboard.writeText(props.item.text)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch (error) {
    console.warn('复制失败:', error)
  }
}

const openPathViaIPC = (target: string) => {
  if (!window.aliceIPC) return
  window.aliceIPC
    .invoke('electron:open-path', { target })
    .catch(err => console.error('打开路径失败:', err))
}

const handleContentClick = (event: MouseEvent) => {
  const target = event.target as HTMLElement

  if (target.tagName === 'IMG' && target.classList.contains('generated-alice-image')) {
    const absoluteImagePath = target.getAttribute('data-absolute-path')
    if (absoluteImagePath) {
      event.preventDefault()
      openPathViaIPC(absoluteImagePath.replace(/\\/g, '/'))
    }
    return
  }

  let element: HTMLElement | null = target
  for (let i = 0; i < 3 && element && element !== event.currentTarget; i++) {
    if (element.tagName === 'A') {
      const href = element.getAttribute('href')
      if (
        href &&
        (href.startsWith('http://') ||
          href.startsWith('https://') ||
          href.startsWith('mailto:'))
      ) {
        event.preventDefault()
        openPathViaIPC(href)
        return
      }
    }
    element = element.parentElement
  }
}
</script>

<style scoped>
.msg-stack {
  display: flex;
  flex-direction: column;
  max-width: 92%;
  gap: 2px;
}

.msg-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: rgb(148 163 184 / 0.85);
  padding: 0 4px;
}

.msg-role {
  font-weight: 600;
  letter-spacing: 0.02em;
}

.msg-time {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}

.msg-bubble {
  border-radius: 14px;
  padding: 8px 12px;
  /* 五号字大小：正文太小是阅读负担，尤其长回复 */
  font-size: 15px;
  line-height: 1.65;
  word-break: break-word;
  overflow-wrap: anywhere;
  border: 1px solid transparent;
}

.msg-bubble-user {
  background: rgb(56 189 248 / 0.16);
  border-color: rgb(56 189 248 / 0.32);
  color: rgb(240 249 255);
  border-bottom-right-radius: 4px;
}

.msg-bubble-assistant {
  background: rgb(30 41 59 / 0.82);
  border-color: rgb(148 163 184 / 0.16);
  color: rgb(226 232 240);
  border-bottom-left-radius: 4px;
}

.msg-content :deep(p) {
  margin: 0 0 6px;
}
.msg-content :deep(p:last-child) {
  margin-bottom: 0;
}
.msg-content :deep(ul),
.msg-content :deep(ol) {
  margin: 4px 0 6px 18px;
  list-style: disc;
}
.msg-content :deep(pre) {
  background: rgb(2 6 23 / 0.85);
  border-radius: 8px;
  padding: 8px 10px;
  margin: 6px 0;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
}
.msg-content :deep(code) {
  background: rgb(2 6 23 / 0.6);
  border-radius: 4px;
  padding: 1px 4px;
  font-size: 13px;
}
.msg-content :deep(pre code) {
  background: transparent;
  padding: 0;
}
.msg-content :deep(a) {
  color: rgb(96 165 250);
  text-decoration: underline;
}
.msg-content :deep(table) {
  border-collapse: collapse;
  margin: 6px 0;
  font-size: 13px;
}
.msg-content :deep(th),
.msg-content :deep(td) {
  border: 1px solid rgb(148 163 184 / 0.3);
  padding: 3px 6px;
}

.msg-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 4px;
}

.tool-chip {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgb(16 185 129 / 0.14);
  border: 1px solid rgb(16 185 129 / 0.3);
  color: rgb(167 243 208);
}

.msg-actions {
  display: flex;
  gap: 4px;
  padding: 0 4px;
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 0.15s ease;
}

.msg-row:hover .msg-actions,
.msg-row:focus-within .msg-actions {
  opacity: 1;
}

.msg-action {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  color: rgb(148 163 184);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 4px;
}

.msg-action:hover {
  color: rgb(226 232 240);
  background: rgb(148 163 184 / 0.14);
}

.msg-action-active {
  color: rgb(52 211 153);
}

.msg-action-active:hover {
  color: rgb(110 231 183);
}
</style>
