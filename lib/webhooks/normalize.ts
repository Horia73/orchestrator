import { createHash } from 'crypto'

import type { NormalizedWebhookEvent, WebhookEndpoint } from './schema'
import { NormalizedWebhookEventSchema } from './schema'

const EVENT_TYPE_KEYS = ['eventType', 'event_type', 'type', 'topic', 'action', 'kind']
const EVENT_ID_KEYS = ['id', 'eventId', 'event_id', 'deliveryId', 'delivery_id']
const TIME_KEYS = ['occurredAt', 'occurred_at', 'timestamp', 'time', 'createdAt', 'created_at']

export function normalizeWebhookEvent(
    endpoint: WebhookEndpoint,
    request: Request,
    payload: Record<string, unknown>,
): NormalizedWebhookEvent {
    const eventType = cleanString(
        request.headers.get('x-orchestrator-event-type')
            ?? request.headers.get('x-webhook-event')
            ?? request.headers.get('x-event-type')
            ?? firstString(payload, EVENT_TYPE_KEYS)
            ?? endpoint.defaultEventType
            ?? 'event',
    )
    const occurredAt = parseTimestamp(firstValue(payload, TIME_KEYS)) ?? Date.now()
    const subject = cleanOptionalString(
        firstString(payload, ['subject', 'entity_id', 'resource', 'target', 'name']),
    )
    const actor = cleanOptionalString(
        firstString(payload, ['actor', 'user', 'sender', 'source']),
    )
    const summary = cleanString(
        firstString(payload, ['summary', 'message', 'title', 'description'])
            ?? `${endpoint.source}.${eventType}`,
        2_000,
    )

    return NormalizedWebhookEventSchema.parse({
        source: endpoint.source,
        eventType,
        subject,
        actor,
        occurredAt,
        summary,
        metadata: {
            endpointId: endpoint.id,
            endpointSlug: endpoint.slug,
        },
    })
}

export function computeWebhookDedupeKey(
    endpoint: WebhookEndpoint,
    request: Request,
    rawBody: string,
    payload: Record<string, unknown>,
    normalized: NormalizedWebhookEvent,
): string {
    const explicit = request.headers.get('idempotency-key')
        ?? request.headers.get('x-idempotency-key')
        ?? request.headers.get('x-webhook-event-id')
        ?? request.headers.get('x-github-delivery')
        ?? firstString(payload, EVENT_ID_KEYS)
    if (explicit?.trim()) {
        return cleanString(explicit, 200)
    }
    return createHash('sha256')
        .update(endpoint.id)
        .update('\n')
        .update(normalized.eventType)
        .update('\n')
        .update(rawBody)
        .digest('hex')
        .slice(0, 64)
}

function firstString(payload: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
        const value = payload[key]
        if (typeof value === 'string' && value.trim()) return value
        if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    }
    return null
}

function firstValue(payload: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
        if (payload[key] !== undefined && payload[key] !== null) return payload[key]
    }
    return undefined
}

function parseTimestamp(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        const ms = value > 10_000_000_000 ? value : value * 1000
        return ms > 0 ? Math.round(ms) : null
    }
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value)
        if (Number.isFinite(numeric)) return parseTimestamp(numeric)
        const parsed = Date.parse(value)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

function cleanString(value: string, max = 160): string {
    const clean = value.trim().replace(/\s+/g, ' ')
    return clean.slice(0, max) || 'event'
}

function cleanOptionalString(value: string | null): string | null {
    if (!value?.trim()) return null
    return cleanString(value, 500)
}
