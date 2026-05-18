import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

import { PRIVATE_STATE_DIR, getEnvValue } from '@/lib/config'

import type { Chat, Client, Message } from 'whatsapp-web.js'

const AUTH_BASE_DIR = path.join(PRIVATE_STATE_DIR, 'whatsapp-web')
const AUTH_CLIENT_ID = 'orchestrator'
const QR_TTL_MS = 60_000
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const READY_WAIT_TIMEOUT_MS = 25_000
const READY_HEALTH_TIMEOUT_MS = 5_000

export type WhatsAppPhase =
    | 'idle'
    | 'starting'
    | 'qr'
    | 'authenticated'
    | 'ready'
    | 'disconnected'
    | 'auth_failure'
    | 'error'

export interface WhatsAppIntegrationStatus {
    id: 'whatsapp'
    name: string
    description: string
    configured: boolean
    connected: boolean
    accountName: string | null
    phoneNumber: string | null
    phase: WhatsAppPhase
    sessionStored: boolean
    qrAvailable: boolean
    qrDataUrl: string | null
    qrImageUrl: string | null
    qrUpdatedAt: number | null
    qrExpiresAt: number | null
    lastReadyAt: number | null
    lastSyncAt: number | null
    lastError: string | null
    browserExecutablePath: string | null
    missingConfig: string[]
    needsReconnect: boolean
    capabilities: string[]
}

export interface WhatsAppStartResult {
    status: WhatsAppIntegrationStatus
    qrMarkdown: string | null
}

export interface WhatsAppChatSummary {
    id: string
    name: string
    isGroup: boolean
    isReadOnly: boolean
    unreadCount: number
    timestamp: number | null
    lastMessage: WhatsAppMessageSummary | null
}

export interface WhatsAppUnreadChatSummary {
    id: string
    name: string
    isGroup: boolean
    unreadCount: number
    timestamp: number | null
}

export interface WhatsAppUnreadSummary {
    totalUnread: number
    unreadChatCount: number
    scannedChats: number
    unreadChats: WhatsAppUnreadChatSummary[]
    truncated: boolean
}

export interface WhatsAppMessageSummary {
    id: string
    chatId: string
    chatName?: string
    from: string
    to: string
    author: string | null
    fromMe: boolean
    type: string
    body: string
    timestamp: number | null
    date: string | null
    hasMedia: boolean
}

export interface WhatsAppReadChatResult {
    chat: WhatsAppChatSummary
    messages: WhatsAppMessageSummary[]
    truncated: boolean
}

export interface WhatsAppSearchResult {
    query: string
    scannedChats: number
    scannedMessages: number
    results: WhatsAppMessageSummary[]
    truncated: boolean
}

interface MutableWhatsAppState {
    phase: WhatsAppPhase
    qrText: string | null
    qrDataUrl: string | null
    qrUpdatedAt: number | null
    accountName: string | null
    phoneNumber: string | null
    lastReadyAt: number | null
    lastSyncAt: number | null
    lastError: string | null
    browserExecutablePath: string | null
}

class WhatsAppManager {
    private client: Client | null = null
    private initializePromise: Promise<void> | null = null
    private state: MutableWhatsAppState = {
        phase: 'idle',
        qrText: null,
        qrDataUrl: null,
        qrUpdatedAt: null,
        accountName: null,
        phoneNumber: null,
        lastReadyAt: null,
        lastSyncAt: null,
        lastError: null,
        browserExecutablePath: null,
    }

    async getStatus(origin?: string): Promise<WhatsAppIntegrationStatus> {
        return this.status(origin)
    }

    async start(origin?: string): Promise<WhatsAppStartResult> {
        await this.ensureStarted()
        await this.waitForQrOrReady()
        if (this.state.phase === 'authenticated' || this.state.phase === 'starting') {
            await this.resetBrokenClient(new Error('WhatsApp Web did not become ready after startup.'), 'WhatsApp startup stalled')
            await this.ensureStarted()
            await this.waitForQrOrReady()
        }
        const status = await this.status(origin)
        return {
            status,
            qrMarkdown: status.qrImageUrl
                ? `![WhatsApp QR](${status.qrImageUrl})`
                : status.qrDataUrl ? `![WhatsApp QR](${status.qrDataUrl})` : null,
        }
    }

    async disconnect(): Promise<void> {
        const client = this.client
        this.client = null
        this.initializePromise = null
        this.state.phase = 'disconnected'
        this.clearQr()

        if (client) {
            try {
                await client.logout()
            } catch {
                // A broken/expired browser session may fail to log out remotely.
            }
            try {
                await client.destroy()
            } catch {
                // Best effort: local session cleanup below is the important part.
            }
        }

        fs.rmSync(AUTH_BASE_DIR, { recursive: true, force: true })
        this.state.accountName = null
        this.state.phoneNumber = null
        this.state.lastSyncAt = Date.now()
    }

    async getQrPng(): Promise<Buffer | null> {
        if (!this.state.qrText) return null
        const qrcode = await import('qrcode')
        return qrcode.toBuffer(this.state.qrText, {
            type: 'png',
            width: 360,
            margin: 1,
            errorCorrectionLevel: 'M',
        })
    }

    async listChats(maxResults: number): Promise<{ chats: WhatsAppChatSummary[] }> {
        const limit = clamp(Math.floor(maxResults), 1, 50)
        return this.runReadyOperation('list chats', async client => {
            const chats = await withTimeout(client.getChats(), DEFAULT_OPERATION_TIMEOUT_MS, 'WhatsApp chat list timed out.')
            return {
                chats: chats
                    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                    .slice(0, limit)
                    .map(chatSummary),
            }
        })
    }

    async unreadSummary(maxResults: number): Promise<WhatsAppUnreadSummary> {
        const limit = clamp(Math.floor(maxResults), 1, 50)
        return this.runReadyOperation('summarize unread chats', async client => {
            const chats = await withTimeout(client.getChats(), DEFAULT_OPERATION_TIMEOUT_MS, 'WhatsApp chat list timed out.')
            const unreadChats = chats
                .filter(chat => Number.isFinite(chat.unreadCount) && chat.unreadCount > 0)
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                .map(unreadChatSummary)
            const returnedUnreadChats = unreadChats.slice(0, limit)

            return {
                totalUnread: unreadChats.reduce((sum, chat) => sum + chat.unreadCount, 0),
                unreadChatCount: unreadChats.length,
                scannedChats: chats.length,
                unreadChats: returnedUnreadChats,
                truncated: unreadChats.length > returnedUnreadChats.length,
            }
        })
    }

    async readChat(chatId: string, maxMessages: number, maxChars: number): Promise<WhatsAppReadChatResult> {
        return this.runReadyOperation('read chat', async client => {
            const chat = await this.getChat(client, chatId)
            const messages = await withTimeout(
                chat.fetchMessages({ limit: clamp(Math.floor(maxMessages), 1, 100) }),
                DEFAULT_OPERATION_TIMEOUT_MS,
                'WhatsApp message fetch timed out.'
            )
            const newestFirst = messages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
            const limited = limitMessagesByChars(
                newestFirst.map(message => messageSummary(message, chat)),
                clamp(Math.floor(maxChars), 2_000, 80_000)
            )

            return {
                chat: chatSummary(chat),
                messages: limited.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)),
                truncated: limited.truncated,
            }
        })
    }

    async searchMessages(args: {
        query: string
        chatId?: string
        maxResults: number
        maxChats: number
        perChatLimit: number
    }): Promise<WhatsAppSearchResult> {
        const query = args.query.trim().toLowerCase()
        if (!query) throw new Error('WhatsApp search query is required.')

        return this.runReadyOperation('search messages', async client => {
            const candidateChats = args.chatId
                ? [await this.getChat(client, args.chatId)]
                : (await withTimeout(client.getChats(), DEFAULT_OPERATION_TIMEOUT_MS, 'WhatsApp chat list timed out.'))
                    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                    .slice(0, clamp(Math.floor(args.maxChats), 1, 50))

            const maxResults = clamp(Math.floor(args.maxResults), 1, 50)
            const perChatLimit = clamp(Math.floor(args.perChatLimit), 1, 150)
            const results: WhatsAppMessageSummary[] = []
            let scannedMessages = 0
            let truncated = false

            for (const chat of candidateChats) {
                if (results.length >= maxResults) {
                    truncated = true
                    break
                }
                let messages: Message[]
                try {
                    messages = await withTimeout(
                        chat.fetchMessages({ limit: perChatLimit }),
                        DEFAULT_OPERATION_TIMEOUT_MS,
                        `WhatsApp message fetch timed out for ${chat.name || chat.id._serialized}.`
                    )
                } catch {
                    continue
                }

                scannedMessages += messages.length
                for (const message of messages) {
                    const body = message.body ?? ''
                    if (!body.toLowerCase().includes(query)) continue
                    results.push(messageSummary(message, chat))
                    if (results.length >= maxResults) {
                        truncated = true
                        break
                    }
                }
            }

            return {
                query: args.query,
                scannedChats: candidateChats.length,
                scannedMessages,
                results: results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)),
                truncated,
            }
        })
    }

    private async ensureStarted(): Promise<void> {
        if (
            this.client &&
            this.state.phase !== 'error' &&
            this.state.phase !== 'auth_failure' &&
            this.state.phase !== 'disconnected'
        ) return
        if (this.initializePromise) return this.initializePromise

        this.initializePromise = this.initialize().finally(() => {
            this.initializePromise = null
        })
        return this.initializePromise
    }

    private async initialize(): Promise<void> {
        ensurePrivateDir(AUTH_BASE_DIR)

        const executablePath = resolveBrowserExecutablePath()
        this.state.browserExecutablePath = executablePath
        if (!executablePath) {
            this.state.phase = 'error'
            this.state.lastError = 'Could not find Chrome/Chromium. Set WHATSAPP_CHROME_EXECUTABLE_PATH to a local Chrome executable.'
            throw new Error(this.state.lastError)
        }

        this.state.phase = 'starting'
        this.state.lastError = null

        const whatsappWeb = await import('whatsapp-web.js')
        const ClientCtor = whatsappWeb.Client
        const LocalAuthCtor = whatsappWeb.LocalAuth

        for (let attempt = 0; attempt < 2; attempt += 1) {
            const client = new ClientCtor({
                authStrategy: new LocalAuthCtor({
                    clientId: AUTH_CLIENT_ID,
                    dataPath: AUTH_BASE_DIR,
                }),
                takeoverOnConflict: false,
                qrMaxRetries: 0,
                puppeteer: {
                    executablePath,
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-extensions',
                        '--disable-gpu',
                    ],
                },
            })

            this.client = client
            this.attachEvents(client)

            try {
                await client.initialize()
                return
            } catch (err) {
                this.state.phase = 'error'
                this.state.lastError = err instanceof Error ? err.message : 'Could not start WhatsApp Web.'
                try {
                    await client.destroy()
                } catch {
                    // Ignore cleanup failures after a failed launch.
                }
                if (this.client === client) this.client = null

                if (attempt === 0 && isBrowserProfileInUseError(err)) {
                    const killed = killBrowserProcessesUsingPath(path.join(AUTH_BASE_DIR, `session-${AUTH_CLIENT_ID}`))
                    this.state.phase = 'starting'
                    this.state.lastError = killed > 0
                        ? `Closed ${killed} stale WhatsApp browser process${killed === 1 ? '' : 'es'}; retrying.`
                        : 'WhatsApp browser profile looked busy; retrying startup once.'
                    await sleep(1_000)
                    continue
                }

                throw err
            }
        }
    }

    private attachEvents(client: Client) {
        client.on('qr', (qr: string) => {
            void this.setQr(qr)
        })

        client.on('authenticated', () => {
            this.state.phase = 'authenticated'
            this.state.lastSyncAt = Date.now()
        })

        client.on('ready', () => {
            this.state.phase = 'ready'
            this.state.lastError = null
            this.state.lastReadyAt = Date.now()
            this.state.lastSyncAt = Date.now()
            this.clearQr()
            this.captureAccountInfo(client)
        })

        client.on('auth_failure', (message: string) => {
            this.state.phase = 'auth_failure'
            this.state.lastError = message || 'WhatsApp authentication failed.'
            this.clearQr()
        })

        client.on('disconnected', (reason: string) => {
            this.state.phase = 'disconnected'
            this.state.lastError = reason || null
            this.state.lastSyncAt = Date.now()
            this.clearQr()
            if (this.client === client) this.client = null
        })
    }

    private async setQr(qr: string) {
        this.state.phase = 'qr'
        this.state.qrText = qr
        this.state.qrUpdatedAt = Date.now()
        this.state.lastSyncAt = Date.now()
        try {
            const qrcode = await import('qrcode')
            this.state.qrDataUrl = await qrcode.toDataURL(qr, {
                width: 320,
                margin: 1,
                errorCorrectionLevel: 'M',
            })
        } catch (err) {
            this.state.qrDataUrl = null
            this.state.lastError = err instanceof Error ? err.message : 'Could not render WhatsApp QR.'
        }
    }

    private clearQr() {
        this.state.qrText = null
        this.state.qrDataUrl = null
        this.state.qrUpdatedAt = null
    }

    private captureAccountInfo(client: Client) {
        try {
            const info = client.info
            this.state.accountName = info?.pushname || null
            this.state.phoneNumber = info?.wid?.user || info?.me?.user || null
        } catch (err) {
            this.state.lastError = formatClientError(err)
        }
    }

    private async waitForQrOrReady(timeoutMs = 30_000): Promise<void> {
        const startedAt = Date.now()
        while (Date.now() - startedAt < timeoutMs) {
            if (this.state.phase === 'qr' || this.state.phase === 'ready') return
            if (this.state.phase === 'error' || this.state.phase === 'auth_failure') return
            await sleep(250)
        }
    }

    private async requireReadyClient(): Promise<Client> {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            await this.ensureStarted()
            await this.waitForReady()
            if (this.client && this.state.phase === 'ready') return this.client
            if (
                attempt === 0 &&
                this.client &&
                (this.state.phase === 'authenticated' || this.state.phase === 'starting')
            ) {
                await this.resetBrokenClient(
                    new Error('WhatsApp Web did not become ready after authentication.'),
                    'WhatsApp startup stalled'
                )
                continue
            }
            break
        }

        throw new Error('WhatsApp is not connected. Use WhatsAppConnect and scan the QR code first.')
    }

    private async waitForReady(timeoutMs = READY_WAIT_TIMEOUT_MS): Promise<void> {
        const startedAt = Date.now()
        while (Date.now() - startedAt < timeoutMs) {
            if (this.state.phase === 'ready') return
            if (this.state.phase === 'qr' || this.state.phase === 'error' || this.state.phase === 'auth_failure') return
            await sleep(250)
        }
    }

    private async runReadyOperation<T>(
        label: string,
        operation: (client: Client) => Promise<T>
    ): Promise<T> {
        const client = await this.requireReadyClient()
        try {
            return await operation(client)
        } catch (err) {
            if (!isRecoverableClientError(err)) throw err
            await this.resetBrokenClient(err)
        }

        const retryClient = await this.requireReadyClient()
        try {
            return await operation(retryClient)
        } catch (err) {
            if (isRecoverableClientError(err)) await this.resetBrokenClient(err)
            throw new Error(`WhatsApp ${label} failed after reconnect: ${formatClientError(err)}`)
        }
    }

    private async resetBrokenClient(err: unknown, prefix = 'WhatsApp browser session broke'): Promise<void> {
        const client = this.client
        this.client = null
        this.initializePromise = null
        this.state.phase = 'error'
        this.state.lastError = `${prefix}: ${formatClientError(err)}`
        this.state.lastSyncAt = Date.now()
        this.clearQr()

        if (!client) return
        try {
            await withTimeout(client.destroy(), 5_000, 'Timed out while closing stale WhatsApp browser.')
        } catch {
            // The browser is already broken; best-effort cleanup is enough.
        }
    }

    private async isReadyClientHealthy(): Promise<boolean> {
        const client = this.client
        if (!client || this.state.phase !== 'ready') return false

        try {
            const state = await withTimeout(client.getState(), READY_HEALTH_TIMEOUT_MS, 'WhatsApp health check timed out.')
            if (String(state).toUpperCase() === 'CONNECTED') {
                this.state.lastError = null
                return true
            }
            this.state.phase = 'disconnected'
            this.state.lastError = state ? `WhatsApp Web state is ${state}. Reconnect to resume.` : 'WhatsApp Web is not connected.'
            this.state.lastSyncAt = Date.now()
            return false
        } catch (err) {
            if (isRecoverableClientError(err)) {
                await this.resetBrokenClient(err)
            } else {
                this.state.phase = 'error'
                this.state.lastError = formatClientError(err)
                this.state.lastSyncAt = Date.now()
            }
            return false
        }
    }

    private async getChat(client: Client, chatId: string): Promise<Chat> {
        const normalized = normalizeChatId(chatId)
        try {
            return await withTimeout(
                client.getChatById(normalized),
                DEFAULT_OPERATION_TIMEOUT_MS,
                `WhatsApp chat lookup timed out for ${normalized}.`
            )
        } catch (err) {
            throw new Error(`Could not read WhatsApp chat ${normalized}: ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    private async status(origin?: string): Promise<WhatsAppIntegrationStatus> {
        const browserExecutablePath = this.state.browserExecutablePath ?? resolveBrowserExecutablePath()
        this.state.browserExecutablePath = browserExecutablePath
        const qrUpdatedAt = this.state.qrUpdatedAt
        const connected = await this.isReadyClientHealthy()
        const qrImageUrl = origin && this.state.qrText
            ? `${origin}/api/integrations/whatsapp/qr?ts=${qrUpdatedAt ?? Date.now()}`
            : null

        return {
            id: 'whatsapp',
            name: 'WhatsApp',
            description: 'Read-only WhatsApp Web session using your own linked device. No send, delete, archive, or mark-read tools are exposed.',
            configured: Boolean(browserExecutablePath),
            connected,
            accountName: this.state.accountName,
            phoneNumber: this.state.phoneNumber,
            phase: this.state.phase,
            sessionStored: hasStoredSession(),
            qrAvailable: Boolean(this.state.qrText),
            qrDataUrl: this.state.qrDataUrl,
            qrImageUrl,
            qrUpdatedAt,
            qrExpiresAt: qrUpdatedAt ? qrUpdatedAt + QR_TTL_MS : null,
            lastReadyAt: this.state.lastReadyAt,
            lastSyncAt: this.state.lastSyncAt,
            lastError: this.state.lastError,
            browserExecutablePath,
            missingConfig: browserExecutablePath ? [] : ['WHATSAPP_CHROME_EXECUTABLE_PATH or local Chrome/Chromium'],
            needsReconnect: !connected,
            capabilities: ['status', 'qr_login', 'list_chats', 'unread_summary', 'read_chat', 'search_recent_messages'],
        }
    }
}

declare global {
    var __orchestratorWhatsAppManager: WhatsAppManager | undefined
}

function manager(): WhatsAppManager {
    globalThis.__orchestratorWhatsAppManager ??= new WhatsAppManager()
    return globalThis.__orchestratorWhatsAppManager
}

export function getWhatsAppIntegrationStatus(origin?: string): Promise<WhatsAppIntegrationStatus> {
    return manager().getStatus(origin)
}

export function startWhatsApp(origin?: string): Promise<WhatsAppStartResult> {
    return manager().start(origin)
}

export function disconnectWhatsApp(): Promise<void> {
    return manager().disconnect()
}

export function getWhatsAppQrPng(): Promise<Buffer | null> {
    return manager().getQrPng()
}

export function whatsappListChats(maxResults: number): Promise<{ chats: WhatsAppChatSummary[] }> {
    return manager().listChats(maxResults)
}

export function whatsappUnreadSummary(maxResults: number): Promise<WhatsAppUnreadSummary> {
    return manager().unreadSummary(maxResults)
}

export function whatsappReadChat(chatId: string, maxMessages: number, maxChars: number): Promise<WhatsAppReadChatResult> {
    return manager().readChat(chatId, maxMessages, maxChars)
}

export function whatsappSearchMessages(args: {
    query: string
    chatId?: string
    maxResults: number
    maxChats: number
    perChatLimit: number
}): Promise<WhatsAppSearchResult> {
    return manager().searchMessages(args)
}

function chatSummary(chat: Chat): WhatsAppChatSummary {
    return {
        id: chat.id._serialized,
        name: chat.name || chat.id.user || chat.id._serialized,
        isGroup: Boolean(chat.isGroup),
        isReadOnly: Boolean(chat.isReadOnly),
        unreadCount: Number.isFinite(chat.unreadCount) ? chat.unreadCount : 0,
        timestamp: unixSeconds(chat.timestamp),
        lastMessage: chat.lastMessage ? messageSummary(chat.lastMessage, chat) : null,
    }
}

function unreadChatSummary(chat: Chat): WhatsAppUnreadChatSummary {
    return {
        id: chat.id._serialized,
        name: chat.name || chat.id.user || chat.id._serialized,
        isGroup: Boolean(chat.isGroup),
        unreadCount: Number.isFinite(chat.unreadCount) ? chat.unreadCount : 0,
        timestamp: unixSeconds(chat.timestamp),
    }
}

function messageSummary(message: Message, chat?: Chat): WhatsAppMessageSummary {
    return {
        id: message.id?._serialized || message.id?.id || '',
        chatId: chat?.id._serialized || (message.fromMe ? message.to : message.from),
        chatName: chat?.name || undefined,
        from: message.from,
        to: message.to,
        author: message.author ?? null,
        fromMe: Boolean(message.fromMe),
        type: String(message.type ?? 'unknown'),
        body: clip(message.body ?? '', 8_000),
        timestamp: unixSeconds(message.timestamp),
        date: message.timestamp ? new Date(message.timestamp * 1000).toISOString() : null,
        hasMedia: Boolean(message.hasMedia),
    }
}

function limitMessagesByChars(messages: WhatsAppMessageSummary[], maxChars: number): {
    messages: WhatsAppMessageSummary[]
    truncated: boolean
} {
    let used = 0
    const out: WhatsAppMessageSummary[] = []
    for (const message of messages) {
        const bodyChars = message.body.length
        if (out.length > 0 && used + bodyChars > maxChars) return { messages: out, truncated: true }
        out.push(message)
        used += bodyChars
    }
    return { messages: out, truncated: false }
}

function normalizeChatId(value: string): string {
    const trimmed = value.trim()
    if (trimmed.includes('@')) return trimmed
    const digits = trimmed.replace(/[^\d]/g, '')
    if (digits.length >= 8) return `${digits}@c.us`
    return trimmed
}

function unixSeconds(value: number | undefined): number | null {
    return Number.isFinite(value) && value ? value : null
}

function clip(value: string, maxChars: number): string {
    return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min
    return Math.max(min, Math.min(max, value))
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | null = null
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function isRecoverableClientError(err: unknown): boolean {
    const message = formatClientError(err).toLowerCase()
    return [
        'detached frame',
        'target closed',
        'session closed',
        'protocol error',
        'execution context was destroyed',
        'cannot find context',
        'page has been closed',
        'browser has been closed',
        'most likely the page has been closed',
    ].some(fragment => message.includes(fragment))
}

function isBrowserProfileInUseError(err: unknown): boolean {
    const message = formatClientError(err).toLowerCase()
    return message.includes('browser is already running') || message.includes('userdatadir')
}

function killBrowserProcessesUsingPath(profilePath: string): number {
    let output: string
    try {
        output = execFileSync('ps', ['-axo', 'pid=,command='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        })
    } catch {
        return 0
    }

    let killed = 0
    for (const line of output.split('\n')) {
        if (!line.includes(profilePath)) continue
        const match = line.match(/^\s*(\d+)\s+(.+)$/)
        if (!match) continue
        const pid = Number(match[1])
        const command = match[2]
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
        if (!/chrome|chromium|brave|edge/i.test(command)) continue
        try {
            process.kill(pid, 'SIGTERM')
            killed += 1
        } catch {
            // The process may have exited between ps and kill.
        }
    }
    return killed
}

function formatClientError(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}

function ensurePrivateDir(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    try {
        fs.chmodSync(dir, 0o700)
    } catch {
        // Some filesystems ignore chmod; the directory remains in private app state.
    }
}

function hasStoredSession(): boolean {
    try {
        if (!fs.existsSync(AUTH_BASE_DIR)) return false
        const entries = fs.readdirSync(AUTH_BASE_DIR)
        return entries.some(entry => entry.includes(AUTH_CLIENT_ID) || entry.includes('session'))
    } catch {
        return false
    }
}

function resolveBrowserExecutablePath(): string | null {
    const configured = getEnvValue('WHATSAPP_CHROME_EXECUTABLE_PATH') || process.env.PUPPETEER_EXECUTABLE_PATH
    if (configured && fileExists(configured)) return configured

    const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        ...puppeteerCacheExecutables(),
    ]

    return candidates.find(fileExists) ?? null
}

function puppeteerCacheExecutables(): string[] {
    const cacheDir = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome-headless-shell')
    try {
        return fs.readdirSync(cacheDir)
            .map(name => ({
                name,
                fullPath: path.join(cacheDir, name, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'),
                mtimeMs: statMtime(path.join(cacheDir, name)),
            }))
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .map(item => item.fullPath)
    } catch {
        return []
    }
}

function statMtime(filePath: string): number {
    try {
        return fs.statSync(filePath).mtimeMs
    } catch {
        return 0
    }
}

function fileExists(filePath: string): boolean {
    try {
        fs.accessSync(filePath, fs.constants.X_OK)
        return true
    } catch {
        return false
    }
}
