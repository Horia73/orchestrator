/**
 * Smoke test for WhatsApp Smart Monitor load-shaping.
 *
 * Pure in-process harness: it injects a fake WhatsApp runtime into the global
 * manager registry and verifies the adapter does not read on every heartbeat.
 */

import { EMPTY_WATCH_STATE, type MonitorWatch, type WatchState } from '@/lib/monitor/schema'
import type {
    WhatsAppChatSummary,
    WhatsAppIntegrationStatus,
    WhatsAppReadChatResult,
} from '@/lib/integrations/whatsapp'
import {
    __resetWhatsAppToolGuardForTests,
    __setWhatsAppToolGuardTestClock,
} from '@/lib/integrations/whatsapp-tool-guard'

process.env.WHATSAPP_PROVIDER = 'baileys'

const NOW = 1_900_000_000_000
let guardNow = 10_000
const guardWaits: number[] = []
__resetWhatsAppToolGuardForTests()
__setWhatsAppToolGuardTestClock({
    now: () => guardNow,
    sleep: async ms => {
        guardWaits.push(ms)
        guardNow += ms
    },
})
const chat: WhatsAppChatSummary = {
    id: '40123456789@s.whatsapp.net',
    name: 'Mom',
    isGroup: false,
    isReadOnly: false,
    unreadCount: 1,
    timestamp: NOW,
    lastMessage: null,
}

let failures = 0
let listCalls: number[] = []
let readCalls: Array<{ chatId: string; maxMessages: number; maxChars: number }> = []
let chatsToReturn: WhatsAppChatSummary[] = [chat]
let listError: Error | null = null

function check(label: string, condition: unknown, detail?: unknown) {
    const ok = Boolean(condition)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (${JSON.stringify(detail)})`}`)
    if (!ok) failures += 1
}

function resetCalls() {
    listCalls = []
    readCalls = []
}

function waExtra(result: { stateUpdate: { extra?: unknown } }): Record<string, unknown> {
    const extra = result.stateUpdate.extra as Record<string, unknown> | undefined
    return (extra?.whatsapp ?? {}) as Record<string, unknown>
}

const fakeStatus: WhatsAppIntegrationStatus = {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'fake',
    provider: 'baileys',
    configured: true,
    connected: true,
    accountName: null,
    phoneNumber: null,
    phase: 'ready',
    sessionStored: true,
    qrAvailable: false,
    qrDataUrl: null,
    qrImageUrl: null,
    qrUpdatedAt: null,
    qrExpiresAt: null,
    lastReadyAt: NOW,
    lastSyncAt: NOW,
    lastError: null,
    browserExecutablePath: null,
    missingConfig: [],
    needsReconnect: false,
    capabilities: ['status', 'list_chats', 'read_chat'],
}

const fakeRead: WhatsAppReadChatResult = {
    chat,
    messages: [],
    truncated: false,
}

globalThis.__orchestratorWhatsAppManagers = {
    'admin_horia:baileys': {
        async getStatus() { return fakeStatus },
        async start() { throw new Error('not used') },
        async disconnect() { },
        async getQrPng() { return null },
        async listChats(maxResults: number) {
            listCalls.push(maxResults)
            if (listError) throw listError
            return { chats: chatsToReturn }
        },
        async unreadSummary() { throw new Error('not used') },
        async readChat(chatId: string, maxMessages: number, maxChars: number) {
            readCalls.push({ chatId, maxMessages, maxChars })
            return fakeRead
        },
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

function state(patch: Partial<WatchState>): WatchState {
    return {
        ...EMPTY_WATCH_STATE,
        ...patch,
        extra: patch.extra ?? EMPTY_WATCH_STATE.extra,
    }
}

function watch(watchState: WatchState): MonitorWatch {
    return {
        id: 'wa_watch_load_shape',
        title: 'WhatsApp VIP',
        source: 'whatsapp',
        target: 'Mom',
        rule: { kind: 'wa_unread' },
        cadence: { current: 900, min: 900, max: 43_200, adaptive: true },
        notify: { onMatch: true },
        allowedActions: [],
        suppressPatterns: [],
        followUp: null,
        enabled: true,
        createdBy: 'user',
        createdAt: NOW,
        updatedAt: NOW,
        lastCheckedAt: null,
        nextCheckAt: null,
        lastFiredAt: null,
        lastError: null,
        consecutiveErrors: 0,
        state: watchState,
    }
}

const prime = await whatsappSourceAdapter.cheapCheck({
    watch: watch(state({})),
    now: NOW,
    timeoutMs: 10_000,
})
const primeExtra = waExtra(prime)
check('priming succeeds', prime.ok === true, prime)
check('priming lists chats once', listCalls.length === 1, listCalls)
check('priming does not read unread backlog', readCalls.length === 0, readCalls)
check('priming stores next jittered window', typeof primeExtra.nextCheckAfter === 'number' && primeExtra.nextCheckAfter > NOW, primeExtra)
check('priming starts quiet streak', primeExtra.quietStreak === 1, primeExtra)
check('chat list cap is bounded and variable-range', listCalls[0] >= 18 && listCalls[0] <= 30, listCalls)

resetCalls()
const beforeWindow = await whatsappSourceAdapter.cheapCheck({
    watch: watch(state({ lastFetchedAt: NOW, extra: prime.stateUpdate.extra as Record<string, unknown> })),
    now: NOW + 60_000,
    timeoutMs: 10_000,
})
check('heartbeat before next window is a no-op success', beforeWindow.ok === true, beforeWindow)
check('heartbeat before next window does not list chats', listCalls.length === 0, listCalls)
check('heartbeat before next window does not read chats', readCalls.length === 0, readCalls)

resetCalls()
chatsToReturn = []
const quiet = await whatsappSourceAdapter.cheapCheck({
    watch: watch(state({ lastFetchedAt: NOW, extra: prime.stateUpdate.extra as Record<string, unknown> })),
    now: Number(primeExtra.nextCheckAfter) + 1,
    timeoutMs: 10_000,
})
const quietExtra = waExtra(quiet)
check('due quiet window lists chats again', listCalls.length === 1, listCalls)
check('quiet window still does not read without unread chats', readCalls.length === 0, readCalls)
check('due monitor list is paced through the WhatsApp guard', guardWaits.length >= 1 && guardWaits[0] >= 450 && guardWaits[0] <= 700, guardWaits)
check('quiet window increases quiet streak', quietExtra.quietStreak === 2, quietExtra)
check('quiet window schedules a later jittered check', Number(quietExtra.nextCheckAfter) > Number(primeExtra.nextCheckAfter), quietExtra)

resetCalls()
listError = new Error('stored WhatsApp session could not resume')
const listFailure = await whatsappSourceAdapter.cheapCheck({
    watch: watch(state({
        lastFetchedAt: NOW,
        extra: {
            whatsapp: {
                primed: true,
                quietStreak: 2,
                chats: { [chat.id]: { lastSeenAt: NOW - 60_000, lastSeenIds: [] } },
            },
        },
    })),
    now: NOW + 180_000,
    timeoutMs: 10_000,
})
const listFailureExtra = waExtra(listFailure)
check('list failure reports not ok', listFailure.ok === false, listFailure)
check('list failure schedules error backoff', Number(listFailureExtra.nextCheckAfter) > NOW + 180_000, listFailureExtra)
check('list failure increments quiet streak', listFailureExtra.quietStreak === 3, listFailureExtra)

resetCalls()
listError = null
const afterListFailure = await whatsappSourceAdapter.cheapCheck({
    watch: watch(state({ lastFetchedAt: NOW + 180_000, extra: listFailure.stateUpdate.extra as Record<string, unknown> })),
    now: NOW + 181_000,
    timeoutMs: 10_000,
})
check('heartbeat after list failure before backoff is no-op', afterListFailure.ok === true, afterListFailure)
check('heartbeat after list failure does not list chats', listCalls.length === 0, listCalls)

resetCalls()
chatsToReturn = [chat]
const waitsBeforeReadable = guardWaits.length
const dueReadable = await whatsappSourceAdapter.cheapCheck({
    watch: watch(state({
        lastFetchedAt: NOW,
        extra: {
            whatsapp: {
                primed: true,
                chats: { [chat.id]: { lastSeenAt: NOW - 60_000, lastSeenIds: [] } },
            },
        },
    })),
    now: NOW + 120_000,
    timeoutMs: 10_000,
})
check('due readable window succeeds', dueReadable.ok === true, dueReadable)
check('due readable window reads the unread chat', readCalls.length === 1, readCalls)
check('due readable window paces both list and read through the WhatsApp guard', guardWaits.length >= waitsBeforeReadable + 2, guardWaits)
check('read message cap stays bounded', readCalls[0]?.maxMessages >= 12 && readCalls[0]?.maxMessages <= 25, readCalls)
check('read char cap stays bounded', readCalls[0]?.maxChars >= 8_000 && readCalls[0]?.maxChars <= 14_000, readCalls)

if (failures > 0) {
    console.error(`\n${failures} WhatsApp monitor load-shaping smoke check(s) failed.`)
    process.exit(1)
}

console.log('\nWhatsApp monitor load-shaping smoke checks passed.')
