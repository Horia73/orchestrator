import { type IPty, spawn as ptySpawn } from 'node-pty'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

import { CLI_SPECS, getCliLoginArgs, type CliId } from './specs'
import { resolveBin, augmentedEnv } from './resolve-bin'
import { codexCliEnv } from './codex-env'
import { AGENT_WORKSPACE_DIR } from '@/lib/config'

// ---------------------------------------------------------------------------
// In-memory PTY session manager.
//
// We use node-pty (real pty) so interactive CLIs see a TTY: ANSI colour, line
// editing, resize, mouse modes, bracketed paste — everything xterm.js renders
// on the client. Plain child_process.spawn would degrade to non-TTY output,
// which breaks `claude` REPL and `codex` interactive flows.
//
// PTY data is a single byte stream — we forward as base64 so binary-safe over
// SSE (xterm.js writes the decoded buffer back into the terminal).
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 30 * 60 * 1000
const MAX_BUFFER_BYTES = 512 * 1024

export type SessionMode = 'install' | 'login' | 'logout' | 'status' | 'generate' | 'free' | 'setup-token'

export interface SessionEvent {
    type: 'data' | 'exit' | 'error'
    /** Base64-encoded raw PTY output for `data` events. */
    data?: string
    /** Set on `exit`. */
    code?: number | null
    signal?: number | null
    /** Set on `error`. */
    message?: string
}

interface Session {
    id: string
    cli: CliId
    mode: SessionMode
    createdAt: number
    pty: IPty
    emitter: EventEmitter
    /** Rolling buffer of recent output so reconnecting clients see history. */
    buffer: SessionEvent[]
    bufferBytes: number
    exited: boolean
    exitCode: number | null
    cols: number
    rows: number
    idleTimer: NodeJS.Timeout
}

// Survive Next dev fast-refresh.
const globalForSessions = globalThis as unknown as {
    __cliSessions?: Map<string, Session>
}
const sessions: Map<string, Session> = globalForSessions.__cliSessions ?? new Map()
if (process.env.NODE_ENV !== 'production') globalForSessions.__cliSessions = sessions

interface StartArgs {
    cli: CliId
    mode: SessionMode
    /** Override default args for the spec. Used by `generate` mode. */
    extraArgs?: string[]
    /** Initial terminal size — defaults to 100x32. */
    cols?: number
    rows?: number
    /** cwd for the spawned process. */
    cwd?: string
}

export function startSession(args: StartArgs): string {
    const spec = CLI_SPECS[args.cli]

    let cliArgs: string[]
    let binName = spec.bin
    switch (args.mode) {
        case 'install':
            binName = spec.installBin
            cliArgs = spec.installArgs
            break
        case 'login': cliArgs = getCliLoginArgs(args.cli); break
        case 'logout': cliArgs = spec.logoutArgs; break
        case 'status': cliArgs = spec.statusArgs; break
        case 'generate': cliArgs = args.extraArgs ?? []; break
        case 'free': cliArgs = []; break
        case 'setup-token':
            // Claude Code mints a long-lived API token via `claude
            // setup-token`. Codex has no equivalent; the spawn route rejects
            // setup-token for unsupported CLIs so we don't need to handle it
            // here defensively beyond throwing if the spec lacks args.
            if (!spec.setupTokenArgs) {
                throw new Error(`${spec.name} does not support setup-token mode`)
            }
            cliArgs = spec.setupTokenArgs
            break
    }

    const cols = args.cols ?? 100
    const rows = args.rows ?? 32

    // Resolve the binary explicitly — Next.js may inherit a sparse PATH
    // that misses ~/.local/bin or ~/.npm-global/bin. resolveBin walks the
    // common install locations so spawn never fails with posix_spawnp.
    const binPath = resolveBin(binName)

    // FORCE_COLOR + a full xterm-256color TERM gives the CLI permission to
    // render colours and use cursor addressing — both important for the
    // Claude Code TUI.
    //
    // Default cwd to the same workspace used by agent runs so the terminal
    // and automated provider paths agree about where the model starts.
    const env = args.cli === 'codex' && args.mode !== 'install'
        ? codexCliEnv({ FORCE_COLOR: '1', TERM: 'xterm-256color' })
        : augmentedEnv({ FORCE_COLOR: '1', TERM: 'xterm-256color' })

    const pty = ptySpawn(binPath, cliArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: args.cwd ?? AGENT_WORKSPACE_DIR,
        env: env as { [key: string]: string },
    })

    const id = randomUUID()
    const emitter = new EventEmitter()
    emitter.setMaxListeners(20)

    const session: Session = {
        id,
        cli: args.cli,
        mode: args.mode,
        createdAt: Date.now(),
        pty,
        emitter,
        buffer: [],
        bufferBytes: 0,
        exited: false,
        exitCode: null,
        cols,
        rows,
        idleTimer: setTimeout(() => closeSession(id, 'idle'), IDLE_TIMEOUT_MS),
    }

    const push = (event: SessionEvent) => {
        const size = (event.data?.length ?? 0) + 16
        session.buffer.push(event)
        session.bufferBytes += size
        while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
            const dropped = session.buffer.shift()
            session.bufferBytes -= (dropped?.data?.length ?? 0) + 16
        }
        emitter.emit('event', event)
    }

    pty.onData(chunk => {
        // Encode raw bytes as base64 — string passes cleanly through JSON/SSE,
        // and the client decodes back to binary before xterm.write().
        const base64 = Buffer.from(chunk, 'binary').toString('base64')
        push({ type: 'data', data: base64 })
    })

    pty.onExit(({ exitCode, signal }) => {
        push({ type: 'exit', code: exitCode ?? null, signal: signal ?? null })
        finalize(session, exitCode ?? null)
    })

    sessions.set(id, session)
    return id
}

function finalize(session: Session, code: number | null) {
    if (session.exited) return
    session.exited = true
    session.exitCode = code
    clearTimeout(session.idleTimer)
    // Hold session 60s after exit so late SSE re-connects can replay the tail.
    setTimeout(() => sessions.delete(session.id), 60_000)
}

export function getSession(id: string): Session | undefined {
    return sessions.get(id)
}

/** Snapshot serializable for HTTP responses (no live process handles). */
export function describeSession(id: string) {
    const s = sessions.get(id)
    if (!s) return null
    return {
        id: s.id,
        cli: s.cli,
        mode: s.mode,
        createdAt: s.createdAt,
        exited: s.exited,
        exitCode: s.exitCode,
        bufferBytes: s.bufferBytes,
        cols: s.cols,
        rows: s.rows,
    }
}

/** Forward keystrokes (raw, ANSI-escape-aware) to the PTY. */
export function writeInput(id: string, data: string): boolean {
    const s = sessions.get(id)
    if (!s || s.exited) return false
    try {
        s.pty.write(data)
        return true
    } catch {
        return false
    }
}

/** Inform the PTY of a new terminal size — needed for TUI layout. */
export function resizeSession(id: string, cols: number, rows: number): boolean {
    const s = sessions.get(id)
    if (!s || s.exited) return false
    try {
        s.pty.resize(cols, rows)
        s.cols = cols
        s.rows = rows
        return true
    } catch {
        return false
    }
}

export function closeSession(id: string, reason: 'user' | 'idle' = 'user'): boolean {
    const s = sessions.get(id)
    if (!s) return false
    if (!s.exited) {
        try {
            s.pty.kill(reason === 'idle' ? 'SIGKILL' : 'SIGTERM')
        } catch { /* gone */ }
        // Force-kill stragglers that ignore SIGTERM.
        setTimeout(() => { try { s.pty.kill('SIGKILL') } catch { /* gone */ } }, 2000)
    }
    return true
}

/**
 * Subscribe to a session's events. Returns the rolling buffer + an
 * unsubscribe function.
 */
export function subscribe(
    id: string,
    listener: (event: SessionEvent) => void
): { history: SessionEvent[]; unsubscribe: () => void } | null {
    const s = sessions.get(id)
    if (!s) return null
    s.emitter.on('event', listener)
    return {
        history: [...s.buffer],
        unsubscribe: () => s.emitter.off('event', listener),
    }
}
