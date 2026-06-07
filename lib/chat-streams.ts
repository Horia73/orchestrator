import { emitChatEvent } from '@/lib/events'
import { getActiveProfileId } from '@/lib/profiles/context'

interface ActiveChatStream {
    messageId: string
    startedAt: number
    controller: AbortController
}

const globalForChatStreams = globalThis as unknown as {
    __orchestratorChatStreams?: Map<string, ActiveChatStream>
}

const streams = globalForChatStreams.__orchestratorChatStreams ?? new Map<string, ActiveChatStream>()

if (!globalForChatStreams.__orchestratorChatStreams) {
    globalForChatStreams.__orchestratorChatStreams = streams
}

function streamKey(conversationId: string): string {
    return `${getActiveProfileId()}:${conversationId}`
}

export function registerChatStream(conversationId: string, messageId: string, controller: AbortController) {
    const key = streamKey(conversationId)
    const current = streams.get(key)
    if (current && !current.controller.signal.aborted) {
        current.controller.abort()
        emitChatEvent({
            type: 'chat_stream_ended',
            payload: { conversationId, messageId: current.messageId },
        })
    }
    const stream = {
        messageId,
        startedAt: Date.now(),
        controller,
    }
    streams.set(key, stream)
    emitChatEvent({
        type: 'chat_stream_started',
        payload: { conversationId, messageId, startedAt: stream.startedAt },
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

export function stopChatStream(conversationId: string): boolean {
    const key = streamKey(conversationId)
    const active = streams.get(key)
    if (!active) return false
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
