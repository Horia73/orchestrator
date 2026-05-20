import { evaluateRule, type WhatsAppCandidate } from '../rules'
import type { WatchState } from '../schema'
import { extractWaContactsFromRule } from './rule-targets'
import {
    safeAdapterCall,
    withTimeout,
    type AvailabilityResult,
    type CheapCheckInput,
    type CheapCheckResult,
    type MatchedCandidate,
    type SourceAdapter,
} from './types'

// ---------------------------------------------------------------------------
// WhatsApp source adapter.
//
// The cheap-check has two phases per tick:
//   A. List recent chats with unreadCount (cheap, in-process via wwebjs).
//      Filter to chats that:
//        - match a wa_from contact target in the rule, when the rule has any;
//          otherwise consider ALL chats with unreadCount > 0 (text-only rules
//          like `wa_text_contains` apply across all chats).
//        - have unreadCount > 0 (no new messages = nothing to evaluate).
//   B. For each candidate chat, read the chat's recent messages, drop
//      messages we've already processed (per-chat lastSeenAt + LRU ring),
//      build WhatsAppCandidate per message, evaluate rule, collect matches.
//
// Primes on first tick like Gmail — we never blast historical messages on
// watch creation; the watermark is set to "now" and only mail/messages
// arriving AFTER are surfaced.
// ---------------------------------------------------------------------------

const WA_KEY = 'whatsapp'
const MAX_CHATS_LISTED = 30
const MAX_MESSAGES_PER_CHAT = 25
const READ_CHAT_MAX_CHARS = 12_000
const PER_CHAT_RING_CAP = 50

interface WaChatState {
    /** Last message timestamp we processed for this chat (epoch ms). */
    lastSeenAt?: number
    /** LRU of recent message ids we've already surfaced for this chat. */
    lastSeenIds?: string[]
}

interface WaExtra {
    primed?: boolean
    chats?: Record<string, WaChatState>
}

function readWaExtra(state: WatchState): WaExtra {
    const all = (state.extra ?? {}) as Record<string, unknown>
    const entry = all[WA_KEY]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {}
    return entry as WaExtra
}

function mergeWaExtra(
    state: WatchState,
    patch: { primed?: boolean; chats?: Record<string, WaChatState> },
): Record<string, unknown> {
    const next = { ...(state.extra ?? {}) } as Record<string, unknown>
    const prev = readWaExtra(state)
    next[WA_KEY] = {
        primed: patch.primed ?? prev.primed ?? false,
        chats: { ...(prev.chats ?? {}), ...(patch.chats ?? {}) },
    }
    return next
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
    // Best-effort: WhatsApp Web mentions render as "@<digits>" in body. The
    // wwebjs MessageSummary doesn't surface a structured mentions array, so
    // we approximate. False positives here cost the user one extra notify;
    // wa_mention rules are pre-filtered by chat anyway in practice.
    const matches = message.body.match(/@\d{6,}/g)
    return matches ? [...new Set(matches.map((m) => m.slice(1)))] : []
}

export const whatsappSourceAdapter: SourceAdapter = {
    source: 'whatsapp',
    supportedRuleKinds: ['wa_from', 'wa_text_contains', 'wa_mention'],
    supportedActionKinds: ['notify_inbox', 'wa_send_reply'],

    async isAvailable(): Promise<AvailabilityResult> {
        try {
            const { getWhatsAppIntegrationStatus } = await import('@/lib/integrations/whatsapp')
            const status = await getWhatsAppIntegrationStatus()
            if (!status.connected) {
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

            const { whatsappListChats, whatsappReadChat } = await import('@/lib/integrations/whatsapp')

            // Use a slice of the budget for the listChats step; the rest is
            // split per-chat across the readChat calls.
            const listBudget = Math.max(2000, Math.floor(timeoutMs * 0.25))
            const chatList = await withTimeout(
                whatsappListChats(MAX_CHATS_LISTED),
                listBudget,
                'whatsapp listChats',
            )

            const contactTargets = extractWaContactsFromRule(watch.rule)
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
                        extra: mergeWaExtra(watch.state, { primed: true, chats }),
                    },
                    fetchedAt: now,
                }
            }

            if (relevant.length === 0) {
                return {
                    ok: true,
                    matches: [],
                    candidatesSeen: 0,
                    stateUpdate: { lastFetchedAt: now },
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
                    const result = await withTimeout(
                        whatsappReadChat(chatSummary.id, MAX_MESSAGES_PER_CHAT, READ_CHAT_MAX_CHARS),
                        perChatBudget,
                        `whatsapp readChat ${chatSummary.id}`,
                    )

                    const seenIds = new Set(chatPrev.lastSeenIds ?? [])
                    const newlySeenIds: string[] = []
                    let watermark = chatPrev.lastSeenAt ?? 0

                    for (const m of result.messages) {
                        // Skip outgoing messages — monitor is for things the
                        // user receives, not what they send.
                        if (m.fromMe) continue
                        if (seenIds.has(m.id)) continue
                        const ts = m.timestamp ?? (m.date ? Date.parse(m.date) : 0)
                        if (chatPrev.lastSeenAt && ts !== 0 && ts <= chatPrev.lastSeenAt) continue

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

            return {
                ok: errors.length === 0,
                error: errors.length > 0 ? errors.join('; ') : undefined,
                matches,
                candidatesSeen,
                stateUpdate: {
                    lastFetchedAt: now,
                    extra: mergeWaExtra(watch.state, { chats: newChatStates }),
                },
                fetchedAt: now,
            }
        })
    },
}
