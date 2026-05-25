import fs from 'fs'
import path from 'path'

import type { RequestLogRow } from '@/lib/observability/schema'

const PREVIEW_CHARS = 700

export interface RuntimeRunIndexInput {
    id: string
    taskId: string
    taskTitle?: string | null
    startedAt: number
    endedAt: number
    status: 'ok' | 'error'
    trigger: 'schedule' | 'manual'
    surfaced: boolean
    conversationId: string | null
    summary: string
    error?: string | null
}

export interface RuntimeRequestLogIndexInput {
    id: string
    conversationId: string
    agentId: string
    agentThreadId: string | null
    parentRequestId: string | null
    depth: number
    provider: string
    model: string
    status: RequestLogRow['status']
    startedAt: number
    endedAt: number | null
    durationMs: number | null
    toolCallCount: number
    interactionId: string | null
    errorMessage: string | null
    inputText: string | null
    outputText: string | null
}

export function runtimeIndexRoot(): string {
    return path.join(process.cwd(), '.orchestrator', 'index')
}

export function runtimeIndexPath(kind: 'runs' | 'logs', date: string): string {
    return path.join(runtimeIndexRoot(), kind, `${date}.jsonl`)
}

export function codeMapPath(): string {
    return path.join(process.cwd(), 'AGENT_INDEX.md')
}

export function appendRuntimeRunIndex(entry: RuntimeRunIndexInput): void {
    appendJsonl('runs', entry.startedAt, {
        type: 'scheduled_task_run',
        run_id: entry.id,
        task_id: entry.taskId,
        task_title: entry.taskTitle ?? null,
        started_at: new Date(entry.startedAt).toISOString(),
        ended_at: new Date(entry.endedAt).toISOString(),
        duration_ms: Math.max(0, entry.endedAt - entry.startedAt),
        status: entry.status,
        trigger: entry.trigger,
        surfaced: entry.surfaced,
        conversation_id: entry.conversationId,
        summary_preview: preview(entry.summary),
        error: entry.error ?? null,
    })
}

export function appendRuntimeRequestLogIndex(row: RuntimeRequestLogIndexInput): void {
    appendJsonl('logs', row.startedAt, {
        type: 'agent_request_log',
        request_id: row.id,
        conversation_id: row.conversationId,
        agent_id: row.agentId,
        agent_thread_id: row.agentThreadId,
        parent_request_id: row.parentRequestId,
        depth: row.depth,
        provider: row.provider,
        model: row.model,
        status: row.status,
        started_at: new Date(row.startedAt).toISOString(),
        ended_at: row.endedAt ? new Date(row.endedAt).toISOString() : null,
        duration_ms: row.durationMs,
        tool_call_count: row.toolCallCount,
        interaction_id: row.interactionId,
        error: row.errorMessage,
        input_preview: preview(row.inputText),
        output_preview: preview(row.outputText),
    })
}

export function readRuntimeIndexEntries(kind: 'runs' | 'logs', date: string, limit: number): unknown[] {
    const file = runtimeIndexPath(kind, date)
    if (!fs.existsSync(file)) return []
    const lines = fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .filter(Boolean)
    return lines.slice(-limit).map((line) => {
        try {
            return JSON.parse(line) as unknown
        } catch {
            return { parse_error: true, raw: line }
        }
    })
}

export function getRuntimeIndexStatus(): {
    root: string
    database_path: string
    code_map_path: string
    run_index_files: string[]
    log_index_files: string[]
} {
    const root = runtimeIndexRoot()
    return {
        root,
        database_path: path.join(process.cwd(), '.orchestrator', 'data.db'),
        code_map_path: codeMapPath(),
        run_index_files: listJsonlFiles(path.join(root, 'runs')),
        log_index_files: listJsonlFiles(path.join(root, 'logs')),
    }
}

function appendJsonl(kind: 'runs' | 'logs', timestampMs: number, payload: Record<string, unknown>): void {
    try {
        const date = localDateKey(timestampMs)
        const file = runtimeIndexPath(kind, date)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.appendFileSync(file, `${JSON.stringify(payload)}\n`)
    } catch {
        // Runtime indexing is an aid for agents, never part of the critical path.
    }
}

function listJsonlFiles(dir: string): string[] {
    try {
        if (!fs.existsSync(dir)) return []
        return fs
            .readdirSync(dir)
            .filter((name) => name.endsWith('.jsonl'))
            .sort()
            .map((name) => path.join(dir, name))
    } catch {
        return []
    }
}

function localDateKey(ms: number): string {
    const d = new Date(ms)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

function preview(value: string | null | undefined): string | null {
    if (!value) return null
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length <= PREVIEW_CHARS) return normalized
    return `${normalized.slice(0, PREVIEW_CHARS)}...`
}
