import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { existsSync, unlinkSync } from 'node:fs'
import axios from 'axios'
import { backendManager } from './backendManager'
import HnswlibNode from 'hnswlib-node'
const { HierarchicalNSW } = HnswlibNode
type HierarchicalNSWIndex = InstanceType<typeof HierarchicalNSW>
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { initializeMemorySearch } from './memorySearch'
type SQLiteDatabase = any

const OPENAI_VECTOR_DIMENSION = 1536 // OpenAI embedding dimension
const LOCAL_VECTOR_DIMENSION = 384 // multilingual-e5-small embedding dimension (Go backend)
const DOUBAO_VECTOR_DIMENSION = 4096 // doubao-embedding-large dimension (火山方舟, native size)

// doubao-embedding-vision models return their own native dimension (e.g. 3072),
// which differs from doubao-embedding-large (4096). The doubao bucket adapts to
// whatever dimension the configured model actually returns and persists the
// dimension in migration_flags so the HNSW index is recreated with the same
// dimension on the next launch.
let doubaoVectorDimension = DOUBAO_VECTOR_DIMENSION
const DOUBAO_DIMENSION_FLAG = 'doubao_vector_dimension'

function loadPersistedDoubaoDimension(): void {
  if (!db) return
  try {
    const row = db
      .prepare(
        'SELECT completed FROM migration_flags WHERE flag_name = ?'
      )
      .get(DOUBAO_DIMENSION_FLAG) as { completed?: number } | undefined
    if (row?.completed && row.completed > 0) {
      doubaoVectorDimension = row.completed
    }
  } catch {
    // Table may not exist yet during first init; keep the default.
  }
}

function persistDoubaoDimension(): void {
  if (!db) return
  try {
    db.prepare(
      'INSERT OR REPLACE INTO migration_flags (flag_name, completed) VALUES (?, ?)'
    ).run(DOUBAO_DIMENSION_FLAG, doubaoVectorDimension)
  } catch (error) {
    console.error(
      '[ThoughtVectorStore] Failed to persist doubao vector dimension:',
      error
    )
  }
}

export function getDoubaoVectorDimension(): number {
  return doubaoVectorDimension
}

// Three embedding providers are kept in separate HNSW buckets because each
// has its own vector dimension: openai (1536), local (384), doubao (4096).
type EmbeddingProvider = 'openai' | 'local' | 'doubao'
const LOCAL_EMBEDDING_MODEL =
  'intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3'
const LOCAL_EMBEDDING_REINDEXED_FLAG =
  'multilingual_e5_local_embeddings_reindexed'
const LOCAL_EMBEDDING_INVALIDATION_FLAG =
  'multilingual_e5_local_embeddings_invalidated'
// Versions before the automatic reindexer used this flag too early, before
// any replacement vectors had been generated. Treat it as an invalidation
// marker when upgrading from those versions.
const LEGACY_LOCAL_EMBEDDING_MIGRATION_FLAG = 'multilingual_e5_local_embeddings'
const LOCAL_EMBEDDING_BATCH_SIZE = 64
const LOCAL_EMBEDDING_READY_TIMEOUT_MS = 120000
const MAX_ELEMENTS_HNSW = 10000
const HNSW_OPENAI_INDEX_FILE_NAME = 'alice-thoughts-hnsw-openai.index'
const HNSW_LOCAL_INDEX_FILE_NAME = 'alice-thoughts-hnsw-local.index'
const HNSW_DOUBAO_INDEX_FILE_NAME = 'alice-thoughts-hnsw-doubao.index'
const DB_FILE_NAME = 'alice-thoughts.sqlite'
const OLD_MEMORIES_JSON_FILE = 'alice-memories.json'

const hnswOpenAIIndexFilePath = path.join(
  app.getPath('userData'),
  HNSW_OPENAI_INDEX_FILE_NAME
)
const hnswLocalIndexFilePath = path.join(
  app.getPath('userData'),
  HNSW_LOCAL_INDEX_FILE_NAME
)
const hnswDoubaoIndexFilePath = path.join(
  app.getPath('userData'),
  HNSW_DOUBAO_INDEX_FILE_NAME
)
const dbFilePath = path.join(app.getPath('userData'), DB_FILE_NAME)
const oldJsonMemoriesPath = path.join(
  app.getPath('userData'),
  OLD_MEMORIES_JSON_FILE
)

export interface ThoughtMetadata {
  id: string
  conversationId: string
  role: string
  textContent: string
  createdAt: string
}

export interface RawMessageRecord {
  role: string
  text_content: string
  created_at: string
}

export interface ConversationSummaryRecord {
  id: string
  summary_text: string
  summarized_messages_count: number
  conversation_id?: string
  created_at: string
}

export interface MemoryRecord {
  id: string
  content: string
  memoryType: string
  createdAt: string
  embedding?: number[] | Buffer
}

let hnswOpenAIIndex: HierarchicalNSWIndex | null = null
let hnswLocalIndex: HierarchicalNSWIndex | null = null
let hnswDoubaoIndex: HierarchicalNSWIndex | null = null

let openAILabelToThoughtId: Map<number, string> = new Map()
let localLabelToThoughtId: Map<number, string> = new Map()
let doubaoLabelToThoughtId: Map<number, string> = new Map()
let db: SQLiteDatabase | null = null
let isStoreInitialized = false

// Provider-based accessors keep the three HNSW buckets symmetric and make
// it easy to add future providers without touching every call site.
function getIndexForProvider(
  provider: EmbeddingProvider
): HierarchicalNSWIndex | null {
  return provider === 'local'
    ? hnswLocalIndex
    : provider === 'doubao'
      ? hnswDoubaoIndex
      : hnswOpenAIIndex
}

function setIndexForProvider(
  provider: EmbeddingProvider,
  index: HierarchicalNSWIndex
): void {
  if (provider === 'local') {
    hnswLocalIndex = index
  } else if (provider === 'doubao') {
    hnswDoubaoIndex = index
  } else {
    hnswOpenAIIndex = index
  }
}

function getLabelMappingForProvider(
  provider: EmbeddingProvider
): Map<number, string> {
  return provider === 'local'
    ? localLabelToThoughtId
    : provider === 'doubao'
      ? doubaoLabelToThoughtId
      : openAILabelToThoughtId
}

function getDimensionForProvider(provider: EmbeddingProvider): number {
  return provider === 'local'
    ? LOCAL_VECTOR_DIMENSION
    : provider === 'doubao'
      ? doubaoVectorDimension
      : OPENAI_VECTOR_DIMENSION
}

function getIndexPathForProvider(provider: EmbeddingProvider): string {
  return provider === 'local'
    ? hnswLocalIndexFilePath
    : provider === 'doubao'
      ? hnswDoubaoIndexFilePath
      : hnswOpenAIIndexFilePath
}

function initDB() {
  if (db) return

  db = new Database(dbFilePath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS thoughts (
      hnsw_label INTEGER PRIMARY KEY,
      thought_id TEXT UNIQUE NOT NULL,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text_content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      embedding BLOB
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS long_term_memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      embedding BLOB NULLABLE
    );
    CREATE INDEX IF NOT EXISTS idx_ltm_memory_type ON long_term_memories (memory_type);
    CREATE INDEX IF NOT EXISTS idx_ltm_created_at ON long_term_memories (created_at);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_flags (
      flag_name TEXT PRIMARY KEY,
      completed INTEGER NOT NULL DEFAULT 0
    );
  `)

  initializeMemorySearch(db)

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id TEXT PRIMARY KEY,
      summary_text TEXT NOT NULL,
      summarized_messages_count INTEGER NOT NULL,
      conversation_id TEXT, -- Optional: to scope summaries to specific conversations
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cs_created_at ON conversation_summaries (created_at);
    CREATE INDEX IF NOT EXISTS idx_cs_conversation_id ON conversation_summaries (conversation_id);
  `)

  runDualEmbeddingMigration()
  runMultilingualLocalEmbeddingMigration()
  runDoubaoEmbeddingMigration()
}

// Adds the doubao (4096-dim) embedding column to both tables. Mirrors the
// dual-embedding migration pattern: non-fatal if it partially fails, and the
// migration flag prevents repeated work.
function runDoubaoEmbeddingMigration() {
  if (!db) return

  const migrationFlag = db
    .prepare('SELECT completed FROM migration_flags WHERE flag_name = ?')
    .get('doubao_embedding_support') as { completed?: number } | undefined
  if (migrationFlag?.completed) return

  try {
    db.exec('ALTER TABLE thoughts ADD COLUMN embedding_doubao BLOB;')
  } catch {
    // Column already exists on databases created after this feature.
  }
  try {
    db.exec('ALTER TABLE long_term_memories ADD COLUMN embedding_doubao BLOB;')
  } catch {
    // Column already exists.
  }

  db.prepare(
    'INSERT OR REPLACE INTO migration_flags (flag_name, completed) VALUES (?, 1)'
  ).run('doubao_embedding_support')
  console.log(
    '[ThoughtVectorStore Migration] Doubao embedding columns ensured.'
  )
}

function runMultilingualLocalEmbeddingMigration() {
  if (!db) return

  const migrationFlag = db
    .prepare('SELECT completed FROM migration_flags WHERE flag_name = ?')
    .get(LOCAL_EMBEDDING_REINDEXED_FLAG) as { completed?: number } | undefined
  if (migrationFlag?.completed) return

  const invalidationFlag = db
    .prepare('SELECT completed FROM migration_flags WHERE flag_name = ?')
    .get(LOCAL_EMBEDDING_INVALIDATION_FLAG) as
    { completed?: number } | undefined
  const legacyMigrationFlag = db
    .prepare('SELECT completed FROM migration_flags WHERE flag_name = ?')
    .get(LEGACY_LOCAL_EMBEDDING_MIGRATION_FLAG) as
    { completed?: number } | undefined

  const removeStaleLocalIndex = () => {
    if (existsSync(hnswLocalIndexFilePath)) {
      unlinkSync(hnswLocalIndexFilePath)
    }
  }

  // The old flag proves that database invalidation already happened, but not
  // that the HNSW file was removed or replacement vectors were generated.
  if (invalidationFlag?.completed || legacyMigrationFlag?.completed) {
    try {
      removeStaleLocalIndex()
      db.prepare(
        'INSERT OR REPLACE INTO migration_flags (flag_name, completed) VALUES (?, 1)'
      ).run(LOCAL_EMBEDDING_INVALIDATION_FLAG)
    } catch (error) {
      db.prepare('DELETE FROM migration_flags WHERE flag_name = ?').run(
        LOCAL_EMBEDDING_INVALIDATION_FLAG
      )
      console.error(
        '[ThoughtVectorStore Migration] Failed to remove stale local HNSW index:',
        error
      )
    }
    return
  }

  try {
    // all-MiniLM-L6-v2 and multilingual-e5-small both use 384 dimensions,
    // but their vector spaces are incompatible. Invalidate only local
    // vectors; OpenAI embeddings and the original text remain untouched.
    const thoughts = db
      .prepare(
        'UPDATE thoughts SET embedding_local = NULL WHERE embedding_local IS NOT NULL'
      )
      .run().changes
    const memories = db
      .prepare(
        'UPDATE long_term_memories SET embedding_local = NULL WHERE embedding_local IS NOT NULL'
      )
      .run().changes
    removeStaleLocalIndex()
    db.prepare(
      'INSERT OR REPLACE INTO migration_flags (flag_name, completed) VALUES (?, 1)'
    ).run(LOCAL_EMBEDDING_INVALIDATION_FLAG)
    if (thoughts || memories) {
      console.log(
        `[ThoughtVectorStore Migration] Invalidated ${thoughts} legacy thought and ${memories} legacy memory local embeddings for ${LOCAL_EMBEDDING_MODEL}.`
      )
    }
  } catch (error) {
    db.prepare('DELETE FROM migration_flags WHERE flag_name = ?').run(
      LOCAL_EMBEDDING_INVALIDATION_FLAG
    )
    console.error(
      '[ThoughtVectorStore Migration] Failed to invalidate legacy local embeddings:',
      error
    )
  }
}

async function generateLocalEmbeddings(texts: string[]): Promise<number[][]> {
  const response = await axios.post(
    `${backendManager.getApiUrl()}/api/embeddings/generate-batch`,
    { texts, input_type: 'passage' },
    { timeout: 60000 }
  )
  if (!response.data?.success) {
    throw new Error(
      response.data?.error || 'Local embedding generation failed.'
    )
  }
  const embeddings = response.data.data?.embeddings
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new Error('Local embedding batch size mismatch.')
  }
  return embeddings
}

async function waitForLocalEmbeddingsReady(): Promise<void> {
  const deadline = Date.now() + LOCAL_EMBEDDING_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await axios.get(
        `${backendManager.getApiUrl()}/api/embeddings/ready`,
        { timeout: 5000 }
      )
      if (response.data?.success && response.data?.data?.ready === true) {
        return
      }
    } catch {
      // The backend may still be downloading or initializing the model.
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(
    'Local embeddings service did not become ready before the migration timeout.'
  )
}

function toEmbeddingBuffer(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer)
}

async function reindexLocalRows(
  rows: Array<{ id: string; text: string }>,
  updateSql: string,
  label: string
): Promise<number> {
  if (!db || rows.length === 0) return 0

  let indexed = 0
  for (
    let offset = 0;
    offset < rows.length;
    offset += LOCAL_EMBEDDING_BATCH_SIZE
  ) {
    const batch = rows.slice(offset, offset + LOCAL_EMBEDDING_BATCH_SIZE)
    const embeddings = await generateLocalEmbeddings(batch.map(row => row.text))

    const update = db.prepare(updateSql)
    db.transaction(() => {
      for (let index = 0; index < batch.length; index += 1) {
        const embedding = embeddings[index]
        if (
          !Array.isArray(embedding) ||
          embedding.length !== LOCAL_VECTOR_DIMENSION
        ) {
          throw new Error(
            `[ThoughtVectorStore Migration] Invalid ${label} embedding payload.`
          )
        }
        const result = update.run(toEmbeddingBuffer(embedding), batch[index].id)
        indexed += result.changes
      }
    })()
  }

  return indexed
}

export async function reindexMultilingualLocalEmbeddings(): Promise<{
  required: boolean
  indexed: number
}> {
  if (!db || !isStoreInitialized) {
    await initializeThoughtVectorStore()
  }
  if (!db) throw new Error('Thought vector database is not initialized.')

  const migrationFlag = db
    .prepare('SELECT completed FROM migration_flags WHERE flag_name = ?')
    .get(LOCAL_EMBEDDING_REINDEXED_FLAG) as { completed?: number } | undefined
  if (migrationFlag?.completed) {
    return { required: false, indexed: 0 }
  }

  const thoughts = db
    .prepare(
      'SELECT thought_id as id, text_content as text FROM thoughts WHERE embedding_local IS NULL'
    )
    .all() as Array<{ id: string; text: string }>
  const memories = db
    .prepare(
      'SELECT id, content as text FROM long_term_memories WHERE embedding_local IS NULL'
    )
    .all() as Array<{ id: string; text: string }>

  if (thoughts.length > 0 || memories.length > 0) {
    await waitForLocalEmbeddingsReady()
  }

  const indexedThoughts = await reindexLocalRows(
    thoughts,
    'UPDATE thoughts SET embedding_local = ? WHERE thought_id = ? AND embedding_local IS NULL',
    'thought'
  )
  const indexedMemories = await reindexLocalRows(
    memories,
    'UPDATE long_term_memories SET embedding_local = ? WHERE id = ? AND embedding_local IS NULL',
    'memory'
  )

  await rebuildHnswIndexFromDB('local')
  db.prepare(
    'INSERT OR REPLACE INTO migration_flags (flag_name, completed) VALUES (?, 1)'
  ).run(LOCAL_EMBEDDING_REINDEXED_FLAG)

  console.log(
    `[ThoughtVectorStore Migration] Reindexed ${indexedThoughts} thoughts and ${indexedMemories} memories with ${LOCAL_EMBEDDING_MODEL}.`
  )
  return {
    required: true,
    indexed: indexedThoughts + indexedMemories,
  }
}

function runDualEmbeddingMigration() {
  if (!db) return

  // Check if migration already completed
  const migrationFlag = db
    .prepare('SELECT completed FROM migration_flags WHERE flag_name = ?')
    .get('dual_embedding_support')
  if (migrationFlag?.completed) {
    return
  }

  try {
    // Backup existing embedding column to openai-specific column for thoughts table
    db.exec(`
      ALTER TABLE thoughts ADD COLUMN embedding_openai BLOB;
      ALTER TABLE thoughts ADD COLUMN embedding_local BLOB;
    `)

    // Migrate existing embeddings to openai column
    const existingThoughtsStmt = db.prepare(
      'SELECT hnsw_label, embedding FROM thoughts WHERE embedding IS NOT NULL'
    )
    const updateThoughtStmt = db.prepare(
      'UPDATE thoughts SET embedding_openai = ? WHERE hnsw_label = ?'
    )

    const existingThoughts = existingThoughtsStmt.all() as {
      hnsw_label: number
      embedding: Buffer
    }[]
    for (const thought of existingThoughts) {
      updateThoughtStmt.run(thought.embedding, thought.hnsw_label)
    }

    // Backup existing embedding column to openai-specific column for long_term_memories table
    db.exec(`
      ALTER TABLE long_term_memories ADD COLUMN embedding_openai BLOB;
      ALTER TABLE long_term_memories ADD COLUMN embedding_local BLOB;
    `)

    // Migrate existing embeddings to openai column
    const existingMemoriesStmt = db.prepare(
      'SELECT id, embedding FROM long_term_memories WHERE embedding IS NOT NULL'
    )
    const updateMemoryStmt = db.prepare(
      'UPDATE long_term_memories SET embedding_openai = ? WHERE id = ?'
    )

    const existingMemories = existingMemoriesStmt.all() as {
      id: string
      embedding: Buffer
    }[]
    for (const memory of existingMemories) {
      updateMemoryStmt.run(memory.embedding, memory.id)
    }

    // Mark migration as completed
    db.prepare(
      'INSERT OR REPLACE INTO migration_flags (flag_name, completed) VALUES (?, 1)'
    ).run('dual_embedding_support')

    if (existingThoughts.length > 0 || existingMemories.length > 0) {
      console.log(
        `[ThoughtVectorStore Migration] Migrated ${existingThoughts.length} thoughts and ${existingMemories.length} memories to dual embedding support.`
      )
    }
  } catch (error) {
    console.error(
      '[ThoughtVectorStore Migration] Error during dual embedding migration:',
      error
    )
    // Migration failure is non-fatal - system will continue with legacy single embedding column
  }
}

async function migrateMemoriesFromJsonToDb() {
  if (!db) {
    console.error('[Migration] DB not initialized. Cannot migrate.')
    return
  }

  const migrationFlag = db
    .prepare('SELECT completed FROM migration_flags WHERE flag_name = ?')
    .get('json_memories_migrated') as { completed: number } | undefined

  if (migrationFlag && migrationFlag.completed === 1) {
    console.log('[Migration] JSON memories already migrated. Skipping.')
    return
  }

  try {
    await fs.access(oldJsonMemoriesPath)
    const jsonData = await fs.readFile(oldJsonMemoriesPath, 'utf-8')
    const oldMemories = JSON.parse(jsonData) as MemoryRecord[]

    if (oldMemories && oldMemories.length > 0) {
      console.log(
        `[Migration] Found ${oldMemories.length} memories in JSON file. Starting migration...`
      )
      const insertStmt = db.prepare(
        'INSERT OR IGNORE INTO long_term_memories (id, content, memory_type, created_at, embedding) VALUES (?, ?, ?, ?, ?)'
      )

      db.transaction(() => {
        for (const memory of oldMemories) {
          insertStmt.run(
            memory.id || randomUUID(),
            memory.content,
            memory.memoryType,
            memory.createdAt,
            null
          )
        }
      })()
      console.log(
        '[Migration] Successfully migrated memories from JSON to SQLite.'
      )

      db.prepare(
        'INSERT OR REPLACE INTO migration_flags (flag_name, completed) VALUES (?, ?)'
      ).run('json_memories_migrated', 1)

      try {
        await fs.rename(oldJsonMemoriesPath, `${oldJsonMemoriesPath}.migrated`)
        console.log(
          `[Migration] Renamed old JSON memories file to ${OLD_MEMORIES_JSON_FILE}.migrated`
        )
      } catch (renameError) {
        console.error(
          '[Migration] Could not rename old JSON file, please handle manually:',
          renameError
        )
      }
    } else {
      console.log(
        '[Migration] Old JSON memories file is empty or not found. No migration needed from JSON.'
      )
      db.prepare(
        'INSERT OR REPLACE INTO migration_flags (flag_name, completed) VALUES (?, ?)'
      ).run('json_memories_migrated', 1)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(
        '[Migration] Old JSON memories file not found. No migration needed from JSON.'
      )
      db.prepare(
        'INSERT OR REPLACE INTO migration_flags (flag_name, completed) VALUES (?, ?)'
      ).run('json_memories_migrated', 1)
    } else {
      console.error('[Migration] Error during JSON memory migration:', error)
    }
  }
}

function insertThoughtMetadata(
  thoughtId: string,
  conversationId: string,
  role: string,
  textContent: string,
  createdAt: string,
  embedding: number[],
  provider: EmbeddingProvider = 'openai'
) {
  if (!db) throw new Error('Database not initialized for inserting metadata.')
  try {
    const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer)

    // Check if this thought already exists
    const existingStmt = db.prepare(
      'SELECT thought_id FROM thoughts WHERE thought_id = ?'
    )
    const existing = existingStmt.get(thoughtId)

    if (existing) {
      // Update existing thought with new embedding
      const embeddingColumn =
        provider === 'local'
          ? 'embedding_local'
          : provider === 'doubao'
            ? 'embedding_doubao'
            : 'embedding_openai'
      const updateStmt = db.prepare(`
        UPDATE thoughts SET ${embeddingColumn} = ?, 
        role = ?, text_content = ?, created_at = ?
        WHERE thought_id = ?
      `)
      updateStmt.run(embeddingBuffer, role, textContent, createdAt, thoughtId)

      // Also update legacy embedding column for backward compatibility
      if (provider === 'openai') {
        const legacyStmt = db.prepare(
          'UPDATE thoughts SET embedding = ? WHERE thought_id = ?'
        )
        legacyStmt.run(embeddingBuffer, thoughtId)
      }
    } else {
      // Insert new thought - generate unique hnsw_label to avoid constraint issues
      const embeddingOpenAI = provider === 'openai' ? embeddingBuffer : null
      const embeddingLocal = provider === 'local' ? embeddingBuffer : null
      const embeddingDoubao = provider === 'doubao' ? embeddingBuffer : null
      const legacyEmbedding = provider === 'openai' ? embeddingBuffer : null

      // Get next available hnsw_label from database
      const maxLabelResult = db
        .prepare(
          'SELECT COALESCE(MAX(hnsw_label), -1) + 1 as next_label FROM thoughts'
        )
        .get() as { next_label: number }
      const nextLabel = maxLabelResult.next_label

      const insertStmt = db.prepare(`
        INSERT INTO thoughts (hnsw_label, thought_id, conversation_id, role, text_content, created_at, embedding, embedding_openai, embedding_local, embedding_doubao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const info = insertStmt.run(
        nextLabel,
        thoughtId,
        conversationId,
        role,
        textContent,
        createdAt,
        legacyEmbedding,
        embeddingOpenAI,
        embeddingLocal,
        embeddingDoubao
      )

      if (info.changes === 0) {
        console.warn(
          '[insertThoughtMetadata] SQLite insert reported 0 changes. ID might exist or other issue.',
          { thoughtId }
        )
      }
    }
  } catch (dbError) {
    console.error('[insertThoughtMetadata] SQLite insert FAILED:', dbError)
    throw dbError
  }
}

function getThoughtMetadataByLabels(
  labels: number[],
  provider: EmbeddingProvider
): ThoughtMetadata[] {
  if (!db) throw new Error('Database not initialized for fetching metadata.')
  if (labels.length === 0) return []

  const labelMapping = getLabelMappingForProvider(provider)

  // Convert HNSW labels to thought_ids using our mapping
  const thoughtIds = labels
    .map(label => labelMapping.get(label))
    .filter(Boolean) as string[]

  if (thoughtIds.length === 0) return []

  const placeholders = thoughtIds.map(() => '?').join(',')
  const stmt = db.prepare(`
        SELECT thought_id, conversation_id, role, text_content, created_at
        FROM thoughts
        WHERE thought_id IN (${placeholders})
        ORDER BY created_at
    `)
  const rows = stmt.all(...thoughtIds) as any[]
  return rows.map(row => ({
    id: row.thought_id,
    conversationId: row.conversation_id,
    role: row.role,
    textContent: row.text_content,
    createdAt: row.created_at,
  }))
}

function getAllEmbeddingsWithLabelsFromDB(provider: EmbeddingProvider): {
  label: number
  embedding: number[]
  thoughtId: string
}[] {
  if (!db) throw new Error('Database not initialized for fetching embeddings.')

  let query: string
  if (provider === 'local') {
    query =
      'SELECT thought_id, embedding_local as embedding FROM thoughts WHERE embedding_local IS NOT NULL ORDER BY thought_id'
  } else if (provider === 'doubao') {
    query =
      'SELECT thought_id, embedding_doubao as embedding FROM thoughts WHERE embedding_doubao IS NOT NULL ORDER BY thought_id'
  } else {
    // For OpenAI, prefer new column but fallback to legacy
    query =
      'SELECT thought_id, COALESCE(embedding_openai, embedding) as embedding FROM thoughts WHERE embedding_openai IS NOT NULL OR (embedding_openai IS NULL AND embedding IS NOT NULL) ORDER BY thought_id'
  }

  const stmt = db.prepare(query)
  const rows = stmt.all() as { thought_id: string; embedding: Buffer }[]

  // Create sequential labels for this provider
  return rows.map((row, index) => ({
    label: index, // Sequential labeling per provider
    thoughtId: row.thought_id,
    embedding: Array.from(
      new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT
      )
    ),
  }))
}

async function loadIndexAndSyncWithDB() {
  if (!db)
    throw new Error('Failed to initialize database for loading HNSW index.')

  // Initialize all three provider indices
  loadPersistedDoubaoDimension()
  hnswOpenAIIndex = new HierarchicalNSW('cosine', OPENAI_VECTOR_DIMENSION)
  hnswLocalIndex = new HierarchicalNSW('cosine', LOCAL_VECTOR_DIMENSION)
  hnswDoubaoIndex = new HierarchicalNSW('cosine', doubaoVectorDimension)

  let numPointsInDB = 0
  let numOpenAIEmbeddings = 0
  let numLocalEmbeddings = 0
  let numDoubaoEmbeddings = 0

  try {
    const countResult = db
      .prepare('SELECT COUNT(*) as count FROM thoughts')
      .get() as { count: number }
    numPointsInDB = countResult.count

    // Count OpenAI and Local embeddings separately
    const openaiCountResult = db
      .prepare(
        'SELECT COUNT(*) as count FROM thoughts WHERE embedding_openai IS NOT NULL OR (embedding_openai IS NULL AND embedding IS NOT NULL)'
      )
      .get() as { count: number }
    numOpenAIEmbeddings = openaiCountResult.count

    const localCountResult = db
      .prepare(
        'SELECT COUNT(*) as count FROM thoughts WHERE embedding_local IS NOT NULL'
      )
      .get() as { count: number }
    numLocalEmbeddings = localCountResult.count

    const doubaoCountResult = db
      .prepare(
        'SELECT COUNT(*) as count FROM thoughts WHERE embedding_doubao IS NOT NULL'
      )
      .get() as { count: number }
    numDoubaoEmbeddings = doubaoCountResult.count
  } catch (e) {
    console.error('[ThoughtVectorStore DB] Error counting thoughts in DB:', e)
  }

  if (numPointsInDB > 0) {
    console.log(
      `[ThoughtVectorStore LOAD] Loading ${numPointsInDB} points (OpenAI: ${numOpenAIEmbeddings}, Local: ${numLocalEmbeddings}, Doubao: ${numDoubaoEmbeddings})`
    )
  }

  // Load OpenAI index
  await loadProviderIndex(
    'openai',
    hnswOpenAIIndex,
    hnswOpenAIIndexFilePath,
    numOpenAIEmbeddings
  )

  // Load Local index
  await loadProviderIndex(
    'local',
    hnswLocalIndex,
    hnswLocalIndexFilePath,
    numLocalEmbeddings
  )

  // Load Doubao index
  await loadProviderIndex(
    'doubao',
    hnswDoubaoIndex,
    hnswDoubaoIndexFilePath,
    numDoubaoEmbeddings
  )

  isStoreInitialized = true
}

async function loadProviderIndex(
  provider: EmbeddingProvider,
  index: HierarchicalNSWIndex,
  indexFilePath: string,
  numEmbeddings: number
) {
  try {
    if (numEmbeddings > 0) {
      try {
        await index.readIndex(indexFilePath)

        if (index.getCurrentCount() !== numEmbeddings) {
          console.warn(
            `[ThoughtVectorStore LOAD] ${provider} HNSW index count (${index.getCurrentCount()}) mismatch with DB count (${numEmbeddings}). Rebuilding HNSW index from DB embeddings.`
          )
          await rebuildHnswIndexFromDB(provider)
        }
        if (index.getMaxElements() < numEmbeddings) {
          console.warn(
            `[ThoughtVectorStore LOAD] ${provider} HNSW index capacity is less than DB points. Resizing index.`
          )
          index.resizeIndex(Math.max(MAX_ELEMENTS_HNSW, numEmbeddings + 1000))
        }
      } catch (loadError) {
        await rebuildHnswIndexFromDB(provider)
      }
    } else {
      index.initIndex(MAX_ELEMENTS_HNSW)
    }
  } catch (error) {
    console.warn(
      `[ThoughtVectorStore LOAD] Error initializing ${provider} index: ${(error as Error).message}. Initializing fresh index.`
    )
    index.initIndex(MAX_ELEMENTS_HNSW)
  }
}

async function rebuildHnswIndexFromDB(provider: EmbeddingProvider) {
  const index = getIndexForProvider(provider)
  const labelMapping = getLabelMappingForProvider(provider)

  if (!db || !index) {
    console.error(
      `[ThoughtVectorStore REBUILD] DB or ${provider} HNSW Index not initialized. Cannot rebuild.`
    )
    return
  }

  // Count embeddings for this provider
  const countQuery =
    provider === 'local'
      ? 'SELECT COUNT(*) as count FROM thoughts WHERE embedding_local IS NOT NULL'
      : provider === 'doubao'
        ? 'SELECT COUNT(*) as count FROM thoughts WHERE embedding_doubao IS NOT NULL'
        : 'SELECT COUNT(*) as count FROM thoughts WHERE embedding_openai IS NOT NULL OR (embedding_openai IS NULL AND embedding IS NOT NULL)'

  const embeddingCount = (db.prepare(countQuery).get() as { count: number })
    .count

  index.initIndex(Math.max(MAX_ELEMENTS_HNSW, embeddingCount + 1000))

  // Clear and rebuild label mapping
  labelMapping.clear()

  const allEmbeddings = getAllEmbeddingsWithLabelsFromDB(provider)
  if (allEmbeddings.length === 0) {
    console.log(
      `[ThoughtVectorStore REBUILD] No ${provider} embeddings in DB to rebuild index from.`
    )
    return
  }

  const expectedDim = getDimensionForProvider(provider)
  const compatibleEmbeddings = allEmbeddings.filter(
    item => item.embedding.length === expectedDim
  )
  if (compatibleEmbeddings.length !== allEmbeddings.length) {
    console.warn(
      `[ThoughtVectorStore REBUILD] Skipped ${allEmbeddings.length - compatibleEmbeddings.length} ${provider} embeddings with stale dimension (expected ${expectedDim}).`
    )
  }
  if (compatibleEmbeddings.length === 0) {
    return
  }

  for (const item of compatibleEmbeddings) {
    if (item.label >= index.getMaxElements()) {
      index.resizeIndex(item.label + 1000)
    }
    index.addPoint(item.embedding, item.label)
    labelMapping.set(item.label, item.thoughtId)
  }
  await saveHnswIndex(provider)
}

async function saveHnswIndex(provider?: EmbeddingProvider) {
  if (!isStoreInitialized) {
    console.warn(
      '[ThoughtVectorStore Save] Attempted to save HNSW index but store not ready.'
    )
    return
  }

  // If no provider specified, save all
  if (!provider) {
    await saveHnswIndex('openai')
    await saveHnswIndex('local')
    await saveHnswIndex('doubao')
    return
  }

  const index = getIndexForProvider(provider)
  const indexFilePath = getIndexPathForProvider(provider)

  if (!index) {
    console.warn(
      `[ThoughtVectorStore Save] ${provider} HNSW index not initialized.`
    )
    return
  }

  try {
    const dir = path.dirname(indexFilePath)
    await fs.mkdir(dir, { recursive: true })
    await index.writeIndex(indexFilePath)
  } catch (error) {
    console.error(
      `[ThoughtVectorStore] Error saving ${provider} HNSW index:`,
      error
    )
  }
}

export async function initializeThoughtVectorStore(): Promise<void> {
  if (isStoreInitialized) return
  initDB()
  await migrateMemoriesFromJsonToDb()
  await loadIndexAndSyncWithDB()
}

export async function addThoughtVector(
  conversationId: string,
  role: string,
  textContent: string,
  embedding: number[],
  provider: EmbeddingProvider = 'openai'
): Promise<void> {
  const expectedDimension = getDimensionForProvider(provider)
  let hnswIndex = getIndexForProvider(provider)

  if (!isStoreInitialized || !hnswIndex || !db) {
    console.error('[ThoughtVectorStore ADD] Store not initialized properly.')
    await initializeThoughtVectorStore()
    hnswIndex = getIndexForProvider(provider)
    if (!isStoreInitialized || !hnswIndex || !db) {
      throw new Error(
        'Failed to initialize thought vector store for adding vector.'
      )
    }
  }

  if (embedding.length !== expectedDimension) {
    if (provider === 'doubao' && embedding.length > 0) {
      // The configured doubao model changed its native output dimension.
      // Recreate the doubao HNSW bucket instead of rejecting the vector.
      console.warn(
        `[ThoughtVectorStore ADD] Doubao embedding dimension changed: ${doubaoVectorDimension} -> ${embedding.length}. Recreating doubao HNSW index.`
      )
      hnswDoubaoIndex = new HierarchicalNSW('cosine', embedding.length)
      hnswDoubaoIndex.initIndex(MAX_ELEMENTS_HNSW)
      doubaoLabelToThoughtId.clear()
      doubaoVectorDimension = embedding.length
      persistDoubaoDimension()
      hnswIndex = hnswDoubaoIndex
    } else {
      throw new Error(
        `[ThoughtVectorStore ADD] Embedding dimension mismatch for ${provider}. Expected ${expectedDimension}, got ${embedding.length}`
      )
    }
  }

  // Generate a unique thought ID
  const thoughtId = `${conversationId}-${role}-${Date.now()}-${randomUUID().substring(0, 8)}`
  const currentIndex = getIndexForProvider(provider)
  const labelMapping = getLabelMappingForProvider(provider)

  // Get next available label for this provider's index
  const label = currentIndex!.getCurrentCount()

  if (label >= currentIndex!.getMaxElements()) {
    console.warn(
      `[ThoughtVectorStore ADD] ${provider} index is full (max ${currentIndex!.getMaxElements()}). Resizing.`
    )
    const newMaxElements =
      currentIndex!.getMaxElements() +
      Math.max(1000, Math.floor(currentIndex!.getMaxElements() * 0.2))
    currentIndex!.resizeIndex(newMaxElements)
    console.log(
      `[ThoughtVectorStore ADD] ${provider} index resized to ${newMaxElements}`
    )
  }

  db.transaction(() => {
    insertThoughtMetadata(
      thoughtId,
      conversationId,
      role,
      textContent,
      new Date().toISOString(),
      embedding,
      provider
    )
    currentIndex!.addPoint(embedding, label)
    labelMapping.set(label, thoughtId)
  })()

  await saveHnswIndex(provider)
}

export async function searchSimilarThoughts(
  queryEmbedding: number[],
  topK: number,
  provider?: EmbeddingProvider | 'both'
): Promise<ThoughtMetadata[]> {
  if (!isStoreInitialized || !db) {
    console.log('[ThoughtVectorStore SEARCH] Store not ready.')
    return []
  }

  // Auto-detect provider based on embedding dimension if not specified
  if (!provider) {
    if (queryEmbedding.length === OPENAI_VECTOR_DIMENSION) {
      provider = 'openai'
    } else if (queryEmbedding.length === LOCAL_VECTOR_DIMENSION) {
      provider = 'local'
    } else if (queryEmbedding.length === DOUBAO_VECTOR_DIMENSION) {
      provider = 'doubao'
    } else {
      console.error(
        `[ThoughtVectorStore SEARCH] Unknown embedding dimension: ${queryEmbedding.length}`
      )
      return []
    }
  }

  // Handle dual search from both providers
  if (provider === 'both') {
    const openaiResults = await searchWithProvider(
      queryEmbedding,
      topK,
      'openai'
    )
    const localResults = await searchWithProvider(queryEmbedding, topK, 'local')

    // Combine and deduplicate results, preserving order
    const combined = [...openaiResults, ...localResults]
    const seen = new Set<string>()
    const unique = combined.filter(item => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })

    return unique.slice(0, topK)
  }

  return await searchWithProvider(queryEmbedding, topK, provider)
}

async function searchWithProvider(
  queryEmbedding: number[],
  topK: number,
  provider: EmbeddingProvider
): Promise<ThoughtMetadata[]> {
  const expectedDimension = getDimensionForProvider(provider)
  const hnswIndex = getIndexForProvider(provider)

  if (!hnswIndex || hnswIndex.getCurrentCount() === 0) {
    return []
  }

  if (queryEmbedding.length !== expectedDimension) {
    console.error(
      `[ThoughtVectorStore SEARCH] Query embedding dimension mismatch for ${provider}. Expected ${expectedDimension}, got ${queryEmbedding.length}`
    )
    return []
  }

  const numPointsInIndex = hnswIndex.getCurrentCount()
  if (numPointsInIndex === 0) return []

  const results = hnswIndex.searchKnn(
    queryEmbedding,
    Math.min(topK, numPointsInIndex)
  )

  if (!results || !results.neighbors || results.neighbors.length === 0) {
    return []
  }

  const retrievedMetadata = getThoughtMetadataByLabels(
    results.neighbors,
    provider
  )

  return retrievedMetadata
}

export async function deleteAllThoughtVectors(): Promise<void> {
  if (!isStoreInitialized || !db) {
    console.warn(
      '[ThoughtVectorStore DELETE ALL] Store not initialized. Attempting init.'
    )
    await initializeThoughtVectorStore()
    if (!isStoreInitialized || !db) {
      console.error(
        '[ThoughtVectorStore DELETE ALL] Initialization failed. Cannot delete.'
      )
      return
    }
  }
  db.prepare('DELETE FROM thoughts').run()

  // Clear all indices and mappings
  if (hnswOpenAIIndex) {
    hnswOpenAIIndex = new HierarchicalNSW('cosine', OPENAI_VECTOR_DIMENSION)
    hnswOpenAIIndex.initIndex(MAX_ELEMENTS_HNSW)
    openAILabelToThoughtId.clear()
  }
  if (hnswLocalIndex) {
    hnswLocalIndex = new HierarchicalNSW('cosine', LOCAL_VECTOR_DIMENSION)
    hnswLocalIndex.initIndex(MAX_ELEMENTS_HNSW)
    localLabelToThoughtId.clear()
  }
  if (hnswDoubaoIndex) {
    hnswDoubaoIndex = new HierarchicalNSW('cosine', doubaoVectorDimension)
    hnswDoubaoIndex.initIndex(MAX_ELEMENTS_HNSW)
    doubaoLabelToThoughtId.clear()
  }

  await saveHnswIndex()
}

export async function ensureSaveOnQuit(): Promise<void> {
  if (isStoreInitialized) {
    if (
      (hnswOpenAIIndex && hnswOpenAIIndex.getCurrentCount() > 0) ||
      (hnswLocalIndex && hnswLocalIndex.getCurrentCount() > 0) ||
      (hnswDoubaoIndex && hnswDoubaoIndex.getCurrentCount() > 0)
    ) {
      await saveHnswIndex()
    }
  }
  if (db) {
    db.close((err: Error | null) => {
      if (err) {
        console.error(
          '[ThoughtVectorStore QUIT_SAVE] Error closing DB:',
          err.message
        )
      } else {
        console.log('[ThoughtVectorStore QUIT_SAVE] DB connection closed.')
      }
    })
    db = null
  }
}

export function getDBInstance(): SQLiteDatabase {
  if (!db) {
    initDB()
  }
  if (!db) {
    throw new Error('Failed to initialize database instance.')
  }
  return db
}

/**
 * Retrieves the most recent raw messages from the thoughts table for summarization.
 * @param limit The maximum number of messages to retrieve.
 * @param conversationId Optional. If provided, messages will be scoped to this conversation.
 * @returns A promise that resolves to an array of RawMessageRecord.
 */
export async function getRecentMessagesForSummarization(
  limit: number,
  conversationId?: string
): Promise<RawMessageRecord[]> {
  const currentDb = getDBInstance()
  try {
    let sql = 'SELECT role, text_content, created_at FROM thoughts'
    const params: any[] = []

    if (conversationId) {
      sql += ' WHERE conversation_id = ?'
      params.push(conversationId)
    }

    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    const rows = currentDb.prepare(sql).all(...params) as RawMessageRecord[]
    return rows.reverse()
  } catch (error) {
    console.error(
      'Failed to get recent messages for summarization from SQLite:',
      error
    )
    throw error
  }
}

/**
 * Saves a new conversation summary to the database.
 * @param summaryText The text of the summary.
 * @param summarizedMessagesCount The number of messages that were summarized.
 * @param conversationId Optional. The ID of the conversation this summary belongs to.
 * @returns A promise that resolves to the saved ConversationSummaryRecord.
 */
export async function saveConversationSummary(
  summaryText: string,
  summarizedMessagesCount: number,
  conversationId?: string
): Promise<ConversationSummaryRecord> {
  const currentDb = getDBInstance()
  const id = randomUUID()
  const createdAt = new Date().toISOString()

  try {
    const stmt = currentDb.prepare(
      'INSERT INTO conversation_summaries (id, summary_text, summarized_messages_count, conversation_id, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    stmt.run(
      id,
      summaryText,
      summarizedMessagesCount,
      conversationId,
      createdAt
    )
    console.log(
      '[ThoughtVectorStore] Conversation summary saved to SQLite:',
      id
    )
    return {
      id,
      summary_text: summaryText,
      summarized_messages_count: summarizedMessagesCount,
      conversation_id: conversationId,
      created_at: createdAt,
    }
  } catch (error) {
    console.error('Failed to save conversation summary to SQLite:', error)
    throw error
  }
}

/**
 * Retrieves the latest conversation summary.
 * @param conversationId Optional. If provided, retrieves the latest summary for that specific conversation.
 * @returns A promise that resolves to the latest ConversationSummaryRecord or null if none found.
 */
export async function getLatestConversationSummary(
  conversationId?: string
): Promise<ConversationSummaryRecord | null> {
  const currentDb = getDBInstance()
  try {
    let sql =
      'SELECT id, summary_text, summarized_messages_count, conversation_id, created_at FROM conversation_summaries'
    const params: any[] = []

    if (conversationId) {
      sql += ' WHERE conversation_id = ?'
      params.push(conversationId)
    }

    sql += ' ORDER BY created_at DESC LIMIT 1'

    const row = currentDb.prepare(sql).get(...params) as
      ConversationSummaryRecord | undefined
    return row || null
  } catch (error) {
    console.error(
      'Failed to get latest conversation summary from SQLite:',
      error
    )
    throw error
  }
}
