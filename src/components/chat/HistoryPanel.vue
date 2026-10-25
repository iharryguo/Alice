<template>
  <div class="history">
    <div class="history-head">
      <span class="history-title">历史对话</span>
      <button class="head-btn" title="新建对话" @click="handleNewSession">
        ＋ 新对话
      </button>
      <button class="head-btn head-btn-close" title="关闭" @click="$emit('close')">
        ✕
      </button>
    </div>

    <div class="history-search">
      <input
        v-model="query"
        class="search-input"
        type="search"
        placeholder="搜索对话内容…"
        @input="handleSearchInput"
      />
      <button v-if="query" class="search-clear" @click="clearSearch">✕</button>
    </div>

    <div class="history-body">
      <div v-if="isLoading" class="history-empty">加载中…</div>

      <template v-else-if="query.trim()">
        <div v-if="searchResults.length === 0" class="history-empty">
          没有匹配「{{ query.trim() }}」的消息
        </div>
        <button
          v-for="hit in searchResults"
          :key="`${hit.sessionId}-${hit.createdAt}`"
          class="hit-row"
          @click="openSession(hit.sessionId)"
        >
          <div class="hit-head">
            <span class="hit-title">{{ hit.title }}</span>
            <span class="hit-time">{{ formatStamp(hit.createdAt) }}</span>
          </div>
          <div class="hit-snippet">{{ hit.snippet }}</div>
        </button>
      </template>

      <template v-else>
        <div v-if="groups.length === 0" class="history-empty">
          还没有历史对话。聊几句之后这里会自动出现。
          <div v-if="error" class="history-error">上次保存失败：{{ error }}</div>
        </div>
        <div v-for="group in groups" :key="group.label" class="history-group">
          <div class="group-label">{{ group.label }}</div>
          <div
            v-for="session in group.sessions"
            :key="session.id"
            class="session-row"
            :class="{ 'session-row-active': session.id === currentSessionId }"
          >
            <button class="session-main" @click="openSession(session.id)">
              <div class="session-head">
                <span class="session-title">{{ session.title }}</span>
                <span class="session-time">{{ formatStamp(session.updatedAt) }}</span>
              </div>
              <div class="session-preview">{{ session.preview || '（无文本内容）' }}</div>
              <div class="session-meta">{{ session.messageCount }} 条消息</div>
            </button>
            <button
              class="session-delete"
              title="删除这条会话"
              @click.stop="handleDelete(session.id, session.title)"
            >
              🗑
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useConversationLogStore } from '../../stores/conversationLogStore'
import { formatDateLabel } from '../../utils/chatDisplay'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'restored'): void
}>()

const logStore = useConversationLogStore()
const { sessions, searchResults, isLoading, sessionId, error } =
  storeToRefs(logStore)

const query = ref('')
const currentSessionId = computed(() => sessionId.value)

const groups = computed(() => {
  const sorted = [...sessions.value].sort((a, b) => b.updatedAt - a.updatedAt)
  const map = new Map<string, typeof sorted>()
  for (const session of sorted) {
    const label = formatDateLabel(session.updatedAt)
    const bucket = map.get(label) || []
    bucket.push(session)
    map.set(label, bucket)
  }
  return [...map.entries()].map(([label, items]) => ({
    label,
    sessions: items,
  }))
})

let searchTimer: number | null = null
const handleSearchInput = () => {
  if (searchTimer !== null) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    void logStore.search(query.value)
  }, 250)
}

const clearSearch = () => {
  query.value = ''
  void logStore.search('')
}

const formatStamp = (timestamp: number) => {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const openSession = async (id: string) => {
  const ok = await logStore.loadSession(id)
  if (ok) {
    query.value = ''
    emit('restored')
    emit('close')
  }
}

const handleNewSession = async () => {
  await logStore.startNewSession()
  query.value = ''
  emit('restored')
  emit('close')
}

const handleDelete = async (id: string, title: string) => {
  const confirmed = window.confirm(`删除会话「${title}」？此操作不可恢复。`)
  if (!confirmed) return
  await logStore.deleteSessionById(id)
}

onMounted(() => {
  void logStore.refreshSessions()
})
</script>

<style scoped>
.history {
  position: absolute;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  background: rgb(2 6 23 / 0.97);
  backdrop-filter: blur(6px);
}

.history-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid rgb(148 163 184 / 0.18);
}

.history-title {
  font-size: 12px;
  font-weight: 600;
  color: rgb(226 232 240);
  margin-right: auto;
}

.head-btn {
  font-size: 11px;
  color: rgb(148 163 184);
  background: transparent;
  border: 1px solid rgb(148 163 184 / 0.25);
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
}

.head-btn:hover {
  color: rgb(226 232 240);
  background: rgb(148 163 184 / 0.12);
}

.history-search {
  position: relative;
  padding: 8px 10px 4px;
}

.search-input {
  width: 100%;
  font-size: 12px;
  color: rgb(226 232 240);
  background: rgb(15 23 42 / 0.9);
  border: 1px solid rgb(148 163 184 / 0.25);
  border-radius: 8px;
  padding: 5px 26px 5px 9px;
  outline: none;
}

.search-input:focus {
  border-color: rgb(56 189 248 / 0.55);
}

.search-clear {
  position: absolute;
  right: 18px;
  top: 50%;
  transform: translateY(-40%);
  background: transparent;
  border: none;
  color: rgb(100 116 139);
  cursor: pointer;
  font-size: 11px;
}

.history-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 12px;
}

.history-empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 11px;
  color: rgb(100 116 139);
}

.history-error {
  margin-top: 8px;
  color: rgb(248 113 113);
  line-height: 1.5;
}

.history-group {
  margin-bottom: 8px;
}

.group-label {
  font-size: 10px;
  color: rgb(100 116 139);
  padding: 6px 4px 3px;
  letter-spacing: 0.06em;
}

.session-row {
  display: flex;
  align-items: stretch;
  border-radius: 8px;
  border: 1px solid transparent;
}

.session-row:hover {
  background: rgb(30 41 59 / 0.7);
  border-color: rgb(148 163 184 / 0.2);
}

.session-row-active {
  border-color: rgb(56 189 248 / 0.4);
  background: rgb(56 189 248 / 0.08);
}

.session-main {
  flex: 1;
  min-width: 0;
  text-align: left;
  background: transparent;
  border: none;
  color: inherit;
  padding: 6px 8px;
  cursor: pointer;
}

.session-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.session-title {
  font-size: 12px;
  font-weight: 600;
  color: rgb(226 232 240);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-time {
  margin-left: auto;
  font-size: 10px;
  color: rgb(100 116 139);
  white-space: nowrap;
}

.session-preview {
  font-size: 11px;
  color: rgb(148 163 184);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
}

.session-meta {
  font-size: 10px;
  color: rgb(100 116 139);
  margin-top: 2px;
}

.session-delete {
  width: 28px;
  background: transparent;
  border: none;
  color: rgb(100 116 139);
  cursor: pointer;
  font-size: 11px;
  opacity: 0;
}

.session-row:hover .session-delete {
  opacity: 1;
  color: rgb(248 113 113);
}

.hit-row {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 1px solid rgb(148 163 184 / 0.16);
  border-radius: 8px;
  padding: 6px 8px;
  margin-bottom: 5px;
  cursor: pointer;
  color: inherit;
}

.hit-row:hover {
  background: rgb(30 41 59 / 0.7);
}

.hit-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.hit-title {
  font-size: 11px;
  font-weight: 600;
  color: rgb(203 213 225);
}

.hit-time {
  margin-left: auto;
  font-size: 10px;
  color: rgb(100 116 139);
}

.hit-snippet {
  font-size: 11px;
  color: rgb(148 163 184);
  margin-top: 2px;
  line-height: 1.45;
}
</style>
