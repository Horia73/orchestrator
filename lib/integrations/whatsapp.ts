import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

import { PRIVATE_STATE_DIR, getEnvValue } from '@/lib/config'

import type { Chat, Client, Message, MessageSendOptions } from 'whatsapp-web.js'

const AUTH_BASE_DIR = path.join(PRIVATE_STATE_DIR, 'whatsapp-web')
const AUTH_CLIENT_ID = 'orchestrator'
const QR_TTL_MS = 60_000
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const READY_WAIT_TIMEOUT_MS = 120_000
const READY_HEALTH_TIMEOUT_MS = 5_000
const STATUS_READY_WAIT_TIMEOUT_MS = 10_000
const AUTO_RESUME_COOLDOWN_MS = 30_000
const DEFAULT_WHATSAPP_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

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

export interface WhatsAppOutgoingAttachment {
    filename: string
    mimeType: string
    bytes: Buffer
    sendAsDocument: boolean
}

export interface WhatsAppAttachmentSummary {
    filename: string
    mimeType: string
    size: number
    sendAsDocument: boolean
}

export interface WhatsAppSendOptions {
    quotedMessageId?: string
    linkPreview?: boolean
}

export interface WhatsAppSendMessageResult {
    status: 'sent'
    chat: WhatsAppChatSummary
    message: WhatsAppMessageSummary
}

export interface WhatsAppSendMediaResult {
    status: 'sent'
    chat: WhatsAppChatSummary
    messages: WhatsAppMessageSummary[]
    attachments: WhatsAppAttachmentSummary[]
    caption: string | null
}

export interface WhatsAppDeleteMessageResult {
    status: 'deleted_for_everyone'
    messageId: string
    chatId: string | null
    deletedFor: 'everyone'
    clearMedia: true
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
    private lastAutoResumeAt = 0
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
        await this.resumeStoredSessionForStatus()
        return this.status(origin)
    }

    async start(origin?: string): Promise<WhatsAppStartResult> {
        await this.ensureStarted()
        await this.waitForQrOrReady()
        if (this.state.phase === 'authenticated' || this.state.phase === 'starting') await this.waitForReady()
        const status = await this.status(origin)
        return {
            status,
            qrMarkdown: status.qrDataUrl
                ? `![WhatsApp QR](${status.qrDataUrl})`
                : status.qrImageUrl ? `![WhatsApp QR](${status.qrImageUrl})` : null,
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

    async sendMessage(chatId: string, body: string, options: WhatsAppSendOptions = {}): Promise<WhatsAppSendMessageResult> {
        if (!body.trim()) throw new Error('WhatsApp message body is required.')

        return this.runReadyOperation('send message', async client => {
            const chat = await this.getChat(client, chatId)
            ensureChatWritable(chat)
            const message = await withTimeout(
                client.sendMessage(chat.id._serialized, body, sendOptions(options)),
                DEFAULT_OPERATION_TIMEOUT_MS,
                'WhatsApp message send timed out.'
            )
            if (!message) throw new Error('WhatsApp did not return a sent message.')
            return {
                status: 'sent',
                chat: chatSummary(chat),
                message: messageSummary(message, chat),
            }
        })
    }

    async sendMedia(
        chatId: string,
        attachments: WhatsAppOutgoingAttachment[],
        caption?: string,
        options: WhatsAppSendOptions = {}
    ): Promise<WhatsAppSendMediaResult> {
        if (attachments.length === 0) throw new Error('At least one WhatsApp attachment is required.')
        const cleanCaption = caption && caption.trim() ? caption : ''

        return this.runReadyOperation('send media', async client => {
            const chat = await this.getChat(client, chatId)
            ensureChatWritable(chat)

            const whatsappWeb = await import('whatsapp-web.js')
            const MediaCtor = whatsappWeb.MessageMedia
            const messages: WhatsAppMessageSummary[] = []
            for (const [index, attachment] of attachments.entries()) {
                const media = new MediaCtor(
                    attachment.mimeType,
                    attachment.bytes.toString('base64'),
                    attachment.filename,
                    attachment.bytes.byteLength
                )
                const messageOptions: MessageSendOptions = {
                    ...sendOptions(options),
                    sendMediaAsDocument: attachment.sendAsDocument,
                    caption: index === 0 && cleanCaption ? cleanCaption : undefined,
                }
                const message = await withTimeout(
                    client.sendMessage(chat.id._serialized, media, messageOptions),
                    DEFAULT_OPERATION_TIMEOUT_MS,
                    `WhatsApp media send timed out for ${attachment.filename}.`
                )
                if (!message) throw new Error(`WhatsApp did not return a sent message for ${attachment.filename}.`)
                messages.push(messageSummary(message, chat))
            }

            return {
                status: 'sent',
                chat: chatSummary(chat),
                messages,
                attachments: attachments.map(attachmentSummary),
                caption: cleanCaption || null,
            }
        })
    }

    async deleteMessageForEveryone(messageId: string): Promise<WhatsAppDeleteMessageResult> {
        const normalized = messageId.trim()
        if (!normalized) throw new Error('WhatsApp message_id is required.')

        return this.runReadyOperation('delete message for everyone', async client => {
            const message = await withTimeout(
                client.getMessageById(normalized),
                DEFAULT_OPERATION_TIMEOUT_MS,
                `WhatsApp message lookup timed out for ${normalized}.`
            )
            if (!message) throw new Error(`Could not find WhatsApp message ${normalized}.`)
            const summary = messageSummary(message)
            await withTimeout(
                message.delete(true, true),
                DEFAULT_OPERATION_TIMEOUT_MS,
                `WhatsApp delete-for-everyone timed out for ${normalized}.`
            )
            return {
                status: 'deleted_for_everyone',
                messageId: normalized,
                chatId: summary.chatId || null,
                deletedFor: 'everyone',
                clearMedia: true,
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
        const sessionPath = authSessionPath()
        cleanupStaleBrowserProfileLocks(sessionPath)

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
                authTimeoutMs: 120_000,
                takeoverOnConflict: false,
                userAgent: resolveWhatsAppUserAgent(),
                deviceName: 'Orchestrator',
                browserName: 'Chrome',
                qrMaxRetries: 0,
                puppeteer: {
                    executablePath,
                    headless: true,
                    defaultViewport: {
                        width: 1280,
                        height: 900,
                    },
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-extensions',
                        '--disable-gpu',
                        '--disable-background-timer-throttling',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-renderer-backgrounding',
                        '--no-first-run',
                        '--window-size=1280,900',
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
                    const killed = killBrowserProcessesUsingPath(sessionPath)
                    if (killed > 0) await sleep(1_000)
                    const removedLocks = cleanupStaleBrowserProfileLocks(sessionPath)
                    this.state.phase = 'starting'
                    this.state.lastError = killed > 0
                        ? `Closed ${killed} stale WhatsApp browser process${killed === 1 ? '' : 'es'}; retrying.`
                        : removedLocks > 0
                            ? `Removed ${removedLocks} stale WhatsApp browser profile lock${removedLocks === 1 ? '' : 's'}; retrying.`
                            : 'WhatsApp browser profile looked busy; retrying startup once.'
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
            this.clearQr()
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

    private async resumeStoredSessionForStatus(): Promise<void> {
        if (this.client || this.initializePromise) {
            if (this.state.phase === 'starting' || this.state.phase === 'authenticated') {
                await this.waitForReady(STATUS_READY_WAIT_TIMEOUT_MS)
            }
            return
        }

        if (!hasStoredSession() || this.state.phase === 'auth_failure') return

        const now = Date.now()
        if (this.state.phase === 'error' && now - this.lastAutoResumeAt < AUTO_RESUME_COOLDOWN_MS) return
        this.lastAutoResumeAt = now

        try {
            await this.ensureStarted()
            await this.waitForQrOrReady(STATUS_READY_WAIT_TIMEOUT_MS)
            if (this.state.phase === 'authenticated' || this.state.phase === 'starting') {
                await this.waitForReady(STATUS_READY_WAIT_TIMEOUT_MS)
            }
        } catch {
            // status() below reports the stored session plus the concrete lastError.
        }
    }

    private async requireReadyClient(): Promise<Client> {
        await this.ensureStarted()
        await this.waitForReady()
        if (this.client && this.state.phase === 'ready') return this.client

        if (this.client && (this.state.phase === 'authenticated' || this.state.phase === 'starting')) {
            throw new Error('WhatsApp Web is still linking/syncing after QR scan. Keep WhatsApp on your phone and the Orchestrator WhatsApp session open, then retry when syncing finishes.')
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
            description: 'Local WhatsApp Web session using your own linked device. Read tools are available; sending media/messages and deleting messages for everyone require explicit confirmation.',
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
            capabilities: ['status', 'qr_login', 'list_chats', 'unread_summary', 'read_chat', 'search_recent_messages', 'send_message', 'send_media', 'delete_message_for_everyone'],
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

export function whatsappSendMessage(chatId: string, body: string, options?: WhatsAppSendOptions): Promise<WhatsAppSendMessageResult> {
    return manager().sendMessage(chatId, body, options)
}

export function whatsappSendMedia(
    chatId: string,
    attachments: WhatsAppOutgoingAttachment[],
    caption?: string,
    options?: WhatsAppSendOptions
): Promise<WhatsAppSendMediaResult> {
    return manager().sendMedia(chatId, attachments, caption, options)
}

export function whatsappDeleteMessageForEveryone(messageId: string): Promise<WhatsAppDeleteMessageResult> {
    return manager().deleteMessageForEveryone(messageId)
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

function attachmentSummary(attachment: WhatsAppOutgoingAttachment): WhatsAppAttachmentSummary {
    return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.bytes.byteLength,
        sendAsDocument: attachment.sendAsDocument,
    }
}

function ensureChatWritable(chat: Chat): void {
    if (chat.isReadOnly) {
        throw new Error(`WhatsApp chat ${chat.name || chat.id._serialized} is read-only and cannot receive messages.`)
    }
}

function sendOptions(options: WhatsAppSendOptions): MessageSendOptions {
    const out: MessageSendOptions = {
        sendSeen: false,
        waitUntilMsgSent: true,
    }
    const quotedMessageId = options.quotedMessageId?.trim()
    if (quotedMessageId) out.quotedMessageId = quotedMessageId
    if (typeof options.linkPreview === 'boolean') out.linkPreview = options.linkPreview
    return out
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
    return message.includes('browser is already running')
        || message.includes('userdatadir')
        || message.includes('processsingleton')
        || message.includes('singletonlock')
        || message.includes('singleton lock')
}

function killBrowserProcessesUsingPath(profilePath: string): number {
    const processes = browserProcessesUsingPath(profilePath)
    let killed = 0
    for (const processInfo of processes) {
        try {
            process.kill(processInfo.pid, 'SIGTERM')
            killed += 1
        } catch {
            // The process may have exited between ps and kill.
        }
    }
    return killed
}

function cleanupStaleBrowserProfileLocks(profilePath: string): number {
    if (!profilePath || browserProcessesUsingPath(profilePath).length > 0) return 0

    let removed = 0
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        const filePath = path.join(profilePath, name)
        try {
            fs.lstatSync(filePath)
            fs.rmSync(filePath, { force: true, recursive: false })
            removed += 1
        } catch {
            // If the file disappeared or is not removable, Chromium will report it on launch.
        }
    }
    return removed
}

function browserProcessesUsingPath(profilePath: string): Array<{ pid: number; command: string }> {
    let output: string
    try {
        output = execFileSync('ps', ['-axo', 'pid=,command='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        })
    } catch {
        return []
    }

    const processes: Array<{ pid: number; command: string }> = []
    for (const line of output.split('\n')) {
        if (!line.includes(profilePath)) continue
        const match = line.match(/^\s*(\d+)\s+(.+)$/)
        if (!match) continue
        const pid = Number(match[1])
        const command = match[2]
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
        if (!/chrome|chromium|brave|edge/i.test(command)) continue
        processes.push({ pid, command })
    }
    return processes
}

function authSessionPath(): string {
    return path.join(AUTH_BASE_DIR, `session-${AUTH_CLIENT_ID}`)
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

function resolveWhatsAppUserAgent(): string {
    return getEnvValue('WHATSAPP_USER_AGENT') || DEFAULT_WHATSAPP_USER_AGENT
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
