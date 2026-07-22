import type { ProviderBuiltin, ToolDef } from '@/lib/ai/agents/types'
import { removeNativeBuiltinToolDuplicates } from '@/lib/ai/tools/registry'
import type { ContextUsageSnapshot, TokenUsageBreakdown } from '@/lib/types'

export interface AnyObj { [k: string]: unknown }

export function customToolsForCodex(
    tools: ToolDef[],
    builtins: ProviderBuiltin[] = [],
): ToolDef[] {
    return removeNativeBuiltinToolDuplicates(tools, builtins)
}

export function toRecord(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v)
        ? v as Record<string, unknown>
        : {}
}

export function formatToolResult(success: boolean, data: unknown, error: unknown): string {
    if (!success) return typeof error === 'string' ? error : formatUnknown(error ?? 'Tool call failed')
    return formatUnknown(data)
}

export function formatUnknown(value: unknown): string {
    if (typeof value === 'string') return value
    if (value === undefined) return ''
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

interface SyntheticTodo {
    id: string
    content: string
    status: 'pending' | 'in_progress' | 'completed'
}

export function todosFromCodexPlan(params?: AnyObj): SyntheticTodo[] {
    const plan = Array.isArray(params?.plan)
        ? params.plan
        : Array.isArray(toRecord(params?.turn).plan)
            ? toRecord(params?.turn).plan as unknown[]
            : []

    return plan.flatMap((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const record = item as Record<string, unknown>
        const content = firstString(record.step, record.content, record.text, record.title, record.description)
        if (!content) return []
        return [{
            id: firstString(record.id, record.key) || `codex_plan_${index + 1}`,
            content,
            status: normalizePlanStatus(record.status),
        }]
    })
}

export function firstString(...values: unknown[]): string {
    for (const value of values) {
        if (typeof value !== 'string') continue
        const trimmed = value.trim()
        if (trimmed) return trimmed
    }
    return ''
}

function normalizePlanStatus(value: unknown): SyntheticTodo['status'] {
    if (typeof value !== 'string') return 'pending'
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
    if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed'
    if (normalized === 'in_progress' || normalized === 'inprogress' || normalized === 'running' || normalized === 'active') return 'in_progress'
    return 'pending'
}

export function contentItemsToText(value: unknown): string {
    if (!Array.isArray(value)) return ''
    return value.map(item => {
        if (!item || typeof item !== 'object') return ''
        const record = item as Record<string, unknown>
        return typeof record.text === 'string' ? record.text : ''
    }).filter(Boolean).join('\n')
}

export function sanitizeArgs(item: AnyObj): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key of ['command', 'tool', 'query', 'path', 'file', 'url', 'status']) {
        const v = item[key]
        if (typeof v === 'string') out[key] = v
    }
    return out
}

const CODEX_WEB_ARG_KEYS = [
    'search_query',
    'searchQuery',
    'image_query',
    'imageQuery',
    'open',
    'click',
    'find',
    'screenshot',
    'sports',
    'finance',
    'weather',
    'time',
]

export function codexWebArgs(item: AnyObj): Record<string, unknown> {
    const action = toRecord(item.action)
    const out: Record<string, unknown> = {}
    const query = firstString(item.query, action.query)
    const queries = stringArray(action.queries)

    if (query) out.query = query
    if (queries.length) out.queries = queries

    for (const key of CODEX_WEB_ARG_KEYS) {
        const direct = item[key]
        const fromAction = action[key]
        const value = direct !== undefined ? direct : fromAction
        if (value !== undefined) out[key] = value
    }

    if (Object.keys(action).length > 0) out.action = action
    return out
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : []
}

const RAW_WEB_TOOL_NAMES = new Set([
    'run',
    'search_query',
    'image_query',
    'open',
    'click',
    'find',
    'screenshot',
    'sports',
    'finance',
    'weather',
    'time',
])

export function isWebToolName(name: string): boolean {
    return RAW_WEB_TOOL_NAMES.has(name.trim())
}

export function normalizeRawWebArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const normalized = name.trim()
    if (!normalized || normalized === 'run') return args
    if (args[normalized] !== undefined) return args

    if (normalized === 'search_query' || normalized === 'image_query') {
        return { ...args, [normalized]: Array.isArray(args[normalized]) ? args[normalized] : [args] }
    }

    if (RAW_WEB_TOOL_NAMES.has(normalized)) {
        return {
            ...args,
            [normalized]: Array.isArray(args[normalized]) ? args[normalized] : [args],
            action: { type: normalized, ...args },
        }
    }

    return args
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    if (typeof value !== 'string' || !value.trim()) return {}
    try {
        const parsed = JSON.parse(value) as unknown
        return toRecord(parsed)
    } catch {
        return {}
    }
}

export function codexContextUsageSnapshot(args: {
    raw: Record<string, unknown>
    model: string
    threadId?: string
    turnId?: string
}): ContextUsageSnapshot | null {
    const last = tokenUsageBreakdown(args.raw.last)
    const total = tokenUsageBreakdown(args.raw.total)
    const contextWindow = numberOrNull(args.raw.modelContextWindow)

    const inputTokens = last?.inputTokens ?? null
    const outputTokens = last?.outputTokens ?? null
    const thinkingTokens = last?.reasoningOutputTokens ?? null
    const cachedTokens = last?.cachedInputTokens ?? null
    const totalTokens = last?.totalTokens ?? null
    const contextTokens = sumTokens(inputTokens, outputTokens)

    if (
        contextWindow === null &&
        inputTokens === null &&
        outputTokens === null &&
        thinkingTokens === null &&
        cachedTokens === null &&
        totalTokens === null &&
        !total
    ) {
        return null
    }

    return {
        provider: 'codex',
        model: args.model,
        source: 'provider-live',
        accuracy: 'live',
        updatedAt: Date.now(),
        threadId: args.threadId,
        turnId: args.turnId,
        contextWindow,
        contextTokens,
        inputTokens,
        outputTokens,
        thinkingTokens,
        cachedTokens,
        totalTokens,
        threadTokens: total?.totalTokens ?? null,
        last,
        total,
    }
}

export function codexUsageForCurrentTurn(
    rawTokenUsage: unknown,
    previousBaseline: TokenUsageBreakdown | null
): { usage: TokenUsageBreakdown | null; baseline: TokenUsageBreakdown | null } {
    const tokenUsage = toRecord(rawTokenUsage)
    const last = tokenUsageBreakdown(tokenUsage.last)
    const total = tokenUsageBreakdown(tokenUsage.total)

    if (total && last) {
        const baseline = previousBaseline ?? codexUsageBaseline(total, last)
        return {
            usage: codexUsageDelta(total, baseline, last),
            baseline,
        }
    }

    if (last) {
        return { usage: last, baseline: previousBaseline }
    }

    return {
        usage: tokenUsageBreakdown(tokenUsage),
        baseline: previousBaseline,
    }
}

/** Incremental provider-call usage for API-equivalent cost accounting. */
export function codexUsageForBillingUpdate(
    rawTokenUsage: unknown,
    previousTotal: TokenUsageBreakdown | null
): {
    usage: TokenUsageBreakdown | null
    contextInputTokens: number | null
    total: TokenUsageBreakdown | null
} {
    const tokenUsage = toRecord(rawTokenUsage)
    const last = tokenUsageBreakdown(tokenUsage.last)
    const total = tokenUsageBreakdown(tokenUsage.total)

    if (total && last) {
        return {
            usage: previousTotal ? codexUsageDelta(total, previousTotal, last) : last,
            contextInputTokens: last.inputTokens ?? null,
            total,
        }
    }

    return {
        usage: last,
        contextInputTokens: last?.inputTokens ?? null,
        total: previousTotal,
    }
}

export function tokenUsageBreakdown(value: unknown): TokenUsageBreakdown | null {
    const raw = toRecord(value)
    const totalTokens = numberOrNull(raw.totalTokens)
    const inputTokens = numberOrNull(raw.inputTokens)
    const cachedInputTokens = numberOrNull(raw.cachedInputTokens)
    const outputTokens = numberOrNull(raw.outputTokens)
    const reasoningOutputTokens = numberOrNull(raw.reasoningOutputTokens)
    if (
        totalTokens === null &&
        inputTokens === null &&
        cachedInputTokens === null &&
        outputTokens === null &&
        reasoningOutputTokens === null
    ) {
        return null
    }
    return {
        totalTokens,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
    }
}

function codexUsageBaseline(total: TokenUsageBreakdown, last: TokenUsageBreakdown): TokenUsageBreakdown {
    return {
        totalTokens: subtractKnown(total.totalTokens, last.totalTokens),
        inputTokens: subtractKnown(total.inputTokens, last.inputTokens),
        cachedInputTokens: subtractKnown(total.cachedInputTokens, last.cachedInputTokens),
        outputTokens: subtractKnown(total.outputTokens, last.outputTokens),
        reasoningOutputTokens: subtractKnown(total.reasoningOutputTokens, last.reasoningOutputTokens),
    }
}

function codexUsageDelta(
    total: TokenUsageBreakdown,
    baseline: TokenUsageBreakdown | null,
    fallback: TokenUsageBreakdown
): TokenUsageBreakdown | null {
    const usage = {
        totalTokens: deltaOrFallback(total.totalTokens, baseline?.totalTokens, fallback.totalTokens),
        inputTokens: deltaOrFallback(total.inputTokens, baseline?.inputTokens, fallback.inputTokens),
        cachedInputTokens: deltaOrFallback(total.cachedInputTokens, baseline?.cachedInputTokens, fallback.cachedInputTokens),
        outputTokens: deltaOrFallback(total.outputTokens, baseline?.outputTokens, fallback.outputTokens),
        reasoningOutputTokens: deltaOrFallback(total.reasoningOutputTokens, baseline?.reasoningOutputTokens, fallback.reasoningOutputTokens),
    }
    return hasUsageValues(usage) ? usage : null
}

function subtractKnown(total: number | null | undefined, last: number | null | undefined): number | null {
    if (typeof total !== 'number' || typeof last !== 'number') return null
    return Math.max(0, total - last)
}

function deltaOrFallback(
    total: number | null | undefined,
    baseline: number | null | undefined,
    fallback: number | null | undefined
): number | null {
    if (typeof total === 'number' && typeof baseline === 'number') return Math.max(0, total - baseline)
    return typeof fallback === 'number' ? fallback : null
}

function hasUsageValues(usage: TokenUsageBreakdown): boolean {
    return (
        usage.totalTokens !== null ||
        usage.inputTokens !== null ||
        usage.cachedInputTokens !== null ||
        usage.outputTokens !== null ||
        usage.reasoningOutputTokens !== null
    )
}

function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function sumTokens(...values: Array<number | null | undefined>): number | null {
    let total = 0
    let seen = false
    for (const value of values) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
        total += value
        seen = true
    }
    return seen ? total : null
}
