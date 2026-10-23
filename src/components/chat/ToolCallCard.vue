<template>
  <div class="tool-card" :class="`tool-card-${tool.status}`">
    <button class="tool-head" @click="expanded = !expanded">
      <span class="tool-dot" aria-hidden="true">
        {{ tool.status === 'success' ? '✓' : tool.status === 'error' ? '✕' : '◌' }}
      </span>
      <span class="tool-name">{{ toolLabel(tool.name) }}</span>
      <code class="tool-raw">{{ tool.name }}</code>
      <span class="tool-preview">{{ preview }}</span>
      <span class="tool-toggle" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
    </button>

    <div v-if="screenshot" class="tool-shot">
      <img
        :src="screenshot.dataUrl"
        alt="截图预览"
        class="tool-shot-img"
        title="点击打开原图"
        @click="openScreenshot"
      />
      <div class="tool-shot-meta">
        <span class="tool-shot-size">
          {{ screenshot.displayName }} · {{ screenshot.width }}×{{ screenshot.height }}
        </span>
        <button class="tool-shot-open" @click="openScreenshot">打开原图</button>
      </div>
      <div class="tool-shot-path" :title="screenshot.savedPath">
        {{ screenshot.savedPath }}
      </div>
    </div>

    <div v-if="expanded" class="tool-body">
      <div v-if="tool.statusText" class="tool-section">
        <div class="tool-section-title">执行状态</div>
        <div class="tool-status-text">{{ tool.statusText }}</div>
      </div>
      <div v-if="tool.args" class="tool-section">
        <div class="tool-section-title">调用参数</div>
        <pre class="tool-pre">{{ tool.args }}</pre>
      </div>
      <div class="tool-section">
        <div class="tool-section-title">返回结果</div>
        <pre class="tool-pre">{{ displayResult }}</pre>
        <button
          v-if="isTruncated"
          class="tool-more"
          @click.stop="showFull = !showFull"
        >
          {{ showFull ? '收起' : `展开全部（${tool.result.length} 字符）` }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ToolCallDisplay } from '../../utils/chatDisplay'
import { toolLabel } from '../../utils/toolLabels'
import { useGeneralStore } from '../../stores/generalStore'

const props = defineProps<{ tool: ToolCallDisplay }>()

const generalStore = useGeneralStore()

const normalizePath = (value: string) =>
  value.replace(/\\+/g, '/').toLowerCase()

/**
 * 工具结果里只有文本，缩略图从 store 里取"最近一次截图"，
 * 并且要求结果文本里出现了同一路径，避免把旧截图挂到新卡片上。
 */
const screenshot = computed(() => {
  if (props.tool.name !== 'take_screenshot') return null
  if (!props.tool.result) return null

  const result = normalizePath(props.tool.result)
  for (const record of Object.values(generalStore.screenshotRecords)) {
    if (record?.dataUrl && record.savedPath) {
      if (result.includes(normalizePath(record.savedPath))) return record
    }
  }

  const last = generalStore.lastScreenshot
  if (
    last?.dataUrl &&
    last.savedPath &&
    result.includes(normalizePath(last.savedPath))
  ) {
    return last
  }
  return null
})

const openScreenshot = () => {
  const savedPath = screenshot.value?.savedPath
  if (!savedPath || typeof window === 'undefined' || !window.aliceIPC) return
  window.aliceIPC
    .invoke('electron:open-path', { target: savedPath.replace(/\\/g, '/') })
    .catch(error => console.error('打开截图失败:', error))
}

const RESULT_PREVIEW_LIMIT = 1200

const expanded = ref(props.tool.status === 'error')
const showFull = ref(false)

const isTruncated = computed(
  () => props.tool.result.length > RESULT_PREVIEW_LIMIT
)

const displayResult = computed(() => {
  const result = props.tool.result || '（无输出）'
  if (showFull.value || !isTruncated.value) return result
  return `${result.slice(0, RESULT_PREVIEW_LIMIT)}\n…`
})

const preview = computed(() => {
  const raw = (props.tool.result || props.tool.statusText || '').replace(
    /\s+/g,
    ' '
  )
  if (!raw) return ''
  return raw.length > 46 ? `${raw.slice(0, 46)}…` : raw
})
</script>

<style scoped>
.tool-card {
  border-radius: 10px;
  border: 1px solid rgb(148 163 184 / 0.22);
  background: rgb(15 23 42 / 0.72);
  overflow: hidden;
  font-size: 12px;
}

.tool-card-error {
  border-color: rgb(248 113 113 / 0.4);
  background: rgb(69 10 10 / 0.35);
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  border: none;
  color: rgb(203 213 225);
  cursor: pointer;
  text-align: left;
}

.tool-head:hover {
  background: rgb(148 163 184 / 0.08);
}

.tool-dot {
  width: 14px;
  text-align: center;
  color: rgb(52 211 153);
  font-size: 11px;
}

.tool-card-error .tool-dot {
  color: rgb(248 113 113);
}

.tool-name {
  font-weight: 600;
  white-space: nowrap;
}

.tool-raw {
  font-size: 10px;
  color: rgb(100 116 139);
  background: rgb(2 6 23 / 0.5);
  border-radius: 4px;
  padding: 0 4px;
}

.tool-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(148 163 184);
}

.tool-toggle {
  color: rgb(100 116 139);
  font-size: 10px;
}

.tool-body {
  border-top: 1px solid rgb(148 163 184 / 0.16);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tool-section-title {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgb(100 116 139);
  margin-bottom: 3px;
}

.tool-status-text {
  color: rgb(203 213 225);
}

.tool-pre {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
  line-height: 1.5;
  color: rgb(203 213 225);
  background: rgb(2 6 23 / 0.6);
  border-radius: 6px;
  padding: 6px 8px;
}

.tool-more {
  margin-top: 4px;
  font-size: 11px;
  color: rgb(96 165 250);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0;
}

.tool-shot {
  border-top: 1px solid rgb(148 163 184 / 0.16);
  padding: 6px 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tool-shot-img {
  width: 100%;
  max-height: 220px;
  object-fit: contain;
  border-radius: 6px;
  border: 1px solid rgb(148 163 184 / 0.25);
  background: rgb(2 6 23 / 0.6);
  cursor: pointer;
}

.tool-shot-img:hover {
  border-color: rgb(56 189 248 / 0.5);
}

.tool-shot-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: rgb(148 163 184);
}

.tool-shot-size {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-shot-open {
  margin-left: auto;
  font-size: 10px;
  color: rgb(96 165 250);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0;
}

.tool-shot-path {
  font-size: 9px;
  color: rgb(100 116 139);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
