// Semantic search over Library files/images (Phase 2).
//
// Indexes the user's Library assets — images (PNG/JPEG) and PDFs from the
// workspace Library dirs + chat uploads — into the SAME vector space as text
// queries using Gemini's multimodal embeddings, so a TEXT query can retrieve an
// IMAGE ("the whiteboard photo", "that invoice PDF"). This is the embeddings
// follow-up that find_past_uploads (keyword-only) points to.
//
// Self-contained on purpose: it owns its own `library_assets` table and reuses
// the shared connection + the embeddings backend. It is generation-aware
// (model, dim) exactly like the text memory store, so changing the embedding
// model is safe and switching back is free. Multimodal embedding is Gemini-only
// (OpenAI embeddings are text-only) — without a multimodal model, indexing and
// search no-op (fail-open).

import fs from "fs"
import path from "path"

import db from "@/lib/db"
import { activeRuntimePaths } from "@/lib/runtime-paths"
import { listAllAttachments } from "@/lib/db"
import { resolveExistingUploadPath } from "@/lib/uploads"
import {
  embedAsset,
  embedQuery,
  embeddingsAvailable,
  getEmbeddingDim,
  getEmbeddingModel,
  isActiveModelMultimodal,
} from "./embeddings"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS library_assets (
    id TEXT PRIMARY KEY,
    assetKey TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    displayPath TEXT NOT NULL,
    mimeType TEXT NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    sig TEXT NOT NULL,
    embedding BLOB NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_library_assets_gen ON library_assets(model, dim);
  CREATE INDEX IF NOT EXISTS idx_library_assets_key ON library_assets(assetKey);
`)

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LIBRARY_SOURCE_DIRS = ["files", "browser-downloads", "gmail-attachments", "artifacts"]
const MAX_ASSET_BYTES = 20 * 1024 * 1024 // Gemini image cap; also a sane PDF cap.
const SYNC_DEBOUNCE_MS = 60_000

const MIME_BY_EXT: Record<string, { mime: string; kind: "image" | "doc" }> = {
  ".png": { mime: "image/png", kind: "image" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".pdf": { mime: "application/pdf", kind: "doc" },
}

// ---------------------------------------------------------------------------
// Float32 <-> BLOB
// ---------------------------------------------------------------------------

function vectorToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

function bufferToVector(buf: Buffer): Float32Array {
  const copy = Buffer.from(buf)
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4))
}

// ---------------------------------------------------------------------------
// Asset enumeration (workspace Library dirs + chat uploads)
// ---------------------------------------------------------------------------

export interface LibraryAsset {
  assetKey: string
  kind: "image" | "doc"
  path: string
  displayPath: string
  mimeType: string
  sig: string
  conversationId?: string
  conversationTitle?: string
  messageId?: string
  messageTimestamp?: number
}

export interface LibraryAssetProvenance {
  conversationId: string
  conversationTitle: string
  messageId: string
  messageTimestamp: number
}

function provenanceForAttachment(
  att: ReturnType<typeof listAllAttachments>[number]
): LibraryAssetProvenance {
  return {
    conversationId: att.conversationId,
    conversationTitle: att.conversationTitle,
    messageId: att.messageId,
    messageTimestamp: att.messageTimestamp,
  }
}

function attachmentProvenanceMap(): Map<string, LibraryAssetProvenance> {
  const map = new Map<string, LibraryAssetProvenance>()
  try {
    for (const att of listAllAttachments()) {
      const key = `upload:${att.id}`
      if (!map.has(key)) map.set(key, provenanceForAttachment(att))
    }
  } catch {
    /* db unavailable — provenance is best-effort */
  }
  return map
}

function walkDir(absDir: string, relBase: string, out: LibraryAsset[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name)
    const rel = `${relBase}/${entry.name}`
    if (entry.isDirectory()) {
      walkDir(abs, rel, out)
      continue
    }
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    const m = MIME_BY_EXT[ext]
    if (!m) continue
    try {
      const stat = fs.statSync(abs)
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ASSET_BYTES) continue
      out.push({
        assetKey: `ws:${rel}`,
        kind: m.kind,
        path: abs,
        displayPath: rel,
        mimeType: m.mime,
        sig: `${Math.round(stat.mtimeMs)}:${stat.size}`,
      })
    } catch {
      /* skip unreadable */
    }
  }
}

export function listLibraryAssets(): LibraryAsset[] {
  const out: LibraryAsset[] = []
  const workspaceDir = activeRuntimePaths().agentWorkspaceDir

  // 1. Workspace Library dirs (immutable-ish files written by tools/integrations).
  for (const dir of LIBRARY_SOURCE_DIRS) {
    const abs = path.resolve(workspaceDir, dir)
    if (abs !== workspaceDir && !abs.startsWith(workspaceDir + path.sep)) continue
    walkDir(abs, dir, out)
  }

  // 2. Chat uploads (content-addressed by id, so the id is a stable signature).
  try {
    for (const att of listAllAttachments()) {
      if (att.type !== "image" && att.type !== "pdf") continue
      const ext = path.extname(att.filename || "").toLowerCase()
      const m = MIME_BY_EXT[ext] ?? (att.type === "pdf" ? { mime: "application/pdf", kind: "doc" as const } : null)
      if (!m) continue
      const abs = resolveExistingUploadPath(att.id)
      if (!abs) continue
      try {
        const stat = fs.statSync(abs)
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ASSET_BYTES) continue
      } catch {
        continue
      }
      out.push({
        assetKey: `upload:${att.id}`,
        kind: m.kind,
        path: abs,
        displayPath: att.filename || att.id,
        mimeType: att.mimeType || m.mime,
        sig: att.id, // uploads are immutable, id never changes
        ...provenanceForAttachment(att),
      })
    }
  } catch {
    /* db unavailable — workspace assets still index */
  }

  return out
}

export function findLibraryAsset(assetKey: string): LibraryAsset | null {
  const key = assetKey.trim()
  if (!key) return null
  return listLibraryAssets().find((asset) => asset.assetKey === key) ?? null
}

// ---------------------------------------------------------------------------
// Indexing (generation-aware, signature-diffed, single-flight)
// ---------------------------------------------------------------------------

let syncInFlight: Promise<{ indexed: number; removed: number; failed: number }> | null = null
let lastSyncAt = 0

function assetRowId(assetKey: string, model: string, dim: number): string {
  return `${assetKey}#${model}@${dim}`
}

async function doSync(): Promise<{ indexed: number; removed: number; failed: number }> {
  let indexed = 0
  let removed = 0
  let failed = 0

  if (!embeddingsAvailable() || !isActiveModelMultimodal()) {
    return { indexed, removed, failed }
  }

  const model = getEmbeddingModel()
  const dim = getEmbeddingDim()
  const assets = listLibraryAssets()
  const present = new Set(assets.map((a) => a.assetKey))

  // Drop rows for assets that disappeared (every generation).
  const known = db
    .prepare(`SELECT DISTINCT assetKey FROM library_assets`)
    .all() as Array<{ assetKey: string }>
  const dropStmt = db.prepare(`DELETE FROM library_assets WHERE assetKey = ?`)
  for (const row of known) {
    if (!present.has(row.assetKey)) {
      dropStmt.run(row.assetKey)
      removed += 1
    }
  }

  const freshStmt = db.prepare(
    `SELECT sig FROM library_assets WHERE assetKey = ? AND model = ? AND dim = ?`
  )
  const upsertStmt = db.prepare(
    `INSERT OR REPLACE INTO library_assets
       (id, assetKey, kind, path, displayPath, mimeType, model, dim, sig, embedding, createdAt)
     VALUES (@id, @assetKey, @kind, @path, @displayPath, @mimeType, @model, @dim, @sig, @embedding, @createdAt)`
  )

  for (const asset of assets) {
    const existing = freshStmt.get(asset.assetKey, model, dim) as
      | { sig: string }
      | undefined
    if (existing?.sig === asset.sig) continue // fresh for active generation

    let data: Buffer
    try {
      data = fs.readFileSync(asset.path)
    } catch {
      continue
    }
    const vector = await embedAsset(data, asset.mimeType)
    if (!vector) {
      failed += 1
      continue
    }
    upsertStmt.run({
      id: assetRowId(asset.assetKey, model, dim),
      assetKey: asset.assetKey,
      kind: asset.kind,
      path: asset.path,
      displayPath: asset.displayPath,
      mimeType: asset.mimeType,
      model,
      dim,
      sig: asset.sig,
      embedding: vectorToBuffer(vector),
      createdAt: Date.now(),
    })
    indexed += 1
  }

  invalidateCache()
  return { indexed, removed, failed }
}

export function syncLibraryIndex(): Promise<{
  indexed: number
  removed: number
  failed: number
}> {
  if (syncInFlight) return syncInFlight
  syncInFlight = doSync().finally(() => {
    syncInFlight = null
    lastSyncAt = Date.now()
  })
  return syncInFlight
}

// ---------------------------------------------------------------------------
// Search (cross-modal: text query -> image/doc results)
// ---------------------------------------------------------------------------

interface VectorRow {
  assetKey: string
  displayPath: string
  path: string
  kind: string
  mimeType: string
  conversationId?: string
  conversationTitle?: string
  messageId?: string
  messageTimestamp?: number
  vector: Float32Array
}

let cache: { key: string; dataVersion: number; rows: VectorRow[] } | null = null

function invalidateCache(): void {
  cache = null
}

function dbDataVersion(): number {
  try {
    return db.pragma("data_version", { simple: true }) as number
  } catch {
    return 0
  }
}

function loadVectors(model: string, dim: number): VectorRow[] {
  const dataVersion = dbDataVersion()
  const key = `${model}@${dim}`
  if (cache && cache.key === key && cache.dataVersion === dataVersion) return cache.rows
  const rows = db
    .prepare(
      `SELECT assetKey, displayPath, path, kind, mimeType, embedding
       FROM library_assets WHERE model = ? AND dim = ?`
    )
    .all(model, dim) as Array<{
    assetKey: string
    displayPath: string
    path: string
    kind: string
    mimeType: string
    embedding: Buffer
  }>
  const out: VectorRow[] = []
  const provenanceByAssetKey = attachmentProvenanceMap()
  for (const r of rows) {
    const vector = bufferToVector(r.embedding)
    if (vector.length === 0) continue
    const provenance = provenanceByAssetKey.get(r.assetKey)
    out.push({
      assetKey: r.assetKey,
      displayPath: r.displayPath,
      path: r.path,
      kind: r.kind,
      mimeType: r.mimeType,
      ...provenance,
      vector,
    })
  }
  cache = { key, dataVersion, rows: out }
  return out
}

export interface LibraryHit {
  assetKey: string
  displayPath: string
  path: string
  kind: string
  mimeType: string
  conversationId?: string
  conversationTitle?: string
  messageId?: string
  messageTimestamp?: number
  score: number
}

export interface VectorSearchOptions {
  /** Minimum cosine to keep a hit (default 0 — keep everything ranked). */
  threshold?: number
  /** Absolute paths to drop from the results (e.g. the query asset itself). */
  excludePaths?: Set<string>
}

function scoreLibraryRows(
  vec: Float32Array,
  rows: VectorRow[],
  limit: number,
  opts: VectorSearchOptions = {}
): LibraryHit[] {
  const threshold = opts.threshold ?? 0
  const exclude = opts.excludePaths
  const scored: LibraryHit[] = []
  for (const r of rows) {
    if (r.vector.length !== vec.length) continue
    if (exclude && exclude.has(r.path)) continue
    let dot = 0
    for (let i = 0; i < vec.length; i++) dot += vec[i] * r.vector[i]
    if (dot >= threshold) {
      scored.push({
        assetKey: r.assetKey,
        displayPath: r.displayPath,
        path: r.path,
        kind: r.kind,
        mimeType: r.mimeType,
        conversationId: r.conversationId,
        conversationTitle: r.conversationTitle,
        messageId: r.messageId,
        messageTimestamp: r.messageTimestamp,
        score: dot,
      })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(1, limit))
}

export async function searchLibrary(
  query: string,
  limit: number
): Promise<LibraryHit[]> {
  if (!isActiveModelMultimodal()) return []
  // Make sure the index reflects current Library contents.
  try {
    await syncLibraryIndex()
  } catch {
    /* search whatever is indexed */
  }
  const qVec = await embedQuery(query)
  if (!qVec) return []
  const rows = loadVectors(getEmbeddingModel(), getEmbeddingDim())
  return scoreLibraryRows(qVec, rows, limit)
}

/**
 * Search the Library with a PRE-COMPUTED query vector (e.g. the embedding of an
 * attached image), so a freshly-uploaded image can surface similar files the
 * user already has. Unlike searchLibrary, this does NOT block on a full index
 * sync — it self-heals in the background and searches whatever is indexed, so it
 * stays cheap on the per-turn hot path. Multimodal-only; [] otherwise.
 */
export async function searchLibraryByVector(
  vec: Float32Array,
  limit: number,
  opts: VectorSearchOptions = {}
): Promise<LibraryHit[]> {
  if (!isActiveModelMultimodal()) return []
  kickLibrarySync() // background self-heal; never block the hot path on embedding
  const rows = loadVectors(getEmbeddingModel(), getEmbeddingDim())
  return scoreLibraryRows(vec, rows, limit, opts)
}

export interface LibraryStatus {
  multimodal: boolean
  assetsOnDisk: number
  indexedActive: number
  needsIndexing: number
}

export function getLibraryStatus(): LibraryStatus {
  const model = getEmbeddingModel()
  const dim = getEmbeddingDim()
  const assetsOnDisk = listLibraryAssets().length
  const indexedActive = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM library_assets WHERE model = ? AND dim = ?`)
      .get(model, dim) as { n: number }
  ).n
  return {
    multimodal: isActiveModelMultimodal(),
    assetsOnDisk,
    indexedActive,
    needsIndexing: Math.max(0, assetsOnDisk - indexedActive),
  }
}

/** Background, debounced self-heal kicked from the read/tool path. */
export function kickLibrarySync(): void {
  if (!isActiveModelMultimodal()) return
  if (syncInFlight) return
  if (Date.now() - lastSyncAt < SYNC_DEBOUNCE_MS) return
  void syncLibraryIndex().catch(() => {})
}
