import {
    claimMicroscriptForWebhook,
    getMicroscript,
    recordMicroscriptEvent,
} from '@/lib/microscripts/store'
import { runMicroscript, type MicroscriptWebhookContext } from '@/lib/microscripts/runner'

import {
    finishWebhookDispatch,
    getWebhookEvent,
    listMatchingWebhookSubscriptions,
    listWebhookDispatches,
    recordWebhookDispatchStart,
    setWebhookEventStatus,
} from './store'
import type { WebhookDispatch, WebhookEvent } from './schema'

export interface WebhookDispatchResult {
    event: WebhookEvent
    dispatches: WebhookDispatch[]
}

export async function dispatchWebhookEvent(eventId: string): Promise<WebhookDispatchResult | null> {
    const event = getWebhookEvent(eventId)
    if (!event) return null

    setWebhookEventStatus(event.id, 'processing')
    const subscriptions = listMatchingWebhookSubscriptions(event)
    if (subscriptions.length === 0) {
        setWebhookEventStatus(event.id, 'processed')
        return { event, dispatches: [] }
    }

    let failures = 0
    for (const subscription of subscriptions) {
        const dispatch = recordWebhookDispatchStart({
            eventId: event.id,
            subscriptionId: subscription.id,
            targetKind: subscription.targetKind,
            targetId: subscription.targetId,
        })

        try {
            if (subscription.targetKind === 'microscript') {
                const outcome = await dispatchToMicroscript(event, subscription.targetId)
                finishWebhookDispatch(dispatch.id, {
                    status: outcome.ok ? 'ok' : 'error',
                    error: outcome.error ?? null,
                    runSummary: outcome.summary,
                    conversationId: outcome.conversationId,
                })
                if (!outcome.ok) failures += 1
            }
        } catch (err) {
            failures += 1
            finishWebhookDispatch(dispatch.id, {
                status: 'error',
                error: err instanceof Error ? err.message : String(err),
            })
        }
    }

    setWebhookEventStatus(
        event.id,
        failures > 0 ? 'error' : 'processed',
        failures > 0 ? `${failures} webhook dispatch(es) failed.` : null,
    )

    return {
        event: getWebhookEvent(event.id) ?? event,
        dispatches: listWebhookDispatches(event.id),
    }
}

async function dispatchToMicroscript(event: WebhookEvent, scriptId: string): Promise<{
    ok: boolean
    summary: string
    error?: string
    conversationId: string | null
}> {
    const exists = getMicroscript(scriptId)
    if (!exists) {
        return { ok: false, summary: `Microscript ${scriptId} not found.`, error: 'Microscript not found.', conversationId: null }
    }

    const script = claimMicroscriptForWebhook(scriptId, Date.now())
    if (!script) {
        return {
            ok: false,
            summary: `Microscript ${scriptId} is not currently runnable.`,
            error: 'Microscript is disabled, paused, completed, expired, or already running.',
            conversationId: null,
        }
    }

    recordMicroscriptEvent(script.id, 'webhook_triggered', {
        eventId: event.id,
        slug: event.slug,
        source: event.source,
        eventType: event.eventType,
    })

    const result = await runMicroscript(script, {
        trigger: 'webhook',
        webhook: webhookContext(event),
    })
    return {
        ok: result.ok,
        summary: result.summary,
        error: result.error,
        conversationId: result.conversationId,
    }
}

function webhookContext(event: WebhookEvent): MicroscriptWebhookContext {
    return {
        eventId: event.id,
        endpointId: event.endpointId,
        slug: event.slug,
        source: event.source,
        eventType: event.eventType,
        dedupeKey: event.dedupeKey,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
        payload: event.payload,
        normalized: event.normalized,
    }
}
