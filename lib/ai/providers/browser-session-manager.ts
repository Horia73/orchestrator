import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

import type { BrowserEvidenceCapture } from '@/lib/browser-agent-runtime/agent'
import { createBrowserManager, type BrowserDiagnosticsSnapshot, type BrowserDownloadFile, type BrowserManager, type BrowserPageSession, type BrowserPointerState } from '@/lib/browser-agent-runtime/browser'
import type { BrowserLiveViewState } from '@/lib/browser-agent-runtime/display'
import type { AgentConfig as BrowserRuntimeConfig } from '@/lib/browser-agent-runtime/config'
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeStatus } from '@/lib/browser-agent-runtime/runtime'
import {
    BROWSER_INCOGNITO_SESSION_PREFIX,
    BROWSER_SESSION_PREFIX,
    DEFAULT_BROWSER_SESSION_MODE,
    browserSessionModeLabel,
    inferBrowserSessionModeFromSessionId,
    type BrowserSessionMode,
} from '@/lib/browser-agent-runtime/session-mode'
import { DEFAULT_VIEWPORT } from '@/lib/browser-agent-runtime/viewport'
import { getActiveProfileId } from '@/lib/profiles/context'
import { runtimePathsForProfile, type RuntimePathSet } from '@/lib/runtime-paths'
import { durableAiFleetHasOverlap } from '@/lib/ai/worker-generations'

const AWAITING_USER_TTL_MS = 60 * 60 * 1000
const COMPLETED_TTL_MS = 60 * 60 * 1000
const ERROR_TTL_MS = 2 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 1000

export type ManagedBrowserSessionStatus =
    | 'idle'
    | 'running'
    | 'awaiting_user'
    | 'completed'
    | 'error'
    | 'stopped'

export interface BrowserSessionLease {
    id: string
    mode: BrowserSessionMode
    resumed: boolean
    runtime: AgentRuntime
    release(): void
}

export interface BrowserLiveViewClientState extends BrowserLiveViewState {
    selectedSessionId: string | null
    cursor: BrowserPointerState | null
    running: boolean
    paused: boolean
    sessions: Array<{
        id: string
        mode: BrowserSessionMode
        status: ManagedBrowserSessionStatus
        running: boolean
        paused: boolean
        currentUrl: string
    }>
}

export interface BrowserLiveClipboardResult {
    text: string | null
    state: BrowserLiveViewClientState
}

export interface BrowserSessionDiagnosticsResult {
    sessionId: string | null
    status: ManagedBrowserSessionStatus | null
    running: boolean
    diagnostics: BrowserDiagnosticsSnapshot | null
}

export interface AcquireBrowserSessionOptions {
    config: BrowserRuntimeConfig
    prevSession?: { id: string; at: number } | null
    sessionMode?: BrowserSessionMode
    onStatus: (message: string) => void
    onEvidence: (capture: BrowserEvidenceCapture) => void | Promise<void>
}

interface ManagedBrowserSession {
    id: string
    mode: BrowserSessionMode
    createdAt: number
    lastUsedAt: number
    status: ManagedBrowserSessionStatus
    browserManager: BrowserManager
    pageSession: BrowserPageSession
    runtime: AgentRuntime
    lock: AsyncLock
    temporaryProfileDir: string | null
    currentStatusHandler: ((message: string) => void) | null
    currentEvidenceHandler: ((capture: BrowserEvidenceCapture) => void | Promise<void>) | null
    pendingStatusMessages: string[]
}

class AsyncLock {
    private tail: Promise<void> = Promise.resolve()

    async acquire(): Promise<() => void> {
        let releaseNext!: () => void
        const next = new Promise<void>((resolve) => {
            releaseNext = resolve
        })
        const previous = this.tail
        this.tail = previous.then(() => next)
        await previous

        let released = false
        return () => {
            if (released) return
            released = true
            releaseNext()
        }
    }
}

class AsyncSemaphore {
    private active = 0
    private waiters: Array<() => void> = []
    private max = 3

    isSaturated(maxConcurrent: number): boolean {
        const max = normalizeMaxConcurrent(maxConcurrent)
        return this.active >= max
    }

    async acquire(maxConcurrent: number): Promise<() => void> {
        this.max = normalizeMaxConcurrent(maxConcurrent)
        if (this.active < this.max) {
            this.active++
            return this.releaseOnce()
        }

        await new Promise<void>((resolve) => {
            this.waiters.push(resolve)
        })
        return this.releaseOnce()
    }

    private releaseOnce(): () => void {
        let released = false
        return () => {
            if (released) return
            released = true
            this.active = Math.max(0, this.active - 1)
            this.drain()
        }
    }

    private drain(): void {
        while (this.active < this.max && this.waiters.length > 0) {
            const next = this.waiters.shift()
            if (!next) return
            this.active++
            next()
        }
    }
}

function normalizeMaxConcurrent(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 3
}

function getEffectiveMaxConcurrent(): number {
    // One browser agent at a time per profile. Each profile has its own manager,
    // persistent Patchright profile, live-control channel, and virtual display,
    // so different profiles can run concurrently without sharing browser state.
    // Additional runs for the same profile queue and start automatically.
    return 1
}

class BrowserSessionManager {
    readonly profileId: string
    private readonly runtimePaths: RuntimePathSet
    private browserManager: BrowserManager | null = null
    private sessions = new Map<string, ManagedBrowserSession>()
    private cleanupTimer: NodeJS.Timeout | null = null
    private runSlots = new AsyncSemaphore()

    constructor(profileId: string) {
        this.runtimePaths = runtimePathsForProfile(profileId)
        this.profileId = this.runtimePaths.profileId
    }

    async acquire(options: AcquireBrowserSessionOptions): Promise<BrowserSessionLease> {
        if (durableAiFleetHasOverlap()) {
            options.onStatus('⏳ A previous app generation is still finishing browser work. This browser task will start automatically after the safe handoff completes.')
            while (durableAiFleetHasOverlap()) {
                await new Promise(resolve => setTimeout(resolve, 500))
            }
        }
        const maxConcurrent = getEffectiveMaxConcurrent()
        if (this.runSlots.isSaturated(maxConcurrent)) {
            options.onStatus('⏳ The browser is busy with another conversation. Your task is queued and will start automatically as soon as it is free.')
        }
        const releaseRunSlot = await this.runSlots.acquire(maxConcurrent)

        try {
            const sessionMode = this.resolveSessionMode(options)
            await this.cleanupExpiredSessions()

            const previous = options.prevSession?.id
                ? this.sessions.get(options.prevSession.id)
                : undefined
            if (previous && previous.mode !== sessionMode) {
                throw new Error(`Cannot continue browser session ${previous.id} as ${browserSessionModeLabel(sessionMode)}; it was started as ${browserSessionModeLabel(previous.mode)}. Start a fresh browser_agent thread for a different browser session mode.`)
            }
            const resumed = Boolean(previous && !this.isExpired(previous))
            const session = resumed
                ? previous!
                : await this.createSession(options.config, sessionMode)

            const releaseLock = await session.lock.acquire()
            session.currentStatusHandler = options.onStatus
            session.currentEvidenceHandler = options.onEvidence
            session.status = 'running'
            session.lastUsedAt = Date.now()
            const pendingStatusMessages = session.pendingStatusMessages.splice(0)
            for (const message of pendingStatusMessages) {
                session.currentStatusHandler?.(message)
            }

            return {
                id: session.id,
                mode: session.mode,
                resumed,
                runtime: session.runtime,
                release: () => {
                    session.currentStatusHandler = null
                    session.currentEvidenceHandler = null
                    session.lastUsedAt = Date.now()
                    releaseLock()
                    releaseRunSlot()
                    this.scheduleCleanup()
                },
            }
        } catch (error) {
            releaseRunSlot()
            throw error
        }
    }

    markFromRuntimeStatus(sessionId: string, runtimeStatus: AgentRuntimeStatus): ManagedBrowserSessionStatus {
        const session = this.sessions.get(sessionId)
        if (!session) return 'stopped'

        const usageStatus = runtimeStatus.usage.lastTask?.status ?? runtimeStatus.usage.currentTask?.status
        let status: ManagedBrowserSessionStatus = 'completed'
        if (runtimeStatus.running) {
            status = 'running'
        } else if (
            runtimeStatus.lastTerminalAction?.action === 'ask' ||
            runtimeStatus.lastTerminalAction?.action === 'checkpoint' ||
            usageStatus === 'awaiting_user'
        ) {
            // 'checkpoint' = action budget reached; keep the session alive (awaiting TTL)
            // so the orchestrator can continue it on the same thread.
            status = 'awaiting_user'
        } else if (runtimeStatus.lastTerminalAction?.action === 'stopped' || usageStatus === 'stopped') {
            status = 'stopped'
        } else if (
            runtimeStatus.lastTerminalAction?.action === 'error' ||
            usageStatus === 'error'
        ) {
            status = 'error'
        }

        session.status = status
        session.lastUsedAt = Date.now()
        this.scheduleCleanup()
        return status
    }

    markSessionStatus(sessionId: string, status: ManagedBrowserSessionStatus): void {
        const session = this.sessions.get(sessionId)
        if (!session) return
        session.status = status
        session.lastUsedAt = Date.now()
        this.scheduleCleanup()
    }

    async captureSessionScreenshot(sessionId: string, filenameBase = 'browser-final-screen'): Promise<BrowserEvidenceCapture | null> {
        const session = this.sessions.get(sessionId)
        if (!session) return null

        const frame = await session.pageSession.captureAgentFrame()
        session.lastUsedAt = Date.now()
        return {
            kind: 'screenshot',
            mimeType: 'image/jpeg',
            data: Buffer.from(frame.imageBase64, 'base64'),
            filenameBase,
            timestamp: frame.timestamp,
            url: frame.url,
            captureMode: frame.captureMode,
            viewport: frame.viewport,
            page: frame.page,
        }
    }

    async collectSessionDownloads(sessionId: string, timeoutMs = 5000): Promise<BrowserDownloadFile[]> {
        const session = this.sessions.get(sessionId)
        if (!session) return []

        session.lastUsedAt = Date.now()
        return session.pageSession.waitForDownloads(timeoutMs)
    }

    async closeSession(sessionId: string): Promise<boolean> {
        const session = this.sessions.get(sessionId)
        if (!session) return false
        await session.runtime.shutdown()
        await session.browserManager.closeSession(sessionId).catch(() => {
            // Browser process may already be gone; still tear down the manager.
        })
        this.sessions.delete(sessionId)
        if (session.browserManager !== this.browserManager) {
            await session.browserManager.close().catch(() => {
                // Best-effort cleanup for per-session display capsules.
            })
        } else if (this.sessions.size === 0) {
            const sharedManager = this.browserManager
            this.browserManager = null
            if (sharedManager) {
                await sharedManager.close().catch(() => {
                    // Best-effort cleanup; the singleton reference is already cleared
                    // above so a partial close (e.g., chromium already exited) cannot
                    // leak a stale manager into the next acquire call.
                })
            }
        }
        this.removeTemporaryProfile(session.temporaryProfileDir)
        return true
    }

    async shutdownAll(): Promise<void> {
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer)
            this.cleanupTimer = null
        }

        const sessionIds = [...this.sessions.keys()]
        for (const sessionId of sessionIds) {
            await this.closeSession(sessionId).catch(() => {
                // Best-effort cleanup; callers should not fail deploy/restart
                // just because a browser process already exited.
            })
        }

        if (this.browserManager) {
            await this.browserManager.close().catch(() => {
                // Best-effort cleanup.
            })
            this.browserManager = null
        }
        this.sessions.clear()
    }

    async getLiveViewState(sessionId?: string | null): Promise<BrowserLiveViewClientState> {
        const selectedSession = this.getHumanInteractionSession(sessionId)
        const liveViewManager = selectedSession?.browserManager ?? this.browserManager
        const base = liveViewManager?.getLiveViewState() ?? {
            enabled: process.platform === 'linux' || process.platform === 'darwin',
            available: false,
            ready: false,
            mode: process.platform === 'darwin' ? ('mac-headful' as const) : ('disabled' as const),
            platform: process.platform,
            reason: 'Browser has not been started yet.',
        }

        const sessionStates = await Promise.all([...this.sessions.values()].map(async session => {
            let running = false
            let paused = false
            let currentUrl = ''
            try {
                const status = await session.runtime.getStatus()
                running = status.running
                paused = status.paused
                currentUrl = status.currentUrl
            } catch {
                currentUrl = ''
            }
            return {
                id: session.id,
                mode: session.mode,
                status: session.status,
                running,
                paused,
                currentUrl,
            }
        }))

        let cursor: BrowserPointerState | null = null
        try {
            cursor = selectedSession?.pageSession.getPointerState() ?? null
        } catch {
            cursor = null
        }

        return {
            ...base,
            selectedSessionId: selectedSession?.id ?? null,
            cursor,
            running: sessionStates.some(session => session.running),
            paused: sessionStates.some(session => session.paused),
            sessions: sessionStates,
        }
    }

    async getSessionDiagnostics(sessionId?: string | null): Promise<BrowserSessionDiagnosticsResult> {
        const session = this.getHumanInteractionSession(sessionId)
        if (!session) {
            return { sessionId: null, status: null, running: false, diagnostics: null }
        }
        let running = false
        try {
            const status = await session.runtime.getStatus()
            running = status.running
        } catch {
            running = false
        }
        return {
            sessionId: session.id,
            status: session.status,
            running,
            diagnostics: session.pageSession.getDiagnostics(),
        }
    }

    async pasteText(text: string, sessionId?: string | null): Promise<BrowserLiveViewClientState> {
        const session = this.getHumanInteractionSession(sessionId)
        if (!session) {
            throw new Error('No active browser session is available.')
        }
        await session.pageSession.paste(text)
        session.lastUsedAt = Date.now()
        return this.getLiveViewState(session.id)
    }

    async pressKey(key: string, sessionId?: string | null): Promise<BrowserLiveViewClientState> {
        const session = this.getHumanInteractionSession(sessionId)
        if (!session) {
            throw new Error('No active browser session is available.')
        }
        await session.pageSession.pressKey(key)
        session.lastUsedAt = Date.now()
        return this.getLiveViewState(session.id)
    }

    async copyFromBrowser(key?: string, sessionId?: string | null): Promise<BrowserLiveClipboardResult> {
        const session = this.getHumanInteractionSession(sessionId)
        if (!session) {
            throw new Error('No active browser session is available.')
        }
        if (key) {
            await session.pageSession.pressKey(key)
            await new Promise(resolve => setTimeout(resolve, 150))
        }
        const text = await session.pageSession.readClipboard()
        session.lastUsedAt = Date.now()
        return {
            text,
            state: await this.getLiveViewState(session.id),
        }
    }

    private async ensureBrowserManager(config: BrowserRuntimeConfig): Promise<void> {
        if (this.browserManager) {
            await this.browserManager.launch()
            return
        }

        this.browserManager = await createBrowserManager({
            backend: config.browser.backend,
            userDataDir: config.browser.userDataDir,
            downloadsDir: path.join(this.runtimePaths.workspaceDir, 'browser-downloads'),
            workspaceDir: this.runtimePaths.workspaceDir,
            headless: config.browser.headless,
            liveView: config.browser.liveView,
            launchArgs: config.browser.launchArgs,
            viewport: config.browser.headless ? DEFAULT_VIEWPORT : null,
            onLog: () => {
                // Per-run status is emitted by each runtime session; manager-level
                // launch logs would otherwise leak into unrelated browser tasks.
            },
        })
        await this.browserManager.launch()
    }

    private async createIsolatedBrowserManager(
        config: BrowserRuntimeConfig,
        userDataDir: string,
    ): Promise<BrowserManager> {
        const manager = await createBrowserManager({
            backend: config.browser.backend,
            userDataDir,
            downloadsDir: path.join(this.runtimePaths.workspaceDir, 'browser-downloads'),
            workspaceDir: this.runtimePaths.workspaceDir,
            headless: config.browser.headless,
            liveView: config.browser.liveView,
            launchArgs: config.browser.launchArgs,
            viewport: config.browser.headless ? DEFAULT_VIEWPORT : null,
            onLog: () => {
                // Per-run status is emitted by each runtime session; manager-level
                // launch logs would otherwise leak into unrelated browser tasks.
            },
        })
        await manager.launch()
        return manager
    }

    private async createSession(
        config: BrowserRuntimeConfig,
        mode: BrowserSessionMode,
    ): Promise<ManagedBrowserSession> {
        const id = this.createSessionId(mode)
        const pendingStatusMessages: string[] = []
        const temporaryProfileDir = mode === 'incognito'
            ? fs.mkdtempSync(path.join(os.tmpdir(), `orchestrator-browser-${this.profileId}-incognito-`))
            : null
        let browserManager: BrowserManager | null = null
        let pageSession: BrowserPageSession
        try {
            if (mode === 'incognito') {
                browserManager = await this.createIsolatedBrowserManager(config, temporaryProfileDir!)
            } else {
                await this.ensureBrowserManager(config)
                if (!this.browserManager) {
                    throw new Error('Browser manager is not initialized')
                }
                browserManager = this.browserManager
            }
            pageSession = await browserManager.createSession({
                id,
                startupUrl: config.browser.startupUrl || undefined,
                workspaceDir: this.runtimePaths.workspaceDir,
            })
        } catch (error) {
            if (mode === 'incognito') {
                await browserManager?.close().catch(() => {})
                this.removeTemporaryProfile(temporaryProfileDir)
            }
            throw error
        }
        if (!browserManager) {
            throw new Error('Browser manager is not initialized')
        }

        const session: Partial<ManagedBrowserSession> = {
            id,
            mode,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            status: 'idle',
            browserManager,
            pageSession,
            lock: new AsyncLock(),
            temporaryProfileDir,
            currentStatusHandler: null,
            currentEvidenceHandler: null,
            pendingStatusMessages,
        }

        session.runtime = createAgentRuntime(config, (message) => {
            session.currentStatusHandler?.(message)
        }, {
            browserManager,
            browserSession: pageSession,
            closeBrowserOnShutdown: false,
            onEvidence: (capture) => session.currentEvidenceHandler?.(capture),
        })

        const managed = session as ManagedBrowserSession
        this.sessions.set(id, managed)
        this.scheduleCleanup()
        return managed
    }

    private scheduleCleanup(): void {
        if (this.cleanupTimer) return
        this.cleanupTimer = setTimeout(() => {
            this.cleanupTimer = null
            void this.cleanupExpiredSessions()
        }, CLEANUP_INTERVAL_MS)
        this.cleanupTimer.unref?.()
    }

    private async cleanupExpiredSessions(): Promise<void> {
        const expired = [...this.sessions.values()].filter(session => this.isExpired(session))
        await Promise.allSettled(expired.map(session => this.closeSession(session.id)))
    }

    private getHumanInteractionSession(sessionId?: string | null): ManagedBrowserSession | null {
        if (sessionId) {
            return this.sessions.get(sessionId) ?? null
        }
        const sessions = [...this.sessions.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        return sessions.find(session => session.status === 'running' || session.status === 'awaiting_user')
            ?? sessions[0]
            ?? null
    }

    private resolveSessionMode(options: AcquireBrowserSessionOptions): BrowserSessionMode {
        const inferred = inferBrowserSessionModeFromSessionId(options.prevSession?.id)
        if (options.sessionMode && inferred && options.sessionMode !== inferred) {
            throw new Error(`Cannot continue browser session ${options.prevSession?.id} as ${browserSessionModeLabel(options.sessionMode)}; it was started as ${browserSessionModeLabel(inferred)}. Start a fresh browser_agent thread for a different browser session mode.`)
        }
        return options.sessionMode
            ?? inferred
            ?? DEFAULT_BROWSER_SESSION_MODE
    }

    private createSessionId(mode: BrowserSessionMode): string {
        const prefix = mode === 'incognito'
            ? BROWSER_INCOGNITO_SESSION_PREFIX
            : BROWSER_SESSION_PREFIX
        return `${prefix}${randomUUID()}`
    }

    private removeTemporaryProfile(profileDir: string | null | undefined): void {
        if (!profileDir) return
        fs.rm(profileDir, { recursive: true, force: true }, () => {})
    }

    private isExpired(session: ManagedBrowserSession): boolean {
        if (session.status === 'running') return false

        const ttl = session.status === 'awaiting_user'
            ? AWAITING_USER_TTL_MS
            : session.status === 'completed'
                ? COMPLETED_TTL_MS
                : ERROR_TTL_MS

        return Date.now() - session.lastUsedAt > ttl
    }
}

const globalForBrowserSessions = globalThis as unknown as {
    __orchestratorBrowserSessionManagers?: Map<string, BrowserSessionManager>
    __orchestratorBrowserSignalCleanupInstalled?: boolean
    __orchestratorBrowserSignalCleanupInProgress?: boolean
}

const browserSessionManagers = globalForBrowserSessions.__orchestratorBrowserSessionManagers
    ?? new Map<string, BrowserSessionManager>()
globalForBrowserSessions.__orchestratorBrowserSessionManagers = browserSessionManagers

if (!globalForBrowserSessions.__orchestratorBrowserSignalCleanupInstalled) {
    globalForBrowserSessions.__orchestratorBrowserSignalCleanupInstalled = true
    const cleanupAndExit = (signal: NodeJS.Signals) => {
        if (globalForBrowserSessions.__orchestratorBrowserSignalCleanupInProgress) return
        globalForBrowserSessions.__orchestratorBrowserSignalCleanupInProgress = true
        const exitCode = signal === 'SIGINT' ? 130 : 143
        const fallback = setTimeout(() => process.exit(exitCode), 3_000)
        fallback.unref?.()
        void shutdownBrowserSessionManager().finally(() => {
            clearTimeout(fallback)
            process.exit(exitCode)
        })
    }
    process.once('SIGTERM', cleanupAndExit)
    process.once('SIGINT', cleanupAndExit)
}

export function getBrowserSessionManager(): BrowserSessionManager {
    const profileId = getActiveProfileId()
    let manager = browserSessionManagers.get(profileId)
    if (!manager) {
        manager = new BrowserSessionManager(profileId)
        browserSessionManagers.set(manager.profileId, manager)
    }
    return manager
}

export async function shutdownActiveBrowserSessionManager(): Promise<void> {
    const profileId = getActiveProfileId()
    const manager = browserSessionManagers.get(profileId)
    if (!manager) return
    browserSessionManagers.delete(profileId)
    await manager.shutdownAll()
}

export async function shutdownBrowserSessionManager(): Promise<void> {
    const managers = [...browserSessionManagers.values()]
    browserSessionManagers.clear()
    await Promise.allSettled(managers.map(manager => manager.shutdownAll()))
}
