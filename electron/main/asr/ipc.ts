import { ipcMain } from 'electron'
import { transcribeWithVolcengineAsr } from './volcengineAsr'
import { writeAppLog } from '../teaching/logger'

/** 火山识别（录音文件识别）的 IPC 入口 */
export function registerVolcengineAsrHandlers(): void {
  ipcMain.handle(
    'asr:volcengine:transcribe',
    async (
      _event,
      payload: {
        apiKey: string
        audio: Uint8Array | ArrayBuffer | number[]
        resourceId?: string
        language?: string
      }
    ) => {
      try {
        const raw = payload?.audio
        const bytes =
          raw instanceof Uint8Array
            ? raw
            : raw instanceof ArrayBuffer
              ? new Uint8Array(raw)
              : new Uint8Array(raw ?? [])

        const result = await transcribeWithVolcengineAsr({
          apiKey: payload.apiKey,
          audio: bytes,
          resourceId: payload.resourceId,
          language: payload.language,
        })
        return { success: true, text: result.text, durationMs: result.durationMs }
      } catch (error) {
        const message = (error as Error)?.message ?? String(error)
        writeAppLog({
          module: 'asr',
          level: 'warn',
          event: 'volcengine.ipc_failed',
          data: { message },
        })
        return { success: false, error: message }
      }
    }
  )
}
