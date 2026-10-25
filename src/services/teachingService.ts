import type {
  ClassContract,
  ClassSession,
  ContentAnchor,
  CourseVersionRecord,
  DocumentPage,
  MaterialRecord,
} from '../../electron/main/teaching/types'

/**
 * 教师模式的渲染层数据入口。
 *
 * 只封装 IPC，不做业务判断：课程编译在 courseCompiler，课堂编排在 lessonRuntime。
 */

interface InvokeResult<T> {
  success: boolean
  data?: T
  error?: string
  cancelled?: boolean
}

function bridge() {
  if (typeof window === 'undefined' || !window.aliceIPC) {
    throw new Error('教师模式需要在桌面应用中运行')
  }
  return window.aliceIPC
}

async function invoke<T>(
  channel: string,
  payload?: Record<string, unknown>
): Promise<InvokeResult<T>> {
  return (await bridge().invoke(channel, payload)) as InvokeResult<T>
}

export interface ImportMaterialResult {
  success: boolean
  material?: MaterialRecord
  reused?: boolean
  error?: string
  cancelled?: boolean
}

export async function pickAndImportMaterial(): Promise<ImportMaterialResult> {
  return (await invoke<MaterialRecord>(
    'teaching:material:pick-and-import'
  )) as ImportMaterialResult
}

export async function importMaterialByPath(
  filePath: string
): Promise<ImportMaterialResult> {
  return (await invoke<MaterialRecord>('teaching:material:import', {
    filePath,
  })) as ImportMaterialResult
}

export async function listMaterials(): Promise<MaterialRecord[]> {
  const result = await invoke<MaterialRecord[]>('teaching:material:list')
  return result.success ? result.data ?? [] : []
}

export async function getMaterial(
  materialId: string
): Promise<MaterialRecord | null> {
  const result = await invoke<MaterialRecord>('teaching:material:get', {
    materialId,
  })
  return result.success ? result.data ?? null : null
}

export async function getMaterialPages(
  materialId: string
): Promise<DocumentPage[]> {
  const result = await invoke<DocumentPage[]>('teaching:material:pages', {
    materialId,
  })
  return result.success ? result.data ?? [] : []
}

export interface MaterialBlob {
  bytes: Uint8Array
  isPdf: boolean
  sourceType: MaterialRecord['sourceType']
}

export async function getMaterialBlob(
  materialId: string
): Promise<MaterialBlob | null> {
  const result = await invoke<MaterialBlob>('teaching:material:blob', {
    materialId,
  })
  return result.success ? result.data ?? null : null
}

export async function getMaterialAnchors(
  materialId: string,
  pageIndex?: number
): Promise<ContentAnchor[]> {
  const result = await invoke<ContentAnchor[]>('teaching:material:anchors', {
    materialId,
    pageIndex,
  })
  return result.success ? result.data ?? [] : []
}

export async function updatePageText(
  materialId: string,
  pageIndex: number,
  text: string
): Promise<boolean> {
  const result = await invoke('teaching:material:update-page-text', {
    materialId,
    pageIndex,
    text,
  })
  return result.success
}

export async function deleteMaterial(materialId: string): Promise<void> {
  await invoke('teaching:material:delete', { materialId })
}

export async function getCourseVersion(
  courseVersionId: string
): Promise<CourseVersionRecord | null> {
  const result = await invoke<CourseVersionRecord>('teaching:course:version', {
    courseVersionId,
  })
  return result.success ? result.data ?? null : null
}

export async function createCourseVersion(
  record: CourseVersionRecord
): Promise<boolean> {
  const result = await invoke('teaching:course:create', { record })
  return result.success
}

export async function confirmCourse(
  courseVersionId: string
): Promise<boolean> {
  const result = await invoke('teaching:course:confirm', { courseVersionId })
  return result.success
}

export async function saveContract(contract: ClassContract): Promise<boolean> {
  const result = await invoke('teaching:contract:save', { contract })
  return result.success
}

export async function getLatestContract(
  courseVersionId: string
): Promise<ClassContract | null> {
  const result = await invoke<ClassContract>('teaching:contract:latest', {
    courseVersionId,
  })
  return result.success ? result.data ?? null : null
}

export async function createSession(session: ClassSession): Promise<boolean> {
  const result = await invoke('teaching:session:create', { session })
  return result.success
}

export async function updateSession(
  sessionId: string,
  patch: Partial<ClassSession>
): Promise<void> {
  await invoke('teaching:session:update', { sessionId, patch })
}

export async function getSession(
  sessionId: string
): Promise<ClassSession | null> {
  const result = await invoke<ClassSession>('teaching:session:get', {
    sessionId,
  })
  return result.success ? result.data ?? null : null
}

export async function listResumableSessions(): Promise<ClassSession[]> {
  const result = await invoke<ClassSession[]>('teaching:session:resumable')
  return result.success ? result.data ?? [] : []
}

export async function appendStep(step: unknown): Promise<void> {
  await invoke('teaching:step:append', { step })
}

export async function getLatestStep(sessionId: string): Promise<unknown> {
  const result = await invoke('teaching:step:latest', { sessionId })
  return result.success ? result.data ?? null : null
}

export async function saveAttempt(attempt: unknown): Promise<void> {
  await invoke('teaching:attempt:save', { attempt })
}

export async function listAttempts(sessionId: string): Promise<unknown[]> {
  const result = await invoke<unknown[]>('teaching:attempt:list', { sessionId })
  return result.success ? result.data ?? [] : []
}

export async function upsertMastery(payload: {
  objectiveId: string
  courseId: string
  level: 'unknown' | 'learning' | 'needs-review' | 'mastered'
  evidenceAttemptIds: string[]
  selfAssessment?: string | null
  nextReviewAt?: string | null
}): Promise<void> {
  await invoke('teaching:mastery:upsert', payload)
}

export async function listMastery(courseId: string): Promise<unknown[]> {
  const result = await invoke<unknown[]>('teaching:mastery:list', { courseId })
  return result.success ? result.data ?? [] : []
}

export type { ClassContract, ClassSession, CourseVersionRecord, MaterialRecord }
