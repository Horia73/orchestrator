import { randomUUID } from 'crypto'

import type { ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { clearAgentRun, registerAgentRun } from '@/lib/agent-runs'
import { getDatabaseForProfile, getConversation, addMessage } from '@/lib/db'
import { enqueueFollowUp } from '@/lib/chat-followups'
import { getActiveChatStream } from '@/lib/chat-streams'
import {
    getActiveProfileContext,
    getActiveProfileId,
    runWithProfileContext,
} from '@/lib/profiles/context'
import { generateId } from '@/lib/utils-chat'
import type { Message } from '@/lib/types'

export type AsyncDelegationBatchStatus = 'running' | 'ok' | 'error' | 'aborted' | 'lost'
export type AsyncDelegationJobStatus = 'queued' | 'running' | 'ok' | 'error' | 'aborted' | 'lost'

export interface AsyncDelegationBatchRow {
    id: string
    conversationId: string
    createdByAgentId: string
    parentAgentThreadId: string | null
    parentRequestId: string
    status: AsyncDelegationBatchStatus
    maxConcurrency: number
    wakeOnComplete: number
    startedAt: number
    endedAt: number | null
    notifiedAt: number | null
    collectedAt: number | null
}

export interface AsyncDelegationJobRow {
    id: string
    batchId: string
    agentId: string
    agentThreadId: string
    assignedName: string | null
    taskLabel: string | null
    prompt: string
    position: number
    status: AsyncDelegationJobStatus
    result: string | null
    error: string | null
    startedAt: number | null
    endedAt: number | null
}

export interface AsyncDelegationLaunchJob {
    agentId: string
    agentThreadId: string
    assignedName?: string
    taskLabel?: string
    prompt: string
    run: (ctx: ToolExecutionContext) => Promise<ToolResult>
}

export interface AsyncDelegationLaunchResult {
    batchId: string
    jobs: Array<{
        jobId: string
        agentId: string
        agentThreadId: string
        assignedName?: string
        taskLabel?: string
    }>
}

interface RuntimeBatch {
    profileId: string
    controller: AbortController
    promise: Promise<void>
}

const globalForAsyncDelegations = globalThis as unknown as {
    __orchestratorAsyncDelegations?: Map<string, RuntimeBatch>
    __orchestratorAsyncDelegationBootStarted?: boolean
}

const runtimeBatches = globalForAsyncDelegations.__orchestratorAsyncDelegations ?? new Map<string, RuntimeBatch>()
if (!globalForAsyncDelegations.__orchestratorAsyncDelegations) {
    globalForAsyncDelegations.__orchestratorAsyncDelegations = runtimeBatches
}

const ASYNC_DELEGATION_NOTICE_TAG = 'async-delegation-notice'
export const ASYNC_DELEGATION_WAIT_DEFAULT_MS = 60_000
export const ASYNC_DELEGATION_WAIT_MAX_MS = 5 * 60_000
const ASYNC_DELEGATION_RETENTION_MS = 14 * 24 * 60 * 60_000

function runtimeKey(profileId: string, batchId: string): string {
    return `${profileId}:${batchId}`
}

function activeDb() {
    return getDatabaseForProfile()
}

function getBatch(id: string): AsyncDelegationBatchRow | null {
    const row = activeDb()
        .prepare('SELECT * FROM async_delegation_batches WHERE id = ?')
        .get(id) as AsyncDelegationBatchRow | undefined
    return row ?? null
}

function getJobs(batchId: string): AsyncDelegationJobRow[] {
    return activeDb()
        .prepare('SELECT * FROM async_delegation_jobs WHERE batchId = ? ORDER BY position ASC')
        .all(batchId) as AsyncDelegationJobRow[]
}

function inCallerScope(batch: AsyncDelegationBatchRow, ctx: ToolExecutionContext): boolean {
    return batch.conversationId === ctx.conversationId
        && batch.createdByAgentId === ctx.callerAgentId
        && (batch.parentAgentThreadId ?? null) === (ctx.agentThreadId ?? null)
}

export function getAsyncDelegationBatchForCaller(
    batchId: string,
    ctx: ToolExecutionContext,
): AsyncDelegationBatchRow | null {
    const batch = getBatch(batchId)
    return batch && inCallerScope(batch, ctx) ? batch : null
}

export function listAsyncDelegationBatchesForCaller(
    ctx: ToolExecutionContext,
    limit = 12,
): AsyncDelegationBatchRow[] {
    const parentThreadId = ctx.agentThreadId ?? null
    return activeDb()
        .prepare(`
            SELECT *
            FROM async_delegation_batches
            WHERE conversationId = @conversationId
              AND createdByAgentId = @createdByAgentId
              AND (
                parentAgentThreadId = @parentAgentThreadId
                OR (parentAgentThreadId IS NULL AND @parentAgentThreadId IS NULL)
              )
            ORDER BY startedAt DESC
            LIMIT @limit
        `)
        .all({
            conversationId: ctx.conversationId,
            createdByAgentId: ctx.callerAgentId,
            parentAgentThreadId: parentThreadId,
            limit: Math.max(1, Math.min(Math.floor(limit), 50)),
        }) as AsyncDelegationBatchRow[]
}

export function listPendingAsyncDelegationsForPrompt(args: {
    conversationId: string
    createdByAgentId: string
    parentAgentThreadId?: string | null
    limit?: number
}): Array<AsyncDelegationBatchRow & { jobs: AsyncDelegationJobRow[] }> {
    const parentAgentThreadId = args.parentAgentThreadId ?? null
    const batches = activeDb()
        .prepare(`
            SELECT *
            FROM async_delegation_batches
            WHERE conversationId = @conversationId
              AND createdByAgentId = @createdByAgentId
              AND (
                parentAgentThreadId = @parentAgentThreadId
                OR (parentAgentThreadId IS NULL AND @parentAgentThreadId IS NULL)
              )
              AND (status = 'running' OR collectedAt IS NULL)
            ORDER BY startedAt DESC
            LIMIT @limit
        `)
        .all({
            conversationId: args.conversationId,
            createdByAgentId: args.createdByAgentId,
            parentAgentThreadId,
            limit: Math.max(1, Math.min(Math.floor(args.limit ?? 8), 20)),
        }) as AsyncDelegationBatchRow[]
    return batches.map(batch => ({ ...batch, jobs: getJobs(batch.id) }))
}

export async function startAsyncDelegationBatch(args: {
    ctx: ToolExecutionContext
    jobs: AsyncDelegationLaunchJob[]
    maxConcurrency: number
    wakeOnComplete?: boolean
}): Promise<AsyncDelegationLaunchResult> {
    if (args.jobs.length === 0) throw new Error('An async delegation batch needs at least one job.')
    if (args.ctx.depth > 0 || args.ctx.agentThreadId) {
        throw new Error('Nested async delegation is not allowed; child results must return synchronously to their direct parent agent.')
    }

    const profileContext = getActiveProfileContext()
    const profileId = getActiveProfileId()
    const batchId = `adb_${randomUUID()}`
    const now = Date.now()
    const concurrency = Math.max(1, Math.min(Math.floor(args.maxConcurrency), args.jobs.length))
    const rows = args.jobs.map((job, position) => ({
        id: `adj_${randomUUID()}`,
        batchId,
        agentId: job.agentId,
        agentThreadId: job.agentThreadId,
        assignedName: job.assignedName ?? null,
        taskLabel: job.taskLabel ?? null,
        prompt: job.prompt,
        position,
    }))

    const db = activeDb()
    const insertBatch = db.prepare(`
        INSERT INTO async_delegation_batches (
            id, conversationId, createdByAgentId, parentAgentThreadId,
            parentRequestId, status, maxConcurrency, wakeOnComplete,
            startedAt, endedAt, notifiedAt, collectedAt
        ) VALUES (
            @id, @conversationId, @createdByAgentId, @parentAgentThreadId,
            @parentRequestId, 'running', @maxConcurrency, @wakeOnComplete,
            @startedAt, NULL, NULL, NULL
        )
    `)
    const insertJob = db.prepare(`
        INSERT INTO async_delegation_jobs (
            id, batchId, agentId, agentThreadId, assignedName, taskLabel,
            prompt, position, status, result, error, startedAt, endedAt
        ) VALUES (
            @id, @batchId, @agentId, @agentThreadId, @assignedName, @taskLabel,
            @prompt, @position, 'queued', NULL, NULL, NULL, NULL
        )
    `)
    db.transaction(() => {
        insertBatch.run({
            id: batchId,
            conversationId: args.ctx.conversationId,
            createdByAgentId: args.ctx.callerAgentId,
            parentAgentThreadId: args.ctx.agentThreadId ?? null,
            parentRequestId: args.ctx.parentRequestId,
            maxConcurrency: concurrency,
            wakeOnComplete: args.wakeOnComplete ? 1 : 0,
            startedAt: now,
        })
        for (const row of rows) insertJob.run(row)
    })()

    // This run is already admitted as part of its live parent turn. Register it
    // separately so a managed update keeps the old worker alive after the
    // parent model finishes, until every detached child has settled.
    registerAgentRun({
        id: batchId,
        kind: 'delegation',
        conversationId: args.ctx.conversationId,
        startedAt: now,
    }, { alreadyAdmitted: true })

    const controller = new AbortController()
    const onParentAbort = () => {
        // User Stop means stop the whole accepted tree. Suppress a previously
        // requested detach wake before aborting children, otherwise the abort
        // itself would enqueue a fresh autonomous turn right after Stop.
        runWithProfileContext(profileContext, () => {
            activeDb().prepare(`
                UPDATE async_delegation_batches
                SET wakeOnComplete = 0
                WHERE id = @id
            `).run({ id: batchId })
        })
        controller.abort()
    }
    args.ctx.signal?.addEventListener('abort', onParentAbort, { once: true })

    const promise = runWithProfileContext(profileContext, async () => {
        try {
            await mapWithConcurrency(args.jobs, concurrency, async (job, position) => {
                const row = rows[position]
                if (controller.signal.aborted) {
                    settleJob(row.id, 'aborted', { success: false, error: 'Async delegation cancelled before start.' })
                    return
                }

                activeDb().prepare(`
                    UPDATE async_delegation_jobs
                    SET status = 'running', startedAt = @startedAt
                    WHERE id = @id AND status = 'queued'
                `).run({ id: row.id, startedAt: Date.now() })

                let result: ToolResult
                try {
                    result = await job.run({
                        ...args.ctx,
                        signal: controller.signal,
                        permit: undefined,
                    })
                } catch (error) {
                    result = {
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                    }
                }
                const status: AsyncDelegationJobStatus = controller.signal.aborted
                    ? 'aborted'
                    : result.success ? 'ok' : 'error'
                settleJob(row.id, status, result)
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            activeDb().prepare(`
                UPDATE async_delegation_jobs
                SET status = 'error', error = @error, endedAt = @endedAt
                WHERE batchId = @batchId AND status IN ('queued', 'running')
            `).run({ batchId, error: message, endedAt: Date.now() })
        } finally {
            finalizeBatch(batchId, controller.signal.aborted)
            clearAgentRun(batchId)
            runtimeBatches.delete(runtimeKey(profileId, batchId))
            args.ctx.signal?.removeEventListener('abort', onParentAbort)
            await notifyAsyncDelegationCompletion(profileId, batchId)
            pruneExpiredAsyncDelegations()
        }
    })

    runtimeBatches.set(runtimeKey(profileId, batchId), { profileId, controller, promise })
    void promise.catch(error => {
        console.error(`[async-delegations] batch ${batchId} failed`, error)
    })

    return {
        batchId,
        jobs: rows.map(row => ({
            jobId: row.id,
            agentId: row.agentId,
            agentThreadId: row.agentThreadId,
            assignedName: row.assignedName ?? undefined,
            taskLabel: row.taskLabel ?? undefined,
        })),
    }
}

function settleJob(id: string, status: AsyncDelegationJobStatus, result: ToolResult): void {
    activeDb().prepare(`
        UPDATE async_delegation_jobs
        SET status = @status,
            result = @result,
            error = @error,
            endedAt = @endedAt
        WHERE id = @id
    `).run({
        id,
        status,
        result: safeStringify(result),
        error: result.success ? null : result.error ?? 'Delegation failed.',
        endedAt: Date.now(),
    })
}

function finalizeBatch(batchId: string, aborted: boolean): void {
    const jobs = getJobs(batchId)
    const status: AsyncDelegationBatchStatus = aborted
        ? 'aborted'
        : jobs.some(job => job.status === 'lost')
            ? 'lost'
            : jobs.some(job => job.status === 'error' || job.status === 'aborted')
                ? 'error'
                : 'ok'
    activeDb().prepare(`
        UPDATE async_delegation_batches
        SET status = @status, endedAt = @endedAt
        WHERE id = @id
    `).run({ id: batchId, status, endedAt: Date.now() })
}

export function setAsyncDelegationWake(
    batchId: string,
    ctx: ToolExecutionContext,
    wake: boolean,
): AsyncDelegationBatchRow | null {
    const batch = getAsyncDelegationBatchForCaller(batchId, ctx)
    if (!batch) return null
    activeDb().prepare(`
        UPDATE async_delegation_batches
        SET wakeOnComplete = @wakeOnComplete
        WHERE id = @id
    `).run({ id: batchId, wakeOnComplete: wake ? 1 : 0 })
    return getBatch(batchId)
}

export function markAsyncDelegationCollected(batchId: string, ctx: ToolExecutionContext): boolean {
    const batch = getAsyncDelegationBatchForCaller(batchId, ctx)
    if (!batch) return false
    activeDb().prepare(`
        UPDATE async_delegation_batches
        SET collectedAt = @collectedAt, wakeOnComplete = 0
        WHERE id = @id
    `).run({ id: batchId, collectedAt: Date.now() })
    return true
}

export async function waitForAsyncDelegationBatch(
    batchId: string,
    ctx: ToolExecutionContext,
    maxWaitMs: number,
): Promise<AsyncDelegationBatchRow | null> {
    const batch = getAsyncDelegationBatchForCaller(batchId, ctx)
    if (!batch) return null
    const deadline = Date.now() + Math.max(0, Math.min(maxWaitMs, ASYNC_DELEGATION_WAIT_MAX_MS))
    for (;;) {
        const current = getAsyncDelegationBatchForCaller(batchId, ctx)
        if (!current || current.status !== 'running' || Date.now() >= deadline) return current
        const runtime = runtimeBatches.get(runtimeKey(getActiveProfileId(), batchId))
        if (runtime) {
            const remaining = Math.max(0, deadline - Date.now())
            await Promise.race([
                runtime.promise,
                new Promise<void>(resolve => setTimeout(resolve, Math.min(250, remaining))),
            ])
        } else {
            await new Promise<void>(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))))
        }
    }
}

export function cancelAsyncDelegationBatch(
    batchId: string,
    ctx: ToolExecutionContext,
): { ok: boolean; error?: string } {
    const batch = getAsyncDelegationBatchForCaller(batchId, ctx)
    if (!batch) return { ok: false, error: `Unknown async delegation batch: ${batchId}` }
    if (batch.status !== 'running') return { ok: true }
    const runtime = runtimeBatches.get(runtimeKey(getActiveProfileId(), batchId))
    if (!runtime) {
        return { ok: false, error: `Async delegation batch ${batchId} is not active in this worker.` }
    }
    setAsyncDelegationWake(batchId, ctx, false)
    runtime.controller.abort()
    return { ok: true }
}

export function serializeAsyncDelegationBatch(
    batch: AsyncDelegationBatchRow,
    options?: { includeResults?: boolean },
): Record<string, unknown> {
    const jobs = getJobs(batch.id)
    return {
        batch_id: batch.id,
        status: batch.status,
        done: batch.status !== 'running',
        max_concurrency: batch.maxConcurrency,
        wake_on_complete: Boolean(batch.wakeOnComplete),
        started_at: batch.startedAt,
        ended_at: batch.endedAt ?? undefined,
        jobs: jobs.map(job => {
            const parsed = options?.includeResults ? parseResult(job.result) : undefined
            return {
                job_id: job.id,
                agent_id: job.agentId,
                agent_name: job.assignedName ?? undefined,
                task: job.taskLabel ?? undefined,
                agent_thread_id: job.agentThreadId,
                prompt: options?.includeResults ? job.prompt : undefined,
                status: job.status,
                started_at: job.startedAt ?? undefined,
                ended_at: job.endedAt ?? undefined,
                result: parsed,
                error: job.error ?? undefined,
            }
        }),
    }
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        return JSON.stringify({ success: false, error: 'Delegation result was not serializable.' })
    }
}

function parseResult(value: string | null): unknown {
    if (!value) return undefined
    try {
        return JSON.parse(value)
    } catch {
        return { success: false, error: 'Stored delegation result is invalid.' }
    }
}

function buildAsyncDelegationNotice(batch: AsyncDelegationBatchRow, jobs: AsyncDelegationJobRow[]): string {
    const durationMs = (batch.endedAt ?? Date.now()) - batch.startedAt
    const duration = durationMs < 1000
        ? `${durationMs}ms`
        : `${Math.round(durationMs / 1000)}s`
    return [
        `<${ASYNC_DELEGATION_NOTICE_TAG}>`,
        `Async delegation batch ${batch.id} finished with status ${batch.status} after ${duration}.`,
        ...jobs.map(job => {
            const label = [job.agentId, job.assignedName].filter(Boolean).join(' ')
            return `- ${label}: ${job.status}; agent_thread_id=${job.agentThreadId}`
        }),
        '',
        'This is an automated completion notice, not a message typed by the user. Call manage_delegations with action="collect" and this batch_id to read the persisted results, then continue the original task. Do not launch duplicate work.',
        `</${ASYNC_DELEGATION_NOTICE_TAG}>`,
    ].join('\n')
}

export async function notifyAsyncDelegationCompletion(profileId: string, batchId: string): Promise<void> {
    await runWithProfileContext({ profileId }, async () => {
        const batch = getBatch(batchId)
        if (!batch || batch.status === 'running' || !batch.wakeOnComplete || batch.notifiedAt) return

        // Completion wakes are conversation-level. A nested batch belongs to
        // an agent thread, so enqueueing here would leak its completion notice
        // into the root conversation (and potentially another active parent).
        // New nested async launches are rejected above; suppress legacy rows
        // defensively during restart recovery too.
        if (batch.parentAgentThreadId) {
            activeDb().prepare(`
                UPDATE async_delegation_batches
                SET wakeOnComplete = 0
                WHERE id = @id
            `).run({ id: batchId })
            console.warn(`[async-delegations] suppressed nested completion wake for ${batchId}`)
            return
        }

        const claimedAt = Date.now()
        const claimed = activeDb().prepare(`
            UPDATE async_delegation_batches
            SET notifiedAt = @notifiedAt
            WHERE id = @id
              AND status != 'running'
              AND wakeOnComplete = 1
              AND notifiedAt IS NULL
        `).run({ id: batchId, notifiedAt: claimedAt })
        if (claimed.changes === 0 || !getConversation(batch.conversationId)) return

        const refreshed = getBatch(batchId) ?? batch
        const message: Message = {
            id: generateId(),
            role: 'user',
            content: buildAsyncDelegationNotice(refreshed, getJobs(batchId)),
            timestamp: claimedAt,
        }
        addMessage(batch.conversationId, message)
        enqueueFollowUp(batch.conversationId, {
            id: message.id,
            userMessageId: message.id,
            content: message.content,
            source: 'async-delegation',
            queuedAt: claimedAt,
        })
        if (!getActiveChatStream(batch.conversationId)) {
            const { triggerFollowUpDrain } = await import('@/lib/chat-wake')
            void triggerFollowUpDrain(profileId, batch.conversationId).catch(error => {
                console.error(`[async-delegations] wake for ${batchId} failed`, error)
            })
        }
    })
}

export function pruneExpiredAsyncDelegations(now = Date.now()): number {
    const cutoff = now - ASYNC_DELEGATION_RETENTION_MS
    return activeDb().prepare(`
        DELETE FROM async_delegation_batches
        WHERE status != 'running'
          AND endedAt IS NOT NULL
          AND endedAt < ?
    `).run(cutoff).changes
}

/**
 * On an unexpected worker restart there is no safe generic replay: a browser
 * or executor child may have crossed an external side-effect boundary just
 * before the process died. Seal the durable rows as lost and, only for batches
 * explicitly detached with wake enabled, wake the parent to decide whether the
 * existing agent thread should be resumed.
 */
export function startAsyncDelegationRecovery(): void {
    if (globalForAsyncDelegations.__orchestratorAsyncDelegationBootStarted) return
    globalForAsyncDelegations.__orchestratorAsyncDelegationBootStarted = true
    void (async () => {
        const { listProfiles } = await import('@/lib/profiles/store')
        for (const profile of listProfiles()) {
            await runWithProfileContext({ profileId: profile.id, role: profile.role }, async () => {
                const running = activeDb()
                    .prepare(`SELECT id FROM async_delegation_batches WHERE status = 'running'`)
                    .all() as Array<{ id: string }>
                const endedAt = Date.now()
                for (const { id } of running) {
                    activeDb().prepare(`
                        UPDATE async_delegation_jobs
                        SET status = 'lost', error = @error, endedAt = @endedAt
                        WHERE batchId = @batchId AND status IN ('queued', 'running')
                    `).run({
                        batchId: id,
                        error: 'Worker restarted before this async delegation completed.',
                        endedAt,
                    })
                    activeDb().prepare(`
                        UPDATE async_delegation_batches
                        SET status = 'lost', endedAt = @endedAt
                        WHERE id = @id AND status = 'running'
                    `).run({ id, endedAt })
                    await notifyAsyncDelegationCompletion(profile.id, id)
                }
                pruneExpiredAsyncDelegations()
            })
        }
    })().catch(error => {
        console.error('[async-delegations] boot recovery failed', error)
    })
}

async function mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<void>,
): Promise<void> {
    let next = 0
    async function worker() {
        for (;;) {
            const index = next++
            if (index >= items.length) return
            await mapper(items[index], index)
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
}

export const asyncDelegationTestHooks = {
    getBatch,
    getJobs,
    runtimeBatches,
}
