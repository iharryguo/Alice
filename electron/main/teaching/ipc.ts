import { dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs/promises'
import { getMainWindow } from '../windowManager'
import { importTeachingMaterial } from './materials'
import {
  teachingLogDir,
  teachingLogPath,
  writeAppLog,
} from './logger'
import {
  appendStep,
  confirmCourseVersion,
  createSession,
  deleteMaterial,
  getCourseVersion,
  getLatestContract,
  getLatestStep,
  getMaterial,
  getSession,
  insertCourseVersion,
  listAllCourseVersions,
  listAnchors,
  listAttempts,
  listMastery,
  listMaterials,
  listPages,
  listResumableSessions,
  pauseActiveSessions,
  saveAttempt,
  saveContract,
  updatePageText,
  updateSession,
  upsertMastery,
  initializeTeachingDB,
} from './store'
import type {
  ClassContract,
  ClassSession,
  CourseVersionRecord,
  ExerciseAttempt,
  TeachingStepRecord,
} from './types'

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

  /**
   * 渲染层的课堂日志入口。界面把它当"写一行日志"用，不关心文件位置；
   * 出错时用户只要把 logs 目录里的文件发出来即可。
   */
  ipcMain.handle(
    'app:log',
    async (
      _event,
      payload: {
        level?: 'debug' | 'info' | 'warn' | 'error'
        module?: string
        event: string
        seq?: number
        data?: Record<string, unknown>
      }
    ) => {
      if (!payload?.event) return { success: false }
      writeAppLog(payload)
      return { success: true }
    }
  )

  // 兼容旧通道名，课堂模块仍在用
  ipcMain.handle(
    'teaching:log',
    async (_event, payload: { event: string; data?: Record<string, unknown> }) => {
      if (!payload?.event) return { success: false }
      writeAppLog({ module: 'teaching', event: payload.event, data: payload.data })
      return { success: true }
    }
  )

  ipcMain.handle('teaching:log-path', async () => {
    try {
      return { success: true, data: teachingLogPath() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('teaching:open-log-folder', async () => {
    try {
      await shell.openPath(teachingLogDir())
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

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

  /**
   * 把转换后的 PDF 原文件交给渲染层自己用 pdfjs 渲染。
   * 不做服务端页面截图：渲染在浏览器里更省内存，缩放也不糊。
   */
  ipcMain.handle(
    'teaching:material:blob',
    async (_event, payload: { materialId: string }) => {
      try {
        const material = getMaterial(payload?.materialId)
        if (!material) return { success: false, error: '材料不存在' }

        const filePath = material.documentPath || material.sourcePath
        const buffer = await fs.readFile(filePath)
        return {
          success: true,
          data: {
            bytes: new Uint8Array(buffer),
            isPdf: !!material.documentPath,
            sourceType: material.sourceType,
          },
        }
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
    'teaching:material:update-page-text',
    async (
      _event,
      payload: { materialId: string; pageIndex: number; text: string }
    ) => {
      try {
        updatePageText(payload.materialId, payload.pageIndex, payload.text)
        return { success: true }
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

  ipcMain.handle('teaching:course:list', async () => {
    try {
      return { success: true, data: listAllCourseVersions() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'teaching:course:create',
    async (_event, payload: { record: CourseVersionRecord }) => {
      try {
        insertCourseVersion(payload.record)
        return { success: true, data: payload.record.courseVersionId }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:course:confirm',
    async (_event, payload: { courseVersionId: string }) => {
      try {
        confirmCourseVersion(payload.courseVersionId)
        return { success: true }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:contract:save',
    async (_event, payload: { contract: ClassContract }) => {
      try {
        saveContract(payload.contract)
        return { success: true }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:contract:latest',
    async (_event, payload: { courseVersionId: string }) => {
      try {
        return {
          success: true,
          data: getLatestContract(payload.courseVersionId),
        }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:session:create',
    async (_event, payload: { session: ClassSession }) => {
      try {
        createSession(payload.session)
        return { success: true, data: payload.session.sessionId }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:session:update',
    async (
      _event,
      payload: { sessionId: string; patch: Partial<ClassSession> }
    ) => {
      try {
        updateSession(payload.sessionId, payload.patch)
        return { success: true }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:session:get',
    async (_event, payload: { sessionId: string }) => {
      try {
        return { success: true, data: getSession(payload.sessionId) }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle('teaching:session:pause-active', async () => {
    try {
      pauseActiveSessions()
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('teaching:session:resumable', async () => {
    try {
      return { success: true, data: listResumableSessions() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'teaching:step:append',
    async (_event, payload: { step: TeachingStepRecord }) => {
      try {
        appendStep(payload.step)
        return { success: true }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:step:latest',
    async (_event, payload: { sessionId: string }) => {
      try {
        return { success: true, data: getLatestStep(payload.sessionId) }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:attempt:save',
    async (_event, payload: { attempt: ExerciseAttempt }) => {
      try {
        saveAttempt(payload.attempt)
        return { success: true }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:attempt:list',
    async (_event, payload: { sessionId: string }) => {
      try {
        return { success: true, data: listAttempts(payload.sessionId) }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:mastery:upsert',
    async (
      _event,
      payload: {
        objectiveId: string
        courseId: string
        level: 'unknown' | 'learning' | 'needs-review' | 'mastered'
        evidenceAttemptIds: string[]
        selfAssessment?: string | null
        nextReviewAt?: string | null
      }
    ) => {
      try {
        upsertMastery(payload)
        return { success: true }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'teaching:mastery:list',
    async (_event, payload: { courseId: string }) => {
      try {
        return { success: true, data: listMastery(payload.courseId) }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  console.log('[Teaching] IPC handlers registered')
}
