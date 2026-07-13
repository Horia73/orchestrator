import path from 'path'

import type { ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { MAX_TOOL_DELTA_TEXT_CHARS } from '@/lib/ai/reasoning-limits'
import { augmentedEnv, resolveCommandShell } from '@/lib/cli/resolve-bin'
import { activeRuntimePaths } from '@/lib/runtime-paths'
import { getActiveProfileId } from '@/lib/profiles/context'
import { startTrackedBackgroundJob } from '@/lib/ai/background-jobs'
import { displayPath } from './sandbox'
import {
    collectEnvKeys,
    createSecretStreamRedactor,
    redactSecretText,
    resolveEnvVarInjection,
    type EnvVarInjection,
} from './env-vars'
export { bashTool } from './bash-def'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_STREAM_CHARS = 120_000

export async function executeBash(args: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const command = stringArg(args, ['command'])
    if (!command.trim()) return { success: false, error: 'Missing required parameter: command' }

    const cwdResult = resolveCwd(stringArg(args, ['cwd']))
    if (!cwdResult.ok) return { success: false, error: cwdResult.error }

    const runInBackground = booleanArg(args, ['run_in_background'])
    const envResolution = resolveEnvVarInjection(collectEnvKeys(args))
    if (!envResolution.ok) {
        return {
            success: false,
            error: envResolution.error,
            data: envResolution.missing ? { missing_env_keys: envResolution.missing } : undefined,
        }
    }

    if (runInBackground) {
        // Background jobs take the BACKGROUND defaults (30 min default, 24 h
        // cap — applied by startTrackedBackgroundJob), never the foreground
        // 2-minute default: an omitted timeout must not kill a long build.
        const explicitTimeout = numberArg(args, ['timeout'], Number.NaN)
        const backgroundTimeoutMs = Number.isFinite(explicitTimeout)
            ? Math.floor(explicitTimeout)
            : undefined
        return startBackgroundCommand(command, cwdResult.cwd, backgroundTimeoutMs, envResolution.injection, ctx)
    }
    const timeoutMs = clamp(Math.floor(numberArg(args, ['timeout'], DEFAULT_TIMEOUT_MS)), 1_000, MAX_TIMEOUT_MS)
    return runForegroundCommand(command, cwdResult.cwd, timeoutMs, envResolution.injection, ctx)
}

function resolveCwd(cwdArg: string): { ok: true; cwd: string } | { ok: false; error: string } {
    const workspaceDir = activeRuntimePaths().agentWorkspaceDir
    const clean = cwdArg.trim()
    if (!clean) return { ok: true, cwd: workspaceDir }
    const resolved = path.normalize(path.isAbsolute(clean) ? clean : `${workspaceDir}/${clean}`)
    return { ok: true, cwd: resolved }
}

function runtimeCommandEnv(ctx?: ToolExecutionContext): Record<string, string> {
    const paths = activeRuntimePaths()
    return {
        ORCHESTRATOR_APP_DIR: process.cwd(),
        ORCHESTRATOR_AGENT_WORKSPACE_DIR: paths.agentWorkspaceDir,
        ORCHESTRATOR_PROFILE_STATE_DIR: paths.stateDir,
        ORCHESTRATOR_PROJECT_RUNS_DIR: path.join(process.cwd(), '.orchestrator', 'project-runs'),
        ORCHESTRATOR_SELF_DEV_PROFILE_ID: getActiveProfileId(),
        ORCHESTRATOR_SELF_DEV_CONVERSATION_ID: ctx?.conversationId ?? '',
        ORCHESTRATOR_SELF_DEV_PARENT_REQUEST_ID: ctx?.parentRequestId ?? '',
    }
}

async function startBackgroundCommand(command: string, cwd: string, timeoutMs: number | undefined, injection: EnvVarInjection, ctx?: ToolExecutionContext): Promise<ToolResult> {
    // Background commands run as TRACKED jobs: registered in background_jobs,
    // detached from this turn, and the owning conversation gets a completion
    // notice (steering follow-up or headless wake) when the process exits.
    const result = await startTrackedBackgroundJob({
        command,
        cwd,
        timeoutMs,
        injection,
        conversationId: ctx?.conversationId ?? null,
        wakeOnExit: Boolean(ctx?.conversationId),
    })
    if (!result.ok || !result.job) {
        return { success: false, error: result.error ?? 'Could not start background job' }
    }
    return {
        success: true,
        data: {
            id: result.job.id,
            pid: result.job.pid,
            cwd: displayPath(cwd),
            log_path: displayPath(result.job.logPath),
            started: true,
            tracked: true,
            note: 'The job keeps running after this turn ends; a completion notice will arrive in this conversation when it exits. Use manage_background_jobs to check status, read output, or kill it.',
            ...injectionSummary(injection),
        },
    }
}

async function runForegroundCommand(command: string, cwd: string, timeoutMs: number, injection: EnvVarInjection, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const { spawn: ptySpawn } = await import('node' + '-pty') as typeof import('node-pty')

    return new Promise<ToolResult>(resolve => {
        const startedAt = Date.now()
        let rawOutput = ''
        let outputTruncated = false
        let finished = false
        let timedOut = false
        let streamedDeltaChars = 0
        let streamTruncatedNoticeSent = false
        const signal = ctx?.signal
        const toolCallId = ctx?.currentToolCallId
        let proc: ReturnType<typeof ptySpawn>
        const liveRedactor = createSecretStreamRedactor(injection.redactions)

        const emitToolDelta = (text: string) => {
            if (!toolCallId || !text) return

            const remaining = MAX_TOOL_DELTA_TEXT_CHARS - streamedDeltaChars
            if (remaining <= 0) {
                if (!streamTruncatedNoticeSent) {
                    streamTruncatedNoticeSent = true
                    void ctx?.onToolDelta?.(toolCallId, 'Bash', {
                        stream: 'message',
                        text: '\n\n...[live tool output truncated to keep chat history small]...\n\n',
                        timestamp: Date.now(),
                    })
                }
                return
            }

            const emitted = text.length > remaining ? text.slice(0, remaining) : text
            streamedDeltaChars += emitted.length
            void ctx?.onToolDelta?.(toolCallId, 'Bash', {
                stream: 'pty',
                text: emitted,
                timestamp: Date.now(),
            })

            if (text.length > remaining && !streamTruncatedNoticeSent) {
                streamTruncatedNoticeSent = true
                void ctx?.onToolDelta?.(toolCallId, 'Bash', {
                    stream: 'message',
                    text: '\n\n...[live tool output truncated to keep chat history small]...\n\n',
                    timestamp: Date.now(),
                })
            }
        }

        const emit = (text: string) => {
            const liveText = liveRedactor.push(text)
            if (liveText) emitToolDelta(liveText)
            const next = appendBounded(rawOutput, text)
            rawOutput = next.text
            outputTruncated ||= next.truncated
        }

        const finish = (result: ToolResult) => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            resolve(result)
        }

        const kill = (reason: 'timeout' | 'abort') => {
            if (reason === 'timeout') timedOut = true
            try { proc.kill('SIGTERM') } catch { /* already gone */ }
            setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* already gone */ } }, 1500)
        }

        const timer = setTimeout(() => kill('timeout'), timeoutMs)
        const onAbort = () => kill('abort')
        signal?.addEventListener('abort', onAbort, { once: true })

        try {
            proc = ptySpawn(resolveCommandShell(), ['-lc', command], {
                name: 'xterm-256color',
                cols: 120,
                rows: 32,
                cwd,
                env: augmentedEnv({
                    ...runtimeCommandEnv(ctx),
                    ...injection.env,
                    FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
                    TERM: 'xterm-256color',
                }) as Record<string, string>,
            })
        } catch (err) {
            finish({
                success: false,
                error: err instanceof Error ? err.message : `Could not start command in ${displayPath(cwd)}`,
            })
            return
        }

        emit(`\x1b[2m$ ${command}\x1b[0m\r\n`)

        proc.onData(chunk => {
            emit(chunk)
        })
        proc.onExit(({ exitCode }) => {
            const liveTail = liveRedactor.flush()
            if (liveTail) emitToolDelta(liveTail)
            const out = truncateText(redactSecretText(rawOutput, injection.redactions), MAX_STREAM_CHARS)
            const code = typeof exitCode === 'number' ? exitCode : null
            const success = !timedOut && (code === 0)
            finish({
                success,
                data: success ? {
                    command,
                    cwd: displayPath(cwd),
                    exitCode: code,
                    output: out.text,
                    stdout: out.text,
                    stderr: '',
                    durationMs: Date.now() - startedAt,
                    truncated: outputTruncated || out.truncated,
                    ...injectionSummary(injection),
                } : undefined,
                error: success ? undefined : JSON.stringify({
                    command,
                    cwd: displayPath(cwd),
                    exitCode: code,
                    timedOut,
                    output: out.text,
                    stdout: out.text,
                    stderr: '',
                    durationMs: Date.now() - startedAt,
                    truncated: outputTruncated || out.truncated,
                    ...injectionSummary(injection),
                }, null, 2),
            })
        })
    })
}

function injectionSummary(injection: EnvVarInjection): Record<string, unknown> {
    if (injection.keys.length === 0) return {}
    return {
        injected_env_keys: injection.keys,
        injected_env_sources: injection.sources,
    }
}

function appendBounded(current: string, chunk: string): { text: string; truncated: boolean } {
    const combined = current + chunk
    if (combined.length <= MAX_STREAM_CHARS * 2) return { text: combined, truncated: false }
    return { text: combined.slice(-(MAX_STREAM_CHARS * 2)), truncated: true }
}

function stringArg(args: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const value = args[key]
        if (typeof value === 'string') return value
    }
    return ''
}

function numberArg(args: Record<string, unknown>, keys: string[], fallback: number): number {
    for (const key of keys) {
        const value = args[key]
        if (typeof value === 'number' && Number.isFinite(value)) return value
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value)
            if (Number.isFinite(parsed)) return parsed
        }
    }
    return fallback
}

function booleanArg(args: Record<string, unknown>, keys: string[], fallback = false): boolean {
    for (const key of keys) {
        const value = args[key]
        if (typeof value === 'boolean') return value
        if (typeof value === 'string') {
            if (value.toLowerCase() === 'true') return true
            if (value.toLowerCase() === 'false') return false
        }
    }
    return fallback
}

function clamp(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, n))
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
    if (text.length <= maxChars) return { text, truncated: false }
    const keepHead = Math.floor(maxChars * 0.6)
    const keepTail = maxChars - keepHead
    return {
        text: `${text.slice(0, keepHead)}\n\n...[truncated ${text.length - maxChars} chars]...\n\n${text.slice(-keepTail)}`,
        truncated: true,
    }
}
