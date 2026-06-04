import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { createHash, randomUUID } from 'crypto'

import { WORKSPACE_DIR } from '@/lib/runtime-paths'
import { resolveAppOrigin } from '@/lib/app-origin'
import { createInboxConversation } from '@/lib/scheduling/store'
import { sendInboxPushNotification } from '@/lib/push-notifications'
import { normalizeInboxReplyActions } from '@/lib/ai/tools/notify'
import { operationalIntegrationFor } from '@/lib/integrations/manifest'
import { persistArtifactsFromMessage } from '@/lib/artifacts/persist-message'
import { appendMissingArtifactBlocks, stripArtifactBlocksForPreview } from '@/lib/artifacts/text'
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

const TRUSTED_PYTHON_WRAPPER = String.raw`
import builtins
import contextlib
import importlib
import io
import ipaddress
import json
import os
import pathlib
import socket
import stat
import sys
import traceback

ORIGINAL_STDOUT = sys.stdout
ORIGINAL_STDERR = sys.stderr
ORIGINAL_IMPORT = builtins.__import__
ORIGINAL_OPEN = builtins.open
ORIGINAL_IO_OPEN = io.open
ORIGINAL_MAKEDIRS = os.makedirs
ORIGINAL_MKDIR = os.mkdir
ORIGINAL_STAT = os.stat

BLOCKED_MODULE_ROOTS = {
    "_posixsubprocess",
    "ctypes",
    "multiprocessing",
    "posix",
    "pty",
    "subprocess",
}

SHELL_ATTR_PREFIXES = ("execl", "execle", "execlp", "execlpe", "execv", "execve", "execvp", "execvpe", "spawn")
SHELL_ATTRS = {
    "fork", "forkpty", "kill", "killpg", "popen", "posix_spawn", "posix_spawnp",
    "system", "wait", "wait3", "wait4", "waitid", "waitpid",
}
FILE_ATTRS = {
    "chdir", "chmod", "chown", "lchmod", "lchown", "link", "listdir", "mkdir",
    "makedirs", "open", "remove", "removedirs", "rename", "replace", "rmdir",
    "scandir", "stat", "symlink", "truncate", "unlink", "utime",
}

logs = []
pending_requests = []

def blocked_message(action, reason, safe_alternative, implementation_request):
    return (
        "Blocked microscript action: " + action + ".\n"
        "Reason: " + reason + "\n"
        "Safe alternative: " + safe_alternative + "\n"
        "If this is genuinely required, ask the user to approve/implement the capability and record an AGENT_NEEDS.md entry with ReportAgentNeed."
        + (" Needed change: " + implementation_request if implementation_request else "")
    )

def fail(message):
    print(json.dumps({"ok": False, "error": message, "logs": logs}), file=ORIGINAL_STDOUT, flush=True)

class PendingOperation(Exception):
    pass

class MicroscriptContext(dict):
    def __init__(self, data):
        super().__init__(data)
        self.state = data.get("state") if isinstance(data.get("state"), dict) else {}
        self.results = data.get("results") if isinstance(data.get("results"), dict) else {}
        self.phase = data.get("phase")
        self.now = data.get("now")
        self.trigger = data.get("trigger")
        self.webhook = data.get("webhook")
        self.script = data.get("script")
        self.manifest = data.get("manifest")

    def _result_or_pending(self, request):
        request_id = request.get("id")
        if request_id in self.results:
            result = self.results[request_id]
            if isinstance(result, dict) and result.get("ok") is False:
                return result
            return result
        pending_requests.append(request)
        raise PendingOperation()

    def request(self, kind, id=None, **kwargs):
        request_id = id or kind.replace(".", "_")
        request = {"kind": kind, "id": request_id}
        request.update(kwargs)
        return self._result_or_pending(request)

    def notify(self, body, title=None, actions=None, id="notify"):
        request = {"kind": "notify.inbox", "id": id, "body": str(body)}
        if title is not None:
            request["title"] = str(title)
        if actions is not None:
            request["actions"] = actions
        return self._result_or_pending(request)

    def http_fetch(self, url, method="GET", headers=None, body=None, id="http_fetch"):
        request = {
            "kind": "http.fetch",
            "id": id,
            "url": url,
            "method": str(method).upper(),
        }
        if headers is not None:
            request["headers"] = headers
        if body is not None:
            request["body"] = body
        return self._result_or_pending(request)

    def file_read(self, path, id="file_read"):
        return self._result_or_pending({"kind": "file.read", "id": id, "path": path})

    def file_write(self, path, content, append=False, id="file_write"):
        return self._result_or_pending({
            "kind": "file.write",
            "id": id,
            "path": path,
            "content": content,
            "append": bool(append),
        })

    def call_tool(self, tool_id, arguments=None, id=None):
        return self._result_or_pending({
            "kind": "tool.call",
            "id": id or ("tool_" + str(tool_id).replace(".", "_").replace("-", "_")),
            "tool_id": str(tool_id),
            "arguments": arguments or {},
        })

    def continue_after(self, *, milliseconds=None, seconds=None, minutes=None, state=None, summary=None):
        delay = milliseconds
        if delay is None and seconds is not None:
            delay = int(float(seconds) * 1000)
        if delay is None and minutes is not None:
            delay = int(float(minutes) * 60 * 1000)
        result = {"status": "continue", "state": state if state is not None else self.state}
        if delay is not None:
            result["nextCheckAfterMs"] = int(delay)
        if summary is not None:
            result["summary"] = str(summary)
        return result

    def complete(self, summary=None, state=None):
        result = {"status": "complete", "state": state if state is not None else self.state}
        if summary is not None:
            result["summary"] = str(summary)
        return result

    def pause(self, summary=None, state=None):
        result = {"status": "pause", "state": state if state is not None else self.state}
        if summary is not None:
            result["summary"] = str(summary)
        return result

    def wait(self, **kwargs):
        return self.continue_after(**kwargs)

def ensure_relative_path(value):
    raw = os.fspath(value)
    if os.path.isabs(raw):
        raise RuntimeError(blocked_message(
            "absolute filesystem path",
            "Trusted Python file access is confined to the microscript workspace so recurring scripts cannot read or overwrite arbitrary user/app files.",
            "Use a relative path inside the script workspace, or use an app tool/approved integration that exposes the needed data.",
            "Add an explicit reviewed permission/path bridge if this workflow truly needs that external path.",
        ))
    root = os.path.abspath(os.getcwd())
    resolved = os.path.abspath(os.path.join(root, raw))
    if resolved != root and not resolved.startswith(root + os.sep):
        raise RuntimeError(blocked_message(
            "filesystem path escaping workspace",
            "Path traversal would leave the microscript workspace.",
            "Keep reads/writes under the private workspace and pass durable state through ctx.state.",
            "Add a reviewed path-specific bridge if an external file is required.",
        ))
    return resolved

def safe_open(file, mode="r", *args, **kwargs):
    if not POLICY.get("allowWorkspaceFiles", True):
        raise RuntimeError(blocked_message(
            "Python file open",
            "trustedPython.allowWorkspaceFiles is false for this script.",
            "Use ctx.state for small durable data, or enable workspace files in the manifest.",
            "Request a manifest update from the user if file access is necessary.",
        ))
    resolved = ensure_relative_path(file)
    if any(flag in str(mode) for flag in ("w", "a", "x", "+")):
        make_dirs_absolute(os.path.dirname(resolved))
    return ORIGINAL_OPEN(resolved, mode, *args, **kwargs)

def absolute_is_dir(value):
    try:
        return stat.S_ISDIR(ORIGINAL_STAT(value).st_mode)
    except FileNotFoundError:
        return False

def make_dirs_absolute(directory):
    if not directory or absolute_is_dir(directory):
        return
    pending = []
    current = directory
    while current and not absolute_is_dir(current):
        pending.append(current)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    for item in reversed(pending):
        try:
            ORIGINAL_MKDIR(item)
        except FileExistsError:
            pass

def safe_path_method(name, original):
    def wrapper(self, *args, **kwargs):
        return original(pathlib.Path(ensure_relative_path(self)), *args, **kwargs)
    return wrapper

def block_function(action, reason, safe_alternative, implementation_request=""):
    def blocked(*args, **kwargs):
        raise RuntimeError(blocked_message(action, reason, safe_alternative, implementation_request))
    return blocked

def patch_os_module(module):
    if not POLICY.get("allowShell", False):
        for attr in dir(module):
            if attr in SHELL_ATTRS or attr.startswith(SHELL_ATTR_PREFIXES):
                try:
                    setattr(module, attr, block_function(
                        "shell/subprocess/process control",
                        "Autonomous microscripts may run repeatedly; shell and process control can escape runtime limits, leak data, or mutate the host outside audit.",
                        "Use normal Python libraries, ctx.http_fetch for HTTP, ctx.call_tool for app integrations, or request a dedicated app capability.",
                        "Add an explicitly reviewed shell permission with command/path constraints.",
                    ))
                except Exception:
                    pass
    for attr in FILE_ATTRS:
        if hasattr(module, attr):
            original = getattr(module, attr)
            def make_file_wrapper(fn_name, fn):
                def wrapped(path, *args, **kwargs):
                    resolved = ensure_relative_path(path)
                    return fn(resolved, *args, **kwargs)
                return wrapped
            try:
                setattr(module, attr, make_file_wrapper(attr, original))
            except Exception:
                pass

def patch_socket_module(module):
    if POLICY.get("allowNetwork", True):
        if POLICY.get("allowPrivateNetwork", True):
            return
        original_create_connection = module.create_connection
        original_socket = module.socket

        def assert_public_address(address):
            host = address[0] if isinstance(address, tuple) and address else address
            if not isinstance(host, str):
                return
            if host in ("localhost",):
                raise RuntimeError(blocked_message(
                    "direct Python private-network connection",
                    "trustedPython.allowPrivateNetwork is false and localhost is private.",
                    "Use a public host or set allowPrivateNetwork=true after user approval.",
                    "Approve private-network access for this microscript.",
                ))
            try:
                infos = module.getaddrinfo(host, None)
            except Exception:
                infos = []
            for info in infos:
                ip = info[4][0]
                try:
                    parsed = ipaddress.ip_address(ip)
                except Exception:
                    continue
                if parsed.is_private or parsed.is_loopback or parsed.is_link_local or parsed.is_multicast:
                    raise RuntimeError(blocked_message(
                        "direct Python private-network connection",
                        "trustedPython.allowPrivateNetwork is false and the host resolves to a private/internal address.",
                        "Use a public host or set allowPrivateNetwork=true after user approval.",
                        "Approve private-network access for this microscript.",
                    ))

        def safe_create_connection(address, *args, **kwargs):
            assert_public_address(address)
            return original_create_connection(address, *args, **kwargs)

        class SafeSocket(original_socket):
            def connect(self, address):
                assert_public_address(address)
                return super().connect(address)

        module.create_connection = safe_create_connection
        module.socket = SafeSocket
        return
    blocked = block_function(
        "direct Python networking",
        "trustedPython.allowNetwork is false for this script.",
        "Use ctx.http_fetch with an http_fetch permission or enable trusted Python networking in the manifest.",
        "Request a manifest update if this watch requires direct sockets.",
    )
    for attr in ["create_connection", "socket", "fromfd", "socketpair"]:
        if hasattr(module, attr):
            try:
                setattr(module, attr, blocked)
            except Exception:
                pass

def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if not POLICY.get("allowImports", True):
        raise RuntimeError(blocked_message(
            "Python import",
            "trustedPython.allowImports is false for this script.",
            "Use plain Python builtins or enable imports in the manifest.",
            "Request a manifest update if imports are required.",
        ))
    if root in BLOCKED_MODULE_ROOTS and not POLICY.get("allowShell", False):
        raise RuntimeError(blocked_message(
            "Python import " + name,
            "This module can spawn processes, load native memory, or bypass the runtime filesystem/network controls.",
            "Use stdlib/network/file APIs that stay inside the microscript runtime, ctx.call_tool for app capabilities, or ask for a dedicated safe bridge.",
            "Request a reviewed runtime permission/implementation if there is no safe bridge.",
        ))
    module = ORIGINAL_IMPORT(name, globals, locals, fromlist, level)
    if root == "os":
        patch_os_module(module)
    if root == "socket":
        patch_socket_module(module)
    return module

try:
    payload = json.loads(sys.stdin.read())
    code = payload["code"]
    raw_ctx = payload.get("ctx") or {}
    POLICY = (((raw_ctx.get("manifest") or {}).get("trustedPython")) or {})
    validate_only = bool(payload.get("validateOnly"))

    if not POLICY.get("allowEnvironment", False):
        os.environ.clear()
    builtins.__import__ = guarded_import
    builtins.open = safe_open
    io.open = safe_open
    patch_os_module(os)
    patch_socket_module(socket)
    pathlib.Path.open = safe_path_method("open", pathlib.Path.open)

    if validate_only:
        compile(code, "<microscript>", "exec")
        print(json.dumps({"ok": True, "result": {}, "logs": logs}), file=ORIGINAL_STDOUT, flush=True)
        sys.exit(0)

    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    globals_dict = {
        "__builtins__": builtins,
        "__name__": "microscript",
        "ctx": None,
    }
    locals_dict = {}
    ctx = MicroscriptContext(raw_ctx)
    globals_dict["ctx"] = ctx

    with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
        exec(compile(code, "<microscript>", "exec"), globals_dict, locals_dict)
        run = locals_dict.get("run") or globals_dict.get("run")
        if not callable(run):
            raise RuntimeError("Microscript must define run(ctx).")
        try:
            result = run(ctx)
        except PendingOperation:
            result = {
                "summary": "Waiting for parent-mediated microscript operation.",
                "state": ctx.state,
                "requests": pending_requests,
            }

    out = stdout_buffer.getvalue()
    err = stderr_buffer.getvalue()
    if out:
        logs.append(out)
    if err:
        logs.append(err)
    if result is None:
        result = {"state": ctx.state}
    if not isinstance(result, dict):
        result = {"summary": str(result), "state": ctx.state}
    if pending_requests:
        existing = result.get("requests")
        merged = []
        if isinstance(existing, list):
            merged.extend(existing)
        for request in pending_requests:
            if request not in merged:
                merged.append(request)
        result["requests"] = merged
    if "state" not in result:
        result["state"] = ctx.state
    json.dumps(result)
    print(json.dumps({"ok": True, "result": result, "logs": logs}), file=ORIGINAL_STDOUT, flush=True)
except Exception as exc:
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

interface RunPolicyCounters {
    toolCalls: number
}

function defaultTrustedPythonPolicy(): Record<string, boolean> {
    return {
        allowImports: true,
        allowNetwork: true,
        allowPrivateNetwork: true,
        allowWorkspaceFiles: true,
        allowEnvironment: false,
        allowShell: false,
    }
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
            ctx: { manifest: { trustedPython: defaultTrustedPythonPolicy() } },
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
    const counters: RunPolicyCounters = { toolCalls: 0 }

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
                const result = await executeOperation(script, request, pendingNotifications, inboxConversationId, counters)
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
                runtime: script.manifest.runtime,
                schedule: script.manifest.schedule,
                stop: script.manifest.stop,
                trustedPython: script.manifest.trustedPython,
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
        const env: NodeJS.ProcessEnv = {
            NODE_ENV: process.env.NODE_ENV ?? 'production',
            PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
            PYTHONIOENCODING: 'utf-8',
            PYTHONDONTWRITEBYTECODE: '1',
        }
        const child: ChildProcessWithoutNullStreams = spawn('python3', ['-I', '-c', TRUSTED_PYTHON_WRAPPER], {
            cwd: options.cwd,
            env,
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
    counters: RunPolicyCounters,
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
            case 'tool.call':
                return { ok: true, data: await executeToolCall(script, parsed, conversationId, counters) }
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
        tools: buildAgentWakeToolGrant(baseAgent.tools, permission.allowNotifyInbox),
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
        appOrigin: resolveAppOrigin(),
        toolSurfaceMode: 'read-only',
        // notify_inbox is gated into the 'inbox' capability now; warm it up so a
        // read-only microscript wake can still surface a notification.
        preactivatedCapabilities: ['inbox'],
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
    if (notifications.length > notificationsBefore) {
        const last = notifications[notifications.length - 1]
        if (last) last.body = appendMissingArtifactBlocks(last.body, output)
    }
    return {
        agent_id: request.agent_id,
        output,
        notified: notifications.length > notificationsBefore,
        notification_count: notifications.length - notificationsBefore,
    }
}

async function executeToolCall(
    script: Microscript,
    request: Extract<MicroscriptOperation, { kind: 'tool.call' }>,
    conversationId: string,
    counters: RunPolicyCounters,
): Promise<Record<string, unknown>> {
    const permission = assertToolCall(script, request, counters)
    const [{ getTool }, { executeTool }] = await Promise.all([
        import('@/lib/ai/tools/registry'),
        import('@/lib/ai/tools/executor'),
    ])
    const tool = getTool(request.tool_id)
    if (!tool) {
        throw new Error(blockedActionMessage(
            `tool.call ${request.tool_id}`,
            'No app tool with that id is registered in this runtime.',
            'Use an existing tool id, direct Python stdlib code, or a narrower built-in ctx helper.',
            `Implement/register tool ${request.tool_id}, then allow it in this microscript manifest.`,
        ))
    }

    const callerAgentId = permission.allowOrchestratorOnly ? 'orchestrator' : '__microscripts__'
    const ctx: ToolExecutionContext = {
        callerAgentId,
        depth: 0,
        conversationId,
        parentRequestId: `microscript_${script.id}_${randomUUID()}`,
    }
    const result = await executeTool(tool, request.arguments, ctx)
    return {
        tool_id: request.tool_id,
        success: result.success,
        ...(result.data !== undefined ? { data: result.data } : {}),
        ...(result.error ? { error: result.error } : {}),
    }
}

const HARD_BLOCKED_TOOL_IDS = new Set([
    'ActivateIntegrationTools',
    'RunActivatedIntegrationTool',
    'Bash',
    'Read',
    'Write',
    'Edit',
    'SetEnv',
    'delegate_to',
    'delegate_parallel',
])

const ORCHESTRATOR_ONLY_MICROSCRIPT_TOOL_IDS = new Set([
    'search_past_runs',
    'get_past_run',
    'search_agent_logs',
    'get_agent_log',
    'read_runtime_index',
])

function assertToolCall(
    script: Microscript,
    request: Extract<MicroscriptOperation, { kind: 'tool.call' }>,
    counters: RunPolicyCounters,
): Extract<MicroscriptPermission, { kind: 'tool_call' }> {
    const permission = script.manifest.permissions.find(
        (p): p is Extract<MicroscriptPermission, { kind: 'tool_call' }> => p.kind === 'tool_call',
    )
    if (!permission) {
        throw new Error(blockedActionMessage(
            `tool.call ${request.tool_id}`,
            'The script does not declare tool_call permission.',
            'Use direct Python for local logic/network checks, ctx.notify for Inbox alerts, or add tool_call with exact toolIds/toolPatterns.',
            `Approve a tool_call permission for ${request.tool_id}.`,
        ))
    }
    if (HARD_BLOCKED_TOOL_IDS.has(request.tool_id) || request.tool_id.startsWith('microscript_')) {
        throw new Error(blockedActionMessage(
            `tool.call ${request.tool_id}`,
            'This tool can mutate the host runtime, recursively manage microscripts, or bypass lifecycle/audit boundaries.',
            'Use the dedicated microscript helpers, direct Python stdlib, or ask the orchestrator/user to perform the action outside the recurring script.',
            `Design a narrow safe bridge for ${request.tool_id} if recurring scripts truly need it.`,
        ))
    }
    if (ORCHESTRATOR_ONLY_MICROSCRIPT_TOOL_IDS.has(request.tool_id) && !permission.allowOrchestratorOnly) {
        throw new Error(blockedActionMessage(
            `tool.call ${request.tool_id}`,
            'The tool is marked orchestrator-only and this microscript permission does not opt into that surface.',
            'Return structured data from the script and let the orchestrator use the tool, or set allowOrchestratorOnly after user approval.',
            `Approve allowOrchestratorOnly for ${request.tool_id}.`,
        ))
    }
    counters.toolCalls += 1
    if (counters.toolCalls > permission.maxCallsPerRun) {
        throw new Error(blockedActionMessage(
            'too many tool.call operations',
            `The script exceeded maxCallsPerRun=${permission.maxCallsPerRun}.`,
            'Batch work, cache state in ctx.state, or reduce the cadence.',
            'Increase maxCallsPerRun only after reviewing cost and side effects.',
        ))
    }
    if (toolAllowedByPermission(request.tool_id, permission)) return permission
    throw new Error(blockedActionMessage(
        `tool.call ${request.tool_id}`,
        'The tool is outside the microscript tool_call permission boundary.',
        'Use one of the allowed toolIds/toolPatterns, or direct Python for non-app work.',
        `Approve ${request.tool_id} in toolIds/toolPatterns or add a safe dedicated bridge.`,
    ))
}

function toolAllowedByPermission(
    toolId: string,
    permission: Extract<MicroscriptPermission, { kind: 'tool_call' }>,
): boolean {
    if (permission.toolIds?.includes(toolId)) return true
    if (permission.toolPatterns?.some((pattern) => globPatternMatches(pattern, toolId))) return true
    return permission.allowIntegrationTools && Boolean(operationalIntegrationFor(toolId))
}

function globPatternMatches(pattern: string, value: string): boolean {
    const escaped = pattern
        .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
        .replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(value)
}

function buildAgentWakePrompt(script: Microscript, prompt: string, allowNotifyInbox: boolean): string {
    return [
        'You were woken by a Microscript after a deterministic runtime condition matched.',
        'Use only the context supplied in this prompt plus read-only/context tools exposed to this wake. Do not assume you can perform source-side actions.',
        'If the payload asks for planning or judgement that depends on user history, durable memory, local subsystems such as workouts, or connected source reads, activate exactly the relevant capability first and use its read-only tools before deciding. Do not activate broad unrelated capabilities.',
        'Do not perform source-side writes, setup, scheduling, filesystem edits, delegation, or destructive actions from this wake; notify or return an internal summary instead.',
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

function buildAgentWakeToolGrant(baseToolIds: readonly string[], allowNotifyInbox: boolean): string[] {
    const ids = new Set(baseToolIds)
    if (!allowNotifyInbox) ids.delete('notify_inbox')
    return Array.from(ids)
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
    const persisted = persistArtifactsFromMessage({
        conversationId,
        messageId: assistantMsg.id,
        content: assistantMsg.content,
    })
    if (persisted.errors.length > 0) {
        console.warn(
            `Failed to persist ${persisted.errors.length} microscript artifact(s):`,
            persisted.errors,
        )
    }
    void sendInboxPushNotification({
        conversationId,
        title,
        body: stripArtifactBlocksForPreview(body),
    })
    return conversationId
}

function blockedActionMessage(
    action: string,
    reason: string,
    safeAlternative: string,
    implementationRequest: string,
): string {
    return [
        `Blocked microscript action: ${action}.`,
        `Reason: ${reason}`,
        `Safe alternative: ${safeAlternative}`,
        `If this is genuinely required, ask the user to approve/implement the capability and record an AGENT_NEEDS.md entry with ReportAgentNeed. Needed change: ${implementationRequest}`,
    ].join('\n')
}

function requirePermission(script: Microscript, kind: MicroscriptPermission['kind']): MicroscriptPermission {
    const permission = script.manifest.permissions.find((p) => p.kind === kind)
    if (!permission) {
        throw new Error(blockedActionMessage(
            kind,
            `Microscript ${script.id} does not declare this parent-mediated permission.`,
            'Update the manifest with the smallest permission that covers the operation, or use trusted Python direct stdlib APIs when that is enough.',
            `Add/approve permission kind ${kind} for microscript ${script.id}.`,
        ))
    }
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
    if (!permission) throw new Error(blockedActionMessage(
        'agent wake',
        `Microscript ${script.id} lacks agent_wake permission.`,
        'Keep the deterministic check inside Python and notify directly, or add an agent_wake permission with allowed agent ids and prompt limits.',
        'Approve agent_wake for this microscript, or implement a narrower model-escalation bridge.',
    ))
    if (!permission.agentIds.includes(request.agent_id)) {
        throw new Error(blockedActionMessage(
            `wake agent ${request.agent_id}`,
            'The requested agent is outside the agent_wake permission boundary.',
            `Use one of the allowed agents: ${permission.agentIds.join(', ')}.`,
            'Approve the target agent id in this microscript manifest.',
        ))
    }
    if (request.prompt.length > permission.maxPromptChars) {
        throw new Error(blockedActionMessage(
            'large agent wake prompt',
            `The prompt exceeds the permission limit of ${permission.maxPromptChars} characters.`,
            'Summarize the observed facts before waking the agent.',
            'Raise maxPromptChars only if the use case truly needs larger payloads.',
        ))
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
    if (permissions.length === 0) throw new Error(blockedActionMessage(
        'Home Assistant read',
        `Microscript ${script.id} lacks home_assistant_read permission.`,
        'Use ctx.call_tool with an approved tool_call permission, or add home_assistant_read with allowAll/domains/entityIds.',
        'Approve a Home Assistant read boundary for this script.',
    ))
    for (const permission of permissions) {
        if (list && !permission.allowList) continue
        if (history && !permission.allowHistory) continue
        if (permission.allowAll) return
        if (domain && !domainAllowed(permission, domain)) continue
        if (entityIds.length > 0 && entityIds.every((entityId) => entityAllowed(permission, entityId))) return
        if (entityIds.length === 0 && domain) return
        if (entityIds.length === 0 && !list && !history) return
    }
    throw new Error(blockedActionMessage(
        'Home Assistant read',
        'The requested entity/domain/list/history operation is outside the microscript permission boundary.',
        'Use an allowed entity/domain, or declare allowAll/allowList/allowHistory after user approval.',
        'Update the Home Assistant read permission for this script.',
    ))
}

function assertHomeAssistantWrite(
    script: Microscript,
    request: Extract<MicroscriptOperation, { kind: 'home_assistant.call_service' }>,
): void {
    const permission = script.manifest.permissions.find(
        (p): p is Extract<MicroscriptPermission, { kind: 'home_assistant_call_service' }> =>
            p.kind === 'home_assistant_call_service',
    )
    if (!permission) throw new Error(blockedActionMessage(
        'Home Assistant service call',
        `Microscript ${script.id} lacks home_assistant_call_service permission.`,
        'Use ctx.call_tool with approved tool_call permission, or add home_assistant_call_service with allowAll/domains/services.',
        'Approve the Home Assistant service-call boundary for this script.',
    ))
    if (permission.allowAll) return
    if (permission.domains?.includes(request.domain)) return
    const requestedEntities = entityIdsFromTarget(request.target)
    const allowed = permission.services.some((service) => {
        if (service.domain !== request.domain) return false
        if (service.service && service.service !== request.service) return false
        if (!service.entityIds?.length) return true
        return requestedEntities.length > 0 && requestedEntities.every((entityId) => service.entityIds?.includes(entityId))
    })
    if (!allowed) throw new Error(blockedActionMessage(
        'Home Assistant service call',
        'The requested domain/service/target is outside the microscript permission boundary.',
        'Use an allowed service target, or broaden to domains/allowAll only after user approval.',
        'Update the Home Assistant call-service permission for this script.',
    ))
}

function entityAllowed(
    permission: Extract<MicroscriptPermission, { kind: 'home_assistant_read' }>,
    entityId: string,
): boolean {
    if (permission.allowAll) return true
    if (permission.entityIds?.includes(entityId)) return true
    const domain = entityId.split('.')[0]
    return domainAllowed(permission, domain)
}

function domainAllowed(
    permission: Extract<MicroscriptPermission, { kind: 'home_assistant_read' }>,
    domain: string,
): boolean {
    if (permission.allowAll) return true
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
    const permission = httpFetchPermission(script)
    const url = new URL(request.url)
    if (!hostAllowed(url.hostname, permission.allowedHosts)) {
        throw new Error(blockedActionMessage(
            `HTTP ${request.method} ${url.hostname}`,
            `Host ${url.hostname} is not in the microscript HTTP allowlist.`,
            'Use a host in allowedHosts, set allowedHosts=["*"] for trusted broad HTTP, or use direct Python networking when trustedPython.allowNetwork=true.',
            'Approve a broader http_fetch permission for this script.',
        ))
    }
    if (!permission.methods.includes(request.method)) {
        throw new Error(blockedActionMessage(
            `HTTP method ${request.method}`,
            'The method is outside the http_fetch permission boundary.',
            `Use one of: ${permission.methods.join(', ')}.`,
            'Approve a broader HTTP method list for this script.',
        ))
    }
    if (!permission.allowPrivateNetwork && isPrivateHost(url.hostname)) {
        throw new Error(blockedActionMessage(
            `HTTP private/internal host ${url.hostname}`,
            'Private/internal hosts require allowPrivateNetwork=true.',
            'Use a public host, or explicitly approve private-network access in the manifest.',
            'Approve allowPrivateNetwork=true for this script.',
        ))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
        const resp = await fetch(url, {
            method: request.method,
            headers: request.headers,
            body: request.method === 'HEAD' ? undefined : request.body,
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

function httpFetchPermission(script: Microscript): Extract<MicroscriptPermission, { kind: 'http_fetch' }> {
    const permission = script.manifest.permissions.find(
        (p): p is Extract<MicroscriptPermission, { kind: 'http_fetch' }> => p.kind === 'http_fetch',
    )
    if (permission) return permission
    if (script.manifest.runtime === 'trusted_python' && script.manifest.trustedPython.allowNetwork) {
        return {
            kind: 'http_fetch',
            allowedHosts: ['*'],
            methods: ['HEAD', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            allowPrivateNetwork: script.manifest.trustedPython.allowPrivateNetwork,
            maxBytes: 2_000_000,
        }
    }
    return requirePermission(script, 'http_fetch') as Extract<MicroscriptPermission, { kind: 'http_fetch' }>
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
    const permission = filePermission(script)
    if (!permission.read) throw new Error('Microscript file read permission is disabled.')
    const resolved = resolveScriptFile(script.id, relPath)
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw new Error('Requested path is not a file.')
    if (stat.size > permission.maxBytes) throw new Error(`File exceeds ${permission.maxBytes} bytes.`)
    return { path: relPath, content: fs.readFileSync(resolved, 'utf-8') }
}

function executeFileWrite(script: Microscript, relPath: string, content: string, append: boolean): { path: string; bytes: number } {
    const permission = filePermission(script)
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

function filePermission(script: Microscript): Extract<MicroscriptPermission, { kind: 'files' }> {
    const permission = script.manifest.permissions.find(
        (p): p is Extract<MicroscriptPermission, { kind: 'files' }> => p.kind === 'files',
    )
    if (permission) return permission
    if (script.manifest.runtime === 'trusted_python' && script.manifest.trustedPython.allowWorkspaceFiles) {
        return {
            kind: 'files',
            read: true,
            write: true,
            maxBytes: 5_000_000,
        }
    }
    return requirePermission(script, 'files') as Extract<MicroscriptPermission, { kind: 'files' }>
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
        if (pattern === '*') return true
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
