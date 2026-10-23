import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useGeneralStore } from './generalStore'

export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny'

export interface ApprovalRequest {
  id: string
  kind: 'command' | 'directory' | 'other'
  title: string
  detail: string
  /** 命令名/路径等可用于记忆授权的标识 */
  scope?: string
}

/**
 * 主进程通过 `approval:request` 事件把审批请求推到渲染进程，
 * 渲染进程用 `approval:respond` 回传结果（inline 审批卡片）。
 *
 * 只有聊天面板真的可见时才接单：否则不 ack，主进程会在 2.5 秒后
 * 回退到系统原生弹窗，避免请求卡在一个看不见的卡片上。
 */
export const useApprovalStore = defineStore('approval', () => {
  const queue = ref<ApprovalRequest[]>([])
  let listenerAttached = false

  const current = computed<ApprovalRequest | null>(() => queue.value[0] ?? null)
  const hasPending = computed(() => queue.value.length > 0)

  const ensureListener = () => {
    if (listenerAttached) return
    if (typeof window === 'undefined' || !window.aliceIPC) return
    listenerAttached = true

    window.aliceIPC.on('approval:request', (payload: ApprovalRequest) => {
      if (!payload?.id) return

      const generalStore = useGeneralStore()
      if (!generalStore.openSidebar) return

      if (queue.value.some(item => item.id === payload.id)) return
      queue.value.push(payload)
      void window.aliceIPC
        .invoke('approval:ack', { id: payload.id })
        .catch(error => console.warn('[Approval] ack 失败:', error))
    })
  }

  const respond = async (id: string, decision: ApprovalDecision) => {
    queue.value = queue.value.filter(item => item.id !== id)
    if (typeof window === 'undefined' || !window.aliceIPC) return
    try {
      await window.aliceIPC.invoke('approval:respond', { id, decision })
    } catch (error) {
      console.error('[Approval] 回传审批结果失败:', error)
    }
  }

  const respondCurrent = async (decision: ApprovalDecision) => {
    const request = current.value
    if (!request) return
    await respond(request.id, decision)
  }

  const reset = () => {
    queue.value = []
  }

  return {
    queue,
    current,
    hasPending,
    ensureListener,
    respond,
    respondCurrent,
    reset,
  }
})
