import db from '@/lib/db'
import { appendRuntimeRequestLogIndex } from '@/lib/runtime-index'
import { emitObservabilityEvent } from './events'
import {
    type RequestLogRow,
    type ToolLogRow,
    type RequestStatus,
    type ModalityBreakdown,
    type LogsQuery,
    type UsageRange,
    type UsageReport,
    type UsageDaily,
    type UsageTotals,
    type UsageByModel,
    type UsageByAgent,
    type UsageByTool,
    LOG_TEXT_MAX_CHARS,
} from './schema'
import { normalizeUsage } from './usage-mapper'
import { estimateCost } from './cost'
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
        emitObservabilityEvent({ type: 'request_started', requestId: args.requestId })
    })
}

function truncate(s: string | null | undefined): string | null {
    if (s == null) return null
    if (s.length <= LOG_TEXT_MAX_CHARS) return s
    // Suffix marker so a UI rendering this knows it was cut.
    return s.slice(0, LOG_TEXT_MAX_CHARS) + `\n…[truncated, original was ${s.length} chars]`
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
            interactionId: args.interactionId ?? null,
            outputText: truncate(args.outputText),
        })
        indexRequestLog(args.requestId)
        emitObservabilityEvent({ type: 'request_completed', requestId: args.requestId })
    })
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

export function logRequestFail(requestId: string, errorMessage: string, endedAt: number, outputText?: string | null): void {
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
        indexRequestLog(requestId)
        emitObservabilityEvent({ type: 'request_completed', requestId })
    })
}

export function logRequestAbort(requestId: string, endedAt: number, outputText?: string | null): void {
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
        indexRequestLog(requestId)
        emitObservabilityEvent({ type: 'request_completed', requestId })
    })
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

export function clearAllLogs(): { deletedRequests: number; deletedTools: number } {
    const tx = db.transaction(() => {
        const t = db.prepare(`DELETE FROM tool_logs`).run()
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

        const pricing = registry[row.provider]?.models[row.model]?.pricing ?? null
        const cost = estimateCost(pricing, {
            provider: row.provider,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            thinkingTokens: row.thinkingTokens,
            cachedTokens: row.cachedTokens,
            toolUseTokens: row.toolUseTokens,
        })
        estimatedCostUsd += cost.usd
        if (cost.state === 'unknown') uncostedRequests++
        if (cost.state === 'subscription') subscriptionRequests++
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
        const pricing = registry[row.provider]?.models[row.model]?.pricing ?? null
        const cost = estimateCost(pricing, {
            provider: row.provider,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            thinkingTokens: row.thinkingTokens,
            cachedTokens: row.cachedTokens,
            toolUseTokens: row.toolUseTokens,
        })
        bucket.estimatedCostUsd += cost.usd
        buckets.set(key, bucket)
    }

    return [...buckets.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

function computeByModel(rows: RequestLogRow[]): UsageByModel[] {
    const registry = getEffectiveRegistry()
    const map = new Map<string, UsageByModel & { _thinkingMsSum: number; _thinkingMsCount: number }>()
    for (const row of rows) {
        const key = `${row.provider}:${row.model}`
        const existing = map.get(key)
        const pricing = registry[row.provider]?.models[row.model]?.pricing ?? null
        const cost = estimateCost(pricing, {
            provider: row.provider,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            thinkingTokens: row.thinkingTokens,
            cachedTokens: row.cachedTokens,
            toolUseTokens: row.toolUseTokens,
        })

        if (!existing) {
            map.set(key, {
                provider: row.provider,
                model: row.model,
                displayName: registry[row.provider]?.models[row.model]?.name ?? row.model,
                requests: 1,
                errors: row.status === 'error' ? 1 : 0,
                inputTokens: row.inputTokens ?? 0,
                outputTokens: row.outputTokens ?? 0,
                thinkingTokens: row.thinkingTokens ?? 0,
                cachedTokens: row.cachedTokens ?? 0,
                estimatedCostUsd: cost.usd,
                avgThinkingMs: 0,
                lastUsedAt: row.startedAt,
                pricingState: cost.state,
                _thinkingMsSum: row.thinkingMs ?? 0,
                _thinkingMsCount: row.thinkingMs !== null ? 1 : 0,
            })
        } else {
            existing.requests++
            if (row.status === 'error') existing.errors++
            existing.inputTokens += row.inputTokens ?? 0
            existing.outputTokens += row.outputTokens ?? 0
            existing.thinkingTokens += row.thinkingTokens ?? 0
            existing.cachedTokens += row.cachedTokens ?? 0
            existing.estimatedCostUsd += cost.usd
            existing.lastUsedAt = Math.max(existing.lastUsedAt, row.startedAt)
            if (row.thinkingMs !== null) {
                existing._thinkingMsSum += row.thinkingMs
                existing._thinkingMsCount++
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
        const pricing = registry[row.provider]?.models[row.model]?.pricing ?? null
        const cost = estimateCost(pricing, {
            provider: row.provider,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            thinkingTokens: row.thinkingTokens,
            cachedTokens: row.cachedTokens,
            toolUseTokens: row.toolUseTokens,
        })
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
    const inputTokens = normalizeStoredInputTokens(r.provider, r.inputTokens, r.cachedTokens)
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
        outputTokens: r.outputTokens,
        thinkingTokens: r.thinkingTokens,
        cachedTokens: r.cachedTokens,
        toolUseTokens: r.toolUseTokens,
        totalTokens: r.totalTokens,
        modalityBreakdown,
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
