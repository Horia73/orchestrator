import { emitChatEvent } from '@/lib/events'

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

export function registerChatStream(conversationId: string, messageId: string, controller: AbortController) {
    const current = streams.get(conversationId)
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
    streams.set(conversationId, stream)
    emitChatEvent({
        type: 'chat_stream_started',
        payload: { conversationId, messageId, startedAt: stream.startedAt },
    })
}

export function clearChatStream(conversationId: string, messageId?: string) {
    const active = streams.get(conversationId)
    if (!active) return
    if (messageId && active.messageId !== messageId) return
    streams.delete(conversationId)
    emitChatEvent({
        type: 'chat_stream_ended',
        payload: { conversationId, messageId: active.messageId },
    })
}

export function stopChatStream(conversationId: string): boolean {
    const active = streams.get(conversationId)
    if (!active) return false
    active.controller.abort()
    streams.delete(conversationId)
    emitChatEvent({
        type: 'chat_stream_ended',
        payload: { conversationId, messageId: active.messageId },
    })
    return true
}

export function getActiveChatStream(conversationId: string): { messageId: string; startedAt: number } | null {
    const active = streams.get(conversationId)
    if (!active) return null
    if (active.controller.signal.aborted) {
        streams.delete(conversationId)
        return null
    }
    return {
        messageId: active.messageId,
        startedAt: active.startedAt,
    }
}

export function listActiveChatStreams(): Array<{ conversationId: string; messageId: string; startedAt: number }> {
    const active: Array<{ conversationId: string; messageId: string; startedAt: number }> = []
    for (const [conversationId, stream] of streams.entries()) {
        if (stream.controller.signal.aborted) {
            streams.delete(conversationId)
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
