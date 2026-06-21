import type { BillingUsageEntry, ModalityBreakdown, ModalityTokens } from './schema'

// ---------------------------------------------------------------------------
// Provider-agnostic usage shape persisted in `request_logs`.
// Each provider has its own raw shape (Gemini's `Usage`, Anthropic's `usage`,
// OpenAI's `usage`), so we map every flavour into `NormalizedUsage` here.
// ---------------------------------------------------------------------------

export interface NormalizedUsage {
    inputTokens: number | null
    outputTokens: number | null
    thinkingTokens: number | null
    cachedTokens: number | null
    toolUseTokens: number | null
    totalTokens: number | null
    modalityBreakdown: ModalityBreakdown | null
    billingBreakdown: BillingUsageEntry[] | null
}

const EMPTY: NormalizedUsage = {
    inputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    cachedTokens: null,
    toolUseTokens: null,
    totalTokens: null,
    modalityBreakdown: null,
    billingBreakdown: null,
}

/**
 * Map provider-specific usage payload to normalized shape.
 *
 * `provider` is the providerId (e.g. "google", "anthropic", "openai"). When
 * we add new providers, extend this with a new `case` rather than guessing
 * field names — providers diverge enough that explicit mapping is safer than
 * heuristics.
 */
export function normalizeUsage(provider: string, raw: unknown): NormalizedUsage {
    if (!raw || typeof raw !== 'object') return EMPTY
    switch (provider) {
        case 'google':
            return mapGemini(raw as Record<string, unknown>)
        case 'anthropic':
        case 'claude-code':
            return mapAnthropic(raw as Record<string, unknown>)
        case 'openai':
            return mapOpenAI(raw as Record<string, unknown>)
        case 'codex':
            return mapCodex(raw as Record<string, unknown>)
        case 'browser':
            return mapBrowser(raw as Record<string, unknown>)
        default:
            return mapGeneric(raw as Record<string, unknown>)
    }
}

interface OpenAIUsage {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
}

function mapOpenAI(raw: Record<string, unknown>): NormalizedUsage {
    const u = raw as OpenAIUsage
    return {
        inputTokens: numOrNull(u.input_tokens),
        outputTokens: numOrNull(u.output_tokens),
        thinkingTokens: numOrNull(u.output_tokens_details?.reasoning_tokens),
        cachedTokens: numOrNull(u.input_tokens_details?.cached_tokens),
        toolUseTokens: null,
        totalTokens: numOrNull(u.total_tokens),
        modalityBreakdown: null,
        billingBreakdown: null,
    }
}

interface AnthropicUsage {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
}

/**
 * Anthropic / Claude Code usage envelope. Their `input_tokens` excludes cache
 * creation/read tokens, but the rest of the observability layer treats
 * `cachedTokens` as a subset of `inputTokens` (matching OpenAI/Gemini). Normalize
 * to that invariant here so charts can subtract cached input safely.
 */
function mapAnthropic(raw: Record<string, unknown>): NormalizedUsage {
    const u = raw as AnthropicUsage
    const rawInput = numOrNull(u.input_tokens)
    const output = numOrNull(u.output_tokens)
    const cacheRead = numOrNull(u.cache_read_input_tokens)
    const cacheCreate = numOrNull(u.cache_creation_input_tokens)
    const cached = cacheRead !== null || cacheCreate !== null
        ? (cacheRead ?? 0) + (cacheCreate ?? 0)
        : null
    const input = rawInput !== null || cached !== null
        ? (rawInput ?? 0) + (cached ?? 0)
        : null
    const total = [input, output].reduce<number | null>((acc, v) => {
        if (v === null) return acc
        return (acc ?? 0) + v
    }, null)
    return {
        inputTokens: input,
        outputTokens: output,
        thinkingTokens: null,
        cachedTokens: cached,
        toolUseTokens: null,
        totalTokens: total,
        modalityBreakdown: null,
        billingBreakdown: null,
    }
}

// ---------------------------------------------------------------------------
// Gemini Interactions API — `Usage` shape (snake_case from the wire format).
// See node_modules/@google/genai/dist/genai.d.ts → interface Usage.
// ---------------------------------------------------------------------------

interface GeminiModalityEntry {
    modality?: string
    tokens?: number
}

interface GeminiUsage {
    total_input_tokens?: number
    total_output_tokens?: number
    total_thought_tokens?: number
    total_cached_tokens?: number
    total_tool_use_tokens?: number
    total_tokens?: number
    input_tokens_by_modality?: GeminiModalityEntry[]
    output_tokens_by_modality?: GeminiModalityEntry[]
    cached_tokens_by_modality?: GeminiModalityEntry[]
    tool_use_tokens_by_modality?: GeminiModalityEntry[]
}

function mapGemini(raw: Record<string, unknown>): NormalizedUsage {
    const u = raw as GeminiUsage
    const breakdown: ModalityBreakdown = {}
    const input = mapModality(u.input_tokens_by_modality)
    const output = mapModality(u.output_tokens_by_modality)
    const cached = mapModality(u.cached_tokens_by_modality)
    const toolUse = mapModality(u.tool_use_tokens_by_modality)
    if (input) breakdown.input = input
    if (output) breakdown.output = output
    if (cached) breakdown.cached = cached
    if (toolUse) breakdown.toolUse = toolUse

    return {
        inputTokens: numOrNull(u.total_input_tokens),
        outputTokens: numOrNull(u.total_output_tokens),
        thinkingTokens: numOrNull(u.total_thought_tokens),
        cachedTokens: numOrNull(u.total_cached_tokens),
        toolUseTokens: numOrNull(u.total_tool_use_tokens),
        totalTokens: numOrNull(u.total_tokens),
        modalityBreakdown: hasAny(breakdown) ? breakdown : null,
        billingBreakdown: null,
    }
}

function mapCodex(raw: Record<string, unknown>): NormalizedUsage {
    return {
        inputTokens: pickFirst(raw, ['inputTokens', 'input_tokens']),
        outputTokens: pickFirst(raw, ['outputTokens', 'output_tokens']),
        thinkingTokens: pickFirst(raw, ['reasoningOutputTokens', 'reasoning_output_tokens']),
        cachedTokens: pickFirst(raw, ['cachedInputTokens', 'cached_input_tokens']),
        toolUseTokens: null,
        totalTokens: pickFirst(raw, ['totalTokens', 'total_tokens']),
        modalityBreakdown: null,
        billingBreakdown: null,
    }
}

interface BrowserUsageTotals {
    promptTokens?: number
    outputTokens?: number
    thoughtsTokens?: number
    cachedTokens?: number
    toolUseTokens?: number
    totalTokens?: number
    requests?: number
}

interface BrowserTaskUsage {
    model?: string
    totals?: BrowserUsageTotals
    byModel?: Record<string, BrowserUsageTotals>
}

function mapBrowser(raw: Record<string, unknown>): NormalizedUsage {
    const task = raw as BrowserTaskUsage
    const totals = isBrowserUsageTotals(task.totals)
        ? task.totals
        : isBrowserUsageTotals(raw)
            ? raw as BrowserUsageTotals
            : null
    if (!totals) return mapGeneric(raw)

    return {
        inputTokens: numOrNull(totals.promptTokens),
        outputTokens: numOrNull(totals.outputTokens),
        thinkingTokens: numOrNull(totals.thoughtsTokens),
        cachedTokens: numOrNull(totals.cachedTokens),
        toolUseTokens: numOrNull(totals.toolUseTokens),
        totalTokens: numOrNull(totals.totalTokens),
        modalityBreakdown: null,
        billingBreakdown: buildBrowserBillingBreakdown(task, totals),
    }
}

function isBrowserUsageTotals(value: unknown): value is BrowserUsageTotals {
    if (!value || typeof value !== 'object') return false
    const raw = value as Record<string, unknown>
    return ['promptTokens', 'outputTokens', 'thoughtsTokens', 'totalTokens', 'requests']
        .some(key => typeof raw[key] === 'number' && Number.isFinite(raw[key]))
}

function buildBrowserBillingBreakdown(
    task: BrowserTaskUsage,
    fallbackTotals: BrowserUsageTotals
): BillingUsageEntry[] | null {
    const entries: BillingUsageEntry[] = []
    if (task.byModel && typeof task.byModel === 'object') {
        for (const [model, totals] of Object.entries(task.byModel)) {
            const entry = browserBillingEntry(model, totals)
            if (entry) entries.push(entry)
        }
    }
    if (entries.length > 0) return entries

    const model = typeof task.model === 'string' ? task.model : ''
    const fallback = browserBillingEntry(model, fallbackTotals)
    return fallback ? [fallback] : null
}

function browserBillingEntry(model: string, totals: BrowserUsageTotals): BillingUsageEntry | null {
    const cleanModel = model.trim()
    if (!cleanModel || !isBrowserUsageTotals(totals)) return null
    return {
        provider: 'google',
        model: cleanModel,
        requests: nonNegativeInteger(totals.requests, 1),
        inputTokens: nonNegativeInteger(totals.promptTokens, 0),
        outputTokens: nonNegativeInteger(totals.outputTokens, 0),
        thinkingTokens: nonNegativeInteger(totals.thoughtsTokens, 0),
        cachedTokens: nonNegativeInteger(totals.cachedTokens, 0),
        toolUseTokens: nonNegativeInteger(totals.toolUseTokens, 0),
        totalTokens: nonNegativeInteger(totals.totalTokens, 0),
    }
}

// ---------------------------------------------------------------------------
// Generic / unknown provider — best-effort field probing. Used only as a
// fallback so we don't lose data entirely from a provider we forgot to map.
// ---------------------------------------------------------------------------

function mapGeneric(raw: Record<string, unknown>): NormalizedUsage {
    return {
        inputTokens: pickFirst(raw, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'total_input_tokens']),
        outputTokens: pickFirst(raw, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'total_output_tokens']),
        thinkingTokens: pickFirst(raw, ['thinkingTokens', 'thinking_tokens', 'thoughtsTokenCount', 'total_thought_tokens']),
        cachedTokens: pickFirst(raw, ['cachedTokens', 'cached_tokens', 'cachedContentTokenCount', 'total_cached_tokens']),
        toolUseTokens: pickFirst(raw, ['toolUseTokens', 'tool_use_tokens', 'total_tool_use_tokens']),
        totalTokens: pickFirst(raw, ['totalTokens', 'total_tokens', 'totalTokenCount']),
        modalityBreakdown: null,
        billingBreakdown: null,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function numOrNull(v: unknown): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    if (v < 0) return null
    return v
}

function pickFirst(raw: Record<string, unknown>, keys: string[]): number | null {
    for (const k of keys) {
        const v = raw[k]
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
    }
    return null
}

function nonNegativeInteger(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
    return Math.floor(value)
}

function mapModality(entries: GeminiModalityEntry[] | undefined): ModalityTokens[] | null {
    if (!Array.isArray(entries) || entries.length === 0) return null
    const out: ModalityTokens[] = []
    for (const e of entries) {
        const modality = normalizeModality(e?.modality)
        const tokens = numOrNull(e?.tokens)
        if (!modality || tokens === null) continue
        out.push({ modality, tokens })
    }
    return out.length > 0 ? out : null
}

function normalizeModality(m: string | undefined): ModalityTokens['modality'] | null {
    if (!m) return null
    const lower = m.toLowerCase()
    if (lower === 'text') return 'text'
    if (lower === 'image') return 'image'
    if (lower === 'audio') return 'audio'
    if (lower === 'video') return 'video'
    return null
}

function hasAny(b: ModalityBreakdown): boolean {
    return Boolean(b.input || b.output || b.cached || b.toolUse)
}
