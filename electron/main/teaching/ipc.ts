import { dialog, ipcMain } from 'electron'
import { getMainWindow } from '../windowManager'
import { importTeachingMaterial } from './materials'
import {
  deleteMaterial,
  getMaterial,
  getCourseVersion,
  listAnchors,
  listMaterials,
  listPages,
  initializeTeachingDB,
} from './store'

/**
 * 教师运行时的 IPC 入口。
 *
 * 只做"材料与课程数据的增删查"，不做课堂编排：课堂状态机跑在渲染层，
 * 因为它必须和音频队列、VAD、字幕同一条时间线，放到主进程反而要跨进程同步。
 */

let registered = false

export function registerTeachingHandlers(): void {
  if (registered) return
  registered = true

  initializeTeachingDB()

  ipcMain.handle('teaching:material:pick-and-import', async () => {
    const win = getMainWindow()
    const result = await dialog.showOpenDialog(win ?? undefined, {
      title: '选择教案或教材',
      properties: ['openFile'],
      filters: [
        { name: '教学材料', extensions: ['pdf', 'docx', 'pptx', 'png', 'jpg', 'jpeg', 'webp'] },
      ],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, cancelled: true }
    }

    return importTeachingMaterial({ filePath: result.filePaths[0] })
  })

  ipcMain.handle(
    'teaching:material:import',
    async (_event, payload: { filePath: string; title?: string }) => {
      if (!payload?.filePath) {
        return { success: false, error: '缺少文件路径' }
      }
      return importTeachingMaterial(payload)
    }
  )

  ipcMain.handle('teaching:material:list', async () => {
    try {
      return { success: true, data: listMaterials() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'teaching:material:get',
    async (_event, payload: { materialId: string }) => {
      try {
        const material = getMaterial(payload?.materialId)
        if (!material) return { success: false, error: '材料不存在' }
        return { success: true, data: material }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:material:pages',
    async (_event, payload: { materialId: string }) => {
      try {
        return { success: true, data: listPages(payload?.materialId) }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:material:anchors',
    async (_event, payload: { materialId: string; pageIndex?: number }) => {
      try {
        return {
          success: true,
          data: listAnchors(payload?.materialId, payload?.pageIndex),
        }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:material:delete',
    async (_event, payload: { materialId: string }) => {
      try {
        deleteMaterial(payload?.materialId)
        return { success: true }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:course:version',
    async (_event, payload: { courseVersionId: string }) => {
      try {
        const version = getCourseVersion(payload?.courseVersionId)
        if (!version) return { success: false, error: '课程版本不存在' }
        return { success: true, data: version }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  console.log('[Teaching] IPC handlers registered')
}
