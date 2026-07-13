/**
 * Smoke test for generic inbound webhooks.
 *
 * Runs against a temporary DB/workspace. Validates:
 *   - endpoint create/list public shape does not expose the secret;
 *   - bearer auth accepts/rejects correctly;
 *   - event ingest dedupes on explicit idempotency key;
 *   - webhook subscriptions dispatch to Microscripts with ctx.webhook.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHmac } from 'crypto'
import Database from 'better-sqlite3'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webhooks-smoke-'))
process.chdir(tmpRoot)
// Seed the pre-queue dispatch shape so importing the store exercises the
// additive migration, not only fresh-database CREATE TABLE behavior.
fs.mkdirSync(path.join(tmpRoot, '.orchestrator'), { recursive: true })
const legacyDb = new Database(path.join(tmpRoot, '.orchestrator', 'data.db'))
legacyDb.exec(`
    CREATE TABLE webhook_dispatches (
        id TEXT PRIMARY KEY,
        eventId TEXT NOT NULL,
        subscriptionId TEXT,
        targetKind TEXT NOT NULL,
        targetId TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        runSummary TEXT,
        conversationId TEXT,
        startedAt INTEGER NOT NULL,
        endedAt INTEGER
    )
`)
legacyDb.close()

async function main(): Promise<void> {
    const {
        createWebhookEndpoint,
        createWebhookEvent,
        createWebhookSubscription,
        claimNextQueuedWebhookDispatch,
        enqueueWebhookDispatch,
        getWebhookEvent,
        listWebhookDispatches,
        listWebhookEvents,
        reconcileWebhookEventDispatchStatus,
        toPublicWebhookEndpoint,
    } = await import('@/lib/webhooks/store')
    const { authenticateWebhookRequest } = await import('@/lib/webhooks/auth')
    const { computeWebhookDedupeKey, normalizeWebhookEvent } = await import('@/lib/webhooks/normalize')
    const { dispatchWebhookEvent, recoverWebhookDispatchQueue } = await import('@/lib/webhooks/dispatch')
    const {
        createMicroscript,
        getMicroscript,
        listMicroscriptRuns,
        listMicroscriptEvents,
        claimMicroscriptForWebhook,
        setMicroscriptStatus,
    } = await import('@/lib/microscripts/store')
    const {
        executeWebhookCreate,
        executeWebhookList,
        executeWebhookSubscriptionCreate,
    } = await import('@/lib/ai/tools/webhooks')
    const db = (await import('@/lib/db')).default

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (${JSON.stringify(detail)})`}`)
        if (!ok) failures++
    }

    const dispatchColumns = new Set(
        (db.pragma('table_info(webhook_dispatches)') as Array<{ name: string }>).map((column) => column.name),
    )
    check('legacy dispatch table migrates queue metadata additively',
        ['queueSequence', 'attemptCount', 'nextAttemptAt', 'claimedAt'].every((name) => dispatchColumns.has(name)),
        [...dispatchColumns],
    )

    const secret = 'smoke-webhook-secret-value'
    const { endpoint } = createWebhookEndpoint({
        slug: 'smoke-events',
        title: 'Smoke events',
        source: 'smoke',
        defaultEventType: 'smoke.event',
        authMode: 'bearer',
        secret,
        retentionDays: 7,
    }, 'system')
    const publicEndpoint = toPublicWebhookEndpoint(endpoint)
    check('public endpoint masks secret', !('secret' in publicEndpoint) && publicEndpoint.secretConfigured === true, publicEndpoint)

    const rawBody = JSON.stringify({ event_type: 'smoke.event', value: 42, id: 'evt_smoke_1' })
    const badAuth = authenticateWebhookRequest(
        endpoint,
        new Request('http://localhost/api/webhooks/smoke-events', {
            method: 'POST',
            headers: { authorization: 'Bearer wrong' },
            body: rawBody,
        }),
        rawBody,
    )
    check('bearer auth rejects bad secret', badAuth.ok === false && badAuth.status === 401, badAuth)

    const request = new Request('http://localhost/api/webhooks/smoke-events', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${secret}`,
            'content-type': 'application/json',
            'idempotency-key': 'evt_smoke_1',
        },
        body: rawBody,
    })
    const goodAuth = authenticateWebhookRequest(endpoint, request, rawBody)
    check('bearer auth accepts valid secret', goodAuth.ok === true, goodAuth)

    const hmacSecret = 'shopify-compatible-hmac-secret'
    const { endpoint: hmacEndpoint } = createWebhookEndpoint({
        slug: 'shopify-events',
        title: 'Shopify events',
        source: 'shopify',
        defaultEventType: 'orders/create',
        authMode: 'hmac',
        secret: hmacSecret,
        retentionDays: 7,
    }, 'system')
    const shopifyRawBody = JSON.stringify({ id: 1001, topic: 'orders/create' })
    const shopifySignature = createHmac('sha256', hmacSecret).update(shopifyRawBody).digest('base64')
    const shopifyAuth = authenticateWebhookRequest(
        hmacEndpoint,
        new Request('http://localhost/api/webhooks/shopify-events', {
            method: 'POST',
            headers: { 'x-shopify-hmac-sha256': shopifySignature },
            body: shopifyRawBody,
        }),
        shopifyRawBody,
    )
    check('hmac auth accepts Shopify-style base64 signature', shopifyAuth.ok === true, shopifyAuth)

    const svixSecretBytes = Buffer.from('resend-svix-smoke-secret')
    const svixSecret = `whsec_${svixSecretBytes.toString('base64')}`
    const { endpoint: svixEndpoint } = createWebhookEndpoint({
        slug: 'resend-events',
        title: 'Resend events',
        source: 'resend',
        defaultEventType: 'email.received',
        authMode: 'svix',
        secret: svixSecret,
        retentionDays: 7,
    }, 'system')
    const svixRawBody = JSON.stringify({ type: 'email.received', data: { email_id: 'eml_123' } })
    const svixId = 'msg_resend_smoke_1'
    const svixTimestamp = String(Math.floor(Date.now() / 1000))
    const svixSignature = createHmac('sha256', svixSecretBytes)
        .update(`${svixId}.${svixTimestamp}.${svixRawBody}`)
        .digest('base64')
    const svixAuth = authenticateWebhookRequest(
        svixEndpoint,
        new Request('http://localhost/api/webhooks/resend-events', {
            method: 'POST',
            headers: {
                'svix-id': svixId,
                'svix-timestamp': svixTimestamp,
                'svix-signature': `v1,${svixSignature}`,
            },
            body: svixRawBody,
        }),
        svixRawBody,
    )
    check('svix auth accepts Resend/Svix signature', svixAuth.ok === true, svixAuth)

    const payload = JSON.parse(rawBody) as Record<string, unknown>
    const normalized = normalizeWebhookEvent(endpoint, request, payload)
    const dedupeKey = computeWebhookDedupeKey(endpoint, request, rawBody, payload, normalized)
    const first = createWebhookEvent({
        endpointId: endpoint.id,
        slug: endpoint.slug,
        payload,
        dedupeKey,
        normalized,
    })
    const duplicate = createWebhookEvent({
        endpointId: endpoint.id,
        slug: endpoint.slug,
        payload,
        dedupeKey,
        normalized,
    })
    check('first event is not duplicate', first.duplicate === false, first)
    check('second event dedupes to same row', duplicate.duplicate === true && duplicate.event.id === first.event.id, duplicate)
    check('event list contains one event', listWebhookEvents(endpoint.id).length === 1)

    const code = `
def run(ctx):
    webhook = ctx.get("webhook") or {}
    payload = webhook.get("payload") or {}
    return {
        "summary": "webhook " + str(webhook.get("eventType")),
        "state": {
            "event_id": webhook.get("eventId"),
            "event_type": webhook.get("eventType"),
            "value": payload.get("value")
        },
        "status": "complete"
    }
`.trim()
    const script = createMicroscript({
        title: 'Webhook smoke microscript',
        code,
        enabled: true,
        manifest: {
            description: 'Smoke webhook trigger test',
            schedule: { kind: 'manual' },
            permissions: [],
            stop: { persistent: true, expiresAt: null },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    const subscription = createWebhookSubscription({
        endpointId: endpoint.id,
        targetKind: 'microscript',
        targetId: script.id,
        eventType: 'smoke.event',
    })
    check('subscription created', subscription.id.startsWith('whs_'), subscription)

    const toolEndpoint = executeWebhookCreate({
        title: 'Tool-created webhook',
        slug: 'tool-events',
        source: 'tool',
        default_event_type: 'tool.event',
        auth_mode: 'svix',
        secret: svixSecret,
    })
    check(
        'webhook_create tool creates endpoint without echoing supplied secret',
        toolEndpoint.success === true && !(toolEndpoint.data as { secret?: string }).secret,
        toolEndpoint,
    )
    const toolSubscription = executeWebhookSubscriptionCreate({
        endpoint_id_or_slug: 'tool-events',
        target_id: script.id,
        event_type: 'tool.event',
        payload_path: 'data.status',
        payload_equals_json: '"paid"',
    })
    check(
        'webhook_subscription_create tool supports scalar payload_equals_json',
        toolSubscription.success === true
            && (toolSubscription.data as { subscription?: { payloadEquals?: unknown } }).subscription?.payloadEquals === 'paid',
        toolSubscription,
    )
    const toolList = executeWebhookList()
    check(
        'webhook_list tool includes public endpoints',
        toolList.success === true
            && Array.isArray((toolList.data as { endpoints?: unknown[] }).endpoints)
            && ((toolList.data as { endpoints?: Array<{ slug?: string; secret?: string }> }).endpoints ?? []).some((item) => item.slug === 'tool-events' && !('secret' in item)),
        toolList,
    )

    const dispatched = await dispatchWebhookEvent(first.event.id)
    const afterScript = getMicroscript(script.id)
    const runs = listMicroscriptRuns(script.id)
    const dispatches = listWebhookDispatches(first.event.id)
    check('dispatch returns result', dispatched !== null && dispatched.dispatches.length === 1, dispatched)
    check('microscript received ctx.webhook payload', afterScript?.state.value === 42 && afterScript.state.event_type === 'smoke.event', afterScript)
    check('microscript run trigger recorded as webhook', runs[0]?.trigger === 'webhook', runs[0])
    check('dispatch row is ok', dispatches[0]?.status === 'ok', dispatches[0])

    // ---------------------------------------------------------------------
    // Durable serial queue: burst ordering, contention retry, idempotency,
    // interrupted-row recovery, and queue/history readback.
    // ---------------------------------------------------------------------
    const { endpoint: queueEndpoint } = createWebhookEndpoint({
        slug: 'queue-events',
        title: 'Queued webhook events',
        source: 'queue-smoke',
        defaultEventType: 'queue.event',
        authMode: 'none',
        retentionDays: 7,
    }, 'system')
    const queueCode = `
def run(ctx):
    state = dict(ctx.get("state", {}))
    order = list(state.get("order", []))
    webhook = ctx.get("webhook") or {}
    payload = webhook.get("payload") or {}
    order.append(payload.get("sequence"))
    state["order"] = order
    state["last_event_id"] = webhook.get("eventId")
    return {"summary": "queued " + str(payload.get("sequence")), "state": state}
`.trim()
    const queueScript = createMicroscript({
        title: 'Queued webhook smoke microscript',
        code: queueCode,
        enabled: true,
        manifest: {
            description: 'Durable webhook queue test',
            schedule: { kind: 'manual' },
            permissions: [],
            stop: { persistent: true, expiresAt: null },
            limits: { timeoutMs: 5_000, maxPhases: 4, minIntervalMs: 60_000, maxConsecutiveFailures: 3 },
        },
    })
    const queueSubscription = createWebhookSubscription({
        endpointId: queueEndpoint.id,
        targetKind: 'microscript',
        targetId: queueScript.id,
        eventType: 'queue.event',
    })

    let queueEventCounter = 0
    function queueEvent(sequence: number, suffix = '') {
        queueEventCounter += 1
        const now = Date.now()
        return createWebhookEvent({
            endpointId: queueEndpoint.id,
            slug: queueEndpoint.slug,
            payload: { sequence },
            dedupeKey: `queue-${sequence}-${suffix}-${queueEventCounter}`,
            normalized: {
                source: queueEndpoint.source,
                eventType: 'queue.event',
                subject: null,
                actor: null,
                occurredAt: now,
                summary: `queue event ${sequence}`,
                metadata: {},
            },
        }).event
    }

    const burst = [queueEvent(1, 'burst'), queueEvent(2, 'burst'), queueEvent(3, 'burst')]
    await Promise.all(burst.map((event) => dispatchWebhookEvent(event.id)))
    const afterBurst = getMicroscript(queueScript.id)
    check('burst of 3 events processes fully in stable order', JSON.stringify(afterBurst?.state.order) === JSON.stringify([1, 2, 3]), afterBurst?.state)
    check('burst creates one webhook-triggered run per event', listMicroscriptRuns(queueScript.id).filter((run) => run.trigger === 'webhook').length === 3)
    const burstRows = burst.flatMap((event) => listWebhookDispatches(event.id))
    check('burst dispatch rows all settle ok', burstRows.length === 3 && burstRows.every((row) => row.status === 'ok'), burstRows)
    check('burst queue sequence is strictly increasing', burstRows.map((row) => row.queueSequence).every((value, index, values) => index === 0 || value > values[index - 1]), burstRows)

    const held = claimMicroscriptForWebhook(queueScript.id, Date.now())
    check('contention harness claims Microscript as already running', held?.id === queueScript.id)
    const contentionEvent = queueEvent(4, 'contention')
    const release = setTimeout(() => {
        setMicroscriptStatus(queueScript.id, 'active', { reason: 'smoke contention released' })
    }, 250)
    await dispatchWebhookEvent(contentionEvent.id)
    clearTimeout(release)
    const contentionDispatch = listWebhookDispatches(contentionEvent.id)[0]
    check('already-running contention eventually processes without loss', contentionDispatch?.status === 'ok' && getMicroscript(queueScript.id)?.state.last_event_id === contentionEvent.id, contentionDispatch)
    check('already-running contention used persisted retry attempts', (contentionDispatch?.attemptCount ?? 0) >= 2, contentionDispatch)
    check('Microscript history exposes queued retry', listMicroscriptEvents(queueScript.id).some((event) => event.kind === 'webhook_retry_queued'))

    const duplicateEvent = queueEvent(5, 'duplicate-dispatch')
    const runsBeforeDuplicate = listMicroscriptRuns(queueScript.id).length
    await Promise.all([dispatchWebhookEvent(duplicateEvent.id), dispatchWebhookEvent(duplicateEvent.id)])
    check('duplicate dispatch calls share one persisted row', listWebhookDispatches(duplicateEvent.id).length === 1, listWebhookDispatches(duplicateEvent.id))
    check('duplicate dispatch calls execute only once', listMicroscriptRuns(queueScript.id).length === runsBeforeDuplicate + 1)

    const restartEvent = queueEvent(6, 'restart')
    const queuedForRestart = enqueueWebhookDispatch({
        eventId: restartEvent.id,
        subscriptionId: queueSubscription.id,
        targetKind: 'microscript',
        targetId: queueScript.id,
    }).dispatch
    reconcileWebhookEventDispatchStatus(restartEvent.id)
    const interruptedClaim = claimNextQueuedWebhookDispatch('microscript', queueScript.id, Date.now())
    check('restart harness leaves persisted dispatch running', interruptedClaim.kind === 'claimed' && interruptedClaim.dispatch.id === queuedForRestart.id, interruptedClaim)
    const recovered = await recoverWebhookDispatchQueue()
    const restartDispatch = listWebhookDispatches(restartEvent.id)[0]
    check('restart recovery finds interrupted delivery', recovered.recovered >= 1, recovered)
    check('restart recovery resumes and completes queue', restartDispatch?.status === 'ok' && getMicroscript(queueScript.id)?.state.last_event_id === restartEvent.id, restartDispatch)
    check('event readback is processed after recovery', getWebhookEvent(restartEvent.id)?.status === 'processed', getWebhookEvent(restartEvent.id))
    check('dispatch readback exposes attempts/order/claim history',
        typeof restartDispatch?.queueSequence === 'number'
            && (restartDispatch?.attemptCount ?? 0) >= 2
            && typeof restartDispatch?.claimedAt === 'number'
            && restartDispatch?.nextAttemptAt === null,
        restartDispatch,
    )

    console.log(`\n${failures === 0 ? '✅ ALL OK' : `❌ ${failures} failure(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error('Unhandled error in webhook smoke test:', err)
    process.exit(2)
})
