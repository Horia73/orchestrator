import fs from 'fs'
import path from 'path'
import { execFileSync, spawn } from 'child_process'
import { randomUUID } from 'crypto'

import { listActiveChatStreams } from '@/lib/chat-streams'
import { getEnvValue } from '@/lib/config'
import { shutdownBrowserSessionManager } from '@/lib/ai/providers/browser-session-manager'

type UpdatePhase = 'idle' | 'queued' | 'updating' | 'restarting' | 'completed' | 'failed'

export interface ActiveRunInfo {
    conversationId: string
    messageId: string
    startedAt: number
}

export interface CurrentInstallInfo {
    version: string
    commit: string | null
    branch: string | null
    dirty: boolean
}

export interface LatestReleaseInfo {
    version: string
    tag: string
    name: string
    htmlUrl: string
    publishedAt: string | null
    body: string | null
    fallback?: boolean
}

export interface UpdateJob {
    id: string
    phase: UpdatePhase
    targetVersion: string
    targetTag: string
    queuedAt: number
    updatedAt: number
    startedAt?: number
    completedAt?: number
    failedAt?: number
    idleSince?: number
    activeRunCount?: number
    waitReason?: string
    error?: string
    logPath?: string
}

export interface UpdateStatus {
    current: CurrentInstallInfo
    latest: LatestReleaseInfo | null
    updateAvailable: boolean
    latestCheckedAt: number | null
    latestError: string | null
    activeRuns: ActiveRunInfo[]
    job: UpdateJob | null
    config: {
        repo: string
        idleGraceMs: number
        serviceManager: string | null
        managedInstall: boolean
        dockerHostUpdater: boolean
    }
}

export interface HostUpdateResult {
    jobId: string
    phase: 'failed' | 'restarting' | 'completed'
    error?: string
    waitReason?: string
}

interface MemoryState {
    latest: LatestReleaseInfo | null
    latestCheckedAt: number | null
    latestError: string | null
    job: UpdateJob | null
    timer: NodeJS.Timeout | null
}

const PROJECT_DIR = process.cwd()
const UPDATE_DIR = path.join(PROJECT_DIR, '.orchestrator')
const UPDATE_STATE_PATH = path.join(UPDATE_DIR, 'update-state.json')
const UPDATE_RUNNER_PATH = path.join(PROJECT_DIR, 'scripts', 'update-runner.mjs')
const REPO_OWNER = process.env.ORCHESTRATOR_UPDATE_REPO_OWNER || 'Horia73'
const REPO_NAME = process.env.ORCHESTRATOR_UPDATE_REPO_NAME || 'orchestrator'
const REPO = `${REPO_OWNER}/${REPO_NAME}`
const LATEST_CACHE_MS = 5 * 60 * 1000
const MAINTENANCE_STALE_MS = 60 * 60 * 1000
const IDLE_GRACE_MS = Number.parseInt(process.env.ORCHESTRATOR_UPDATE_IDLE_GRACE_MS || '10000', 10)

const globalForUpdates = globalThis as unknown as {
    __orchestratorUpdateState?: MemoryState
}

const memory: MemoryState = globalForUpdates.__orchestratorUpdateState ?? {
    latest: null,
    latestCheckedAt: null,
    latestError: null,
    job: null,
    timer: null,
}

if (!globalForUpdates.__orchestratorUpdateState) {
    globalForUpdates.__orchestratorUpdateState = memory
}

function ensureUpdateDir() {
    if (!fs.existsSync(UPDATE_DIR)) fs.mkdirSync(UPDATE_DIR, { recursive: true })
}

function readPackageVersion(): string {
    try {
        const raw = fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf-8')
        const parsed = JSON.parse(raw) as { version?: unknown }
        return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
    } catch {
        return '0.0.0'
    }
}

function git(args: string[]): string | null {
    try {
        return execFileSync('git', args, {
            cwd: PROJECT_DIR,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null
    } catch {
        return null
    }
}

function getCurrentInstall(): CurrentInstallInfo {
    const dirty = Boolean(git(['status', '--porcelain']))
    return {
        version: readPackageVersion(),
        commit: git(['rev-parse', '--short', 'HEAD']),
        branch: git(['branch', '--show-current']),
        dirty,
    }
}

function normalizeVersion(value: string | null | undefined): string | null {
    if (!value) return null
    const match = value.trim().match(/^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/)
    return match?.[1] ?? null
}

function compareVersions(a: string, b: string): number {
    const cleanA = normalizeVersion(a) ?? a
    const cleanB = normalizeVersion(b) ?? b
    const [mainA] = cleanA.split(/[-+]/)
    const [mainB] = cleanB.split(/[-+]/)
    const partsA = mainA.split('.').map(part => Number.parseInt(part, 10) || 0)
    const partsB = mainB.split('.').map(part => Number.parseInt(part, 10) || 0)
    for (let i = 0; i < 3; i += 1) {
        const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0)
        if (diff !== 0) return diff
    }
    return 0
}

function readPersistedJob(): UpdateJob | null {
    try {
        const raw = fs.readFileSync(UPDATE_STATE_PATH, 'utf-8')
        const parsed = JSON.parse(raw) as UpdateJob
        if (!parsed || typeof parsed.id !== 'string' || typeof parsed.phase !== 'string') return null
        return parsed
    } catch {
        return null
    }
}

function writePersistedJob(job: UpdateJob) {
    ensureUpdateDir()
    fs.writeFileSync(UPDATE_STATE_PATH, JSON.stringify(job, null, 2), 'utf-8')
}

function setJob(job: UpdateJob | null) {
    memory.job = job
    if (job) writePersistedJob(job)
}

function patchJob(patch: Partial<UpdateJob>) {
    if (!memory.job) return null
    const next = { ...memory.job, ...patch, updatedAt: Date.now() }
    setJob(next)
    return next
}

function reconcilePersistedJob(current: CurrentInstallInfo): UpdateJob | null {
    const persisted = readPersistedJob()
    if (persisted && (!memory.job || persisted.updatedAt > memory.job.updatedAt)) {
        memory.job = persisted
    }

    const job = memory.job ?? persisted
    if (!job) return null

    if (
        (job.phase === 'updating' || job.phase === 'restarting') &&
        normalizeVersion(job.targetVersion) &&
        compareVersions(current.version, job.targetVersion) >= 0
    ) {
        const completed: UpdateJob = {
            ...job,
            phase: 'completed',
            completedAt: Date.now(),
            updatedAt: Date.now(),
            waitReason: 'Update installed and service restarted.',
        }
        setJob(completed)
        return completed
    }

    return job
}

async function fetchLatestRelease(force = false): Promise<LatestReleaseInfo | null> {
    const now = Date.now()
    if (!force && memory.latestCheckedAt && now - memory.latestCheckedAt < LATEST_CACHE_MS) {
        return memory.latest
    }

    memory.latestCheckedAt = now
    let githubError: string | null = null

    try {
        const token =
            getEnvValue('ORCHESTRATOR_UPDATE_GITHUB_TOKEN') ||
            getEnvValue('GITHUB_TOKEN') ||
            getEnvValue('GH_TOKEN')
        const headers: Record<string, string> = {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'orchestrator-updater',
        }
        if (token) headers.Authorization = `Bearer ${token}`

        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
            cache: 'no-store',
            headers,
        })

        if (res.status === 404) {
            memory.latest = null
            memory.latestError = 'No GitHub Releases found.'
            return null
        }

        if (!res.ok) throw new Error(`GitHub returned ${res.status}`)

        const json = await res.json() as {
            tag_name?: unknown
            name?: unknown
            html_url?: unknown
            published_at?: unknown
            body?: unknown
        }

        const tag = typeof json.tag_name === 'string' ? json.tag_name : ''
        const version = normalizeVersion(tag) ?? normalizeVersion(typeof json.name === 'string' ? json.name : '') ?? tag
        if (!version || !tag) throw new Error('Latest release is missing a semver tag.')

        memory.latest = {
            version,
            tag,
            name: typeof json.name === 'string' && json.name ? json.name : tag,
            htmlUrl: typeof json.html_url === 'string' ? json.html_url : `https://github.com/${REPO}/releases/tag/${tag}`,
            publishedAt: typeof json.published_at === 'string' ? json.published_at : null,
            body: typeof json.body === 'string' ? json.body : null,
        }
        memory.latestError = null
        return memory.latest
    } catch (err) {
        githubError = err instanceof Error ? err.message : 'Failed to check GitHub Releases.'
    }

    const tagFallback = latestReleaseFromGitTags(githubError)
    if (tagFallback) {
        memory.latest = tagFallback
        memory.latestError = githubError
            ? `${githubError}; detected latest public tag with git fallback. Release notes may be unavailable until GitHub API access recovers.`
            : null
        return memory.latest
    }

    try {
        const packageFallback = await latestReleaseFromRawPackage(githubError)
        if (packageFallback) {
            memory.latest = packageFallback
            memory.latestError = githubError
                ? `${githubError}; detected latest version from raw package metadata. Release notes may be unavailable until GitHub API access recovers.`
                : null
            return memory.latest
        }
    } catch {
        // Preserve the GitHub error below; raw package lookup is only a last-resort fallback.
    }

    memory.latestError = githubError || 'Failed to check GitHub Releases.'
    return memory.latest
}

function latestReleaseFromGitTags(githubError: string | null): LatestReleaseInfo | null {
    try {
        const output = execFileSync('git', [
            'ls-remote',
            '--tags',
            '--refs',
            `https://github.com/${REPO}.git`,
            'v*',
        ], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 10_000,
        })
        const candidates = output
            .split('\n')
            .map(line => line.match(/refs\/tags\/(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/)?.[1] ?? null)
            .filter((tag): tag is string => Boolean(tag && normalizeVersion(tag)))
            .sort((a, b) => compareVersions(b, a))

        const tag = candidates[0]
        const version = normalizeVersion(tag)
        if (!tag || !version) return null

        return {
            version,
            tag,
            name: tag,
            htmlUrl: `https://github.com/${REPO}/releases/tag/${tag}`,
            publishedAt: null,
            body: [
                githubError
                    ? `GitHub release metadata lookup failed: ${githubError}`
                    : 'GitHub release metadata lookup is unavailable.',
                '',
                `Detected latest public tag \`${tag}\` from git refs. Open the release page for full notes if this fallback is active.`,
            ].join('\n'),
        }
    } catch {
        return null
    }
}

async function latestReleaseFromRawPackage(githubError: string | null): Promise<LatestReleaseInfo | null> {
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/master/package.json`, {
        cache: 'no-store',
        headers: { 'User-Agent': 'orchestrator-updater' },
    })
    if (!res.ok) return null

    const json = await res.json() as { version?: unknown }
    const version = normalizeVersion(typeof json.version === 'string' ? json.version : null)
    if (!version) return null
    const tag = `v${version}`
    return {
        version,
        tag,
        name: tag,
        htmlUrl: `https://github.com/${REPO}/releases/tag/${tag}`,
        publishedAt: null,
        body: [
            githubError
                ? `GitHub release metadata lookup failed: ${githubError}`
                : 'GitHub release metadata lookup is unavailable.',
            '',
            `Detected latest version \`${tag}\` from raw package metadata. Open the release page for full notes if this fallback is active.`,
        ].join('\n'),
    }
}

function installedReleaseFallback(current: CurrentInstallInfo): LatestReleaseInfo | null {
    const version = normalizeVersion(current.version)
    if (!version) return null
    return {
        version,
        tag: `v${version}`,
        name: `v${version} (installed)`,
        htmlUrl: `https://github.com/${REPO}/releases/tag/v${version}`,
        publishedAt: null,
        body: [
            memory.latestError
                ? `GitHub release lookup failed: ${memory.latestError}`
                : 'GitHub release lookup is unavailable from this install.',
            'For private repositories, set ORCHESTRATOR_UPDATE_GITHUB_TOKEN in Settings > Files > Env or in the service environment.',
        ].join('\n\n'),
        fallback: true,
    }
}

function serviceManager(): string | null {
    if (process.env.ORCHESTRATOR_SERVICE_MANAGER) return process.env.ORCHESTRATOR_SERVICE_MANAGER
    try {
        if (fs.existsSync('/.dockerenv')) return 'docker'
    } catch {
        // ignore
    }
    return null
}

function dockerHostUpdaterConfig(): { url: string; token: string } | null {
    const url = process.env.ORCHESTRATOR_DOCKER_UPDATE_URL || process.env.ORCHESTRATOR_HOST_UPDATE_URL
    const token = process.env.ORCHESTRATOR_DOCKER_UPDATE_TOKEN || process.env.ORCHESTRATOR_HOST_UPDATE_TOKEN
    if (!url || !token) return null
    return { url, token }
}

function hasDockerHostUpdater(): boolean {
    return Boolean(dockerHostUpdaterConfig())
}

function supportsInAppUpdateRestart(manager: string | null): boolean {
    if (manager === 'systemd' || manager === 'launchd') return true
    if (manager === 'docker') return hasDockerHostUpdater()
    return false
}

function activeJob(job: UpdateJob | null): UpdateJob | null {
    if (!job) return null
    return job.phase === 'queued' || job.phase === 'updating' || job.phase === 'restarting' ? job : null
}

async function startDockerHostUpdateRunner(job: UpdateJob) {
    const config = dockerHostUpdaterConfig()
    if (!config) {
        patchJob({
            phase: 'failed',
            failedAt: Date.now(),
            error: 'Docker host updater is not configured.',
            waitReason: 'Update failed.',
        })
        return
    }

    try {
        const res = await fetch(config.url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jobId: job.id,
                targetTag: job.targetTag,
                targetVersion: job.targetVersion,
            }),
            cache: 'no-store',
        })

        const body = await res.text().catch(() => '')
        if (!res.ok) {
            throw new Error(body || `Docker host updater returned ${res.status}`)
        }

        patchJob({
            phase: 'restarting',
            waitReason: 'Host updater is rebuilding and restarting the Docker stack.',
            activeRunCount: 0,
        })
    } catch (err) {
        patchJob({
            phase: 'failed',
            failedAt: Date.now(),
            error: err instanceof Error ? err.message : 'Docker host updater request failed.',
            waitReason: 'Update failed.',
        })
    }
}

async function startUpdateRunner() {
    const next = patchJob({
        phase: 'updating',
        startedAt: Date.now(),
        waitReason: 'Installing update.',
        activeRunCount: 0,
    })
    if (!next) return

    try {
        patchJob({ waitReason: 'Closing browser agent before update.' })
        await shutdownBrowserSessionManager()
    } catch {
        // Browser cleanup is best-effort; the update runner/restart path also
        // cleans up stale managed-profile processes on next launch.
    }
    patchJob({ waitReason: 'Installing update.' })

    if (serviceManager() === 'docker') {
        void startDockerHostUpdateRunner(next)
        return
    }

    try {
        const child = spawn(process.execPath, [
            UPDATE_RUNNER_PATH,
            '--job-id',
            next.id,
            '--target-tag',
            next.targetTag,
            '--target-version',
            next.targetVersion,
        ], {
            cwd: PROJECT_DIR,
            detached: true,
            stdio: 'ignore',
            env: {
                ...process.env,
                ORCHESTRATOR_UPDATE_REPO: REPO,
            },
        })
        child.unref()
    } catch (err) {
        patchJob({
            phase: 'failed',
            failedAt: Date.now(),
            error: err instanceof Error ? err.message : 'Failed to start update runner.',
            waitReason: 'Update runner failed to start.',
        })
    }
}

function scheduleQueuedJob(jobId: string) {
    if (memory.timer) clearTimeout(memory.timer)

    const tick = () => {
        const job = memory.job
        if (!job || job.id !== jobId || job.phase !== 'queued') return

        const activeRuns = listActiveChatStreams()
        if (activeRuns.length > 0) {
            patchJob({
                idleSince: undefined,
                activeRunCount: activeRuns.length,
                waitReason: `Waiting for ${activeRuns.length} active AI run${activeRuns.length === 1 ? '' : 's'}.`,
            })
            memory.timer = setTimeout(tick, 2000)
            return
        }

        const idleSince = job.idleSince ?? Date.now()
        const idleFor = Date.now() - idleSince
        if (idleFor < IDLE_GRACE_MS) {
            const remainingSeconds = Math.ceil((IDLE_GRACE_MS - idleFor) / 1000)
            patchJob({
                idleSince,
                activeRunCount: 0,
                waitReason: `Waiting ${remainingSeconds}s for a quiet window.`,
            })
            memory.timer = setTimeout(tick, 1000)
            return
        }

        void startUpdateRunner()
    }

    memory.timer = setTimeout(tick, 250)
}

export async function getUpdateStatus(opts?: { refresh?: boolean }): Promise<UpdateStatus> {
    const current = getCurrentInstall()
    const fetchedLatest = await fetchLatestRelease(Boolean(opts?.refresh || !memory.latestCheckedAt))
    const latest = fetchedLatest ?? installedReleaseFallback(current)
    const reconciled = reconcilePersistedJob(current)
    const activeRuns = listActiveChatStreams()
    const manager = serviceManager()
    const dockerHostUpdater = manager === 'docker' && hasDockerHostUpdater()

    return {
        current,
        latest,
        updateAvailable: Boolean(fetchedLatest && compareVersions(fetchedLatest.version, current.version) > 0),
        latestCheckedAt: memory.latestCheckedAt,
        latestError: memory.latestError,
        activeRuns,
        job: reconciled,
        config: {
            repo: REPO,
            idleGraceMs: IDLE_GRACE_MS,
            serviceManager: manager,
            managedInstall: supportsInAppUpdateRestart(manager),
            dockerHostUpdater,
        },
    }
}

export async function queueUpdate(): Promise<UpdateStatus> {
    const status = await getUpdateStatus({ refresh: true })
    const currentActive = activeJob(status.job)
    if (currentActive) {
        if (currentActive.phase === 'queued') scheduleQueuedJob(currentActive.id)
        return status
    }

    if (!status.latest) throw new Error(status.latestError || 'No release is available.')
    if (!status.updateAvailable) throw new Error('The installed version is already up to date.')
    if (!status.config.managedInstall) {
        if (status.config.serviceManager === 'docker') {
            throw new Error('Docker one-click updates need the installer host update bridge. Re-run the installer on the server or run `orchestrator update` there.')
        }
        throw new Error('Managed updates require the app to run under the installer service.')
    }
    if (status.current.dirty) {
        throw new Error('The app has local file changes. Commit/stash them or use a managed install before updating.')
    }
    if (!fs.existsSync(UPDATE_RUNNER_PATH)) {
        throw new Error('Update runner is missing from scripts/update-runner.mjs.')
    }

    const now = Date.now()
    const job: UpdateJob = {
        id: randomUUID(),
        phase: 'queued',
        targetVersion: status.latest.version,
        targetTag: status.latest.tag,
        queuedAt: now,
        updatedAt: now,
        activeRunCount: status.activeRuns.length,
        waitReason: status.activeRuns.length > 0
            ? `Waiting for ${status.activeRuns.length} active AI run${status.activeRuns.length === 1 ? '' : 's'}.`
            : 'Waiting for a quiet window.',
    }

    setJob(job)
    scheduleQueuedJob(job.id)
    return getUpdateStatus()
}

export function verifyDockerHostUpdaterToken(token: string | null | undefined): boolean {
    const config = dockerHostUpdaterConfig()
    return Boolean(config && token && token === config.token)
}

export function recordHostUpdateResult(result: HostUpdateResult): UpdateJob {
    const current = memory.job ?? readPersistedJob()
    if (!current || current.id !== result.jobId) {
        throw new Error('Update job is not active.')
    }

    if (result.phase === 'failed') {
        const failed: UpdateJob = {
            ...current,
            phase: 'failed',
            failedAt: Date.now(),
            updatedAt: Date.now(),
            error: result.error || 'Docker host update failed.',
            waitReason: result.waitReason || 'Update failed.',
        }
        setJob(failed)
        return failed
    }

    if (result.phase === 'completed') {
        const completed: UpdateJob = {
            ...current,
            phase: 'completed',
            completedAt: Date.now(),
            updatedAt: Date.now(),
            waitReason: result.waitReason || 'Update installed and Docker restart requested.',
        }
        setJob(completed)
        return completed
    }

    const restarting: UpdateJob = {
        ...current,
        phase: 'restarting',
        updatedAt: Date.now(),
        waitReason: result.waitReason || 'Host updater is rebuilding and restarting the Docker stack.',
    }
    setJob(restarting)
    return restarting
}

export function isUpdateMaintenanceActive(): boolean {
    const job = memory.job ?? readPersistedJob()
    if (!job) return false
    if (job.phase !== 'updating' && job.phase !== 'restarting') return false
    return Date.now() - job.updatedAt < MAINTENANCE_STALE_MS
}
