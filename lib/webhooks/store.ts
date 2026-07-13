import { randomBytes, randomUUID } from 'crypto'

import db from '@/lib/db'
import { emitAppEvent } from '@/lib/events'
import { getActiveProfileId, runWithProfileContext } from '@/lib/profiles/context'
import {
    assertProfileWebhookSlugAvailable,
    listProfiles,
    registerProfileWebhookSlugOwner,
    unregisterProfileWebhookSlugOwner,
} from '@/lib/profiles/store'

import {
    WebhookEndpointCreateInputSchema,
    WebhookEndpointSchema,
    WebhookEndpointUpdateInputSchema,
    WebhookEventIngestInputSchema,
    WebhookEventSchema,
    WebhookSubscriptionCreateInputSchema,
    WebhookSubscriptionSchema,
    WebhookSubscriptionUpdateInputSchema,
    type WebhookDispatch,
    type WebhookEndpoint,
    type WebhookEndpointCreateInput,
    type WebhookEndpointPublic,
    type WebhookEndpointUpdateInput,
    type WebhookEvent,
    type WebhookEventIngestInput,
    type WebhookEventStatus,
    type WebhookSubscription,
    type WebhookSubscriptionCreateInput,
    type WebhookSubscriptionUpdateInput,
} from './schema'

// ---------------------------------------------------------------------------
// SQLite store for inbound webhooks.
// ---------------------------------------------------------------------------

db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT,
        source TEXT NOT NULL,
        defaultEventType TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        authMode TEXT NOT NULL,
        secret TEXT,
        hmacToleranceSeconds INTEGER NOT NULL DEFAULT 300,
        rateLimitPerMinute INTEGER NOT NULL DEFAULT 120,
        retentionDays INTEGER NOT NULL DEFAULT 30,
        createdBy TEXT NOT NULL DEFAULT 'user',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_slug ON webhook_endpoints(slug);

    CREATE TABLE IF NOT EXISTS webhook_events (
        id TEXT PRIMARY KEY,
        endpointId TEXT NOT NULL,
        slug TEXT NOT NULL,
        source TEXT NOT NULL,
        eventType TEXT NOT NULL,
        dedupeKey TEXT NOT NULL,
        payload TEXT NOT NULL,
        normalized TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        occurredAt INTEGER NOT NULL,
        receivedAt INTEGER NOT NULL,
        processedAt INTEGER,
        FOREIGN KEY (endpointId) REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
        UNIQUE(endpointId, dedupeKey)
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_events_endpoint_received ON webhook_events(endpointId, receivedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_type ON webhook_events(endpointId, eventType, receivedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events(status, receivedAt DESC);

    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id TEXT PRIMARY KEY,
        endpointId TEXT NOT NULL,
        targetKind TEXT NOT NULL,
        targetId TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        eventType TEXT,
        payloadPath TEXT,
        payloadEquals TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        FOREIGN KEY (endpointId) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_endpoint ON webhook_subscriptions(endpointId, enabled);
    CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_target ON webhook_subscriptions(targetKind, targetId);

    CREATE TABLE IF NOT EXISTS webhook_dispatches (
        id TEXT PRIMARY KEY,
        eventId TEXT NOT NULL,
        subscriptionId TEXT,
        targetKind TEXT NOT NULL,
        targetId TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        runSummary TEXT,
        conversationId TEXT,
        queueSequence INTEGER NOT NULL DEFAULT 0,
        attemptCount INTEGER NOT NULL DEFAULT 0,
        nextAttemptAt INTEGER,
        claimedAt INTEGER,
        startedAt INTEGER NOT NULL,
        endedAt INTEGER,
        FOREIGN KEY (eventId) REFERENCES webhook_events(id) ON DELETE CASCADE,
        FOREIGN KEY (subscriptionId) REFERENCES webhook_subscriptions(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_dispatches_event ON webhook_dispatches(eventId, startedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_webhook_dispatches_target ON webhook_dispatches(targetKind, targetId, startedAt DESC);
`)

/** Additive compatibility migration for databases created before dispatches
 * became a durable queue. This is invoked on every active profile before a
 * queue operation because feature modules are cached while profile DBs are
 * opened lazily. */
function ensureWebhookDispatchQueueSchema(): void {
    const columns = db.pragma('table_info(webhook_dispatches)') as Array<{ name: string }>
    const names = new Set(columns.map((column) => column.name))
    const additions = [
        ['queueSequence', 'INTEGER NOT NULL DEFAULT 0'],
        ['attemptCount', 'INTEGER NOT NULL DEFAULT 0'],
        ['nextAttemptAt', 'INTEGER'],
        ['claimedAt', 'INTEGER'],
    ] as const
    for (const [name, definition] of additions) {
        if (!names.has(name)) db.exec(`ALTER TABLE webhook_dispatches ADD COLUMN ${name} ${definition}`)
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_webhook_dispatches_queue ON webhook_dispatches(targetKind, targetId, status, queueSequence)')
}

ensureWebhookDispatchQueueSchema()

const RESERVED_SLUGS = new Set(['subscriptions'])

interface WebhookEndpointRow {
    id: string
    slug: string
    title: string
    description: string | null
    source: string
    defaultEventType: string | null
    enabled: number
    authMode: string
    secret: string | null
    hmacToleranceSeconds: number
    rateLimitPerMinute: number
    retentionDays: number
    createdBy: string
    createdAt: number
    updatedAt: number
}

interface WebhookEventRow {
    id: string
    endpointId: string
    slug: string
    source: string
    eventType: string
    dedupeKey: string
    payload: string
    normalized: string
    status: string
    error: string | null
    occurredAt: number
    receivedAt: number
    processedAt: number | null
}

interface WebhookSubscriptionRow {
    id: string
    endpointId: string
    targetKind: string
    targetId: string
    enabled: number
    eventType: string | null
    payloadPath: string | null
    payloadEquals: string | null
    createdAt: number
    updatedAt: number
}

interface WebhookDispatchRow {
    id: string
    eventId: string
    subscriptionId: string | null
    targetKind: string
    targetId: string
    status: string
    error: string | null
    runSummary: string | null
    conversationId: string | null
    queueSequence: number
    attemptCount: number
    nextAttemptAt: number | null
    claimedAt: number | null
    startedAt: number
    endedAt: number | null
}

function emitWebhooksChanged(endpointId: string | undefined, reason: string): void {
    emitAppEvent({ type: 'webhooks.changed', endpointId, reason })
}

function emitWebhookEventsChanged(endpointId: string | undefined, eventId?: string): void {
    emitAppEvent({ type: 'webhook_events.changed', endpointId, eventId })
}

function parseJsonObject(raw: string): Record<string, unknown> {
    // Degrade a corrupt row to an empty payload instead of failing the
    // whole event listing.
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return {}
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
}

function parseJsonUnknown(raw: string | null): unknown | null {
    if (raw === null) return null
    return JSON.parse(raw) as unknown
}

function endpointFromRow(row: WebhookEndpointRow): WebhookEndpoint {
    return WebhookEndpointSchema.parse({
        ...row,
        enabled: row.enabled === 1,
        description: row.description ?? null,
        defaultEventType: row.defaultEventType ?? null,
        secret: row.secret ?? null,
    })
}

function eventFromRow(row: WebhookEventRow): WebhookEvent {
    return WebhookEventSchema.parse({
        ...row,
        payload: parseJsonObject(row.payload),
        normalized: parseJsonObject(row.normalized),
        error: row.error ?? null,
        processedAt: row.processedAt ?? null,
    })
}

function subscriptionFromRow(row: WebhookSubscriptionRow): WebhookSubscription {
    return WebhookSubscriptionSchema.parse({
        ...row,
        enabled: row.enabled === 1,
        eventType: row.eventType ?? null,
        payloadPath: row.payloadPath ?? null,
        payloadEquals: parseJsonUnknown(row.payloadEquals),
    })
}

function dispatchFromRow(row: WebhookDispatchRow): WebhookDispatch {
    return {
        ...row,
        status: row.status as WebhookDispatch['status'],
        targetKind: row.targetKind as WebhookDispatch['targetKind'],
        error: row.error ?? null,
        runSummary: row.runSummary ?? null,
        conversationId: row.conversationId ?? null,
        queueSequence: row.queueSequence ?? 0,
        attemptCount: row.attemptCount ?? 0,
        nextAttemptAt: row.nextAttemptAt ?? null,
        claimedAt: row.claimedAt ?? null,
        endedAt: row.endedAt ?? null,
    }
}

function generateSecret(): string {
    return `whsec_${randomBytes(32).toString('base64url')}`
}

function secretPreview(secret: string | null): string | null {
    if (!secret) return null
    if (secret.length <= 10) return 'configured'
    return `${secret.slice(0, 6)}...${secret.slice(-4)}`
}

function requireSecretForAuth(authMode: WebhookEndpoint['authMode'], secret: string | null): void {
    if (authMode !== 'none' && !secret) {
        throw new Error(`Webhook authMode "${authMode}" requires a secret.`)
    }
}

function publicEndpoint(endpoint: WebhookEndpoint): WebhookEndpointPublic {
    return {
        id: endpoint.id,
        slug: endpoint.slug,
        title: endpoint.title,
        description: endpoint.description,
        source: endpoint.source,
        defaultEventType: endpoint.defaultEventType,
        enabled: endpoint.enabled,
        authMode: endpoint.authMode,
        hmacToleranceSeconds: endpoint.hmacToleranceSeconds,
        rateLimitPerMinute: endpoint.rateLimitPerMinute,
        retentionDays: endpoint.retentionDays,
        createdBy: endpoint.createdBy,
        createdAt: endpoint.createdAt,
        updatedAt: endpoint.updatedAt,
        secretConfigured: Boolean(endpoint.secret),
        secretPreview: secretPreview(endpoint.secret),
    }
}

export function toPublicWebhookEndpoint(endpoint: WebhookEndpoint): WebhookEndpointPublic {
    return publicEndpoint(endpoint)
}

export function createWebhookEndpoint(input: WebhookEndpointCreateInput, createdBy: WebhookEndpoint['createdBy'] = 'user'): {
    endpoint: WebhookEndpoint
    generatedSecret: string | null
} {
    const parsed = WebhookEndpointCreateInputSchema.parse(input)
    if (RESERVED_SLUGS.has(parsed.slug)) {
        throw new Error(`Webhook slug "${parsed.slug}" is reserved.`)
    }
    const now = Date.now()
    const secret = parsed.authMode === 'none'
        ? null
        : parsed.secret ?? generateSecret()
    requireSecretForAuth(parsed.authMode, secret)

    const endpoint: WebhookEndpoint = {
        id: `wh_${randomUUID()}`,
        slug: parsed.slug,
        title: parsed.title,
        description: parsed.description ?? null,
        source: parsed.source?.trim() || parsed.slug,
        defaultEventType: parsed.defaultEventType ?? null,
        enabled: parsed.enabled,
        authMode: parsed.authMode,
        secret,
        hmacToleranceSeconds: parsed.hmacToleranceSeconds,
        rateLimitPerMinute: parsed.rateLimitPerMinute,
        retentionDays: parsed.retentionDays,
        createdBy,
        createdAt: now,
        updatedAt: now,
    }

    const profileId = getActiveProfileId()
    assertProfileWebhookSlugAvailable(endpoint.slug, profileId, endpoint.id)
    assertWebhookSlugNotUsedByAnotherProfile(endpoint.slug, profileId)

    db.prepare(
        `
        INSERT INTO webhook_endpoints (
            id, slug, title, description, source, defaultEventType, enabled,
            authMode, secret, hmacToleranceSeconds, rateLimitPerMinute,
            retentionDays, createdBy, createdAt, updatedAt
        ) VALUES (
            @id, @slug, @title, @description, @source, @defaultEventType, @enabled,
            @authMode, @secret, @hmacToleranceSeconds, @rateLimitPerMinute,
            @retentionDays, @createdBy, @createdAt, @updatedAt
        )
        `,
    ).run({
        ...endpoint,
        enabled: endpoint.enabled ? 1 : 0,
    })

    try {
        registerProfileWebhookSlugOwner({
            slug: endpoint.slug,
            profileId,
            endpointId: endpoint.id,
        })
    } catch (err) {
        db.prepare('DELETE FROM webhook_endpoints WHERE id = ?').run(endpoint.id)
        throw err
    }

    emitWebhooksChanged(endpoint.id, 'created')
    return {
        endpoint,
        generatedSecret: parsed.secret ? null : secret,
    }
}

function assertWebhookSlugNotUsedByAnotherProfile(slug: string, profileId: string): void {
    for (const profile of listProfiles({ includeDisabled: true })) {
        if (profile.id === profileId) continue
        const existing = runWithProfileContext(
            { profileId: profile.id, role: profile.role },
            () => db
                .prepare('SELECT id FROM webhook_endpoints WHERE lower(slug) = lower(?)')
                .get(slug) as { id: string } | undefined,
        )
        if (existing) {
            throw new Error(`Webhook slug "${slug}" is already owned by another profile.`)
        }
    }
}

export function listWebhookEndpoints(): WebhookEndpoint[] {
    const rows = db
        .prepare('SELECT * FROM webhook_endpoints ORDER BY updatedAt DESC')
        .all() as WebhookEndpointRow[]
    return rows.map(endpointFromRow)
}

export function getWebhookEndpoint(id: string): WebhookEndpoint | null {
    const row = db
        .prepare('SELECT * FROM webhook_endpoints WHERE id = ?')
        .get(id) as WebhookEndpointRow | undefined
    return row ? endpointFromRow(row) : null
}

export function getWebhookEndpointBySlug(slug: string): WebhookEndpoint | null {
    const row = db
        .prepare('SELECT * FROM webhook_endpoints WHERE lower(slug) = lower(?)')
        .get(slug) as WebhookEndpointRow | undefined
    return row ? endpointFromRow(row) : null
}

export function getWebhookEndpointByIdOrSlug(value: string): WebhookEndpoint | null {
    const row = db
        .prepare('SELECT * FROM webhook_endpoints WHERE id = ? OR lower(slug) = lower(?)')
        .get(value, value) as WebhookEndpointRow | undefined
    return row ? endpointFromRow(row) : null
}

export function updateWebhookEndpoint(idOrSlug: string, patch: WebhookEndpointUpdateInput): {
    endpoint: WebhookEndpoint
    generatedSecret: string | null
} | null {
    const current = getWebhookEndpointByIdOrSlug(idOrSlug)
    if (!current) return null
    const parsed = WebhookEndpointUpdateInputSchema.parse(patch)
    const authMode = parsed.authMode ?? current.authMode
    const generatedSecret = parsed.rotateSecret ? generateSecret() : null
    const secret = authMode === 'none'
        ? null
        : parsed.secret ?? generatedSecret ?? current.secret
    requireSecretForAuth(authMode, secret)

    const endpoint: WebhookEndpoint = {
        ...current,
        title: parsed.title ?? current.title,
        description: parsed.description === undefined ? current.description : parsed.description,
        source: parsed.source === undefined ? current.source : parsed.source ?? current.slug,
        defaultEventType: parsed.defaultEventType === undefined ? current.defaultEventType : parsed.defaultEventType,
        enabled: parsed.enabled ?? current.enabled,
        authMode,
        secret,
        hmacToleranceSeconds: parsed.hmacToleranceSeconds ?? current.hmacToleranceSeconds,
        rateLimitPerMinute: parsed.rateLimitPerMinute ?? current.rateLimitPerMinute,
        retentionDays: parsed.retentionDays ?? current.retentionDays,
        updatedAt: Date.now(),
    }

    db.prepare(
        `
        UPDATE webhook_endpoints
        SET title = @title,
            description = @description,
            source = @source,
            defaultEventType = @defaultEventType,
            enabled = @enabled,
            authMode = @authMode,
            secret = @secret,
            hmacToleranceSeconds = @hmacToleranceSeconds,
            rateLimitPerMinute = @rateLimitPerMinute,
            retentionDays = @retentionDays,
            updatedAt = @updatedAt
        WHERE id = @id
        `,
    ).run({
        ...endpoint,
        enabled: endpoint.enabled ? 1 : 0,
    })

    emitWebhooksChanged(endpoint.id, 'updated')
    const updated = getWebhookEndpoint(endpoint.id)
    if (!updated) throw new Error(`Failed to reload webhook endpoint ${endpoint.id}.`)
    return { endpoint: updated, generatedSecret }
}

export function deleteWebhookEndpoint(idOrSlug: string): boolean {
    const endpoint = getWebhookEndpointByIdOrSlug(idOrSlug)
    if (!endpoint) return false
    const result = db.prepare('DELETE FROM webhook_endpoints WHERE id = ?').run(endpoint.id)
    if (result.changes > 0) {
        unregisterProfileWebhookSlugOwner(endpoint.slug, endpoint.id)
        emitWebhooksChanged(endpoint.id, 'deleted')
        return true
    }
    return false
}

export function createWebhookEvent(input: WebhookEventIngestInput): {
    event: WebhookEvent
    duplicate: boolean
} {
    const parsed = WebhookEventIngestInputSchema.parse(input)
    const now = Date.now()
    const id = `whe_${randomUUID()}`
    const normalized = parsed.normalized

    const tx = db.transaction(() => {
        const result = db.prepare(
            `
            INSERT OR IGNORE INTO webhook_events (
                id, endpointId, slug, source, eventType, dedupeKey, payload,
                normalized, status, error, occurredAt, receivedAt, processedAt
            ) VALUES (
                @id, @endpointId, @slug, @source, @eventType, @dedupeKey, @payload,
                @normalized, 'received', NULL, @occurredAt, @receivedAt, NULL
            )
            `,
        ).run({
            id,
            endpointId: parsed.endpointId,
            slug: parsed.slug,
            source: normalized.source,
            eventType: normalized.eventType,
            dedupeKey: parsed.dedupeKey,
            payload: JSON.stringify(parsed.payload),
            normalized: JSON.stringify(normalized),
            occurredAt: normalized.occurredAt,
            receivedAt: now,
        })
        pruneEndpointEvents(parsed.endpointId, now)
        const row = db.prepare(
            'SELECT * FROM webhook_events WHERE endpointId = ? AND dedupeKey = ?',
        ).get(parsed.endpointId, parsed.dedupeKey) as WebhookEventRow | undefined
        if (!row) throw new Error('Failed to persist webhook event.')
        return { event: eventFromRow(row), duplicate: result.changes === 0 }
    })

    const out = tx()
    emitWebhookEventsChanged(out.event.endpointId, out.event.id)
    return out
}

function pruneEndpointEvents(endpointId: string, now: number): void {
    const endpoint = getWebhookEndpoint(endpointId)
    if (!endpoint) return
    const cutoff = now - endpoint.retentionDays * 24 * 60 * 60_000
    db.prepare(
        `
        DELETE FROM webhook_events
        WHERE endpointId = @endpointId
          AND receivedAt < @cutoff
        `,
    ).run({ endpointId, cutoff })
}

export function getWebhookEvent(id: string): WebhookEvent | null {
    const row = db
        .prepare('SELECT * FROM webhook_events WHERE id = ?')
        .get(id) as WebhookEventRow | undefined
    return row ? eventFromRow(row) : null
}

export function listWebhookEvents(endpointIdOrSlug?: string, limit = 100): WebhookEvent[] {
    const capped = Math.max(1, Math.min(500, Math.floor(limit)))
    if (!endpointIdOrSlug) {
        const rows = db
            .prepare('SELECT * FROM webhook_events ORDER BY receivedAt DESC, id DESC LIMIT ?')
            .all(capped) as WebhookEventRow[]
        return rows.map(eventFromRow)
    }
    const endpoint = getWebhookEndpointByIdOrSlug(endpointIdOrSlug)
    if (!endpoint) return []
    const rows = db
        .prepare(
            `
            SELECT * FROM webhook_events
            WHERE endpointId = ?
            ORDER BY receivedAt DESC, id DESC
            LIMIT ?
            `,
        )
        .all(endpoint.id, capped) as WebhookEventRow[]
    return rows.map(eventFromRow)
}

export function setWebhookEventStatus(
    eventId: string,
    status: WebhookEventStatus,
    error: string | null = null,
): WebhookEvent | null {
    const processedAt = ['processed', 'duplicate', 'error'].includes(status) ? Date.now() : null
    db.prepare(
        `
        UPDATE webhook_events
        SET status = @status,
            error = @error,
            processedAt = COALESCE(@processedAt, processedAt)
        WHERE id = @eventId
        `,
    ).run({ eventId, status, error, processedAt })
    const event = getWebhookEvent(eventId)
    if (event) emitWebhookEventsChanged(event.endpointId, event.id)
    return event
}

export function createWebhookSubscription(input: WebhookSubscriptionCreateInput): WebhookSubscription {
    const parsed = WebhookSubscriptionCreateInputSchema.parse(input)
    const endpoint = getWebhookEndpointByIdOrSlug(parsed.endpointId)
    if (!endpoint) throw new Error(`Webhook endpoint ${parsed.endpointId} not found.`)
    const now = Date.now()
    const id = `whs_${randomUUID()}`
    db.prepare(
        `
        INSERT INTO webhook_subscriptions (
            id, endpointId, targetKind, targetId, enabled, eventType,
            payloadPath, payloadEquals, createdAt, updatedAt
        ) VALUES (
            @id, @endpointId, @targetKind, @targetId, @enabled, @eventType,
            @payloadPath, @payloadEquals, @createdAt, @updatedAt
        )
        `,
    ).run({
        id,
        endpointId: endpoint.id,
        targetKind: parsed.targetKind,
        targetId: parsed.targetId,
        enabled: parsed.enabled ? 1 : 0,
        eventType: parsed.eventType ?? null,
        payloadPath: parsed.payloadPath ?? null,
        payloadEquals: parsed.payloadEquals === undefined ? null : JSON.stringify(parsed.payloadEquals),
        createdAt: now,
        updatedAt: now,
    })
    emitWebhooksChanged(endpoint.id, 'subscription-created')
    const created = getWebhookSubscription(id)
    if (!created) throw new Error(`Failed to create webhook subscription ${id}.`)
    return created
}

export function getWebhookSubscription(id: string): WebhookSubscription | null {
    const row = db
        .prepare('SELECT * FROM webhook_subscriptions WHERE id = ?')
        .get(id) as WebhookSubscriptionRow | undefined
    return row ? subscriptionFromRow(row) : null
}

export function listWebhookSubscriptions(endpointIdOrSlug?: string): WebhookSubscription[] {
    if (!endpointIdOrSlug) {
        const rows = db
            .prepare('SELECT * FROM webhook_subscriptions ORDER BY updatedAt DESC')
            .all() as WebhookSubscriptionRow[]
        return rows.map(subscriptionFromRow)
    }
    const endpoint = getWebhookEndpointByIdOrSlug(endpointIdOrSlug)
    if (!endpoint) return []
    const rows = db
        .prepare('SELECT * FROM webhook_subscriptions WHERE endpointId = ? ORDER BY updatedAt DESC')
        .all(endpoint.id) as WebhookSubscriptionRow[]
    return rows.map(subscriptionFromRow)
}

export function listMatchingWebhookSubscriptions(event: WebhookEvent): WebhookSubscription[] {
    const rows = db
        .prepare(
            `
            SELECT * FROM webhook_subscriptions
            WHERE endpointId = @endpointId
              AND enabled = 1
              AND (eventType IS NULL OR eventType = @eventType)
            ORDER BY createdAt ASC
            `,
        )
        .all({ endpointId: event.endpointId, eventType: event.eventType }) as WebhookSubscriptionRow[]
    return rows
        .map(subscriptionFromRow)
        .filter((subscription) => subscriptionMatchesPayload(subscription, event.payload))
}

function subscriptionMatchesPayload(subscription: WebhookSubscription, payload: Record<string, unknown>): boolean {
    if (!subscription.payloadPath) return true
    const actual = getPathValue(payload, subscription.payloadPath)
    if (subscription.payloadEquals === null) return actual !== undefined
    return JSON.stringify(actual) === JSON.stringify(subscription.payloadEquals)
}

function getPathValue(root: unknown, path: string): unknown {
    let current = root
    for (const segment of path.split('.')) {
        if (!segment) return undefined
        if (Array.isArray(current) && /^\d+$/.test(segment)) {
            current = current[Number(segment)]
        } else if (current && typeof current === 'object') {
            current = (current as Record<string, unknown>)[segment]
        } else {
            return undefined
        }
    }
    return current
}

export function updateWebhookSubscription(id: string, patch: WebhookSubscriptionUpdateInput): WebhookSubscription | null {
    const current = getWebhookSubscription(id)
    if (!current) return null
    const parsed = WebhookSubscriptionUpdateInputSchema.parse(patch)
    const next: WebhookSubscription = {
        ...current,
        enabled: parsed.enabled ?? current.enabled,
        eventType: parsed.eventType === undefined ? current.eventType : parsed.eventType,
        payloadPath: parsed.payloadPath === undefined ? current.payloadPath : parsed.payloadPath,
        payloadEquals: parsed.payloadEquals === undefined ? current.payloadEquals : parsed.payloadEquals,
        updatedAt: Date.now(),
    }
    db.prepare(
        `
        UPDATE webhook_subscriptions
        SET enabled = @enabled,
            eventType = @eventType,
            payloadPath = @payloadPath,
            payloadEquals = @payloadEquals,
            updatedAt = @updatedAt
        WHERE id = @id
        `,
    ).run({
        id,
        enabled: next.enabled ? 1 : 0,
        eventType: next.eventType,
        payloadPath: next.payloadPath,
        payloadEquals: next.payloadEquals === null ? null : JSON.stringify(next.payloadEquals),
        updatedAt: next.updatedAt,
    })
    emitWebhooksChanged(next.endpointId, 'subscription-updated')
    return getWebhookSubscription(id)
}

export function deleteWebhookSubscription(id: string): boolean {
    const current = getWebhookSubscription(id)
    if (!current) return false
    const result = db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?').run(id)
    if (result.changes > 0) {
        emitWebhooksChanged(current.endpointId, 'subscription-deleted')
        return true
    }
    return false
}

export function recordWebhookDispatchStart(input: {
    eventId: string
    subscriptionId: string | null
    targetKind: WebhookDispatch['targetKind']
    targetId: string
    status?: WebhookDispatch['status']
}): WebhookDispatch {
    ensureWebhookDispatchQueueSchema()
    const queueSequence = nextWebhookDispatchQueueSequence(input.targetKind, input.targetId)
    const dispatch: WebhookDispatch = {
        id: `whd_${randomUUID()}`,
        eventId: input.eventId,
        subscriptionId: input.subscriptionId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        status: input.status ?? 'running',
        error: null,
        runSummary: null,
        conversationId: null,
        queueSequence,
        attemptCount: input.status === 'queued' ? 0 : 1,
        nextAttemptAt: input.status === 'queued' ? Date.now() : null,
        claimedAt: input.status === 'queued' ? null : Date.now(),
        startedAt: Date.now(),
        endedAt: null,
    }
    db.prepare(
        `
        INSERT INTO webhook_dispatches (
            id, eventId, subscriptionId, targetKind, targetId, status,
            error, runSummary, conversationId, queueSequence, attemptCount,
            nextAttemptAt, claimedAt, startedAt, endedAt
        ) VALUES (
            @id, @eventId, @subscriptionId, @targetKind, @targetId, @status,
            NULL, NULL, NULL, @queueSequence, @attemptCount,
            @nextAttemptAt, @claimedAt, @startedAt, NULL
        )
        `,
    ).run(dispatch)
    return dispatch
}

function nextWebhookDispatchQueueSequence(targetKind: WebhookDispatch['targetKind'], targetId: string): number {
    ensureWebhookDispatchQueueSchema()
    const row = db.prepare(
        'SELECT COALESCE(MAX(queueSequence), 0) AS maxSequence FROM webhook_dispatches WHERE targetKind = ? AND targetId = ?',
    ).get(targetKind, targetId) as { maxSequence: number } | undefined
    return (row?.maxSequence ?? 0) + 1
}

/** Idempotently enqueue one event/subscription delivery. Repeated dispatch of
 * the same persisted event reuses its original row and can never execute the
 * Microscript twice. */
export function enqueueWebhookDispatch(input: {
    eventId: string
    subscriptionId: string | null
    targetKind: WebhookDispatch['targetKind']
    targetId: string
}): { dispatch: WebhookDispatch; created: boolean } {
    ensureWebhookDispatchQueueSchema()
    const tx = db.transaction((): { dispatch: WebhookDispatch; created: boolean } => {
        const existing = db.prepare(
            `SELECT * FROM webhook_dispatches
             WHERE eventId = @eventId
               AND subscriptionId IS @subscriptionId
               AND targetKind = @targetKind
               AND targetId = @targetId
             ORDER BY startedAt ASC, id ASC
             LIMIT 1`,
        ).get(input) as WebhookDispatchRow | undefined
        if (existing) return { dispatch: dispatchFromRow(existing), created: false }
        return {
            dispatch: recordWebhookDispatchStart({ ...input, status: 'queued' }),
            created: true,
        }
    })
    return tx()
}

export type WebhookDispatchClaim =
    | { kind: 'claimed'; dispatch: WebhookDispatch }
    | { kind: 'waiting'; dispatch: WebhookDispatch; waitMs: number }
    | { kind: 'empty' }

/** Claim the oldest delivery for one target. A delayed retry remains at the
 * head of line so later webhook events cannot overtake it. */
export function claimNextQueuedWebhookDispatch(
    targetKind: WebhookDispatch['targetKind'],
    targetId: string,
    now = Date.now(),
): WebhookDispatchClaim {
    ensureWebhookDispatchQueueSchema()
    const tx = db.transaction((): WebhookDispatchClaim => {
        const row = db.prepare(
            `SELECT * FROM webhook_dispatches
             WHERE targetKind = @targetKind AND targetId = @targetId AND status = 'queued'
             ORDER BY queueSequence ASC, startedAt ASC, id ASC
             LIMIT 1`,
        ).get({ targetKind, targetId }) as WebhookDispatchRow | undefined
        if (!row) return { kind: 'empty' }
        const dispatch = dispatchFromRow(row)
        if (dispatch.nextAttemptAt !== null && dispatch.nextAttemptAt > now) {
            return { kind: 'waiting', dispatch, waitMs: dispatch.nextAttemptAt - now }
        }
        const result = db.prepare(
            `UPDATE webhook_dispatches
             SET status = 'running', attemptCount = attemptCount + 1,
                 claimedAt = @now, nextAttemptAt = NULL, error = NULL, endedAt = NULL
             WHERE id = @id AND status = 'queued'`,
        ).run({ id: dispatch.id, now })
        if (result.changes === 0) return { kind: 'empty' }
        const claimed = getWebhookDispatch(dispatch.id)
        return claimed ? { kind: 'claimed', dispatch: claimed } : { kind: 'empty' }
    })
    return tx()
}

export function requeueWebhookDispatch(id: string, input: {
    error: string
    nextAttemptAt: number
}): WebhookDispatch | null {
    ensureWebhookDispatchQueueSchema()
    db.prepare(
        `UPDATE webhook_dispatches
         SET status = 'queued', error = @error, nextAttemptAt = @nextAttemptAt,
             claimedAt = NULL, endedAt = NULL
         WHERE id = @id AND status = 'running'`,
    ).run({ id, error: input.error, nextAttemptAt: input.nextAttemptAt })
    return getWebhookDispatch(id)
}

/** Requeue deliveries interrupted by a process restart. Microscript boot
 * recovery runs first, turning its stale `running` row back into `error`, then
 * this queue resumes the same event without creating another delivery row. */
export function recoverInterruptedWebhookDispatches(now = Date.now()): WebhookDispatch[] {
    ensureWebhookDispatchQueueSchema()
    const rows = db.prepare("SELECT * FROM webhook_dispatches WHERE status = 'running'").all() as WebhookDispatchRow[]
    if (rows.length === 0) return []
    db.prepare(
        `UPDATE webhook_dispatches
         SET status = 'queued', error = 'Interrupted by process restart; queued for retry.',
             nextAttemptAt = @now, claimedAt = NULL, endedAt = NULL
         WHERE status = 'running'`,
    ).run({ now })
    for (const row of rows) {
        const event = getWebhookEvent(row.eventId)
        if (event) emitWebhookEventsChanged(event.endpointId, event.id)
    }
    return rows.map((row) => getWebhookDispatch(row.id)).filter((item): item is WebhookDispatch => item !== null)
}

export function listPendingWebhookDispatchTargets(): Array<{
    targetKind: WebhookDispatch['targetKind']
    targetId: string
}> {
    ensureWebhookDispatchQueueSchema()
    const rows = db.prepare(
        `SELECT targetKind, targetId, MIN(queueSequence) AS firstSequence
         FROM webhook_dispatches
         WHERE status = 'queued'
         GROUP BY targetKind, targetId
         ORDER BY firstSequence ASC, targetKind ASC, targetId ASC`,
    ).all() as Array<{ targetKind: WebhookDispatch['targetKind']; targetId: string }>
    return rows.map(({ targetKind, targetId }) => ({ targetKind, targetId }))
}

export function finishWebhookDispatch(
    id: string,
    patch: {
        status: WebhookDispatch['status']
        error?: string | null
        runSummary?: string | null
        conversationId?: string | null
    },
): WebhookDispatch | null {
    ensureWebhookDispatchQueueSchema()
    db.prepare(
        `
        UPDATE webhook_dispatches
        SET status = @status,
            error = @error,
            runSummary = @runSummary,
            conversationId = @conversationId,
            nextAttemptAt = NULL,
            endedAt = @endedAt
        WHERE id = @id
        `,
    ).run({
        id,
        status: patch.status,
        error: patch.error ?? null,
        runSummary: patch.runSummary ?? null,
        conversationId: patch.conversationId ?? null,
        endedAt: Date.now(),
    })
    return getWebhookDispatch(id)
}

export function getWebhookDispatch(id: string): WebhookDispatch | null {
    ensureWebhookDispatchQueueSchema()
    const row = db
        .prepare('SELECT * FROM webhook_dispatches WHERE id = ?')
        .get(id) as WebhookDispatchRow | undefined
    return row ? dispatchFromRow(row) : null
}

export function listWebhookDispatches(eventId: string): WebhookDispatch[] {
    ensureWebhookDispatchQueueSchema()
    const rows = db
        .prepare(
            `
            SELECT * FROM webhook_dispatches
            WHERE eventId = ?
            ORDER BY startedAt DESC, id DESC
            `,
        )
        .all(eventId) as WebhookDispatchRow[]
    return rows.map(dispatchFromRow)
}

/** Derive the parent event status from its durable delivery rows. This keeps
 * GET .../events?dispatches=1 trustworthy while work is queued, retrying,
 * recovered, or terminal. */
export function reconcileWebhookEventDispatchStatus(eventId: string): WebhookEvent | null {
    const event = getWebhookEvent(eventId)
    if (!event) return null
    const dispatches = listWebhookDispatches(eventId)
    if (dispatches.length === 0) return setWebhookEventStatus(eventId, 'processed')
    if (dispatches.some((dispatch) => dispatch.status === 'queued' || dispatch.status === 'running')) {
        return setWebhookEventStatus(eventId, 'processing')
    }
    const failures = dispatches.filter((dispatch) => dispatch.status === 'error')
    if (failures.length > 0) {
        return setWebhookEventStatus(
            eventId,
            'error',
            `${failures.length} webhook dispatch(es) failed: ${failures.map((dispatch) => dispatch.error ?? dispatch.id).join('; ')}`.slice(0, 2_000),
        )
    }
    return setWebhookEventStatus(eventId, 'processed')
}
