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
//  - Conversation history is indexed at EXCHANGE granularity: one source per
//    user turn + the assistant reply that follows it. A question without its
//    answer (and vice versa) is semantic noise in isolation; paired, each side
//    anchors the other. Long exchanges split into paragraph chunks, each
//    re-anchored with a capped copy of the user's question.
//  - The automatic per-turn pass (buildRecalledMemoryContext) embeds the user's
//    message and surfaces older memories that are NOT already in the prompt
//    (it excludes the durable files + the last 3 daily files, which the prompt
//    builder already injects). That targets exactly the "months later, similar
//    thing comes up" case.
//  - Precision filters keep that pass honest (all silent-pass-only; the explicit
//    memory_search tool stays wide): old daily/conversation chunks pay a small
//    age penalty, candidates far below the turn's best score are dropped
//    (applyTopGap — cosine scores are uncalibrated globally but comparable
//    within one query), same-topic version clusters are resolved
//    (resolveVersionClusters — curated notes beat raw conversation exchanges;
//    among raw-only versions the newest is shown with the older folded into the
//    same hit, dates visible, so the model judges validity), and a coverage gate
//    (shouldSuppressByCoverage) drops the whole block when a broad,
//    multi-intent message is matched only by a small tangential slice of memory.
//    Legacy per-message assistant chunks (pre-exchange index rows) are skipped
//    outright until the reindex replaces them.
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
import { getMemoryEmbeddingSettings } from "@/lib/config"
import { MAX_CONTEXT_FILE_CHARS } from "@/lib/ai/prompts/shared"
import {
  MAX_PLAYBOOKS_CONTEXT_CHARS,
  MAX_USER_CONTEXT_CHARS,
} from "@/lib/memory/recent-context"
import { activeRuntimePaths } from "@/lib/runtime-paths"
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
  anyGenerationChunksMatch,
  ftsSearch,
  generationChunksMatch,
  generationFresh,
  getContentHash,
  getMemoryMetaInt,
  getStatus,
  getThreshold,
  listContentSources,
  loadVectorRows,
  markContentChanged,
  pruneSource,
  setThreshold,
  setMemoryMetaInt,
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

// Relative cutoff for the SILENT pass: drop candidates more than this far below
// the turn's best semantic score. Absolute cosine thresholds can't separate
// "relevant" from "topically adjacent" (the score distribution shifts with query
// length and language), but scores ARE comparable within a single query: when
// one note matches clearly, notes much weaker than it are tangential riders.
const RECALL_TOP_GAP = clampNumber(
  process.env.ORCHESTRATOR_MEMORY_RECALL_TOP_GAP,
  0.05,
  0,
  1
)

// Small score penalty for OLD dated chunks (daily ledger + conversation
// messages) in the silent pass, growing linearly to AGE_PENALTY_MAX over
// AGE_PENALTY_HORIZON_DAYS. A year-old ledger line must clear a slightly higher
// bar than today's; durable files (USER/MEMORY/...) are curated and never pay it.
const AGE_PENALTY_MAX = clampNumber(
  process.env.ORCHESTRATOR_MEMORY_RECALL_AGE_PENALTY,
  0.03,
  0,
  0.2
)
const AGE_PENALTY_HORIZON_DAYS = 365

// Near-duplicate suppression. Vectors are unit-normalized (cosine == dot), so
// this is a similarity in [0,1]. Kept high/conservative: it only collapses hits
// the model considers near-identical — e.g. the SAME fact re-logged across
// several daily files — while distinct same-topic notes survive.
const DEDUP_SIM = clampNumber(process.env.ORCHESTRATOR_MEMORY_RECALL_DEDUP, 0.92, 0.5, 1)

// Version-cluster thresholds (SILENT pass only, see resolveVersionClusters).
// Two hits at/above the bar are treated as versions of the same topic. Chunks
// from the SAME conversation get a lower bar: a correction three turns later
// ("actually, make it Y") is phrased differently enough that the global bar
// would miss it, while cross-source clustering must stay strict to avoid
// merging merely-related notes.
const CLUSTER_SIM = clampNumber(
  process.env.ORCHESTRATOR_MEMORY_RECALL_CLUSTER_SIM,
  0.9,
  0.5,
  1
)
const CLUSTER_SIM_SAME_CONVERSATION = clampNumber(
  process.env.ORCHESTRATOR_MEMORY_RECALL_CLUSTER_SIM_LOCAL,
  0.8,
  0.5,
  1
)
// O(n²) pairwise dots stay trivial at this size (vectors are already in RAM).
const CLUSTER_MAX_CANDIDATES = 64
// Budget for the folded-in older version inside a merged hit, sized so both
// versions survive formatRecallBlock's MAX_HIT_CHARS clip.
const CLUSTER_OLDER_VERSION_CHARS = 140

// When a long exchange splits into multiple chunks, every fragment of the
// answer is re-anchored with this much of the user's question.
const EXCHANGE_ANCHOR_CHARS = 240

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
const MIN_CONVERSATION_CHUNK_CHARS = 24
// Defensive cap so a pathological huge paragraph can never hit the embedding
// model's per-item token limit (gemini-embedding-2: 8192 tokens, SILENTLY
// truncated above it). ~4000 chars ≈ ~1000 tokens — comfortably under, and
// small focused chunks retrieve better than huge ones anyway.
const MAX_CHUNK_CHARS = 4000
const MAX_HIT_CHARS = 320
const SYNC_DEBOUNCE_MS = 15_000
const CHUNKING_VERSION = 2
const CHUNKING_VERSION_META_KEY = "chunkingVersion"

// Durable files the prompt builder already injects every turn (lib/ai/prompts/
// shared.ts). The silent pass excludes them so it only surfaces *new* signal.
// All durable markdown files we INDEX for semantic recall (content searchable),
// regardless of whether they are injected into the prompt.
const INDEXED_DURABLE_FILES = [
  "USER.md",
  "MEMORY.md",
  "MEMORY_ARCHIVE.md",
  "MONITORS.md",
  "PLAYBOOKS.md",
]

// The HOT tier the prompt builder injects every ordinary orchestrator turn
// (lib/ai/prompts/shared.ts buildWorkspaceContextFiles). MEMORY is full within
// its safety cap; larger USER/PLAYBOOKS files use bounded extractive views. The
// silent recall pass excludes a source only when its raw content fully fits the
// corresponding prompt-view budget — see inContextSources.
// MEMORY_ARCHIVE.md is the recall-only cold tier and MONITORS.md is injected
// only on the Smart Monitor wake (not this chat recall path), so NEITHER is hot
// here: both must stay recall-reachable. Recent MEMORY_DAY files are also kept
// recall-reachable because the prompt now carries only a bounded extractive
// orientation view, not the complete raw ledger.
const HOT_DURABLE_SOURCE_BUDGETS = new Map<string, number>([
  ["USER.md", Math.min(MAX_CONTEXT_FILE_CHARS, MAX_USER_CONTEXT_CHARS)],
  ["MEMORY.md", MAX_CONTEXT_FILE_CHARS],
  [
    "PLAYBOOKS.md",
    Math.min(MAX_CONTEXT_FILE_CHARS, MAX_PLAYBOOKS_CONTEXT_CHARS),
  ],
])
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
  "cold storage for durable memory",
  "the nightly reflection moves rarely-used",
  "this file is not loaded into the prompt every turn",
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
  for (const rel of INDEXED_DURABLE_FILES) {
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

// Conversation history is indexed at EXCHANGE granularity: consecutive user
// messages + the assistant replies that follow them form ONE source. Isolated
// messages retrieve badly (a question without its answer, an answer without
// its question), and isolated assistant prose is the dominant false-positive
// source. The source id is keyed to the exchange's FIRST message id, so it is
// stable while the exchange grows: when the assistant reply lands, only that
// source's content hash changes and it re-embeds in place.
interface ConversationExchange {
  conversationId: string
  conversationTitle: string
  anchorMessageId: string
  userParts: string[]
  assistantParts: string[]
  attachments: string[]
  lastTimestamp: number
}

function groupConversationExchanges(
  rows: ConversationMemoryRow[]
): ConversationExchange[] {
  const byConversation = new Map<string, ConversationMemoryRow[]>()
  for (const row of rows) {
    const list = byConversation.get(row.conversationId)
    if (list) list.push(row)
    else byConversation.set(row.conversationId, [row])
  }

  const out: ConversationExchange[] = []
  for (const list of byConversation.values()) {
    let current: ConversationExchange | null = null
    for (const row of list) {
      // A user message arriving after assistant replies starts a new exchange.
      if (!current || (row.role === "user" && current.assistantParts.length > 0)) {
        if (current) out.push(current)
        current = {
          conversationId: row.conversationId,
          conversationTitle: row.conversationTitle,
          anchorMessageId: row.messageId,
          userParts: [],
          assistantParts: [],
          attachments: [],
          lastTimestamp: row.timestamp,
        }
      }
      const body = stripArtifactBlocksForPreview(row.content ?? "").trim()
      if (body) {
        if (row.role === "assistant") current.assistantParts.push(body)
        else current.userParts.push(body)
      }
      for (const name of parseAttachmentNames(row.attachments)) {
        if (current.attachments.length >= MAX_CONVERSATION_ATTACHMENT_NAMES) break
        if (!current.attachments.includes(name)) current.attachments.push(name)
      }
      current.lastTimestamp = row.timestamp
    }
    if (current) out.push(current)
  }
  return out
}

function formatConversationSource(exchange: ConversationExchange): string {
  const title = exchange.conversationTitle?.trim() || "Untitled conversation"
  const date = new Date(exchange.lastTimestamp).toISOString()
  const metaLines = [
    `Conversation: ${title}`,
    `Conversation ID: ${exchange.conversationId}`,
    `Message ID: ${exchange.anchorMessageId}`,
    `Date: ${date}`,
    exchange.attachments.length
      ? `Attachments: ${exchange.attachments.join(", ")}`
      : "",
  ].filter(Boolean)
  const sections = [
    exchange.userParts.length ? `User: ${exchange.userParts.join("\n\n")}` : "",
    exchange.assistantParts.length
      ? `Assistant: ${exchange.assistantParts.join("\n\n")}`
      : "",
  ].filter(Boolean)
  return [metaLines.join("\n"), "", sections.join("\n\n")].join("\n").trim()
}

function listConversationMemorySources(): MemorySourceSnapshot[] {
  return groupConversationExchanges(listConversationMemoryRows()).map((exchange) => ({
    source: conversationSourceId(exchange.conversationId, exchange.anchorMessageId),
    content: formatConversationSource(exchange),
  }))
}

// ---------------------------------------------------------------------------
// Recent-activity enumeration (non-semantic).
//
// Semantic recall answers "have we seen something LIKE this?"; this answers
// "what did the user actually ask for lately?" — a cheap, date-bounded sweep
// over the same exchange grouping, no embeddings involved. Primary consumer is
// the nightly memory reflection's playbook synthesis (spotting the same
// multi-step request recurring across days), exposed to the model as the
// memory_recent_activity tool.
// ---------------------------------------------------------------------------

export interface RecentConversationActivity {
  conversationId: string
  title: string
  lastTimestamp: number
  exchangeCount: number
  /** First user message of each exchange, compacted — the "what was asked"
   *  signal, without assistant prose. */
  userRequests: string[]
}

export function listRecentConversationActivity(opts: {
  sinceMs: number
  maxConversations?: number
  maxRequestsPerConversation?: number
}): RecentConversationActivity[] {
  const maxConversations = Math.max(1, Math.min(opts.maxConversations ?? 60, 200))
  const maxRequests = Math.max(1, Math.min(opts.maxRequestsPerConversation ?? 12, 50))
  // Filtering rows before grouping can split an exchange straddling the window
  // edge — harmless here, since only the user-request lines are consumed.
  const rows = listConversationMemoryRows().filter((r) => r.timestamp >= opts.sinceMs)
  const byConversation = new Map<string, RecentConversationActivity>()
  for (const exchange of groupConversationExchanges(rows)) {
    let entry = byConversation.get(exchange.conversationId)
    if (!entry) {
      entry = {
        conversationId: exchange.conversationId,
        title: exchange.conversationTitle?.trim() || "Untitled conversation",
        lastTimestamp: exchange.lastTimestamp,
        exchangeCount: 0,
        userRequests: [],
      }
      byConversation.set(exchange.conversationId, entry)
    }
    entry.exchangeCount++
    entry.lastTimestamp = Math.max(entry.lastTimestamp, exchange.lastTimestamp)
    const firstUser = exchange.userParts[0]?.replace(/\s+/g, " ").trim()
    if (firstUser && entry.userRequests.length < maxRequests) {
      entry.userRequests.push(
        firstUser.length > 200 ? `${firstUser.slice(0, 200)}…` : firstUser
      )
    }
  }
  return [...byConversation.values()]
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    .slice(0, maxConversations)
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

/**
 * Sources already fully in the prompt this turn — excluded from the silent pass
 * so it only surfaces *new* signal. The hot durable files (USER/MEMORY/PLAYBOOKS)
 * are injected by the prompt builder either fully or as explicit compact views.
 *
 * Crucially, a hot file is only excluded when its raw content FITS that source's
 * prompt-view budget. If it is compacted or clipped, the omitted raw detail is
 * NOT fully in the prompt, so the source remains recall-eligible. Nothing is
 * silently lost.
 * MONITORS.md and MEMORY_ARCHIVE.md are deliberately absent here (cold tier).
 * MEMORY_DAY is deliberately absent too: recent days appear only as compact
 * extractive views, so their complete raw entries must remain recall-eligible.
 * Exported for the recall smoke test.
 */
export function inContextSources(): Set<string> {
  const set = new Set<string>()
  for (const [source, promptBudget] of HOT_DURABLE_SOURCE_BUDGETS) {
    const content = readSource(source)
    if (content === null) continue
    if (content.length <= promptBudget) set.add(source)
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

  const pushEntry = (text: string): void => {
    if (!text || isTemplateNoise(text)) return
    for (const part of splitPlainTextForChunks(text)) {
      // Raw memory is the source of truth, but the derived semantic index must
      // represent every non-template entry too. In particular, do not drop
      // short identifiers/preferences or truncate the tail of a long capsule.
      if (part) raw.push({ title: titleFor(source, heading), text: part })
    }
  }

  const flushPara = (): void => {
    if (para.length === 0) return
    const text = para.join(" ").replace(/\s+/g, " ").trim()
    para = []
    pushEntry(text)
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
      pushEntry(text)
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

function splitPlainTextForChunks(
  text: string,
  maxChars = MAX_CHUNK_CHARS
): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim()
  if (!normalized || maxChars <= 0) return []

  const parts: string[] = []
  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean)

  for (const block of blocks.length ? blocks : [normalized.replace(/\s+/g, " ").trim()]) {
    if (block.length <= maxChars) {
      parts.push(block)
      continue
    }

    // Balance the pieces first (4010 chars becomes roughly 2005+2005, not a
    // 4000-char chunk plus a tiny tail), then prefer a nearby word boundary.
    let remaining = block
    let piecesLeft = Math.ceil(block.length / maxChars)
    while (remaining.length > maxChars && piecesLeft > 1) {
      const target = Math.min(maxChars, Math.ceil(remaining.length / piecesLeft))
      const lowerBound = Math.floor(target * 0.65)
      const before = remaining.lastIndexOf(" ", target)
      const after = remaining.indexOf(" ", target)
      const cut = before >= lowerBound
        ? before
        : after > 0 && after <= maxChars
          ? after
          : target
      const part = remaining.slice(0, cut).trim()
      if (part) parts.push(part)
      remaining = remaining.slice(cut).trim()
      piecesLeft -= 1
    }
    if (remaining) parts.push(remaining)
  }
  return parts
}

// Exchange-source chunking. A short exchange becomes ONE chunk holding both
// sides — the question anchors the answer semantically. A long exchange splits
// into paragraph chunks, but every fragment of the answer is re-anchored with
// a capped copy of the user's question so no piece floats free of its context
// (the original per-message indexing failure mode).
export function chunkConversationContent(source: string, content: string): Chunk[] {
  const title = conversationMeta(content, "Conversation") || source
  const date = conversationMeta(content, "Date")
  const attachments = conversationMeta(content, "Attachments")
  const body = content.split(/\n\n/).slice(1).join("\n\n").trim()

  let userText = ""
  let assistantText = ""
  if (body.startsWith("User: ")) {
    const split = body.indexOf("\n\nAssistant: ")
    if (split >= 0) {
      userText = body.slice("User: ".length, split).trim()
      assistantText = body.slice(split + "\n\nAssistant: ".length).trim()
    } else {
      userText = body.slice("User: ".length).trim()
    }
  } else if (body.startsWith("Assistant: ")) {
    assistantText = body.slice("Assistant: ".length).trim()
  } else {
    userText = body
  }

  const chunkTitle = `Conversation › ${title}${date ? ` · ${date.slice(0, 10)}` : ""}`
  const head = [
    `Exchange${date ? ` on ${date}` : ""}`,
    attachments ? `attachments: ${attachments}` : "",
  ]
    .filter(Boolean)
    .join("; ")

  const flatUser = userText.replace(/\s+/g, " ").trim()
  const flatAssistant = assistantText.replace(/\s+/g, " ").trim()
  const wholeBody =
    [
      flatUser ? `User: ${flatUser}` : "",
      flatAssistant ? `Assistant: ${flatAssistant}` : "",
    ]
      .filter(Boolean)
      .join(" ") || attachments
  if (!wholeBody) return []

  const whole = `${head}: ${wholeBody}`
  const texts: string[] = []
  if (whole.length <= MAX_CHUNK_CHARS) {
    texts.push(whole)
  } else {
    const anchor =
      flatUser.length > EXCHANGE_ANCHOR_CHARS
        ? `${flatUser.slice(0, EXCHANGE_ANCHOR_CHARS).trimEnd()}…`
        : flatUser
    for (const part of splitPlainTextForChunks(userText)) {
      const prefix = `${head}: User: `
      for (const fitted of splitPlainTextForChunks(part, MAX_CHUNK_CHARS - prefix.length)) {
        texts.push(`${prefix}${fitted}`)
      }
    }
    const assistantPrefix = anchor
      ? `${head}: User: ${anchor} › Assistant: `
      : `${head}: Assistant: `
    for (const part of splitPlainTextForChunks(
      assistantText,
      MAX_CHUNK_CHARS - assistantPrefix.length
    )) {
      texts.push(`${assistantPrefix}${part}`)
    }
  }

  return texts
    .filter(
      (text) => text.length >= MIN_CONVERSATION_CHUNK_CHARS && !isTemplateNoise(text)
    )
    .map((text, index) => ({ chunkIndex: index, title: chunkTitle, text }))
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
  const needsChunkingMigration =
    getMemoryMetaInt(CHUNKING_VERSION_META_KEY) < CHUNKING_VERSION

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
    let deferredChunkMigration = false
    const contentChanged = getContentHash(source) !== hash
    if (contentChanged) {
      chunks = chunkMemorySource(source, content)
      markContentChanged(source, hash, chunks)
    }

    // 2. Ensure the ACTIVE generation is embedded for the current content. If a
    //    fresh generation already exists (e.g. we switched back to a model used
    //    before, content unchanged), this is a no-op — free, no API call.
    if (generationFresh(source, getEmbeddingModel(), getEmbeddingDim(), hash)) {
      if (!needsChunkingMigration) continue
      chunks = chunkMemorySource(source, content)
      if (
        generationChunksMatch(
          source,
          getEmbeddingModel(),
          getEmbeddingDim(),
          chunks
        )
      ) {
        continue
      }
      // Same raw content, improved chunk representation. Keep the currently
      // useful (if incomplete) vectors until the replacement embed succeeds;
      // a transient provider outage must not turn a targeted migration into a
      // recall outage.
      deferredChunkMigration = true
    } else if (needsChunkingMigration && !contentChanged) {
      chunks = chunkMemorySource(source, content)
      deferredChunkMigration = !anyGenerationChunksMatch(source, chunks)
    }

    if (!chunks) chunks = chunkMemorySource(source, content)
    if (chunks.length === 0) {
      // Record an empty generation so we don't retry an empty file every sync.
      if (deferredChunkMigration) markContentChanged(source, hash, chunks)
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
    if (deferredChunkMigration) markContentChanged(source, hash, chunks)
    writeGeneration(source, getEmbeddingModel(), getEmbeddingDim(), hash, rows)
    indexed += 1
  }

  if (needsChunkingMigration && failed === 0) {
    setMemoryMetaInt(CHUNKING_VERSION_META_KEY, CHUNKING_VERSION)
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
  /** Silent pass only: skip assistant-authored conversation chunks. Only
   *  LEGACY per-message index rows carry the role marker — exchange chunks are
   *  anchored by the user's text and never match — so this is a transitional
   *  no-op once the exchange reindex completes (default false). */
  excludeAssistantTurns?: boolean
  /** Silent pass only: drop semantic candidates more than this far below the
   *  turn's best score (0/undefined = off). */
  topGap?: number
  /** Silent pass only: penalize old dated chunks slightly (default false). */
  agePenalty?: boolean
  /** Silent pass only: resolve same-topic version clusters — curated sources
   *  beat raw conversation exchanges, raw-only clusters show the newest with
   *  the older version folded in (default false; subsumes dedup). */
  versionClusters?: boolean
}

function isSourceExcluded(
  source: string,
  exact: Set<string>,
  prefixes: readonly string[]
): boolean {
  if (exact.has(source)) return true
  return prefixes.some((prefix) => source.startsWith(prefix))
}

// Conversation chunk titles carry the speaking role ("Conversation › <title> ›
// Assistant · 2026-01-03"), which is the only role marker that survives into the
// vector rows — so existing indexes work without a re-embed.
const ASSISTANT_TITLE_RE = /›\s*Assistant(?:\s*·|\s*$)/

/** True for a conversation chunk authored by the assistant. Exported for tests. */
export function isAssistantConversationChunk(source: string, title: string): boolean {
  return source.startsWith(CONVERSATION_SOURCE_PREFIX) && ASSISTANT_TITLE_RE.test(title)
}

const DAY_SOURCE_RE = /^MEMORY_DAY\/(\d{4}-\d{2}-\d{2})\.md$/
const CONVERSATION_TITLE_DATE_RE = /·\s*(\d{4}-\d{2}-\d{2})\s*$/

/**
 * YYYY-MM-DD stamp for dated chunks (daily ledger files by filename,
 * conversation chunks by the date in their title); null for the undated
 * curated durable files. Exported for tests.
 */
export function chunkDateStamp(source: string, title: string): string | null {
  return (
    DAY_SOURCE_RE.exec(source)?.[1] ??
    (source.startsWith(CONVERSATION_SOURCE_PREFIX)
      ? (CONVERSATION_TITLE_DATE_RE.exec(title)?.[1] ?? null)
      : null)
  )
}

/**
 * Score penalty in [0, AGE_PENALTY_MAX] for dated chunks (daily ledger files by
 * filename, conversation chunks by the date in their title). Undated sources
 * (the curated durable files) pay nothing. Exported for tests.
 */
export function recallAgePenalty(
  source: string,
  title: string,
  now: number = Date.now()
): number {
  if (AGE_PENALTY_MAX <= 0) return 0
  const stamp = chunkDateStamp(source, title)
  if (!stamp) return 0
  const ageMs = now - Date.parse(stamp)
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 0
  return (
    AGE_PENALTY_MAX *
    Math.min(1, ageMs / (AGE_PENALTY_HORIZON_DAYS * 86_400_000))
  )
}

/** Keep only candidates within `gap` of the best score. Exported for tests. */
export function applyTopGap(candidates: MemoryHit[], gap: number): MemoryHit[] {
  if (!(gap > 0) || candidates.length <= 1) return candidates
  let best = -Infinity
  for (const c of candidates) if (c.score > best) best = c.score
  const cutoff = best - gap
  return candidates.filter((c) => c.score >= cutoff)
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

// ---------------------------------------------------------------------------
// Version-cluster resolution (SILENT pass only)
// ---------------------------------------------------------------------------
// Same-topic memories accumulate versions over time: the user decides X in one
// exchange and revises it to Y three turns (or three weeks) later; a daily note
// supersedes an older one. Cosine similarity can DETECT that two hits are
// versions of the same topic, but cannot judge which one still holds — newest
// is not always rightest. So the resolution never destroys information:
//  1. Curated beats raw. Durable files and daily-ledger lines are rewritten in
//     place by the agent when the user changes their mind, so a curated member
//     IS the resolved state of the topic — raw conversation versions of it are
//     redundant and drop. Durable (undated) > daily > conversation.
//  2. Among raw-only versions nothing is judged: the newest is shown and the
//     best older version is folded INTO the same hit with its date visible,
//     so the model reading the block resolves validity itself.
//  3. The explicit memory_search tool never goes through this — it stays wide
//     and returns every version with ids and dates.

type SourceTier = 0 | 1 | 2

/** 2 = curated durable file, 1 = daily ledger line, 0 = raw conversation exchange. */
function sourceTier(source: string): SourceTier {
  if (source.startsWith(CONVERSATION_SOURCE_PREFIX)) return 0
  if (DAY_SOURCE_RE.test(source)) return 1
  return 2
}

function sameConversationSource(a: string, b: string): boolean {
  if (
    !a.startsWith(CONVERSATION_SOURCE_PREFIX) ||
    !b.startsWith(CONVERSATION_SOURCE_PREFIX)
  ) {
    return false
  }
  return a.split(":")[1] === b.split(":")[1]
}

// Undated curated chunks sort as "current" — they are maintained in place.
function newestFirst(a: MemoryHit, b: MemoryHit): number {
  const da = chunkDateStamp(a.source, a.title) ?? "9999-12-31"
  const db = chunkDateStamp(b.source, b.title) ?? "9999-12-31"
  if (da !== db) return db.localeCompare(da)
  return b.score - a.score
}

function resolveCluster(members: MemoryHit[]): MemoryHit {
  if (members.length === 1) return members[0]

  const bestTier = Math.max(...members.map((m) => sourceTier(m.source)))
  const top = [...members.filter((m) => sourceTier(m.source) === bestTier)].sort(
    newestFirst
  )
  const rep = top[0]
  if (bestTier > 0) return rep

  // Raw-only cluster: fold the strongest genuinely-older version into the
  // newest hit instead of picking a winner. Same-day restatements are plain
  // near-duplicates and just collapse.
  const repDate = chunkDateStamp(rep.source, rep.title)
  const older = top.find((m) => chunkDateStamp(m.source, m.title) !== repDate)
  if (!older) return rep
  const olderDate = chunkDateStamp(older.source, older.title)
  return {
    ...rep,
    text: `${clip(rep.text, MAX_HIT_CHARS - CLUSTER_OLDER_VERSION_CHARS - 40)} 〔older version, ${olderDate}: ${clip(older.text, CLUSTER_OLDER_VERSION_CHARS)}〕`,
  }
}

/**
 * Cluster same-topic candidates and resolve each cluster to one hit (see the
 * section comment above for the rules). Subsumes near-duplicate suppression:
 * the cluster bars sit below DEDUP_SIM, so anything selectDiverse would
 * collapse, this collapses too. Vectorless (FTS-only) hits pass through as
 * their own clusters. Exported for tests.
 */
export function resolveVersionClusters(
  candidates: MemoryHit[],
  vectorById: Map<string, Float32Array>,
  topK: number
): MemoryHit[] {
  const ranked = [...candidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, CLUSTER_MAX_CANDIDATES)

  const clusters: MemoryHit[][] = []
  for (const cand of ranked) {
    const v = vectorById.get(cand.id)
    let joined = false
    if (v) {
      outer: for (const cluster of clusters) {
        for (const member of cluster) {
          const mv = vectorById.get(member.id)
          if (!mv || mv.length !== v.length) continue
          const bar = sameConversationSource(cand.source, member.source)
            ? CLUSTER_SIM_SAME_CONVERSATION
            : CLUSTER_SIM
          if (dot(v, mv) >= bar) {
            cluster.push(cand)
            joined = true
            break outer
          }
        }
      }
    }
    if (!joined) clusters.push([cand])
  }

  return clusters
    .map(resolveCluster)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
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
  const qVec = await embedQuery(query)
  return searchMemoryWithVector(query, qVec, opts)
}

async function searchMemoryWithVector(
  query: string,
  qVec: Float32Array | null,
  opts: SearchOptions = {}
): Promise<MemoryHit[]> {
  const topK = opts.topK ?? RECALL_TOP_K
  const threshold = opts.threshold ?? getRecallThreshold()
  const exclude = opts.excludeSources ?? new Set<string>()
  const excludePrefixes = opts.excludeSourcePrefixes ?? []
  const mode = opts.mode ?? "semantic"
  const dedup = opts.dedup ?? true

  let candidates: MemoryHit[] = []
  const seenIds = new Set<string>()
  const vectorById = new Map<string, Float32Array>()

  if (qVec) {
    const rows = loadVectorRows(getEmbeddingModel(), getEmbeddingDim())
    for (const r of rows) {
      if (isSourceExcluded(r.source, exclude, excludePrefixes)) continue
      if (opts.excludeAssistantTurns && isAssistantConversationChunk(r.source, r.title)) {
        continue
      }
      if (r.vector.length !== qVec.length) continue
      const score =
        dot(qVec, r.vector) -
        (opts.agePenalty ? recallAgePenalty(r.source, r.title) : 0)
      if (score >= threshold) {
        candidates.push({ id: r.id, source: r.source, title: r.title, text: r.text, score })
        seenIds.add(r.id)
        vectorById.set(r.id, r.vector)
      }
    }
    candidates = applyTopGap(candidates, opts.topGap ?? 0)
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

  const selected = opts.versionClusters
    ? resolveVersionClusters(candidates, vectorById, topK)
    : dedup
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
    "Possibly relevant notes from your long-term memory, retrieved by semantic similarity to the current message. They may be old, superseded, or no longer accurate — and recency is not validity: even a snippet written today only captures the moment it was saved, and the code, files, or state it describes may have changed since (a problem it mentions may already be fixed). Re-check the live workspace files before relying on any of them, and prefer those files and the current message on conflict. This is a hint surfaced automatically; do not mention it unless it is actually useful.",
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
      // Legacy per-message assistant chunks are too broad; exchange chunks are
      // user-anchored and never match this (transitional, like the text pass).
      if (isAssistantConversationChunk(r.source, r.title)) continue
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
            excludeAssistantTurns: true,
            topGap: RECALL_TOP_GAP,
            agePenalty: true,
            versionClusters: true,
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

/** Read-only evaluation pair: unfiltered semantic ranking plus the exact
 * automatic text-recall pipeline. Does not sync or mutate the index. */
export async function evaluateRecallSearch(
  query: string,
  rawLimit: number
): Promise<RecallSearchPreview> {
  const threshold = getRecallThreshold()
  const qVec = await embedQuery(query)
  const [rawHits, automaticHits] = await Promise.all([
    searchMemoryWithVector(query, qVec, {
      topK: rawLimit,
      threshold: 0,
      mode: "semantic",
      dedup: false,
    }),
    searchMemoryWithVector(query, qVec, {
      topK: RECALL_TOP_K,
      threshold,
      excludeSources: inContextSources(),
      mode: "semantic",
      coverageGate: true,
      excludeAssistantTurns: true,
      topGap: RECALL_TOP_GAP,
      agePenalty: true,
      versionClusters: true,
    }),
  ])
  return { rawHits, automaticHits, threshold, topK: RECALL_TOP_K }
}

/**
 * Settings calibration view: show both the raw score distribution and the exact
 * automatic text-recall result. The latter applies the full production filter
 * chain: threshold, in-context source exclusion, legacy assistant-turn
 * exclusion, age penalty, top-gap cutoff, version-cluster resolution, and the
 * coverage gate.
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
  const qVec = await embedQuery(query)
  const [rawHits, automaticHits] = await Promise.all([
    searchMemoryWithVector(query, qVec, {
      topK: rawLimit,
      threshold: 0,
      mode: "hybrid",
      dedup: false,
    }),
    searchMemoryWithVector(query, qVec, {
      topK: RECALL_TOP_K,
      threshold,
      excludeSources: inContextSources(),
      mode: "semantic",
      coverageGate: true,
      excludeAssistantTurns: true,
      topGap: RECALL_TOP_GAP,
      agePenalty: true,
      versionClusters: true,
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
