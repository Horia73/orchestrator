import { emitChatEvent } from '@/lib/events'
import { getActiveProfileId } from '@/lib/profiles/context'
import type { ChatFollowUpSnapshot, ChatFollowUpSource } from '@/lib/chat-followup-types'
import type { MessageSecretRef } from '@/lib/types'

/**
 * Follow-up queue — the server half of chat steering.
 *
 * While an agent turn is streaming, the user can keep sending messages. Each
 * one is persisted to the conversation immediately (so it survives refresh),
 * represented in the client pending tray, and queued here. Delivery happens
 * at the earliest safe boundary — the end of the in-flight turn:
 *
 *   • If the client that owns the stream is still connected, it drains the
 *     queue itself: on the `done` SSE event it POSTs /api/chat for the next
 *     queued message (marked with followUpId so the server consumes the
 *     queue entry instead of double-running it).
 *   • If no client picks a queued entry up shortly after the run ends (phone
 *     locked mid-run), the server-side sweep runs the turn headlessly via the
 *     same internal turn runner the background-job wake uses.
 *
 * Background-job completion notices reuse this queue: when a tracked job
 * exits while a turn is streaming, the notice is queued and the agent sees it
 * right after finishing its current work.
 *
 * Entries are in-memory (mirroring lib/chat-streams.ts): the user message
 * itself is already durable in the DB, so a server restart only loses the
 * auto-run — the message still sits in the conversation and is included in
 * history on the next manual send.
 */

export interface ChatFollowUp {
    /** Queue entry id — also used by the client to claim the entry. */
    id: string
    /** Persisted user message id this entry corresponds to. */
    userMessageId: string
    /** Raw text to run the turn with (already persisted as the message body). */
    content: string
    /** Safe markers for credentials captured from this message. */
    secretRefs?: MessageSecretRef[]
    /** Attachments persisted on the user message, forwarded to the turn. */
    attachments?: unknown[]
    /**
     * Where the entry came from: a user steering message or a system-side
     * notice (background job completion). System notices never render a
     * "queued" chip client-side.
     */
    source: ChatFollowUpSource
    queuedAt: number
}

const globalForFollowUps = globalThis as unknown as {
    __orchestratorChatFollowUps?: Map<string, ChatFollowUp[]>
}

const queues = globalForFollowUps.__orchestratorChatFollowUps ?? new Map<string, ChatFollowUp[]>()

if (!globalForFollowUps.__orchestratorChatFollowUps) {
    globalForFollowUps.__orchestratorChatFollowUps = queues
}

function queueKey(conversationId: string, profileId?: string): string {
    return `${profileId ?? getActiveProfileId()}:${conversationId}`
}

export function enqueueFollowUp(conversationId: string, followUp: ChatFollowUp): void {
    const key = queueKey(conversationId)
    const queue = queues.get(key) ?? []
    queue.push(followUp)
    queues.set(key, queue)
    emitChatEvent({
        type: 'chat_followup_queued',
        payload: {
            conversationId,
            followUpId: followUp.id,
            userMessageId: followUp.userMessageId,
            source: followUp.source,
            queuedAt: followUp.queuedAt,
        },
    })
}

export function peekFollowUps(conversationId: string): ChatFollowUp[] {
    return [...(queues.get(queueKey(conversationId)) ?? [])]
}

export function peekFollowUpSnapshots(conversationId: string): ChatFollowUpSnapshot[] {
    return peekFollowUps(conversationId).map(entry => ({
        followUpId: entry.id,
        userMessageId: entry.userMessageId,
        source: entry.source,
        queuedAt: entry.queuedAt,
    }))
}

/** Put a claimed entry back at the head when a start loses an active-stream race. */
export function requeueClaimedFollowUp(conversationId: string, followUp: ChatFollowUp): void {
    const key = queueKey(conversationId)
    const queue = queues.get(key) ?? []
    if (queue.some(entry => entry.id === followUp.id)) return
    queue.unshift(followUp)
    queues.set(key, queue)
    emitChatEvent({
        type: 'chat_followup_queued',
        payload: {
            conversationId,
            followUpId: followUp.id,
            userMessageId: followUp.userMessageId,
            source: followUp.source,
            queuedAt: followUp.queuedAt,
        },
    })
}

/**
 * Claim the next queued follow-up for a turn run. When `followUpId` is given
 * (client-driven drain) the entry is only consumed if it is still queued —
 * a second claim returns null so the same follow-up never runs twice.
 */
export function claimFollowUp(conversationId: string, followUpId?: string): ChatFollowUp | null {
    const key = queueKey(conversationId)
    const queue = queues.get(key)
    if (!queue || queue.length === 0) return null
    let entry: ChatFollowUp | undefined
    if (followUpId) {
        const idx = queue.findIndex(item => item.id === followUpId)
        if (idx < 0) return null
        entry = queue.splice(idx, 1)[0]
    } else {
        entry = queue.shift()
    }
    if (queue.length === 0) queues.delete(key)
    if (!entry) return null
    emitChatEvent({
        type: 'chat_followup_claimed',
        payload: { conversationId, followUpId: entry.id, userMessageId: entry.userMessageId },
    })
    return entry
}

/** Drop every queued follow-up (user pressed Stop — stop means stop). */
export function clearFollowUps(conversationId: string): void {
    const key = queueKey(conversationId)
    const queue = queues.get(key)
    if (!queue || queue.length === 0) return
    queues.delete(key)
    emitChatEvent({
        type: 'chat_followups_cleared',
        payload: { conversationId },
    })
}

export function hasFollowUps(conversationId: string, profileId?: string): boolean {
    const queue = queues.get(queueKey(conversationId, profileId))
    return Boolean(queue && queue.length > 0)
}

/**
 * Iterate every queue across profiles — used by the orphan sweep that runs
 * queued follow-ups headlessly when no client drained them. Returns
 * profile-scoped keys so the sweep can re-enter the right profile context.
 */
export function listFollowUpQueues(): Array<{ profileId: string; conversationId: string; entries: ChatFollowUp[] }> {
    const result: Array<{ profileId: string; conversationId: string; entries: ChatFollowUp[] }> = []
    for (const [key, entries] of queues.entries()) {
        if (entries.length === 0) continue
        const sep = key.indexOf(':')
        if (sep <= 0) continue
        result.push({
            profileId: key.slice(0, sep),
            conversationId: key.slice(sep + 1),
            entries: [...entries],
        })
    }
    return result
}
