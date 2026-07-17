import fs from 'fs'
import path from 'path'
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { canRunBackgroundLoop } from '@/lib/ai/background-leadership'

const execFileAsync = promisify(execFile)
const RECENT_RUN_MS = 72 * 60 * 60 * 1000
const RECOVERY_COOLDOWN_MS = 5 * 60 * 1000
const RECOVERY_BOOT_DELAY_MS = 15_000
const RECOVERY_TIMEOUT_MS = 3 * 60 * 1000

interface SelfDevOwner {
    profileId?: string | null
    conversationId?: string | null
    parentRequestId?: string | null
}

interface SelfDevRunState {
    runId?: unknown
    kind?: unknown
    createdAt?: unknown
    repoDir?: unknown
    baseRef?: unknown
    port?: unknown
    task?: unknown
    owner?: SelfDevOwner
    preview?: {
        status?: unknown
        pid?: unknown
        stoppedAt?: unknown
        healthPath?: unknown
    }
    recovery?: {
        lastAttemptAt?: unknown
        recoveredAt?: unknown
        lastError?: unknown
    }
    [key: string]: unknown
}

export interface RecoverableSelfDevRun {
    runId: string
    statePath: string
    repoDir: string
    createdAt: number
    healthPath: string
    task: string
    owner: SelfDevOwner
}

interface DiscoveryOptions {
    roots?: string[]
    now?: number
    isPreviewAlive?: (state: SelfDevRunState) => boolean
}

const globalForRecovery = globalThis as unknown as {
    __orchestratorSelfDevRecoveryTimer?: ReturnType<typeof setTimeout>
    __orchestratorSelfDevRecoveryRunning?: boolean
}

/** Arm a one-shot boot recovery. A short delay lets the loopback chat route
 * become available before a recovered run wakes its original conversation. */
export function startSelfDevRecovery(): void {
    if (globalForRecovery.__orchestratorSelfDevRecoveryTimer) return
    const timer = setTimeout(() => {
        globalForRecovery.__orchestratorSelfDevRecoveryTimer = undefined
        if (!canRunBackgroundLoop()) return
        void recoverInterruptedSelfDevRun().catch(error => {
            console.error('[self-dev] interrupted-run recovery failed', error)
        })
    }, RECOVERY_BOOT_DELAY_MS)
    timer.unref?.()
    globalForRecovery.__orchestratorSelfDevRecoveryTimer = timer
}

/** Recover at most the newest interrupted run. Starting every abandoned
 * preview after a reboot would create a resource spike and revive stale work. */
export async function recoverInterruptedSelfDevRun(): Promise<RecoverableSelfDevRun | null> {
    if (globalForRecovery.__orchestratorSelfDevRecoveryRunning) return null
    globalForRecovery.__orchestratorSelfDevRecoveryRunning = true
    try {
        const candidate = findRecoverableSelfDevRuns()[0]
        if (!candidate) return null

        patchRunState(candidate.statePath, {
            lastAttemptAt: new Date().toISOString(),
            lastError: null,
        })
        try {
            await execFileAsync(process.execPath, [
                path.join(process.cwd(), 'scripts', 'self-dev-run.mjs'),
                'restart',
                '--state', candidate.statePath,
                '--health-path', candidate.healthPath,
                '--json',
            ], {
                cwd: process.cwd(),
                timeout: RECOVERY_TIMEOUT_MS,
                maxBuffer: 2 * 1024 * 1024,
            })
            patchRunState(candidate.statePath, {
                recoveredAt: new Date().toISOString(),
                lastError: null,
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            patchRunState(candidate.statePath, { lastError: message })
            await notifyRecovery(candidate, false, message)
            return candidate
        }

        await notifyRecovery(candidate, true)
        return candidate
    } finally {
        globalForRecovery.__orchestratorSelfDevRecoveryRunning = false
    }
}

/** Pure discovery boundary used by the boot recovery and smoke test. */
export function findRecoverableSelfDevRuns(options: DiscoveryOptions = {}): RecoverableSelfDevRun[] {
    const now = options.now ?? Date.now()
    const roots = dedupePaths(options.roots ?? projectRunRoots())
    const isPreviewAlive = options.isPreviewAlive ?? recordedPreviewIsAlive
    const candidates: RecoverableSelfDevRun[] = []

    for (const root of roots) {
        if (!fs.existsSync(root)) continue
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(root, { withFileTypes: true })
        } catch {
            continue
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue
            const statePath = path.join(root, entry.name, 'run-state.json')
            const state = readState(statePath)
            if (!state || state.kind !== 'self' || typeof state.runId !== 'string') continue
            if (typeof state.repoDir !== 'string' || !path.isAbsolute(state.repoDir) || !fs.existsSync(state.repoDir)) continue

            const createdAt = typeof state.createdAt === 'string' ? Date.parse(state.createdAt) : Number.NaN
            const fallbackCreatedAt = safeMtime(statePath)
            const timestamp = Number.isFinite(createdAt) ? createdAt : fallbackCreatedAt
            if (!timestamp || now - timestamp > RECENT_RUN_MS || timestamp > now + 60_000) continue

            const preview = state.preview
            if (!preview || !['running', 'starting'].includes(String(preview.status))) continue
            if (typeof preview.stoppedAt === 'string' && preview.stoppedAt.trim()) continue
            if (isPreviewAlive(state)) continue

            const lastAttempt = typeof state.recovery?.lastAttemptAt === 'string'
                ? Date.parse(state.recovery.lastAttemptAt)
                : Number.NaN
            if (Number.isFinite(lastAttempt) && now - lastAttempt < RECOVERY_COOLDOWN_MS) continue
            if (!repoHasUnfinishedWork(state.repoDir, typeof state.baseRef === 'string' ? state.baseRef : null)) continue

            candidates.push({
                runId: state.runId,
                statePath,
                repoDir: state.repoDir,
                createdAt: timestamp,
                healthPath: typeof preview.healthPath === 'string' && preview.healthPath.startsWith('/')
                    ? preview.healthPath
                    : '/',
                task: typeof state.task === 'string' ? state.task : 'Orchestrator self-development run',
                owner: state.owner && typeof state.owner === 'object' ? state.owner : {},
            })
        }
    }
    return candidates.sort((a, b) => b.createdAt - a.createdAt)
}

function projectRunRoots(): string[] {
    const sourceDir = process.env.ORCHESTRATOR_SELF_DEV_SOURCE_DIR
        || process.env.ORCHESTRATOR_SOURCE_DIR
        || '/orchestrator-source'
    return [
        process.env.ORCHESTRATOR_PROJECT_RUNS_DIR || '',
        path.join(process.cwd(), '.orchestrator', 'project-runs'),
        path.join(sourceDir, '.orchestrator', 'project-runs'),
    ].filter(Boolean)
}

function recordedPreviewIsAlive(state: SelfDevRunState): boolean {
    const pid = state.preview?.pid
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false
    try {
        process.kill(Number(pid), 0)
    } catch {
        return false
    }

    // On Linux, reject a recycled PID that clearly is not this run's Next
    // preview. Elsewhere process existence is the best portable signal.
    const cmdlinePath = `/proc/${pid}/cmdline`
    if (!fs.existsSync(cmdlinePath)) return true
    try {
        const command = fs.readFileSync(cmdlinePath, 'utf8').replace(/\0/g, ' ')
        const port = Number.isSafeInteger(state.port) ? String(state.port) : ''
        return /(?:^|\/)next(?:\s|$)/.test(command) && (!port || command.includes(port))
    } catch {
        return true
    }
}

function repoHasUnfinishedWork(repoDir: string, baseRef: string | null): boolean {
    try {
        const dirty = execFileSync('git', ['status', '--porcelain'], {
            cwd: repoDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        if (dirty) return true
        if (!baseRef) return false
        const ahead = execFileSync('git', ['rev-list', '--count', `${baseRef}..HEAD`], {
            cwd: repoDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        return Number.parseInt(ahead, 10) > 0
    } catch {
        return false
    }
}

async function notifyRecovery(candidate: RecoverableSelfDevRun, recovered: boolean, error?: string): Promise<void> {
    const owner = await resolveOwner(candidate)
    const summary = recovered
        ? `The host restarted while self-development run ${candidate.runId} was active. Its existing worktree was preserved and the managed preview has been restarted. Resume from ${candidate.statePath}; inspect the current diff and continue the same verification/approval gate. Do not create a replacement worktree and do not push, release, deploy, or clean up without the original user authorization.`
        : `Self-development run ${candidate.runId} survived the host restart, but its managed preview could not be restarted: ${error || 'unknown error'}. The worktree remains preserved at ${candidate.repoDir}. Inspect it and continue the original gate without creating a replacement or discarding changes.`

    if (owner?.conversationId) {
        const { runConversationWakeTurn } = await import('@/lib/chat-wake')
        const result = await runConversationWakeTurn({
            profileId: owner.profileId,
            conversationId: owner.conversationId,
            message: {
                id: `selfdev-recovery-${candidate.runId}-${Date.now()}`,
                content: `[System recovery notice]\n${summary}`,
            },
        })
        if (result.ok) return
        console.warn(`[self-dev] could not wake owner conversation ${owner.conversationId}: ${result.error}`)
    }

    await createRecoveryInbox(owner?.profileId, candidate, recovered, summary)
}

async function resolveOwner(candidate: RecoverableSelfDevRun): Promise<{ profileId: string; conversationId?: string } | null> {
    if (candidate.owner.profileId && candidate.owner.conversationId) {
        return { profileId: candidate.owner.profileId, conversationId: candidate.owner.conversationId }
    }
    try {
        const [{ listProfiles }, { runWithProfileContext }, { queryLogs }] = await Promise.all([
            import('@/lib/profiles/store'),
            import('@/lib/profiles/context'),
            import('@/lib/observability/store'),
        ])
        for (const profile of listProfiles()) {
            const match = runWithProfileContext(
                { profileId: profile.id, role: profile.role },
                () => queryLogs({ q: candidate.runId, range: '30d', limit: 20 }).rows
                    .find(row => row.depth === 0 && Boolean(row.conversationId)),
            )
            if (match) return { profileId: profile.id, conversationId: match.conversationId }
        }
    } catch (error) {
        console.warn('[self-dev] could not infer recovery owner from request logs', error)
    }
    return candidate.owner.profileId ? { profileId: candidate.owner.profileId } : null
}

async function createRecoveryInbox(
    requestedProfileId: string | undefined,
    candidate: RecoverableSelfDevRun,
    recovered: boolean,
    summary: string,
): Promise<void> {
    const [{ ADMIN_PROFILE_ID }, { getProfile }, { runWithProfileContext }, { createInboxConversation }, { sendInboxPushNotification }] = await Promise.all([
        import('@/lib/profiles/constants'),
        import('@/lib/profiles/store'),
        import('@/lib/profiles/context'),
        import('@/lib/scheduling/store'),
        import('@/lib/push-notifications'),
    ])
    const profileId = requestedProfileId && getProfile(requestedProfileId) ? requestedProfileId : ADMIN_PROFILE_ID
    const title = recovered ? 'Self-development run recovered' : 'Self-development run needs attention'
    const body = `${summary}\n\nTask: ${candidate.task}`
    const conversationId = runWithProfileContext({ profileId }, () => createInboxConversation({
        taskId: `system:self-dev-recovery:${candidate.runId}`,
        title,
        messages: [{
            id: `selfdev-recovery-inbox-${candidate.runId}-${Date.now()}`,
            role: 'assistant',
            content: body,
            timestamp: Date.now(),
        }],
    }))
    await runWithProfileContext({ profileId }, () => sendInboxPushNotification({
        conversationId,
        title,
        body: recovered ? 'The preview was restarted and the existing worktree was preserved.' : 'The worktree is preserved, but the preview restart failed.',
    })).catch(error => console.warn('[self-dev] recovery push notification failed', error))
}

function patchRunState(statePath: string, recoveryPatch: Record<string, unknown>): void {
    const current = readState(statePath)
    if (!current) return
    const next = {
        ...current,
        recovery: {
            ...(current.recovery && typeof current.recovery === 'object' ? current.recovery : {}),
            ...recoveryPatch,
        },
    }
    const tempPath = `${statePath}.recovery-${process.pid}-${Date.now()}.tmp`
    fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    fs.renameSync(tempPath, statePath)
}

function readState(statePath: string): SelfDevRunState | null {
    try {
        return JSON.parse(fs.readFileSync(statePath, 'utf8')) as SelfDevRunState
    } catch {
        return null
    }
}

function safeMtime(filePath: string): number {
    try {
        return fs.statSync(filePath).mtimeMs
    } catch {
        return 0
    }
}

function dedupePaths(paths: string[]): string[] {
    return [...new Set(paths.filter(Boolean).map(value => path.resolve(value)))]
}
