import { ipcMain } from 'electron'
import {
  cancelVolcengineTts,
  synthesizeVolcengineTts,
  type VolcengineTtsRequest,
} from './volcengineTts'
import { writeAppLog } from '../teaching/logger'

/**
 * 火山引擎 TTS 的 IPC 入口。
 *
 * 渲染层只传文本、音色和语气，凭据由渲染层从设置里带过来（设置本身存在加密区），
 * 主进程不额外持久化。
 */
export function registerVolcengineTtsHandlers(): void {
  ipcMain.handle(
    'tts:volcengine:synthesize',
    async (_event, payload: VolcengineTtsRequest) => {
      try {
        if (!payload?.text?.trim()) {
          return { success: false, error: '待合成文本为空' }
        }
        const result = await synthesizeVolcengineTts(payload)
        return {
          success: true,
          audio: result.audio,
          mime: result.mime,
          requestId: result.requestId,
        }
      } catch (error) {
        const message = (error as Error)?.message ?? String(error)
        writeAppLog({
          module: 'tts',
          level: 'warn',
          event: 'volcengine.ipc_failed',
          data: { message },
        })
        return { success: false, error: message }
      }
    }
  )

  ipcMain.handle('tts:volcengine:cancel', async (_event, payload: { requestId?: string }) => {
    const requestId = String(payload?.requestId || '')
    if (!requestId) return { success: false }
    return { success: cancelVolcengineTts(requestId) }
  })
}
