// Embedding backend for semantic memory recall — multi-provider.
//
// Supports Google/Gemini (gemini-embedding-2 via @google/genai) and OpenAI
// (text-embedding-3-* via the REST embeddings endpoint), selected in Settings.
// Everything is FAIL-OPEN: missing key, network error, timeout, or a bad
// response returns null, and the caller treats recall as if it did not exist.
//
// Each stored chunk records the model+dim it was embedded with, so switching
// provider/model is safe and reversible (see store.ts generations).

import { GoogleGenAI } from "@google/genai"
import {
  getApiKey,
  getEnvValue,
  getMemoryEmbeddingSettings,
  type EmbeddingProviderId,
} from "@/lib/config"

export function getEmbeddingProvider(): EmbeddingProviderId {
  return getMemoryEmbeddingSettings().provider
}

export function getEmbeddingModel(): string {
  return getMemoryEmbeddingSettings().model
}

export function getEmbeddingDim(): number {
  return getMemoryEmbeddingSettings().dim
}

// Per-request batch cap — keep modest to stay under provider request limits.
const EMBED_BATCH_SIZE = 64

// ---------------------------------------------------------------------------
// API key resolution (reuse existing provider credentials)
// ---------------------------------------------------------------------------

export function resolveGoogleApiKey(): string | null {
  return (
    getEnvValue("GEMINI_API_KEY") ||
    getEnvValue("GOOGLE_API_KEY") ||
    getEnvValue("GOOGLE_GENERATIVE_AI_API_KEY") ||
    getApiKey("google") ||
    getApiKey("gemini") ||
    null
  )
}

export function resolveOpenAIApiKey(): string | null {
  return getEnvValue("OPENAI_API_KEY") || getApiKey("openai") || null
}

export function providerHasKey(provider: EmbeddingProviderId): boolean {
  return provider === "openai"
    ? resolveOpenAIApiKey() !== null
    : resolveGoogleApiKey() !== null
}

// ---------------------------------------------------------------------------
// Circuit breaker — stop hammering a failing API on the per-turn hot path
// ---------------------------------------------------------------------------

const FAILURE_THRESHOLD = 3
const COOLDOWN_MS = 5 * 60_000

let consecutiveFailures = 0
let cooldownUntil = 0

function recordSuccess(): void {
  consecutiveFailures = 0
  cooldownUntil = 0
}

function recordFailure(): void {
  consecutiveFailures += 1
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    cooldownUntil = Date.now() + COOLDOWN_MS
    consecutiveFailures = 0
  }
}

/** True only when the ACTIVE provider has a key and the breaker is not cooling down. */
export function embeddingsAvailable(): boolean {
  if (Date.now() < cooldownUntil) return false
  return providerHasKey(getEmbeddingProvider())
}

// ---------------------------------------------------------------------------
// Vector math
// ---------------------------------------------------------------------------

function normalize(vector: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < vector.length; i++) vector[i] /= norm
  }
  return vector
}

// ---------------------------------------------------------------------------
// Google / Gemini
// ---------------------------------------------------------------------------

let googleClient: GoogleGenAI | null = null
let googleClientKey: string | null = null

function getGoogleClient(): GoogleGenAI | null {
  const key = resolveGoogleApiKey()
  if (!key) return null
  if (!googleClient || googleClientKey !== key) {
    googleClient = new GoogleGenAI({ apiKey: key })
    googleClientKey = key
  }
  return googleClient
}

interface GoogleEmbeddingResponse {
  embeddings?: Array<{ values?: number[] }>
}

async function embedBatchGoogle(
  texts: string[],
  model: string,
  dim: number
): Promise<Float32Array[] | null> {
  const ai = getGoogleClient()
  if (!ai) return null
  try {
    const res = (await ai.models.embedContent({
      model,
      contents: texts.map((t) => ({ parts: [{ text: t }] })),
      config: { outputDimensionality: dim },
    })) as GoogleEmbeddingResponse
    const embeddings = res?.embeddings
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      recordFailure()
      return null
    }
    const out: Float32Array[] = []
    for (const e of embeddings) {
      const values = e?.values
      if (!Array.isArray(values) || values.length !== dim) {
        recordFailure()
        return null
      }
      out.push(normalize(Float32Array.from(values)))
    }
    recordSuccess()
    return out
  } catch {
    recordFailure()
    return null
  }
}

// gemini-embedding-2 dropped the task_type field; the documented replacement is
// a task instruction embedded in the content (asymmetric retrieval).
function googleQueryText(query: string): string {
  return `task: search result | query: ${query}`
}

function googleDocText(title: string, text: string): string {
  return `title: ${title || "none"} | text: ${text}`
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

interface OpenAIEmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>
}

async function embedBatchOpenAI(
  texts: string[],
  model: string,
  dim: number
): Promise<Float32Array[] | null> {
  const key = resolveOpenAIApiKey()
  if (!key) return null
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: texts, dimensions: dim }),
    })
    if (!res.ok) {
      recordFailure()
      return null
    }
    const json = (await res.json()) as OpenAIEmbeddingResponse
    const data = json?.data
    if (!Array.isArray(data) || data.length !== texts.length) {
      recordFailure()
      return null
    }
    // Reassemble in input order (the API returns an `index` per item).
    const out: Float32Array[] = new Array(texts.length)
    for (let i = 0; i < data.length; i++) {
      const item = data[i]
      const idx = typeof item?.index === "number" ? item.index : i
      const values = item?.embedding
      if (!Array.isArray(values) || values.length !== dim || idx < 0 || idx >= texts.length) {
        recordFailure()
        return null
      }
      out[idx] = normalize(Float32Array.from(values))
    }
    if (out.some((v) => !v)) {
      recordFailure()
      return null
    }
    recordSuccess()
    return out
  } catch {
    recordFailure()
    return null
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function embedBatch(
  provider: EmbeddingProviderId,
  texts: string[],
  model: string,
  dim: number
): Promise<Float32Array[] | null> {
  return provider === "openai"
    ? embedBatchOpenAI(texts, model, dim)
    : embedBatchGoogle(texts, model, dim)
}

// ---------------------------------------------------------------------------
// Public API — all fail-open (null on any problem)
// ---------------------------------------------------------------------------

/** Embed many documents. Returns null if ANY batch fails (caller retries later). */
export async function embedDocuments(
  docs: Array<{ title: string; text: string }>
): Promise<Float32Array[] | null> {
  if (docs.length === 0) return []
  if (!embeddingsAvailable()) return null
  const { provider, model, dim } = getMemoryEmbeddingSettings()
  const out: Float32Array[] = []
  for (let i = 0; i < docs.length; i += EMBED_BATCH_SIZE) {
    const slice = docs.slice(i, i + EMBED_BATCH_SIZE)
    const texts = slice.map((d) =>
      provider === "openai"
        ? `${d.title ? d.title + ": " : ""}${d.text}`
        : googleDocText(d.title, d.text)
    )
    const vectors = await embedBatch(provider, texts, model, dim)
    if (!vectors) return null
    out.push(...vectors)
  }
  return out
}

/** Embed a single search query. Returns null on any failure. */
export async function embedQuery(query: string): Promise<Float32Array | null> {
  const q = query.trim()
  if (!q) return null
  if (!embeddingsAvailable()) return null
  const { provider, model, dim } = getMemoryEmbeddingSettings()
  const text = provider === "openai" ? q : googleQueryText(q)
  const vectors = await embedBatch(provider, [text], model, dim)
  return vectors?.[0] ?? null
}

/**
 * Embed several search queries in ONE batched call (same query-side treatment as
 * embedQuery). Caller must pass non-empty, trimmed strings; the returned array is
 * positionally aligned with the input. Returns null on any failure (fail-open).
 */
export async function embedQueries(
  queries: string[]
): Promise<Float32Array[] | null> {
  if (queries.length === 0) return []
  if (!embeddingsAvailable()) return null
  const { provider, model, dim } = getMemoryEmbeddingSettings()
  const texts = queries.map((q) => (provider === "openai" ? q : googleQueryText(q)))
  const out: Float32Array[] = []
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const vectors = await embedBatch(provider, texts.slice(i, i + EMBED_BATCH_SIZE), model, dim)
    if (!vectors) return null
    out.push(...vectors)
  }
  return out
}

// ---------------------------------------------------------------------------
// Multimodal (images / PDFs) — Gemini only. OpenAI embeddings are text-only.
// ---------------------------------------------------------------------------

/** True when the active model can embed images/PDFs (cross-modal search). */
export function isActiveModelMultimodal(): boolean {
  const { provider, model } = getMemoryEmbeddingSettings()
  return provider === "google" && model === "gemini-embedding-2"
}

/**
 * Embed a binary asset (image/PDF) into the SAME vector space as text queries,
 * so a text query can retrieve images. Gemini-only; returns null otherwise or
 * on any failure (fail-open).
 */
export async function embedAsset(
  data: Buffer,
  mimeType: string
): Promise<Float32Array | null> {
  if (!embeddingsAvailable() || !isActiveModelMultimodal()) return null
  const ai = getGoogleClient()
  if (!ai) return null
  const { model, dim } = getMemoryEmbeddingSettings()
  try {
    const res = (await ai.models.embedContent({
      model,
      contents: [
        { parts: [{ inlineData: { mimeType, data: data.toString("base64") } }] },
      ],
      config: { outputDimensionality: dim },
    })) as GoogleEmbeddingResponse
    const values = res?.embeddings?.[0]?.values
    if (!Array.isArray(values) || values.length !== dim) {
      recordFailure()
      return null
    }
    recordSuccess()
    return normalize(Float32Array.from(values))
  } catch {
    recordFailure()
    return null
  }
}
