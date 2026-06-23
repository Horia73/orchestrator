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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webhooks-smoke-'))
process.chdir(tmpRoot)

async function main(): Promise<void> {
    const {
        createWebhookEndpoint,
        createWebhookEvent,
        createWebhookSubscription,
        listWebhookDispatches,
        listWebhookEvents,
        toPublicWebhookEndpoint,
    } = await import('@/lib/webhooks/store')
    const { authenticateWebhookRequest } = await import('@/lib/webhooks/auth')
    const { computeWebhookDedupeKey, normalizeWebhookEvent } = await import('@/lib/webhooks/normalize')
    const { dispatchWebhookEvent } = await import('@/lib/webhooks/dispatch')
    const {
        createMicroscript,
        getMicroscript,
        listMicroscriptRuns,
    } = await import('@/lib/microscripts/store')
    const {
        executeWebhookCreate,
        executeWebhookList,
        executeWebhookSubscriptionCreate,
    } = await import('@/lib/ai/tools/webhooks')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (${JSON.stringify(detail)})`}`)
        if (!ok) failures++
    }

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

    console.log(`\n${failures === 0 ? '✅ ALL OK' : `❌ ${failures} failure(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error('Unhandled error in webhook smoke test:', err)
    process.exit(2)
})
