import { evaluateRule, type WhatsAppCandidate } from '../rules'
import type { WatchState } from '../schema'
import { extractWaChatPrefilterFromRule } from './rule-targets'
import {
    safeAdapterCall,
    withTimeout,
    type AvailabilityResult,
    type CheapCheckInput,
    type CheapCheckResult,
    type MatchedCandidate,
    type PendingRevalidationInput,
    type PendingRevalidationResult,
    type SourceAdapter,
} from './types'

// ---------------------------------------------------------------------------
// WhatsApp source adapter.
//
// The cheap-check has two phases when its per-watch window is due:
//   A. List recent chats with unreadCount (cheap, in-process via the active
//      WhatsApp provider).
//      Filter to chats that:
//        - match the SOUND contact prefilter (extractWaChatPrefilterFromRule):
//          non-empty only when every possible match requires a wa_from hit.
//          A rule like any_of(wa_unread, wa_from…) yields no prefilter — ALL
//          chats with unread are considered (narrowing to the wa_from
//          contacts once silenced every other chat for weeks).
//        - have unreadCount > 0 (no new messages = nothing to evaluate).
//   B. For each candidate chat, read the chat's recent messages, drop
//      messages we've already processed (per-chat lastSeenAt + LRU ring),
//      build WhatsAppCandidate per message, evaluate rule, collect matches.
//
// Primes on first tick like Gmail — we never blast historical messages on
// watch creation; the watermark is set to "now" and only mail/messages
// arriving AFTER are surfaced. A chat first seen AFTER priming (no per-chat
// state yet) gets a 24h lookback floor instead, so fresh messages surface
// but a months-old unread backlog does not.
//
// Units: WhatsApp message timestamps are unix SECONDS;
// watermarks are stored in epoch MILLISECONDS. toWaMs() normalizes both ways
// (legacy seconds watermarks written by older builds migrate on read).
// ---------------------------------------------------------------------------

const WA_KEY = 'whatsapp'
const MIN_CHATS_LISTED = 18
const MAX_CHATS_LISTED = 30
const MIN_MESSAGES_PER_CHAT = 12
const MAX_MESSAGES_PER_CHAT = 25
const MIN_READ_CHAT_MAX_CHARS = 8_000
const MAX_READ_CHAT_MAX_CHARS = 14_000
const PER_CHAT_RING_CAP = 50
const BASE_CHECK_INTERVAL_MS = 15 * 60_000
const MAX_CHECK_INTERVAL_MS = 2 * 60 * 60_000
// Watermark floor for chats with no per-chat state yet (first seen after the
// watch primed): surface only messages from the last 24h, not the whole
// unread backlog.
const NEW_CHAT_LOOKBACK_MS = 24 * 60 * 60_000

/** Normalize a WhatsApp timestamp to epoch ms. Providers report unix seconds;
 *  older builds also persisted per-chat watermarks in seconds. */
function toWaMs(value: number | null | undefined): number {
    if (!value || !Number.isFinite(value) || value <= 0) return 0
    return value < 1e12 ? value * 1000 : value
}

interface WaChatState {
    /** Last message timestamp we processed for this chat (epoch ms). */
    lastSeenAt?: number
    /** LRU of recent message ids we've already surfaced for this chat. */
    lastSeenIds?: string[]
}

interface WaExtra {
    primed?: boolean
    chats?: Record<string, WaChatState>
    nextCheckAfter?: number
    quietStreak?: number
}

function readWaExtra(state: WatchState): WaExtra {
    const all = (state.extra ?? {}) as Record<string, unknown>
    const entry = all[WA_KEY]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {}
    return entry as WaExtra
}

function mergeWaExtra(
    state: WatchState,
    patch: { primed?: boolean; chats?: Record<string, WaChatState>; nextCheckAfter?: number; quietStreak?: number },
): Record<string, unknown> {
    const next = { ...(state.extra ?? {}) } as Record<string, unknown>
    const prev = readWaExtra(state)
    next[WA_KEY] = {
        primed: patch.primed ?? prev.primed ?? false,
        chats: { ...(prev.chats ?? {}), ...(patch.chats ?? {}) },
        nextCheckAfter: patch.nextCheckAfter ?? prev.nextCheckAfter,
        quietStreak: patch.quietStreak ?? prev.quietStreak ?? 0,
    }
    return next
}

function deterministicUnit(seed: string): number {
    let hash = 2166136261
    for (let i = 0; i < seed.length; i += 1) {
        hash ^= seed.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0) / 0xffffffff
}

function jitteredInt(watchId: string, now: number, salt: string, min: number, max: number): number {
    const bucket = Math.floor(now / 60_000)
    return Math.round(min + deterministicUnit(`${watchId}:${bucket}:${salt}`) * (max - min))
}

function nextCheckAfter(watchId: string, now: number, quietStreak: number, hadError: boolean): number {
    const quietMultiplier = hadError ? 4 : 1 + Math.min(Math.max(quietStreak, 0), 6) * 0.5
    const jitter = 0.75 + deterministicUnit(`${watchId}:${Math.floor(now / 60_000)}:next`) * 0.6
    const interval = Math.min(MAX_CHECK_INTERVAL_MS, Math.round(BASE_CHECK_INTERVAL_MS * quietMultiplier * jitter))
    return now + interval
}

function chatMatchesContactTarget(chat: { id: string; name: string }, targets: string[]): boolean {
    if (targets.length === 0) return true
    const id = chat.id.toLowerCase()
    const name = chat.name.toLowerCase()
    return targets.some((t) => {
        const n = t.toLowerCase().trim()
        return n.length > 0 && (id.includes(n) || name.includes(n))
    })
}

function extractMentions(message: { body: string }): string[] {
    // Best-effort: mentions render as "@<digits>" in the text body. The shared
    // MessageSummary doesn't surface structured mentions yet, so we approximate.
    // False positives here cost the user one extra notify; wa_mention rules are
    // pre-filtered by chat anyway in practice.
    const matches = message.body.match(/@\d{6,}/g)
    return matches ? [...new Set(matches.map((m) => m.slice(1)))] : []
}

async function guardedWhatsAppRead<T>(
    guard: typeof import('@/lib/integrations/whatsapp-tool-guard').withWhatsAppToolGuard,
    fingerprint: string,
    timeoutMs: number,
    label: string,
    action: () => Promise<T>,
): Promise<T> {
    const controller = new AbortController()
    const startedAt = Date.now()
    return withTimeout(
        guard('read', fingerprint, () => {
            const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt))
            return withTimeout(action(), remainingMs, label)
        }, { signal: controller.signal }),
        timeoutMs,
        label,
        () => controller.abort(),
    )
}

export const whatsappSourceAdapter: SourceAdapter = {
    source: 'whatsapp',
    supportedRuleKinds: ['wa_unread', 'wa_from', 'wa_text_contains', 'wa_mention'],
    supportedActionKinds: ['notify_inbox', 'wa_send_reply'],

    async isAvailable(): Promise<AvailabilityResult> {
        try {
            const { getWhatsAppIntegrationStatus } = await import('@/lib/integrations/whatsapp')
            const status = await getWhatsAppIntegrationStatus()
            if (!status.connected) {
                if (status.provider === 'baileys' && status.sessionStored && !status.qrAvailable && !status.needsReconnect) {
                    return { available: true }
                }
                return {
                    available: false,
                    reason: status.phase === 'qr'
                        ? 'WhatsApp waiting for QR scan.'
                        : status.lastError ?? 'WhatsApp not connected.',
                }
            }
            return { available: true }
        } catch (err) {
            return { available: false, reason: err instanceof Error ? err.message : 'WhatsApp status check failed.' }
        }
    },

    cheapCheck(input: CheapCheckInput): Promise<CheapCheckResult> {
        return safeAdapterCall('whatsapp', async () => {
            const { watch, now, timeoutMs } = input
            const extra = readWaExtra(watch.state)
            const isPriming = !extra.primed
            if (extra.nextCheckAfter && now < extra.nextCheckAfter) {
                return {
                    ok: true,
                    matches: [],
                    candidatesSeen: 0,
                    stateUpdate: { lastFetchedAt: watch.state.lastFetchedAt ?? now },
                    fetchedAt: now,
                }
            }

            const { whatsappListChats, whatsappReadChat } = await import('@/lib/integrations/whatsapp')
            const { withWhatsAppToolGuard } = await import('@/lib/integrations/whatsapp-tool-guard')
            const chatLimit = jitteredInt(watch.id, now, 'chats', MIN_CHATS_LISTED, MAX_CHATS_LISTED)
            const messagesPerChat = jitteredInt(watch.id, now, 'messages', MIN_MESSAGES_PER_CHAT, MAX_MESSAGES_PER_CHAT)
            const readMaxChars = jitteredInt(watch.id, now, 'chars', MIN_READ_CHAT_MAX_CHARS, MAX_READ_CHAT_MAX_CHARS)

            // Use a slice of the budget for the listChats step; the rest is
            // split per-chat across the readChat calls. The outer timeout
            // aborts queued guard work, so a timed-out monitor read cannot run
            // later as stale work.
            const listBudget = Math.max(2000, Math.floor(timeoutMs * 0.25))
            let chatList: Awaited<ReturnType<typeof whatsappListChats>>
            try {
                chatList = await guardedWhatsAppRead(
                    withWhatsAppToolGuard,
                    `monitor:${watch.id}:list:${chatLimit}`,
                    listBudget,
                    'whatsapp listChats',
                    () => whatsappListChats(chatLimit),
                )
            } catch (err) {
                const quietStreak = (extra.quietStreak ?? 0) + 1
                return {
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                    matches: [],
                    candidatesSeen: 0,
                    stateUpdate: {
                        lastFetchedAt: now,
                        extra: mergeWaExtra(watch.state, {
                            quietStreak,
                            nextCheckAfter: nextCheckAfter(watch.id, now, quietStreak, true),
                        }),
                    },
                    fetchedAt: now,
                }
            }

            const contactTargets = extractWaChatPrefilterFromRule(watch.rule)
            const relevant = chatList.chats.filter(
                (c) => c.unreadCount > 0 && chatMatchesContactTarget(c, contactTargets),
            )

            if (isPriming) {
                // Set watermarks for every relevant chat to "now" and bail.
                const chats: Record<string, WaChatState> = {}
                for (const c of relevant) {
                    chats[c.id] = { lastSeenAt: now, lastSeenIds: [] }
                }
                return {
                    ok: true,
                    matches: [],
                    candidatesSeen: 0,
                    stateUpdate: {
                        lastFetchedAt: now,
                        extra: mergeWaExtra(watch.state, {
                            primed: true,
                            chats,
                            quietStreak: 1,
                            nextCheckAfter: nextCheckAfter(watch.id, now, 1, false),
                        }),
                    },
                    fetchedAt: now,
                }
            }

            if (relevant.length === 0) {
                return {
                    ok: true,
                    matches: [],
                    candidatesSeen: 0,
                    stateUpdate: {
                        lastFetchedAt: now,
                        extra: mergeWaExtra(watch.state, {
                            quietStreak: (extra.quietStreak ?? 0) + 1,
                            nextCheckAfter: nextCheckAfter(watch.id, now, (extra.quietStreak ?? 0) + 1, false),
                        }),
                    },
                    fetchedAt: now,
                }
            }

            const remainingBudget = Math.max(2000, timeoutMs - listBudget)
            const perChatBudget = Math.max(1500, Math.floor(remainingBudget / relevant.length))

            const matches: MatchedCandidate[] = []
            const errors: string[] = []
            const newChatStates: Record<string, WaChatState> = {}
            let candidatesSeen = 0

            for (const chatSummary of relevant) {
                const chatPrev = extra.chats?.[chatSummary.id] ?? {}
                try {
                    const result = await guardedWhatsAppRead(
                        withWhatsAppToolGuard,
                        `monitor:${watch.id}:read:${chatSummary.id}:${messagesPerChat}:${readMaxChars}`,
                        perChatBudget,
                        `whatsapp readChat ${chatSummary.id}`,
                        () => whatsappReadChat(chatSummary.id, messagesPerChat, readMaxChars),
                    )

                    const seenIds = new Set(chatPrev.lastSeenIds ?? [])
                    const newlySeenIds: string[] = []
                    const prevSeenMs = toWaMs(chatPrev.lastSeenAt)
                    // Known chats cut at their watermark; never-seen chats cut
                    // at a 24h lookback so we don't blast an old unread backlog.
                    const floorMs = prevSeenMs || now - NEW_CHAT_LOOKBACK_MS
                    let watermark = prevSeenMs

                    for (const m of result.messages) {
                        // Skip outgoing messages — monitor is for things the
                        // user receives, not what they send.
                        if (m.fromMe) continue
                        if (seenIds.has(m.id)) continue
                        const ts = toWaMs(m.timestamp) || (m.date ? Date.parse(m.date) : 0)
                        if (ts !== 0 && ts <= floorMs) continue

                        candidatesSeen += 1
                        newlySeenIds.push(m.id)
                        if (ts > watermark) watermark = ts

                        const candidate: WhatsAppCandidate = {
                            source: 'whatsapp',
                            id: m.id,
                            chatId: m.chatId,
                            chatName: m.chatName ?? chatSummary.name ?? null,
                            from: m.author ?? m.from,
                            fromMe: m.fromMe,
                            body: m.body,
                            mentions: extractMentions(m),
                            timestamp: ts || now,
                        }

                        if (evaluateRule(watch.rule, candidate)) {
                            const preview = m.body.length > 200 ? `${m.body.slice(0, 200)}…` : m.body
                            matches.push({
                                candidate,
                                summary: `${candidate.chatName ?? candidate.from}: ${preview}`,
                                externalId: m.id,
                                details: {
                                    chatId: m.chatId,
                                    chatName: candidate.chatName,
                                    from: candidate.from,
                                    body: m.body,
                                    timestamp: ts,
                                    hasMedia: m.hasMedia,
                                },
                            })
                        }
                    }

                    newChatStates[chatSummary.id] = {
                        lastSeenAt: watermark || now,
                        lastSeenIds: [...newlySeenIds, ...(chatPrev.lastSeenIds ?? [])].slice(0, PER_CHAT_RING_CAP),
                    }
                } catch (err) {
                    errors.push(
                        err instanceof Error
                            ? `${chatSummary.id}: ${err.message}`
                            : `${chatSummary.id}: ${String(err)}`,
                    )
                }
            }
            const quietStreak = matches.length > 0 || candidatesSeen > 0 ? 0 : (extra.quietStreak ?? 0) + 1

            return {
                ok: errors.length === 0,
                error: errors.length > 0 ? errors.join('; ') : undefined,
                matches,
                candidatesSeen,
                stateUpdate: {
                    lastFetchedAt: now,
                    extra: mergeWaExtra(watch.state, {
                        chats: newChatStates,
                        quietStreak,
                        nextCheckAfter: nextCheckAfter(watch.id, now, quietStreak, errors.length > 0),
                    }),
                },
                fetchedAt: now,
            }
        })
    },

    revalidatePending(input: PendingRevalidationInput): Promise<PendingRevalidationResult> {
        return safeRevalidateWhatsAppPending(input)
    },
}

async function safeRevalidateWhatsAppPending(input: PendingRevalidationInput): Promise<PendingRevalidationResult> {
    const { watch, pending, now, timeoutMs } = input
    const details = pending.details ?? {}
    const chatId = typeof details.chatId === 'string' ? details.chatId : null
    if (!chatId) {
        return { active: true, checkedAt: now, error: 'WhatsApp pending item has no chat id to recheck.' }
    }

    try {
        const { whatsappReadChat } = await import('@/lib/integrations/whatsapp')
        const { withWhatsAppToolGuard } = await import('@/lib/integrations/whatsapp-tool-guard')
        const result = await guardedWhatsAppRead(
            withWhatsAppToolGuard,
            `monitor:${watch.id}:revalidate:${chatId}`,
            timeoutMs,
            `whatsapp recheck ${chatId}`,
            () => whatsappReadChat(chatId, MAX_MESSAGES_PER_CHAT, MAX_READ_CHAT_MAX_CHARS),
        )

        if (result.chat.unreadCount <= 0) {
            return { active: false, reason: 'WhatsApp chat no longer has unread messages.', checkedAt: now }
        }

        const messageId = typeof pending.externalId === 'string' ? pending.externalId : null
        const message = messageId ? result.messages.find((m) => m.id === messageId) : null
        if (!message) {
            return {
                active: true,
                checkedAt: now,
                error: messageId
                    ? 'WhatsApp chat is still unread, but the exact pending message was not in the bounded recent read.'
                    : 'WhatsApp chat is still unread, but the pending item has no message id to recheck.',
            }
        }

        const ts = toWaMs(message.timestamp) || (message.date ? Date.parse(message.date) : 0)
        const candidate: WhatsAppCandidate = {
            source: 'whatsapp',
            id: message.id,
            chatId: message.chatId,
            chatName: message.chatName ?? result.chat.name ?? null,
            from: message.author ?? message.from,
            fromMe: message.fromMe,
            body: message.body,
            mentions: extractMentions(message),
            timestamp: ts || now,
        }
        if (!evaluateRule(watch.rule, candidate)) {
            return { active: false, reason: 'WhatsApp message no longer matches the watch rule.', checkedAt: now }
        }

        const preview = message.body.length > 200 ? `${message.body.slice(0, 200)}…` : message.body
        return {
            active: true,
            checkedAt: now,
            summary: `${candidate.chatName ?? candidate.from}: ${preview}`,
            details: {
                ...details,
                chatId: message.chatId,
                chatName: candidate.chatName,
                from: candidate.from,
                body: message.body,
                timestamp: ts,
                hasMedia: message.hasMedia,
            },
        }
    } catch (err) {
        return {
            active: true,
            checkedAt: now,
            error: err instanceof Error ? err.message : String(err),
        }
    }
}
