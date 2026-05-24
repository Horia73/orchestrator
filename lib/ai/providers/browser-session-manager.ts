import { randomUUID } from 'crypto'
import path from 'path'

import type { BrowserEvidenceCapture } from '@/lib/browser-agent-runtime/agent'
import { createBrowserManager, type BrowserDownloadFile, type BrowserManager, type BrowserPageSession } from '@/lib/browser-agent-runtime/browser'
import type { BrowserLiveViewState } from '@/lib/browser-agent-runtime/display'
import type { AgentConfig as BrowserRuntimeConfig } from '@/lib/browser-agent-runtime/config'
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeStatus } from '@/lib/browser-agent-runtime/runtime'
import { DEFAULT_VIEWPORT } from '@/lib/browser-agent-runtime/viewport'
import { WORKSPACE_DIR } from '@/lib/runtime-paths'

const AWAITING_USER_TTL_MS = 30 * 60 * 1000
const COMPLETED_TTL_MS = 5 * 60 * 1000
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
    resumed: boolean
    runtime: AgentRuntime
    release(): void
}

export interface BrowserLiveViewClientState extends BrowserLiveViewState {
    selectedSessionId: string | null
    controlMode: 'agent' | 'user'
    running: boolean
    paused: boolean
    sessions: Array<{
        id: string
        status: ManagedBrowserSessionStatus
        running: boolean
        paused: boolean
        currentUrl: string
    }>
}

export interface AcquireBrowserSessionOptions {
    config: BrowserRuntimeConfig
    prevSession?: { id: string; at: number } | null
    onStatus: (message: string) => void
    onEvidence: (capture: BrowserEvidenceCapture) => void | Promise<void>
}

interface ManagedBrowserSession {
    id: string
    createdAt: number
    lastUsedAt: number
    status: ManagedBrowserSessionStatus
    browserManager: BrowserManager
    pageSession: BrowserPageSession
    runtime: AgentRuntime
    lock: AsyncLock
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

function getEffectiveMaxConcurrent(config: BrowserRuntimeConfig): number {
    if (config.browser.backend === 'official-display' && config.browser.profileMode === 'shared-serial') {
        return 1
    }
    return normalizeMaxConcurrent(config.browser.maxConcurrent)
}

function usesSharedBrowserManager(config: BrowserRuntimeConfig): boolean {
    return config.browser.backend !== 'official-display'
}

function usesOfficialSharedSerialProfile(config: BrowserRuntimeConfig): boolean {
    return config.browser.backend === 'official-display' && config.browser.profileMode === 'shared-serial'
}

function getOfficialDisplayUserDataDir(config: BrowserRuntimeConfig, sessionId: string): string {
    if (config.browser.profileMode === 'shared-serial') {
        return path.resolve(config.browser.baseProfileDir || config.browser.userDataDir)
    }

    return path.join(path.resolve(config.browser.userDataDir), 'sessions', sessionId, 'profile')
}

function getLaunchArgsForBackend(config: BrowserRuntimeConfig): string[] {
    return config.browser.backend === 'official-display' ? [] : config.browser.launchArgs
}

class BrowserSessionManager {
    private browserManager: BrowserManager | null = null
    private sessions = new Map<string, ManagedBrowserSession>()
    private cleanupTimer: NodeJS.Timeout | null = null
    private humanControl = false
    private humanControlSessionId: string | null = null
    private runSlots = new AsyncSemaphore()

    async acquire(options: AcquireBrowserSessionOptions): Promise<BrowserSessionLease> {
        const maxConcurrent = getEffectiveMaxConcurrent(options.config)
        if (this.runSlots.isSaturated(maxConcurrent)) {
            options.onStatus(`⏳ Browser agent queued; ${maxConcurrent} run${maxConcurrent === 1 ? '' : 's'} already active.`)
        }
        const releaseRunSlot = await this.runSlots.acquire(maxConcurrent)

        try {
            if (usesSharedBrowserManager(options.config)) {
                await this.ensureBrowserManager(options.config)
            }
            await this.cleanupExpiredSessions()

            const previous = options.prevSession?.id
                ? this.sessions.get(options.prevSession.id)
                : undefined
            const sharedSerialSession = !previous && usesOfficialSharedSerialProfile(options.config)
                ? this.getReusableOfficialDisplaySession()
                : undefined
            const resumed = Boolean((previous || sharedSerialSession) && !this.isExpired((previous || sharedSerialSession)!))
            const session = resumed
                ? (previous || sharedSerialSession)!
                : await this.createSession(options.config)

            const releaseLock = await session.lock.acquire()
            if (this.humanControl) {
                this.humanControl = false
                this.humanControlSessionId = null
                for (const managedSession of this.sessions.values()) {
                    managedSession.runtime.resumeTask()
                }
            }
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
        } else if (runtimeStatus.lastTerminalAction?.action === 'ask' || usageStatus === 'awaiting_user') {
            status = 'awaiting_user'
        } else if (runtimeStatus.lastTerminalAction?.action === 'stopped' || usageStatus === 'stopped') {
            status = 'stopped'
        } else if (
            runtimeStatus.lastTerminalAction?.action === 'error' ||
            runtimeStatus.lastTerminalAction?.action === 'iteration_limit' ||
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
            await this.browserManager?.close()
            this.browserManager = null
        }
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
        this.humanControl = false
        this.humanControlSessionId = null
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
                status: session.status,
                running,
                paused,
                currentUrl,
            }
        }))

        return {
            ...base,
            selectedSessionId: selectedSession?.id ?? null,
            controlMode: this.humanControl ? 'user' : 'agent',
            running: sessionStates.some(session => session.running),
            paused: sessionStates.some(session => session.paused),
            sessions: sessionStates,
        }
    }

    async setHumanControl(enabled: boolean, sessionId?: string | null): Promise<BrowserLiveViewClientState> {
        this.humanControl = enabled
        this.humanControlSessionId = enabled
            ? this.getHumanInteractionSession(sessionId)?.id ?? null
            : null
        for (const session of this.sessions.values()) {
            if (enabled) {
                session.runtime.pauseTask()
            } else {
                session.runtime.resumeTask()
            }
        }
        return this.getLiveViewState(this.humanControlSessionId ?? sessionId)
    }

    async pasteText(text: string, sessionId?: string | null): Promise<BrowserLiveViewClientState> {
        if (!this.humanControl) {
            throw new Error('Take browser control before sending input.')
        }
        const session = this.getHumanInteractionSession(sessionId ?? this.humanControlSessionId)
        if (!session) {
            throw new Error('No active browser session is available.')
        }
        await session.pageSession.paste(text)
        session.lastUsedAt = Date.now()
        return this.getLiveViewState(session.id)
    }

    async pressKey(key: string, sessionId?: string | null): Promise<BrowserLiveViewClientState> {
        if (!this.humanControl) {
            throw new Error('Take browser control before sending input.')
        }
        const session = this.getHumanInteractionSession(sessionId ?? this.humanControlSessionId)
        if (!session) {
            throw new Error('No active browser session is available.')
        }
        await session.pageSession.pressKey(key)
        session.lastUsedAt = Date.now()
        return this.getLiveViewState(session.id)
    }

    private async ensureBrowserManager(config: BrowserRuntimeConfig): Promise<void> {
        if (!usesSharedBrowserManager(config)) {
            return
        }

        if (this.browserManager) {
            await this.browserManager.launch()
            return
        }

        this.browserManager = await createBrowserManager({
            backend: config.browser.backend,
            userDataDir: config.browser.userDataDir,
            downloadsDir: path.join(WORKSPACE_DIR, 'browser-downloads'),
            profileMode: config.browser.profileMode,
            baseProfileDir: config.browser.baseProfileDir,
            chromeExecutablePath: config.browser.chromeExecutablePath,
            headless: config.browser.headless,
            liveView: config.browser.liveView,
            launchArgs: getLaunchArgsForBackend(config),
            viewport: config.browser.headless ? DEFAULT_VIEWPORT : null,
            onLog: () => {
                // Per-run status is emitted by each runtime session; manager-level
                // launch logs would otherwise leak into unrelated browser tasks.
            },
        })
        await this.browserManager.launch()
    }

    private async createBrowserManagerForSession(
        config: BrowserRuntimeConfig,
        sessionId: string,
        onBrowserLog?: (message: string) => void,
    ): Promise<BrowserManager> {
        if (usesSharedBrowserManager(config)) {
            await this.ensureBrowserManager(config)
            if (!this.browserManager) {
                throw new Error('Browser manager is not initialized')
            }
            return this.browserManager
        }

        const manager = await createBrowserManager({
            backend: config.browser.backend,
            userDataDir: getOfficialDisplayUserDataDir(config, sessionId),
            downloadsDir: path.join(WORKSPACE_DIR, 'browser-downloads', sessionId),
            profileMode: config.browser.profileMode,
            baseProfileDir: config.browser.baseProfileDir,
            chromeExecutablePath: config.browser.chromeExecutablePath,
            headless: false,
            liveView: true,
            launchArgs: getLaunchArgsForBackend(config),
            viewport: DEFAULT_VIEWPORT,
            onLog: onBrowserLog ?? (() => {
                // Per-run status is emitted by each runtime session; manager-level
                // launch logs would otherwise leak into unrelated browser tasks.
            }),
        })
        await manager.launch()
        return manager
    }

    private async createSession(config: BrowserRuntimeConfig): Promise<ManagedBrowserSession> {
        const id = `browser_${randomUUID()}`
        const pendingStatusMessages: string[] = []
        let managedRef: ManagedBrowserSession | null = null
        const browserManager = await this.createBrowserManagerForSession(config, id, (message) => {
            if (managedRef?.currentStatusHandler) {
                managedRef.currentStatusHandler(message)
                return
            }
            if (!managedRef || managedRef.status === 'idle' || managedRef.status === 'running') {
                pendingStatusMessages.push(message)
            }
        })
        const pageSession = await browserManager.createSession({
            id,
            startupUrl: config.browser.startupUrl || undefined,
        })

        const session: Partial<ManagedBrowserSession> = {
            id,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            status: 'idle',
            browserManager,
            pageSession,
            lock: new AsyncLock(),
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
        managedRef = managed
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

    private getReusableOfficialDisplaySession(): ManagedBrowserSession | undefined {
        return [...this.sessions.values()]
            .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
            .find(session => session.pageSession.capabilities.backend === 'official-display' && !this.isExpired(session))
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

const browserSessionManager = new BrowserSessionManager()

const globalForBrowserSessions = globalThis as unknown as {
    __orchestratorBrowserSignalCleanupInstalled?: boolean
    __orchestratorBrowserSignalCleanupInProgress?: boolean
}

if (!globalForBrowserSessions.__orchestratorBrowserSignalCleanupInstalled) {
    globalForBrowserSessions.__orchestratorBrowserSignalCleanupInstalled = true
    const cleanupAndExit = (signal: NodeJS.Signals) => {
        if (globalForBrowserSessions.__orchestratorBrowserSignalCleanupInProgress) return
        globalForBrowserSessions.__orchestratorBrowserSignalCleanupInProgress = true
        const exitCode = signal === 'SIGINT' ? 130 : 143
        const fallback = setTimeout(() => process.exit(exitCode), 3_000)
        fallback.unref?.()
        void browserSessionManager.shutdownAll().finally(() => {
            clearTimeout(fallback)
            process.exit(exitCode)
        })
    }
    process.once('SIGTERM', cleanupAndExit)
    process.once('SIGINT', cleanupAndExit)
}

export function getBrowserSessionManager(): BrowserSessionManager {
    return browserSessionManager
}

export async function shutdownBrowserSessionManager(): Promise<void> {
    await browserSessionManager.shutdownAll()
}
