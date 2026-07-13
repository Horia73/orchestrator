/**
 * WhatsApp Smart Monitor metadata coverage. Exercises the real source adapter
 * and its pre-wake revalidation with text, media, technical, and unknown types.
 */
import { EMPTY_WATCH_STATE, type MonitorRule, type MonitorWatch, type WatchState } from '@/lib/monitor/schema'
import { evaluateRule, type WhatsAppCandidate } from '@/lib/monitor/rules'
import type {
    WhatsAppChatSummary,
    WhatsAppIntegrationStatus,
    WhatsAppMessageSummary,
    WhatsAppReadChatResult,
} from '@/lib/integrations/whatsapp'
import {
    __resetWhatsAppToolGuardForTests,
    __setWhatsAppToolGuardTestClock,
} from '@/lib/integrations/whatsapp-tool-guard'

process.env.WHATSAPP_PROVIDER = 'baileys'
const NOW = 1_900_000_000_000
let clock = 50_000
__resetWhatsAppToolGuardForTests()
__setWhatsAppToolGuardTestClock({
    now: () => clock,
    sleep: async (ms) => { clock += ms },
})

let failures = 0
function check(label: string, condition: unknown, detail?: unknown) {
    const ok = Boolean(condition)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (${JSON.stringify(detail)})`}`)
    if (!ok) failures += 1
}

const chat: WhatsAppChatSummary = {
    id: 'technical-events@s.whatsapp.net',
    name: 'Protocol test',
    isGroup: false,
    isReadOnly: false,
    unreadCount: 4,
    timestamp: Math.floor(NOW / 1000),
    lastMessage: null,
}

function message(id: string, type: string, body: string, hasMedia: boolean, offsetMs: number): WhatsAppMessageSummary {
    return {
        id,
        chatId: chat.id,
        chatName: chat.name,
        from: chat.id,
        to: 'me@s.whatsapp.net',
        author: null,
        authorName: null,
        fromMe: false,
        type,
        body,
        timestamp: Math.floor((NOW + offsetMs) / 1000),
        date: new Date(NOW + offsetMs).toISOString(),
        hasMedia,
        isForwarded: false,
        forwardingScore: 0,
    }
}

const technical = message('technical-empty', 'senderkeydistribution', '', false, 1_000)
const text = message('normal-text', 'chat', 'hello', false, 2_000)
const media = message('normal-media', 'image', '', true, 3_000)
const unknown = message('unknown-empty', 'future-provider-message', '', false, 4_000)
let readResult: WhatsAppReadChatResult = { chat, messages: [technical, text, media, unknown], truncated: false }

const status: WhatsAppIntegrationStatus = {
    id: 'whatsapp', name: 'WhatsApp', description: 'fake', provider: 'baileys',
    configured: true, connected: true, accountName: null, phoneNumber: null,
    phase: 'ready', sessionStored: true, qrAvailable: false, qrDataUrl: null,
    qrImageUrl: null, qrUpdatedAt: null, qrExpiresAt: null, lastReadyAt: NOW,
    lastSyncAt: NOW, lastError: null, browserExecutablePath: null,
    missingConfig: [], needsReconnect: false, capabilities: ['list_chats', 'read_chat'],
}

globalThis.__orchestratorWhatsAppManagers = {
    'admin_horia:baileys': {
        async getStatus() { return status },
        async start() { throw new Error('not used') },
        async disconnect() {},
        async getQrPng() { return null },
        async listChats() { return { chats: [chat] } },
        async unreadSummary() { throw new Error('not used') },
        async readChat() { return readResult },
        async searchMessages() { throw new Error('not used') },
        async findMessages() { throw new Error('not used') },
        async sendMessage() { throw new Error('not used') },
        async sendMedia() { throw new Error('not used') },
        async markChatRead() { throw new Error('not used') },
        async markChatUnread() { throw new Error('not used') },
        async deleteMessageForEveryone() { throw new Error('not used') },
        async downloadMessageMedia() { throw new Error('not used') },
    },
}

const { whatsappSourceAdapter } = await import('@/lib/monitor/sources/whatsapp')

function state(): WatchState {
    return {
        ...EMPTY_WATCH_STATE,
        extra: {
            whatsapp: {
                primed: true,
                nextCheckAfter: NOW - 1,
                quietStreak: 0,
                chats: { [chat.id]: { lastSeenAt: NOW - 60_000, lastSeenIds: [] } },
            },
        },
    }
}

function watch(rule: MonitorRule): MonitorWatch {
    return {
        id: 'wa_technical_metadata', title: 'WhatsApp protocol noise', source: 'whatsapp',
        target: 'all incoming', rule, allowedActions: [],
        cadence: { current: 900, min: 900, max: 43_200, adaptive: true },
        notify: { onMatch: true }, followUp: null, enabled: true, state: state(),
        suppressPatterns: [], lastCheckedAt: null, nextCheckAt: null, lastFiredAt: null,
        consecutiveErrors: 0, lastError: null, createdBy: 'system', createdAt: NOW, updatedAt: NOW,
    }
}

const result = await whatsappSourceAdapter.cheapCheck({ watch: watch({ kind: 'wa_unread' }), now: NOW + 10_000, timeoutMs: 10_000 })
check('adapter reads all four incoming events under wa_unread', result.ok && result.matches.length === 4, result)
const candidates = result.matches.map((match) => match.candidate).filter((candidate): candidate is WhatsAppCandidate => candidate.source === 'whatsapp')
check('adapter exposes type/text/media metadata on candidates',
    candidates.some((candidate) => candidate.id === technical.id && candidate.messageType === 'senderkeydistribution' && !candidate.hasText && !candidate.hasMedia)
        && candidates.some((candidate) => candidate.id === text.id && candidate.messageType === 'chat' && candidate.hasText && !candidate.hasMedia)
        && candidates.some((candidate) => candidate.id === media.id && candidate.messageType === 'image' && !candidate.hasText && candidate.hasMedia)
        && candidates.some((candidate) => candidate.id === unknown.id && candidate.messageType === 'future-provider-message'),
    candidates,
)
check('adapter details expose type/text/media metadata', result.matches.every((match) => {
    const details = match.details ?? {}
    return typeof details.messageType === 'string' && typeof details.hasText === 'boolean' && typeof details.hasMedia === 'boolean'
}), result.matches.map((match) => match.details))

const emptyTechnicalRule: MonitorRule = {
    kind: 'all_of',
    rules: [
        { kind: 'wa_message_type', types: ['senderkeydistribution'] },
        { kind: 'wa_has_text', value: false },
        { kind: 'wa_has_media', value: false },
    ],
}
const suppressed = candidates.filter((candidate) => evaluateRule(emptyTechnicalRule, candidate))
check('pre-wake suppress predicate selects only the empty technical event', suppressed.length === 1 && suppressed[0].id === technical.id, suppressed)
check('text, media, and unknown candidates remain eligible', candidates.filter((candidate) => !evaluateRule(emptyTechnicalRule, candidate)).length === 3)

const pending = {
    watchId: 'wa_technical_metadata', watchTitle: 'WhatsApp protocol noise', source: 'whatsapp',
    summary: 'technical', externalId: technical.id, ts: NOW,
    details: { chatId: chat.id, messageType: technical.type, hasText: false, hasMedia: false },
}
const revalidated = await whatsappSourceAdapter.revalidatePending!({
    watch: watch(emptyTechnicalRule), pending, now: NOW + 20_000, timeoutMs: 10_000,
})
check('revalidation rebuilds metadata and keeps exact technical match active',
    revalidated.active === true
        && revalidated.details?.messageType === 'senderkeydistribution'
        && revalidated.details?.hasText === false
        && revalidated.details?.hasMedia === false,
    revalidated,
)

readResult = { ...readResult, messages: [{ ...technical, type: 'future-provider-message' }] }
const changedType = await whatsappSourceAdapter.revalidatePending!({
    watch: watch(emptyTechnicalRule), pending, now: NOW + 30_000, timeoutMs: 10_000,
})
check('revalidation drops pending event when its type no longer explicitly matches', changedType.active === false, changedType)

if (failures > 0) {
    console.error(`\n${failures} WhatsApp technical-event smoke check(s) failed.`)
    process.exit(1)
}
console.log('\nWhatsApp technical-event smoke checks passed.')
