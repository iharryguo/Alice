<template>
  <div v-if="request" class="approval" role="alertdialog" aria-live="assertive">
    <div class="approval-head">
      <span class="approval-icon" aria-hidden="true">🛡</span>
      <span class="approval-title">{{ request.title }}</span>
      <span v-if="queueLength > 1" class="approval-count">
        还有 {{ queueLength - 1 }} 条待批
      </span>
    </div>

    <pre class="approval-detail">{{ truncatedDetail }}</pre>

    <div class="approval-actions">
      <button class="btn-ghost" @click="respond('deny')">拒绝</button>
      <button class="btn-soft" @click="respond('once')">仅本次</button>
      <button class="btn-soft" @click="respond('session')">本次会话</button>
      <button class="btn-primary" @click="respond('always')">永久允许</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useApprovalStore, type ApprovalDecision } from '../../stores/approvalStore'

const approvalStore = useApprovalStore()
const { current: request, queue } = storeToRefs(approvalStore)

const queueLength = computed(() => queue.value.length)

const truncatedDetail = computed(() => {
  const detail = request.value?.detail || ''
  return detail.length > 1600 ? `${detail.slice(0, 1600)}\n…（已截断）` : detail
})

const respond = (decision: ApprovalDecision) => {
  approvalStore.respondCurrent(decision)
}
</script>

<style scoped>
.approval {
  flex: 0 0 auto;
  margin: 0 10px 8px;
  border: 1px solid rgb(251 191 36 / 0.55);
  background: rgb(69 47 12 / 0.92);
  border-radius: 10px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.35);
}

.approval-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: rgb(253 230 138);
  font-weight: 600;
}

.approval-count {
  margin-left: auto;
  font-weight: 400;
  font-size: 10px;
  color: rgb(251 191 36 / 0.8);
}

.approval-detail {
  margin: 0;
  max-height: 130px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
  line-height: 1.5;
  color: rgb(254 243 199);
  background: rgb(2 6 23 / 0.55);
  border-radius: 6px;
  padding: 6px 8px;
}

.approval-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.approval-actions button {
  font-size: 11px;
  border-radius: 7px;
  padding: 3px 10px;
  cursor: pointer;
  border: 1px solid transparent;
}

.btn-ghost {
  background: transparent;
  border-color: rgb(251 191 36 / 0.35);
  color: rgb(253 230 138);
}

.btn-soft {
  background: rgb(251 191 36 / 0.16);
  border-color: rgb(251 191 36 / 0.4);
  color: rgb(254 243 199);
}

.btn-primary {
  background: rgb(251 191 36);
  color: rgb(69 26 3);
  font-weight: 600;
}

.approval-actions button:hover {
  filter: brightness(1.12);
}
</style>
