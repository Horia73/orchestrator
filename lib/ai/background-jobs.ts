import fs from 'fs'
import path from 'path'
import { spawn as spawnProcess } from 'child_process'

import db, { addMessage, getConversation } from '@/lib/db'
import type { Message } from '@/lib/types'
import { augmentedEnv } from '@/lib/cli/resolve-bin'
import { activeRuntimePaths } from '@/lib/runtime-paths'
import { getActiveProfileId, runWithProfileContext } from '@/lib/profiles/context'
import { getActiveChatStream } from '@/lib/chat-streams'
import { enqueueFollowUp } from '@/lib/chat-followups'
import { generateId } from '@/lib/utils-chat'
import { displayPath } from '@/lib/ai/tools/sandbox'
import {
    createSecretStreamRedactor,
    redactSecretText,
    type EnvVarInjection,
} from '@/lib/ai/tools/env-vars'

/**
 * Tracked background jobs.
 *
 * A background job is a detached OS process owned by the SERVER, not by the
 * agent turn (or CLI subprocess) that started it — so it survives the end of
 * the turn. Claude Code's native `run_in_background` does NOT survive headless
 * turns (the CLI kills it ~5s after its final result), which is exactly the
 * gap this module fills for CLI-backed agents via the start_background_job
 * tool, and for API-backed agents via Bash run_in_background.
 *
 * Every job is registered in the per-profile `background_jobs` table. On exit
 * the server posts a completion notice into the owning conversation through
 * the steering follow-up queue: if a turn is streaming, the agent sees it
 * right after finishing; if the conversation is idle, a headless wake turn
 * runs so the agent can pick the result up immediately.
 *
 * Restart resilience: the spawned shell writes its exit code to a marker file,
 * and a boot-armed poll reconciles rows whose watcher died with the server.
 */

export interface BackgroundJobRow {
    id: string
    conversationId: string | null
    command: string
    description: string | null
    cwd: string | null
    pid: number | null
    logPath: string
    exitMarkerPath: string | null
    status: 'running' | 'exited' | 'killed' | 'lost'
    exitCode: number | null
    wakeOnExit: number
    startedAt: number
    endedAt: number | null
    notifiedAt: number | null
}

const LOG_TAIL_CHARS = 4_000
const WATCH_POLL_INTERVAL_MS = 30_000
/** Default cap on a background job before it is SIGTERMed. */
export const BACKGROUND_JOB_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
export const BACKGROUND_JOB_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000

const globalForJobs = globalThis as unknown as {
    __orchestratorBgJobWatcher?: ReturnType<typeof setInterval>
    __orchestratorBgJobsWatched?: Set<string>
}

/** Job ids whose exit is watched in-process (we spawned them this boot). */
const watchedJobs = globalForJobs.__orchestratorBgJobsWatched ?? new Set<string>()
if (!globalForJobs.__orchestratorBgJobsWatched) {
    globalForJobs.__orchestratorBgJobsWatched = watchedJobs
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function getBackgroundJob(id: string): BackgroundJobRow | null {
    const row = db.prepare('SELECT * FROM background_jobs WHERE id = ?').get(id) as
        | BackgroundJobRow
        | undefined
    return row ?? null
}

export function listBackgroundJobs(options?: {
    conversationId?: string
    runningOnly?: boolean
    limit?: number
}): BackgroundJobRow[] {
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100)
    const clauses: string[] = []
    const params: unknown[] = []
    if (options?.conversationId) {
        clauses.push('conversationId = ?')
        params.push(options.conversationId)
    }
    if (options?.runningOnly) {
        clauses.push("status = 'running'")
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    return db
        .prepare(`SELECT * FROM background_jobs ${where} ORDER BY startedAt DESC LIMIT ?`)
        .all(...params, limit) as BackgroundJobRow[]
}

function insertBackgroundJob(row: BackgroundJobRow): void {
    db.prepare(
        `INSERT INTO background_jobs
            (id, conversationId, command, description, cwd, pid, logPath, exitMarkerPath,
             status, exitCode, wakeOnExit, startedAt, endedAt, notifiedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        row.id,
        row.conversationId,
        row.command,
        row.description,
        row.cwd,
        row.pid,
        row.logPath,
        row.exitMarkerPath,
        row.status,
        row.exitCode,
        row.wakeOnExit,
        row.startedAt,
        row.endedAt,
        row.notifiedAt,
    )
}

function finalizeBackgroundJob(
    id: string,
    status: 'exited' | 'killed' | 'lost',
    exitCode: number | null,
): BackgroundJobRow | null {
    db.prepare(
        `UPDATE background_jobs
         SET status = ?, exitCode = ?, endedAt = ?
         WHERE id = ? AND status = 'running'`
    ).run(status, exitCode, Date.now(), id)
    return getBackgroundJob(id)
}

export function setBackgroundJobWake(id: string, wakeOnExit: boolean): void {
    db.prepare('UPDATE background_jobs SET wakeOnExit = ? WHERE id = ?').run(
        wakeOnExit ? 1 : 0,
        id,
    )
}

function markBackgroundJobNotified(id: string): void {
    db.prepare('UPDATE background_jobs SET notifiedAt = ? WHERE id = ?').run(Date.now(), id)
}

// ---------------------------------------------------------------------------
// Spawn + in-process watch
// ---------------------------------------------------------------------------

export interface StartBackgroundJobArgs {
    command: string
    cwd: string
    timeoutMs?: number
    injection: EnvVarInjection
    conversationId?: string | null
    description?: string | null
    /** Post a completion notice / wake the conversation when the job exits. */
    wakeOnExit?: boolean
}

export interface StartBackgroundJobResult {
    ok: boolean
    error?: string
    job?: BackgroundJobRow
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}

export function startTrackedBackgroundJob(args: StartBackgroundJobArgs): StartBackgroundJobResult {
    const id = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const jobsDir = path.join(activeRuntimePaths().workspaceDir, '.background-jobs')
    const logPath = path.join(jobsDir, `${id}.log`)
    const exitMarkerPath = path.join(jobsDir, `${id}.exit`)
    fs.mkdirSync(/* turbopackIgnore: true */ jobsDir, { recursive: true })

    const logStream = fs.createWriteStream(/* turbopackIgnore: true */ logPath, { flags: 'a' })
    const logRedactor = createSecretStreamRedactor(args.injection.redactions)
    logStream.write(redactSecretText(`$ ${args.command}\n`, args.injection.redactions))
    if (args.injection.keys.length > 0) {
        logStream.write(`[orchestrator] injected env keys: ${args.injection.keys.join(', ')}\n`)
    }
    logStream.write('\n')

    // Run the command in a subshell and persist its exit code to a marker
    // file — that is what lets a restarted server reconcile jobs whose
    // in-process watcher died with the old process.
    const wrappedCommand = [
        `(\n${args.command}\n)`,
        '__orch_bg_ec=$?',
        `printf '%s' "$__orch_bg_ec" > ${shellQuote(exitMarkerPath)}`,
        'exit $__orch_bg_ec',
    ].join('\n')

    const paths = activeRuntimePaths()
    const runtimeEnv = {
        ORCHESTRATOR_APP_DIR: process.cwd(),
        ORCHESTRATOR_AGENT_WORKSPACE_DIR: paths.agentWorkspaceDir,
        ORCHESTRATOR_PROFILE_STATE_DIR: paths.stateDir,
        ORCHESTRATOR_PROJECT_RUNS_DIR: path.join(process.cwd(), '.orchestrator', 'project-runs'),
    }
    let proc: ReturnType<typeof spawnProcess>
    try {
        proc = spawnProcess(process.env.SHELL || '/bin/zsh', ['-lc', wrappedCommand], {
            cwd: args.cwd,
            env: augmentedEnv({ ...runtimeEnv, ...args.injection.env }),
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
        })
    } catch (err) {
        logStream.end()
        return {
            ok: false,
            error: err instanceof Error ? err.message : `Could not start command in ${displayPath(args.cwd)}`,
        }
    }

    const timeoutMs = Math.min(
        Math.max(args.timeoutMs ?? BACKGROUND_JOB_DEFAULT_TIMEOUT_MS, 1_000),
        BACKGROUND_JOB_MAX_TIMEOUT_MS,
    )
    const profileId = getActiveProfileId()
    const row: BackgroundJobRow = {
        id,
        conversationId: args.conversationId ?? null,
        command: args.command,
        description: args.description ?? null,
        cwd: args.cwd,
        pid: proc.pid ?? null,
        logPath,
        exitMarkerPath,
        status: 'running',
        exitCode: null,
        wakeOnExit: args.wakeOnExit === false ? 0 : 1,
        startedAt: Date.now(),
        endedAt: null,
        notifiedAt: null,
    }
    insertBackgroundJob(row)
    watchedJobs.add(id)

    let timedOut = false
    const timer = setTimeout(() => {
        timedOut = true
        logStream.write(`\n[orchestrator] Timeout after ${timeoutMs}ms; sending SIGTERM.\n`)
        try { process.kill(-proc.pid!, 'SIGTERM') } catch { try { proc.kill('SIGTERM') } catch { /* gone */ } }
        setTimeout(() => {
            try { process.kill(-proc.pid!, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch { /* gone */ } }
        }, 1500)
    }, timeoutMs)

    const writeRedacted = (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
        const redacted = logRedactor.push(text)
        if (redacted) logStream.write(redacted)
    }
    proc.stdout?.on('data', writeRedacted)
    proc.stderr?.on('data', writeRedacted)
    proc.on('error', err => {
        logStream.write(`\n[orchestrator] spawn error: ${err.message}\n`)
    })
    proc.on('exit', code => {
        clearTimeout(timer)
        const tail = logRedactor.flush()
        if (tail) logStream.write(tail)
        const durationMs = Date.now() - row.startedAt
        logStream.write(`\n[orchestrator] exited with code ${code ?? 'unknown'} after ${durationMs}ms\n`)
        logStream.end()
        watchedJobs.delete(id)
        try {
            runWithProfileContext({ profileId }, () => {
                const finalized = finalizeBackgroundJob(
                    id,
                    timedOut ? 'killed' : 'exited',
                    typeof code === 'number' ? code : null,
                )
                if (finalized) void notifyBackgroundJobCompletion(profileId, finalized)
            })
        } catch (err) {
            console.error(`[background-jobs] failed to finalize ${id}`, err)
        }
    })
    proc.unref()

    return { ok: true, job: row }
}

export function killBackgroundJob(id: string, opts?: { silent?: boolean }): { ok: boolean; error?: string } {
    const job = getBackgroundJob(id)
    if (!job) return { ok: false, error: `Unknown background job: ${id}` }
    if (job.status !== 'running') return { ok: false, error: `Job ${id} is not running (status: ${job.status})` }
    if (!job.pid) return { ok: false, error: `Job ${id} has no recorded pid` }
    if (opts?.silent !== false) {
        // A deliberate kill needs no completion wake — the caller already knows.
        setBackgroundJobWake(id, false)
    }
    try { process.kill(-job.pid, 'SIGTERM') } catch { try { process.kill(job.pid, 'SIGTERM') } catch { /* gone */ } }
    setTimeout(() => {
        try { process.kill(-job.pid!, 'SIGKILL') } catch { try { process.kill(job.pid!, 'SIGKILL') } catch { /* gone */ } }
    }, 1500)
    return { ok: true }
}

export function readBackgroundJobLogTail(job: BackgroundJobRow, maxChars = LOG_TAIL_CHARS): string {
    try {
        const stat = fs.statSync(/* turbopackIgnore: true */ job.logPath)
        const start = Math.max(0, stat.size - maxChars * 4)
        const fd = fs.openSync(/* turbopackIgnore: true */ job.logPath, 'r')
        try {
            const buf = Buffer.alloc(Math.min(stat.size - start, maxChars * 4))
            fs.readSync(fd, buf, 0, buf.length, start)
            const text = buf.toString('utf-8')
            return text.length > maxChars ? text.slice(-maxChars) : text
        } finally {
            fs.closeSync(fd)
        }
    } catch {
        return ''
    }
}

// ---------------------------------------------------------------------------
// Completion notice → steering queue / wake
// ---------------------------------------------------------------------------

export const BACKGROUND_JOB_NOTICE_TAG = 'background-job-notice'

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`
    const seconds = Math.round(ms / 1000)
    if (seconds < 90) return `${seconds}s`
    const minutes = Math.round(seconds / 60)
    if (minutes < 90) return `${minutes}m`
    return `${Math.round(minutes / 60)}h`
}

export function buildBackgroundJobNotice(job: BackgroundJobRow): string {
    const durationMs = (job.endedAt ?? Date.now()) - job.startedAt
    const outcome =
        job.status === 'killed'
            ? 'was killed (timeout or explicit stop)'
            : job.status === 'lost'
                ? 'is no longer running (its exit was not observed — likely a server restart)'
                : job.exitCode === 0
                    ? 'finished successfully'
                    : `finished with exit code ${job.exitCode ?? 'unknown'}`
    const tail = readBackgroundJobLogTail(job).trim()
    return [
        `<${BACKGROUND_JOB_NOTICE_TAG}>`,
        `Background job ${job.id} ${outcome} after ${formatDuration(durationMs)}.`,
        `Command: ${job.command}`,
        ...(job.description ? [`Purpose: ${job.description}`] : []),
        `Log: ${displayPath(job.logPath)}`,
        ...(tail ? ['Log tail:', '```', tail, '```'] : ['(no output captured)']),
        '',
        'This is an automated completion notice, not a message typed by the user. Pick up the task this job belongs to: verify the outcome from the log, continue with the next pending step, and report briefly. If nothing further is needed, summarize the result in one or two sentences.',
        `</${BACKGROUND_JOB_NOTICE_TAG}>`,
    ].join('\n')
}

/**
 * Post the completion notice into the owning conversation. Runs inside the
 * job's profile context. The notice is persisted immediately (visible in the
 * conversation right away) and queued as a steering follow-up: a streaming
 * turn picks it up the moment it finishes; an idle conversation gets a
 * headless wake turn right away.
 */
async function notifyBackgroundJobCompletion(profileId: string, job: BackgroundJobRow): Promise<void> {
    if (!job.wakeOnExit || !job.conversationId || job.notifiedAt) return
    if (!getConversation(job.conversationId)) return

    const message: Message = {
        id: generateId(),
        role: 'user',
        content: buildBackgroundJobNotice(job),
        timestamp: Date.now(),
    }
    addMessage(job.conversationId, message)
    enqueueFollowUp(job.conversationId, {
        id: message.id,
        userMessageId: message.id,
        content: message.content,
        source: 'background-job',
        queuedAt: Date.now(),
    })
    markBackgroundJobNotified(job.id)

    if (!getActiveChatStream(job.conversationId)) {
        // Idle conversation — wake it now instead of waiting for the sweep.
        const { triggerFollowUpDrain } = await import('@/lib/chat-wake')
        void triggerFollowUpDrain(profileId, job.conversationId).catch(err => {
            console.error(`[background-jobs] wake for ${job.id} failed`, err)
        })
    }
}

// ---------------------------------------------------------------------------
// Boot reconciliation + liveness poll
// ---------------------------------------------------------------------------

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

function readExitMarker(job: BackgroundJobRow): number | null {
    if (!job.exitMarkerPath) return null
    try {
        const raw = fs.readFileSync(/* turbopackIgnore: true */ job.exitMarkerPath, 'utf-8').trim()
        const parsed = Number.parseInt(raw, 10)
        return Number.isFinite(parsed) ? parsed : null
    } catch {
        return null
    }
}

/** Reconcile 'running' rows whose in-process watcher is gone (server restart). */
async function reconcileBackgroundJobsForActiveProfile(profileId: string): Promise<void> {
    const running = listBackgroundJobs({ runningOnly: true, limit: 100 })
    for (const job of running) {
        if (watchedJobs.has(job.id)) continue
        if (job.pid && pidAlive(job.pid)) continue
        const exitCode = readExitMarker(job)
        const finalized = finalizeBackgroundJob(
            job.id,
            exitCode !== null ? 'exited' : 'lost',
            exitCode,
        )
        if (finalized) {
            try {
                await notifyBackgroundJobCompletion(profileId, finalized)
            } catch (err) {
                console.error(`[background-jobs] completion notice for ${job.id} failed`, err)
            }
        }
    }
}

export function startBackgroundJobWatcher(): void {
    if (globalForJobs.__orchestratorBgJobWatcher) return
    const sweep = async () => {
        const { listProfiles } = await import('@/lib/profiles/store')
        for (const profile of listProfiles()) {
            try {
                await runWithProfileContext(
                    { profileId: profile.id, role: profile.role },
                    () => reconcileBackgroundJobsForActiveProfile(profile.id),
                )
            } catch (err) {
                console.error(`[background-jobs] reconcile failed for profile ${profile.id}`, err)
            }
        }
    }
    globalForJobs.__orchestratorBgJobWatcher = setInterval(() => {
        void sweep().catch(err => console.error('[background-jobs] sweep failed', err))
    }, WATCH_POLL_INTERVAL_MS)
    // One immediate pass so jobs orphaned by a restart notify promptly.
    void sweep().catch(err => console.error('[background-jobs] boot reconcile failed', err))
}
