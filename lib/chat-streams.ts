import { emitChatEvent } from '@/lib/events'
import { getAiRunAdmissionBlock } from '@/lib/ai/run-admission'
import { getActiveProfileId } from '@/lib/profiles/context'

interface ActiveChatStream {
    messageId: string
    startedAt: number
    controller: AbortController
}

interface PendingStop {
    messageId?: string
    requestedAt: number
}

const globalForChatStreams = globalThis as unknown as {
    __orchestratorChatStreams?: Map<string, ActiveChatStream>
    __orchestratorPendingChatStops?: Map<string, PendingStop>
}

const streams = globalForChatStreams.__orchestratorChatStreams ?? new Map<string, ActiveChatStream>()
const pendingStops = globalForChatStreams.__orchestratorPendingChatStops ?? new Map<string, PendingStop>()
const PENDING_STOP_TTL_MS = 60_000

if (!globalForChatStreams.__orchestratorChatStreams) {
    globalForChatStreams.__orchestratorChatStreams = streams
}

if (!globalForChatStreams.__orchestratorPendingChatStops) {
    globalForChatStreams.__orchestratorPendingChatStops = pendingStops
}

function streamKey(conversationId: string): string {
    return `${getActiveProfileId()}:${conversationId}`
}

function prunePendingStops(now = Date.now()) {
    for (const [key, stop] of pendingStops.entries()) {
        if (now - stop.requestedAt > PENDING_STOP_TTL_MS) {
            pendingStops.delete(key)
        }
    }
}

function consumePendingStop(key: string, messageId: string): boolean {
    prunePendingStops()
    const pending = pendingStops.get(key)
    if (!pending) return false
    if (pending.messageId && pending.messageId !== messageId) return false
    pendingStops.delete(key)
    return true
}

export function registerChatStream(
    conversationId: string,
    messageId: string,
    controller: AbortController,
    options?: { announce?: boolean },
): boolean {
    if (getAiRunAdmissionBlock()) return false
    const key = streamKey(conversationId)
    const current = streams.get(key)
    if (current && !current.controller.signal.aborted) {
        return false
    }
    const stream = {
        messageId,
        startedAt: Date.now(),
        controller,
    }
    streams.set(key, stream)
    if (options?.announce !== false) announceChatStream(conversationId, messageId)
    if (consumePendingStop(key, messageId)) {
        controller.abort()
        streams.delete(key)
        emitChatEvent({
            type: 'chat_stream_ended',
            payload: { conversationId, messageId },
        })
    }
    return true
}

export function announceChatStream(conversationId: string, messageId: string): void {
    const active = streams.get(streamKey(conversationId))
    if (!active || active.messageId !== messageId) return
    emitChatEvent({
        type: 'chat_stream_started',
        payload: { conversationId, messageId, startedAt: active.startedAt },
    })
}

export function clearChatStream(conversationId: string, messageId?: string) {
    const key = streamKey(conversationId)
    const active = streams.get(key)
    if (!active) return
    if (messageId && active.messageId !== messageId) return
    streams.delete(key)
    emitChatEvent({
        type: 'chat_stream_ended',
        payload: { conversationId, messageId: active.messageId },
    })
}

export function stopChatStream(conversationId: string, messageId?: string): boolean {
    const key = streamKey(conversationId)
    const active = streams.get(key)
    if (!active) {
        pendingStops.set(key, { messageId, requestedAt: Date.now() })
        prunePendingStops()
        return false
    }
    if (messageId && active.messageId !== messageId) {
        pendingStops.set(key, { messageId, requestedAt: Date.now() })
        prunePendingStops()
        return false
    }
    active.controller.abort()
    streams.delete(key)
    emitChatEvent({
        type: 'chat_stream_ended',
        payload: { conversationId, messageId: active.messageId },
    })
    return true
}

export function getActiveChatStream(conversationId: string): { messageId: string; startedAt: number } | null {
    const key = streamKey(conversationId)
    const active = streams.get(key)
    if (!active) return null
    if (active.controller.signal.aborted) {
        streams.delete(key)
        return null
    }
    return {
        messageId: active.messageId,
        startedAt: active.startedAt,
    }
}

export function listActiveChatStreams(): Array<{ conversationId: string; messageId: string; startedAt: number }> {
    const active: Array<{ conversationId: string; messageId: string; startedAt: number }> = []
    const prefix = `${getActiveProfileId()}:`
    for (const [key, stream] of streams.entries()) {
        if (!key.startsWith(prefix)) continue
        const conversationId = key.slice(prefix.length)
        if (stream.controller.signal.aborted) {
            streams.delete(key)
            continue
        }
        active.push({
            conversationId,
            messageId: stream.messageId,
            startedAt: stream.startedAt,
        })
    }
    return active.sort((a, b) => a.startedAt - b.startedAt)
}

/** Process-wide view used by lifecycle machinery such as managed updates. */
export function listAllActiveChatStreams(): Array<{
    profileId: string
    conversationId: string
    messageId: string
    startedAt: number
}> {
    const active: Array<{
        profileId: string
        conversationId: string
        messageId: string
        startedAt: number
    }> = []
    for (const [key, stream] of streams.entries()) {
        if (stream.controller.signal.aborted) {
            streams.delete(key)
            continue
        }
        const separator = key.indexOf(':')
        if (separator <= 0) continue
        active.push({
            profileId: key.slice(0, separator),
            conversationId: key.slice(separator + 1),
            messageId: stream.messageId,
            startedAt: stream.startedAt,
        })
    }
    return active.sort((a, b) => a.startedAt - b.startedAt)
}
