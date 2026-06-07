import { EventEmitter } from 'events'
import { getActiveProfileId } from '@/lib/profiles/context'

// Survives Next.js fast-refresh in dev — same trick as lib/events.ts.
const globalForEvents = globalThis as unknown as {
    observabilityEventEmitter?: EventEmitter
}

export const observabilityEventEmitter =
    globalForEvents.observabilityEventEmitter || new EventEmitter()
observabilityEventEmitter.setMaxListeners(100)

if (process.env.NODE_ENV !== 'production') {
    globalForEvents.observabilityEventEmitter = observabilityEventEmitter
}

export type ObservabilityEvent =
    | { type: 'request_started'; requestId: string; profileId?: string }
    | { type: 'request_completed'; requestId: string; profileId?: string }
    | { type: 'logs_cleared'; profileId?: string }

export function emitObservabilityEvent(event: ObservabilityEvent) {
    observabilityEventEmitter.emit('observability:update', {
        profileId: getActiveProfileId(),
        ...event,
    })
}
