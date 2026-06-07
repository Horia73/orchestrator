// Semantic memory recall — chunking, indexing, search, and the per-turn
// "recalled memory" block.
//
// Design (see also store.ts / embeddings.ts):
//  - The raw daily ledger (MEMORY_DAY/*.md) and durable files (USER/MEMORY/
//    MONITORS/PLAYBOOKS) remain the source of truth. This layer is a derived
//    index on top, never a replacement.
//  - The index self-heals via content-hash diffing (syncMemoryIndex): whoever
//    writes a memory file — the agent's Write/Edit tools, the settings UI, a
//    manual edit — is picked up on the next sync. No write-path hooks needed.
//  - The automatic per-turn pass (buildRecalledMemoryContext) embeds the user's
//    message and surfaces older memories that are NOT already in the prompt
//    (it excludes the durable files + the last 3 daily files, which the prompt
//    builder already injects). That targets exactly the "months later, similar
//    thing comes up" case.
//  - Two precision filters keep that pass honest: near-duplicate suppression
//    (selectDiverse) collapses the same fact re-logged across days, and a
//    coverage gate (shouldSuppressByCoverage) drops the whole block when a broad,
//    multi-intent message is matched only by a small tangential slice of memory.
//    Both are silent-pass concerns; the explicit memory_search tool stays wide.
//  - When the model is multimodal (Gemini) and the turn carries an image/PDF, the
//    attachment ALSO drives recall (recallByAsset): it embeds into the shared
//    text+image space to surface (a) older text notes it resembles cross-modally
//    and (b) similar files already in the Library. Asset hits bypass the coverage
//    gate (an attachment is explicit intent) and are unaffected on text models.
//  - Everything is fail-open: disabled, no key, timeout, or error => "".

import fs from "fs"
import path from "path"
import { createHash } from "crypto"

import type { MemoryRecallHit } from "@/lib/types"
import db from "@/lib/db"
import { stripArtifactBlocksForPreview } from "@/lib/artifacts/text"
import { getConfiguredTimezone, getMemoryEmbeddingSettings } from "@/lib/config"
import { activeRuntimePaths } from "@/lib/runtime-paths"
import { dateStampInTimezone } from "@/lib/timezone"
import {
  embedAsset,
  embedDocuments,
  embedQueries,
  embedQuery,
  embeddingsAvailable,
  getEmbeddingDim,
  getEmbeddingModel,
  isActiveModelMultimodal,
} from "./embeddings"
import { searchLibraryByVector } from "./library"
import {
  ftsSearch,
  generationFresh,
  getContentHash,
  getStatus,
  getThreshold,
  listContentSources,
  loadVectorRows,
  markContentChanged,
  pruneSource,
  setThreshold,
  writeGeneration,
  type IndexChunkInput,
  type MemoryStatus,
} from "./store"

// ---------------------------------------------------------------------------
// Config (env-overridable, with calibrated defaults)
// ---------------------------------------------------------------------------

function clampNumber(raw: string | undefined, fallback: number, lo: number, hi: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

function clampInt(raw: unknown, fallback: number, lo: number, hi: number): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

// Resolved from Settings (config.json) at call time with env/default fallback,
// so toggling recall or changing the threshold in the UI takes effect without a
// restart. ORCHESTRATOR_MEMORY_RECALL=off remains a hard ops kill-switch.
export function isRecallEnabled(): boolean {
  return getMemoryEmbeddingSettings().enabled
}

// Cosine threshold for the AUTOMATIC per-turn pass. Resolved per active
// generation (provider:model:dim) so each model keeps its own calibrated value;
// falls back to the configured/default threshold.
function activeThresholdKey(): string {
  const s = getMemoryEmbeddingSettings()
  return `${s.provider}:${s.model}:${s.dim}`
}

function getRecallThreshold(): number {
  return getThreshold(activeThresholdKey()) ?? getMemoryEmbeddingSettings().threshold
}

/** Persist a calibrated threshold for the active generation. Returns the clamped value. */
export function setActiveThreshold(value: number): number {
  const v = Math.min(1, Math.max(0, value))
  setThreshold(activeThresholdKey(), v)
  return v
}

/** Effective threshold currently in force for the active generation. */
export function getActiveThreshold(): number {
  return getRecallThreshold()
}

export const RECALL_TOP_K = clampInt(
  process.env.ORCHESTRATOR_MEMORY_RECALL_TOPK,
  4,
  1,
  20
)

// Conversation-local repeat suppression for the automatic pass. Consecutive user
// turns often have near-identical phrasing, which can surface the same marginal
// notes over and over. Keep a short in-process ledger per conversation and hide
// repeated hits unless the new score is strong enough to be worth showing again.
const RECALL_REPEAT_WINDOW_TURNS = clampInt(
  process.env.ORCHESTRATOR_MEMORY_RECALL_REPEAT_WINDOW,
  3,
  0,
  10
)
const RECALL_REPEAT_KEEP_SCORE = clampNumber(
  process.env.ORCHESTRATOR_MEMORY_RECALL_REPEAT_KEEP_SCORE,
  0.78,
  0,
  1
)
const MAX_RECENT_RECALL_CONVERSATIONS = 200

// The explicit memory_search tool casts a wider net than the silent pass.
const TOOL_THRESHOLD = clampNumber(
  process.env.ORCHESTRATOR_MEMORY_SEARCH_THRESHOLD,
  0.35,
  0,
  1
)

// Near-duplicate suppression. Vectors are unit-normalized (cosine == dot), so
// this is a similarity in [0,1]. Kept high/conservative: it only collapses hits
// the model considers near-identical — e.g. the SAME fact re-logged across
// several daily files — while distinct same-topic notes survive.
const DEDUP_SIM = clampNumber(process.env.ORCHESTRATOR_MEMORY_RECALL_DEDUP, 0.92, 0.5, 1)

// Coverage gate (SILENT per-turn pass only). A broad, multi-intent message whose
// recalled hits address only a small tangential slice of it (the classic case:
// a one-line "HA is cool" aside dragging in old Home-Assistant notes while the
// message is really about new hardware) should surface nothing. We require a
// genuinely broad message (>= MIN_SEGMENTS sentences) and suppress when at most
// FLOOR of those segments are actually matched by the returned hits.
const COVERAGE_MIN_SEGMENTS = clampInt(
  process.env.ORCHESTRATOR_MEMORY_RECALL_MIN_SEGMENTS,
  4,
  2,
  32
)
const COVERAGE_FLOOR = clampNumber(
  process.env.ORCHESTRATOR_MEMORY_RECALL_COVERAGE_FLOOR,
  0.34,
  0,
  1
)
const SEGMENT_MIN_CHARS = 12
const MAX_SEGMENTS = 12

// Multimodal recall (Gemini-only): when the user attaches an image/PDF, embed it
// into the shared text+image vector space and surface (a) older text memories it
// resembles and (b) similar files the user already has in their Library.
// Image -> TEXT memory used to default lower than text recall, but that proved
// too noisy in practice. Default it to the active recall threshold; env can still
// calibrate it explicitly when needed.
function getImageMemoryThreshold(): number {
  return clampNumber(
    process.env.ORCHESTRATOR_MEMORY_RECALL_IMG_THRESHOLD,
    getRecallThreshold(),
    0,
    1
  )
}

// The file bar (image -> IMAGE/PDF) is same-modality and can stay separate.
const FILE_THRESHOLD = clampNumber(
  process.env.ORCHESTRATOR_MEMORY_RECALL_FILE_THRESHOLD,
  0.6,
  0,
  1
)
const IMG_MEMORY_TOPK = clampInt(process.env.ORCHESTRATOR_MEMORY_RECALL_IMG_TOPK, 3, 1, 10)
const FILE_TOPK = clampInt(process.env.ORCHESTRATOR_MEMORY_RECALL_FILE_TOPK, 3, 1, 10)
// Bigger budget when an asset is in play: embedding an image is one extra,
// heavier API call than a text query, so the text-only 1.5s would too often
// time the whole thing out (fail-open => the asset recall silently never fires).
const RECALL_ASSET_TIMEOUT_MS = clampInt(
  process.env.ORCHESTRATOR_MEMORY_RECALL_ASSET_TIMEOUT_MS,
  4000,
  1500, // never below the text-only RECALL_TIMEOUT_MS
  15_000
)
const MAX_RECALL_ASSET_BYTES = 20 * 1024 * 1024 // matches Gemini's per-item cap
// What we can embed cross-modally (matches the Library's supported set).
const RECALL_ASSET_MIMES = new Set(["image/png", "image/jpeg", "application/pdf"])

const RECALL_TIMEOUT_MS = 1500
const MIN_QUERY_CHARS = 8
const MIN_CHUNK_CHARS = 24
// Defensive cap so a pathological huge paragraph can never hit the embedding
// model's per-item token limit (gemini-embedding-2: 8192 tokens, SILENTLY
// truncated above it). ~4000 chars ≈ ~1000 tokens — comfortably under, and
// small focused chunks retrieve better than huge ones anyway.
const MAX_CHUNK_CHARS = 4000
const MAX_HIT_CHARS = 320
const SYNC_DEBOUNCE_MS = 15_000

// Durable files the prompt builder already injects every turn (lib/ai/prompts/
// shared.ts). The silent pass excludes them so it only surfaces *new* signal.
const DURABLE_SOURCES = ["USER.md", "MEMORY.md", "MONITORS.md", "PLAYBOOKS.md"]
const MEMORY_DAY_DIR = "MEMORY_DAY"
const CONVERSATION_SOURCE_PREFIX = "conversation:"
const MAX_CONVERSATION_ATTACHMENT_NAMES = 12

// Template boilerplate that should never become a memory chunk (it repeats in
// every freshly-scaffolded file and carries no signal).
const TEMPLATE_NOISE = [
  "append compact entries",
  "daily working memory for",
  "this file is noisy by design",
  "stable user knowledge goes here",
  "permanent memory belongs here",
  "keep this file compact",
  "document proactive monitoring",
  "reusable, distilled procedures",
  "keep only information that should help",
  "a smart monitor entry is active only",
  "each entry should define status",
  "each playbook should have",
]

// ---------------------------------------------------------------------------
// Source enumeration
// ---------------------------------------------------------------------------

function workspacePath(relPath: string): string | null {
  const workspaceDir = activeRuntimePaths().agentWorkspaceDir
  const abs = path.resolve(workspaceDir, relPath)
  if (abs !== workspaceDir && !abs.startsWith(workspaceDir + path.sep)) {
    return null
  }
  return abs
}

function readSource(relPath: string): string | null {
  const abs = workspacePath(relPath)
  if (!abs) return null
  try {
    const stat = fs.statSync(abs)
    if (!stat.isFile() || stat.size <= 0) return null
    return fs.readFileSync(abs, "utf-8")
  } catch {
    return null
  }
}

/** All markdown memory source files currently on disk (durable + every daily note). */
export function listMemorySourceFiles(): string[] {
  const out: string[] = []
  for (const rel of DURABLE_SOURCES) {
    if (readSource(rel) !== null) out.push(rel)
  }
  const dir = workspacePath(MEMORY_DAY_DIR)
  if (dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) continue
        out.push(`${MEMORY_DAY_DIR}/${entry.name}`)
      }
    } catch {
      /* no daily dir yet */
    }
  }
  return out
}

interface MemorySourceSnapshot {
  source: string
  content: string
}

interface ConversationMemoryRow {
  messageId: string
  conversationId: string
  conversationTitle: string
  role: "user" | "assistant"
  content: string
  attachments: string | null
  timestamp: number
}

function conversationSourceId(conversationId: string, messageId: string): string {
  return `${CONVERSATION_SOURCE_PREFIX}${conversationId}:${messageId}`
}

function conversationSourcePrefix(conversationId: string): string {
  return `${CONVERSATION_SOURCE_PREFIX}${conversationId}:`
}

function parseAttachmentNames(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue
      const rec = item as Record<string, unknown>
      const name =
        typeof rec.filename === "string" && rec.filename.trim()
          ? rec.filename.trim()
          : typeof rec.id === "string" && rec.id.trim()
            ? rec.id.trim()
            : ""
      if (name) out.push(name)
      if (out.length >= MAX_CONVERSATION_ATTACHMENT_NAMES) break
    }
    return out
  } catch {
    return []
  }
}

function listConversationMemoryRows(): ConversationMemoryRow[] {
  try {
    return db
      .prepare(
        `
          SELECT
            m.id AS messageId,
            m.conversationId,
            c.title AS conversationTitle,
            m.role,
            m.content,
            m.attachments,
            m.timestamp
          FROM messages m
          JOIN conversations c ON c.id = m.conversationId
          WHERE (c.origin IS NULL OR c.origin = 'user')
            AND (m.status IS NULL OR m.status = 'ok')
            AND (
              length(trim(COALESCE(m.content, ''))) > 0
              OR (m.attachments IS NOT NULL AND m.attachments != '')
            )
          ORDER BY m.timestamp ASC, m.id ASC
        `
      )
      .all() as ConversationMemoryRow[]
  } catch {
    return []
  }
}

function formatConversationSource(row: ConversationMemoryRow): string {
  const role = row.role === "assistant" ? "Assistant" : "User"
  const title = row.conversationTitle?.trim() || "Untitled conversation"
  const date = new Date(row.timestamp).toISOString()
  const attachments = parseAttachmentNames(row.attachments)
  const body = stripArtifactBlocksForPreview(row.content ?? "")
  const metaLines = [
    `Conversation: ${title}`,
    `Conversation ID: ${row.conversationId}`,
    `Message ID: ${row.messageId}`,
    `Date: ${date}`,
    `Role: ${role}`,
    attachments.length ? `Attachments: ${attachments.join(", ")}` : "",
  ].filter(Boolean)
  return [...metaLines, "", body].join("\n").trim()
}

function listConversationMemorySources(): MemorySourceSnapshot[] {
  return listConversationMemoryRows().map((row) => ({
    source: conversationSourceId(row.conversationId, row.messageId),
    content: formatConversationSource(row),
  }))
}

function listMemorySourceSnapshots(): MemorySourceSnapshot[] {
  const out: MemorySourceSnapshot[] = []
  for (const source of listMemorySourceFiles()) {
    const content = readSource(source)
    if (content !== null) out.push({ source, content })
  }
  out.push(...listConversationMemorySources())
  return out
}

/** All semantic memory sources: durable/daily markdown plus conversation messages. */
export function listMemorySources(): string[] {
  return listMemorySourceSnapshots().map((entry) => entry.source)
}

/** Sources already in the prompt this turn: durable files + last 3 configured-local days. */
function inContextSources(): Set<string> {
  const set = new Set<string>(DURABLE_SOURCES)
  const timezone = getConfiguredTimezone()
  for (let back = 0; back <= 2; back++) {
    const stamp = dateStampInTimezone(Date.now() - back * 86_400_000, timezone)
    set.add(`${MEMORY_DAY_DIR}/${stamp}.md`)
  }
  return set
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function isTemplateNoise(text: string): boolean {
  const lower = text.toLowerCase()
  return TEMPLATE_NOISE.some((needle) => lower.includes(needle))
}

function normalizeTitlePart(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
}

export function displayMemoryTitle(source: string, rawTitle: string): string {
  const cleanSource = source.trim()
  const cleanTitle = rawTitle.trim() || cleanSource
  const prefix = `${cleanSource} › `
  if (!cleanTitle.startsWith(prefix)) return cleanTitle

  const heading = cleanTitle.slice(prefix.length).trim()
  const sourceLabel = cleanSource.replace(/\.md$/i, "").replace(/[\\/]+/g, " ")
  if (normalizeTitlePart(sourceLabel) === normalizeTitlePart(heading)) {
    return cleanSource
  }
  return cleanTitle
}

function titleFor(source: string, heading: string): string {
  if (!heading) return source
  return displayMemoryTitle(source, `${source} › ${heading}`)
}

function capChunk(text: string): string {
  return text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS).trimEnd() : text
}

export interface Chunk {
  chunkIndex: number
  title: string
  text: string
}

/** Split a markdown memory file into bullet/paragraph chunks under headings. */
export function chunkMarkdown(source: string, content: string): Chunk[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  let heading = ""
  const raw: Array<{ title: string; text: string }> = []
  let para: string[] = []

  const flushPara = (): void => {
    if (para.length === 0) return
    const text = para.join(" ").replace(/\s+/g, " ").trim()
    para = []
    if (text.length >= MIN_CHUNK_CHARS && !isTemplateNoise(text)) {
      raw.push({ title: titleFor(source, heading), text: capChunk(text) })
    }
  }

  for (const rawLine of lines) {
    const t = rawLine.trim()
    if (!t) {
      flushPara()
      continue
    }
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(t)
    if (headingMatch) {
      flushPara()
      heading = headingMatch[1].trim()
      continue
    }
    const bulletMatch = /^([-*+]|\d+[.)])\s+(.*)$/.exec(t)
    if (bulletMatch) {
      flushPara()
      const text = bulletMatch[2].replace(/\s+/g, " ").trim()
      if (text.length >= MIN_CHUNK_CHARS && !isTemplateNoise(text)) {
        raw.push({ title: titleFor(source, heading), text: capChunk(text) })
      }
      continue
    }
    para.push(t)
  }
  flushPara()

  return raw.map((c, i) => ({ chunkIndex: i, title: c.title, text: c.text }))
}

function conversationMeta(content: string, label: string): string {
  const prefix = `${label}:`
  const line = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .find((value) => value.startsWith(prefix))
  return line ? line.slice(prefix.length).trim() : ""
}

function splitPlainTextForChunks(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim()
  if (!normalized) return []

  const parts: string[] = []
  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean)

  for (const block of blocks.length ? blocks : [normalized.replace(/\s+/g, " ").trim()]) {
    if (block.length <= MAX_CHUNK_CHARS) {
      parts.push(block)
      continue
    }
    for (let offset = 0; offset < block.length; offset += MAX_CHUNK_CHARS) {
      const part = block.slice(offset, offset + MAX_CHUNK_CHARS).trim()
      if (part) parts.push(part)
    }
  }
  return parts
}

export function chunkConversationContent(source: string, content: string): Chunk[] {
  const title = conversationMeta(content, "Conversation") || source
  const date = conversationMeta(content, "Date")
  const role = conversationMeta(content, "Role") || "Message"
  const attachments = conversationMeta(content, "Attachments")
  const body = content.split(/\n\n/).slice(1).join("\n\n").trim()
  const textParts = splitPlainTextForChunks(body || attachments)
  const chunkTitle = `Conversation › ${title}${date ? ` › ${role} · ${date.slice(0, 10)}` : ` › ${role}`}`
  const prefix = [
    `${role}${date ? ` on ${date}` : ""}`,
    attachments ? `attachments: ${attachments}` : "",
  ]
    .filter(Boolean)
    .join("; ")

  return textParts
    .filter((text) => text.length >= MIN_CHUNK_CHARS && !isTemplateNoise(text))
    .map((text, index) => ({
      chunkIndex: index,
      title: chunkTitle,
      text: capChunk(prefix ? `${prefix}: ${text}` : text),
    }))
}

function chunkMemorySource(source: string, content: string): Chunk[] {
  return source.startsWith(CONVERSATION_SOURCE_PREFIX)
    ? chunkConversationContent(source, content)
    : chunkMarkdown(source, content)
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

// ---------------------------------------------------------------------------
// Indexing (self-healing, content-hash diffed)
// ---------------------------------------------------------------------------

let syncInFlight: Promise<{ indexed: number; removed: number; failed: number }> | null =
  null
let lastSyncAt = 0

async function doSync(): Promise<{
  indexed: number
  removed: number
  failed: number
}> {
  let indexed = 0
  let removed = 0
  let failed = 0

  if (!embeddingsAvailable()) return { indexed, removed, failed }

  const sources = listMemorySourceSnapshots()
  const sourceSet = new Set(sources.map((entry) => entry.source))

  // Drop sources whose backing file/message disappeared (every generation +
  // content + FTS).
  for (const source of listContentSources()) {
    if (!sourceSet.has(source)) {
      pruneSource(source)
      removed += 1
    }
  }

  for (const { source, content } of sources) {
    const hash = sha256(content)

    // 1. Content change: rebuild the model-independent content marker + FTS and
    //    wipe every stale embedding generation for this source.
    let chunks: Chunk[] | null = null
    if (getContentHash(source) !== hash) {
      chunks = chunkMemorySource(source, content)
      markContentChanged(source, hash, chunks)
    }

    // 2. Ensure the ACTIVE generation is embedded for the current content. If a
    //    fresh generation already exists (e.g. we switched back to a model used
    //    before, content unchanged), this is a no-op — free, no API call.
    if (generationFresh(source, getEmbeddingModel(), getEmbeddingDim(), hash)) continue

    if (!chunks) chunks = chunkMemorySource(source, content)
    if (chunks.length === 0) {
      // Record an empty generation so we don't retry an empty file every sync.
      writeGeneration(source, getEmbeddingModel(), getEmbeddingDim(), hash, [])
      indexed += 1
      continue
    }

    const vectors = await embedDocuments(
      chunks.map((c) => ({ title: c.title, text: c.text }))
    )
    if (!vectors) {
      // Transient embedding failure: leave as-is and retry next sync.
      failed += 1
      continue
    }

    const rows: IndexChunkInput[] = []
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]
      const v = vectors[i]
      if (!c || !v) continue
      rows.push({ chunkIndex: c.chunkIndex, title: c.title, text: c.text, embedding: v })
    }
    writeGeneration(source, getEmbeddingModel(), getEmbeddingDim(), hash, rows)
    indexed += 1
  }

  return { indexed, removed, failed }
}

/** Idempotent, single-flight reindex of changed sources. */
export function syncMemoryIndex(): Promise<{
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

/** Fire-and-forget, debounced self-heal kicked from the read path. */
function kickMemoryIndexSync(): void {
  if (!isRecallEnabled()) return
  if (syncInFlight) return
  if (Date.now() - lastSyncAt < SYNC_DEBOUNCE_MS) return
  void syncMemoryIndex().catch(() => {})
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface MemoryHit {
  id: string
  source: string
  title: string
  text: string
  score: number
  /** "note" = a text memory chunk (default); "file" = a similar Library asset
   *  surfaced via an attached image/PDF. */
  kind?: "note" | "file"
  assetKey?: string
  mimeType?: string
  url?: string
  conversationId?: string
  conversationTitle?: string
  messageId?: string
  messageTimestamp?: number
}

function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

function buildFtsMatch(query: string): string | null {
  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length >= 2)
    .slice(0, 12)
  if (tokens.length === 0) return null
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ")
}

export interface SearchOptions {
  topK?: number
  threshold?: number
  excludeSources?: Set<string>
  excludeSourcePrefixes?: string[]
  /** "hybrid" blends keyword (FTS) hits in when semantic is thin/unavailable. */
  mode?: "semantic" | "hybrid"
  /** Collapse near-duplicate hits (default true). Off for calibration dry-runs. */
  dedup?: boolean
  /** Silent per-turn pass only: suppress entirely when a broad, multi-intent
   *  message is matched only by a small tangential slice of memory (default false). */
  coverageGate?: boolean
}

function isSourceExcluded(
  source: string,
  exact: Set<string>,
  prefixes: readonly string[]
): boolean {
  if (exact.has(source)) return true
  return prefixes.some((prefix) => source.startsWith(prefix))
}

/**
 * Greedy near-duplicate suppression. Sorts candidates by score and keeps the
 * highest-scoring representative of each near-identical cluster, capped at topK.
 * Vector-based, so it only collapses chunks the model considers near-identical
 * (DEDUP_SIM); distinct same-topic notes survive. FTS-only hits carry no vector
 * and always pass through.
 */
export function selectDiverse(
  candidates: MemoryHit[],
  vectorById: Map<string, Float32Array>,
  topK: number
): MemoryHit[] {
  const ranked = [...candidates].sort((a, b) => b.score - a.score)
  const picked: MemoryHit[] = []
  const pickedVecs: Float32Array[] = []
  for (const cand of ranked) {
    if (picked.length >= topK) break
    const v = vectorById.get(cand.id)
    if (v) {
      let redundant = false
      for (const pv of pickedVecs) {
        if (pv.length === v.length && dot(pv, v) >= DEDUP_SIM) {
          redundant = true
          break
        }
      }
      if (redundant) continue
      pickedVecs.push(v)
    }
    picked.push(cand)
  }
  return picked
}

// Split a user message into substantive segments for the coverage gate.
// Sentence/line level only — splitting on commas would shred a single intent
// ("wifi, wake word instant, quality > apple"). Exported for tests.
export function splitQuerySegments(query: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of query.replace(/\r\n/g, "\n").split(/[\n.!?]+/)) {
    const seg = raw.replace(/\s+/g, " ").trim()
    if (seg.length < SEGMENT_MIN_CHARS) continue
    const key = seg.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(seg)
    if (out.length >= MAX_SEGMENTS) break
  }
  return out
}

/**
 * Coverage gate for the SILENT per-turn pass. Embeds the message's segments and
 * counts how many are actually addressed by the returned hits; a genuinely broad
 * message (>= COVERAGE_MIN_SEGMENTS) covered at or below COVERAGE_FLOOR is a
 * tangential match (the recall locked onto one aside) and should surface nothing.
 * Fail-open: any problem (no key, embed failure, too few segments) => no suppression.
 */
async function shouldSuppressByCoverage(
  query: string,
  hits: MemoryHit[],
  vectorById: Map<string, Float32Array>,
  threshold: number
): Promise<boolean> {
  try {
    if (hits.length === 0) return false
    const hitVecs = hits
      .map((h) => vectorById.get(h.id))
      .filter((v): v is Float32Array => v !== undefined)
    if (hitVecs.length === 0) return false // FTS-only result: nothing to compare

    const segments = splitQuerySegments(query)
    if (segments.length < COVERAGE_MIN_SEGMENTS) return false // not broad enough to judge

    const segVecs = await embedQueries(segments)
    if (!segVecs || segVecs.length !== segments.length) return false // fail-open

    let covered = 0
    for (const sv of segVecs) {
      for (const hv of hitVecs) {
        if (sv.length === hv.length && dot(sv, hv) >= threshold) {
          covered += 1
          break
        }
      }
    }
    return covered / segments.length <= COVERAGE_FLOOR
  } catch {
    return false // fail-open
  }
}

export async function searchMemory(
  query: string,
  opts: SearchOptions = {}
): Promise<MemoryHit[]> {
  const topK = opts.topK ?? RECALL_TOP_K
  const threshold = opts.threshold ?? getRecallThreshold()
  const exclude = opts.excludeSources ?? new Set<string>()
  const excludePrefixes = opts.excludeSourcePrefixes ?? []
  const mode = opts.mode ?? "semantic"
  const dedup = opts.dedup ?? true

  const candidates: MemoryHit[] = []
  const seenIds = new Set<string>()
  const vectorById = new Map<string, Float32Array>()

  const qVec = await embedQuery(query)
  if (qVec) {
    const rows = loadVectorRows(getEmbeddingModel(), getEmbeddingDim())
    for (const r of rows) {
      if (isSourceExcluded(r.source, exclude, excludePrefixes)) continue
      if (r.vector.length !== qVec.length) continue
      const score = dot(qVec, r.vector)
      if (score >= threshold) {
        candidates.push({ id: r.id, source: r.source, title: r.title, text: r.text, score })
        seenIds.add(r.id)
        vectorById.set(r.id, r.vector)
      }
    }
  }

  if (mode === "hybrid" && candidates.length < topK) {
    const match = buildFtsMatch(query)
    if (match) {
      for (const hit of ftsSearch(match, topK * 2)) {
        if (isSourceExcluded(hit.source, exclude, excludePrefixes)) continue
        if (seenIds.has(hit.id)) continue
        candidates.push(hit)
        seenIds.add(hit.id)
      }
    }
  }

  const selected = dedup
    ? selectDiverse(candidates, vectorById, topK)
    : [...candidates].sort((a, b) => b.score - a.score).slice(0, topK)

  if (
    opts.coverageGate &&
    (await shouldSuppressByCoverage(query, selected, vectorById, threshold))
  ) {
    return []
  }

  return selected.map((hit) => ({
    ...hit,
    title: displayMemoryTitle(hit.source, hit.title),
  }))
}

// ---------------------------------------------------------------------------
// Per-turn recalled-memory block
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim()
  if (single.length <= max) return single
  return `${single.slice(0, max - 1).trimEnd()}…`
}

// Resolve to `fallback` on timeout OR rejection (never throws), so one slow/failed
// recall branch (e.g. a heavy image embed) cannot take down a sibling branch that
// already succeeded. Each branch gets its own budget.
function withSoftTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    const done = (v: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => done(fallback), ms)
    p.then(done, () => done(fallback))
  })
}

export function formatRecallBlock(hits: MemoryHit[]): string {
  if (hits.length === 0) return ""
  const lines = hits.map(
    (h) =>
      `- [${displayMemoryTitle(h.source, h.title || h.source)}] ${clip(h.text, MAX_HIT_CHARS)} (relevance ${h.score.toFixed(2)})`
  )
  return [
    "<recalled_memory>",
    "Possibly relevant notes from your long-term memory, retrieved by semantic similarity to the current message. They may be old, superseded, or no longer accurate — verify before relying on them, and prefer the live workspace files and the current message on conflict. This is a hint surfaced automatically; do not mention it unless it is actually useful.",
    ...lines,
    "</recalled_memory>",
  ].join("\n")
}

/** Prompt block for files the user already has that resemble an attached asset. */
export function formatFilesBlock(hits: MemoryHit[]): string {
  if (hits.length === 0) return ""
  const lines = hits.map((h) => {
    const text = clip(h.text, MAX_HIT_CHARS)
    return `- [${h.title}]${text ? ` ${text}` : ""} (relevance ${h.score.toFixed(2)})`
  })
  return [
    "<similar_files>",
    "Files you ALREADY have that look similar to what was just attached, matched by visual/document similarity to the attachment. Use them to reuse or reference existing material instead of treating the attachment as brand new. Best-effort hints — verify before relying, and mention only if useful.",
    ...lines,
    "</similar_files>",
  ].join("\n")
}

export interface RecalledMemory {
  /** Prompt block to inject into the user message (empty when nothing recalled). */
  block: string
  /** The hits behind the block — used to surface a UI/activity annotation. */
  hits: MemoryHit[]
}

export interface RecalledMemoryOptions {
  attachments?: RecallAttachmentInput[]
  excludeFilePaths?: string[]
  /**
   * Optional chat scope for repeat suppression. When omitted, recall is stateless
   * (used by tests, smoke scripts, and Settings preview).
   */
  conversationId?: string | null
}

/** An attachment on the current user turn, resolved to bytes on disk. */
export interface RecallAttachmentInput {
  /** Absolute path to the file bytes. */
  path: string
  /** MIME type (used to gate to embeddable kinds). */
  mimeType: string
}

interface RecentRecallHit {
  id: string
  score: number
  turn: number
}

const recallTurnByConversation = new Map<string, number>()
const recentRecallByConversation = new Map<string, RecentRecallHit[]>()

function normalizeConversationId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed ? trimmed.slice(0, 160) : null
}

function pruneRecentRecallTrackers(): void {
  while (recallTurnByConversation.size > MAX_RECENT_RECALL_CONVERSATIONS) {
    const oldest = recallTurnByConversation.keys().next().value as string | undefined
    if (!oldest) break
    recallTurnByConversation.delete(oldest)
    recentRecallByConversation.delete(oldest)
  }
}

function nextConversationRecallTurn(conversationId: string): number {
  const turn = (recallTurnByConversation.get(conversationId) ?? 0) + 1
  // Refresh insertion order so idle conversations are pruned first.
  recallTurnByConversation.delete(conversationId)
  recallTurnByConversation.set(conversationId, turn)
  pruneRecentRecallTrackers()
  return turn
}

export function suppressRepeatedRecallHits(
  hits: MemoryHit[],
  recentScores: Map<string, number>
): MemoryHit[] {
  if (recentScores.size === 0) return hits
  return hits.filter((hit) => {
    if (!recentScores.has(hit.id)) return true
    return hit.score >= RECALL_REPEAT_KEEP_SCORE
  })
}

function filterAndRecordConversationRecall(
  conversationId: string | null | undefined,
  hits: MemoryHit[]
): MemoryHit[] {
  const id = normalizeConversationId(conversationId)
  if (!id || RECALL_REPEAT_WINDOW_TURNS <= 0) return hits

  const turn = nextConversationRecallTurn(id)
  const recent = (recentRecallByConversation.get(id) ?? []).filter(
    (entry) => turn - entry.turn <= RECALL_REPEAT_WINDOW_TURNS
  )
  const recentScores = new Map<string, number>()
  for (const entry of recent) {
    recentScores.set(entry.id, Math.max(entry.score, recentScores.get(entry.id) ?? -Infinity))
  }

  const filtered = suppressRepeatedRecallHits(hits, recentScores)
  recentRecallByConversation.set(id, [
    ...recent,
    ...filtered.map((hit) => ({ id: hit.id, score: hit.score, turn })),
  ])
  return filtered
}

function normalizeRecallOptions(
  value: RecallAttachmentInput[] | RecalledMemoryOptions | undefined
): RecalledMemoryOptions {
  if (Array.isArray(value)) return { attachments: value }
  if (!value || typeof value !== "object") return {}
  return value
}

/** First attachment we can embed cross-modally, or null. */
function pickRecallAsset(
  attachments: RecallAttachmentInput[] | undefined
): RecallAttachmentInput | null {
  if (!attachments) return null
  for (const att of attachments) {
    if (att && typeof att.path === "string" && RECALL_ASSET_MIMES.has(att.mimeType)) {
      return att
    }
  }
  return null
}

function readAssetBytes(absPath: string): Buffer | null {
  try {
    const stat = fs.statSync(absPath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_RECALL_ASSET_BYTES) return null
    return fs.readFileSync(absPath)
  } catch {
    return null
  }
}

/**
 * Recall driven by an attached image/PDF (Gemini-only). Embeds the asset ONCE
 * into the shared vector space, then surfaces (a) older TEXT memories it
 * resembles cross-modally and (b) similar files already in the Library. Returns
 * empty on any problem (fail-open).
 */
async function recallByAsset(
  asset: RecallAttachmentInput,
  exclude: Set<string>,
  excludeSourcePrefixes: string[],
  excludeFilePaths?: Set<string>
): Promise<{ notes: MemoryHit[]; files: MemoryHit[] }> {
  const empty = { notes: [] as MemoryHit[], files: [] as MemoryHit[] }
  try {
    if (!isActiveModelMultimodal()) return empty
    const data = readAssetBytes(asset.path)
    if (!data) return empty
    const vec = await embedAsset(data, asset.mimeType)
    if (!vec) return empty

    // (a) image -> older text memories (cross-modal, lower bar than text<->text).
    const rows = loadVectorRows(getEmbeddingModel(), getEmbeddingDim())
    const scored: MemoryHit[] = []
    const vectorById = new Map<string, Float32Array>()
    for (const r of rows) {
      if (isSourceExcluded(r.source, exclude, excludeSourcePrefixes)) continue
      if (r.vector.length !== vec.length) continue
      const score = dot(vec, r.vector)
      if (score >= getImageMemoryThreshold()) {
        scored.push({ id: r.id, source: r.source, title: r.title, text: r.text, score, kind: "note" })
        vectorById.set(r.id, r.vector)
      }
    }
    const notes = selectDiverse(scored, vectorById, IMG_MEMORY_TOPK).map((h) => ({
      ...h,
      title: displayMemoryTitle(h.source, h.title),
    }))

    // (b) image -> similar files the user already has (same-modality, stricter).
    const libHits = await searchLibraryByVector(vec, FILE_TOPK, {
      threshold: FILE_THRESHOLD,
      excludePaths: new Set([asset.path, ...(excludeFilePaths ?? [])]),
    })
    const files: MemoryHit[] = libHits.map((f) => ({
      id: `file:${f.assetKey}`,
      source: f.displayPath,
      title: f.displayPath,
      text: f.conversationTitle
        ? `from conversation "${f.conversationTitle}"${
            typeof f.messageTimestamp === "number"
              ? ` on ${new Date(f.messageTimestamp).toISOString()}`
              : ""
          }`
        : "",
      score: f.score,
      kind: "file",
      assetKey: f.assetKey,
      mimeType: f.mimeType,
      url: `/api/memory/file?assetKey=${encodeURIComponent(f.assetKey)}`,
      conversationId: f.conversationId,
      conversationTitle: f.conversationTitle,
      messageId: f.messageId,
      messageTimestamp: f.messageTimestamp,
    }))

    return { notes, files }
  } catch {
    return empty // fail-open
  }
}

/** Text hits first, then asset-driven notes filling the remaining slots (id-deduped). */
function mergeNoteHits(primary: MemoryHit[], secondary: MemoryHit[], topK: number): MemoryHit[] {
  const out = [...primary]
  const seen = new Set(primary.map((h) => h.id))
  for (const h of secondary) {
    if (out.length >= topK) break
    if (seen.has(h.id)) continue
    seen.add(h.id)
    out.push(h)
  }
  return out.slice(0, topK)
}

/**
 * Compute the automatic per-turn recall for the latest user message. Returns an
 * empty block + no hits on disabled / no key / trivial query / timeout / no
 * match / error (fail-open — the turn proceeds as if recall did not exist).
 *
 * When the active embedding model is multimodal and the turn carries an
 * embeddable attachment (image/PDF), the asset also drives recall: similar older
 * text notes (folded into the recalled_memory block) and similar existing files
 * (a separate similar_files block). The text-query coverage gate never suppresses
 * asset-driven hits — an attachment is explicit, strong intent.
 */
export async function getRecalledMemory(
  query: string | null | undefined,
  options?: RecallAttachmentInput[] | RecalledMemoryOptions
): Promise<RecalledMemory> {
  const empty: RecalledMemory = { block: "", hits: [] }
  try {
    const recallOptions = normalizeRecallOptions(options)
    if (!isRecallEnabled()) return empty
    if (!embeddingsAvailable()) return empty
    const q = (query ?? "").trim()
    const asset = pickRecallAsset(recallOptions.attachments)
    // Nothing to go on: trivial text AND no embeddable attachment.
    if (q.length < MIN_QUERY_CHARS && !asset) return empty

    // Self-heal the index in the background; never block the turn on indexing.
    kickMemoryIndexSync()

    const exclude = inContextSources()
    const excludeSourcePrefixes = recallOptions.conversationId
      ? [conversationSourcePrefix(recallOptions.conversationId)]
      : []
    const excludeFilePaths = new Set(
      (recallOptions.excludeFilePaths ?? []).filter((p) => typeof p === "string" && p.trim())
    )
    const textPromise: Promise<MemoryHit[]> =
      q.length >= MIN_QUERY_CHARS
        ? searchMemory(q, {
            topK: RECALL_TOP_K,
            threshold: getRecallThreshold(),
            excludeSources: exclude,
            excludeSourcePrefixes,
            mode: "semantic",
            coverageGate: true,
          })
        : Promise.resolve([])
    const assetPromise = asset
      ? recallByAsset(asset, exclude, excludeSourcePrefixes, excludeFilePaths)
      : Promise.resolve({ notes: [] as MemoryHit[], files: [] as MemoryHit[] })

    // Independent budgets: a slow/failed image embed must not lose text hits
    // that already landed, and vice versa.
    const [textHits, assetHits] = await Promise.all([
      withSoftTimeout(textPromise, RECALL_TIMEOUT_MS, [] as MemoryHit[]),
      withSoftTimeout(assetPromise, RECALL_ASSET_TIMEOUT_MS, {
        notes: [] as MemoryHit[],
        files: [] as MemoryHit[],
      }),
    ])

    let noteHits = mergeNoteHits(textHits, assetHits.notes, RECALL_TOP_K)
    let fileHits = assetHits.files
    const filteredHits = filterAndRecordConversationRecall(recallOptions.conversationId, [
      ...noteHits,
      ...fileHits,
    ])
    noteHits = filteredHits.filter((hit) => hit.kind !== "file")
    fileHits = filteredHits.filter((hit) => hit.kind === "file")
    const block = [formatRecallBlock(noteHits), formatFilesBlock(fileHits)]
      .filter(Boolean)
      .join("\n")
    return { block, hits: [...noteHits, ...fileHits] }
  } catch {
    return empty // fail-open
  }
}

/** Backward-compatible string-only accessor (used by the smoke test). */
export async function buildRecalledMemoryContext(
  query: string | null | undefined
): Promise<string> {
  return (await getRecalledMemory(query)).block
}

/**
 * One-line activity annotation surfaced in the assistant's collapsible thinking
 * stream so the recall is auditable (which notes, what scores) without a bespoke
 * UI component or new event plumbing.
 */
export function formatRecallNote(hits: MemoryHit[]): string {
  if (hits.length === 0) return ""
  const items = hits
    .map((h) => `${displayMemoryTitle(h.source, h.title || h.source)} (${h.score.toFixed(2)})`)
    .join(", ")
  const n = hits.length
  return `🧠 Memory recall: surfaced ${n} older note${n === 1 ? "" : "s"} by similarity — ${items}.\n`
}

/**
 * Structured form of the recall hits for the UI. The model prompt remains
 * clipped via `formatRecallBlock`, but the UI gets the full indexed chunk so an
 * expanded memory card does not end in an artificial ellipsis.
 */
export function buildRecallUiHits(hits: MemoryHit[]): MemoryRecallHit[] {
  return hits.map((h) => ({
    id: h.id,
    kind: h.kind ?? "note",
    title: displayMemoryTitle(h.source, h.title || h.source),
    source: h.source,
    score: h.score,
    snippet: h.text.replace(/\s+/g, " ").trim(),
    mimeType: h.mimeType,
    url: h.url,
    conversationId: h.conversationId,
    conversationTitle: h.conversationTitle,
    messageId: h.messageId,
    messageTimestamp: h.messageTimestamp,
  }))
}

function normalizedPrefix(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/(?:…|\.\.\.)$/u, "")
    .trim()
}

export function findMemoryChunkForUi(input: {
  id?: string
  source: string
  title?: string
  snippet?: string
}): { title: string; text: string } | null {
  const source = input.source.trim()
  if (!source) return null

  const rows = loadVectorRows(getEmbeddingModel(), getEmbeddingDim()).filter(
    (row) => row.source === source
  )
  if (rows.length === 0) return null

  if (input.id) {
    const byId = rows.find((row) => row.id === input.id)
    if (byId) {
      return { title: displayMemoryTitle(byId.source, byId.title), text: byId.text }
    }
  }

  const title = input.title?.trim()
  const titleMatches = title
    ? rows.filter(
        (row) =>
          row.title === title ||
          displayMemoryTitle(row.source, row.title) === title
      )
    : rows
  const candidates = titleMatches.length > 0 ? titleMatches : rows

  const prefix = input.snippet ? normalizedPrefix(input.snippet) : ""
  if (prefix.length > 0) {
    const bySnippet = candidates.find((row) =>
      normalizedPrefix(row.text).startsWith(prefix)
    )
    if (bySnippet) {
      return {
        title: displayMemoryTitle(bySnippet.source, bySnippet.title),
        text: bySnippet.text,
      }
    }
  }

  const first = candidates[0]
  return first
    ? { title: displayMemoryTitle(first.source, first.title), text: first.text }
    : null
}

// ---------------------------------------------------------------------------
// Explicit tool search (wider net, hybrid, no source exclusion)
// ---------------------------------------------------------------------------

/** Index status for the ACTIVE embedding generation (ops / future UI). */
export function getMemoryStatus(): MemoryStatus {
  return getStatus(getEmbeddingModel(), getEmbeddingDim())
}

/**
 * Calibration search: returns the top hits with RAW scores (no threshold
 * filter) so the Settings UI can show the score distribution and help pick a
 * threshold. Syncs the index first so results reflect current content.
 */
export async function dryRunSearch(
  query: string,
  limit: number
): Promise<MemoryHit[]> {
  try {
    await syncMemoryIndex()
  } catch {
    /* search whatever is already indexed */
  }
  // Calibration view: show the true score distribution, so keep near-duplicates.
  return searchMemory(query, { topK: limit, threshold: 0, mode: "hybrid", dedup: false })
}

export interface RecallSearchPreview {
  rawHits: MemoryHit[]
  automaticHits: MemoryHit[]
  threshold: number
  topK: number
}

/**
 * Settings calibration view: show both the raw score distribution and the exact
 * automatic text-recall result. The latter applies the production threshold,
 * excludes sources already in prompt context, dedups, and runs the coverage gate.
 */
export async function previewRecallSearch(
  query: string,
  rawLimit: number
): Promise<RecallSearchPreview> {
  try {
    await syncMemoryIndex()
  } catch {
    /* search whatever is already indexed */
  }
  const threshold = getRecallThreshold()
  const [rawHits, automaticHits] = await Promise.all([
    searchMemory(query, {
      topK: rawLimit,
      threshold: 0,
      mode: "hybrid",
      dedup: false,
    }),
    searchMemory(query, {
      topK: RECALL_TOP_K,
      threshold,
      excludeSources: inContextSources(),
      mode: "semantic",
      coverageGate: true,
    }),
  ])
  return { rawHits, automaticHits, threshold, topK: RECALL_TOP_K }
}

export async function searchMemoryForTool(
  query: string,
  limit: number
): Promise<{ hits: MemoryHit[]; semanticUsed: boolean }> {
  // The agent explicitly asked: make sure the index is fresh first (cheap when
  // nothing changed — only embeds files whose content hash moved).
  try {
    await syncMemoryIndex()
  } catch {
    /* fall through to whatever is already indexed */
  }
  const semanticUsed = embeddingsAvailable()
  const hits = await searchMemory(query, {
    topK: limit,
    threshold: TOOL_THRESHOLD,
    mode: "hybrid",
  })
  return { hits, semanticUsed }
}
