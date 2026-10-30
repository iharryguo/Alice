<template>
  <div class="dash-stat" :class="`tone-${tone}`">
    <div class="stat-head">
      <span class="stat-icon">{{ icon }}</span>
      <span class="stat-label">{{ label }}</span>
    </div>
    <div class="stat-value" :title="title || value">{{ value }}</div>
    <div v-if="hint" class="stat-hint" :title="hint">{{ hint }}</div>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string
    value: string
    hint?: string
    icon?: string
    tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent'
    title?: string
  }>(),
  { tone: 'neutral', icon: '•', hint: '', title: '' }
)
</script>

<style scoped>
.dash-stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  padding: 9px 11px;
  border-radius: 12px;
  border: 1px solid rgb(148 163 184 / 0.18);
  border-left-width: 3px;
  background: rgb(15 23 42 / 0.72);
}

.stat-head {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.stat-icon {
  font-size: 11px;
  line-height: 1;
  color: rgb(148 163 184);
}

.stat-label {
  font-size: 10px;
  color: rgb(148 163 184);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stat-value {
  font-size: 13px;
  font-weight: 600;
  color: rgb(236 241 247);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stat-hint {
  font-size: 10px;
  color: rgb(100 116 139);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tone-neutral {
  border-left-color: rgb(100 116 139);
}
.tone-success {
  border-left-color: rgb(52 211 153);
}
.tone-warning {
  border-left-color: rgb(251 191 36);
}
.tone-danger {
  border-left-color: rgb(248 113 113);
}
.tone-info {
  border-left-color: rgb(56 189 248);
}
.tone-accent {
  border-left-color: rgb(167 139 250);
}
</style>
