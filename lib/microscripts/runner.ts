import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'

import { WORKSPACE_DIR } from '@/lib/runtime-paths'
import { createInboxConversation } from '@/lib/scheduling/store'
import { sendInboxPushNotification } from '@/lib/push-notifications'
import { normalizeInboxReplyActions } from '@/lib/ai/tools/notify'
import type { ToolExecutionContext } from '@/lib/ai/agents/types'
import type { InboxReplyAction, Message } from '@/lib/types'

import {
    MicroscriptOperationSchema,
    MicroscriptRunResponseSchema,
    type Microscript,
    type MicroscriptOperation,
    type MicroscriptPermission,
    type MicroscriptRunResponse,
} from './schema'
import {
    computeDefaultNextRun,
    finishMicroscriptRun,
    recordMicroscriptEvent,
} from './store'

// ---------------------------------------------------------------------------
// Python runner.
// ---------------------------------------------------------------------------

const PYTHON_WRAPPER = String.raw`
import ast
import json
import sys
import traceback

FORBIDDEN_NODES = (
    ast.Import,
    ast.ImportFrom,
    ast.AsyncFunctionDef,
    ast.ClassDef,
    ast.With,
    ast.AsyncWith,
)
FORBIDDEN_NAMES = {
    "open", "input", "eval", "exec", "compile", "__import__",
    "globals", "locals", "vars", "dir", "getattr", "setattr", "delattr",
    "breakpoint", "help", "memoryview",
}

logs = []

def safe_print(*args, **kwargs):
    sep = kwargs.get("sep", " ")
    end = kwargs.get("end", "\n")
    logs.append(sep.join(str(a) for a in args) + end)

SAFE_BUILTINS = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "Exception": Exception,
    "float": float,
    "int": int,
    "isinstance": isinstance,
    "len": len,
    "list": list,
    "max": max,
    "min": min,
    "pow": pow,
    "print": safe_print,
    "range": range,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "ValueError": ValueError,
    "zip": zip,
}

def fail(message):
    print(json.dumps({"ok": False, "error": message, "logs": logs}), flush=True)

try:
    payload = json.loads(sys.stdin.read())
    code = payload["code"]
    ctx = payload["ctx"]
    validate_only = bool(payload.get("validateOnly"))
    tree = ast.parse(code, filename="<microscript>", mode="exec")
    for node in ast.walk(tree):
        if isinstance(node, FORBIDDEN_NODES):
            fail(f"Forbidden Python construct: {type(node).__name__}")
            sys.exit(0)
        if isinstance(node, ast.Name):
            if node.id.startswith("__") or node.id in FORBIDDEN_NAMES:
                fail(f"Forbidden Python name: {node.id}")
                sys.exit(0)
        if isinstance(node, ast.Attribute):
            if node.attr.startswith("__"):
                fail(f"Forbidden Python attribute: {node.attr}")
                sys.exit(0)
    if validate_only:
        print(json.dumps({"ok": True, "result": {}, "logs": logs}), flush=True)
        sys.exit(0)
    globals_dict = {"__builtins__": SAFE_BUILTINS, "__name__": "microscript"}
    locals_dict = {}
    exec(compile(tree, "<microscript>", "exec"), globals_dict, locals_dict)
    run = locals_dict.get("run") or globals_dict.get("run")
    if not callable(run):
        fail("Microscript must define run(ctx).")
        sys.exit(0)
    result = run(ctx)
    json.dumps(result)
    print(json.dumps({"ok": True, "result": result, "logs": logs}), flush=True)
except BaseException as exc:
    fail(type(exc).__name__ + ": " + str(exc) + "\n" + traceback.format_exc(limit=4))
`

interface PythonPhaseResult {
    response: MicroscriptRunResponse
    logs: string[]
}

interface OperationResult {
    ok: boolean
    data?: unknown
    error?: string
}

interface PendingNotification {
    title?: string
    body: string
    actions?: InboxReplyAction[]
}

export interface RunMicroscriptOptions {
    trigger: 'schedule' | 'manual' | 'webhook'
    now?: number
    /** Used by Run now on paused scripts: test without re-enabling. */
    preserveEnabled?: boolean
    /** Present when a generic inbound webhook triggered this run. */
    webhook?: MicroscriptWebhookContext
}

export interface MicroscriptWebhookContext {
    eventId: string
    endpointId: string
    slug: string
    source: string
    eventType: string
    dedupeKey: string
    occurredAt: number
    receivedAt: number
    payload: Record<string, unknown>
    normalized: Record<string, unknown>
}

export interface RunMicroscriptResult {
    ok: boolean
    summary: string
    error?: string
    surfaced: boolean
    conversationId: string | null
}

export async function validateMicroscriptCode(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
        fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
        const raw = await spawnPython(JSON.stringify({
            code,
            ctx: {},
            validateOnly: true,
        }), {
            cwd: WORKSPACE_DIR,
            timeoutMs: 3_000,
            maxOutputBytes: 32_000,
        })
        const parsed = JSON.parse(raw.stdout.trim()) as { ok?: unknown; error?: unknown }
        if (parsed.ok === true) return { ok: true }
        return { ok: false, error: typeof parsed.error === 'string' ? parsed.error : 'Python validation failed.' }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
}

export async function runMicroscript(
    script: Microscript,
    options: RunMicroscriptOptions,
): Promise<RunMicroscriptResult> {
    const startedAt = options.now ?? Date.now()
    const operationResults: Record<string, OperationResult> = {}
    const pendingNotifications: PendingNotification[] = []
    const inboxConversationId = `inbox_${randomUUID()}`
    let state: Record<string, unknown> = { ...script.state }
    let lastResponse: MicroscriptRunResponse = {}
    let phases = 0
    let operations = 0
    let summary = 'Microscript ran.'
    let ok = false
    let error: string | undefined
    let surfaced = false
    let conversationId: string | null = null

    try {
        for (let phase = 1; phase <= script.manifest.limits.maxPhases; phase++) {
            phases = phase
            const phaseResult = await runPythonPhase(script, {
                now: Date.now(),
                trigger: options.trigger,
                webhook: options.webhook ?? null,
                phase,
                state,
                results: operationResults,
            })
            lastResponse = phaseResult.response
            if (lastResponse.state) state = lastResponse.state
            if (lastResponse.summary) summary = lastResponse.summary
            if (phaseResult.logs.length > 0) {
                recordMicroscriptEvent(script.id, 'python_logs', {
                    phase,
                    logs: phaseResult.logs.join('').slice(0, 4_000),
                })
            }

            const requests = lastResponse.requests ?? []
            if (requests.length === 0) break
            if (phase === script.manifest.limits.maxPhases) {
                throw new Error(`Microscript returned requests in final phase (maxPhases=${script.manifest.limits.maxPhases}).`)
            }
            let newRequests = 0
            for (const [index, request] of requests.entries()) {
                const key = operationKey(request, index)
                if (operationResults[key]) continue
                newRequests += 1
                operations += 1
                const result = await executeOperation(script, request, pendingNotifications, inboxConversationId)
                operationResults[key] = result
                recordMicroscriptEvent(script.id, result.ok ? 'operation_ok' : 'operation_error', {
                    key,
                    kind: request.kind,
                    error: result.error ?? null,
                })
            }
            if (newRequests === 0) break
        }

        if (pendingNotifications.length > 0) {
            conversationId = postMicroscriptInbox(script, pendingNotifications, inboxConversationId)
            surfaced = true
        }

        const now = Date.now()
        const requestedStatus = lastResponse.status
        let status = chooseFinalStatus(script, requestedStatus, pendingNotifications.length > 0, now)
        if (options.preserveEnabled && !script.enabled && status === 'active') status = 'paused'
        const nextRunAt = status === 'active'
            ? chooseNextRunAt(script, lastResponse, now)
            : null
        const enabled = status === 'active'
        ok = true

        finishMicroscriptRun(script.id, {
            ok: true,
            trigger: options.trigger,
            startedAt,
            summary: summaryForRun(script, summary, status, nextRunAt, operations),
            state,
            status,
            enabled,
            nextRunAt,
            phases,
            operations,
            surfaced,
            conversationId,
        })

        return {
            ok: true,
            summary,
            surfaced,
            conversationId,
        }
    } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        summary = `Microscript failed: ${error}`
        const retryAt = script.manifest.schedule.kind === 'interval'
            ? computeDefaultNextRun(script, Date.now())
            : null
        finishMicroscriptRun(script.id, {
            ok: false,
            trigger: options.trigger,
            startedAt,
            summary,
            error,
            state,
            status: 'error',
            enabled: script.enabled,
            nextRunAt: retryAt,
            phases,
            operations,
            surfaced: false,
            conversationId: null,
        })
        return { ok, summary, error, surfaced: false, conversationId: null }
    }
}

async function runPythonPhase(
    script: Microscript,
    ctx: Record<string, unknown>,
): Promise<PythonPhaseResult> {
    const cwd = scriptWorkDir(script.id)
    fs.mkdirSync(cwd, { recursive: true })
    const payload = JSON.stringify({
        code: script.code,
        ctx: {
            script: {
                id: script.id,
                title: script.title,
                description: script.manifest.description,
            },
            manifest: {
                schedule: script.manifest.schedule,
                stop: script.manifest.stop,
            },
            ...ctx,
        },
    })
    const raw = await spawnPython(payload, {
        cwd,
        timeoutMs: script.manifest.limits.timeoutMs,
        maxOutputBytes: script.manifest.limits.maxOutputBytes,
    })

    let parsed: unknown
    try {
        parsed = JSON.parse(raw.stdout.trim())
    } catch {
        const stderr = raw.stderr.trim()
        throw new Error(`Python returned non-JSON output.${stderr ? ` stderr: ${stderr.slice(0, 1000)}` : ''}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Python returned an invalid envelope.')
    }
    const envelope = parsed as { ok?: unknown; result?: unknown; error?: unknown; logs?: unknown }
    const logs = Array.isArray(envelope.logs)
        ? envelope.logs.filter((v): v is string => typeof v === 'string').slice(0, 50)
        : []
    if (envelope.ok !== true) {
        throw new Error(typeof envelope.error === 'string' ? envelope.error : 'Python execution failed.')
    }
    const response = MicroscriptRunResponseSchema.parse(envelope.result ?? {})
    return { response, logs }
}

function spawnPython(
    input: string,
    options: { cwd: string; timeoutMs: number; maxOutputBytes: number },
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn('python3', ['-I', '-S', '-c', PYTHON_WRAPPER], {
            cwd: options.cwd,
            env: {
                ...process.env,
                PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
                PYTHONIOENCODING: 'utf-8',
                PYTHONDONTWRITEBYTECODE: '1',
            },
            stdio: 'pipe',
        })
        let stdout = ''
        let stderr = ''
        let settled = false
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            child.kill('SIGKILL')
            reject(new Error(`Python timed out after ${options.timeoutMs}ms.`))
        }, options.timeoutMs)

        child.on('error', (err) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(new Error(`Could not start python3: ${err.message}`))
        })
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf-8')
            if (stdout.length + stderr.length > options.maxOutputBytes && !settled) {
                settled = true
                clearTimeout(timer)
                child.kill('SIGKILL')
                reject(new Error(`Python output exceeded ${options.maxOutputBytes} bytes.`))
            }
        })
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf-8')
            if (stdout.length + stderr.length > options.maxOutputBytes && !settled) {
                settled = true
                clearTimeout(timer)
                child.kill('SIGKILL')
                reject(new Error(`Python output exceeded ${options.maxOutputBytes} bytes.`))
            }
        })
        child.on('close', (code, signal) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (code !== 0) {
                reject(new Error(`Python exited with code ${code ?? signal ?? 'unknown'}: ${stderr.slice(0, 1000)}`))
                return
            }
            resolve({ stdout, stderr })
        })
        child.stdin.end(input)
    })
}

async function executeOperation(
    script: Microscript,
    request: MicroscriptOperation,
    notifications: PendingNotification[],
    conversationId: string,
): Promise<OperationResult> {
    try {
        const parsed = MicroscriptOperationSchema.parse(request)
        switch (parsed.kind) {
            case 'notify.inbox':
                requirePermission(script, 'notify_inbox')
                notifications.push({
                    title: parsed.title,
                    body: parsed.body,
                    actions: normalizeInboxReplyActions(parsed.actions),
                })
                return { ok: true, data: { queued: true } }
            case 'agent.wake':
                return {
                    ok: true,
                    data: await executeAgentWake(script, parsed, notifications, conversationId),
                }
            case 'home_assistant.get_state':
                assertHomeAssistantRead(script, [parsed.entity_id], false, false)
                return { ok: true, data: await homeAssistantGetState(parsed.entity_id) }
            case 'home_assistant.list_states':
                assertHomeAssistantRead(script, [], true, false, parsed.domain)
                return {
                    ok: true,
                    data: await homeAssistantListStates({
                        domain: parsed.domain,
                        query: parsed.query,
                        includeAttributes: parsed.include_attributes === true,
                        maxResults: parsed.max_results ?? 100,
                    }),
                }
            case 'home_assistant.history':
                assertHomeAssistantRead(script, parsed.entity_ids, false, true)
                return {
                    ok: true,
                    data: await homeAssistantHistory({
                        entityIds: parsed.entity_ids,
                        startTime: parsed.start_time,
                        endTime: parsed.end_time,
                        noAttributes: true,
                        significantChangesOnly: true,
                        maxStateChanges: parsed.max_state_changes ?? 300,
                    }),
                }
            case 'home_assistant.call_service':
                assertHomeAssistantWrite(script, parsed)
                return {
                    ok: true,
                    data: await homeAssistantCallService({
                        domain: parsed.domain,
                        service: parsed.service,
                        target: parsed.target,
                        data: parsed.data,
                        confirmed: true,
                        reason: parsed.reason ?? `Microscript ${script.title} (${script.id})`,
                        returnResponse: parsed.return_response === true,
                    }),
                }
            case 'http.fetch':
                return { ok: true, data: await executeHttpFetch(script, parsed) }
            case 'file.read':
                return { ok: true, data: executeFileRead(script, parsed.path) }
            case 'file.write':
                return { ok: true, data: executeFileWrite(script, parsed.path, parsed.content, parsed.append === true) }
        }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
}

async function executeAgentWake(
    script: Microscript,
    request: Extract<MicroscriptOperation, { kind: 'agent.wake' }>,
    notifications: PendingNotification[],
    conversationId: string,
): Promise<Record<string, unknown>> {
    const permission = assertAgentWake(script, request)
    const { getAgent } = await import('@/lib/ai/agents/registry')
    const { runTextSubAgent } = await import('@/lib/ai/agents/runner')
    const baseAgent = getAgent(request.agent_id)
    if (!baseAgent) throw new Error(`Unknown agent: ${request.agent_id}`)
    if (baseAgent.kind !== 'text') throw new Error(`Microscript agent.wake only supports text agents; ${request.agent_id} is kind=${baseAgent.kind}.`)

    const target = {
        ...baseAgent,
        tools: permission.allowNotifyInbox ? ['notify_inbox'] : [],
        builtins: [],
        canCallAgents: [],
    }
    const prompt = buildAgentWakePrompt(script, request.prompt, permission.allowNotifyInbox)
    const notificationsBefore = notifications.length

    const parentCtx: ToolExecutionContext = {
        callerAgentId: '__microscripts__',
        depth: 0,
        conversationId,
        parentRequestId: `microscript_${script.id}_${randomUUID()}`,
        onAgentEvent: (event) => {
            if (event.type !== 'agent_tool_call' || event.toolCall?.name !== 'notify_inbox') return
            const args = event.toolCall.arguments as { title?: unknown; body?: unknown; actions?: unknown }
            const body = typeof args.body === 'string' ? args.body.trim() : ''
            if (!body) return
            notifications.push({
                title: typeof args.title === 'string' ? args.title.trim() : undefined,
                body,
                actions: normalizeInboxReplyActions(args.actions),
            })
        },
    }

    const result = await runTextSubAgent({ target, prompt, parentCtx })
    if (!result.success) {
        throw new Error(result.error ?? `Agent ${request.agent_id} wake failed.`)
    }
    const data = result.data as { output?: unknown } | undefined
    const output = typeof data?.output === 'string' ? data.output : ''
    return {
        agent_id: request.agent_id,
        output,
        notified: notifications.length > notificationsBefore,
        notification_count: notifications.length - notificationsBefore,
    }
}

function buildAgentWakePrompt(script: Microscript, prompt: string, allowNotifyInbox: boolean): string {
    return [
        'You were woken by a Microscript after a deterministic runtime condition matched.',
        'Use only the context supplied in this prompt. Do not assume you can perform source-side actions.',
        allowNotifyInbox
            ? 'If the user should be interrupted, call notify_inbox with a specific title and concise body. If the item is not worth interrupting the user about, do not call notify_inbox; return a short internal summary.'
            : 'Do not notify the user. Return a short internal summary with your judgement.',
        'When a notification asks for a decision, include notify_inbox actions with short labels and exact reply values.',
        '',
        `Microscript: ${script.title} (${script.id})`,
        `Description: ${script.manifest.description}`,
        '',
        '<microscript_payload>',
        prompt,
        '</microscript_payload>',
    ].join('\n')
}

function operationKey(operation: MicroscriptOperation, index: number): string {
    const raw = 'id' in operation && typeof operation.id === 'string'
        ? operation.id
        : `${operation.kind}:${index}:${hash(JSON.stringify(operation))}`
    return raw.slice(0, 160)
}

function hash(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function chooseFinalStatus(
    script: Microscript,
    requested: MicroscriptRunResponse['status'],
    notified: boolean,
    now: number,
): 'active' | 'paused' | 'completed' | 'expired' {
    if (script.manifest.stop.expiresAt !== null && script.manifest.stop.expiresAt <= now) return 'expired'
    if (requested === 'pause') return 'paused'
    if (requested === 'complete') return 'completed'
    if (notified && script.manifest.stop.completeOnNotification && requested !== 'continue') return 'completed'
    return 'active'
}

function chooseNextRunAt(script: Microscript, response: MicroscriptRunResponse, now: number): number | null {
    let requested: number | null = null
    if (response.nextRunAt !== undefined) requested = response.nextRunAt
    else if (response.nextCheckAfterMs !== undefined) requested = now + response.nextCheckAfterMs
    else requested = computeDefaultNextRun(script, now)

    if (requested === null) return null
    const minNext = now + script.manifest.limits.minIntervalMs
    return Math.max(requested, minNext)
}

function summaryForRun(
    script: Microscript,
    summary: string,
    status: string,
    nextRunAt: number | null,
    operations: number,
): string {
    return [
        summary || `Microscript ${script.title} ran.`,
        `Status: ${status}.`,
        `Operations: ${operations}.`,
        `Next run: ${nextRunAt ? new Date(nextRunAt).toISOString() : 'none'}.`,
    ].join('\n')
}

function postMicroscriptInbox(script: Microscript, notifications: PendingNotification[], conversationId: string): string {
    const now = Date.now()
    const body = notifications
        .map((n) => n.title ? `**${n.title}**\n\n${n.body}` : n.body)
        .join('\n\n---\n\n')
    const actions = notifications.flatMap((n) => n.actions ?? [])
    const title = notifications.length === 1 && notifications[0]?.title
        ? notifications[0].title
        : script.title
    const assistantMsg: Message = {
        id: `msg_${randomUUID()}`,
        role: 'assistant',
        content: body,
        replyActions: actions.length > 0 ? actions : undefined,
        timestamp: now,
    }
    createInboxConversation({
        id: conversationId,
        taskId: script.id,
        title,
        messages: [assistantMsg],
    })
    void sendInboxPushNotification({
        conversationId,
        title,
        body,
    })
    return conversationId
}

function requirePermission(script: Microscript, kind: MicroscriptPermission['kind']): MicroscriptPermission {
    const permission = script.manifest.permissions.find((p) => p.kind === kind)
    if (!permission) throw new Error(`Microscript ${script.id} lacks permission ${kind}.`)
    return permission
}

function assertAgentWake(
    script: Microscript,
    request: Extract<MicroscriptOperation, { kind: 'agent.wake' }>,
): Extract<MicroscriptPermission, { kind: 'agent_wake' }> {
    const permission = script.manifest.permissions.find(
        (p): p is Extract<MicroscriptPermission, { kind: 'agent_wake' }> =>
            p.kind === 'agent_wake',
    )
    if (!permission) throw new Error(`Microscript ${script.id} lacks agent_wake permission.`)
    if (!permission.agentIds.includes(request.agent_id)) {
        throw new Error(`Microscript ${script.id} may not wake agent ${request.agent_id}.`)
    }
    if (request.prompt.length > permission.maxPromptChars) {
        throw new Error(`agent.wake prompt exceeds permission limit of ${permission.maxPromptChars} characters.`)
    }
    return permission
}

function homeAssistantReadPermissions(script: Microscript): Extract<MicroscriptPermission, { kind: 'home_assistant_read' }>[] {
    return script.manifest.permissions.filter((p): p is Extract<MicroscriptPermission, { kind: 'home_assistant_read' }> => p.kind === 'home_assistant_read')
}

function assertHomeAssistantRead(
    script: Microscript,
    entityIds: string[],
    list: boolean,
    history: boolean,
    domain?: string,
): void {
    const permissions = homeAssistantReadPermissions(script)
    if (permissions.length === 0) throw new Error(`Microscript ${script.id} lacks home_assistant_read permission.`)
    for (const permission of permissions) {
        if (list && !permission.allowList) continue
        if (history && !permission.allowHistory) continue
        if (domain && !domainAllowed(permission, domain)) continue
        if (entityIds.length > 0 && entityIds.every((entityId) => entityAllowed(permission, entityId))) return
        if (entityIds.length === 0) return
    }
    throw new Error('Home Assistant read request is outside the microscript permission boundary.')
}

function assertHomeAssistantWrite(
    script: Microscript,
    request: Extract<MicroscriptOperation, { kind: 'home_assistant.call_service' }>,
): void {
    const permission = script.manifest.permissions.find(
        (p): p is Extract<MicroscriptPermission, { kind: 'home_assistant_call_service' }> =>
            p.kind === 'home_assistant_call_service',
    )
    if (!permission) throw new Error(`Microscript ${script.id} lacks home_assistant_call_service permission.`)
    const requestedEntities = entityIdsFromTarget(request.target)
    const allowed = permission.services.some((service) => {
        if (service.domain !== request.domain) return false
        if (service.service && service.service !== request.service) return false
        if (!service.entityIds?.length) return true
        return requestedEntities.length > 0 && requestedEntities.every((entityId) => service.entityIds?.includes(entityId))
    })
    if (!allowed) throw new Error('Home Assistant service call is outside the microscript permission boundary.')
}

function entityAllowed(
    permission: Extract<MicroscriptPermission, { kind: 'home_assistant_read' }>,
    entityId: string,
): boolean {
    if (permission.entityIds?.includes(entityId)) return true
    const domain = entityId.split('.')[0]
    return domainAllowed(permission, domain)
}

function domainAllowed(
    permission: Extract<MicroscriptPermission, { kind: 'home_assistant_read' }>,
    domain: string,
): boolean {
    return Boolean(permission.domains?.includes(domain))
}

function entityIdsFromTarget(target: Record<string, unknown> | undefined): string[] {
    const value = target?.entity_id
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
    return []
}

async function executeHttpFetch(
    script: Microscript,
    request: Extract<MicroscriptOperation, { kind: 'http.fetch' }>,
): Promise<Record<string, unknown>> {
    const permission = requirePermission(script, 'http_fetch') as Extract<MicroscriptPermission, { kind: 'http_fetch' }>
    const url = new URL(request.url)
    if (!hostAllowed(url.hostname, permission.allowedHosts)) {
        throw new Error(`Host ${url.hostname} is not in the microscript HTTP allowlist.`)
    }
    if (!permission.methods.includes(request.method)) {
        throw new Error(`HTTP method ${request.method} is not allowed for this microscript.`)
    }
    if (!permission.allowPrivateNetwork && isPrivateHost(url.hostname)) {
        throw new Error(`Private/internal host ${url.hostname} requires allowPrivateNetwork=true.`)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
        const resp = await fetch(url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: controller.signal,
        })
        const text = await readResponseText(resp, permission.maxBytes)
        return {
            status: resp.status,
            ok: resp.ok,
            headers: Object.fromEntries([...resp.headers.entries()].slice(0, 50)),
            text,
        }
    } finally {
        clearTimeout(timer)
    }
}

async function readResponseText(resp: Response, maxBytes: number): Promise<string> {
    const reader = resp.body?.getReader()
    if (!reader) return ''
    const chunks: Uint8Array[] = []
    let received = 0
    while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        received += value.byteLength
        if (received > maxBytes) {
            reader.cancel().catch(() => undefined)
            throw new Error(`HTTP response exceeded ${maxBytes} bytes.`)
        }
        chunks.push(value)
    }
    return new TextDecoder().decode(Buffer.concat(chunks))
}

function executeFileRead(script: Microscript, relPath: string): { path: string; content: string } {
    const permission = requirePermission(script, 'files') as Extract<MicroscriptPermission, { kind: 'files' }>
    if (!permission.read) throw new Error('Microscript file read permission is disabled.')
    const resolved = resolveScriptFile(script.id, relPath)
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw new Error('Requested path is not a file.')
    if (stat.size > permission.maxBytes) throw new Error(`File exceeds ${permission.maxBytes} bytes.`)
    return { path: relPath, content: fs.readFileSync(resolved, 'utf-8') }
}

function executeFileWrite(script: Microscript, relPath: string, content: string, append: boolean): { path: string; bytes: number } {
    const permission = requirePermission(script, 'files') as Extract<MicroscriptPermission, { kind: 'files' }>
    if (!permission.write) throw new Error('Microscript file write permission is disabled.')
    if (Buffer.byteLength(content, 'utf-8') > permission.maxBytes) {
        throw new Error(`File write exceeds ${permission.maxBytes} bytes.`)
    }
    const resolved = resolveScriptFile(script.id, relPath)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    if (append) fs.appendFileSync(resolved, content, 'utf-8')
    else fs.writeFileSync(resolved, content, 'utf-8')
    return { path: relPath, bytes: Buffer.byteLength(content, 'utf-8') }
}

function resolveScriptFile(scriptId: string, relPath: string): string {
    if (path.isAbsolute(relPath)) throw new Error('Microscript file paths must be relative.')
    const root = path.join(scriptWorkDir(scriptId), 'files')
    const resolved = path.resolve(root, relPath)
    const normalizedRoot = path.resolve(root)
    if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
        throw new Error('Microscript file path escapes the script workspace.')
    }
    return resolved
}

function scriptWorkDir(scriptId: string): string {
    return path.join(WORKSPACE_DIR, 'microscripts', scriptId)
}

function hostAllowed(host: string, allowedHosts: string[]): boolean {
    const h = host.toLowerCase()
    return allowedHosts.some((raw) => {
        const pattern = raw.toLowerCase().trim()
        if (pattern.startsWith('*.')) {
            const suffix = pattern.slice(1)
            return h.endsWith(suffix) && h.length > suffix.length
        }
        return h === pattern
    })
}

function isPrivateHost(host: string): boolean {
    const h = host.toLowerCase()
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan')) return true
    if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
    const parts = h.split('.').map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return false
    const [a, b] = parts
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    return false
}

async function homeAssistantGetState(entityId: string) {
    const { homeAssistantGetState: fn } = await import('@/lib/integrations/home-assistant')
    return fn(entityId)
}

async function homeAssistantListStates(options: {
    domain?: string
    query?: string
    includeAttributes?: boolean
    maxResults?: number
}) {
    const { homeAssistantListStates: fn } = await import('@/lib/integrations/home-assistant')
    return fn(options)
}

async function homeAssistantHistory(options: {
    entityIds: string[]
    startTime?: string
    endTime?: string
    noAttributes?: boolean
    significantChangesOnly?: boolean
    maxStateChanges?: number
}) {
    const { homeAssistantHistory: fn } = await import('@/lib/integrations/home-assistant')
    return fn(options)
}

async function homeAssistantCallService(options: {
    domain: string
    service: string
    target?: Record<string, unknown>
    data?: Record<string, unknown>
    confirmed: boolean
    reason: string
    returnResponse?: boolean
}) {
    const { homeAssistantCallService: fn } = await import('@/lib/integrations/home-assistant')
    return fn(options)
}
