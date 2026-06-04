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
//  - Everything is fail-open: disabled, no key, timeout, or error => "".

import fs from "fs"
import path from "path"
import { createHash } from "crypto"

import type { MemoryRecallHit } from "@/lib/types"
import { AGENT_WORKSPACE_DIR, getConfiguredTimezone, getMemoryEmbeddingSettings } from "@/lib/config"
import { dateStampInTimezone } from "@/lib/timezone"
import {
  embedDocuments,
  embedQueries,
  embedQuery,
  embeddingsAvailable,
  getEmbeddingDim,
  getEmbeddingModel,
} from "./embeddings"
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
  const abs = path.resolve(AGENT_WORKSPACE_DIR, relPath)
  if (abs !== AGENT_WORKSPACE_DIR && !abs.startsWith(AGENT_WORKSPACE_DIR + path.sep)) {
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

/** All memory source files currently on disk (durable + every daily note). */
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

  const files = listMemorySourceFiles()
  const fileSet = new Set(files)

  // Drop sources whose files disappeared (every generation + content + FTS).
  for (const source of listContentSources()) {
    if (!fileSet.has(source)) {
      pruneSource(source)
      removed += 1
    }
  }

  for (const source of files) {
    const content = readSource(source)
    if (content === null) continue
    const hash = sha256(content)

    // 1. Content change: rebuild the model-independent content marker + FTS and
    //    wipe every stale embedding generation for this source.
    let chunks: Chunk[] | null = null
    if (getContentHash(source) !== hash) {
      chunks = chunkMarkdown(source, content)
      markContentChanged(source, hash, chunks)
    }

    // 2. Ensure the ACTIVE generation is embedded for the current content. If a
    //    fresh generation already exists (e.g. we switched back to a model used
    //    before, content unchanged), this is a no-op — free, no API call.
    if (generationFresh(source, getEmbeddingModel(), getEmbeddingDim(), hash)) continue

    if (!chunks) chunks = chunkMarkdown(source, content)
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
  /** "hybrid" blends keyword (FTS) hits in when semantic is thin/unavailable. */
  mode?: "semantic" | "hybrid"
  /** Collapse near-duplicate hits (default true). Off for calibration dry-runs. */
  dedup?: boolean
  /** Silent per-turn pass only: suppress entirely when a broad, multi-intent
   *  message is matched only by a small tangential slice of memory (default false). */
  coverageGate?: boolean
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
  const mode = opts.mode ?? "semantic"
  const dedup = opts.dedup ?? true

  const candidates: MemoryHit[] = []
  const seenIds = new Set<string>()
  const vectorById = new Map<string, Float32Array>()

  const qVec = await embedQuery(query)
  if (qVec) {
    const rows = loadVectorRows(getEmbeddingModel(), getEmbeddingDim())
    for (const r of rows) {
      if (exclude.has(r.source)) continue
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
        if (exclude.has(hit.source)) continue
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("recall timeout")), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
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

export interface RecalledMemory {
  /** Prompt block to inject into the user message (empty when nothing recalled). */
  block: string
  /** The hits behind the block — used to surface a UI/activity annotation. */
  hits: MemoryHit[]
}

/**
 * Compute the automatic per-turn recall for the latest user message. Returns an
 * empty block + no hits on disabled / no key / trivial query / timeout / no
 * match / error (fail-open — the turn proceeds as if recall did not exist).
 */
export async function getRecalledMemory(
  query: string | null | undefined
): Promise<RecalledMemory> {
  const empty: RecalledMemory = { block: "", hits: [] }
  try {
    if (!isRecallEnabled()) return empty
    const q = (query ?? "").trim()
    if (q.length < MIN_QUERY_CHARS) return empty
    if (!embeddingsAvailable()) return empty

    // Self-heal the index in the background; never block the turn on indexing.
    kickMemoryIndexSync()

    const hits = await withTimeout(
      searchMemory(q, {
        topK: RECALL_TOP_K,
        threshold: getRecallThreshold(),
        excludeSources: inContextSources(),
        mode: "semantic",
        coverageGate: true,
      }),
      RECALL_TIMEOUT_MS
    )
    return { block: formatRecallBlock(hits), hits }
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
    title: displayMemoryTitle(h.source, h.title || h.source),
    source: h.source,
    score: h.score,
    snippet: h.text.replace(/\s+/g, " ").trim(),
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
