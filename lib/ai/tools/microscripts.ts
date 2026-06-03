import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import {
    createMicroscript,
    deleteMicroscript,
    getMicroscript,
    listMicroscriptEvents,
    listMicroscriptRuns,
    listMicroscripts,
    setMicroscriptStatus,
    updateMicroscript,
} from '@/lib/microscripts/store'
import { runMicroscript, validateMicroscriptCode } from '@/lib/microscripts/runner'
import {
    MicroscriptManifestSchema,
    MicroscriptStatusSchema,
    type Microscript,
    type MicroscriptManifest,
} from '@/lib/microscripts/schema'

// ---------------------------------------------------------------------------
// Microscripts lifecycle tools.
// ---------------------------------------------------------------------------

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/i
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

function parseDurationMs(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
    if (typeof value !== 'string') return null
    const m = DURATION_RE.exec(value)
    if (!m) return null
    return Math.round(Number(m[1]) * UNIT_MS[m[2].toLowerCase()])
}

function parseOptionalDateMs(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
    if (typeof value !== 'string' || !value.trim()) return undefined
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
}

function boolAlias(input: Record<string, unknown>, ...keys: string[]): boolean | undefined {
    for (const key of keys) if (typeof input[key] === 'boolean') return input[key]
    return undefined
}

function numberAlias(input: Record<string, unknown>, ...keys: string[]): number | undefined {
    for (const key of keys) if (typeof input[key] === 'number' && Number.isFinite(input[key])) return input[key] as number
    return undefined
}

function normalizeManifest(raw: unknown): MicroscriptManifest {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('manifest must be an object.')
    }
    const input = raw as Record<string, unknown>
    const scheduleRaw = input.schedule && typeof input.schedule === 'object' && !Array.isArray(input.schedule)
        ? input.schedule as Record<string, unknown>
        : {}
    let schedule: Record<string, unknown>
    if (scheduleRaw.kind === 'manual' || input.schedule === 'manual') {
        schedule = { kind: 'manual' }
    } else if (scheduleRaw.kind === 'interval' || scheduleRaw.every !== undefined || scheduleRaw.everyMs !== undefined) {
        const everyMs = parseDurationMs(scheduleRaw.everyMs ?? scheduleRaw.every)
        if (!everyMs) throw new Error('manifest.schedule.every/everyMs must be a positive duration.')
        schedule = {
            kind: 'interval',
            everyMs,
            ...(parseOptionalDateMs(scheduleRaw.startAt ?? scheduleRaw.start_at) ? { startAt: parseOptionalDateMs(scheduleRaw.startAt ?? scheduleRaw.start_at) } : {}),
        }
    } else {
        schedule = { kind: 'manual' }
    }

    const limitsRaw = input.limits && typeof input.limits === 'object' && !Array.isArray(input.limits)
        ? input.limits as Record<string, unknown>
        : {}
    const stopRaw = input.stop && typeof input.stop === 'object' && !Array.isArray(input.stop)
        ? input.stop as Record<string, unknown>
        : {}
    const trustedCandidate = input.trustedPython ?? input.trusted_python
    const trustedRaw = trustedCandidate && typeof trustedCandidate === 'object' && !Array.isArray(trustedCandidate)
        ? trustedCandidate as Record<string, unknown>
        : {}
    const expiresAt = parseOptionalDateMs(stopRaw.expiresAt ?? stopRaw.expires_at)
    const parsed = MicroscriptManifestSchema.parse({
        description: typeof input.description === 'string' ? input.description : '',
        runtime: input.runtime ?? input.mode ?? input.executionMode ?? input.execution_mode,
        trustedPython: {
            allowImports: boolAlias(trustedRaw, 'allowImports', 'allow_imports'),
            allowNetwork: boolAlias(trustedRaw, 'allowNetwork', 'allow_network'),
            allowPrivateNetwork: boolAlias(trustedRaw, 'allowPrivateNetwork', 'allow_private_network'),
            allowWorkspaceFiles: boolAlias(trustedRaw, 'allowWorkspaceFiles', 'allow_workspace_files'),
            allowEnvironment: boolAlias(trustedRaw, 'allowEnvironment', 'allow_environment'),
            allowShell: boolAlias(trustedRaw, 'allowShell', 'allow_shell'),
        },
        schedule,
        permissions: normalizePermissions(input.permissions),
        limits: {
            timeoutMs: numberAlias(limitsRaw, 'timeoutMs', 'timeout_ms') ?? parseDurationMs(limitsRaw.timeout) ?? undefined,
            maxPhases: numberAlias(limitsRaw, 'maxPhases', 'max_phases'),
            minIntervalMs: numberAlias(limitsRaw, 'minIntervalMs', 'min_interval_ms') ?? parseDurationMs(limitsRaw.min_interval),
            maxOutputBytes: numberAlias(limitsRaw, 'maxOutputBytes', 'max_output_bytes'),
            maxConsecutiveFailures: numberAlias(limitsRaw, 'maxConsecutiveFailures', 'max_consecutive_failures'),
            maxRuns: numberAlias(limitsRaw, 'maxRuns', 'max_runs'),
        },
        stop: {
            completeOnNotification: boolAlias(stopRaw, 'completeOnNotification', 'complete_on_notification'),
            persistent: boolAlias(stopRaw, 'persistent'),
            expiresAt: expiresAt ?? (stopRaw.expiresAt === null || stopRaw.expires_at === null ? null : undefined),
        },
    })
    return parsed
}

function normalizePermissions(raw: unknown): unknown[] {
    if (!Array.isArray(raw)) return []
    return raw.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item
        const p = item as Record<string, unknown>
        switch (p.kind) {
            case 'home_assistant_read':
                return {
                    kind: p.kind,
                    allowAll: p.allowAll ?? p.allow_all,
                    entityIds: p.entityIds ?? p.entity_ids,
                    domains: p.domains,
                    allowList: p.allowList ?? p.allow_list,
                    allowHistory: p.allowHistory ?? p.allow_history,
                }
            case 'home_assistant_call_service': {
                const services = Array.isArray(p.services)
                    ? p.services.map((s) => {
                        if (!s || typeof s !== 'object' || Array.isArray(s)) return s
                        const service = s as Record<string, unknown>
                        return {
                            domain: service.domain,
                            service: service.service,
                            entityIds: service.entityIds ?? service.entity_ids,
                        }
                    })
                    : p.services
                return {
                    kind: p.kind,
                    allowAll: p.allowAll ?? p.allow_all,
                    domains: p.domains,
                    services,
                }
            }
            case 'tool_call':
                return {
                    kind: p.kind,
                    toolIds: p.toolIds ?? p.tool_ids,
                    toolPatterns: p.toolPatterns ?? p.tool_patterns,
                    allowIntegrationTools: p.allowIntegrationTools ?? p.allow_integration_tools,
                    allowOrchestratorOnly: p.allowOrchestratorOnly ?? p.allow_orchestrator_only,
                    maxCallsPerRun: p.maxCallsPerRun ?? p.max_calls_per_run,
                }
            case 'agent_wake':
                return {
                    kind: p.kind,
                    agentIds: p.agentIds ?? p.agent_ids,
                    maxPromptChars: p.maxPromptChars ?? p.max_prompt_chars,
                    allowNotifyInbox: p.allowNotifyInbox ?? p.allow_notify_inbox,
                }
            case 'http_fetch':
                return {
                    kind: p.kind,
                    allowedHosts: p.allowedHosts ?? p.allowed_hosts,
                    methods: Array.isArray(p.methods)
                        ? p.methods.map((m) => typeof m === 'string' ? m.toUpperCase() : m)
                        : undefined,
                    allowPrivateNetwork: p.allowPrivateNetwork ?? p.allow_private_network,
                    maxBytes: p.maxBytes ?? p.max_bytes,
                }
            default:
                return p
        }
    })
}

function compactScript(script: Microscript): Record<string, unknown> {
    return {
        script_id: script.id,
        title: script.title,
        enabled: script.enabled,
        status: script.status,
        runtime: script.manifest.runtime,
        schedule: script.manifest.schedule,
        permission_count: script.manifest.permissions.length,
        next_run: script.nextRunAt ? new Date(script.nextRunAt).toISOString() : null,
        last_run: script.lastRunAt ? new Date(script.lastRunAt).toISOString() : null,
        last_run_status: script.lastRunStatus,
        last_run_error: script.lastRunError,
        run_count: script.runCount,
        consecutive_failures: script.consecutiveFailures,
        expires_at: script.manifest.stop.expiresAt ? new Date(script.manifest.stop.expiresAt).toISOString() : null,
    }
}

export const microscriptDescribeCapabilitiesTool: ToolDef = {
    id: 'microscript_describe_capabilities',
    name: 'microscript_describe_capabilities',
    description: 'Describe the Microscripts subsystem: trusted Python runtime, supported permissions, helper APIs, blocked-action guidance, lifecycle defaults, and stop policies.',
    input_schema: { type: 'object', properties: {} },
    tags: ['microscripts'],
}

export async function executeMicroscriptDescribeCapabilities(): Promise<ToolResult> {
    return {
        success: true,
        data: {
            contract: [
                'Default runtime is trusted_python: Python code defines run(ctx), may use normal stdlib imports, and returns a JSON-serializable dict.',
                'Runs are short-lived. Do not sleep or loop forever; return nextCheckAfterMs or nextRunAt.',
                'Runs may be triggered manually, on an interval, or by an inbound webhook subscription.',
                'ctx is dict-like and also exposes helpers: ctx.notify, ctx.http_fetch, ctx.file_read, ctx.file_write, ctx.call_tool, ctx.continue_after, ctx.complete, ctx.pause.',
                'trusted_python direct networking is allowed by default; direct file access is confined to the script workspace; env secrets and shell/process control are blocked by default.',
                'A script with agent_wake permission may wake a text agent after its deterministic gate passes; the woken agent receives the script prompt plus read-only/context tools, may activate exactly relevant capabilities for context, and may call notify_inbox if allowed.',
                'Parent-mediated helpers still enforce manifest permissions when they touch app integrations, Inbox notifications, or app tools.',
                'Any blocked action error includes why it was blocked, a safe alternative, and instructions to ask the user/record AGENT_NEEDS.md if implementation is needed.',
                'Use ctx["state"] for durable private state and return {"state": {...}} with the full next state.',
            ],
            webhook_trigger: {
                trigger: 'ctx["trigger"] == "webhook"',
                context: 'ctx["webhook"] contains eventId, endpointId, slug, source, eventType, dedupeKey, occurredAt, receivedAt, payload, and normalized.',
                follow_up: 'Return nextCheckAfterMs/nextRunAt only when the webhook event needs a later follow-up run.',
            },
            schedule_contract: {
                manual: 'manifest.schedule={kind:"manual"} means no timed polling; manual runs and webhook dispatch can still invoke the script.',
                interval: 'manifest.schedule={kind:"interval", every:"5m"} or everyMs schedules timed polling through the Microscripts heartbeat.',
            },
            response_shape: {
                summary: 'optional short run summary',
                state: 'optional full state object for next run',
                requests: 'optional list of operations; results are available next phase under ctx["results"][request_id]',
                status: 'continue | pause | complete',
                nextCheckAfterMs: 'optional delay before next run',
                nextRunAt: 'optional absolute epoch ms',
            },
            trusted_python_policy: {
                allowImports: 'default true',
                allowNetwork: 'default true',
                allowPrivateNetwork: 'default true',
                allowWorkspaceFiles: 'default true, confined to script workspace',
                allowEnvironment: 'default false; app/user secrets are never passed to Python',
                allowShell: 'default false',
            },
            operation_kinds: [
                'notify.inbox',
                'agent.wake',
                'home_assistant.get_state',
                'home_assistant.list_states',
                'home_assistant.history',
                'home_assistant.call_service',
                'http.fetch',
                'tool.call',
                'file.read',
                'file.write',
            ],
            defaults: {
                default_expiry: '24h unless stop.persistent=true or stop.expiresAt is set',
                min_interval: '60s',
                timeout: '5s per Python phase',
                max_phases: 4,
                max_consecutive_failures: 5,
            },
        },
    }
}

export const microscriptCreateTool: ToolDef = {
    id: 'microscript_create',
    name: 'microscript_create',
    description: [
        'Create a production Microscript from Python code plus a manifest.',
        'The only runtime is trusted_python: normal Python controlled by app lifecycle, sandbox policy, and manifest permissions.',
        'Use only for short-lived or clearly bounded automation. Include an explicit stop policy: completeOnNotification, expiresAt, maxRuns, or persistent=true when the user really wants it ongoing.',
        'Use agent_wake only when a cheap deterministic gate should escalate to model judgement after matching; keep agent ids and prompt size bounded.',
        'If an action is blocked, tell the user why, suggest the safe alternative, and request a manifest/runtime implementation change when truly needed.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            title: { type: 'string' },
            code: { type: 'string', description: 'Python code defining run(ctx).' },
            manifest: { type: 'object', description: 'MicroscriptManifest. schedule.every may be a duration string such as "5m"; microscript_describe_capabilities includes the schedule shapes.' },
            enabled: { type: 'boolean' },
            initial_state: { type: 'object' },
        },
        required: ['title', 'code', 'manifest'],
    },
    tags: ['microscripts'],
}

export async function executeMicroscriptCreate(args: Record<string, unknown>): Promise<ToolResult> {
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    const code = typeof args.code === 'string' ? args.code : ''
    if (!title) return { success: false, error: 'title is required.' }
    if (!code.trim()) return { success: false, error: 'code is required.' }
    let manifest: MicroscriptManifest
    try {
        manifest = normalizeManifest(args.manifest)
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Invalid manifest.' }
    }
    const validation = await validateMicroscriptCode(code)
    if (!validation.ok) return { success: false, error: validation.error }
    const initialState = args.initial_state && typeof args.initial_state === 'object' && !Array.isArray(args.initial_state)
        ? args.initial_state as Record<string, unknown>
        : {}
    const script = createMicroscript({
        title,
        code,
        manifest,
        enabled: args.enabled !== false,
        initialState,
        createdBy: 'orchestrator',
    })
    await syncHeartbeatBestEffort()
    return { success: true, data: compactScript(script) }
}

export const microscriptListTool: ToolDef = {
    id: 'microscript_list',
    name: 'microscript_list',
    description: 'List Microscripts with status, schedule, next run, failures, and expiry.',
    input_schema: {
        type: 'object',
        properties: {
            enabled: { type: 'boolean' },
            status: { type: 'string', description: 'active, running, paused, completed, expired, error' },
        },
    },
    tags: ['microscripts'],
}

export async function executeMicroscriptList(args: Record<string, unknown>): Promise<ToolResult> {
    const status = typeof args.status === 'string' ? MicroscriptStatusSchema.safeParse(args.status).data : undefined
    if (args.status !== undefined && !status) return { success: false, error: `Unknown status "${String(args.status)}".` }
    const scripts = listMicroscripts({
        enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
        status,
    })
    return { success: true, data: { count: scripts.length, scripts: scripts.map(compactScript) } }
}

export const microscriptGetTool: ToolDef = {
    id: 'microscript_get',
    name: 'microscript_get',
    description: 'Get one Microscript with manifest, state, recent runs, and recent events.',
    input_schema: {
        type: 'object',
        properties: {
            script_id: { type: 'string' },
            include_code: { type: 'boolean' },
            event_limit: { type: 'number' },
            run_limit: { type: 'number' },
        },
        required: ['script_id'],
    },
    tags: ['microscripts'],
}

export async function executeMicroscriptGet(args: Record<string, unknown>): Promise<ToolResult> {
    const id = typeof args.script_id === 'string' ? args.script_id.trim() : ''
    if (!id) return { success: false, error: 'script_id is required.' }
    const script = getMicroscript(id)
    if (!script) return { success: false, error: `No microscript with id ${id}.` }
    return {
        success: true,
        data: {
            ...compactScript(script),
            manifest: script.manifest,
            state: script.state,
            code_hash: script.codeHash,
            ...(args.include_code === true ? { code: script.code } : {}),
            runs: listMicroscriptRuns(id, Math.floor(Number(args.run_limit) || 20)),
            events: listMicroscriptEvents(id, Math.floor(Number(args.event_limit) || 30)),
        },
    }
}

export const microscriptUpdateTool: ToolDef = {
    id: 'microscript_update',
    name: 'microscript_update',
    description: 'Patch a Microscript title, code, manifest, enabled state, or private state. Revalidates code and manifest.',
    input_schema: {
        type: 'object',
        properties: {
            script_id: { type: 'string' },
            title: { type: 'string' },
            code: { type: 'string' },
            manifest: { type: 'object' },
            enabled: { type: 'boolean' },
            state: { type: 'object' },
        },
        required: ['script_id'],
    },
    tags: ['microscripts'],
}

export async function executeMicroscriptUpdate(args: Record<string, unknown>): Promise<ToolResult> {
    const id = typeof args.script_id === 'string' ? args.script_id.trim() : ''
    if (!id) return { success: false, error: 'script_id is required.' }
    const existing = getMicroscript(id)
    if (!existing) return { success: false, error: `No microscript with id ${id}.` }
    const patch: Parameters<typeof updateMicroscript>[1] = {}
    if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim()
    if (args.manifest !== undefined) {
        try { patch.manifest = normalizeManifest(args.manifest) }
        catch (err) { return { success: false, error: err instanceof Error ? err.message : 'Invalid manifest.' } }
    }
    if (typeof args.code === 'string') {
        const validation = await validateMicroscriptCode(args.code)
        if (!validation.ok) return { success: false, error: validation.error }
        patch.code = args.code
    }
    if (typeof args.enabled === 'boolean') patch.enabled = args.enabled
    if (args.state && typeof args.state === 'object' && !Array.isArray(args.state)) {
        patch.state = args.state as Record<string, unknown>
    }
    const script = updateMicroscript(id, patch)
    if (!script) return { success: false, error: `No microscript with id ${id}.` }
    await syncHeartbeatBestEffort()
    return { success: true, data: compactScript(script) }
}

export const microscriptPauseTool: ToolDef = {
    id: 'microscript_pause',
    name: 'microscript_pause',
    description: 'Pause a Microscript. Use this as soon as the script is no longer needed.',
    input_schema: {
        type: 'object',
        properties: {
            script_id: { type: 'string' },
            reason: { type: 'string' },
        },
        required: ['script_id'],
    },
    tags: ['microscripts'],
}

export async function executeMicroscriptPause(args: Record<string, unknown>): Promise<ToolResult> {
    const id = typeof args.script_id === 'string' ? args.script_id.trim() : ''
    if (!id) return { success: false, error: 'script_id is required.' }
    const script = setMicroscriptStatus(id, 'paused', {
        enabled: false,
        nextRunAt: null,
        reason: typeof args.reason === 'string' ? args.reason : undefined,
    })
    await syncHeartbeatBestEffort()
    return script ? { success: true, data: compactScript(script) } : { success: false, error: `No microscript with id ${id}.` }
}

export const microscriptResumeTool: ToolDef = {
    id: 'microscript_resume',
    name: 'microscript_resume',
    description: 'Resume a paused Microscript and recompute its next run from the manifest schedule.',
    input_schema: {
        type: 'object',
        properties: { script_id: { type: 'string' } },
        required: ['script_id'],
    },
    tags: ['microscripts'],
}

export async function executeMicroscriptResume(args: Record<string, unknown>): Promise<ToolResult> {
    const id = typeof args.script_id === 'string' ? args.script_id.trim() : ''
    if (!id) return { success: false, error: 'script_id is required.' }
    const script = updateMicroscript(id, { enabled: true })
    await syncHeartbeatBestEffort()
    return script ? { success: true, data: compactScript(script) } : { success: false, error: `No microscript with id ${id}.` }
}

export const microscriptDeleteTool: ToolDef = {
    id: 'microscript_delete',
    name: 'microscript_delete',
    description: 'Delete a Microscript and its run/event history.',
    input_schema: {
        type: 'object',
        properties: { script_id: { type: 'string' } },
        required: ['script_id'],
    },
    tags: ['microscripts'],
}

export async function executeMicroscriptDelete(args: Record<string, unknown>): Promise<ToolResult> {
    const id = typeof args.script_id === 'string' ? args.script_id.trim() : ''
    if (!id) return { success: false, error: 'script_id is required.' }
    const deleted = deleteMicroscript(id)
    await syncHeartbeatBestEffort()
    return deleted ? { success: true, data: { script_id: id, deleted: true } } : { success: false, error: `No microscript with id ${id}.` }
}

export const microscriptRunNowTool: ToolDef = {
    id: 'microscript_run_now',
    name: 'microscript_run_now',
    description: 'Run a Microscript immediately for testing or manual execution. Does not re-enable a paused script.',
    input_schema: {
        type: 'object',
        properties: { script_id: { type: 'string' } },
        required: ['script_id'],
    },
    tags: ['microscripts'],
}

export async function executeMicroscriptRunNow(args: Record<string, unknown>): Promise<ToolResult> {
    const id = typeof args.script_id === 'string' ? args.script_id.trim() : ''
    if (!id) return { success: false, error: 'script_id is required.' }
    const script = getMicroscript(id)
    if (!script) return { success: false, error: `No microscript with id ${id}.` }
    if (script.status === 'running') return { success: false, error: 'Microscript is already running.' }
    setMicroscriptStatus(id, 'running', { enabled: script.enabled, nextRunAt: null, reason: 'manual run' })
    const result = await runMicroscript(script, { trigger: 'manual', preserveEnabled: true })
    await syncHeartbeatBestEffort()
    return { success: result.ok, data: result, error: result.ok ? undefined : result.error }
}

export const microscriptGetRunTool: ToolDef = {
    id: 'microscript_get_run',
    name: 'microscript_get_run',
    description: 'Get a recent Microscript run by id.',
    input_schema: {
        type: 'object',
        properties: {
            run_id: { type: 'string' },
        },
        required: ['run_id'],
    },
    tags: ['microscripts'],
}

export async function executeMicroscriptGetRun(args: Record<string, unknown>): Promise<ToolResult> {
    const runId = typeof args.run_id === 'string' ? args.run_id.trim() : ''
    if (!runId) return { success: false, error: 'run_id is required.' }
    const { getMicroscriptRun } = await import('@/lib/microscripts/store')
    const run = getMicroscriptRun(runId)
    return run ? { success: true, data: run } : { success: false, error: `No microscript run with id ${runId}.` }
}

async function syncHeartbeatBestEffort(): Promise<void> {
    try {
        const { syncMicroscriptsActivation } = await import('@/lib/microscripts/heartbeat')
        await syncMicroscriptsActivation()
    } catch {
        // Boot hook and event listener also reconcile. Do not fail lifecycle ops.
    }
}

export const microscriptTools: ToolDef[] = [
    microscriptDescribeCapabilitiesTool,
    microscriptCreateTool,
    microscriptListTool,
    microscriptGetTool,
    microscriptUpdateTool,
    microscriptPauseTool,
    microscriptResumeTool,
    microscriptDeleteTool,
    microscriptRunNowTool,
    microscriptGetRunTool,
]
