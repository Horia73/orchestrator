import { getActiveProfileId } from '@/lib/profiles/context'
import type { Message } from '@/lib/types'

/**
 * Live turn-steering registry — the mid-turn half of chat steering.
 *
 * While a turn streams, the chat route registers a delivery handle here when
 * (and only while) the active provider can inject user input into the
 * in-flight turn (codex app-server `turn/steer`). POST /api/chat/steer tries
 * this handle FIRST; only when there is no handle, the provider refuses the
 * injection, or the message can't be steered (attachments) does it fall back
 * to the follow-up queue (lib/chat-followups.ts), which runs the message as
 * the next turn.
 *
 * In-memory globalThis singleton, mirroring lib/chat-streams.ts — the handle
 * closes over the live turn, so it is meaningless across restarts, and the
 * instrumentation/route module-graph split means module-level state would
 * exist twice per process.
 */

export interface TurnSteeringHandle {
    /** Assistant message id of the turn this handle can steer. */
    messageId: string
    /**
     * Inject the user message into the running turn. Resolves true only when
     * the provider confirmed the injection AND the message was persisted +
     * announced on the stream; false means "fall back to the queue".
     */
    deliver: (message: Message) => Promise<boolean>
}

const globalForTurnSteering = globalThis as unknown as {
    __orchestratorTurnSteering?: Map<string, TurnSteeringHandle>
}

const handles = globalForTurnSteering.__orchestratorTurnSteering ?? new Map<string, TurnSteeringHandle>()

if (!globalForTurnSteering.__orchestratorTurnSteering) {
    globalForTurnSteering.__orchestratorTurnSteering = handles
}

function steeringKey(conversationId: string): string {
    return `${getActiveProfileId()}:${conversationId}`
}

export function registerTurnSteering(conversationId: string, handle: TurnSteeringHandle): void {
    handles.set(steeringKey(conversationId), handle)
}

/** Clear the handle; with `messageId`, only when it still belongs to that turn. */
export function clearTurnSteering(conversationId: string, messageId?: string): void {
    const key = steeringKey(conversationId)
    const current = handles.get(key)
    if (!current) return
    if (messageId && current.messageId !== messageId) return
    handles.delete(key)
}

export function getTurnSteering(conversationId: string): TurnSteeringHandle | null {
    return handles.get(steeringKey(conversationId)) ?? null
}
