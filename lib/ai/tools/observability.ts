import fs from 'fs'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import type { ScheduledAction } from '@/lib/scheduling/schema'
import { codeMapPath, getRuntimeIndexStatus, readRuntimeIndexEntries } from '@/lib/runtime-index'
import { getConfiguredTimezone } from '@/lib/config'
import { dateStampInTimezone } from '@/lib/timezone'
import { booleanArg, clamp, numberArg, stringArg, truncateText } from './helpers'

type Range = '1h' | '24h' | '7d' | '30d' | 'all'
type RequestStatus = 'streaming' | 'ok' | 'error' | 'aborted'
type RunStatus = 'ok' | 'error'
type RunTrigger = 'schedule' | 'manual'

const RANGE_MS: Record<Range, number | null> = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    all: null,
}

export const searchPastRunsTool: ToolDef = {
    id: 'search_past_runs',
    name: 'search_past_runs',
    description: 'Read-only search over Scheduling Past runs stored in SQLite. Use this when you need prior scheduled task outcomes, monitor wake decisions, summaries, surfaced state, or errors without injecting run history into your prompt.',
    input_schema: {
        type: 'object',
        properties: {
            task_id: { type: 'string', description: 'Optional scheduled task id.' },
            task_title: { type: 'string', description: 'Optional case-insensitive title substring.' },
            range: { type: 'string', enum: ['1h', '24h', '7d', '30d', 'all'], description: 'Time window by started_at. Defaults to 24h.' },
            status: { type: 'string', enum: ['ok', 'error'], description: 'Optional run status filter.' },
            trigger: { type: 'string', enum: ['schedule', 'manual'], description: 'Optional trigger filter.' },
            surfaced: { type: 'boolean', description: 'Optional filter for runs that surfaced to Inbox.' },
            q: { type: 'string', description: 'Optional text search over run summary, error, and task title.' },
            limit: { type: 'integer', description: 'Max rows to return. Defaults to 20, capped at 100.' },
        },
    },
    tags: ['read', 'observability', 'scheduling'],
}

export const getPastRunTool: ToolDef = {
    id: 'get_past_run',
    name: 'get_past_run',
    description: 'Read one Scheduling Past run by run_id, including its full stored summary clipped to max_chars. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            run_id: { type: 'string', description: 'Past run id returned by search_past_runs.' },
            id: { type: 'string', description: 'Alias for run_id.' },
            max_chars: { type: 'integer', description: 'Maximum summary characters returned. Defaults to 12000, capped at 64000.' },
        },
    },
    tags: ['read', 'observability', 'scheduling'],
}

export const searchAgentLogsTool: ToolDef = {
    id: 'search_agent_logs',
    name: 'search_agent_logs',
    description: 'Read-only search over model request logs stored in SQLite. Use this for prior orchestrator/sub-agent runs, provider/model/status, input/output previews, token counts, errors, and request ids.',
    input_schema: {
        type: 'object',
        properties: {
            range: { type: 'string', enum: ['1h', '24h', '7d', '30d', 'all'], description: 'Time window by started_at. Defaults to 24h.' },
            status: { type: 'string', enum: ['streaming', 'ok', 'error', 'aborted'], description: 'Optional request status filter.' },
            agent: { type: 'string', description: 'Optional agent id, e.g. orchestrator, researcher.' },
            provider: { type: 'string', description: 'Optional provider id.' },
            model: { type: 'string', description: 'Optional model id.' },
            q: { type: 'string', description: 'Optional search over errors, ids, input text, and output text.' },
            limit: { type: 'integer', description: 'Max rows to return. Defaults to 20, capped at 100.' },
        },
    },
    tags: ['read', 'observability', 'logs'],
}

export const getAgentLogTool: ToolDef = {
    id: 'get_agent_log',
    name: 'get_agent_log',
    description: 'Read one model request log by request_id, including clipped input/output text and tool logs on demand. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            request_id: { type: 'string', description: 'Request id returned by search_agent_logs.' },
            id: { type: 'string', description: 'Alias for request_id.' },
            include_text: { type: 'boolean', description: 'Include clipped input/output text. Defaults true.' },
            include_tool_logs: { type: 'boolean', description: 'Include tool log rows. Defaults true.' },
            max_chars: { type: 'integer', description: 'Maximum characters per text field. Defaults to 12000, capped at 64000.' },
        },
    },
    tags: ['read', 'observability', 'logs'],
}

export const readRuntimeIndexTool: ToolDef = {
    id: 'read_runtime_index',
    name: 'read_runtime_index',
    description: 'Read the compact runtime index files and code map. Use overview to discover paths, code to read AGENT_INDEX.md, runs/logs to read recent JSONL index entries for a date.',
    input_schema: {
        type: 'object',
        properties: {
            section: { type: 'string', enum: ['overview', 'code', 'runs', 'logs'], description: 'What to read. Defaults to overview.' },
            date: { type: 'string', description: 'YYYY-MM-DD for runs/logs. Defaults to today in the app-configured timezone.' },
            limit: { type: 'integer', description: 'Max JSONL entries for runs/logs. Defaults to 50, capped at 200.' },
            max_chars: { type: 'integer', description: 'Max chars for code map. Defaults to 30000.' },
        },
    },
    tags: ['read', 'observability', 'filesystem'],
}

export const observabilityTools: ToolDef[] = [
    searchPastRunsTool,
    getPastRunTool,
    searchAgentLogsTool,
    getAgentLogTool,
    readRuntimeIndexTool,
]

export async function executeSearchPastRuns(args: Record<string, unknown>): Promise<ToolResult> {
    const range = parseRange(args, '24h')
    const status = optionalEnum<RunStatus>(args.status, ['ok', 'error'], 'status')
    if ('error' in status) return status.error
    const trigger = optionalEnum<RunTrigger>(args.trigger, ['schedule', 'manual'], 'trigger')
    if ('error' in trigger) return trigger.error

    const { searchTaskRuns } = await import('@/lib/scheduling/store')
    const rangeMs = RANGE_MS[range]
    const limit = parseLimit(args, 20, 100)
    const result = searchTaskRuns({
        taskId: stringArg(args, ['task_id']) || undefined,
        taskTitle: stringArg(args, ['task_title']) || undefined,
        startedAfter: rangeMs === null ? undefined : Date.now() - rangeMs,
        status: status.value,
        trigger: trigger.value,
        surfaced: typeof args.surfaced === 'boolean' ? args.surfaced : undefined,
        q: stringArg(args, ['q']) || undefined,
        limit,
    })

    return {
        success: true,
        data: {
            count: result.runs.length,
            total: result.total,
            range,
            runs: result.runs.map((run) => ({
                run_id: run.id,
                task_id: run.taskId,
                task_title: run.taskTitle,
                task_action: describeAction(run.taskAction),
                started_at: new Date(run.startedAt).toISOString(),
                ended_at: new Date(run.endedAt).toISOString(),
                duration_ms: Math.max(0, run.endedAt - run.startedAt),
                status: run.status,
                trigger: run.trigger,
                surfaced: run.surfaced,
                conversation_id: run.conversationId,
                summary_preview: preview(run.summary, 900),
                error: run.error,
            })),
        },
    }
}

export async function executeGetPastRun(args: Record<string, unknown>): Promise<ToolResult> {
    const runId = stringArg(args, ['run_id', 'id']).trim()
    if (!runId) return { success: false, error: 'run_id is required.' }
    const { getTaskRunWithTask } = await import('@/lib/scheduling/store')
    const run = getTaskRunWithTask(runId)
    if (!run) return { success: false, error: `No past run with id ${runId}.` }
    const maxChars = parseMaxChars(args, 12_000)
    const summary = truncateText(run.summary, maxChars)
    return {
        success: true,
        data: {
            run_id: run.id,
            task_id: run.taskId,
            task_title: run.taskTitle,
            task_action: describeAction(run.taskAction),
            started_at: new Date(run.startedAt).toISOString(),
            ended_at: new Date(run.endedAt).toISOString(),
            duration_ms: Math.max(0, run.endedAt - run.startedAt),
            status: run.status,
            trigger: run.trigger,
            surfaced: run.surfaced,
            conversation_id: run.conversationId,
            error: run.error,
            summary: summary.text,
            summary_truncated: summary.truncated,
        },
    }
}

export async function executeSearchAgentLogs(args: Record<string, unknown>): Promise<ToolResult> {
    const range = parseRange(args, '24h')
    const status = optionalEnum<RequestStatus>(args.status, ['streaming', 'ok', 'error', 'aborted'], 'status')
    if ('error' in status) return status.error
    const { queryLogs } = await import('@/lib/observability/store')
    const page = queryLogs({
        range,
        status: status.value,
        agent: stringArg(args, ['agent']) || undefined,
        provider: stringArg(args, ['provider']) || undefined,
        model: stringArg(args, ['model']) || undefined,
        q: stringArg(args, ['q']) || undefined,
        limit: parseLimit(args, 20, 100),
    })
    return {
        success: true,
        data: {
            count: page.rows.length,
            total: page.total,
            next_cursor: page.nextCursor,
            range,
            logs: page.rows.map((row) => ({
                request_id: row.id,
                conversation_id: row.conversationId,
                agent_id: row.agentId,
                agent_thread_id: row.agentThreadId,
                parent_request_id: row.parentRequestId,
                depth: row.depth,
                provider: row.provider,
                model: row.model,
                thinking_level: row.thinkingLevel,
                status: row.status,
                started_at: new Date(row.startedAt).toISOString(),
                ended_at: row.endedAt ? new Date(row.endedAt).toISOString() : null,
                duration_ms: row.durationMs,
                input_tokens: row.inputTokens,
                output_tokens: row.outputTokens,
                total_tokens: row.totalTokens,
                tool_call_count: row.toolCallCount,
                interaction_id: row.interactionId,
                error: row.errorMessage,
                input_preview: preview(row.inputText, 900),
                output_preview: preview(row.outputText, 900),
            })),
        },
    }
}

export async function executeGetAgentLog(args: Record<string, unknown>): Promise<ToolResult> {
    const requestId = stringArg(args, ['request_id', 'id']).trim()
    if (!requestId) return { success: false, error: 'request_id is required.' }
    const includeText = booleanArg(args, ['include_text'], true)
    const includeToolLogs = booleanArg(args, ['include_tool_logs'], true)
    const maxChars = parseMaxChars(args, 12_000)
    const { getRequestLog, getToolLogsForRequest } = await import('@/lib/observability/store')
    const row = getRequestLog(requestId)
    if (!row) return { success: false, error: `No agent log with request_id ${requestId}.` }
    const input = includeText ? truncateText(row.inputText ?? '', maxChars) : null
    const output = includeText ? truncateText(row.outputText ?? '', maxChars) : null
    return {
        success: true,
        data: {
            request_id: row.id,
            conversation_id: row.conversationId,
            agent_id: row.agentId,
            agent_thread_id: row.agentThreadId,
            parent_request_id: row.parentRequestId,
            depth: row.depth,
            provider: row.provider,
            model: row.model,
            thinking_level: row.thinkingLevel,
            status: row.status,
            started_at: new Date(row.startedAt).toISOString(),
            ended_at: row.endedAt ? new Date(row.endedAt).toISOString() : null,
            duration_ms: row.durationMs,
            thinking_ms: row.thinkingMs,
            tokens: {
                input: row.inputTokens,
                output: row.outputTokens,
                thinking: row.thinkingTokens,
                cached: row.cachedTokens,
                tool_use: row.toolUseTokens,
                total: row.totalTokens,
            },
            tool_call_count: row.toolCallCount,
            interaction_id: row.interactionId,
            stateful_mode: row.statefulMode,
            error: row.errorMessage,
            ...(includeText ? {
                input_text: input?.text ?? '',
                input_truncated: input?.truncated ?? false,
                output_text: output?.text ?? '',
                output_truncated: output?.truncated ?? false,
            } : {}),
            ...(includeToolLogs ? {
                tool_logs: getToolLogsForRequest(requestId).map((tool) => ({
                    id: tool.id,
                    tool_name: tool.toolName,
                    success: tool.success,
                    started_at: new Date(tool.startedAt).toISOString(),
                    duration_ms: tool.durationMs,
                    error: tool.errorMessage,
                })),
            } : {}),
        },
    }
}

export async function executeReadRuntimeIndex(args: Record<string, unknown>): Promise<ToolResult> {
    const section = stringArg(args, ['section']).trim() || 'overview'
    const limit = parseLimit(args, 50, 200)
    if (section === 'overview') {
        return { success: true, data: getRuntimeIndexStatus() }
    }
    if (section === 'code') {
        const file = codeMapPath()
        if (!fs.existsSync(file)) return { success: false, error: 'AGENT_INDEX.md is missing.' }
        const maxChars = clamp(Math.floor(numberArg(args, ['max_chars'], 30_000)), 1_000, 120_000)
        const content = truncateText(fs.readFileSync(file, 'utf-8'), maxChars)
        return { success: true, data: { path: file, content: content.text, truncated: content.truncated } }
    }
    if (section === 'runs' || section === 'logs') {
        const date = stringArg(args, ['date']).trim() || todayLocal()
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return { success: false, error: 'date must be YYYY-MM-DD.' }
        }
        return {
            success: true,
            data: {
                section,
                date,
                entries: readRuntimeIndexEntries(section, date, limit),
            },
        }
    }
    return { success: false, error: 'section must be one of: overview, code, runs, logs.' }
}

function parseRange(args: Record<string, unknown>, fallback: Range): Range {
    const raw = stringArg(args, ['range']).trim()
    if (raw === '1h' || raw === '24h' || raw === '7d' || raw === '30d' || raw === 'all') return raw
    return fallback
}

function optionalEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
    name: string
): { value?: T } | { error: ToolResult } {
    if (value === undefined || value === null || value === '') return {}
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return { value: value as T }
    return { error: { success: false, error: `${name} must be one of: ${allowed.join(', ')}.` } }
}

function parseLimit(args: Record<string, unknown>, fallback: number, max: number): number {
    return clamp(Math.floor(numberArg(args, ['limit'], fallback)), 1, max)
}

function parseMaxChars(args: Record<string, unknown>, fallback: number): number {
    return clamp(Math.floor(numberArg(args, ['max_chars'], fallback)), 1_000, 64_000)
}

function preview(value: string | null | undefined, maxChars: number): string | null {
    if (!value) return null
    const text = value.replace(/\s+/g, ' ').trim()
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`
}

function describeAction(action: ScheduledAction | null): string | null {
    if (!action) return null
    if (action.kind === 'tool') return `tool:${action.toolId}`
    if (action.kind === 'agent') return `agent:${action.agentId}`
    return `monitor:${action.monitorKind}`
}

function todayLocal(): string {
    return dateStampInTimezone(new Date(), getConfiguredTimezone())
}
