import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

/**
 * 感知观察记录：仪表盘「最近观察」的数据源。
 *
 * 只保留最近 30 条，落在 localStorage 里 —— 重启之后仪表盘不该是空白的，
 * 但也没必要为这种可丢弃的记录建表。
 */
export type ObservationKind = 'screen' | 'camera' | 'audio' | 'chat' | 'system'

export interface Observation {
  id: string
  kind: ObservationKind
  summary: string
  timestamp: number
}

const STORAGE_KEY = 'alice:observations:v1'
const MAX_OBSERVATIONS = 30

function loadFromStorage(): Observation[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item: any) =>
          item &&
          typeof item.summary === 'string' &&
          typeof item.timestamp === 'number'
      )
      .slice(0, MAX_OBSERVATIONS)
  } catch {
    return []
  }
}

export const useObservationStore = defineStore('observation', () => {
  const observations = ref<Observation[]>(loadFromStorage())

  const persist = () => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(observations.value)
      )
    } catch {
      // 存储不可用时只保留内存记录
    }
  }

  const observe = (kind: ObservationKind, summary: string) => {
    const text = String(summary || '').trim()
    if (!text) return
    observations.value = [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind,
        summary: text.length > 220 ? `${text.slice(0, 220)}…` : text,
        timestamp: Date.now(),
      },
      ...observations.value,
    ].slice(0, MAX_OBSERVATIONS)
    persist()
  }

  const lastAt = (kind: ObservationKind): number | null =>
    observations.value.find(item => item.kind === kind)?.timestamp ?? null

  const countOf = (kind: ObservationKind): number =>
    observations.value.filter(item => item.kind === kind).length

  const total = computed(() => observations.value.length)

  const clear = () => {
    observations.value = []
    persist()
  }

  return {
    observations,
    total,
    observe,
    lastAt,
    countOf,
    clear,
  }
})
