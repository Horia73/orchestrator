import { randomUUID } from 'crypto'

import type { BrowserEvidenceCapture } from '@/lib/browser-agent-runtime/agent'
import { createBrowserManager, type BrowserManager, type BrowserPageSession } from '@/lib/browser-agent-runtime/browser'
import type { BrowserLiveViewState } from '@/lib/browser-agent-runtime/display'
import type { AgentConfig as BrowserRuntimeConfig } from '@/lib/browser-agent-runtime/config'
import { createAgentRuntime, type AgentRuntime, type AgentRuntimeStatus } from '@/lib/browser-agent-runtime/runtime'
import { DEFAULT_VIEWPORT } from '@/lib/browser-agent-runtime/viewport'

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
    pageSession: BrowserPageSession
    runtime: AgentRuntime
    lock: AsyncLock
    currentStatusHandler: ((message: string) => void) | null
    currentEvidenceHandler: ((capture: BrowserEvidenceCapture) => void | Promise<void>) | null
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

class BrowserSessionManager {
    private browserManager: BrowserManager | null = null
    private sessions = new Map<string, ManagedBrowserSession>()
    private cleanupTimer: NodeJS.Timeout | null = null
    private humanControl = false

    async acquire(options: AcquireBrowserSessionOptions): Promise<BrowserSessionLease> {
        await this.ensureBrowserManager(options.config)
        await this.cleanupExpiredSessions()

        const previous = options.prevSession?.id
            ? this.sessions.get(options.prevSession.id)
            : undefined
        const resumed = Boolean(previous && !this.isExpired(previous))
        const session = resumed
            ? previous!
            : await this.createSession(options.config)

        const releaseLock = await session.lock.acquire()
        if (this.humanControl) {
            this.humanControl = false
            for (const managedSession of this.sessions.values()) {
                managedSession.runtime.resumeTask()
            }
        }
        session.currentStatusHandler = options.onStatus
        session.currentEvidenceHandler = options.onEvidence
        session.status = 'running'
        session.lastUsedAt = Date.now()

        return {
            id: session.id,
            resumed,
            runtime: session.runtime,
            release: () => {
                session.currentStatusHandler = null
                session.currentEvidenceHandler = null
                session.lastUsedAt = Date.now()
                releaseLock()
                this.scheduleCleanup()
            },
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

    async closeSession(sessionId: string): Promise<boolean> {
        const session = this.sessions.get(sessionId)
        if (!session) return false
        await session.runtime.shutdown()
        await this.browserManager?.closeSession(sessionId)
        this.sessions.delete(sessionId)
        if (this.sessions.size === 0) {
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
    }

    async getLiveViewState(): Promise<BrowserLiveViewClientState> {
        const base = this.browserManager?.getLiveViewState() ?? {
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
            controlMode: this.humanControl ? 'user' : 'agent',
            running: sessionStates.some(session => session.running),
            paused: sessionStates.some(session => session.paused),
            sessions: sessionStates,
        }
    }

    async setHumanControl(enabled: boolean): Promise<BrowserLiveViewClientState> {
        this.humanControl = enabled
        for (const session of this.sessions.values()) {
            if (enabled) {
                session.runtime.pauseTask()
            } else {
                session.runtime.resumeTask()
            }
        }
        return this.getLiveViewState()
    }

    async pasteText(text: string): Promise<BrowserLiveViewClientState> {
        if (!this.humanControl) {
            throw new Error('Take browser control before sending input.')
        }
        const session = this.getHumanInteractionSession()
        if (!session) {
            throw new Error('No active browser session is available.')
        }
        await session.pageSession.paste(text)
        session.lastUsedAt = Date.now()
        return this.getLiveViewState()
    }

    async pressKey(key: string): Promise<BrowserLiveViewClientState> {
        if (!this.humanControl) {
            throw new Error('Take browser control before sending input.')
        }
        const session = this.getHumanInteractionSession()
        if (!session) {
            throw new Error('No active browser session is available.')
        }
        await session.pageSession.pressKey(key)
        session.lastUsedAt = Date.now()
        return this.getLiveViewState()
    }

    private async ensureBrowserManager(config: BrowserRuntimeConfig): Promise<void> {
        if (this.browserManager) {
            await this.browserManager.launch()
            return
        }

        this.browserManager = await createBrowserManager({
            userDataDir: config.browser.userDataDir,
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

    private async createSession(config: BrowserRuntimeConfig): Promise<ManagedBrowserSession> {
        if (!this.browserManager) {
            throw new Error('Browser manager is not initialized')
        }

        const id = `browser_${randomUUID()}`
        const pageSession = await this.browserManager.createSession({
            id,
            startupUrl: config.browser.startupUrl || undefined,
        })

        const session: Partial<ManagedBrowserSession> = {
            id,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            status: 'idle',
            pageSession,
            lock: new AsyncLock(),
            currentStatusHandler: null,
            currentEvidenceHandler: null,
        }

        session.runtime = createAgentRuntime(config, (message) => {
            session.currentStatusHandler?.(message)
        }, {
            browserManager: this.browserManager,
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

    private getHumanInteractionSession(): ManagedBrowserSession | null {
        const sessions = [...this.sessions.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        return sessions.find(session => session.status === 'running' || session.status === 'awaiting_user')
            ?? sessions[0]
            ?? null
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
