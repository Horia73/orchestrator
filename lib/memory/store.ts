// Semantic-memory storage layer (multi-generation).
//
// Reuses the shared better-sqlite3 connection (lib/db.ts default export) but
// OWNS its own tables, created here rather than in lib/db.ts so the feature is
// self-contained and removable in one place.
//
// MULTI-GENERATION MODEL (why this is more than a flat vector table):
// Changing the embedding model moves the vector space — old vectors are
// meaningless against new-model queries. We therefore key embeddings by
// GENERATION = (model, dim) and search ONLY the active generation, so a model
// switch degrades to partial coverage, never to garbage. Crucially, switching
// BACK to a previously-used model is FREE: its vectors are retained on disk and
// reused as long as the source content is unchanged. Old MEMORY_DAY files are
// immutable, so the bulk of the corpus never needs re-embedding again across
// any number of model switches.
//
// Layout:
//  - memory_content: one row per source = the CURRENT content hash (model-
//    independent). Drives content-change detection and owns the FTS rows.
//  - memory_generations: which (source, model, dim) generations are built for
//    the current content. PK (source, model, dim).
//  - memory_chunks: the embeddings, one row per (source, model, dim, chunkIndex).
//  - memory_fts: keyword index over current content (model-independent).
//  - memory_meta: schema version (the index is a derived cache; a version bump
//    drops + rebuilds it from the upstream memory/chat sources).

import db from "@/lib/db"

const SCHEMA_VERSION = 2

// ---------------------------------------------------------------------------
// Schema + migration (derived cache: drop & rebuild on version change)
// ---------------------------------------------------------------------------

db.exec(`CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT)`)

const versionRow = db
  .prepare(`SELECT value FROM memory_meta WHERE key = 'schemaVersion'`)
  .get() as { value: string } | undefined
const installedVersion = versionRow ? Number(versionRow.value) : 0

if (installedVersion !== SCHEMA_VERSION) {
  // The index is fully rebuildable from the workspace markdown files, so a
  // schema change just drops the old shape and lets sync repopulate.
  db.exec(`
    DROP TABLE IF EXISTS memory_chunks;
    DROP TABLE IF EXISTS memory_sources;
    DROP TABLE IF EXISTS memory_generations;
    DROP TABLE IF EXISTS memory_content;
  `)
  try {
    db.exec(`DROP TABLE IF EXISTS memory_fts`)
  } catch {
    /* fts may be absent */
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS memory_content (
    source TEXT PRIMARY KEY,
    contentHash TEXT NOT NULL,
    chunkCount INTEGER NOT NULL DEFAULT 0,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_generations (
    source TEXT NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    contentHash TEXT NOT NULL,
    chunkCount INTEGER NOT NULL DEFAULT 0,
    indexedAt INTEGER NOT NULL,
    PRIMARY KEY (source, model, dim)
  );

  CREATE TABLE IF NOT EXISTS memory_chunks (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    chunkIndex INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_chunks_gen ON memory_chunks(model, dim);
  CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON memory_chunks(source);
`)

// FTS5 may be absent in exotic SQLite builds; degrade gracefully.
let ftsAvailable = false
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      text,
      id UNINDEXED,
      source UNINDEXED,
      title UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `)
  ftsAvailable = true
} catch {
  ftsAvailable = false
}

if (installedVersion !== SCHEMA_VERSION) {
  db.prepare(
    `INSERT INTO memory_meta (key, value) VALUES ('schemaVersion', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(SCHEMA_VERSION))
}

export function isFtsAvailable(): boolean {
  return ftsAvailable
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContentChunk {
  chunkIndex: number
  title: string
  text: string
}

export interface IndexChunkInput extends ContentChunk {
  embedding: Float32Array
}

export interface VectorRow {
  id: string
  source: string
  title: string
  text: string
  vector: Float32Array
}

export interface GenerationStat {
  model: string
  dim: number
  sources: number
  chunks: number
}

export interface MemoryStatus {
  activeModel: string
  activeDim: number
  /** Sources present on disk and content-indexed. */
  sources: number
  /** Sources that have an embedding generation for the ACTIVE model+dim. */
  activeSources: number
  /** Chunks embedded for the active generation. */
  activeChunks: number
  /** Sources still needing embedding for the active generation. */
  needsIndexing: number
  /** Every generation present on disk (the models you can switch to for free). */
  generations: GenerationStat[]
}

interface ChunkDbRow {
  id: string
  source: string
  title: string
  text: string
  embedding: Buffer
}

// ---------------------------------------------------------------------------
// Float32 <-> BLOB
// ---------------------------------------------------------------------------

function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

function bufferToVector(buf: Buffer): Float32Array {
  const copy = Buffer.from(buf)
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4))
}

function chunkId(source: string, model: string, dim: number, chunkIndex: number): string {
  return `${source}#${model}@${dim}#${chunkIndex}`
}

function ftsId(source: string, chunkIndex: number): string {
  return `${source}#${chunkIndex}`
}

// ---------------------------------------------------------------------------
// In-memory vector cache (per active generation)
// ---------------------------------------------------------------------------

let cacheVersion = 0
let cached: {
  version: number
  dataVersion: number
  key: string
  rows: VectorRow[]
} | null = null

function bumpVectorCache(): void {
  cacheVersion += 1
}

// data_version changes when ANOTHER connection commits (e.g. the backfill
// script while the server runs); cacheVersion covers same-connection writes.
function dbDataVersion(): number {
  try {
    return db.pragma("data_version", { simple: true }) as number
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Content marker (model-independent) + FTS
// ---------------------------------------------------------------------------

export function getContentHash(source: string): string | null {
  const row = db
    .prepare(`SELECT contentHash FROM memory_content WHERE source = ?`)
    .get(source) as { contentHash: string } | undefined
  return row?.contentHash ?? null
}

export function listContentSources(): string[] {
  const rows = db
    .prepare(`SELECT source FROM memory_content ORDER BY source`)
    .all() as Array<{ source: string }>
  return rows.map((r) => r.source)
}

function ftsDeleteForSource(source: string): void {
  if (!ftsAvailable) return
  try {
    db.prepare(`DELETE FROM memory_fts WHERE source = ?`).run(source)
  } catch {
    /* best-effort secondary index */
  }
}

function ftsInsert(source: string, chunks: ContentChunk[]): void {
  if (!ftsAvailable) return
  try {
    const stmt = db.prepare(
      `INSERT INTO memory_fts (id, source, title, text) VALUES (?, ?, ?, ?)`
    )
    for (const c of chunks) {
      stmt.run(ftsId(source, c.chunkIndex), source, c.title, c.text)
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Record that a source's CONTENT changed (or is new). Wipes every embedding
 * generation for it (they embedded the old content and are now stale), rebuilds
 * the model-independent FTS rows, and sets the new content hash. Embeddings for
 * the active generation are written separately by writeGeneration.
 */
export function markContentChanged(
  source: string,
  contentHash: string,
  chunks: ContentChunk[]
): void {
  const now = Date.now()
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM memory_chunks WHERE source = ?`).run(source)
    db.prepare(`DELETE FROM memory_generations WHERE source = ?`).run(source)
    ftsDeleteForSource(source)
    ftsInsert(source, chunks)
    db.prepare(
      `INSERT INTO memory_content (source, contentHash, chunkCount, updatedAt)
       VALUES (@source, @contentHash, @chunkCount, @now)
       ON CONFLICT(source) DO UPDATE SET
         contentHash = excluded.contentHash,
         chunkCount = excluded.chunkCount,
         updatedAt = excluded.updatedAt`
    ).run({ source, contentHash, chunkCount: chunks.length, now })
  })
  run()
  bumpVectorCache()
}

/** Remove a source entirely (its file disappeared). */
export function pruneSource(source: string): void {
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM memory_chunks WHERE source = ?`).run(source)
    db.prepare(`DELETE FROM memory_generations WHERE source = ?`).run(source)
    db.prepare(`DELETE FROM memory_content WHERE source = ?`).run(source)
    ftsDeleteForSource(source)
  })
  run()
  bumpVectorCache()
}

// ---------------------------------------------------------------------------
// Generations (embeddings)
// ---------------------------------------------------------------------------

/** True when an up-to-date embedding generation exists for this content. */
export function generationFresh(
  source: string,
  model: string,
  dim: number,
  contentHash: string
): boolean {
  const row = db
    .prepare(
      `SELECT contentHash FROM memory_generations
       WHERE source = ? AND model = ? AND dim = ?`
    )
    .get(source, model, dim) as { contentHash: string } | undefined
  return row?.contentHash === contentHash
}

/** Write (replace) the embedding generation for one (source, model, dim). */
export function writeGeneration(
  source: string,
  model: string,
  dim: number,
  contentHash: string,
  chunks: IndexChunkInput[]
): void {
  const now = Date.now()
  const insertChunk = db.prepare(
    `INSERT OR REPLACE INTO memory_chunks
       (id, source, model, dim, chunkIndex, title, text, embedding, createdAt)
     VALUES (@id, @source, @model, @dim, @chunkIndex, @title, @text, @embedding, @createdAt)`
  )
  const run = db.transaction(() => {
    db.prepare(
      `DELETE FROM memory_chunks WHERE source = ? AND model = ? AND dim = ?`
    ).run(source, model, dim)
    for (const c of chunks) {
      insertChunk.run({
        id: chunkId(source, model, dim, c.chunkIndex),
        source,
        model,
        dim,
        chunkIndex: c.chunkIndex,
        title: c.title,
        text: c.text,
        embedding: vectorToBuffer(c.embedding),
        createdAt: now,
      })
    }
    db.prepare(
      `INSERT INTO memory_generations (source, model, dim, contentHash, chunkCount, indexedAt)
       VALUES (@source, @model, @dim, @contentHash, @chunkCount, @now)
       ON CONFLICT(source, model, dim) DO UPDATE SET
         contentHash = excluded.contentHash,
         chunkCount = excluded.chunkCount,
         indexedAt = excluded.indexedAt`
    ).run({ source, model, dim, contentHash, chunkCount: chunks.length, now })
  })
  run()
  bumpVectorCache()
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Vectors for the ACTIVE generation only (cached). */
export function loadVectorRows(model: string, dim: number): VectorRow[] {
  const dataVersion = dbDataVersion()
  const key = `${model}@${dim}`
  if (
    cached &&
    cached.version === cacheVersion &&
    cached.dataVersion === dataVersion &&
    cached.key === key
  ) {
    return cached.rows
  }
  const rows = db
    .prepare(
      `SELECT id, source, title, text, embedding
       FROM memory_chunks
       WHERE model = ? AND dim = ?`
    )
    .all(model, dim) as ChunkDbRow[]
  const out: VectorRow[] = []
  for (const r of rows) {
    const vector = bufferToVector(r.embedding)
    if (vector.length === 0) continue
    out.push({ id: r.id, source: r.source, title: r.title, text: r.text, vector })
  }
  cached = { version: cacheVersion, dataVersion, key, rows: out }
  return out
}

export interface FtsHit {
  id: string
  source: string
  title: string
  text: string
  score: number
}

export function ftsSearch(match: string, limit: number): FtsHit[] {
  if (!ftsAvailable) return []
  try {
    const rows = db
      .prepare(
        `SELECT id, source, title, text, bm25(memory_fts) AS rank
         FROM memory_fts
         WHERE memory_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(match, limit) as Array<{
      id: string
      source: string
      title: string
      text: string
      rank: number
    }>
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      title: r.title,
      text: r.text,
      score: 1 / (1 + Math.max(0, r.rank)),
    }))
  } catch {
    return []
  }
}

export function getStatus(activeModel: string, activeDim: number): MemoryStatus {
  const sources = (
    db.prepare(`SELECT COUNT(*) AS n FROM memory_content`).get() as { n: number }
  ).n
  const activeSources = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_generations WHERE model = ? AND dim = ?`
      )
      .get(activeModel, activeDim) as { n: number }
  ).n
  const activeChunks = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM memory_chunks WHERE model = ? AND dim = ?`
      )
      .get(activeModel, activeDim) as { n: number }
  ).n
  const generations = db
    .prepare(
      `SELECT model, dim,
              COUNT(DISTINCT source) AS sources,
              COUNT(*) AS chunks
       FROM memory_chunks
       GROUP BY model, dim
       ORDER BY model, dim`
    )
    .all() as GenerationStat[]
  return {
    activeModel,
    activeDim,
    sources,
    activeSources,
    activeChunks,
    needsIndexing: Math.max(0, sources - activeSources),
    generations,
  }
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-generation calibrated thresholds (so switching models restores the
// threshold you tuned for each). Keyed by "<provider>:<model>:<dim>".
// ---------------------------------------------------------------------------

export function getThresholds(): Record<string, number> {
  const row = db
    .prepare(`SELECT value FROM memory_meta WHERE key = 'thresholds'`)
    .get() as { value: string } | undefined
  if (!row) return {}
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function getThreshold(key: string): number | null {
  const v = getThresholds()[key]
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

export function setThreshold(key: string, value: number): void {
  const all = getThresholds()
  all[key] = value
  db.prepare(
    `INSERT INTO memory_meta (key, value) VALUES ('thresholds', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify(all))
}

/** Wipe the entire semantic index (all generations). */
export function clearMemoryIndex(): void {
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM memory_chunks`).run()
    db.prepare(`DELETE FROM memory_generations`).run()
    db.prepare(`DELETE FROM memory_content`).run()
    if (ftsAvailable) {
      try {
        db.prepare(`DELETE FROM memory_fts`).run()
      } catch {
        /* best-effort */
      }
    }
  })
  run()
  bumpVectorCache()
}
