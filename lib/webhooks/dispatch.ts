import {
    claimMicroscriptForWebhook,
    getMicroscript,
    recordMicroscriptEvent,
} from '@/lib/microscripts/store'
import { runMicroscript, type MicroscriptWebhookContext } from '@/lib/microscripts/runner'
import { getActiveProfileId, runWithProfileContext } from '@/lib/profiles/context'
import { canRunBackgroundLoop } from '@/lib/ai/background-leadership'

import {
    claimNextQueuedWebhookDispatch,
    enqueueWebhookDispatch,
    finishWebhookDispatch,
    getWebhookDispatch,
    getWebhookEvent,
    listMatchingWebhookSubscriptions,
    listPendingWebhookDispatchTargets,
    listWebhookDispatches,
    reconcileWebhookEventDispatchStatus,
    recoverInterruptedWebhookDispatches,
    requeueWebhookDispatch,
    setWebhookEventStatus,
} from './store'
import type { WebhookDispatch, WebhookEvent } from './schema'

const RETRY_BASE_MS = 100
const RETRY_MAX_MS = 5_000
const QUEUE_SWEEP_MS = 5_000

interface DispatchTarget {
    targetKind: WebhookDispatch['targetKind']
    targetId: string
}

export interface WebhookDispatchResult {
    event: WebhookEvent
    dispatches: WebhookDispatch[]
}

const globalForQueue = globalThis as unknown as {
    __orchestratorWebhookDispatchWorkers?: Map<string, Promise<void>>
    __orchestratorWebhookDispatchSweep?: ReturnType<typeof setInterval>
}

const targetWorkers = globalForQueue.__orchestratorWebhookDispatchWorkers ?? new Map<string, Promise<void>>()
if (!globalForQueue.__orchestratorWebhookDispatchWorkers) {
    globalForQueue.__orchestratorWebhookDispatchWorkers = targetWorkers
}

/** Persist matching deliveries first, then wait for their per-Microscript
 * serial workers. The public route intentionally calls this fire-and-forget,
 * while tests/internal callers may await terminal readback. Repeating this
 * function for the same event is idempotent. */
export async function dispatchWebhookEvent(eventId: string): Promise<WebhookDispatchResult | null> {
    const event = getWebhookEvent(eventId)
    if (!event) return null

    const subscriptions = listMatchingWebhookSubscriptions(event)
    if (subscriptions.length === 0) {
        setWebhookEventStatus(event.id, 'processed')
        return { event: getWebhookEvent(event.id) ?? event, dispatches: [] }
    }

    const dispatchIds: string[] = []
    const targets = new Map<string, DispatchTarget>()
    for (const subscription of subscriptions) {
        const queued = enqueueWebhookDispatch({
            eventId: event.id,
            subscriptionId: subscription.id,
            targetKind: subscription.targetKind,
            targetId: subscription.targetId,
        })
        dispatchIds.push(queued.dispatch.id)
        const target = { targetKind: subscription.targetKind, targetId: subscription.targetId }
        targets.set(targetKey(getActiveProfileId(), target), target)
        if (queued.created && subscription.targetKind === 'microscript' && getMicroscript(subscription.targetId)) {
            recordMicroscriptEvent(subscription.targetId, 'webhook_queued', {
                eventId: event.id,
                dispatchId: queued.dispatch.id,
                queueSequence: queued.dispatch.queueSequence,
                eventType: event.eventType,
            })
        }
    }

    reconcileWebhookEventDispatchStatus(event.id)
    if (!canRunBackgroundLoop()) {
        return {
            event: getWebhookEvent(event.id) ?? event,
            dispatches: listWebhookDispatches(event.id),
        }
    }
    await waitForDispatches(dispatchIds, [...targets.values()])

    return {
        event: getWebhookEvent(event.id) ?? event,
        dispatches: listWebhookDispatches(event.id),
    }
}

async function waitForDispatches(ids: string[], targets: DispatchTarget[]): Promise<void> {
    // A worker obtained just as it was settling may not see a concurrently
    // enqueued row. Re-check after every worker promise until all requested
    // rows are terminal; enqueue idempotency ensures this never duplicates a
    // run.
    while (ids.some((id) => {
        const status = getWebhookDispatch(id)?.status
        return status === 'queued' || status === 'running'
    })) {
        await Promise.all(targets.map((target) => kickWebhookDispatchTarget(target)))
    }
}

export function kickWebhookDispatchTarget(target: DispatchTarget): Promise<void> {
    if (!canRunBackgroundLoop()) return Promise.resolve()
    const profileId = getActiveProfileId()
    const key = targetKey(profileId, target)
    const existing = targetWorkers.get(key)
    if (existing) return existing

    const worker = runWithProfileContext(
        { profileId },
        () => drainWebhookDispatchTarget(target),
    ).catch((err) => {
        console.error(`[webhooks] dispatch worker failed for ${target.targetKind}:${target.targetId}`, err)
    }).finally(() => {
        targetWorkers.delete(key)
        // Cover the enqueue-vs-finally race without polling latency.
        if (runWithProfileContext({ profileId }, () => hasPendingTarget(target))) {
            queueMicrotask(() => {
                void runWithProfileContext({ profileId }, () => kickWebhookDispatchTarget(target))
            })
        }
    })
    targetWorkers.set(key, worker)
    return worker
}

async function drainWebhookDispatchTarget(target: DispatchTarget): Promise<void> {
    for (;;) {
        const claim = claimNextQueuedWebhookDispatch(target.targetKind, target.targetId, Date.now())
        if (claim.kind === 'empty') return
        if (claim.kind === 'waiting') {
            await delay(Math.min(RETRY_MAX_MS, Math.max(1, claim.waitMs)))
            continue
        }
        await processClaimedDispatch(claim.dispatch)
    }
}

async function processClaimedDispatch(dispatch: WebhookDispatch): Promise<void> {
    const event = getWebhookEvent(dispatch.eventId)
    if (!event) {
        finishWebhookDispatch(dispatch.id, { status: 'error', error: 'Webhook event no longer exists.' })
        return
    }

    if (dispatch.targetKind !== 'microscript') {
        finishWebhookDispatch(dispatch.id, { status: 'error', error: `Unsupported webhook target: ${dispatch.targetKind}` })
        reconcileWebhookEventDispatchStatus(event.id)
        return
    }

    const exists = getMicroscript(dispatch.targetId)
    if (!exists) {
        finishTerminalMicroscriptDispatch(dispatch, event, {
            ok: false,
            summary: `Microscript ${dispatch.targetId} not found.`,
            error: 'Microscript not found.',
            conversationId: null,
        })
        return
    }

    const script = claimMicroscriptForWebhook(dispatch.targetId, Date.now())
    if (!script) {
        const latest = getMicroscript(dispatch.targetId)
        if (latest?.enabled && latest.status === 'running') {
            const retryMs = retryBackoffMs(dispatch.attemptCount)
            requeueWebhookDispatch(dispatch.id, {
                error: `Microscript is already running; retrying in ${retryMs}ms.`,
                nextAttemptAt: Date.now() + retryMs,
            })
            recordMicroscriptEvent(dispatch.targetId, 'webhook_retry_queued', {
                eventId: event.id,
                dispatchId: dispatch.id,
                attempt: dispatch.attemptCount,
                retryAfterMs: retryMs,
                reason: 'already_running',
            })
            reconcileWebhookEventDispatchStatus(event.id)
            return
        }
        finishTerminalMicroscriptDispatch(dispatch, event, {
            ok: false,
            summary: `Microscript ${dispatch.targetId} is not currently runnable.`,
            error: 'Microscript is disabled, paused, completed, or expired.',
            conversationId: null,
        })
        return
    }

    recordMicroscriptEvent(script.id, 'webhook_triggered', {
        eventId: event.id,
        dispatchId: dispatch.id,
        queueSequence: dispatch.queueSequence,
        attempt: dispatch.attemptCount,
        slug: event.slug,
        source: event.source,
        eventType: event.eventType,
    })

    try {
        const result = await runMicroscript(script, {
            trigger: 'webhook',
            webhook: webhookContext(event),
        })
        finishTerminalMicroscriptDispatch(dispatch, event, {
            ok: result.ok,
            summary: result.summary,
            error: result.error,
            conversationId: result.conversationId,
        })
    } catch (err) {
        // Once runMicroscript has been entered, retrying would risk repeating
        // side effects. Record a terminal error; retries are reserved strictly
        // for pre-execution already-running contention.
        finishTerminalMicroscriptDispatch(dispatch, event, {
            ok: false,
            summary: `Microscript ${script.id} webhook run threw.`,
            error: err instanceof Error ? err.message : String(err),
            conversationId: null,
        })
    }
}

function finishTerminalMicroscriptDispatch(
    dispatch: WebhookDispatch,
    event: WebhookEvent,
    outcome: { ok: boolean; summary: string; error?: string; conversationId: string | null },
): void {
    finishWebhookDispatch(dispatch.id, {
        status: outcome.ok ? 'ok' : 'error',
        error: outcome.error ?? null,
        runSummary: outcome.summary,
        conversationId: outcome.conversationId,
    })
    if (getMicroscript(dispatch.targetId)) {
        recordMicroscriptEvent(dispatch.targetId, outcome.ok ? 'webhook_dispatch_ok' : 'webhook_dispatch_error', {
            eventId: event.id,
            dispatchId: dispatch.id,
            queueSequence: dispatch.queueSequence,
            attempts: dispatch.attemptCount,
            summary: outcome.summary.slice(0, 1_000),
            error: outcome.error ?? null,
        })
    }
    reconcileWebhookEventDispatchStatus(event.id)
}

function retryBackoffMs(attemptCount: number): number {
    const exponent = Math.max(0, Math.min(10, attemptCount - 1))
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** exponent))
}

function hasPendingTarget(target: DispatchTarget): boolean {
    return listPendingWebhookDispatchTargets().some(
        (candidate) => candidate.targetKind === target.targetKind && candidate.targetId === target.targetId,
    )
}

function targetKey(profileId: string, target: DispatchTarget): string {
    return `${profileId}:${target.targetKind}:${target.targetId}`
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Active-profile recovery hook, exported for deterministic restart tests. */
export async function recoverWebhookDispatchQueue(now = Date.now()): Promise<{
    recovered: number
    pendingTargets: number
}> {
    const recovered = recoverInterruptedWebhookDispatches(now)
    const targets = listPendingWebhookDispatchTargets()
    await Promise.all(targets.map((target) => kickWebhookDispatchTarget(target)))
    return { recovered: recovered.length, pendingTargets: targets.length }
}

/** Server boot hook: recover every profile and keep a low-frequency safety
 * sweep armed. Normal ingress kicks immediately; the sweep only covers rows
 * left queued by an abrupt failure between persistence and worker startup. */
export async function wireWebhookDispatchQueue(): Promise<void> {
    await recoverAllProfiles()
    if (globalForQueue.__orchestratorWebhookDispatchSweep) return
    const timer = setInterval(() => {
        void recoverAllProfiles(false).catch((err) => {
            console.error('[webhooks] dispatch queue sweep failed', err)
        })
    }, QUEUE_SWEEP_MS)
    timer.unref?.()
    globalForQueue.__orchestratorWebhookDispatchSweep = timer
}

async function recoverAllProfiles(recoverRunning = true): Promise<void> {
    if (!canRunBackgroundLoop()) return
    const { listProfiles } = await import('@/lib/profiles/store')
    for (const profile of listProfiles()) {
        await runWithProfileContext({ profileId: profile.id, role: profile.role }, async () => {
            if (recoverRunning) recoverInterruptedWebhookDispatches()
            const targets = listPendingWebhookDispatchTargets()
            await Promise.all(targets.map((target) => kickWebhookDispatchTarget(target)))
        })
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
