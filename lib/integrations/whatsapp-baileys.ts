import fs from 'fs'
import path from 'path'

import { activeRuntimePaths } from '@/lib/runtime-paths'
import { normalizeTimezone } from '@/lib/timezone'

import {
    attachmentSummary,
    limitMessagesByChars,
    normalizeChatId,
} from './whatsapp-formatting'

import type {
    WhatsAppChatSummary,
    WhatsAppDeleteMessageResult,
    WhatsAppDownloadedMedia,
    WhatsAppFindMessagesArgs,
    WhatsAppFindMessagesResult,
    WhatsAppIntegrationStatus,
    WhatsAppMarkChatResult,
    WhatsAppMessageSummary,
    WhatsAppOutgoingAttachment,
    WhatsAppPhase,
    WhatsAppReadChatResult,
    WhatsAppSearchResult,
    WhatsAppSendMediaResult,
    WhatsAppSendMessageResult,
    WhatsAppSendOptions,
    WhatsAppStartResult,
    WhatsAppUnreadChatSummary,
    WhatsAppUnreadSummary,
} from './whatsapp'
import type {
    BaileysEventMap,
    Chat,
    Contact,
    AnyMessageContent,
    MinimalMessage,
    WAMessage,
    WAMessageContent,
    WAMessageKey,
    WASocket,
    WAVersion,
} from 'baileys'

const QR_TTL_MS = 60_000
const READY_WAIT_TIMEOUT_MS = 120_000
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000
const WA_WEB_VERSION_TIMEOUT_MS = 5_000
const FIND_MESSAGES_DEFAULT_MAX_RESULTS = 20
const FIND_MESSAGES_MAX_RESULTS = 75
const FIND_MESSAGES_DEFAULT_MAX_MESSAGES = 500
const FIND_MESSAGES_MAX_MESSAGES = 2_000
const STORE_MESSAGES_PER_CHAT = 500
const STORE_MAX_CHATS = 250
const BAILEYS_RESTART_REQUIRED = 515
const BAILEYS_MAX_RESTARTS = 2
const BAILEYS_UNAUTHORIZED = new Set([401, 403, 419])

type BaileysModule = typeof import('baileys')

interface MutableBaileysState {
    phase: WhatsAppPhase
    qrText: string | null
    qrDataUrl: string | null
    qrUpdatedAt: number | null
    accountName: string | null
    phoneNumber: string | null
    lastAuthenticatedAt: number | null
    lastReadyAt: number | null
    lastSyncAt: number | null
    lastError: string | null
}

interface StoredChat {
    id: string
    name: string | null
    isGroup: boolean
    isReadOnly: boolean
    unreadCount: number
    timestamp: number | null
    lastMessageId: string | null
}

interface StoredContact {
    id: string
    name: string | null
}

interface ParsedMessageId {
    remoteJid: string
    id: string
    fromMe: boolean
    participant?: string
}

interface FindDateFilter {
    raw: string
    localDate: string | null
    instantSeconds: number | null
}

const nullLogger = {
    level: 'silent',
    child() {
        return nullLogger
    },
    trace() { },
    debug() { },
    info() { },
    warn() { },
    error() { },
}

export class BaileysWhatsAppManager {
    private socket: WASocket | null = null
    private connectPromise: Promise<void> | null = null
    private restartPromise: Promise<void> | null = null
    private restartAttempts = 0
    private saveCreds: (() => Promise<void>) | null = null
    private baileys: BaileysModule | null = null
    private readonly chats = new Map<string, StoredChat>()
    private readonly contacts = new Map<string, StoredContact>()
    private readonly messagesByChat = new Map<string, WAMessage[]>()
    private readonly messagesById = new Map<string, WAMessage>()
    private state: MutableBaileysState = {
        phase: 'idle',
        qrText: null,
        qrDataUrl: null,
        qrUpdatedAt: null,
        accountName: null,
        phoneNumber: null,
        lastAuthenticatedAt: null,
        lastReadyAt: null,
        lastSyncAt: null,
        lastError: null,
    }

    async getStatus(origin?: string): Promise<WhatsAppIntegrationStatus> {
        return this.status(origin)
    }

    async start(origin?: string): Promise<WhatsAppStartResult> {
        this.prepareInteractiveAuthStart()
        await this.ensureStarted()
        await this.waitForQrOrReady()
        if (this.state.phase === 'starting' || this.state.phase === 'authenticated') await this.waitForReady()
        const status = await this.status(origin)
        return {
            status,
            qrMarkdown: status.qrDataUrl
                ? `![WhatsApp QR](${status.qrDataUrl})`
                : status.qrImageUrl ? `![WhatsApp QR](${status.qrImageUrl})` : null,
        }
    }

    async disconnect(): Promise<void> {
        const socket = this.socket
        this.socket = null
        this.connectPromise = null
        this.restartPromise = null
        this.restartAttempts = 0
        this.saveCreds = null
        this.state.phase = 'disconnected'
        this.clearQr()
        this.clearStore()

        if (socket) {
            try {
                await socket.logout('Orchestrator disconnect')
            } catch {
                try {
                    await socket.end(undefined)
                } catch {
                    // Best effort; local auth cleanup below is the important part.
                }
            }
        }

        fs.rmSync(/* turbopackIgnore: true */ authBaseDir(), { recursive: true, force: true })
        this.state.accountName = null
        this.state.phoneNumber = null
        this.state.lastSyncAt = Date.now()
    }

    async stopRuntime(): Promise<void> {
        const socket = this.socket
        this.socket = null
        this.connectPromise = null
        this.restartPromise = null
        this.restartAttempts = 0
        this.saveCreds = null
        this.state.phase = 'disconnected'
        this.clearQr()
        this.clearStore()

        if (socket) {
            try {
                await socket.end(undefined)
            } catch {
                // Runtime stop is best-effort; it intentionally preserves local auth.
            }
        }

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
        await this.requireReadySocket()
        const limit = clamp(Math.floor(maxResults), 1, 50)
        return {
            chats: this.sortedChats()
                .slice(0, limit)
                .map(chat => this.chatSummary(chat)),
        }
    }

    async unreadSummary(maxResults: number): Promise<WhatsAppUnreadSummary> {
        await this.requireReadySocket()
        const limit = clamp(Math.floor(maxResults), 1, 50)
        const unreadChats = this.sortedChats()
            .filter(chat => chat.unreadCount > 0)
            .map(chat => this.unreadChatSummary(chat))
        return {
            totalUnread: unreadChats.reduce((sum, chat) => sum + chat.unreadCount, 0),
            unreadChatCount: unreadChats.length,
            scannedChats: this.chats.size,
            unreadChats: unreadChats.slice(0, limit),
            truncated: unreadChats.length > limit,
        }
    }

    async readChat(chatId: string, maxMessages: number, maxChars: number): Promise<WhatsAppReadChatResult> {
        await this.requireReadySocket()
        const chat = this.requireChat(chatId)
        const newestFirst = this.messagesForChat(chat.id)
            .slice()
            .sort((a, b) => timestampOfMessage(b) - timestampOfMessage(a))
            .slice(0, clamp(Math.floor(maxMessages), 1, 100))
        const limited = limitMessagesByChars(
            newestFirst.map(message => this.messageSummary(message, chat)),
            clamp(Math.floor(maxChars), 2_000, 80_000)
        )
        return {
            chat: this.chatSummary(chat),
            messages: limited.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)),
            truncated: limited.truncated || newestFirst.length > limited.messages.length,
        }
    }

    async searchMessages(args: {
        query: string
        chatId?: string
        maxResults: number
        maxChats: number
        perChatLimit: number
    }): Promise<WhatsAppSearchResult> {
        await this.requireReadySocket()
        const query = args.query.trim().toLowerCase()
        if (!query) throw new Error('WhatsApp search query is required.')

        const candidateChats = args.chatId
            ? [this.requireChat(args.chatId)]
            : this.sortedChats().slice(0, clamp(Math.floor(args.maxChats), 1, 50))
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
            const messages = this.messagesForChat(chat.id)
                .slice()
                .sort((a, b) => timestampOfMessage(b) - timestampOfMessage(a))
                .slice(0, perChatLimit)
            scannedMessages += messages.length
            for (const message of messages) {
                const summary = this.messageSummary(message, chat)
                if (!summary.body.toLowerCase().includes(query)) continue
                results.push(summary)
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
    }

    async findMessages(args: WhatsAppFindMessagesArgs): Promise<WhatsAppFindMessagesResult> {
        await this.requireReadySocket()
        const chat = this.requireChat(args.chatId)
        const query = args.query?.trim() ? args.query.trim().toLowerCase() : null
        const dateFrom = parseFindDateFilter(args.dateFrom, 'date_from')
        const dateTo = parseFindDateFilter(args.dateTo, 'date_to')
        const types = normalizeMessageTypes(args.types ?? [])
        const mediaOnly = Boolean(args.mediaOnly)
        const fromMe = typeof args.fromMe === 'boolean' ? args.fromMe : null

        if (!query && !dateFrom && !dateTo && types.length === 0 && !mediaOnly && fromMe === null) {
            throw new Error('WhatsAppFindMessages requires at least one filter: query, date_from/date_to, types, media_only, or from_me.')
        }

        const maxResults = clamp(Math.floor(args.maxResults ?? FIND_MESSAGES_DEFAULT_MAX_RESULTS), 1, FIND_MESSAGES_MAX_RESULTS)
        const maxMessages = clamp(Math.floor(args.maxMessages ?? FIND_MESSAGES_DEFAULT_MAX_MESSAGES), 50, FIND_MESSAGES_MAX_MESSAGES)
        const timeZone = normalizeTimezone(args.timeZone, 'UTC')
        const messages = this.messagesForChat(chat.id)
            .slice()
            .sort((a, b) => timestampOfMessage(b) - timestampOfMessage(a))
            .slice(0, maxMessages)
        const summaries = messages.map(message => this.messageSummary(message, chat))
        const matches: WhatsAppMessageSummary[] = []

        for (const summary of summaries) {
            if (fromMe !== null && summary.fromMe !== fromMe) continue
            if (query && !summary.body.toLowerCase().includes(query)) continue
            if (!matchesDate(summary.timestamp ?? 0, dateFrom, dateTo, timeZone)) continue
            if (types.length > 0 && !types.includes(normalizeMessageType(summary.type))) continue
            if (mediaOnly && !summary.hasMedia) continue
            matches.push(summary)
        }

        const timestamps = summaries.map(summary => summary.timestamp ?? 0).filter(ts => ts > 0)
        const oldest = timestamps.length ? Math.min(...timestamps) : 0
        const newest = timestamps.length ? Math.max(...timestamps) : 0
        const returned = matches.slice(0, maxResults)
        const scannedAllStored = messages.length < maxMessages && messages.length < STORE_MESSAGES_PER_CHAT
        const scanLimitHit = !scannedAllStored && matches.length <= returned.length

        return {
            chat: this.chatSummary(chat),
            filters: {
                query,
                dateFrom: dateFrom?.raw ?? null,
                dateTo: dateTo?.raw ?? null,
                timeZone,
                types,
                mediaOnly,
                fromMe,
            },
            scannedMessages: summaries.length,
            loadedEarlierBatches: 0,
            reachedStartOfChat: scannedAllStored,
            oldestScannedDate: oldest ? new Date(oldest * 1000).toISOString() : null,
            newestScannedDate: newest ? new Date(newest * 1000).toISOString() : null,
            results: returned,
            truncated: matches.length > returned.length || scanLimitHit,
            scanLimitHit,
        }
    }

    async sendMessage(chatId: string, body: string, options: WhatsAppSendOptions = {}): Promise<WhatsAppSendMessageResult> {
        if (!body.trim()) throw new Error('WhatsApp message body is required.')
        const socket = await this.requireReadySocket()
        const jid = normalizeBaileysChatId(chatId)
        const quoted = options.quotedMessageId ? this.messagesById.get(options.quotedMessageId.trim()) : undefined
        const message = await withTimeout(
            socket.sendMessage(jid, {
                text: body,
                linkPreview: options.linkPreview === false ? null : undefined,
            }, quoted ? { quoted } : undefined),
            DEFAULT_OPERATION_TIMEOUT_MS,
            'WhatsApp message send timed out.'
        )
        if (!message) throw new Error('WhatsApp did not return a sent message.')
        this.upsertMessage(message)
        const chat = this.ensureChatForJid(jid, message)
        return {
            status: 'sent',
            chat: this.chatSummary(chat),
            message: this.messageSummary(message, chat),
        }
    }

    async sendMedia(
        chatId: string,
        attachments: WhatsAppOutgoingAttachment[],
        caption?: string,
        options: WhatsAppSendOptions = {}
    ): Promise<WhatsAppSendMediaResult> {
        if (attachments.length === 0) throw new Error('At least one WhatsApp attachment is required.')
        const socket = await this.requireReadySocket()
        const jid = normalizeBaileysChatId(chatId)
        const quoted = options.quotedMessageId ? this.messagesById.get(options.quotedMessageId.trim()) : undefined
        const cleanCaption = caption && caption.trim() ? caption.trim() : ''
        const messages: WhatsAppMessageSummary[] = []

        for (const [index, attachment] of attachments.entries()) {
            const content = baileysMediaContent(attachment, index === 0 ? cleanCaption : '')
            const message = await withTimeout(
                socket.sendMessage(jid, content, quoted ? { quoted } : undefined),
                DEFAULT_OPERATION_TIMEOUT_MS,
                `WhatsApp media send timed out for ${attachment.filename}.`
            )
            if (!message) throw new Error(`WhatsApp did not return a sent message for ${attachment.filename}.`)
            this.upsertMessage(message)
            messages.push(this.messageSummary(message, this.ensureChatForJid(jid, message)))
        }

        return {
            status: 'sent',
            chat: this.chatSummary(this.ensureChatForJid(jid)),
            messages,
            attachments: attachments.map(attachmentSummary),
            caption: cleanCaption || null,
        }
    }

    async markChatRead(chatId: string): Promise<WhatsAppMarkChatResult> {
        const socket = await this.requireReadySocket()
        const chat = this.requireChat(chatId)
        const previousUnreadCount = chat.unreadCount
        const unreadKeys = this.messagesForChat(chat.id)
            .filter(message => !Boolean(message.key.fromMe))
            .slice(0, Math.max(previousUnreadCount, 1))
            .map(message => message.key)
        if (unreadKeys.length > 0) {
            await withTimeout(
                socket.readMessages(unreadKeys),
                DEFAULT_OPERATION_TIMEOUT_MS,
                `WhatsApp mark chat read timed out for ${chat.id}.`
            )
        }
        chat.unreadCount = 0
        return {
            status: 'marked_read',
            chatId: chat.id,
            chatName: chat.name,
            isGroup: chat.isGroup,
            previousUnreadCount,
        }
    }

    async markChatUnread(chatId: string): Promise<WhatsAppMarkChatResult> {
        const socket = await this.requireReadySocket()
        const chat = this.requireChat(chatId)
        const previousUnreadCount = chat.unreadCount
        const last = this.lastMessageForChat(chat.id)
        if (!last) {
            throw new Error(`Could not mark WhatsApp chat ${chat.id} unread: no recent message is available in the bounded Baileys store.`)
        }
        await withTimeout(
            socket.chatModify({ markRead: false, lastMessages: [minimalMessage(last)] }, chat.id),
            DEFAULT_OPERATION_TIMEOUT_MS,
            `WhatsApp mark chat unread timed out for ${chat.id}.`
        )
        chat.unreadCount = Math.max(chat.unreadCount, 1)
        return {
            status: 'marked_unread',
            chatId: chat.id,
            chatName: chat.name,
            isGroup: chat.isGroup,
            previousUnreadCount,
        }
    }

    async deleteMessageForEveryone(messageId: string): Promise<WhatsAppDeleteMessageResult> {
        const socket = await this.requireReadySocket()
        const normalized = messageId.trim()
        if (!normalized) throw new Error('WhatsApp message_id is required.')
        const stored = this.messagesById.get(normalized)
        const key = stored?.key ?? parseMessageId(normalized)
        if (!key?.remoteJid || !key.id) throw new Error(`Could not parse WhatsApp message ${normalized}.`)
        await withTimeout(
            socket.sendMessage(key.remoteJid, { delete: key }),
            DEFAULT_OPERATION_TIMEOUT_MS,
            `WhatsApp delete-for-everyone timed out for ${normalized}.`
        )
        return {
            status: 'deleted_for_everyone',
            messageId: normalized,
            chatId: key.remoteJid,
            deletedFor: 'everyone',
            clearMedia: true,
        }
    }

    async downloadMessageMedia(messageId: string): Promise<WhatsAppDownloadedMedia> {
        const socket = await this.requireReadySocket()
        const normalized = messageId.trim()
        if (!normalized) throw new Error('WhatsApp message_id is required.')
        const message = this.messagesById.get(normalized)
        if (!message) {
            throw new Error(`Could not find WhatsApp message ${normalized}. Baileys can download media only for messages held in the bounded local store; read the chat or wait for recent sync, then retry.`)
        }
        const baileys = await this.loadBaileys()
        const content = unwrapMessageContent(message.message)
        const mediaInfo = mediaInfoFromContent(content)
        if (!mediaInfo) throw new Error(`WhatsApp message ${normalized} has no media attachment to download.`)

        const buffer = await withTimeout(
            baileys.downloadMediaMessage(message, 'buffer', {}, {
                logger: nullLogger,
                reuploadRequest: socket.updateMediaMessage,
            }),
            MEDIA_DOWNLOAD_TIMEOUT_MS,
            `WhatsApp media download timed out for ${normalized}.`
        )
        if (!Buffer.isBuffer(buffer) || buffer.byteLength === 0) {
            throw new Error(`WhatsApp returned no media data for message ${normalized}.`)
        }

        return {
            messageId: normalized,
            chatId: message.key.remoteJid ?? null,
            type: mediaInfo.type,
            mimeType: mediaInfo.mimeType,
            filename: mediaInfo.filename,
            bytes: buffer,
        }
    }

    private async ensureStarted(): Promise<void> {
        if (this.socket && (this.state.phase === 'ready' || this.state.phase === 'starting' || this.state.phase === 'authenticated')) return
        if (this.connectPromise) return this.connectPromise
        this.connectPromise = this.connect().finally(() => {
            this.connectPromise = null
        })
        return this.connectPromise
    }

    private prepareInteractiveAuthStart(): void {
        if (this.socket || this.connectPromise || this.restartPromise) return
        const stored = hasStoredSession()
        const resumable = stored && hasResumableStoredSession()
        if (!stored && this.state.phase !== 'auth_failure') return
        if (resumable && this.state.phase !== 'auth_failure') return

        fs.rmSync(/* turbopackIgnore: true */ authBaseDir(), { recursive: true, force: true })
        this.saveCreds = null
        this.restartAttempts = 0
        this.state.phase = 'idle'
        this.state.accountName = null
        this.state.phoneNumber = null
        this.state.lastAuthenticatedAt = null
        this.state.lastReadyAt = null
        this.state.lastError = null
        this.state.lastSyncAt = Date.now()
        this.clearQr()
        this.clearStore()
    }

    private async connect(): Promise<void> {
        ensurePrivateDir(authBaseDir())
        const baileys = await this.loadBaileys()
        const auth = await baileys.useMultiFileAuthState(authBaseDir())
        this.saveCreds = auth.saveCreds
        this.state.phase = 'starting'
        this.state.lastError = null
        const waWebVersion = await this.resolveWaWebVersion(baileys)

        const socket = baileys.makeWASocket({
            ...(waWebVersion ? { version: waWebVersion } : {}),
            auth: auth.state,
            browser: baileys.Browsers.ubuntu('Orchestrator'),
            logger: nullLogger,
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            fireInitQueries: true,
            defaultQueryTimeoutMs: 45_000,
            shouldSyncHistoryMessage: ({ syncType }) => {
                const history = baileys.proto.HistorySync.HistorySyncType
                return syncType === history.RECENT || syncType === history.PUSH_NAME
            },
            getMessage: async key => this.findMessageByKey(key)?.message ?? undefined,
            cachedGroupMetadata: async () => undefined,
        })

        this.socket = socket
        socket.ev.on('creds.update', () => {
            void auth.saveCreds()
        })
        socket.ev.on('connection.update', update => {
            void this.handleConnectionUpdate(update, socket)
        })
        socket.ev.on('messaging-history.set', event => {
            this.applyHistory(event)
        })
        socket.ev.on('chats.upsert', chats => {
            this.applyChats(chats)
        })
        socket.ev.on('chats.update', updates => {
            this.applyChatUpdates(updates)
        })
        socket.ev.on('contacts.upsert', contacts => {
            this.applyContacts(contacts)
        })
        socket.ev.on('contacts.update', contacts => {
            this.applyContacts(contacts)
        })
        socket.ev.on('messages.upsert', event => {
            const countUnread = event.type === 'notify'
            for (const message of event.messages) this.upsertMessage(message, { countUnread })
        })
        socket.ev.on('messages.update', updates => {
            for (const update of updates) {
                const existing = this.findMessageByKey(update.key)
                if (existing) this.upsertMessage({ ...existing, ...update.update, key: existing.key }, { countUnread: false })
            }
        })
    }

    private async handleConnectionUpdate(update: Partial<BaileysEventMap['connection.update']>, sourceSocket?: WASocket): Promise<void> {
        if (sourceSocket && this.socket !== sourceSocket) return

        if (update.qr) await this.setQr(update.qr)
        if (update.connection === 'connecting') {
            if (this.state.phase !== 'qr') this.state.phase = 'starting'
            this.state.lastSyncAt = Date.now()
        }
        if (update.isNewLogin) {
            this.state.phase = 'authenticated'
            this.state.lastAuthenticatedAt = Date.now()
            this.clearQr()
        }
        if (update.connection === 'open') {
            this.state.phase = 'ready'
            this.state.lastError = null
            this.state.lastAuthenticatedAt = null
            this.state.lastReadyAt = Date.now()
            this.state.lastSyncAt = Date.now()
            this.restartAttempts = 0
            this.clearQr()
            this.captureAccountInfo()
            try {
                await this.socket?.sendPresenceUpdate('unavailable')
            } catch {
                // Presence is a best-effort courtesy so the phone keeps notifications.
            }
        }
        if (update.connection === 'close') {
            const statusCode = disconnectStatusCode(update.lastDisconnect?.error)
            if (!sourceSocket || this.socket === sourceSocket) this.socket = null
            this.state.lastSyncAt = Date.now()
            this.clearQr()

            if (statusCode === BAILEYS_RESTART_REQUIRED) {
                this.state.phase = 'starting'
                this.state.lastError = 'WhatsApp requested a socket restart after pairing.'
                this.scheduleRestartAfterPairing()
                return
            }

            if (statusCode && BAILEYS_UNAUTHORIZED.has(statusCode)) {
                this.state.phase = 'auth_failure'
                this.state.lastError = 'WhatsApp authentication was rejected. Disconnect and scan a new QR code.'
                return
            }

            this.state.phase = 'disconnected'
            this.state.lastError = disconnectReason(update.lastDisconnect?.error)
        }
    }

    private scheduleRestartAfterPairing() {
        if (this.restartPromise) return
        if (this.restartAttempts >= BAILEYS_MAX_RESTARTS) {
            this.state.phase = 'error'
            this.state.lastError = 'WhatsApp requested repeated socket restarts after pairing.'
            return
        }

        this.restartAttempts += 1
        this.restartPromise = sleep(750)
            .then(async () => {
                if (this.state.phase !== 'starting') return
                await this.ensureStarted()
            })
            .catch(err => {
                this.state.phase = 'error'
                this.state.lastError = err instanceof Error ? err.message : String(err)
                this.state.lastSyncAt = Date.now()
            })
            .finally(() => {
                this.restartPromise = null
            })
    }

    private applyHistory(event: BaileysEventMap['messaging-history.set']) {
        this.applyContacts(event.contacts)
        this.applyChats(event.chats)
        for (const message of event.messages) this.upsertMessage(message, { countUnread: false })
        this.state.lastSyncAt = Date.now()
    }

    private applyChats(chats: Array<Chat | Partial<Chat>>) {
        for (const chat of chats) {
            const id = chatIdFromRecord(chat)
            if (!id || isIgnoredJid(id)) continue
            const prev = this.chats.get(id)
            this.chats.set(id, {
                id,
                name: stringField(chat, ['name', 'subject']) ?? prev?.name ?? this.contactName(id),
                isGroup: id.endsWith('@g.us'),
                isReadOnly: Boolean(booleanField(chat, ['isReadOnly']) ?? prev?.isReadOnly ?? false),
                unreadCount: numberField(chat, ['unreadCount']) ?? prev?.unreadCount ?? 0,
                timestamp: timestampFromUnknown(
                    valueField(chat, ['conversationTimestamp', 'lastMessageRecvTimestamp', 'timestamp'])
                ) ?? prev?.timestamp ?? null,
                lastMessageId: prev?.lastMessageId ?? null,
            })
        }
        this.trimChats()
    }

    private applyChatUpdates(updates: Array<Partial<Chat>>) {
        this.applyChats(updates)
    }

    private applyContacts(contacts: Array<Contact | Partial<Contact>>) {
        for (const contact of contacts) {
            const id = stringField(contact, ['id', 'jid'])
            if (!id || isIgnoredJid(id)) continue
            const name = preferredBaileysName(contact)
            const prev = this.contacts.get(id)
            this.contacts.set(id, { id, name: name ?? prev?.name ?? null })
            const chat = this.chats.get(id)
            if (chat && !chat.name && name) chat.name = name
        }
    }

    private upsertMessage(message: WAMessage, options: { countUnread?: boolean } = {}) {
        const jid = message.key.remoteJid
        if (!jid || isIgnoredJid(jid) || !message.key.id) return
        const id = serializeMessageId(message.key)
        const wasStored = this.messagesById.has(id)
        this.messagesById.set(id, message)

        const existing = this.messagesByChat.get(jid) ?? []
        const deduped = [message, ...existing.filter(item => serializeMessageId(item.key) !== id)]
            .sort((a, b) => timestampOfMessage(b) - timestampOfMessage(a))
        const next = deduped.slice(0, STORE_MESSAGES_PER_CHAT)
        for (const removed of deduped.slice(STORE_MESSAGES_PER_CHAT)) {
            this.messagesById.delete(serializeMessageId(removed.key))
        }
        this.messagesByChat.set(jid, next)

        const chat = this.ensureChatForJid(jid, message)
        const messageTimestamp = timestampOfMessage(message) || 0
        const previousTimestamp = chat.timestamp ?? 0
        if (!chat.lastMessageId || messageTimestamp >= previousTimestamp) chat.lastMessageId = id
        chat.timestamp = Math.max(previousTimestamp, messageTimestamp) || chat.timestamp
        if (options.countUnread !== false && !wasStored && !message.key.fromMe && this.state.phase === 'ready') {
            chat.unreadCount = Math.min(999, Math.max(0, chat.unreadCount) + 1)
        }
    }

    private clearStore() {
        this.chats.clear()
        this.contacts.clear()
        this.messagesByChat.clear()
        this.messagesById.clear()
    }

    private captureAccountInfo() {
        const me = this.socket?.authState?.creds?.me
        this.state.accountName = me?.name ?? this.state.accountName
        this.state.phoneNumber = jidPhone(me?.id) ?? this.state.phoneNumber
    }

    private async requireReadySocket(): Promise<WASocket> {
        await this.ensureStarted()
        await this.waitForReady()
        if (this.socket && this.state.phase === 'ready') return this.socket
        throw new Error('WhatsApp is not connected. Use WhatsAppConnect and scan the QR code first.')
    }

    private async waitForQrOrReady(timeoutMs = 30_000): Promise<void> {
        const startedAt = Date.now()
        while (Date.now() - startedAt < timeoutMs) {
            if (this.state.phase === 'qr' || this.state.phase === 'ready') return
            if (this.state.phase === 'error' || this.state.phase === 'auth_failure' || this.state.phase === 'disconnected') return
            await sleep(250)
        }
    }

    private async waitForReady(timeoutMs = READY_WAIT_TIMEOUT_MS): Promise<void> {
        const startedAt = Date.now()
        while (Date.now() - startedAt < timeoutMs) {
            if (this.state.phase === 'ready') return
            if (this.state.phase === 'qr' || this.state.phase === 'error' || this.state.phase === 'auth_failure' || this.state.phase === 'disconnected') return
            await sleep(250)
        }
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

    private async status(origin?: string): Promise<WhatsAppIntegrationStatus> {
        const qrUpdatedAt = this.state.qrUpdatedAt
        const connected = Boolean(this.socket && this.state.phase === 'ready')
        const sessionStored = hasStoredSession()
        const resumableSessionStored = hasResumableStoredSession()
        const canResumeStoredSession =
            resumableSessionStored &&
            (this.state.phase === 'idle' || this.state.phase === 'disconnected')
        const qrImageUrl = origin && this.state.qrText
            ? `${origin}/api/integrations/whatsapp/qr?ts=${qrUpdatedAt ?? Date.now()}`
            : null

        return {
            id: 'whatsapp',
            name: 'WhatsApp',
            description: 'Local WhatsApp companion session using Baileys. Read tools use a bounded recent-message store; sending media/messages and deleting messages for everyone require explicit confirmation.',
            configured: true,
            connected,
            accountName: this.state.accountName,
            phoneNumber: this.state.phoneNumber,
            phase: this.state.phase,
            sessionStored,
            qrAvailable: Boolean(this.state.qrText),
            qrDataUrl: this.state.qrDataUrl,
            qrImageUrl,
            qrUpdatedAt,
            qrExpiresAt: qrUpdatedAt ? qrUpdatedAt + QR_TTL_MS : null,
            lastReadyAt: this.state.lastReadyAt,
            lastSyncAt: this.state.lastSyncAt,
            lastError: this.state.lastError,
            browserExecutablePath: null,
            missingConfig: [],
            needsReconnect: !connected && !canResumeStoredSession,
            provider: 'baileys',
            capabilities: ['status', 'qr_login', 'list_chats', 'unread_summary', 'read_chat', 'search_recent_messages', 'find_messages', 'send_message', 'send_media', 'delete_message_for_everyone', 'mark_chat_read', 'mark_chat_unread'],
        }
    }

    private sortedChats(): StoredChat[] {
        return [...this.chats.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    }

    private messagesForChat(chatId: string): WAMessage[] {
        return this.messagesByChat.get(normalizeBaileysChatId(chatId)) ?? []
    }

    private lastMessageForChat(chatId: string): WAMessage | null {
        return this.messagesForChat(chatId)
            .slice()
            .sort((a, b) => timestampOfMessage(b) - timestampOfMessage(a))[0] ?? null
    }

    private requireChat(chatId: string): StoredChat {
        const normalized = normalizeBaileysChatId(chatId)
        const chat = this.chats.get(normalized)
        if (!chat) throw new Error(`Could not read WhatsApp chat ${normalized}: it is not in the recent Baileys store yet.`)
        return chat
    }

    private ensureChatForJid(jid: string, message?: WAMessage): StoredChat {
        const normalized = normalizeBaileysChatId(jid)
        const existing = this.chats.get(normalized)
        if (existing) return existing
        const chat: StoredChat = {
            id: normalized,
            name: this.contactName(normalized),
            isGroup: normalized.endsWith('@g.us'),
            isReadOnly: false,
            unreadCount: 0,
            timestamp: message ? timestampOfMessage(message) : null,
            lastMessageId: message ? serializeMessageId(message.key) : null,
        }
        this.chats.set(normalized, chat)
        this.trimChats()
        return chat
    }

    private chatSummary(chat: StoredChat): WhatsAppChatSummary {
        const last = chat.lastMessageId ? this.messagesById.get(chat.lastMessageId) : this.lastMessageForChat(chat.id)
        return {
            id: chat.id,
            name: chat.name || jidDisplay(chat.id),
            isGroup: chat.isGroup,
            isReadOnly: chat.isReadOnly,
            unreadCount: chat.unreadCount,
            timestamp: chat.timestamp,
            lastMessage: last ? this.messageSummary(last, chat) : null,
        }
    }

    private unreadChatSummary(chat: StoredChat): WhatsAppUnreadChatSummary {
        return {
            id: chat.id,
            name: chat.name || jidDisplay(chat.id),
            isGroup: chat.isGroup,
            unreadCount: chat.unreadCount,
            timestamp: chat.timestamp,
        }
    }

    private messageSummary(message: WAMessage, chat?: StoredChat): WhatsAppMessageSummary {
        const content = unwrapMessageContent(message.message)
        const info = messageInfoFromContent(content)
        const timestamp = timestampOfMessage(message) || null
        const chatId = message.key.remoteJid ?? chat?.id ?? ''
        const fromMe = Boolean(message.key.fromMe)
        const from = fromMe ? this.selfJid() : message.key.participant ?? chatId
        const to = fromMe ? chatId : this.selfJid()
        const author = message.key.participant ?? null
        return {
            id: serializeMessageId(message.key),
            chatId,
            chatName: chat?.name || undefined,
            from,
            to,
            author,
            authorName: author ? this.contactName(author) : null,
            fromMe,
            type: info.type,
            body: clip(info.body, 8_000),
            timestamp,
            date: timestamp ? new Date(timestamp * 1000).toISOString() : null,
            hasMedia: info.hasMedia,
            isForwarded: info.isForwarded,
            forwardingScore: info.forwardingScore,
        }
    }

    private contactName(jid: string): string | null {
        return this.contacts.get(jid)?.name ?? null
    }

    private selfJid(): string {
        return this.socket?.authState?.creds?.me?.id ?? ''
    }

    private findMessageByKey(key: WAMessageKey): WAMessage | undefined {
        return this.messagesById.get(serializeMessageId(key))
    }

    private trimChats() {
        if (this.chats.size <= STORE_MAX_CHATS) return
        const keep = new Set(this.sortedChats().slice(0, STORE_MAX_CHATS).map(chat => chat.id))
        for (const id of this.chats.keys()) {
            if (keep.has(id)) continue
            this.chats.delete(id)
            const messages = this.messagesByChat.get(id) ?? []
            for (const message of messages) this.messagesById.delete(serializeMessageId(message.key))
            this.messagesByChat.delete(id)
        }
    }

    private async loadBaileys(): Promise<BaileysModule> {
        if (!this.baileys) this.baileys = await import('baileys')
        return this.baileys
    }

    private async resolveWaWebVersion(baileys: BaileysModule): Promise<WAVersion | undefined> {
        try {
            const result = await withTimeout(
                baileys.fetchLatestWaWebVersion(),
                WA_WEB_VERSION_TIMEOUT_MS,
                'WhatsApp Web version lookup timed out.'
            )
            if (result.error || !isWaVersion(result.version)) return undefined
            return result.version
        } catch {
            return undefined
        }
    }
}

function isWaVersion(value: unknown): value is WAVersion {
    return Array.isArray(value)
        && value.length === 3
        && value.every(part => Number.isInteger(part) && part >= 0)
}

function authBaseDir(): string {
    return path.join(/* turbopackIgnore: true */ activeRuntimePaths().privateStateDir, 'whatsapp-baileys')
}

function hasStoredSession(): boolean {
    try {
        return fs.existsSync(/* turbopackIgnore: true */ baileysCredsPath())
    } catch {
        return false
    }
}

function hasResumableStoredSession(): boolean {
    try {
        const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ baileysCredsPath(), 'utf-8')) as {
            me?: { id?: unknown }
        }
        return typeof parsed.me?.id === 'string' && parsed.me.id.trim().length > 0
    } catch {
        return false
    }
}

function baileysCredsPath(): string {
    return path.join(/* turbopackIgnore: true */ authBaseDir(), 'creds.json')
}

function ensurePrivateDir(dir: string) {
    if (!fs.existsSync(/* turbopackIgnore: true */ dir)) fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true })
    try {
        fs.chmodSync(/* turbopackIgnore: true */ dir, 0o700)
    } catch {
        // Some filesystems ignore chmod; the directory remains in private app state.
    }
}

function normalizeBaileysChatId(value: string): string {
    const normalized = normalizeChatId(value)
    if (normalized.endsWith('@c.us')) return `${normalized.slice(0, -5)}@s.whatsapp.net`
    return normalized
}

function serializeMessageId(key: WAMessageKey): string {
    const remoteJid = key.remoteJid ?? ''
    const id = key.id ?? ''
    const participant = key.participant ?? ''
    const fromMe = key.fromMe ? '1' : '0'
    return `baileys:${encodeURIComponent(remoteJid)}:${fromMe}:${encodeURIComponent(id)}:${encodeURIComponent(participant)}`
}

function parseMessageId(value: string): ParsedMessageId | null {
    if (!value.startsWith('baileys:')) return null
    const parts = value.split(':')
    if (parts.length < 4) return null
    try {
        return {
            remoteJid: decodeURIComponent(parts[1]),
            fromMe: parts[2] === '1',
            id: decodeURIComponent(parts[3]),
            participant: parts[4] ? decodeURIComponent(parts[4]) : undefined,
        }
    } catch {
        return null
    }
}

function chatIdFromRecord(chat: Partial<Chat>): string | null {
    return stringField(chat, ['id', 'jid'])
}

function valueField(record: unknown, fields: string[]): unknown {
    if (!record || typeof record !== 'object') return undefined
    const obj = record as Record<string, unknown>
    for (const field of fields) {
        if (obj[field] !== undefined && obj[field] !== null) return obj[field]
    }
    return undefined
}

function stringField(record: unknown, fields: string[]): string | null {
    const value = valueField(record, fields)
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberField(record: unknown, fields: string[]): number | null {
    const value = valueField(record, fields)
    const n = Number(value)
    return Number.isFinite(n) ? n : null
}

function booleanField(record: unknown, fields: string[]): boolean | null {
    const value = valueField(record, fields)
    return typeof value === 'boolean' ? value : null
}

function timestampFromUnknown(value: unknown): number | null {
    if (value == null) return null
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? toUnixSeconds(value) : null
    if (typeof value === 'string') {
        const n = Number(value)
        return Number.isFinite(n) && n > 0 ? toUnixSeconds(n) : null
    }
    if (typeof value === 'object') {
        const record = value as { toNumber?: () => number; low?: number; high?: number; unsigned?: boolean }
        if (typeof record.toNumber === 'function') {
            const n = record.toNumber()
            return Number.isFinite(n) && n > 0 ? toUnixSeconds(n) : null
        }
        if (typeof record.low === 'number') return toUnixSeconds(record.low)
    }
    return null
}

function toUnixSeconds(value: number): number {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value)
}

function timestampOfMessage(message: WAMessage): number {
    return timestampFromUnknown(message.messageTimestamp) ?? 0
}

function unwrapMessageContent(content: WAMessageContent | null | undefined): WAMessageContent | undefined {
    let current = content
    for (let i = 0; i < 4; i += 1) {
        if (!current) return undefined
        const nested = current.ephemeralMessage?.message
            ?? current.viewOnceMessage?.message
            ?? current.viewOnceMessageV2?.message
            ?? current.documentWithCaptionMessage?.message
        if (!nested) return current
        current = nested
    }
    return current ?? undefined
}

function messageInfoFromContent(content: WAMessageContent | undefined): {
    type: string
    body: string
    hasMedia: boolean
    isForwarded: boolean
    forwardingScore: number
} {
    if (!content) return { type: 'unknown', body: '', hasMedia: false, isForwarded: false, forwardingScore: 0 }
    const typed = content as Record<string, unknown>
    const type = normalizeContentType(Object.keys(typed).find(key => typed[key] != null) ?? 'unknown')
    const body = extractBody(content)
    const context = contextInfo(content)
    const forwardingScore = Number(context?.forwardingScore)
    return {
        type,
        body,
        hasMedia: ['audio', 'image', 'video', 'document', 'sticker'].includes(type),
        isForwarded: Boolean(context?.isForwarded) || (Number.isFinite(forwardingScore) && forwardingScore > 0),
        forwardingScore: Number.isFinite(forwardingScore) ? forwardingScore : 0,
    }
}

function mediaInfoFromContent(content: WAMessageContent | undefined): { type: string; mimeType: string; filename: string | null } | null {
    if (!content) return null
    for (const [field, type] of [
        ['imageMessage', 'image'],
        ['videoMessage', 'video'],
        ['audioMessage', 'audio'],
        ['documentMessage', 'document'],
        ['stickerMessage', 'sticker'],
    ] as const) {
        const media = (content as Record<string, unknown>)[field]
        if (!media || typeof media !== 'object') continue
        const record = media as Record<string, unknown>
        return {
            type,
            mimeType: typeof record.mimetype === 'string' && record.mimetype.trim() ? record.mimetype.trim() : 'application/octet-stream',
            filename: typeof record.fileName === 'string' && record.fileName.trim() ? record.fileName.trim() : null,
        }
    }
    return null
}

function extractBody(content: WAMessageContent): string {
    if (typeof content.conversation === 'string') return content.conversation
    const extendedText = content.extendedTextMessage?.text
    if (typeof extendedText === 'string') return extendedText
    for (const item of [
        content.imageMessage,
        content.videoMessage,
        content.documentMessage,
    ]) {
        if (typeof item?.caption === 'string') return item.caption
    }
    if (typeof content.buttonsResponseMessage?.selectedDisplayText === 'string') return content.buttonsResponseMessage.selectedDisplayText
    if (typeof content.listResponseMessage?.title === 'string') return content.listResponseMessage.title
    return ''
}

function contextInfo(content: WAMessageContent): { isForwarded?: boolean | null; forwardingScore?: number | null } | undefined {
    return content.extendedTextMessage?.contextInfo
        ?? content.imageMessage?.contextInfo
        ?? content.videoMessage?.contextInfo
        ?? content.documentMessage?.contextInfo
        ?? content.audioMessage?.contextInfo
        ?? content.stickerMessage?.contextInfo
        ?? undefined
}

function normalizeContentType(type: string): string {
    switch (type) {
        case 'conversation':
        case 'extendedTextMessage':
            return 'chat'
        case 'imageMessage':
            return 'image'
        case 'videoMessage':
            return 'video'
        case 'audioMessage':
            return 'audio'
        case 'documentMessage':
            return 'document'
        case 'stickerMessage':
            return 'sticker'
        default:
            return normalizeMessageType(type.replace(/Message$/, ''))
    }
}

function normalizeMessageTypes(values: string[]): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const value of values) {
        const normalized = normalizeMessageType(value)
        if (!seen.has(normalized)) {
            seen.add(normalized)
            out.push(normalized)
        }
    }
    return out
}

function normalizeMessageType(value: string): string {
    const raw = value.trim().toLowerCase()
    switch (raw) {
        case 'ptt':
        case 'voice':
        case 'voicenote':
        case 'voice_note':
            return 'audio'
        case 'photo':
            return 'image'
        case 'file':
            return 'document'
        case 'text':
        case 'conversation':
        case 'extendedtext':
            return 'chat'
        default:
            return raw || 'unknown'
    }
}

function parseFindDateFilter(value: string | undefined, name: string): FindDateFilter | null {
    const raw = value?.trim()
    if (!raw) return null
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { raw, localDate: raw, instantSeconds: null }
    const parsed = Date.parse(raw)
    if (!Number.isFinite(parsed)) throw new Error(`${name} must be YYYY-MM-DD or an ISO date-time with timezone/offset.`)
    return { raw, localDate: null, instantSeconds: Math.floor(parsed / 1000) }
}

function matchesDate(timestamp: number, dateFrom: FindDateFilter | null, dateTo: FindDateFilter | null, timeZone: string): boolean {
    if (!timestamp) return !(dateFrom || dateTo)
    if (dateFrom?.instantSeconds !== null && dateFrom?.instantSeconds !== undefined && timestamp < dateFrom.instantSeconds) return false
    if (dateTo?.instantSeconds !== null && dateTo?.instantSeconds !== undefined && timestamp > dateTo.instantSeconds) return false
    if (dateFrom?.localDate || dateTo?.localDate) {
        const localDate = localDateFor(timestamp, timeZone)
        if (!localDate) return false
        if (dateFrom?.localDate && localDate < dateFrom.localDate) return false
        if (dateTo?.localDate && localDate > dateTo.localDate) return false
    }
    return true
}

function localDateFor(timestamp: number, timeZone: string): string | null {
    try {
        return new Intl.DateTimeFormat('sv-SE', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(new Date(timestamp * 1000))
    } catch {
        return new Date(timestamp * 1000).toISOString().slice(0, 10)
    }
}

function baileysMediaContent(attachment: WhatsAppOutgoingAttachment, caption: string): AnyMessageContent {
    if (attachment.sendAsDocument) {
        return {
            document: attachment.bytes,
            mimetype: attachment.mimeType,
            fileName: attachment.filename,
            caption: caption || undefined,
        }
    }
    if (attachment.mimeType.startsWith('image/')) {
        return { image: attachment.bytes, mimetype: attachment.mimeType, caption: caption || undefined }
    }
    if (attachment.mimeType.startsWith('video/')) {
        return { video: attachment.bytes, mimetype: attachment.mimeType, caption: caption || undefined }
    }
    if (attachment.mimeType.startsWith('audio/')) {
        return { audio: attachment.bytes, mimetype: attachment.mimeType }
    }
    return {
        document: attachment.bytes,
        mimetype: attachment.mimeType,
        fileName: attachment.filename,
        caption: caption || undefined,
    }
}

function minimalMessage(message: WAMessage): MinimalMessage {
    return {
        key: message.key,
        messageTimestamp: message.messageTimestamp,
    }
}

function preferredBaileysName(record: unknown): string | null {
    for (const field of ['name', 'notify', 'verifiedName', 'pushName', 'subject']) {
        const value = stringField(record, [field])
        if (value) return value
    }
    return null
}

function jidDisplay(jid: string): string {
    return jidPhone(jid) ?? jid
}

function jidPhone(jid: string | undefined): string | null {
    if (!jid) return null
    const digits = jid.split('@')[0].replace(/[^\d]/g, '')
    return digits ? `+${digits}` : null
}

function isIgnoredJid(jid: string): boolean {
    return jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')
}

function clip(value: string, maxChars: number): string {
    return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min
    return Math.max(min, Math.min(max, value))
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

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function disconnectStatusCode(err: unknown): number | null {
    if (!err) return null
    const statusCode = typeof err === 'object' && err
        ? (err as { output?: { statusCode?: number }; statusCode?: number }).output?.statusCode
        ?? (err as { statusCode?: number }).statusCode
        : null
    return typeof statusCode === 'number' ? statusCode : null
}

function disconnectReason(err: unknown): string | null {
    if (!err) return null
    if (err instanceof Error) return err.message
    const statusCode = disconnectStatusCode(err)
    return statusCode ? `WhatsApp connection closed with status ${statusCode}.` : String(err)
}
