import fs from 'fs'
import path from 'path'
import { spawn as spawnProcess } from 'child_process'

import type { ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { MAX_TOOL_DELTA_TEXT_CHARS } from '@/lib/ai/reasoning-limits'
import { AGENT_WORKSPACE_DIR, WORKSPACE_DIR } from '@/lib/runtime-paths'
import { displayPath } from './sandbox'
export { bashTool } from './bash-def'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_STREAM_CHARS = 120_000
const BACKGROUND_DIR = `${WORKSPACE_DIR}/.background-jobs`

export async function executeBash(args: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const command = stringArg(args, ['command'])
    if (!command.trim()) return { success: false, error: 'Missing required parameter: command' }

    const cwdResult = resolveCwd(stringArg(args, ['cwd']))
    if (!cwdResult.ok) return { success: false, error: cwdResult.error }

    const timeoutMs = clamp(Math.floor(numberArg(args, ['timeout'], DEFAULT_TIMEOUT_MS)), 1_000, MAX_TIMEOUT_MS)
    const runInBackground = booleanArg(args, ['run_in_background'])
    if (runInBackground) return startBackgroundCommand(command, cwdResult.cwd, timeoutMs)
    return runForegroundCommand(command, cwdResult.cwd, timeoutMs, ctx)
}

function resolveCwd(cwdArg: string): { ok: true; cwd: string } | { ok: false; error: string } {
    const clean = cwdArg.trim()
    if (!clean) return { ok: true, cwd: AGENT_WORKSPACE_DIR }
    const resolved = path.normalize(path.isAbsolute(clean) ? clean : `${AGENT_WORKSPACE_DIR}/${clean}`)
    return { ok: true, cwd: resolved }
}

function startBackgroundCommand(command: string, cwd: string, timeoutMs: number): ToolResult {
    const id = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const logPath = `${BACKGROUND_DIR}/${id}.log`
    ensureParentDir(logPath)
    const logStream = fs.createWriteStream(/* turbopackIgnore: true */ logPath, { flags: 'a' })
    logStream.write(`$ ${command}\n\n`)

    let proc: ReturnType<typeof spawnProcess>
    try {
        proc = spawnProcess(process.env.SHELL || '/bin/zsh', ['-lc', command], {
            cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        })
    } catch (err) {
        logStream.end()
        return {
            success: false,
            error: err instanceof Error ? err.message : `Could not start command in ${displayPath(cwd)}`,
        }
    }

    const startedAt = Date.now()
    const timer = setTimeout(() => {
        logStream.write(`\n[orchestrator] Timeout after ${timeoutMs}ms; sending SIGTERM.\n`)
        try { process.kill(-proc.pid!, 'SIGTERM') } catch { try { proc.kill('SIGTERM') } catch { /* already gone */ } }
        setTimeout(() => {
            try { process.kill(-proc.pid!, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch { /* already gone */ } }
        }, 1500)
    }, timeoutMs)

    proc.stdout?.pipe(logStream, { end: false })
    proc.stderr?.pipe(logStream, { end: false })
    proc.on('exit', code => {
        clearTimeout(timer)
        logStream.write(`\n[orchestrator] exited with code ${code ?? 'unknown'} after ${Date.now() - startedAt}ms\n`)
        logStream.end()
    })
    proc.unref()

    return {
        success: true,
        data: {
            id,
            pid: proc.pid,
            cwd: displayPath(cwd),
            log_path: displayPath(logPath),
            started: true,
        },
    }
}

async function runForegroundCommand(command: string, cwd: string, timeoutMs: number, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const { spawn: ptySpawn } = await import('node' + '-pty') as typeof import('node-pty')

    return new Promise<ToolResult>(resolve => {
        const startedAt = Date.now()
        let output = ''
        let outputTruncated = false
        let finished = false
        let timedOut = false
        let streamedDeltaChars = 0
        let streamTruncatedNoticeSent = false
        const signal = ctx?.signal
        const toolCallId = ctx?.currentToolCallId
        let proc: ReturnType<typeof ptySpawn>

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
            emitToolDelta(text)
            const next = appendBounded(output, text)
            output = next.text
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
            proc = ptySpawn(process.env.SHELL || '/bin/zsh', ['-lc', command], {
                name: 'xterm-256color',
                cols: 120,
                rows: 32,
                cwd,
                env: {
                    ...process.env,
                    FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
                    TERM: 'xterm-256color',
                } as Record<string, string>,
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
            const out = truncateText(output, MAX_STREAM_CHARS)
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
                }, null, 2),
            })
        })
    })
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

function ensureParentDir(filePath: string): void {
    const dir = path.dirname(/* turbopackIgnore: true */ filePath)
    fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true })
}
