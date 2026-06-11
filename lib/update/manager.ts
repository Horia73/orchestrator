import fs from 'fs'
import path from 'path'
import { execFileSync, spawn } from 'child_process'
import { randomUUID } from 'crypto'

import { listActiveChatStreams } from '@/lib/chat-streams'
import { listAgentRuns, type ActiveAgentRun } from '@/lib/agent-runs'
import { getEnvValue } from '@/lib/config'
import { shutdownBrowserSessionManager } from '@/lib/ai/providers/browser-session-manager'
import { createInboxConversation } from '@/lib/scheduling/store'
import { sendInboxPushNotification } from '@/lib/push-notifications'
import { addMessage, getConversation } from '@/lib/db'
import type { Message } from '@/lib/types'

type UpdatePhase = 'idle' | 'queued' | 'updating' | 'restarting' | 'completed' | 'failed'
type UpdateTargetKind = 'release' | 'branch'

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
    targetKind?: UpdateTargetKind
    targetVersion: string
    targetTag: string
    targetBranch?: string | null
    targetCommit?: string | null
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
    postRestartCheckedAt?: number
    postRestartConfirmedAt?: number
    postRestartCurrentCommit?: string | null
    postRestartConfirmationError?: string
    postRestartConfirmationConversationId?: string
    /** Chat conversation that initiated this update (so the boot hook can post a follow-up there). */
    initiatedFromConversationId?: string
    /** Whether the boot hook already posted a follow-up to the originating chat conversation. */
    postRestartChatNotifiedAt?: number
}

export interface UpdateStatus {
    current: CurrentInstallInfo
    latest: LatestReleaseInfo | null
    updateAvailable: boolean
    latestCheckedAt: number | null
    latestError: string | null
    activeRuns: ActiveRunInfo[]
    job: UpdateJob | null
    rollback: RollbackInfo | null
    config: {
        repo: string
        idleGraceMs: number
        serviceManager: string | null
        managedInstall: boolean
        dockerHostUpdater: boolean
    }
}

export interface RollbackInfo {
    available: boolean
    image: string
    imageId: string | null
    version: string | null
    commit: string | null
    ref: string | null
    savedAt: number | null
    savedBeforeTarget: string | null
    unavailableReason?: string
}

export interface HostUpdateResult {
    jobId: string
    phase: 'failed' | 'restarting' | 'completed'
    targetCommit?: string
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
const REPO_OWNER = getEnvValue('ORCHESTRATOR_UPDATE_REPO_OWNER') || 'Horia73'
const REPO_NAME = getEnvValue('ORCHESTRATOR_UPDATE_REPO_NAME') || 'orchestrator'
const REPO = `${REPO_OWNER}/${REPO_NAME}`
const LATEST_CACHE_MS = 5 * 60 * 1000
const MAINTENANCE_STALE_MS = 60 * 60 * 1000
const IDLE_GRACE_MS = Number.parseInt(getEnvValue('ORCHESTRATOR_UPDATE_IDLE_GRACE_MS') || '10000', 10)
const UPDATE_CONFIRMATION_TASK_ID = 'system:update'

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

function envBuildValue(name: string): string | null {
    const value = getEnvValue(name)?.trim()
    if (!value || value === 'unknown') return null
    return value
}

interface BakedBuildInfo {
    commit: string | null
    ref: string | null
    builtAt: string | null
}

let cachedBuildInfo: BakedBuildInfo | null | undefined

function readBakedBuildInfo(): BakedBuildInfo | null {
    if (cachedBuildInfo !== undefined) return cachedBuildInfo
    // Written by the Dockerfile from build args. Truthy when running inside a
    // managed Docker image, missing when running from a local source checkout.
    // Authoritative over `git` (`.git` is `.dockerignore`-d) and over the env
    // var (which `env_file` in docker-compose can silently override with stale
    // values from `.env`).
    const candidatePath = path.join(PROJECT_DIR, '.build-info.json')
    try {
        if (!fs.existsSync(candidatePath)) {
            cachedBuildInfo = null
            return null
        }
        const raw = fs.readFileSync(candidatePath, 'utf-8')
        const parsed = JSON.parse(raw) as { commit?: unknown; ref?: unknown; builtAt?: unknown }
        const commit = typeof parsed.commit === 'string' && parsed.commit.trim() && parsed.commit.trim() !== 'unknown'
            ? parsed.commit.trim()
            : null
        const ref = typeof parsed.ref === 'string' && parsed.ref.trim() && parsed.ref.trim() !== 'unknown'
            ? parsed.ref.trim()
            : null
        const builtAt = typeof parsed.builtAt === 'string' && parsed.builtAt.trim()
            ? parsed.builtAt.trim()
            : null
        cachedBuildInfo = { commit, ref, builtAt }
        return cachedBuildInfo
    } catch {
        cachedBuildInfo = null
        return null
    }
}

function normalizeCommit(value: string | null | undefined): string | null {
    const clean = value?.trim()
    if (!clean || clean === 'unknown') return null
    return /^[0-9a-f]{7,40}$/i.test(clean) ? clean : null
}

function commitsMatch(current: string | null | undefined, target: string | null | undefined): boolean {
    const currentCommit = normalizeCommit(current)
    const targetCommit = normalizeCommit(target)
    if (!currentCommit || !targetCommit) return false
    return currentCommit === targetCommit
        || currentCommit.startsWith(targetCommit)
        || targetCommit.startsWith(currentCommit)
}

function getCurrentInstall(): CurrentInstallInfo {
    const dirty = Boolean(git(['status', '--porcelain']))
    const baked = readBakedBuildInfo()
    // Precedence: baked image metadata (Docker prod) → live git (source
    // checkouts) → env var (legacy fallback). Reading `baked` first means
    // post-restart confirmation no longer reports a stale commit when
    // `.env` happens to carry an old `ORCHESTRATOR_BUILD_COMMIT` line.
    const commit = baked?.commit
        ?? git(['rev-parse', '--short=12', 'HEAD'])
        ?? envBuildValue('ORCHESTRATOR_BUILD_COMMIT')
    const branch = baked?.ref
        ?? git(['branch', '--show-current'])
        ?? envBuildValue('ORCHESTRATOR_BUILD_REF')
    return {
        version: readPackageVersion(),
        commit,
        branch,
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

    const restartResult = reconcileRestartingJobWithCurrentInstall(job, current)
    if (restartResult) return restartResult

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

function reconcileRestartingJobWithCurrentInstall(
    job: UpdateJob,
    current: CurrentInstallInfo,
): UpdateJob | null {
    if (job.phase !== 'restarting') return null
    if (!job.targetCommit || !commitsMatch(current.commit, job.targetCommit)) return null

    const now = Date.now()
    const targetVersion = normalizeVersion(job.targetVersion)
    const currentVersion = normalizeVersion(current.version)

    if (targetVersion && currentVersion && compareVersions(currentVersion, targetVersion) < 0) {
        const failed: UpdateJob = {
            ...job,
            phase: 'failed',
            failedAt: now,
            updatedAt: now,
            waitReason: 'Host updater finished, but the requested release is not running.',
            error: `Running version v${current.version} is still below target v${job.targetVersion}. Check that the release tag points at the code the updater installed.`,
            postRestartCheckedAt: now,
            postRestartCurrentCommit: normalizeCommit(current.commit),
            postRestartConfirmationError: `Running version v${current.version} is still below target v${job.targetVersion}.`,
        }
        setJob(failed)
        return failed
    }

    const completed: UpdateJob = {
        ...job,
        phase: 'completed',
        completedAt: job.completedAt ?? now,
        updatedAt: now,
        waitReason: 'Update installed, service restarted, and running commit confirmed.',
        postRestartCheckedAt: now,
        postRestartConfirmedAt: job.postRestartConfirmedAt ?? now,
        postRestartCurrentCommit: normalizeCommit(current.commit),
    }
    setJob(completed)
    return completed
}

async function postUpdateConfirmationInbox(args: {
    ok: boolean
    targetCommit: string
    currentCommit: string | null
    currentVersion: string
    error?: string
}): Promise<string> {
    const title = args.ok
        ? 'Orchestrator update confirmed'
        : 'Orchestrator update needs attention'
    const body = args.ok
        ? [
            'Orchestrator restarted and confirmed the running build.',
            '',
            `Target commit: \`${args.targetCommit}\``,
            `Running commit: \`${args.currentCommit ?? 'unknown'}\``,
            `Version: \`${args.currentVersion}\``,
        ].join('\n')
        : [
            'Orchestrator restarted, but the running build could not be confirmed.',
            '',
            `Target commit: \`${args.targetCommit}\``,
            `Running commit: \`${args.currentCommit ?? 'unknown'}\``,
            `Version: \`${args.currentVersion}\``,
            '',
            args.error ?? 'Post-restart confirmation failed.',
        ].join('\n')

    const message: Message = {
        id: `msg_${randomUUID()}`,
        role: 'assistant',
        content: body,
        status: args.ok ? 'ok' : 'error',
        timestamp: Date.now(),
    }
    const conversationId = createInboxConversation({
        taskId: UPDATE_CONFIRMATION_TASK_ID,
        title,
        messages: [message],
    })
    await sendInboxPushNotification({ conversationId, title, body }).catch((err) => {
        console.warn('[update] failed to send post-restart push notification', err)
    })
    return conversationId
}

export async function confirmPendingUpdateAfterRestart(): Promise<UpdateJob | null> {
    if (process.env.ORCHESTRATOR_BUILD === '1' || process.env.NEXT_PHASE === 'phase-production-build') {
        return null
    }

    const persisted = readPersistedJob()
    if (persisted && (!memory.job || persisted.updatedAt > memory.job.updatedAt)) {
        memory.job = persisted
    }

    const job = memory.job ?? persisted
    const targetCommit = normalizeCommit(job?.targetCommit)
    if (!job || !targetCommit || job.postRestartConfirmedAt) return job ?? null
    if (job.phase !== 'restarting' && job.phase !== 'completed') return job

    const current = getCurrentInstall()
    const currentCommit = normalizeCommit(current.commit)
    const ok = commitsMatch(currentCommit, targetCommit)
    const now = Date.now()
    const error = ok
        ? undefined
        : currentCommit
            ? `Running commit ${currentCommit} does not match target ${targetCommit}.`
            : 'Running commit is unavailable. Docker builds must pass ORCHESTRATOR_BUILD_COMMIT to confirm self-updates.'

    let conversationId = job.postRestartConfirmationConversationId
    if (!conversationId) {
        try {
            conversationId = await postUpdateConfirmationInbox({
                ok,
                targetCommit,
                currentCommit,
                currentVersion: current.version,
                error,
            })
        } catch (err) {
            console.warn('[update] failed to post restart confirmation inbox item', err)
        }
    }

    // If the update was initiated from an orchestrator chat, drop a follow-up
    // assistant message into that conversation so the user sees the result
    // inline next time they open it. Best-effort: a failure here must not
    // block the inbox confirmation or job state transition.
    let chatNotifiedAt = job.postRestartChatNotifiedAt
    if (
        !chatNotifiedAt &&
        job.initiatedFromConversationId &&
        getConversation(job.initiatedFromConversationId)
    ) {
        try {
            postUpdateConfirmationChat({
                conversationId: job.initiatedFromConversationId,
                ok,
                targetCommit,
                currentCommit,
                currentVersion: current.version,
                targetVersion: job.targetVersion,
                error,
            })
            chatNotifiedAt = now
        } catch (err) {
            console.warn('[update] failed to post restart follow-up into chat', err)
        }
    }

    const next: UpdateJob = {
        ...job,
        phase: ok ? 'completed' : job.phase,
        completedAt: ok ? (job.completedAt ?? now) : job.completedAt,
        updatedAt: now,
        waitReason: ok
            ? 'Update installed, service restarted, and running commit confirmed.'
            : 'Post-restart confirmation failed.',
        postRestartCheckedAt: now,
        postRestartConfirmedAt: ok ? now : job.postRestartConfirmedAt,
        postRestartCurrentCommit: currentCommit,
        postRestartConfirmationError: error,
        postRestartConfirmationConversationId: conversationId,
        postRestartChatNotifiedAt: chatNotifiedAt,
    }
    setJob(next)
    return next
}

function postUpdateConfirmationChat(args: {
    conversationId: string
    ok: boolean
    targetCommit: string
    currentCommit: string | null
    currentVersion: string
    targetVersion: string
    error?: string
}) {
    const body = args.ok
        ? [
            `Updateul s-a aplicat cu succes. Rulez acum versiunea \`${args.currentVersion}\` (commit \`${args.currentCommit ?? 'unknown'}\`).`,
            '',
            'Spune-mi dacă vrei să continuăm de unde am rămas.',
        ].join('\n')
        : [
            `Updateul a fost lansat dar nu am putut confirma versiunea după restart.`,
            '',
            `Target commit: \`${args.targetCommit}\``,
            `Running commit: \`${args.currentCommit ?? 'unknown'}\``,
            `Version: \`${args.currentVersion}\``,
            '',
            args.error ?? 'Post-restart confirmation failed.',
        ].join('\n')

    addMessage(args.conversationId, {
        id: `msg_${randomUUID()}`,
        role: 'assistant',
        content: body,
        contentSegments: [{ phase: 0, content: body }],
        status: args.ok ? 'ok' : 'error',
        timestamp: Date.now(),
    })
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
    const configured = getEnvValue('ORCHESTRATOR_SERVICE_MANAGER')
    if (configured) return configured
    try {
        if (fs.existsSync('/.dockerenv')) return 'docker'
    } catch {
        // ignore
    }
    return null
}

function dockerHostUpdaterConfig(): { url: string; token: string } | null {
    const url = getEnvValue('ORCHESTRATOR_DOCKER_UPDATE_URL') || getEnvValue('ORCHESTRATOR_HOST_UPDATE_URL')
    const token = getEnvValue('ORCHESTRATOR_DOCKER_UPDATE_TOKEN') || getEnvValue('ORCHESTRATOR_HOST_UPDATE_TOKEN')
    if (!url || !token) return null
    return { url, token }
}

/**
 * Returns the upstream URL + bearer token for streaming the host updater's
 * log (SSE endpoint on the docker-update-bridge). Resolves the log path from
 * the configured `/update` URL: replaces the final segment with `/update-log`,
 * appends it if no path is present. Returns null when the host updater is not
 * configured (non-Docker installs).
 */
export function getDockerHostUpdaterLogConfig(): { url: string; token: string } | null {
    const base = dockerHostUpdaterConfig()
    if (!base) return null
    let logUrl: string
    try {
        const parsed = new URL(base.url)
        const segments = parsed.pathname.split('/').filter(Boolean)
        if (segments.length > 0 && segments[segments.length - 1] === 'update') {
            segments[segments.length - 1] = 'update-log'
        } else {
            segments.push('update-log')
        }
        parsed.pathname = '/' + segments.join('/')
        // Preserve any query string the user may have appended.
        logUrl = parsed.toString()
    } catch {
        return null
    }
    return { url: logUrl, token: base.token }
}

/**
 * Derive a sibling endpoint on the docker-update-bridge from the configured
 * `/update` URL (e.g. `/update-clis`, `/restart`), reusing its bearer token.
 */
function dockerBridgeEndpoint(segment: string): { url: string; token: string } | null {
    const base = dockerHostUpdaterConfig()
    if (!base) return null
    try {
        const parsed = new URL(base.url)
        const segments = parsed.pathname.split('/').filter(Boolean)
        if (segments.length > 0 && segments[segments.length - 1] === 'update') {
            segments[segments.length - 1] = segment
        } else {
            segments.push(segment)
        }
        parsed.pathname = '/' + segments.join('/')
        return { url: parsed.toString(), token: base.token }
    } catch {
        return null
    }
}

function bridgeRollbackFromPayload(payload: unknown): RollbackInfo | null {
    if (!payload || typeof payload !== 'object') return null
    const item = (payload as { rollback?: unknown }).rollback
    if (!item || typeof item !== 'object') return null
    const raw = item as Record<string, unknown>
    const image = typeof raw.image === 'string' && raw.image ? raw.image : 'orchestrator:rollback'
    return {
        available: raw.available === true,
        image,
        imageId: typeof raw.imageId === 'string' && raw.imageId ? raw.imageId : null,
        version: typeof raw.version === 'string' && raw.version ? raw.version : null,
        commit: typeof raw.commit === 'string' && raw.commit ? raw.commit : null,
        ref: typeof raw.ref === 'string' && raw.ref ? raw.ref : null,
        savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : null,
        savedBeforeTarget: typeof raw.savedBeforeTarget === 'string' && raw.savedBeforeTarget ? raw.savedBeforeTarget : null,
        unavailableReason: typeof raw.unavailableReason === 'string' ? raw.unavailableReason : undefined,
    }
}

async function getDockerRollbackStatus(): Promise<RollbackInfo | null> {
    const cfg = dockerBridgeEndpoint('status')
    if (!cfg) return null
    try {
        const res = await fetch(cfg.url, {
            headers: { Authorization: `Bearer ${cfg.token}` },
            cache: 'no-store',
        })
        if (!res.ok) return null
        const json = await res.json().catch(() => null)
        return bridgeRollbackFromPayload(json)
    } catch {
        return null
    }
}

/**
 * Ask the host bridge to update the Codex CLI inside the
 * container's bind-mounted npm-global volume, then restart the container.
 * Docker installs only — the CLIs live outside the image, so neither a rebuild
 * nor their headless runs ever refresh them.
 */
export async function triggerCliUpdate(): Promise<{ ok: boolean; versions?: string; error?: string }> {
    const cfg = dockerBridgeEndpoint('update-clis')
    if (!cfg) {
        return { ok: false, error: 'CLI update needs a Docker install with the host bridge configured.' }
    }
    try {
        const res = await fetch(cfg.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
            body: '{}',
            cache: 'no-store',
        })
        const json = (await res.json().catch(() => null)) as { ok?: boolean; versions?: string; error?: string } | null
        if (!res.ok || !json?.ok) {
            return { ok: false, error: json?.error || `Host bridge returned ${res.status}.` }
        }
        return { ok: true, versions: json.versions }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'CLI update request failed.' }
    }
}

/** Ask the host bridge to restart the orchestrator container. Docker only. */
export async function triggerContainerRestart(): Promise<{ ok: boolean; error?: string }> {
    const cfg = dockerBridgeEndpoint('restart')
    if (!cfg) {
        return { ok: false, error: 'Restart needs a Docker install with the host bridge configured.' }
    }
    try {
        const res = await fetch(cfg.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
            body: '{}',
            cache: 'no-store',
        })
        if (!res.ok) {
            const txt = await res.text().catch(() => '')
            return { ok: false, error: txt || `Host bridge returned ${res.status}.` }
        }
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Restart request failed.' }
    }
}

/** Ask the host bridge to switch back to the cached previous Docker image. */
export async function triggerRollback(): Promise<{ ok: boolean; rollback?: RollbackInfo | null; error?: string }> {
    const cfg = dockerBridgeEndpoint('rollback')
    if (!cfg) {
        return { ok: false, error: 'Rollback needs a Docker install with the host bridge configured.' }
    }
    try {
        const res = await fetch(cfg.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
            body: '{}',
            cache: 'no-store',
        })
        const json = await res.json().catch(() => null) as { ok?: boolean; error?: string; rollback?: unknown } | null
        if (!res.ok || !json?.ok) {
            return { ok: false, error: json?.error || `Host bridge returned ${res.status}.` }
        }
        return { ok: true, rollback: bridgeRollbackFromPayload(json) }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Rollback request failed.' }
    }
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

function sanitizeBranchName(value: string): string {
    const branch = value.trim()
    if (
        !branch ||
        branch.startsWith('/') ||
        branch.endsWith('/') ||
        branch.includes('..') ||
        !/^[A-Za-z0-9._/-]+$/.test(branch)
    ) {
        throw new Error(`Invalid update branch: ${value || '(empty)'}`)
    }
    return branch
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
                targetBranch: job.targetBranch,
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
        const runnerArgs = [
            UPDATE_RUNNER_PATH,
            '--job-id',
            next.id,
            '--target-version',
            next.targetVersion,
        ]
        if (next.targetKind === 'branch' && next.targetBranch) {
            runnerArgs.push('--target-branch', next.targetBranch)
        } else {
            runnerArgs.push('--target-tag', next.targetTag)
        }

        const child = spawn(process.execPath, runnerArgs, {
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

function agentRunToActiveRunInfo(run: ActiveAgentRun): ActiveRunInfo {
    return {
        conversationId: run.conversationId,
        messageId: run.id,
        startedAt: run.startedAt,
    }
}

function listAllActiveRuns(): ActiveRunInfo[] {
    // Combine main chat streams with background (inbox-reply, scheduled-task)
    // model wakes. The update manager treats both as "AI is busy" so a managed
    // update won't pre-empt a running scheduled run or inbox-reply continuation.
    return [
        ...listActiveChatStreams(),
        ...listAgentRuns().map(agentRunToActiveRunInfo),
    ]
}

function scheduleQueuedJob(jobId: string) {
    if (memory.timer) clearTimeout(memory.timer)

    const tick = () => {
        const job = memory.job
        if (!job || job.id !== jobId || job.phase !== 'queued') return

        const activeRuns = listAllActiveRuns()
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
    const activeRuns = listAllActiveRuns()
    const manager = serviceManager()
    const dockerHostUpdater = manager === 'docker' && hasDockerHostUpdater()
    const rollback = dockerHostUpdater ? await getDockerRollbackStatus() : null

    return {
        current,
        latest,
        updateAvailable: Boolean(fetchedLatest && compareVersions(fetchedLatest.version, current.version) > 0),
        latestCheckedAt: memory.latestCheckedAt,
        latestError: memory.latestError,
        activeRuns,
        job: reconciled,
        rollback,
        config: {
            repo: REPO,
            idleGraceMs: IDLE_GRACE_MS,
            serviceManager: manager,
            managedInstall: supportsInAppUpdateRestart(manager),
            dockerHostUpdater,
        },
    }
}

export async function queueUpdate(opts?: {
    mode?: UpdateTargetKind
    branch?: string
    initiatedFromConversationId?: string
}): Promise<UpdateStatus> {
    const mode: UpdateTargetKind = opts?.mode === 'branch' ? 'branch' : 'release'
    const status = await getUpdateStatus({ refresh: mode === 'release' })
    const currentActive = activeJob(status.job)
    if (currentActive) {
        if (currentActive.phase === 'queued') scheduleQueuedJob(currentActive.id)
        return status
    }

    if (mode === 'release') {
        if (!status.latest) throw new Error(status.latestError || 'No release is available.')
        if (!status.updateAvailable) throw new Error('The installed version is already up to date.')
    }
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
    const targetBranch = mode === 'branch'
        ? sanitizeBranchName(opts?.branch || status.current.branch || 'master')
        : null
    const job: UpdateJob = {
        id: randomUUID(),
        phase: 'queued',
        targetKind: mode,
        targetVersion: mode === 'release' ? status.latest!.version : status.current.version,
        targetTag: mode === 'release' ? status.latest!.tag : `branch:${targetBranch}`,
        targetBranch,
        queuedAt: now,
        updatedAt: now,
        activeRunCount: status.activeRuns.length,
        waitReason: status.activeRuns.length > 0
            ? `Waiting for ${status.activeRuns.length} active AI run${status.activeRuns.length === 1 ? '' : 's'}.`
            : 'Waiting for a quiet window.',
        initiatedFromConversationId: opts?.initiatedFromConversationId,
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
    const targetCommit = normalizeCommit(result.targetCommit) ?? normalizeCommit(current.targetCommit)

    if (result.phase === 'failed') {
        const failed: UpdateJob = {
            ...current,
            phase: 'failed',
            targetCommit,
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
            targetCommit,
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
        targetCommit,
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
    if (job.phase === 'restarting' && job.targetCommit) {
        const reconciled = reconcileRestartingJobWithCurrentInstall(job, getCurrentInstall())
        if (reconciled && (reconciled.phase === 'completed' || reconciled.phase === 'failed')) {
            return false
        }
    }
    return Date.now() - job.updatedAt < MAINTENANCE_STALE_MS
}

export interface CachedPendingUpdate {
    currentVersion: string
    targetVersion: string
    targetTag: string
    releaseName: string | null
    releaseUrl: string | null
    publishedAt: string | null
    notes: string | null
    fallback: boolean
}

/**
 * Cache-only view of the pending update used by the orchestrator chat prompt.
 *
 * Returns null when no update has been detected yet — never triggers a git
 * shell or HTTP request, so it's safe to call from the chat hot path. The
 * cache is populated by the background poll started in instrumentation.ts
 * (and any in-app refresh via Settings → Updates).
 */
export function getCachedPendingUpdate(): CachedPendingUpdate | null {
    const latest = memory.latest
    if (!latest) return null
    const currentVersion = readPackageVersion()
    if (compareVersions(latest.version, currentVersion) <= 0) return null
    return {
        currentVersion,
        targetVersion: latest.version,
        targetTag: latest.tag,
        releaseName: latest.name && latest.name !== latest.tag ? latest.name : null,
        releaseUrl: latest.htmlUrl,
        publishedAt: latest.publishedAt,
        notes: latest.body,
        fallback: Boolean(latest.fallback),
    }
}

/**
 * Background poll that refreshes the GitHub release cache so the chat prompt
 * can see new versions without doing any work on the hot path. Called once
 * from instrumentation.ts; idempotent.
 */
const PENDING_UPDATE_POLL_MS = 30 * 60 * 1000

export function startPendingUpdatePoll(): void {
    const globalKey = '__orchestratorPendingUpdatePollTimer'
    const g = globalThis as unknown as { [k: string]: NodeJS.Timeout | undefined }
    if (g[globalKey]) return
    const tick = () => {
        fetchLatestRelease(false).catch((err) => {
            console.warn('[update] background latest-release poll failed', err)
        })
    }
    // Warm the cache once shortly after boot so the first chat turn sees it,
    // then keep refreshing on a long interval (30 min). The HTTP call itself
    // is also cached for 5 min inside fetchLatestRelease, so this is cheap.
    setTimeout(tick, 10_000).unref()
    g[globalKey] = setInterval(tick, PENDING_UPDATE_POLL_MS)
    g[globalKey]?.unref?.()
}
