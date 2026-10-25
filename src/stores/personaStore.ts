import { ref } from 'vue'
import { defineStore } from 'pinia'
import { logEvent } from '../utils/logger'

/**
 * 人格自己记下的背景细节（"我父亲叫 Dale""我第一次坐飞机是……"）。
 *
 * 存在主进程 SQLite 的 persona_notes 表里，这里只做一个内存缓存：
 * 拼系统提示词是同步的，不能每次现发 IPC 去查。
 */
export const usePersonaStore = defineStore('persona', () => {
  const notes = ref<Record<string, string[]>>({})
  const loadedAt = ref<Record<string, number>>({})
  const isLoading = ref(false)

  const notesFor = (personaId: string): string[] =>
    notes.value[personaId] || []

  async function load(personaId: string, force = false): Promise<string[]> {
    const id = String(personaId || '').trim() || 'alice'
    if (!force && loadedAt.value[id]) return notesFor(id)
    if (!window.aliceIPC) return notesFor(id)

    isLoading.value = true
    try {
      const result = await window.aliceIPC.invoke('persona:notes:list', {
        personaId: id,
      })
      if (result?.success && Array.isArray(result.data)) {
        notes.value = {
          ...notes.value,
          [id]: result.data
            .map((item: any) => String(item?.content || ''))
            .filter(Boolean),
        }
        loadedAt.value = { ...loadedAt.value, [id]: Date.now() }
      }
    } catch (error) {
      logEvent(
        'persona',
        'notes.load.failed',
        { personaId: id, error: error instanceof Error ? error.message : String(error) },
        'warn'
      )
    } finally {
      isLoading.value = false
    }
    return notesFor(id)
  }

  async function remember(personaId: string, content: string): Promise<boolean> {
    const id = String(personaId || '').trim() || 'alice'
    const text = String(content || '').trim()
    if (!text || !window.aliceIPC) return false

    try {
      const result = await window.aliceIPC.invoke('persona:notes:add', {
        personaId: id,
        content: text,
      })
      if (result?.success) {
        notes.value = {
          ...notes.value,
          [id]: [...notesFor(id), text],
        }
        return true
      }
      // 重复内容不算失败：模型重复记录同一条设定是常见且无害的
      if (String(result?.error || '').includes('已经记过')) return true
      return false
    } catch (error) {
      logEvent(
        'persona',
        'notes.save.failed',
        { personaId: id, error: error instanceof Error ? error.message : String(error) },
        'warn'
      )
      return false
    }
  }

  return { notes, isLoading, notesFor, load, remember }
})
