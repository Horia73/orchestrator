import { EventEmitter } from 'events'

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
    | { type: 'request_started'; requestId: string }
    | { type: 'request_completed'; requestId: string }
    | { type: 'logs_cleared' }

export function emitObservabilityEvent(event: ObservabilityEvent) {
    observabilityEventEmitter.emit('observability:update', event)
}
