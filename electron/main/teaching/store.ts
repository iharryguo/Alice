import { getDBInstance } from '../thoughtVectorStore'
import type {
  ClassContract,
  ClassSession,
  ContentAnchor,
  CourseVersionRecord,
  DocumentPage,
  ExerciseAttempt,
  LessonNode,
  MaterialQualityReport,
  MaterialRecord,
  MaterialStatus,
  TeachingStepRecord,
} from './types'

/**
 * 教师领域持久化。
 *
 * 设计取舍：一期不引入独立数据库，也不建"课程"这一层父实体——一个材料对应
 * 一条课程主线，course_id 直接用 material_id，课程内容变化派生新的 course_version。
 * 这样课程编译器只需要处理"材料 → 版本"两跳，少一层无用的间接。
 */

let initialized = false

function nowIso(): string {
  return new Date().toISOString()
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function initializeTeachingDB(): void {
  if (initialized) return
  initialized = true

  const db = getDBInstance()
  db.exec(`
    CREATE TABLE IF NOT EXISTS teaching_materials (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_path TEXT NOT NULL,
      document_path TEXT,
      source_hash TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      quality_json TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_teaching_materials_hash ON teaching_materials (source_hash);
    CREATE INDEX IF NOT EXISTS idx_teaching_materials_status ON teaching_materials (status);

    CREATE TABLE IF NOT EXISTS teaching_pages (
      material_id TEXT NOT NULL,
      page_index INTEGER NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      text TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      text_source TEXT NOT NULL,
      text_coverage REAL NOT NULL,
      PRIMARY KEY (material_id, page_index)
    );

    CREATE TABLE IF NOT EXISTS teaching_anchors (
      anchor_id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL,
      page_index INTEGER NOT NULL,
      char_start INTEGER NOT NULL,
      char_end INTEGER NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      width REAL NOT NULL,
      height REAL NOT NULL,
      text TEXT NOT NULL,
      confidence REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_teaching_anchors_page ON teaching_anchors (material_id, page_index);

    CREATE TABLE IF NOT EXISTS teaching_course_versions (
      course_version_id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      material_id TEXT NOT NULL,
      status TEXT NOT NULL,
      objectives_json TEXT NOT NULL,
      prerequisites_json TEXT NOT NULL,
      nodes_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_teaching_versions_course ON teaching_course_versions (course_id, version);

    CREATE TABLE IF NOT EXISTS teaching_contracts (
      contract_version_id TEXT PRIMARY KEY,
      course_version_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      target_duration_min INTEGER NOT NULL,
      pace_policy TEXT NOT NULL,
      presentation_mode TEXT NOT NULL,
      language_policy TEXT NOT NULL,
      correction_policy TEXT NOT NULL,
      strictness TEXT NOT NULL,
      wander_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      confirmed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_teaching_contracts_course ON teaching_contracts (course_version_id, version);

    CREATE TABLE IF NOT EXISTS teaching_sessions (
      session_id TEXT PRIMARY KEY,
      course_version_id TEXT NOT NULL,
      contract_version_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      turn_state TEXT NOT NULL,
      presentation_state TEXT NOT NULL,
      current_node_id TEXT,
      teacher_turn_id TEXT,
      student_turn_id TEXT,
      cancel_teacher_turn_id TEXT,
      lesson_anchor_json TEXT,
      viewport_json TEXT,
      time_debt_sec INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_teaching_sessions_status ON teaching_sessions (status, updated_at);

    CREATE TABLE IF NOT EXISTS teaching_steps (
      step_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      node_id TEXT,
      action TEXT NOT NULL,
      teacher_turn_id TEXT,
      student_turn_id TEXT,
      sentence_index INTEGER NOT NULL DEFAULT 0,
      sentence_committed INTEGER NOT NULL DEFAULT 0,
      playback_state TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      committed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_teaching_steps_session ON teaching_steps (session_id, committed_at);

    CREATE TABLE IF NOT EXISTS teaching_attempts (
      attempt_id TEXT PRIMARY KEY,
      exercise_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      student_input TEXT NOT NULL,
      audio_path TEXT,
      score_json TEXT,
      feedback TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_teaching_attempts_session ON teaching_attempts (session_id);

    CREATE TABLE IF NOT EXISTS teaching_mastery (
      objective_id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      level TEXT NOT NULL,
      evidence_attempt_ids_json TEXT NOT NULL,
      self_assessment TEXT,
      updated_at TEXT NOT NULL,
      next_review_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_teaching_mastery_course ON teaching_mastery (course_id);
  `)

  console.log('[Teaching] Database initialized')
}

interface MaterialRow {
  id: string
  title: string
  source_type: string
  source_path: string
  document_path: string | null
  source_hash: string
  page_count: number
  status: string
  quality_json: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

function rowToMaterial(row: MaterialRow): MaterialRecord {
  return {
    id: row.id,
    title: row.title,
    sourceType: row.source_type as MaterialRecord['sourceType'],
    sourcePath: row.source_path,
    documentPath: row.document_path,
    sourceHash: row.source_hash,
    pageCount: row.page_count,
    status: row.status as MaterialStatus,
    quality: parseJson<MaterialQualityReport | null>(row.quality_json, null),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function insertMaterial(record: MaterialRecord): void {
  const db = getDBInstance()
  db.prepare(
    `INSERT INTO teaching_materials
      (id, title, source_type, source_path, document_path, source_hash, page_count, status, quality_json, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.title,
    record.sourceType,
    record.sourcePath,
    record.documentPath,
    record.sourceHash,
    record.pageCount,
    record.status,
    record.quality ? JSON.stringify(record.quality) : null,
    record.errorMessage,
    record.createdAt,
    record.updatedAt
  )
}

export function updateMaterial(
  id: string,
  patch: {
    status?: MaterialStatus
    documentPath?: string | null
    pageCount?: number
    quality?: MaterialQualityReport | null
    errorMessage?: string | null
    title?: string
  }
): void {
  const db = getDBInstance()
  const current = getMaterial(id)
  if (!current) return

  db.prepare(
    `UPDATE teaching_materials
       SET title = ?, document_path = ?, page_count = ?, status = ?, quality_json = ?, error_message = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    patch.title ?? current.title,
    patch.documentPath !== undefined ? patch.documentPath : current.documentPath,
    patch.pageCount ?? current.pageCount,
    patch.status ?? current.status,
    patch.quality !== undefined
      ? patch.quality
        ? JSON.stringify(patch.quality)
        : null
      : current.quality
        ? JSON.stringify(current.quality)
        : null,
    patch.errorMessage !== undefined
      ? patch.errorMessage
      : current.errorMessage,
    nowIso(),
    id
  )
}

export function getMaterial(id: string): MaterialRecord | null {
  const db = getDBInstance()
  const row = db
    .prepare('SELECT * FROM teaching_materials WHERE id = ?')
    .get(id) as MaterialRow | undefined
  return row ? rowToMaterial(row) : null
}

export function getMaterialByHash(hash: string): MaterialRecord | null {
  const db = getDBInstance()
  const row = db
    .prepare('SELECT * FROM teaching_materials WHERE source_hash = ?')
    .get(hash) as MaterialRow | undefined
  return row ? rowToMaterial(row) : null
}

export function listMaterials(): MaterialRecord[] {
  const db = getDBInstance()
  const rows = db
    .prepare('SELECT * FROM teaching_materials ORDER BY updated_at DESC')
    .all() as MaterialRow[]
  return rows.map(rowToMaterial)
}

export function deleteMaterial(id: string): void {
  const db = getDBInstance()
  db.prepare('DELETE FROM teaching_anchors WHERE material_id = ?').run(id)
  db.prepare('DELETE FROM teaching_pages WHERE material_id = ?').run(id)
  db.prepare('DELETE FROM teaching_materials WHERE id = ?').run(id)
}

export function replacePages(materialId: string, pages: DocumentPage[]): void {
  const db = getDBInstance()
  const insert = db.prepare(
    `INSERT OR REPLACE INTO teaching_pages
       (material_id, page_index, width, height, text, char_count, text_source, text_coverage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const tx = db.transaction((rows: DocumentPage[]) => {
    db.prepare('DELETE FROM teaching_pages WHERE material_id = ?').run(materialId)
    for (const page of rows) {
      insert.run(
        materialId,
        page.pageIndex,
        page.width,
        page.height,
        page.text,
        page.charCount,
        page.textSource,
        page.textCoverage
      )
    }
  })
  tx(pages)
}

export function listPages(materialId: string): DocumentPage[] {
  const db = getDBInstance()
  const rows = db
    .prepare(
      'SELECT * FROM teaching_pages WHERE material_id = ? ORDER BY page_index ASC'
    )
    .all(materialId) as Array<{
    material_id: string
    page_index: number
    width: number
    height: number
    text: string
    char_count: number
    text_source: string
    text_coverage: number
  }>

  return rows.map(row => ({
    materialId: row.material_id,
    pageIndex: row.page_index,
    width: row.width,
    height: row.height,
    text: row.text,
    charCount: row.char_count,
    textSource: row.text_source as DocumentPage['textSource'],
    textCoverage: row.text_coverage,
  }))
}

/** 模型读图得到的文字写回页面记录 */
export function updatePageText(
  materialId: string,
  pageIndex: number,
  text: string
): void {
  const db = getDBInstance()
  const charCount = text.replace(/\s/g, '').length
  db.prepare(
    `UPDATE teaching_pages
        SET text = ?, char_count = ?, text_source = 'vision'
      WHERE material_id = ? AND page_index = ?`
  ).run(text, charCount, materialId, pageIndex)
}

export function replaceAnchors(
  materialId: string,
  anchors: ContentAnchor[]
): void {
  const db = getDBInstance()
  const insert = db.prepare(
    `INSERT OR REPLACE INTO teaching_anchors
       (anchor_id, material_id, page_index, char_start, char_end, x, y, width, height, text, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const tx = db.transaction((rows: ContentAnchor[]) => {
    db.prepare('DELETE FROM teaching_anchors WHERE material_id = ?').run(
      materialId
    )
    for (const anchor of rows) {
      insert.run(
        anchor.anchorId,
        anchor.materialId,
        anchor.pageIndex,
        anchor.charStart,
        anchor.charEnd,
        anchor.x,
        anchor.y,
        anchor.width,
        anchor.height,
        anchor.text,
        anchor.confidence
      )
    }
  })
  tx(anchors)
}

export function listAnchors(
  materialId: string,
  pageIndex?: number
): ContentAnchor[] {
  const db = getDBInstance()
  const rows = (
    pageIndex === undefined
      ? db
          .prepare(
            'SELECT * FROM teaching_anchors WHERE material_id = ? ORDER BY page_index ASC, char_start ASC'
          )
          .all(materialId)
      : db
          .prepare(
            'SELECT * FROM teaching_anchors WHERE material_id = ? AND page_index = ? ORDER BY char_start ASC'
          )
          .all(materialId, pageIndex)
  ) as Array<{
    anchor_id: string
    material_id: string
    page_index: number
    char_start: number
    char_end: number
    x: number
    y: number
    width: number
    height: number
    text: string
    confidence: number
  }>

  return rows.map(row => ({
    anchorId: row.anchor_id,
    materialId: row.material_id,
    pageIndex: row.page_index,
    charStart: row.char_start,
    charEnd: row.char_end,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    text: row.text,
    confidence: row.confidence,
  }))
}

export function insertCourseVersion(record: CourseVersionRecord): void {
  const db = getDBInstance()
  db.prepare(
    `INSERT INTO teaching_course_versions
      (course_version_id, course_id, version, title, material_id, status, objectives_json, prerequisites_json, nodes_json, content_hash, created_at, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.courseVersionId,
    record.courseId,
    record.version,
    record.title,
    record.materialId,
    record.status,
    JSON.stringify(record.objectives),
    JSON.stringify(record.prerequisites),
    JSON.stringify(record.nodes),
    record.contentHash,
    record.createdAt,
    record.confirmedAt
  )
}

interface CourseVersionRow {
  course_version_id: string
  course_id: string
  version: number
  title: string
  material_id: string
  status: string
  objectives_json: string
  prerequisites_json: string
  nodes_json: string
  content_hash: string
  created_at: string
  confirmed_at: string | null
}

function rowToCourseVersion(row: CourseVersionRow): CourseVersionRecord {
  return {
    courseVersionId: row.course_version_id,
    courseId: row.course_id,
    version: row.version,
    title: row.title,
    materialId: row.material_id,
    status: row.status as CourseVersionRecord['status'],
    objectives: parseJson<string[]>(row.objectives_json, []),
    prerequisites: parseJson<string[]>(row.prerequisites_json, []),
    nodes: parseJson<LessonNode[]>(row.nodes_json, []),
    contentHash: row.content_hash,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
  }
}

export function getCourseVersion(id: string): CourseVersionRecord | null {
  const db = getDBInstance()
  const row = db
    .prepare('SELECT * FROM teaching_course_versions WHERE course_version_id = ?')
    .get(id) as CourseVersionRow | undefined
  return row ? rowToCourseVersion(row) : null
}

export function listCourseVersions(courseId: string): CourseVersionRecord[] {
  const db = getDBInstance()
  const rows = db
    .prepare(
      'SELECT * FROM teaching_course_versions WHERE course_id = ? ORDER BY version DESC'
    )
    .all(courseId) as CourseVersionRow[]
  return rows.map(rowToCourseVersion)
}

export function listAllCourseVersions(): CourseVersionRecord[] {
  const db = getDBInstance()
  const rows = db
    .prepare(
      'SELECT * FROM teaching_course_versions ORDER BY created_at DESC LIMIT 100'
    )
    .all() as CourseVersionRow[]
  return rows.map(rowToCourseVersion)
}

export function confirmCourseVersion(id: string): void {
  const db = getDBInstance()
  const record = getCourseVersion(id)
  if (!record) return
  db.prepare(
    `UPDATE teaching_course_versions SET status = 'SUPERSEDED' WHERE course_id = ? AND status = 'CONFIRMED' AND course_version_id != ?`
  ).run(record.courseId, id)
  db.prepare(
    `UPDATE teaching_course_versions SET status = 'CONFIRMED', confirmed_at = ? WHERE course_version_id = ?`
  ).run(nowIso(), id)
}

export function saveContract(contract: ClassContract): void {
  const db = getDBInstance()
  db.prepare(
    `INSERT INTO teaching_contracts
      (contract_version_id, course_version_id, version, target_duration_min, pace_policy, presentation_mode, language_policy, correction_policy, strictness, wander_json, created_at, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    contract.contractVersionId,
    contract.courseVersionId,
    contract.version,
    contract.targetDurationMin,
    contract.pacePolicy,
    contract.presentationMode,
    contract.languagePolicy,
    contract.correctionPolicy,
    contract.strictness,
    JSON.stringify(contract.wanderThreshold),
    contract.createdAt,
    contract.confirmedAt
  )
}

export function getLatestContract(
  courseVersionId: string
): ClassContract | null {
  const db = getDBInstance()
  const row = db
    .prepare(
      'SELECT * FROM teaching_contracts WHERE course_version_id = ? ORDER BY version DESC LIMIT 1'
    )
    .get(courseVersionId) as
    | {
        contract_version_id: string
        course_version_id: string
        version: number
        target_duration_min: number
        pace_policy: string
        presentation_mode: string
        language_policy: string
        correction_policy: string
        strictness: string
        wander_json: string
        created_at: string
        confirmed_at: string | null
      }
    | undefined

  if (!row) return null
  return {
    contractVersionId: row.contract_version_id,
    courseVersionId: row.course_version_id,
    version: row.version,
    targetDurationMin: row.target_duration_min,
    pacePolicy: row.pace_policy as ClassContract['pacePolicy'],
    presentationMode: row.presentation_mode as ClassContract['presentationMode'],
    languagePolicy: row.language_policy as ClassContract['languagePolicy'],
    correctionPolicy: row.correction_policy as ClassContract['correctionPolicy'],
    strictness: row.strictness as ClassContract['strictness'],
    wanderThreshold: parseJson(row.wander_json, {
      windowMinutes: 3,
      strikes: 2,
    }),
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
  }
}

export function createSession(session: ClassSession): void {
  const db = getDBInstance()
  db.prepare(
    `INSERT INTO teaching_sessions
      (session_id, course_version_id, contract_version_id, phase, turn_state, presentation_state,
       current_node_id, teacher_turn_id, student_turn_id, cancel_teacher_turn_id,
       lesson_anchor_json, viewport_json, time_debt_sec, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.sessionId,
    session.courseVersionId,
    session.contractVersionId,
    session.phase,
    session.turnState,
    session.presentationState,
    session.currentNodeId,
    session.teacherTurnId,
    session.studentTurnId,
    session.cancelTeacherTurnId,
    session.lessonAnchor ? JSON.stringify(session.lessonAnchor) : null,
    session.viewport ? JSON.stringify(session.viewport) : null,
    session.timeDebtSec,
    session.status,
    session.createdAt,
    session.updatedAt
  )
}

export function updateSession(
  sessionId: string,
  patch: Partial<Omit<ClassSession, 'sessionId' | 'createdAt'>>
): void {
  const current = getSession(sessionId)
  if (!current) return
  const next: ClassSession = {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  }
  const db = getDBInstance()
  db.prepare(
    `UPDATE teaching_sessions
       SET phase = ?, turn_state = ?, presentation_state = ?, current_node_id = ?,
           teacher_turn_id = ?, student_turn_id = ?, cancel_teacher_turn_id = ?,
           lesson_anchor_json = ?, viewport_json = ?, time_debt_sec = ?, status = ?, updated_at = ?
     WHERE session_id = ?`
  ).run(
    next.phase,
    next.turnState,
    next.presentationState,
    next.currentNodeId,
    next.teacherTurnId,
    next.studentTurnId,
    next.cancelTeacherTurnId,
    next.lessonAnchor ? JSON.stringify(next.lessonAnchor) : null,
    next.viewport ? JSON.stringify(next.viewport) : null,
    next.timeDebtSec,
    next.status,
    next.updatedAt,
    sessionId
  )
}

export function getSession(sessionId: string): ClassSession | null {
  const db = getDBInstance()
  const row = db
    .prepare('SELECT * FROM teaching_sessions WHERE session_id = ?')
    .get(sessionId) as any
  if (!row) return null
  return {
    sessionId: row.session_id,
    courseVersionId: row.course_version_id,
    contractVersionId: row.contract_version_id,
    phase: row.phase,
    turnState: row.turn_state,
    presentationState: row.presentation_state,
    currentNodeId: row.current_node_id,
    teacherTurnId: row.teacher_turn_id,
    studentTurnId: row.student_turn_id,
    cancelTeacherTurnId: row.cancel_teacher_turn_id,
    lessonAnchor: parseJson(row.lesson_anchor_json, null),
    viewport: parseJson(row.viewport_json, null),
    timeDebtSec: row.time_debt_sec,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 退出应用前把进行中的课堂落到 PAUSED，重启后才能接着上 */
export function pauseActiveSessions(): void {
  try {
    const db = getDBInstance()
    db.prepare(
      "UPDATE teaching_sessions SET status = 'PAUSED', updated_at = ? WHERE status = 'IN_SESSION'"
    ).run(nowIso())
  } catch (error) {
    console.warn('[Teaching] 保存课堂暂停状态失败:', error)
  }
}

export function listResumableSessions(): ClassSession[] {
  const db = getDBInstance()
  // IN_SESSION 说明上次是异常退出（正常下课会写 COMPLETED，暂停会写 PAUSED），
  // 这两种都应该允许接着上，否则崩溃一次就得重头讲。
  const rows = db
    .prepare(
      "SELECT session_id FROM teaching_sessions WHERE status IN ('PAUSED', 'IN_SESSION') ORDER BY updated_at DESC LIMIT 5"
    )
    .all() as Array<{ session_id: string }>
  return rows
    .map(row => getSession(row.session_id))
    .filter((item): item is ClassSession => item !== null)
}

export function appendStep(step: TeachingStepRecord): void {
  const db = getDBInstance()
  db.prepare(
    `INSERT INTO teaching_steps
      (step_id, session_id, node_id, action, teacher_turn_id, student_turn_id,
       sentence_index, sentence_committed, playback_state, payload_json, committed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    step.stepId,
    step.sessionId,
    step.nodeId,
    step.action,
    step.teacherTurnId,
    step.studentTurnId,
    step.sentenceIndex,
    step.sentenceCommitted ? 1 : 0,
    step.playbackState,
    JSON.stringify(step.payload),
    step.committedAt
  )
}

export function getLatestStep(sessionId: string): TeachingStepRecord | null {
  const db = getDBInstance()
  const row = db
    .prepare(
      'SELECT * FROM teaching_steps WHERE session_id = ? ORDER BY committed_at DESC LIMIT 1'
    )
    .get(sessionId) as any
  if (!row) return null
  return {
    stepId: row.step_id,
    sessionId: row.session_id,
    nodeId: row.node_id,
    action: row.action,
    teacherTurnId: row.teacher_turn_id,
    studentTurnId: row.student_turn_id,
    sentenceIndex: row.sentence_index,
    sentenceCommitted: row.sentence_committed === 1,
    playbackState: row.playback_state,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    committedAt: row.committed_at,
  }
}

export function saveAttempt(attempt: ExerciseAttempt): void {
  const db = getDBInstance()
  db.prepare(
    `INSERT INTO teaching_attempts
      (attempt_id, exercise_id, session_id, student_input, audio_path, score_json, feedback, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    attempt.attemptId,
    attempt.exerciseId,
    attempt.sessionId,
    attempt.studentInput,
    attempt.audioPath,
    attempt.score ? JSON.stringify(attempt.score) : null,
    attempt.feedback,
    attempt.createdAt
  )
}

export function listAttempts(sessionId: string): ExerciseAttempt[] {
  const db = getDBInstance()
  const rows = db
    .prepare(
      'SELECT * FROM teaching_attempts WHERE session_id = ? ORDER BY created_at ASC'
    )
    .all(sessionId) as any[]
  return rows.map(row => ({
    attemptId: row.attempt_id,
    exerciseId: row.exercise_id,
    sessionId: row.session_id,
    studentInput: row.student_input,
    audioPath: row.audio_path,
    score: parseJson(row.score_json, null),
    feedback: row.feedback,
    createdAt: row.created_at,
  }))
}

export function upsertMastery(params: {
  objectiveId: string
  courseId: string
  level: 'unknown' | 'learning' | 'needs-review' | 'mastered'
  evidenceAttemptIds: string[]
  selfAssessment?: string | null
  nextReviewAt?: string | null
}): void {
  const db = getDBInstance()
  db.prepare(
    `INSERT INTO teaching_mastery
      (objective_id, course_id, level, evidence_attempt_ids_json, self_assessment, updated_at, next_review_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(objective_id) DO UPDATE SET
       level = excluded.level,
       evidence_attempt_ids_json = excluded.evidence_attempt_ids_json,
       self_assessment = excluded.self_assessment,
       updated_at = excluded.updated_at,
       next_review_at = excluded.next_review_at`
  ).run(
    params.objectiveId,
    params.courseId,
    params.level,
    JSON.stringify(params.evidenceAttemptIds),
    params.selfAssessment ?? null,
    nowIso(),
    params.nextReviewAt ?? null
  )
}

export function listMastery(courseId: string): Array<{
  objectiveId: string
  level: string
  evidenceAttemptIds: string[]
  selfAssessment: string | null
  updatedAt: string
  nextReviewAt: string | null
}> {
  const db = getDBInstance()
  const rows = db
    .prepare('SELECT * FROM teaching_mastery WHERE course_id = ?')
    .all(courseId) as any[]
  return rows.map(row => ({
    objectiveId: row.objective_id,
    level: row.level,
    evidenceAttemptIds: parseJson<string[]>(
      row.evidence_attempt_ids_json,
      []
    ),
    selfAssessment: row.self_assessment,
    updatedAt: row.updated_at,
    nextReviewAt: row.next_review_at,
  }))
}
