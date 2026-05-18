import fs from 'fs'
import path from 'path'
import { spawn as spawnProcess } from 'child_process'
import { spawn as ptySpawn } from 'node-pty'

import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { AGENT_WORKSPACE_DIR, WORKSPACE_DIR } from '@/lib/config'
import { commandMentionsProtectedAgentPath, displayPath, resolveSandboxedWritable } from './sandbox'
import { booleanArg, clamp, ensureParentDir, numberArg, stringArg, truncateText } from './helpers'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_STREAM_CHARS = 120_000
const BACKGROUND_DIR = path.join(/* turbopackIgnore: true */ WORKSPACE_DIR, '.background-jobs')
const PROVIDER_PRIVATE_DISCOVERY_NAMES = ['.claude', '.claude-memory', 'CLAUDE.md']

export const bashTool: ToolDef = {
    id: 'Bash',
    name: 'Bash',
    description: 'Runs a shell command in the writable agent workspace. Use for build/test/search commands. Foreground commands are timed out and output-limited; background commands return a log path.',
    input_schema: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'Shell command to run.',
            },
            description: {
                type: 'string',
                description: 'Short human-readable purpose for the command.',
            },
            timeout: {
                type: 'integer',
                description: 'Timeout in milliseconds. Defaults to 120000 and is capped at 600000.',
            },
            run_in_background: {
                type: 'boolean',
                description: 'When true, start the command and return immediately with a log path.',
            },
            cwd: {
                type: 'string',
                description: 'Optional working directory inside the writable workspace. Defaults to the workspace root.',
            },
        },
        required: ['command'],
    },
    tags: ['execute', 'shell'],
}

export async function executeBash(args: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const command = stringArg(args, ['command'])
    if (!command.trim()) return { success: false, error: 'Missing required parameter: command' }
    if (commandMentionsProtectedAgentPath(command)) {
        return {
            success: false,
            error: 'Bash cannot access protected workspace secret files such as .env.local. Use SetEnv for secret updates.',
        }
    }

    const cwdResult = resolveCwd(stringArg(args, ['cwd']))
    if (!cwdResult.ok) return { success: false, error: cwdResult.error }

    const timeoutMs = clamp(Math.floor(numberArg(args, ['timeout'], DEFAULT_TIMEOUT_MS)), 1_000, MAX_TIMEOUT_MS)
    const runInBackground = booleanArg(args, ['run_in_background'])
    if (runInBackground) return startBackgroundCommand(command, cwdResult.cwd, timeoutMs)
    return runForegroundCommand(command, cwdResult.cwd, timeoutMs, ctx)
}

function resolveCwd(cwdArg: string): { ok: true; cwd: string } | { ok: false; error: string } {
    if (!cwdArg.trim()) return { ok: true, cwd: AGENT_WORKSPACE_DIR }
    const sandboxed = resolveSandboxedWritable(cwdArg)
    if (!sandboxed.ok) return { ok: false, error: sandboxed.error }
    if (!fs.existsSync(/* turbopackIgnore: true */ sandboxed.resolved)) {
        return { ok: false, error: `Working directory not found: ${displayPath(sandboxed.resolved)}` }
    }
    if (!fs.statSync(/* turbopackIgnore: true */ sandboxed.resolved).isDirectory()) {
        return { ok: false, error: `Working path is not a directory: ${displayPath(sandboxed.resolved)}` }
    }
    return { ok: true, cwd: sandboxed.resolved }
}

function startBackgroundCommand(command: string, cwd: string, timeoutMs: number): ToolResult {
    const id = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const logPath = path.join(/* turbopackIgnore: true */ BACKGROUND_DIR, `${id}.log`)
    ensureParentDir(logPath)
    const logStream = fs.createWriteStream(/* turbopackIgnore: true */ logPath, { flags: 'a' })
    logStream.write(`$ ${command}\n\n`)

    const proc = spawnProcess(process.env.SHELL || '/bin/zsh', ['-lc', command], {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    })

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

function runForegroundCommand(command: string, cwd: string, timeoutMs: number, ctx?: ToolExecutionContext): Promise<ToolResult> {
    return new Promise<ToolResult>(resolve => {
        const startedAt = Date.now()
        let output = ''
        let outputTruncated = false
        let finished = false
        let timedOut = false
        const signal = ctx?.signal
        const toolCallId = ctx?.currentToolCallId

        const emit = (text: string) => {
            if (toolCallId && text) {
                void ctx?.onToolDelta?.(toolCallId, 'Bash', {
                    stream: 'pty',
                    text,
                    timestamp: Date.now(),
                })
            }
            const next = appendBounded(output, text)
            output = next.text
            outputTruncated ||= next.truncated
        }

        const proc = ptySpawn(process.env.SHELL || '/bin/zsh', ['-lc', command], {
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

        emit(`\x1b[2m$ ${command}\x1b[0m\r\n`)

        proc.onData(chunk => {
            emit(chunk)
        })
        proc.onExit(({ exitCode }) => {
            const visibleOutput = filterRoutineDiscoveryOutput(command, output)
            const out = truncateText(visibleOutput, MAX_STREAM_CHARS)
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

function filterRoutineDiscoveryOutput(command: string, output: string): string {
    if (!isRoutineDiscoveryCommand(command)) return output
    if (PROVIDER_PRIVATE_DISCOVERY_NAMES.some(name => command.includes(name))) return output
    return output
        .split('\n')
        .filter(line => !PROVIDER_PRIVATE_DISCOVERY_NAMES.some(name => line.includes(name)))
        .join('\n')
}

function isRoutineDiscoveryCommand(command: string): boolean {
    return /(^|[;&|]\s*)(command\s+)?(ls|find)(\s|$)/.test(command)
}
