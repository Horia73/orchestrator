import db from '@/lib/db'
import { appendRuntimeRequestLogIndex } from '@/lib/runtime-index'
import { emitObservabilityEvent } from './events'
import {
    type RequestLogRow,
    type ToolLogRow,
    type RequestStatus,
    type ModalityBreakdown,
    type BillingUsageEntry,
    type LogsQuery,
    type UsageRange,
    type UsageReport,
    type UsageDaily,
    type UsageTotals,
    type UsageByModel,
    type UsageByAgent,
    type UsageByTool,
    LOG_TEXT_MAX_CHARS,
    LOG_REASONING_MAX_CHARS,
} from './schema'
import type { ContentSegment, ReasoningEntry } from '@/lib/types'
import { normalizeUsage } from './usage-mapper'
import { estimateCost, type PricingState } from './cost'
import { getEffectiveRegistry } from '@/lib/models/registry'

// ---------------------------------------------------------------------------
// Lifecycle hooks called from app/api/chat/route.ts.
//
// Every write is wrapped in `safe(...)` — a logging failure never breaks the
// chat request. Reads happen only from API route handlers and are allowed to
// throw (the caller maps to a 500).
// ---------------------------------------------------------------------------

interface StartArgs {
    requestId: string
    conversationId: string
    agentId: string
    agentThreadId?: string | null
    provider: string
    model: string
    thinkingLevel: string
    statefulMode: boolean
    startedAt: number
    parentRequestId?: string | null
    depth?: number
    /** Prompt to record on the row. For the orchestrator request this is the
     *  last user message; for sub-agent rows it's the delegate_to prompt. */
    inputText?: string | null
}

const globalForObservabilityStore = globalThis as unknown as {
    __orchestratorActiveRequestLogIds?: Set<string>
    __orchestratorRequestLogBootSealDone?: boolean
}

const activeRequestLogIds =
    globalForObservabilityStore.__orchestratorActiveRequestLogIds ?? new Set<string>()

if (!globalForObservabilityStore.__orchestratorActiveRequestLogIds) {
    globalForObservabilityStore.__orchestratorActiveRequestLogIds = activeRequestLogIds
}

const processStartedAt = Date.now() - Math.round(process.uptime() * 1000)

const INTERRUPTED_STREAM_ERROR_MESSAGE =
    'Request was interrupted before completion, likely because the server process restarted.'

const insertStartStmt = db.prepare(`
    INSERT INTO request_logs (
        id, conversationId, agentId, agentThreadId, parentRequestId, depth,
        provider, model, thinkingLevel,
        status, startedAt, statefulMode, toolCallCount, inputText
    ) VALUES (
        @id, @conversationId, @agentId, @agentThreadId, @parentRequestId, @depth,
        @provider, @model, @thinkingLevel,
        'streaming', @startedAt, @statefulMode, 0, @inputText
    )
    ON CONFLICT(id) DO UPDATE SET
        conversationId = excluded.conversationId,
        agentId = excluded.agentId,
        agentThreadId = excluded.agentThreadId,
        parentRequestId = excluded.parentRequestId,
        depth = excluded.depth,
        provider = excluded.provider,
        model = excluded.model,
        thinkingLevel = excluded.thinkingLevel,
        status = 'streaming',
        startedAt = excluded.startedAt,
        statefulMode = excluded.statefulMode,
        inputText = excluded.inputText
`)

export function logRequestStart(args: StartArgs): void {
    safe(() => {
        insertStartStmt.run({
            id: args.requestId,
            conversationId: args.conversationId,
            agentId: args.agentId,
            agentThreadId: args.agentThreadId ?? null,
            parentRequestId: args.parentRequestId ?? null,
            depth: args.depth ?? 0,
            provider: args.provider,
            model: args.model,
            thinkingLevel: args.thinkingLevel,
            startedAt: args.startedAt,
            statefulMode: args.statefulMode ? 1 : 0,
            inputText: truncate(args.inputText),
        })
        activeRequestLogIds.add(args.requestId)
        emitObservabilityEvent({ type: 'request_started', requestId: args.requestId })
    })
}

function truncate(s: string | null | undefined): string | null {
    if (s == null) return null
    if (s.length <= LOG_TEXT_MAX_CHARS) return s
    // Suffix marker so a UI rendering this knows it was cut.
    return s.slice(0, LOG_TEXT_MAX_CHARS) + `\n…[truncated, original was ${s.length} chars]`
}

// Heavy transcript reasoning lives in its own row so the Logs list query never
// has to read it. The interleaved reasoning is what lets the Logs detail render
// a background/scheduled run exactly like the main chat instead of collapsing
// to a flat text-only view.
export interface LogReasoningExtra {
    reasoning?: ReasoningEntry[] | null
    contentSegments?: ContentSegment[] | null
}

const upsertReasoningStmt = db.prepare(`
    INSERT INTO request_log_reasoning (requestId, reasoning, contentSegments)
    VALUES (@requestId, @reasoning, @contentSegments)
    ON CONFLICT(requestId) DO UPDATE SET
        reasoning = COALESCE(excluded.reasoning, request_log_reasoning.reasoning),
        contentSegments = COALESCE(excluded.contentSegments, request_log_reasoning.contentSegments)
`)

/** Serialize a reasoning/segments array, or null when empty, unserializable, or
 *  over the size cap — never a partial/corrupt string. */
function serializeBoundedJson(value: unknown): string | null {
    if (!Array.isArray(value) || value.length === 0) return null
    try {
        const json = JSON.stringify(value)
        if (json.length > LOG_REASONING_MAX_CHARS) return null
        return json
    } catch {
        return null
    }
}

/** Persist (or merge) the per-request interleaved transcript. No-op when there
 *  is nothing useful to store, so a reasoning-less run leaves no row. */
function persistRequestReasoning(requestId: string, extra?: LogReasoningExtra): void {
    if (!extra) return
    const reasoning = serializeBoundedJson(extra.reasoning)
    const contentSegments = serializeBoundedJson(extra.contentSegments)
    if (reasoning === null && contentSegments === null) return
    upsertReasoningStmt.run({ requestId, reasoning, contentSegments })
}

const incToolCountStmt = db.prepare(`UPDATE request_logs SET toolCallCount = toolCallCount + 1 WHERE id = ?`)
const insertToolStmt = db.prepare(`
    INSERT INTO tool_logs (requestId, toolName, success, startedAt, durationMs, errorMessage)
    VALUES (@requestId, @toolName, @success, @startedAt, @durationMs, @errorMessage)
`)

interface ToolArgs {
    requestId: string
    toolName: string
    success: boolean
    startedAt: number
    durationMs?: number | null
    errorMessage?: string | null
}

export function logToolCall(args: ToolArgs): void {
    safe(() => {
        insertToolStmt.run({
            requestId: args.requestId,
            toolName: args.toolName,
            success: args.success ? 1 : 0,
            startedAt: args.startedAt,
            durationMs: args.durationMs ?? null,
            errorMessage: args.errorMessage ?? null,
        })
        incToolCountStmt.run(args.requestId)
    })
}

interface CompleteArgs {
    requestId: string
    endedAt: number
    thinkingMs?: number | null
    interactionId?: string | null
    /** Provider-raw usage object — normalized inside this function. */
    usage?: unknown
    provider: string
    /** Final assistant content. Saved truncated to LOG_TEXT_MAX_CHARS. */
    outputText?: string | null
    /** Interleaved thinking + tool_call reasoning, sanitized by the caller. */
    reasoning?: ReasoningEntry[] | null
    /** Content segments aligned with the reasoning phases. */
    contentSegments?: ContentSegment[] | null
}

const updateCompleteStmt = db.prepare(`
    UPDATE request_logs SET
        status = 'ok',
        endedAt = @endedAt,
        durationMs = @durationMs,
        thinkingMs = @thinkingMs,
        inputTokens = @inputTokens,
        outputTokens = @outputTokens,
        thinkingTokens = @thinkingTokens,
        cachedTokens = @cachedTokens,
        toolUseTokens = @toolUseTokens,
        totalTokens = @totalTokens,
        modalityBreakdown = @modalityBreakdown,
        billingBreakdown = @billingBreakdown,
        interactionId = @interactionId,
        errorMessage = NULL,
        outputText = COALESCE(@outputText, outputText)
    WHERE id = @id
`)

export function logRequestComplete(args: CompleteArgs): void {
    safe(() => {
        const usage = normalizeUsage(args.provider, args.usage)
        const startedAtRow = db
            .prepare(`SELECT startedAt FROM request_logs WHERE id = ?`)
            .get(args.requestId) as { startedAt: number } | undefined
        const durationMs = startedAtRow ? args.endedAt - startedAtRow.startedAt : null

        updateCompleteStmt.run({
            id: args.requestId,
            endedAt: args.endedAt,
            durationMs,
            thinkingMs: args.thinkingMs ?? null,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            thinkingTokens: usage.thinkingTokens,
            cachedTokens: usage.cachedTokens,
            toolUseTokens: usage.toolUseTokens,
            totalTokens: usage.totalTokens,
            modalityBreakdown: usage.modalityBreakdown ? JSON.stringify(usage.modalityBreakdown) : null,
            billingBreakdown: usage.billingBreakdown ? JSON.stringify(usage.billingBreakdown) : null,
            interactionId: args.interactionId ?? null,
            outputText: truncate(args.outputText),
        })
        persistRequestReasoning(args.requestId, {
            reasoning: args.reasoning,
            contentSegments: args.contentSegments,
        })
        indexRequestLog(args.requestId)
        emitObservabilityEvent({ type: 'request_completed', requestId: args.requestId })
    })
    activeRequestLogIds.delete(args.requestId)
}

const updateFailStmt = db.prepare(`
    UPDATE request_logs SET
        status = @status,
        endedAt = @endedAt,
        durationMs = @durationMs,
        errorMessage = @errorMessage,
        outputText = COALESCE(@outputText, outputText)
    WHERE id = @id
`)

export function logRequestFail(requestId: string, errorMessage: string, endedAt: number, outputText?: string | null, extra?: LogReasoningExtra): void {
    safe(() => {
        const startedAtRow = db
            .prepare(`SELECT startedAt FROM request_logs WHERE id = ?`)
            .get(requestId) as { startedAt: number } | undefined
        updateFailStmt.run({
            id: requestId,
            status: 'error',
            endedAt,
            durationMs: startedAtRow ? endedAt - startedAtRow.startedAt : null,
            errorMessage,
            outputText: truncate(outputText),
        })
        persistRequestReasoning(requestId, extra)
        indexRequestLog(requestId)
        emitObservabilityEvent({ type: 'request_completed', requestId })
    })
    activeRequestLogIds.delete(requestId)
}

export function logRequestAbort(requestId: string, endedAt: number, outputText?: string | null, extra?: LogReasoningExtra): void {
    safe(() => {
        const startedAtRow = db
            .prepare(`SELECT startedAt FROM request_logs WHERE id = ?`)
            .get(requestId) as { startedAt: number } | undefined
        updateFailStmt.run({
            id: requestId,
            status: 'aborted',
            endedAt,
            durationMs: startedAtRow ? endedAt - startedAtRow.startedAt : null,
            errorMessage: null,
            outputText: truncate(outputText),
        })
        persistRequestReasoning(requestId, extra)
        indexRequestLog(requestId)
        emitObservabilityEvent({ type: 'request_completed', requestId })
    })
    activeRequestLogIds.delete(requestId)
}

const selectStreamingRequestsStmt = db.prepare(`
    SELECT id, startedAt FROM request_logs WHERE status = 'streaming'
`)

const sealStreamingRequestStmt = db.prepare(`
    UPDATE request_logs SET
        status = 'aborted',
        endedAt = @endedAt,
        durationMs = @durationMs,
        errorMessage = COALESCE(errorMessage, @errorMessage)
    WHERE id = @id AND status = 'streaming'
`)

export function sealInterruptedStreamingRequestLogs(options?: {
    now?: number
    activeRequestIds?: ReadonlySet<string>
    startedBefore?: number | null
}): number {
    const now = options?.now ?? Date.now()
    const activeIds = options?.activeRequestIds ?? activeRequestLogIds
    const startedBefore = options?.startedBefore ?? processStartedAt
    const sealedIds: string[] = []

    try {
        const tx = db.transaction(() => {
            const rows = selectStreamingRequestsStmt.all() as Array<{ id: string; startedAt: number }>
            for (const row of rows) {
                if (activeIds.has(row.id)) continue
                if (startedBefore !== null && row.startedAt >= startedBefore) continue
                const durationMs = Math.max(0, now - row.startedAt)
                const result = sealStreamingRequestStmt.run({
                    id: row.id,
                    endedAt: now,
                    durationMs,
                    errorMessage: INTERRUPTED_STREAM_ERROR_MESSAGE,
                })
                if (result.changes > 0) {
                    sealedIds.push(row.id)
                    activeRequestLogIds.delete(row.id)
                }
            }
        })
        tx()
    } catch (err) {
        console.error('[observability] failed to seal interrupted streams:', err)
        return 0
    }

    for (const requestId of sealedIds) {
        indexRequestLog(requestId)
        emitObservabilityEvent({ type: 'request_completed', requestId })
    }

    return sealedIds.length
}

if (!globalForObservabilityStore.__orchestratorRequestLogBootSealDone) {
    globalForObservabilityStore.__orchestratorRequestLogBootSealDone = true
    sealInterruptedStreamingRequestLogs()
}

function indexRequestLog(requestId: string): void {
    const row = getRequestLog(requestId)
    if (row) appendRuntimeRequestLogIndex(row)
}

// ---------------------------------------------------------------------------
// Reads — Logs tab
// ---------------------------------------------------------------------------

export interface LogsPage {
    rows: RequestLogRow[]
    /** Pass back as `cursor` to fetch the next page. `null` when no more rows. */
    nextCursor: number | null
    /** Total matching rows, regardless of pagination (used for the header). */
    total: number
}

const RANGE_MS: Record<NonNullable<LogsQuery['range']>, number | null> = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    'all': null,
}

export function queryLogs(q: LogsQuery): LogsPage {
    const where: string[] = []
    const params: Record<string, string | number> = {}

    const rangeMs = RANGE_MS[q.range]
    if (rangeMs !== null) {
        where.push(`startedAt >= @rangeStart`)
        params.rangeStart = Date.now() - rangeMs
    }
    if (q.status) {
        where.push(`status = @status`)
        params.status = q.status
    }
    if (q.agent) {
        where.push(`agentId = @agent`)
        params.agent = q.agent
    }
    if (q.provider) {
        where.push(`provider = @provider`)
        params.provider = q.provider
    }
    if (q.model) {
        where.push(`model = @model`)
        params.model = q.model
    }
    if (q.q) {
        where.push(`(errorMessage LIKE @q OR conversationId LIKE @q OR interactionId LIKE @q OR inputText LIKE @q OR outputText LIKE @q)`)
        params.q = `%${q.q}%`
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

    if (q.cursor !== undefined) {
        // Cursor is a startedAt value — keyset pagination on (startedAt DESC, id DESC).
        const cursorClause = where.length > 0 ? `AND startedAt < @cursor` : `WHERE startedAt < @cursor`
        params.cursor = q.cursor
        const rows = db
            .prepare(
                `SELECT * FROM request_logs ${whereSql} ${cursorClause}
                 ORDER BY startedAt DESC LIMIT @limit`
            )
            .all({ ...params, limit: q.limit }) as RawRequestLogRow[]
        const totalRow = db.prepare(`SELECT COUNT(*) as c FROM request_logs ${whereSql}`).get(params) as { c: number }
        const nextCursor = rows.length === q.limit ? rows[rows.length - 1].startedAt : null
        return { rows: rows.map(parseRequestLogRow), nextCursor, total: totalRow.c }
    }

    const rows = db
        .prepare(`SELECT * FROM request_logs ${whereSql} ORDER BY startedAt DESC LIMIT @limit`)
        .all({ ...params, limit: q.limit }) as RawRequestLogRow[]
    const totalRow = db.prepare(`SELECT COUNT(*) as c FROM request_logs ${whereSql}`).get(params) as { c: number }
    const nextCursor = rows.length === q.limit ? rows[rows.length - 1].startedAt : null
    return { rows: rows.map(parseRequestLogRow), nextCursor, total: totalRow.c }
}

export function getRequestLog(id: string): RequestLogRow | null {
    const row = db.prepare(`SELECT * FROM request_logs WHERE id = ?`).get(id) as RawRequestLogRow | undefined
    return row ? parseRequestLogRow(row) : null
}

export function getToolLogsForRequest(requestId: string): ToolLogRow[] {
    const rows = db
        .prepare(`SELECT * FROM tool_logs WHERE requestId = ? ORDER BY startedAt ASC`)
        .all(requestId) as RawToolLogRow[]
    return rows.map(parseToolLogRow)
}

export interface RequestLogReasoning {
    reasoning: ReasoningEntry[] | null
    contentSegments: ContentSegment[] | null
}

/** Heavy per-request transcript, read only when a Logs row is expanded. */
export function getRequestLogReasoning(requestId: string): RequestLogReasoning | null {
    const row = db
        .prepare(`SELECT reasoning, contentSegments FROM request_log_reasoning WHERE requestId = ?`)
        .get(requestId) as { reasoning: string | null; contentSegments: string | null } | undefined
    if (!row) return null
    const reasoning = parseJsonArray<ReasoningEntry>(row.reasoning)
    const contentSegments = parseJsonArray<ContentSegment>(row.contentSegments)
    if (!reasoning && !contentSegments) return null
    return { reasoning, contentSegments }
}

function parseJsonArray<T>(value: string | null): T[] | null {
    if (!value) return null
    try {
        const parsed = JSON.parse(value) as unknown
        return Array.isArray(parsed) && parsed.length > 0 ? (parsed as T[]) : null
    } catch {
        return null
    }
}

export function clearAllLogs(): { deletedRequests: number; deletedTools: number } {
    const tx = db.transaction(() => {
        const t = db.prepare(`DELETE FROM tool_logs`).run()
        db.prepare(`DELETE FROM request_log_reasoning`).run()
        const r = db.prepare(`DELETE FROM request_logs`).run()
        return { deletedRequests: r.changes, deletedTools: t.changes }
    })
    const result = tx()
    emitObservabilityEvent({ type: 'logs_cleared' })
    return result
}

// ---------------------------------------------------------------------------
// Reads — Usage tab (aggregates)
// ---------------------------------------------------------------------------

const USAGE_RANGE_MS: Record<UsageRange, number | null> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
    'all': null,
}

export function buildUsageReport(range: UsageRange): UsageReport {
    const now = Date.now()
    const windowMs = USAGE_RANGE_MS[range]
    const rangeStart = windowMs === null ? 0 : now - windowMs
    const rangeEnd = now

    const allRows = db
        .prepare(
            `SELECT * FROM request_logs WHERE startedAt >= ? AND startedAt <= ? ORDER BY startedAt ASC`
        )
        .all(rangeStart, rangeEnd) as RawRequestLogRow[]
    const rows = allRows.map(parseRequestLogRow)

    const totals = computeTotals(rows)

    let previousTotals: UsageTotals | null = null
    if (windowMs !== null) {
        const prevStart = rangeStart - windowMs
        const prevRows = db
            .prepare(
                `SELECT * FROM request_logs WHERE startedAt >= ? AND startedAt < ?`
            )
            .all(prevStart, rangeStart) as RawRequestLogRow[]
        previousTotals = computeTotals(prevRows.map(parseRequestLogRow))
    }

    const daily = computeDaily(rows, rangeStart, rangeEnd, windowMs)
    const byModel = computeByModel(rows)
    const byAgent = computeByAgent(rows)
    const byTool = computeByTool(rangeStart, rangeEnd)

    return {
        range,
        rangeStart,
        rangeEnd,
        totals,
        previousTotals,
        daily,
        byModel,
        byAgent,
        byTool,
    }
}

type EffectiveRegistrySnapshot = ReturnType<typeof getEffectiveRegistry>

interface RowCostSummary {
    usd: number
    hasUnknown: boolean
    hasSubscription: boolean
}

type ModelUsageEntry = BillingUsageEntry & {
    inputTokens: number
    outputTokens: number
    thinkingTokens: number
    cachedTokens: number
    toolUseTokens: number
}

function estimateRowCost(row: RequestLogRow, registry: EffectiveRegistrySnapshot): RowCostSummary {
    const entries = modelUsageEntries(row)
    let usd = 0
    let hasUnknown = false
    let hasSubscription = false

    for (const entry of entries) {
        const pricing = registry[entry.provider]?.models[entry.model]?.pricing ?? null
        const cost = estimateCost(pricing, entry)
        usd += cost.usd
        if (cost.state === 'unknown') hasUnknown = true
        if (cost.state === 'subscription') hasSubscription = true
    }

    return { usd, hasUnknown, hasSubscription }
}

function modelUsageEntries(row: RequestLogRow): ModelUsageEntry[] {
    if (row.billingBreakdown && row.billingBreakdown.length > 0) {
        return row.billingBreakdown.map(entry => normalizeBillingEntry(entry))
    }

    return [{
        provider: row.provider,
        model: row.model,
        requests: 1,
        inputTokens: row.inputTokens ?? 0,
        outputTokens: row.outputTokens ?? 0,
        thinkingTokens: row.thinkingTokens ?? 0,
        cachedTokens: row.cachedTokens ?? 0,
        toolUseTokens: row.toolUseTokens ?? 0,
        totalTokens: row.totalTokens ?? 0,
    }]
}

function normalizeBillingEntry(entry: BillingUsageEntry): ModelUsageEntry {
    return {
        provider: entry.provider,
        model: entry.model,
        requests: Math.max(1, Math.floor(entry.requests || 0)),
        inputTokens: Math.max(0, Math.floor(entry.inputTokens || 0)),
        outputTokens: Math.max(0, Math.floor(entry.outputTokens || 0)),
        thinkingTokens: Math.max(0, Math.floor(entry.thinkingTokens || 0)),
        cachedTokens: Math.max(0, Math.floor(entry.cachedTokens || 0)),
        toolUseTokens: Math.max(0, Math.floor(entry.toolUseTokens || 0)),
        totalTokens: Math.max(0, Math.floor(entry.totalTokens || 0)),
    }
}

function mergePricingState(a: PricingState, b: PricingState): PricingState {
    if (a === b) return a
    if (a === 'unknown' || b === 'unknown') return 'unknown'
    if (a === 'priced' || b === 'priced') return 'priced'
    return 'subscription'
}

function computeTotals(rows: RequestLogRow[]): UsageTotals {
    const registry = getEffectiveRegistry()
    let estimatedCostUsd = 0
    let uncostedRequests = 0
    let subscriptionRequests = 0

    let inputTokens = 0
    let outputTokens = 0
    let thinkingTokens = 0
    let cachedTokens = 0
    let toolUseTokens = 0
    let totalTokens = 0
    let errors = 0
    let aborted = 0

    for (const row of rows) {
        if (row.status === 'error') errors++
        if (row.status === 'aborted') aborted++

        inputTokens += row.inputTokens ?? 0
        outputTokens += row.outputTokens ?? 0
        thinkingTokens += row.thinkingTokens ?? 0
        cachedTokens += row.cachedTokens ?? 0
        toolUseTokens += row.toolUseTokens ?? 0
        totalTokens += row.totalTokens ?? 0

        const cost = estimateRowCost(row, registry)
        estimatedCostUsd += cost.usd
        if (cost.hasUnknown) uncostedRequests++
        if (cost.hasSubscription) subscriptionRequests++
    }

    return {
        requests: rows.length,
        errors,
        aborted,
        inputTokens,
        outputTokens,
        thinkingTokens,
        cachedTokens,
        toolUseTokens,
        totalTokens,
        estimatedCostUsd,
        uncostedRequests,
        subscriptionRequests,
    }
}

function computeDaily(
    rows: RequestLogRow[],
    rangeStart: number,
    rangeEnd: number,
    windowMs: number | null
): UsageDaily[] {
    // Local timezone bucketing — match what the user sees in the UI.
    const buckets = new Map<string, UsageDaily>()

    // Pre-seed empty days so charts don't have gaps. For 'all', start at the
    // earliest data point if any, otherwise just emit today.
    const startMs = windowMs !== null ? rangeStart : (rows[0]?.startedAt ?? rangeEnd)
    for (let cursor = startOfLocalDay(startMs); cursor <= rangeEnd; cursor += 24 * 60 * 60 * 1000) {
        const key = isoLocalDate(cursor)
        if (!buckets.has(key)) {
            buckets.set(key, {
                date: key,
                requests: 0,
                inputTokens: 0,
                outputTokens: 0,
                thinkingTokens: 0,
                cachedTokens: 0,
                estimatedCostUsd: 0,
            })
        }
    }

    const registry = getEffectiveRegistry()
    for (const row of rows) {
        const key = isoLocalDate(row.startedAt)
        const bucket = buckets.get(key) ?? {
            date: key,
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            thinkingTokens: 0,
            cachedTokens: 0,
            estimatedCostUsd: 0,
        }
        bucket.requests += 1
        bucket.inputTokens += row.inputTokens ?? 0
        bucket.outputTokens += row.outputTokens ?? 0
        bucket.thinkingTokens += row.thinkingTokens ?? 0
        bucket.cachedTokens += row.cachedTokens ?? 0
        const cost = estimateRowCost(row, registry)
        bucket.estimatedCostUsd += cost.usd
        buckets.set(key, bucket)
    }

    return [...buckets.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

function computeByModel(rows: RequestLogRow[]): UsageByModel[] {
    const registry = getEffectiveRegistry()
    const map = new Map<string, UsageByModel & { _thinkingMsSum: number; _thinkingMsCount: number }>()
    for (const row of rows) {
        for (const usage of modelUsageEntries(row)) {
            const key = `${usage.provider}:${usage.model}`
            const existing = map.get(key)
            const pricing = registry[usage.provider]?.models[usage.model]?.pricing ?? null
            const cost = estimateCost(pricing, usage)

            if (!existing) {
                map.set(key, {
                    provider: usage.provider,
                    model: usage.model,
                    displayName: registry[usage.provider]?.models[usage.model]?.name ?? usage.model,
                    requests: usage.requests,
                    errors: row.status === 'error' ? 1 : 0,
                    inputTokens: usage.inputTokens ?? 0,
                    outputTokens: usage.outputTokens ?? 0,
                    thinkingTokens: usage.thinkingTokens ?? 0,
                    cachedTokens: usage.cachedTokens ?? 0,
                    estimatedCostUsd: cost.usd,
                    avgThinkingMs: 0,
                    lastUsedAt: row.startedAt,
                    pricingState: cost.state,
                    _thinkingMsSum: row.thinkingMs ?? 0,
                    _thinkingMsCount: row.thinkingMs !== null ? 1 : 0,
                })
            } else {
                existing.requests += usage.requests
                if (row.status === 'error') existing.errors++
                existing.inputTokens += usage.inputTokens ?? 0
                existing.outputTokens += usage.outputTokens ?? 0
                existing.thinkingTokens += usage.thinkingTokens ?? 0
                existing.cachedTokens += usage.cachedTokens ?? 0
                existing.estimatedCostUsd += cost.usd
                existing.pricingState = mergePricingState(existing.pricingState, cost.state)
                existing.lastUsedAt = Math.max(existing.lastUsedAt, row.startedAt)
                if (row.thinkingMs !== null) {
                    existing._thinkingMsSum += row.thinkingMs
                    existing._thinkingMsCount++
                }
            }
        }
    }
    return [...map.values()]
        .map(({ _thinkingMsSum, _thinkingMsCount, ...rest }) => ({
            ...rest,
            avgThinkingMs: _thinkingMsCount > 0 ? Math.round(_thinkingMsSum / _thinkingMsCount) : 0,
        }))
        .sort((a, b) => b.requests - a.requests)
}

function computeByAgent(rows: RequestLogRow[]): UsageByAgent[] {
    const registry = getEffectiveRegistry()
    const map = new Map<string, UsageByAgent>()
    for (const row of rows) {
        const existing = map.get(row.agentId)
        const cost = estimateRowCost(row, registry)
        if (!existing) {
            map.set(row.agentId, {
                agentId: row.agentId,
                requests: 1,
                errors: row.status === 'error' ? 1 : 0,
                inputTokens: row.inputTokens ?? 0,
                outputTokens: row.outputTokens ?? 0,
                thinkingTokens: row.thinkingTokens ?? 0,
                estimatedCostUsd: cost.usd,
            })
        } else {
            existing.requests++
            if (row.status === 'error') existing.errors++
            existing.inputTokens += row.inputTokens ?? 0
            existing.outputTokens += row.outputTokens ?? 0
            existing.thinkingTokens += row.thinkingTokens ?? 0
            existing.estimatedCostUsd += cost.usd
        }
    }
    return [...map.values()].sort((a, b) => b.requests - a.requests)
}

function computeByTool(rangeStart: number, rangeEnd: number): UsageByTool[] {
    const rows = db
        .prepare(
            `SELECT toolName,
                    COUNT(*) as calls,
                    SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
                    AVG(durationMs) as avgDurationMs
             FROM tool_logs
             WHERE startedAt >= ? AND startedAt <= ?
             GROUP BY toolName
             ORDER BY calls DESC`
        )
        .all(rangeStart, rangeEnd) as Array<{
            toolName: string
            calls: number
            failures: number
            avgDurationMs: number | null
        }>
    return rows.map(r => ({
        toolName: r.toolName,
        calls: r.calls,
        failures: r.failures,
        avgDurationMs: r.avgDurationMs !== null ? Math.round(r.avgDurationMs) : null,
    }))
}

// ---------------------------------------------------------------------------
// Distinct values for filter dropdowns (Logs tab)
// ---------------------------------------------------------------------------

export interface FilterOptions {
    agents: string[]
    providers: string[]
    models: Array<{ provider: string; model: string }>
}

export function getFilterOptions(): FilterOptions {
    const agents = (db.prepare(`SELECT DISTINCT agentId FROM request_logs ORDER BY agentId`).all() as { agentId: string }[]).map(r => r.agentId)
    const providers = (db.prepare(`SELECT DISTINCT provider FROM request_logs ORDER BY provider`).all() as { provider: string }[]).map(r => r.provider)
    const models = db
        .prepare(`SELECT DISTINCT provider, model FROM request_logs ORDER BY provider, model`)
        .all() as Array<{ provider: string; model: string }>
    return { agents, providers, models }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RawRequestLogRow {
    id: string
    conversationId: string
    agentId: string
    agentThreadId: string | null
    parentRequestId: string | null
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
    modalityBreakdown: string | null
    billingBreakdown: string | null
    toolCallCount: number
    interactionId: string | null
    statefulMode: number
    errorMessage: string | null
    inputText: string | null
    outputText: string | null
}

interface RawToolLogRow {
    id: number
    requestId: string
    toolName: string
    success: number
    startedAt: number
    durationMs: number | null
    errorMessage: string | null
}

function parseRequestLogRow(r: RawRequestLogRow): RequestLogRow {
    let modalityBreakdown: ModalityBreakdown | null = null
    if (r.modalityBreakdown) {
        try {
            modalityBreakdown = JSON.parse(r.modalityBreakdown) as ModalityBreakdown
        } catch {
            modalityBreakdown = null
        }
    }
    const billingBreakdown = parseBillingBreakdown(r.billingBreakdown)
        ?? legacyBrowserBillingBreakdown(r.provider, r.outputText)
    const legacyTotals = billingBreakdown && r.provider === 'browser'
        ? sumBillingBreakdown(billingBreakdown)
        : null
    const inputTokens = normalizeStoredInputTokens(
        r.provider,
        r.inputTokens ?? legacyTotals?.inputTokens ?? null,
        r.cachedTokens ?? legacyTotals?.cachedTokens ?? null
    )
    return {
        id: r.id,
        conversationId: r.conversationId,
        agentId: r.agentId,
        agentThreadId: r.agentThreadId,
        parentRequestId: r.parentRequestId,
        depth: r.depth,
        provider: r.provider,
        model: r.model,
        thinkingLevel: r.thinkingLevel,
        status: r.status,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        durationMs: r.durationMs,
        thinkingMs: r.thinkingMs,
        inputTokens,
        outputTokens: r.outputTokens ?? legacyTotals?.outputTokens ?? null,
        thinkingTokens: r.thinkingTokens ?? legacyTotals?.thinkingTokens ?? null,
        cachedTokens: r.cachedTokens ?? legacyTotals?.cachedTokens ?? null,
        toolUseTokens: r.toolUseTokens ?? legacyTotals?.toolUseTokens ?? null,
        totalTokens: r.totalTokens ?? legacyTotals?.totalTokens ?? null,
        modalityBreakdown,
        billingBreakdown,
        toolCallCount: r.toolCallCount,
        interactionId: r.interactionId,
        statefulMode: r.statefulMode === 1,
        errorMessage: r.errorMessage,
        inputText: r.inputText,
        outputText: r.outputText,
    }
}

function normalizeStoredInputTokens(provider: string, inputTokens: number | null, cachedTokens: number | null): number | null {
    if (inputTokens === null || cachedTokens === null) return inputTokens
    if (cachedTokens <= inputTokens) return inputTokens

    // Legacy Anthropic/Claude rows were stored with `inputTokens` as the
    // provider-emitted uncached input only, while the UI expects cached tokens
    // to be a subset of input. Fix old rows at read time without mutating DB.
    if (provider === 'anthropic' || provider === 'claude-code') {
        return inputTokens + cachedTokens
    }

    return inputTokens
}

function parseBillingBreakdown(value: string | null): BillingUsageEntry[] | null {
    if (!value) return null
    try {
        const parsed = JSON.parse(value) as unknown
        if (!Array.isArray(parsed)) return null
        const entries = parsed
            .map(parseBillingEntry)
            .filter((entry): entry is BillingUsageEntry => entry !== null)
        return entries.length > 0 ? entries : null
    } catch {
        return null
    }
}

function parseBillingEntry(value: unknown): BillingUsageEntry | null {
    if (!value || typeof value !== 'object') return null
    const raw = value as Record<string, unknown>
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
    const model = typeof raw.model === 'string' ? raw.model.trim() : ''
    if (!provider || !model) return null
    return {
        provider,
        model,
        requests: nonNegativeInt(raw.requests, 1),
        inputTokens: nonNegativeInt(raw.inputTokens, 0),
        outputTokens: nonNegativeInt(raw.outputTokens, 0),
        thinkingTokens: nonNegativeInt(raw.thinkingTokens, 0),
        cachedTokens: nonNegativeInt(raw.cachedTokens, 0),
        toolUseTokens: nonNegativeInt(raw.toolUseTokens, 0),
        totalTokens: nonNegativeInt(raw.totalTokens, 0),
    }
}

function legacyBrowserBillingBreakdown(provider: string, outputText: string | null): BillingUsageEntry[] | null {
    if (provider !== 'browser' || !outputText) return null
    const matches = [...outputText.matchAll(
        /Usage \([^)]+\): task\[prompt=(\d+), output=(\d+), thoughts=(\d+), total=(\d+), requests=(\d+)\].*?\|\s*model=([^|\n]+?)\s*\|/g
    )]
    const match = matches[matches.length - 1]
    if (!match) return null

    const model = match[6]?.trim()
    if (!model) return null
    return [{
        provider: 'google',
        model,
        inputTokens: nonNegativeInt(Number(match[1]), 0),
        outputTokens: nonNegativeInt(Number(match[2]), 0),
        thinkingTokens: nonNegativeInt(Number(match[3]), 0),
        cachedTokens: 0,
        toolUseTokens: 0,
        totalTokens: nonNegativeInt(Number(match[4]), 0),
        requests: nonNegativeInt(Number(match[5]), 1),
    }]
}

function sumBillingBreakdown(entries: BillingUsageEntry[]): Omit<BillingUsageEntry, 'provider' | 'model'> {
    return entries.reduce(
        (acc, entry) => ({
            requests: acc.requests + entry.requests,
            inputTokens: acc.inputTokens + entry.inputTokens,
            outputTokens: acc.outputTokens + entry.outputTokens,
            thinkingTokens: acc.thinkingTokens + entry.thinkingTokens,
            cachedTokens: acc.cachedTokens + entry.cachedTokens,
            toolUseTokens: acc.toolUseTokens + entry.toolUseTokens,
            totalTokens: acc.totalTokens + entry.totalTokens,
        }),
        {
            requests: 0,
            inputTokens: 0,
            outputTokens: 0,
            thinkingTokens: 0,
            cachedTokens: 0,
            toolUseTokens: 0,
            totalTokens: 0,
        }
    )
}

function nonNegativeInt(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
    return Math.floor(value)
}

function parseToolLogRow(r: RawToolLogRow): ToolLogRow {
    return {
        id: r.id,
        requestId: r.requestId,
        toolName: r.toolName,
        success: r.success === 1,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        errorMessage: r.errorMessage,
    }
}

function startOfLocalDay(ms: number): number {
    const d = new Date(ms)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
}

function isoLocalDate(ms: number): string {
    const d = new Date(ms)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

function safe(fn: () => void): void {
    try {
        fn()
    } catch (err) {
        // Logging must never break the chat path. Surface to console only.
        console.error('[observability] write failed:', err)
    }
}
