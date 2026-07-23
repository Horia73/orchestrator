/**
 * Smoke test for detached specialist batches.
 *
 * Proves that one or many child jobs return control immediately, respect the
 * requested batch concurrency, persist results, can be cancelled, and emit at
 * most one completion wake only after an explicit detach.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'async-delegations-smoke-'))
const originalStateDir = process.env.ORCHESTRATOR_STATE_DIR
process.env.ORCHESTRATOR_STATE_DIR = tmpRoot

async function main(): Promise<void> {
    const {
        asyncDelegationTestHooks,
        cancelAsyncDelegationBatch,
        notifyAsyncDelegationCompletion,
        pruneExpiredAsyncDelegations,
        serializeAsyncDelegationBatch,
        setAsyncDelegationWake,
        startAsyncDelegationBatch,
        waitForAsyncDelegationBatch,
    } = await import('@/lib/ai/async-delegations')
    const { clearAgentRun, listAgentRuns } = await import('@/lib/agent-runs')
    const {
        createAgentThread,
        createConversation,
        addAgentThreadMessage,
        getDatabaseForProfile,
        getConversation,
    } = await import('@/lib/db')
    const { clearChatStream, registerChatStream } = await import('@/lib/chat-streams')
    const { clearFollowUps, peekFollowUps } = await import('@/lib/chat-followups')
    const { getActiveProfileId } = await import('@/lib/profiles/context')
    const { executeDelegateTo } = await import('@/lib/ai/tools/delegate-to')

    const conversationId = 'async_delegation_smoke'
    createConversation({
        id: conversationId,
        title: 'Async delegation smoke',
        createdAt: Date.now(),
        messages: [],
    })
    const ctx = {
        callerAgentId: 'orchestrator',
        depth: 0,
        conversationId,
        parentRequestId: 'parent_async_smoke',
    }
    const makeThread = (title: string) => createAgentThread({
        conversationId,
        agentId: 'researcher',
        createdByAgentId: 'orchestrator',
        title,
    })

    // Detached batches are conversation-level wakes, so only the root may own
    // one. A sub-agent must wait synchronously for its direct children.
    let nestedLaunchRejected = false
    try {
        await startAsyncDelegationBatch({
            ctx: { ...ctx, depth: 1, callerAgentId: 'researcher', agentThreadId: 'nested-parent' },
            jobs: [{
                agentId: 'researcher',
                agentThreadId: 'nested-child',
                prompt: 'must not launch',
                run: async () => ({ success: true }),
            }],
            maxConcurrency: 1,
            wakeOnComplete: true,
        })
    } catch (error) {
        nestedLaunchRejected = /Nested async delegation is not allowed/.test(String(error))
    }
    check(nestedLaunchRejected, 'nested async launch is rejected before any child starts')

    // Defensive migration behavior: an old nested row may still be present on
    // disk after an upgrade. Its completion must never enqueue into the root
    // conversation.
    const legacyParent = makeThread('legacy nested parent')
    const legacyBatchId = 'adb_legacy_nested_scope'
    const now = Date.now()
    getDatabaseForProfile().prepare(`
        INSERT INTO async_delegation_batches (
            id, conversationId, createdByAgentId, parentAgentThreadId,
            parentRequestId, status, maxConcurrency, wakeOnComplete,
            startedAt, endedAt, notifiedAt, collectedAt
        ) VALUES (?, ?, ?, ?, ?, 'ok', 1, 1, ?, ?, NULL, NULL)
    `).run(
        legacyBatchId,
        conversationId,
        'researcher',
        legacyParent.id,
        'legacy-parent-request',
        now - 10,
        now,
    )
    await notifyAsyncDelegationCompletion(getActiveProfileId(), legacyBatchId)
    check(
        asyncDelegationTestHooks.getBatch(legacyBatchId)?.wakeOnComplete === 0,
        'legacy nested completion wake is suppressed',
    )
    check(
        !getConversation(conversationId)?.messages.some(message => message.content.includes(legacyBatchId)),
        'legacy nested completion notice does not leak into the root conversation',
    )

    const foreignBranch = createAgentThread({
        conversationId,
        agentId: 'researcher',
        createdByAgentId: 'researcher',
        parentAgentThreadId: legacyParent.id,
        title: 'foreign sibling branch',
    })
    addAgentThreadMessage(foreignBranch.id, {
        role: 'assistant',
        content: 'private foreign-branch result',
    })
    const crossBranchForward = await executeDelegateTo({
        agent_id: 'researcher',
        prompt: 'try to consume another branch',
        context_thread_ids: [foreignBranch.id],
    }, ctx)
    check(
        !crossBranchForward.success && /different parent agent/.test(crossBranchForward.error ?? ''),
        'context forwarding cannot cross parent-agent branches',
    )

    // One child: the launch must resolve while the child is still blocked.
    let releaseSingle!: () => void
    const singleGate = new Promise<void>(resolve => { releaseSingle = resolve })
    let singleStarted = false
    const singleThread = makeThread('single async child')
    const single = await startAsyncDelegationBatch({
        ctx,
        jobs: [{
            agentId: 'researcher',
            agentThreadId: singleThread.id,
            taskLabel: singleThread.title,
            prompt: 'single',
            run: async () => {
                singleStarted = true
                await singleGate
                return { success: true, data: { output: 'single-result' } }
            },
        }],
        maxConcurrency: 1,
    })
    await eventually(() => singleStarted)
    check(asyncDelegationTestHooks.getBatch(single.batchId)?.status === 'running', 'single launch returns before child completion')
    check(listAgentRuns().some(run => run.id === single.batchId && run.kind === 'delegation'), 'live async batch participates in worker drain')
    releaseSingle()
    const singleDone = await waitForAsyncDelegationBatch(single.batchId, ctx, 2_000)
    check(singleDone?.status === 'ok', 'single async child settles successfully')
    const singleResult = singleDone ? serializeAsyncDelegationBatch(singleDone, { includeResults: true }) : null
    check(JSON.stringify(singleResult).includes('single-result'), 'single result is durably collectable')
    check(!listAgentRuns().some(run => run.id === single.batchId), 'settled batch leaves worker drain registry')

    // Many children: local batch concurrency must cap simultaneous runners.
    let live = 0
    let peak = 0
    const multiThreads = [0, 1, 2, 3].map(index => makeThread(`parallel ${index}`))
    const multi = await startAsyncDelegationBatch({
        ctx,
        jobs: multiThreads.map((thread, index) => ({
            agentId: 'researcher',
            agentThreadId: thread.id,
            taskLabel: thread.title,
            prompt: `job-${index}`,
            run: async () => {
                live += 1
                peak = Math.max(peak, live)
                await sleep(35)
                live -= 1
                return { success: true, data: { output: `result-${index}` } }
            },
        })),
        maxConcurrency: 2,
    })
    check(asyncDelegationTestHooks.getBatch(multi.batchId)?.status === 'running', 'multi launch returns immediately')
    const multiDone = await waitForAsyncDelegationBatch(multi.batchId, ctx, 3_000)
    check(multiDone?.status === 'ok', 'multi batch settles')
    check(peak === 2, `multi batch honors max_concurrency=2 (peak=${peak})`)
    check(asyncDelegationTestHooks.getJobs(multi.batchId).every(job => job.status === 'ok'), 'all multi jobs persist terminal status')

    // Cancellation owns its own signal and does not require stopping parent.
    const cancelThread = makeThread('cancel async child')
    const cancellable = await startAsyncDelegationBatch({
        ctx,
        jobs: [{
            agentId: 'researcher',
            agentThreadId: cancelThread.id,
            taskLabel: cancelThread.title,
            prompt: 'wait until cancelled',
            run: async childCtx => new Promise(resolve => {
                childCtx.signal?.addEventListener('abort', () => {
                    resolve({ success: false, error: 'cancelled by smoke' })
                }, { once: true })
            }),
        }],
        maxConcurrency: 1,
    })
    await eventually(() => asyncDelegationTestHooks.getJobs(cancellable.batchId)[0]?.status === 'running')
    check(cancelAsyncDelegationBatch(cancellable.batchId, ctx).ok, 'cancel signal accepted')
    const cancelled = await waitForAsyncDelegationBatch(cancellable.batchId, ctx, 2_000)
    check(cancelled?.status === 'aborted', 'cancelled batch becomes aborted')

    // Stopping the parent cancels children AND suppresses a requested wake.
    const parentAbort = new AbortController()
    const stopThread = makeThread('parent stop child')
    const stopped = await startAsyncDelegationBatch({
        ctx: { ...ctx, signal: parentAbort.signal },
        jobs: [{
            agentId: 'researcher',
            agentThreadId: stopThread.id,
            taskLabel: stopThread.title,
            prompt: 'stop with parent',
            run: async childCtx => new Promise(resolve => {
                childCtx.signal?.addEventListener('abort', () => {
                    resolve({ success: false, error: 'parent stopped' })
                }, { once: true })
            }),
        }],
        maxConcurrency: 1,
        wakeOnComplete: true,
    })
    await eventually(() => asyncDelegationTestHooks.getJobs(stopped.batchId)[0]?.status === 'running')
    parentAbort.abort()
    const stoppedDone = await waitForAsyncDelegationBatch(stopped.batchId, ctx, 2_000)
    check(stoppedDone?.status === 'aborted', 'parent Stop aborts async batch')
    check(stoppedDone?.wakeOnComplete === 0, 'parent Stop suppresses detached completion wake')
    check(!peekFollowUps(conversationId).some(item => item.source === 'async-delegation'), 'parent Stop queues no async follow-up')

    // Detach after settlement: one system notice, never a duplicate wake.
    const wakeController = new AbortController()
    check(registerChatStream(conversationId, 'wake_guard', wakeController), 'wake guard stream registered')
    const detachedThread = makeThread('detached async child')
    const detached = await startAsyncDelegationBatch({
        ctx,
        jobs: [{
            agentId: 'researcher',
            agentThreadId: detachedThread.id,
            taskLabel: detachedThread.title,
            prompt: 'finish for wake',
            run: async () => ({ success: true, data: { output: 'detached-result' } }),
        }],
        maxConcurrency: 1,
    })
    const detachedDone = await waitForAsyncDelegationBatch(detached.batchId, ctx, 2_000)
    check(detachedDone?.status === 'ok', 'detached fixture settles')
    check(Boolean(setAsyncDelegationWake(detached.batchId, ctx, true)), 'detach enables completion wake')
    await notifyAsyncDelegationCompletion(getActiveProfileId(), detached.batchId)
    await notifyAsyncDelegationCompletion(getActiveProfileId(), detached.batchId)
    const notices = getConversation(conversationId)?.messages.filter(message =>
        message.content.includes(`<async-delegation-notice>`) && message.content.includes(detached.batchId)
    ) ?? []
    check(notices.length === 1, `detach posts exactly one persisted notice (count=${notices.length})`)
    const queued = peekFollowUps(conversationId).filter(item => item.source === 'async-delegation')
    check(queued.length === 1, `detach queues exactly one async follow-up (count=${queued.length})`)
    clearFollowUps(conversationId)
    clearChatStream(conversationId, 'wake_guard')
    check(
        pruneExpiredAsyncDelegations(Date.now() + 15 * 24 * 60 * 60_000) >= 4,
        'terminal async bookkeeping prunes after retention window',
    )

    // Defensive cleanup if an assertion above changed sequencing.
    for (const run of listAgentRuns()) {
        if (run.kind === 'delegation') clearAgentRun(run.id)
    }
    console.log('async delegation smoke passed')
}

function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message)
    console.log(`✓ ${message}`)
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for async delegation state.')
        await sleep(10)
    }
}

main()
    .catch(error => {
        console.error(error)
        process.exitCode = 1
    })
    .finally(() => {
        if (originalStateDir === undefined) delete process.env.ORCHESTRATOR_STATE_DIR
        else process.env.ORCHESTRATOR_STATE_DIR = originalStateDir
        fs.rmSync(tmpRoot, { recursive: true, force: true })
    })
