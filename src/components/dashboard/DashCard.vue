<template>
  <section class="dash-card">
    <header class="card-head">
      <div class="card-titles">
        <span class="card-title">{{ title }}</span>
        <span v-if="hint" class="card-hint">{{ hint }}</span>
      </div>
      <div class="card-actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="card-body">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{ title: string; hint?: string }>()
</script>

<style scoped>
.dash-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-radius: 14px;
  border: 1px solid rgb(148 163 184 / 0.18);
  background: rgb(15 23 42 / 0.66);
  overflow: hidden;
}

.card-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 12px 7px;
  border-bottom: 1px solid rgb(148 163 184 / 0.12);
}

.card-titles {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.card-title {
  font-size: 12px;
  font-weight: 600;
  color: rgb(226 232 240);
}

.card-hint {
  font-size: 10px;
  color: rgb(100 116 139);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.card-body {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
</style>
