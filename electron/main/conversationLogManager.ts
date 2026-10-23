import { app, ipcMain } from 'electron'
import path from 'node:path'
import Database from 'better-sqlite3'

/**
 * 会话历史持久化。
 *
 * Alice 原本的 chatHistory 只活在渲染进程内存里，关掉窗口就没了；
 * 这里用独立的 SQLite 文件保存会话与消息，供「历史」面板检索与恢复。
 * 不复用 thoughtVectorStore 的库，避免和向量索引/迁移逻辑耦合。
 */

const DB_FILE_NAME = 'alice-conversations.sqlite'
const MAX_MESSAGES_PER_SESSION = 500

export interface StoredMessage {
  id?: string
  role: string
  content: unknown
  created_at?: number
  tool_calls?: unknown
  tool_call_id?: string | null
  name?: string | null
}

export interface SessionSummary {
  id: string
  title: string
  messageCount: number
  createdAt: number
  updatedAt: number
  preview: string
}

export interface SessionMessage {
  id: string
  role: string
  content: unknown
  createdAt: number
  toolCalls?: unknown
  toolCallId?: string | null
  name?: string | null
}

// better-sqlite3 在 types/vendor.d.ts 里被声明为 any，这里沿用同一写法
type SQLiteDatabase = any

let db: SQLiteDatabase | null = null
let handlersRegistered = false

function getDb(): SQLiteDatabase {
  if (db) return db
  const filePath = path.join(app.getPath('userData'), DB_FILE_NAME)
  db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      tool_calls TEXT,
      tool_call_id TEXT,
      name TEXT,
      seq INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
      ON chat_messages(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_created
      ON chat_messages(created_at);
  `)
  return db
}

function safeParse(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function extractPreview(content: unknown): string {
  if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim()
  if (Array.isArray(content)) {
    const text = content
      .filter((part: any) => part?.type === 'app_text' && part?.text)
      .map((part: any) => part.text as string)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) return text
    const other = content.find((part: any) => part?.type !== 'app_text')
    if (other?.type === 'app_image_uri') return '[图片]'
    if (other?.type === 'app_file') return `[文件] ${other.fileName || ''}`.trim()
    if (other?.type === 'app_generated_image_path') return '[生成的图片]'
  }
  return ''
}

export function syncSession(payload: {
  sessionId: string
  title?: string
  messages: StoredMessage[]
}): { success: boolean; messageCount?: number; error?: string } {
  try {
    const sessionId = String(payload?.sessionId || '').trim()
    if (!sessionId) return { success: false, error: '缺少 sessionId' }

    const messages = Array.isArray(payload.messages)
      ? payload.messages
          .filter(
            message =>
              message &&
              typeof message.role === 'string' &&
              message.role !== 'system'
          )
          .slice(-MAX_MESSAGES_PER_SESSION)
      : []

    const now = Date.now()
    const firstUserText =
      messages.find(message => message.role === 'user')?.content ?? ''
    const fallbackTitle =
      extractPreview(firstUserText).slice(0, 40) || '新的对话'
    const title = (payload.title || fallbackTitle).slice(0, 80)

    const database = getDb()
    const transaction = database.transaction(() => {
      database
        .prepare(
          `INSERT INTO chat_sessions (id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`
        )
        .run(sessionId, title, now, now)

      database.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId)

      const insert = database.prepare(
        `INSERT INTO chat_messages
          (id, session_id, role, content, created_at, tool_calls, tool_call_id, name, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )

      messages.forEach((message, index) => {
        insert.run(
          `${sessionId}-${index}`,
          sessionId,
          message.role,
          JSON.stringify(message.content ?? ''),
          Number(message.created_at) || now,
          message.tool_calls ? JSON.stringify(message.tool_calls) : null,
          message.tool_call_id ?? null,
          message.name ?? null,
          index
        )
      })
    })
    transaction()

    return { success: true, messageCount: messages.length }
  } catch (error) {
    console.error('[ConversationLog] 同步会话失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function listSessions(limit = 100): SessionSummary[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT s.id as id,
                s.title as title,
                s.created_at as createdAt,
                s.updated_at as updatedAt,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) as messageCount,
                (SELECT m.content FROM chat_messages m
                  WHERE m.session_id = s.id AND m.role = 'user'
                  ORDER BY m.seq ASC LIMIT 1) as firstUserContent
         FROM chat_sessions s
         ORDER BY s.updated_at DESC
         LIMIT ?`
      )
      .all(Math.max(1, Math.min(limit, 500))) as Array<{
      id: string
      title: string
      createdAt: number
      updatedAt: number
      messageCount: number
      firstUserContent: string | null
    }>

    return rows.map(row => ({
      id: row.id,
      title: row.title || '新的对话',
      messageCount: row.messageCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      preview: extractPreview(safeParse(row.firstUserContent)).slice(0, 120),
    }))
  } catch (error) {
    console.error('[ConversationLog] 读取会话列表失败:', error)
    return []
  }
}

export function getSessionMessages(sessionId: string): SessionMessage[] {
  try {
    if (!sessionId) return []
    const rows = getDb()
      .prepare(
        `SELECT id, role, content, created_at as createdAt, tool_calls as toolCalls,
                tool_call_id as toolCallId, name
         FROM chat_messages
         WHERE session_id = ?
         ORDER BY seq ASC`
      )
      .all(sessionId) as Array<{
      id: string
      role: string
      content: string
      createdAt: number
      toolCalls: string | null
      toolCallId: string | null
      name: string | null
    }>

    return rows.map(row => ({
      id: row.id,
      role: row.role,
      content: safeParse(row.content),
      createdAt: row.createdAt,
      toolCalls: safeParse(row.toolCalls),
      toolCallId: row.toolCallId,
      name: row.name,
    }))
  } catch (error) {
    console.error('[ConversationLog] 读取会话消息失败:', error)
    return []
  }
}

export function searchMessages(query: string, limit = 60) {
  try {
    const keyword = String(query || '').trim()
    if (!keyword) return []
    const rows = getDb()
      .prepare(
        `SELECT m.session_id as sessionId,
                s.title as title,
                m.role as role,
                m.content as content,
                m.created_at as createdAt
         FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id
         WHERE m.content LIKE ?
         ORDER BY m.created_at DESC
         LIMIT ?`
      )
      .all(`%${keyword}%`, Math.max(1, Math.min(limit, 200))) as Array<{
      sessionId: string
      title: string
      role: string
      content: string
      createdAt: number
    }>

    return rows.map(row => {
      const text = extractPreview(safeParse(row.content))
      const at = text.toLowerCase().indexOf(keyword.toLowerCase())
      const start = at > 30 ? at - 30 : 0
      return {
        sessionId: row.sessionId,
        title: row.title || '新的对话',
        role: row.role,
        createdAt: row.createdAt,
        snippet:
          at >= 0
            ? `${start > 0 ? '…' : ''}${text.slice(start, start + 140)}`
            : text.slice(0, 140),
      }
    })
  } catch (error) {
    console.error('[ConversationLog] 搜索消息失败:', error)
    return []
  }
}

export function deleteSession(sessionId: string): boolean {
  try {
    if (!sessionId) return false
    const database = getDb()
    const transaction = database.transaction(() => {
      database.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(sessionId)
      database.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId)
    })
    transaction()
    return true
  } catch (error) {
    console.error('[ConversationLog] 删除会话失败:', error)
    return false
  }
}

export function registerConversationLogHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true

  ipcMain.handle('conversation-log:sync', (_event, payload) => syncSession(payload))
  ipcMain.handle('conversation-log:list-sessions', (_event, payload) =>
    listSessions(payload?.limit)
  )
  ipcMain.handle('conversation-log:get-messages', (_event, payload) =>
    getSessionMessages(payload?.sessionId)
  )
  ipcMain.handle('conversation-log:search', (_event, payload) =>
    searchMessages(payload?.query, payload?.limit)
  )
  ipcMain.handle('conversation-log:delete-session', (_event, payload) =>
    deleteSession(payload?.sessionId)
  )
}
