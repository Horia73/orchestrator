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
