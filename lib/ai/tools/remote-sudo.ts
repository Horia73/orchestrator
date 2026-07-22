import type { IPty } from 'node-pty'

import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { MAX_TOOL_DELTA_TEXT_CHARS } from '@/lib/ai/reasoning-limits'
import { agentCommandEnv } from '@/lib/cli/resolve-bin'

import {
    createSecretStreamRedactor,
    redactSecretText,
    resolveEnvVarInjection,
    type SecretRedaction,
} from './env-vars'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_CHARS = 120_000
const SUDO_PROMPT = '[orchestrator-sudo-password]: '
const PASSWORD_REQUIRED_RE = /sudo:\s*(?:a password is required|password is required|no tty present and no askpass program specified)/i
const HOST_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?)$/i
const USER_RE = /^[a-z_][a-z0-9_-]*$/i

export const remoteSudoTool: ToolDef = {
    id: 'remote_sudo',
    name: 'remote_sudo',
    description: [
        'Run one privileged command on a remote SSH host without putting the sudo password in model-visible arguments, command text, or logs.',
        'Pass only the server-side environment-variable NAME in password_env_key. The server resolves and redacts its value. The tool first tries sudo -n and sends no stdin when passwordless sudo works. Only after sudo explicitly reports that a password is required does it retry with sudo -S, wait for its private prompt marker, and write the password exactly once.',
        'SSH authentication must already work non-interactively (agent/key). Use this instead of Bash/ssh when a remote command needs a sudo password. The remote command itself must not print secrets.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            host: { type: 'string', description: 'Remote SSH hostname or IP address.' },
            user: { type: 'string', description: 'Optional remote SSH user.' },
            port: { type: 'integer', description: 'Optional SSH port (1-65535).' },
            identity_file: { type: 'string', description: 'Optional local SSH private-key path. The key contents are never read or returned by this tool.' },
            command: { type: 'string', description: 'Command to run remotely under sudo via /bin/bash -lc.' },
            password_env_key: { type: 'string', description: 'Name of the configured server-side environment variable containing the sudo password. Never pass the password value.' },
            timeout: { type: 'integer', description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}, capped at ${MAX_TIMEOUT_MS}.` },
        },
        required: ['host', 'command', 'password_env_key'],
        additionalProperties: false,
    },
    tags: ['execute', 'shell', 'secret'],
}

interface PtyLike {
    onData(callback: (data: string) => void): { dispose(): void } | void
    onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } | void
    write(data: string): void
    kill(signal?: string): void
}

export interface RemoteSudoDependencies {
    spawnPty?: (
        file: string,
        args: string[],
        options: { name: string; cols: number; rows: number; env: Record<string, string> },
    ) => PtyLike
}

interface RemotePhaseResult {
    exitCode: number | null
    output: string
    timedOut: boolean
    promptSeen: boolean
    passwordWrites: number
    renderedCommand: string
}

export async function executeRemoteSudo(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
    dependencies: RemoteSudoDependencies = {},
): Promise<ToolResult> {
    const host = stringValue(args.host).trim()
    const user = stringValue(args.user).trim()
    const command = stringValue(args.command)
    const passwordEnvKey = stringValue(args.password_env_key).trim()
    const identityFile = stringValue(args.identity_file).trim()
    const port = integerValue(args.port)
    const timeoutMs = clamp(integerValue(args.timeout) ?? DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS)

    if (!host) return { success: false, error: 'host is required.' }
    if (!HOST_RE.test(host)) return { success: false, error: 'host must be a hostname or IP address without shell syntax.' }
    if (user && !USER_RE.test(user)) return { success: false, error: 'user contains unsupported characters.' }
    if (!command.trim()) return { success: false, error: 'command is required.' }
    if (!passwordEnvKey) return { success: false, error: 'password_env_key is required.' }
    if (port !== null && (port < 1 || port > 65_535)) return { success: false, error: 'port must be between 1 and 65535.' }

    const resolution = resolveEnvVarInjection([passwordEnvKey])
    if (!resolution.ok) {
        return {
            success: false,
            error: resolution.error,
            data: resolution.missing ? { missing_env_keys: resolution.missing } : undefined,
        }
    }
    const password = resolution.injection.env[passwordEnvKey]
    const redactions = resolution.injection.redactions
    const sshArgs = buildSshArgs({ host, user, port, identityFile })
    const startedAt = Date.now()

    const fast = await runRemotePhase({
        sshArgs,
        remoteCommand: `sudo -n -- /bin/bash -lc ${shellQuote(command)}`,
        timeoutMs,
        redactions,
        ctx,
        spawnPty: dependencies.spawnPty,
    })
    if (!fast.timedOut && fast.exitCode === 0) {
        return {
            success: true,
            data: {
                host,
                command,
                rendered_command: fast.renderedCommand,
                exit_code: fast.exitCode,
                output: fast.output,
                sudo_mode: 'non-interactive',
                password_sent: false,
                password_env_key: passwordEnvKey,
                duration_ms: Date.now() - startedAt,
            },
        }
    }

    if (fast.timedOut || !PASSWORD_REQUIRED_RE.test(stripAnsi(fast.output))) {
        return remoteFailure('Remote sudo -n command failed without a sudo password prompt.', fast, redactions, {
            host,
            command,
            passwordEnvKey,
            durationMs: Date.now() - startedAt,
        })
    }

    const remainingMs = Math.max(1_000, timeoutMs - (Date.now() - startedAt))
    const prompted = await runRemotePhase({
        sshArgs,
        remoteCommand: `sudo -S -p ${shellQuote(SUDO_PROMPT)} -- /bin/bash -lc ${shellQuote(command)}`,
        timeoutMs: remainingMs,
        password,
        redactions,
        ctx,
        spawnPty: dependencies.spawnPty,
    })

    if (!prompted.timedOut && prompted.exitCode === 0 && prompted.promptSeen && prompted.passwordWrites === 1) {
        return {
            success: true,
            data: {
                host,
                command,
                rendered_command: prompted.renderedCommand,
                exit_code: prompted.exitCode,
                output: prompted.output,
                sudo_mode: 'prompted',
                password_sent: true,
                password_write_count: 1,
                password_env_key: passwordEnvKey,
                duration_ms: Date.now() - startedAt,
            },
        }
    }

    return remoteFailure(
        prompted.promptSeen
            ? 'Remote sudo command failed after the password prompt.'
            : 'Remote sudo did not present the expected password prompt; no password was sent.',
        prompted,
        redactions,
        { host, command, passwordEnvKey, durationMs: Date.now() - startedAt },
    )
}

async function runRemotePhase(input: {
    sshArgs: string[]
    remoteCommand: string
    timeoutMs: number
    password?: string
    redactions: SecretRedaction[]
    ctx?: ToolExecutionContext
    spawnPty?: RemoteSudoDependencies['spawnPty']
}): Promise<RemotePhaseResult> {
    const { spawn: nativeSpawn } = input.spawnPty
        ? { spawn: input.spawnPty }
        : await import('node' + '-pty') as typeof import('node-pty')
    const argv = [...input.sshArgs, input.remoteCommand]
    const renderedCommand = renderCommand('ssh', argv)

    return new Promise<RemotePhaseResult>((resolve) => {
        let proc: PtyLike
        let finished = false
        let timedOut = false
        let promptSeen = false
        let passwordWrites = 0
        let promptTail = ''
        let output = ''
        let streamedChars = 0
        const redactor = createSecretStreamRedactor(input.redactions)
        const toolCallId = input.ctx?.currentToolCallId

        const appendRedacted = (text: string) => {
            if (!text) return
            output = appendBounded(output, text, MAX_OUTPUT_CHARS)
            if (!toolCallId || streamedChars >= MAX_TOOL_DELTA_TEXT_CHARS) return
            const emitted = text.slice(0, MAX_TOOL_DELTA_TEXT_CHARS - streamedChars)
            streamedChars += emitted.length
            void input.ctx?.onToolDelta?.(toolCallId, 'remote_sudo', {
                stream: 'pty',
                text: emitted,
                timestamp: Date.now(),
            })
        }

        const settle = (exitCode: number | null) => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            input.ctx?.signal?.removeEventListener('abort', onAbort)
            appendRedacted(redactor.flush())
            resolve({
                exitCode,
                output: stripPrompt(output),
                timedOut,
                promptSeen,
                passwordWrites,
                renderedCommand,
            })
        }

        const stop = (timeout: boolean) => {
            timedOut ||= timeout
            try { proc.kill('SIGTERM') } catch { /* process already exited */ }
            setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* process already exited */ } }, 1_000)
        }

        const timer = setTimeout(() => stop(true), input.timeoutMs)
        const onAbort = () => stop(false)
        input.ctx?.signal?.addEventListener('abort', onAbort, { once: true })

        try {
            proc = nativeSpawn('ssh', argv, {
                name: 'xterm-256color',
                cols: 120,
                rows: 32,
                // Deliberately do not inject the sudo secret into the SSH
                // process environment. It exists only long enough to answer
                // the exact private sudo prompt below.
                env: agentCommandEnv() as Record<string, string>,
            }) as IPty
        } catch (err) {
            clearTimeout(timer)
            input.ctx?.signal?.removeEventListener('abort', onAbort)
            const message = redactSecretText(err instanceof Error ? err.message : String(err), input.redactions)
            resolve({ exitCode: null, output: message, timedOut: false, promptSeen: false, passwordWrites: 0, renderedCommand })
            return
        }

        proc.onData((chunk) => {
            if (input.password && !promptSeen) {
                promptTail = `${promptTail}${chunk}`.slice(-(SUDO_PROMPT.length * 2))
                if (promptTail.includes(SUDO_PROMPT)) {
                    promptSeen = true
                    passwordWrites += 1
                    proc.write(`${input.password}\n`)
                }
            }
            appendRedacted(redactor.push(chunk))
        })
        proc.onExit(({ exitCode }) => settle(typeof exitCode === 'number' ? exitCode : null))
    })
}

function buildSshArgs(input: {
    host: string
    user: string
    port: number | null
    identityFile: string
}): string[] {
    const args = [
        '-tt',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=2',
    ]
    if (input.port !== null) args.push('-p', String(input.port))
    if (input.identityFile) args.push('-i', input.identityFile)
    args.push('--', input.user ? `${input.user}@${input.host}` : input.host)
    return args
}

function remoteFailure(
    message: string,
    phase: RemotePhaseResult,
    redactions: SecretRedaction[],
    metadata: { host: string; command: string; passwordEnvKey: string; durationMs: number },
): ToolResult {
    return {
        success: false,
        error: redactSecretText(JSON.stringify({
            message,
            host: metadata.host,
            command: metadata.command,
            rendered_command: phase.renderedCommand,
            exit_code: phase.exitCode,
            timed_out: phase.timedOut,
            output: phase.output,
            sudo_prompt_seen: phase.promptSeen,
            password_sent: phase.passwordWrites === 1,
            password_write_count: phase.passwordWrites,
            password_env_key: metadata.passwordEnvKey,
            duration_ms: metadata.durationMs,
        }, null, 2), redactions),
    }
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}

function renderCommand(file: string, args: string[]): string {
    return [file, ...args].map((part) => shellQuote(part)).join(' ')
}

function stripPrompt(text: string): string {
    return text.split(SUDO_PROMPT).join('[sudo password prompt]')
}

function stripAnsi(text: string): string {
    return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
}

function appendBounded(current: string, chunk: string, maxChars: number): string {
    const combined = current + chunk
    return combined.length <= maxChars ? combined : combined.slice(-maxChars)
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function integerValue(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    return Math.floor(value)
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}
