import { randomUUID } from 'node:crypto'
import { getDBInstance } from './thoughtVectorStore'
import { writeAppLog } from './teaching/logger'

/**
 * 人格自己记下的细节。
 *
 * 用户在聊天里问到设定没写的背景（"你父亲叫什么""你第一次进城是什么时候"），
 * 模型会即兴补一个合理答案，然后调 remember_self_fact 落到这张表里。
 * 以后每次拼提示词都把最近的条目带上，同一个问题不会再给出两个版本。
 *
 * 与 long_term_memories 分开：那是"关于用户"的记忆，这里是"关于它自己"的。
 */

export interface PersonaNote {
  id: string
  personaId: string
  content: string
  createdAt: string
}

let tableReady = false

function db() {
  const database = getDBInstance()
  if (!tableReady) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS persona_notes (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_persona_notes_persona
        ON persona_notes(persona_id, created_at);
    `)
    tableReady = true
  }
  return database
}

function normalizeKey(content: string): string {
  return content.toLowerCase().replace(/[\s，。、；;：:！!？?,.、"'"'（）()]/g, '')
}

export function listPersonaNotes(personaId?: string): PersonaNote[] {
  try {
    const rows = personaId
      ? db()
          .prepare(
            `SELECT id, persona_id as personaId, content, created_at as createdAt
             FROM persona_notes WHERE persona_id = ?
             ORDER BY created_at ASC LIMIT 300`
          )
          .all(personaId)
      : db()
          .prepare(
            `SELECT id, persona_id as personaId, content, created_at as createdAt
             FROM persona_notes ORDER BY created_at ASC LIMIT 600`
          )
          .all()
    return rows as PersonaNote[]
  } catch (error) {
    writeAppLog({
      level: 'error',
      module: 'persona',
      event: 'notes.list_failed',
      data: { error: error instanceof Error ? error.message : String(error) },
    })
    return []
  }
}

export function addPersonaNote(
  personaId: string,
  content: string
): PersonaNote | null {
  const persona = String(personaId || '').trim() || 'alice'
  const text = String(content || '').replace(/\s+/g, ' ').trim()
  if (text.length < 4) return null
  if (text.length > 240) return null

  try {
    const database = db()
    const existing = database
      .prepare('SELECT content FROM persona_notes WHERE persona_id = ?')
      .all(persona) as Array<{ content: string }>
    const key = normalizeKey(text)
    if (
      existing.some(item => {
        const known = normalizeKey(item.content)
        return known === key || known.includes(key) || key.includes(known)
      })
    ) {
      return null
    }

    const note: PersonaNote = {
      id: randomUUID(),
      personaId: persona,
      content: text,
      createdAt: new Date().toISOString(),
    }
    database
      .prepare(
        'INSERT INTO persona_notes (id, persona_id, content, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(note.id, note.personaId, note.content, note.createdAt)

    writeAppLog({
      level: 'info',
      module: 'persona',
      event: 'note.saved',
      data: { personaId: persona, content: text.slice(0, 80) },
    })
    return note
  } catch (error) {
    writeAppLog({
      level: 'error',
      module: 'persona',
      event: 'note.save_failed',
      data: {
        personaId: persona,
        error: error instanceof Error ? error.message : String(error),
      },
    })
    return null
  }
}

export function deletePersonaNote(id: string): boolean {
  try {
    const result = db().prepare('DELETE FROM persona_notes WHERE id = ?').run(id)
    return result.changes > 0
  } catch {
    return false
  }
}
