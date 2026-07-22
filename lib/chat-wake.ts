import { addMessage, getConversation } from '@/lib/db'
import type { Message } from '@/lib/types'
import { getActiveChatStream } from '@/lib/chat-streams'
import { claimFollowUp, listFollowUpQueues } from '@/lib/chat-followups'
import { runWithProfileContext } from '@/lib/profiles/context'
import { getProfile, createProfileSession, deleteProfileSession } from '@/lib/profiles/store'
import { PROFILE_SESSION_COOKIE } from '@/lib/profiles/constants'
import { generateId } from '@/lib/utils-chat'
import { canRunBackgroundLoop } from '@/lib/ai/background-leadership'

/**
 * Server-initiated conversation turns ("wakes").
 *
 * Used when a turn must run with no browser attached:
 *   • a queued steering follow-up whose client vanished mid-run (phone locked)
 *   • a tracked background job that finished while the conversation was idle
 *
 * Rather than extracting the 2000-line /api/chat pipeline, the wake performs a
 * loopback POST to /api/chat — the same pattern the CLI MCP bridge uses for
 * tool execution. Auth rides on a real short-lived profile session (created
 * directly in the store, deleted right after), so the route's profile gate and
 * permission model apply unchanged. The SSE response is drained and discarded;
 * progress persistence (every 250ms) plus add_message/chat_stream events keep
 * any connected clients in sync exactly as they do for a client-owned run.
 */

const WAKE_FETCH_TIMEOUT_MS = 30 * 60 * 1000 // hard ceiling; agentic turns can be long

/** How long the connected client gets to drain its own follow-up before the
 *  server assumes it's gone and runs the turn headlessly. */
const FOLLOWUP_ORPHAN_GRACE_MS = 8_000
const FOLLOWUP_SWEEP_INTERVAL_MS = 10_000

function loopbackBaseUrl(): string {
    const port = process.env.PORT ?? '3000'
    return `http://127.0.0.1:${port}`
}

export interface WakeTurnArgs {
    profileId: string
    conversationId: string
    /** User-role message to run the turn with. It is (re)persisted with a
     *  fresh run-time timestamp — a queued follow-up was typed while the
     *  previous turn streamed, and that turn's terminal persist stamps the
     *  assistant row later; without the re-stamp the follow-up would sort
     *  BEFORE the answer it followed on reload. */
    message: Pick<Message, 'id' | 'content'> & Partial<Message>
}

export async function runConversationWakeTurn(args: WakeTurnArgs): Promise<{ ok: boolean; error?: string }> {
    const profile = getProfile(args.profileId)
    if (!profile || profile.disabledAt) {
        return { ok: false, error: `Profile ${args.profileId} unavailable` }
    }

    const run = () => {
        if (!getConversation(args.conversationId)) {
            return { skip: `Conversation ${args.conversationId} not found` }
        }
        if (getActiveChatStream(args.conversationId)) {
            return { skip: 'stream already active' }
        }
        const message: Message = {
            role: 'user',
            ...args.message,
            timestamp: Date.now(),
        } as Message
        addMessage(args.conversationId, message)
        return { message }
    }
    const prepared = runWithProfileContext(
        { profileId: profile.id, role: profile.role },
        run,
    )
    if ('skip' in prepared) {
        return { ok: false, error: prepared.skip }
    }

    const { token } = createProfileSession({
        profileId: profile.id,
        deviceLabel: 'internal:chat-wake',
        userAgent: 'orchestrator/chat-wake',
    })
    try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), WAKE_FETCH_TIMEOUT_MS)
        try {
            const response = await fetch(`${loopbackBaseUrl()}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: `${PROFILE_SESSION_COOKIE}=${encodeURIComponent(token)}`,
                },
                body: JSON.stringify({
                    conversationId: args.conversationId,
                    messageId: generateId(),
                    messages: [prepared.message],
                    promptContextSource: 'Server wake',
                }),
                signal: controller.signal,
            })
            if (!response.ok) {
                const text = await response.text().catch(() => '')
                return { ok: false, error: `Wake POST failed (${response.status}): ${text.slice(0, 300)}` }
            }
            // Drain the SSE body so the run is fully consumed; content is
            // already persisted server-side, we don't need it here.
            const reader = response.body?.getReader()
            if (reader) {
                for (;;) {
                    const { done } = await reader.read()
                    if (done) break
                }
            }
            return { ok: true }
        } finally {
            clearTimeout(timeout)
        }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'wake fetch failed' }
    } finally {
        try { deleteProfileSession(token) } catch { /* best-effort */ }
    }
}

// ---------------------------------------------------------------------------
// Orphaned follow-up sweep
// ---------------------------------------------------------------------------

const globalForWake = globalThis as unknown as {
    __orchestratorFollowUpSweep?: ReturnType<typeof setInterval>
    __orchestratorWakeRunning?: Set<string>
}

/** Conversations with a wake turn currently in flight (profile-scoped keys) —
 *  guards against the sweep double-firing while a wake POST is still running. */
const wakeRunning = globalForWake.__orchestratorWakeRunning ?? new Set<string>()
if (!globalForWake.__orchestratorWakeRunning) {
    globalForWake.__orchestratorWakeRunning = wakeRunning
}

export function startFollowUpSweep(): void {
    if (globalForWake.__orchestratorFollowUpSweep) return
    globalForWake.__orchestratorFollowUpSweep = setInterval(() => {
        if (!canRunBackgroundLoop()) return
        void sweepOrphanedFollowUps().catch(err => {
            console.error('[chat-wake] follow-up sweep failed', err)
        })
    }, FOLLOWUP_SWEEP_INTERVAL_MS)
}

/**
 * Immediately drain the oldest queued follow-up for one conversation,
 * ignoring the orphan grace period. Used by background-job completion when
 * the conversation is idle — there is no client that could drain the entry,
 * so waiting out the grace would only add latency.
 */
export async function triggerFollowUpDrain(profileId: string, conversationId: string): Promise<void> {
    const key = `${profileId}:${conversationId}`
    if (wakeRunning.has(key)) return
    const claimed = runWithProfileContext({ profileId }, () => {
        if (getActiveChatStream(conversationId)) return null
        return claimFollowUp(conversationId)
    })
    if (!claimed) return
    wakeRunning.add(key)
    try {
        const result = await runConversationWakeTurn({
            profileId,
            conversationId,
            message: {
                id: claimed.userMessageId,
                content: claimed.content,
                secretRefs: claimed.secretRefs,
                attachments: claimed.attachments as Message['attachments'],
            },
        })
        if (!result.ok) {
            console.warn(`[chat-wake] immediate drain failed for ${conversationId}: ${result.error}`)
        }
    } finally {
        wakeRunning.delete(key)
    }
}

export async function sweepOrphanedFollowUps(): Promise<void> {
    const now = Date.now()
    for (const queue of listFollowUpQueues()) {
        const key = `${queue.profileId}:${queue.conversationId}`
        if (wakeRunning.has(key)) continue
        const stale = queue.entries.find(entry => now - entry.queuedAt >= FOLLOWUP_ORPHAN_GRACE_MS)
        if (!stale) continue

        const claimed = runWithProfileContext({ profileId: queue.profileId }, () => {
            if (getActiveChatStream(queue.conversationId)) return null
            return claimFollowUp(queue.conversationId, stale.id)
        })
        if (!claimed) continue

        wakeRunning.add(key)
        try {
            const result = await runConversationWakeTurn({
                profileId: queue.profileId,
                conversationId: queue.conversationId,
                message: {
                    id: claimed.userMessageId,
                    content: claimed.content,
                    secretRefs: claimed.secretRefs,
                    attachments: claimed.attachments as Message['attachments'],
                },
            })
            if (!result.ok) {
                console.warn(
                    `[chat-wake] orphaned follow-up run failed for ${queue.conversationId}: ${result.error}`,
                )
            }
        } finally {
            wakeRunning.delete(key)
        }
    }
}
