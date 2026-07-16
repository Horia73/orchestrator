import { z } from 'zod'

// ---------------------------------------------------------------------------
// Request log — one row per chat request to /api/chat.
// Lives in SQLite (table `request_logs`). Append-only from the chat route;
// the UI reads via lib/observability/store.ts.
// ---------------------------------------------------------------------------

export const RequestStatusSchema = z.enum(['streaming', 'ok', 'error', 'aborted'])
export type RequestStatus = z.infer<typeof RequestStatusSchema>

export const ModalityTokensSchema = z.object({
    modality: z.enum(['text', 'image', 'audio', 'video']),
    tokens: z.number().int().nonnegative(),
})
export type ModalityTokens = z.infer<typeof ModalityTokensSchema>

export const ModalityBreakdownSchema = z.object({
    input: z.array(ModalityTokensSchema).optional(),
    output: z.array(ModalityTokensSchema).optional(),
    cached: z.array(ModalityTokensSchema).optional(),
    toolUse: z.array(ModalityTokensSchema).optional(),
})
export type ModalityBreakdown = z.infer<typeof ModalityBreakdownSchema>

export interface BillingUsageEntry {
    provider: string
    model: string
    requests: number
    inputTokens: number
    outputTokens: number
    thinkingTokens: number
    cachedTokens: number
    toolUseTokens: number
    totalTokens: number
    /** Metered API equivalent for subscription-covered usage (real billed cost stays $0). */
    apiEquivalentCostUsd?: number
    costSource?: 'provider-estimate' | 'api-pricing'
    costAccuracy?: 'provider' | 'per-call' | 'aggregate'
    pricingSource?: string
    pricingAsOf?: string
}

export interface RequestLogRow {
    profileId?: string | null
    profileName?: string | null
    id: string
    conversationId: string
    agentId: string
    /** Persistent parent↔agent thread id when this row is a delegated agent run. */
    agentThreadId: string | null
    /** Parent request id when this row is a delegated sub-agent call. */
    parentRequestId: string | null
    /** Delegation depth — 0 for the user-facing call, 1 or 2 for sub-agents. */
    depth: number
    provider: string
    model: string
    thinkingLevel: string
    status: RequestStatus
    startedAt: number
    endedAt: number | null
    durationMs: number | null
    thinkingMs: number | null
    inputTokens: number | null
    outputTokens: number | null
    thinkingTokens: number | null
    cachedTokens: number | null
    toolUseTokens: number | null
    totalTokens: number | null
    modalityBreakdown: ModalityBreakdown | null
    billingBreakdown: BillingUsageEntry[] | null
    toolCallCount: number
    interactionId: string | null
    statefulMode: boolean
    errorMessage: string | null
    /** Prompt (or last-user-message) sent to the provider. Truncated if huge. */
    inputText: string | null
    /** Final assistant content accumulated from the stream. Truncated if huge. */
    outputText: string | null
}

/** Cap each text column so a giant prompt can't blow up the DB or the UI. */
export const LOG_TEXT_MAX_CHARS = 64_000

/** Cap the serialized per-request reasoning+segments JSON. Tool results can be
 *  large even after per-entry sanitization, so bound the whole blob — if it
 *  exceeds this, we skip persisting it rather than store a giant/partial row. */
export const LOG_REASONING_MAX_CHARS = 200_000
export const LOG_TOOL_DETAIL_MAX_CHARS = 160_000

/** Cap each captured full-input field (system prompt, the resolved-messages
 *  JSON). Big enough to hold a real system prompt + recent history, bounded so
 *  the per-request input snapshot can't run away on the DB. */
export const LOG_INPUT_MAX_CHARS = 512_000

/** One resolved message exactly as sent to the provider — content has the
 *  injected memories / runtime / attachment context already inlined. */
export interface RequestLogInputMessage {
    role: string
    content: string
    /** Native file attachments handed to the provider (descriptor only). */
    attachments?: Array<{ filePath?: string; mimeType?: string }>
}

/** The full input the model received for a request: the exact system prompt,
 *  the resolved messages, and the tool/builtin names exposed for the turn. */
export interface RequestLogInput {
    systemPrompt: string | null
    messages: RequestLogInputMessage[]
    tools: string[]
}

export interface ToolLogRow {
    id: number
    requestId: string
    toolCallId?: string | null
    toolName: string
    title?: string | null
    phase?: number | null
    args?: Record<string, unknown> | null
    resultText?: string | null
    deltas?: import("@/lib/types").ToolStreamDelta[] | null
    success: boolean
    startedAt: number
    durationMs: number | null
    errorMessage: string | null
}

// ---------------------------------------------------------------------------
// API request types
// ---------------------------------------------------------------------------

export const LogsQuerySchema = z.object({
    cursor: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    range: z.enum(['1h', '24h', '7d', '30d', 'all']).default('all'),
    status: RequestStatusSchema.optional(),
    agent: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    q: z.string().optional(),
})
export type LogsQuery = z.infer<typeof LogsQuerySchema>

export const UsageRangeSchema = z.enum(['24h', '7d', '30d', '90d', 'all'])
export type UsageRange = z.infer<typeof UsageRangeSchema>

export const UsageQuerySchema = z.object({
    range: UsageRangeSchema.default('30d'),
})
export type UsageQuery = z.infer<typeof UsageQuerySchema>

// ---------------------------------------------------------------------------
// Aggregate response types (returned by /api/usage)
// ---------------------------------------------------------------------------

export interface UsageTotals {
    requests: number
    errors: number
    aborted: number
    inputTokens: number
    outputTokens: number
    thinkingTokens: number
    cachedTokens: number
    toolUseTokens: number
    totalTokens: number
    estimatedCostUsd: number
    /**
     * Metered-equivalent USD for subscription-covered usage — what the user
     * would have paid on à-la-carte API pricing. 0 when no subscription model
     * carries documented equivalent rates. NOT added to estimatedCostUsd.
     */
    subscriptionNotionalUsd: number
    /** Number of requests whose model has unknown pricing (cost contribution = 0). */
    uncostedRequests: number
    /** Number of requests on subscription-priced models (cost contribution = 0). */
    subscriptionRequests: number
}

export interface UsageDaily {
    /** ISO date YYYY-MM-DD (local time). */
    date: string
    requests: number
    inputTokens: number
    outputTokens: number
    thinkingTokens: number
    cachedTokens: number
    estimatedCostUsd: number
    subscriptionNotionalUsd: number
}

export interface UsageByModel {
    provider: string
    model: string
    displayName: string
    requests: number
    errors: number
    inputTokens: number
    outputTokens: number
    thinkingTokens: number
    cachedTokens: number
    estimatedCostUsd: number
    /**
     * Metered-equivalent USD this model would cost on à-la-carte API pricing.
     * Equals estimatedCostUsd for priced models; for subscription models it's
     * the notional cost the plan covered (0 when no equivalent rates are known).
     */
    notionalUsd: number
    avgThinkingMs: number
    lastUsedAt: number
    pricingState: 'priced' | 'subscription' | 'unknown'
    costSource: 'provider-estimate' | 'api-pricing' | 'mixed' | null
    costAccuracy: 'provider' | 'per-call' | 'aggregate' | 'mixed' | null
    pricingSource: string | null
    pricingAsOf: string | null
}

export interface UsageByAgent {
    agentId: string
    requests: number
    errors: number
    inputTokens: number
    outputTokens: number
    thinkingTokens: number
    estimatedCostUsd: number
    subscriptionNotionalUsd: number
}

export interface UsageByTool {
    toolName: string
    calls: number
    failures: number
    avgDurationMs: number | null
}

export interface UsageReport {
    range: UsageRange
    rangeStart: number
    rangeEnd: number
    totals: UsageTotals
    /** Same totals, computed for the same-length window immediately preceding rangeStart. */
    previousTotals: UsageTotals | null
    daily: UsageDaily[]
    byModel: UsageByModel[]
    byAgent: UsageByAgent[]
    byTool: UsageByTool[]
}
