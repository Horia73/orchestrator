/**
 * Smoke test for the Smart Monitor cheap-pass gate
 * (lib/monitoring/smart-monitor-cheap-pass.ts).
 *
 * Runs against a TEMPORARY DB so it never touches the real .orchestrator/data.db.
 * Validates the no-model gate state machine:
 *   - readGate defaults + clamps (min-sleep floor, ceiling >= floor)
 *   - runSmartMonitorCheapPass with no watches → silent, well-formed gate
 *   - a due custom watch buffers but HOLDS while the minimum sleep hasn't elapsed
 *   - the same watch WAKES once the minimum sleep elapsed, with the detected
 *     block + lastFiredAt advanced
 *   - the safety ceiling fires a wake during total quiet (no pending)
 *   - suppressed Gmail matches auto-archive only when gmail_archive is allowed
 *   - finalizeSmartMonitorWake clears pending on success, preserves it on
 *     failure, advances lastWakeAt either way, and honours/falls-back the knobs
 *
 * Run with: npx tsx scripts/smoke-smart-monitor-gate.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

// Force a private DB path BEFORE any module imports lib/db.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-monitor-gate-smoke-'))
process.chdir(tmpRoot)

const MINUTE = 60_000
const HOUR = 60 * MINUTE

async function main(): Promise<void> {
    const {
        runSmartMonitorCheapPass,
        finalizeSmartMonitorWake,
        readGate,
        SMART_MONITOR_POLL_INTERVAL_MS,
    } = await import('@/lib/monitoring/smart-monitor-cheap-pass')
    const { addSuppressPattern, createMonitorWatch, deleteMonitorWatch, getMonitorWatch, listWatchEvents, setWatchCheckpoint } = await import(
        '@/lib/monitor/store'
    )
    const { gmailSourceAdapter } = await import('@/lib/monitor/sources/gmail')
    const { webSourceAdapter } = await import('@/lib/monitor/sources/web')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
        if (!ok) failures++
    }

    const NOW = 1_900_000_000_000 // fixed epoch ms for deterministic timing

    // --- readGate defaults + clamps ----------------------------------------
    const defGate = readGate(null)
    check('readGate(null) min defaults to 15m', defGate.minWakeGapMs === 15 * MINUTE, defGate)
    check('readGate(null) max defaults to 6h', defGate.maxWakeGapMs === 6 * HOUR, defGate)

    const flooredGate = readGate({ minWakeGapMs: 1_000 })
    check(
        'min sleep is floored to the 5m poll interval',
        flooredGate.minWakeGapMs === SMART_MONITOR_POLL_INTERVAL_MS,
        flooredGate,
    )

    const invertedGate = readGate({ minWakeGapMs: 60 * MINUTE, maxWakeGapMs: 10 * MINUTE })
    check(
        'ceiling is clamped to >= min sleep',
        invertedGate.maxWakeGapMs >= invertedGate.minWakeGapMs &&
            invertedGate.minWakeGapMs === 60 * MINUTE,
        invertedGate,
    )

    const pendingGate = readGate({
        _smartGate: { pending: [{ watchId: 'w1', summary: 's', source: 'gmail', ts: NOW }] },
    })
    check('readGate restores a valid pending buffer', pendingGate.pending.length === 1, pendingGate)

    // --- no watches → silent ------------------------------------------------
    const empty = await runSmartMonitorCheapPass({ priorState: null, now: NOW, taskId: 't_empty' })
    const emptyGate = (empty.nextState as Record<string, unknown>)._smartGate as Record<string, unknown>
    check('no watches → not noteworthy', empty.noteworthy === false, empty.summary)
    check('no watches → no brief prompt', empty.briefPrompt === undefined)
    check('no watches → lastCheapRunAt stamped', emptyGate?.lastCheapRunAt === NOW, emptyGate)

    // --- a due custom watch -------------------------------------------------
    const watch = createMonitorWatch({
        title: 'Daily standup digest',
        source: 'custom',
        target: 'standup',
        rule: { kind: 'custom_prompt', prompt: 'Summarise overnight activity.' },
        createdBy: 'user',
    })

    // HOLD: pending exists but the minimum sleep has not elapsed.
    const hold = await runSmartMonitorCheapPass({
        priorState: {
            minWakeGapMs: 15 * MINUTE,
            maxWakeGapMs: 6 * HOUR,
            _smartGate: { lastWakeAt: NOW - 1 * MINUTE, pending: [], lastCheapRunAt: NOW - 5 * MINUTE },
        },
        now: NOW,
        taskId: 't_hold',
    })
    const holdGate = (hold.nextState as Record<string, unknown>)._smartGate as Record<string, unknown>
    check('due custom watch is buffered', Array.isArray(holdGate?.pending) && (holdGate.pending as unknown[]).length === 1, holdGate)
    check('within min sleep → HOLDS (not noteworthy)', hold.noteworthy === false, hold.summary)
    check('hold path does not set lastFiredAt', getMonitorWatch(watch.id)?.lastFiredAt == null)

    // WAKE: minimum sleep elapsed → the buffered item escalates.
    const wake = await runSmartMonitorCheapPass({
        priorState: {
            minWakeGapMs: 15 * MINUTE,
            maxWakeGapMs: 6 * HOUR,
            _smartGate: { lastWakeAt: NOW - 20 * MINUTE, pending: [], lastCheapRunAt: NOW - 5 * MINUTE },
        },
        now: NOW,
        taskId: 't_wake',
    })
    check('min sleep elapsed + pending → noteworthy', wake.noteworthy === true, wake.summary)
    check('wake builds a brief prompt', typeof wake.briefPrompt === 'string' && wake.briefPrompt!.length > 0)
    check('brief prompt carries the detected block', wake.briefPrompt?.includes('<detected_changes>') === true)
    check('brief prompt names the watch', wake.briefPrompt?.includes('Daily standup digest') === true)
    check('wake advances the watch lastFiredAt', getMonitorWatch(watch.id)?.lastFiredAt === NOW)

    // --- safety ceiling during total quiet ---------------------------------
    // Park the custom watch far in the future so it is NOT due → zero pending.
    setWatchCheckpoint(watch.id, { lastFiredAt: NOW })
    const calm = createMonitorWatch({
        title: 'Quiet model check',
        source: 'custom',
        target: 'calm',
        rule: { kind: 'custom_prompt', prompt: 'Low-frequency audit.' },
        cadence: { current: 12 * HOUR / 1000, min: 15 * MINUTE / 1000, max: 12 * HOUR / 1000, adaptive: false },
        createdBy: 'user',
    })
    setWatchCheckpoint(calm.id, { lastFiredAt: NOW }) // just fired → not due

    const ceiling = await runSmartMonitorCheapPass({
        priorState: {
            minWakeGapMs: 15 * MINUTE,
            maxWakeGapMs: 6 * HOUR,
            _smartGate: { lastWakeAt: NOW - 7 * HOUR, pending: [], lastCheapRunAt: NOW - 5 * MINUTE },
        },
        now: NOW,
        taskId: 't_ceiling',
    })
    check('quiet past the ceiling → noteworthy', ceiling.noteworthy === true, ceiling.summary)
    check('ceiling wake summary says "safety wake"', ceiling.summary.toLowerCase().includes('safety wake'), ceiling.summary)

    // --- follow-up deadline escalation --------------------------------------
    // A closed-loop follow-up whose deadline passes with no observed effect
    // must complete (one-shot disable) and buffer an escalation item, even
    // though the watch's own cadence/connector never matched anything.
    const followUp = createMonitorWatch({
        title: 'Reply from Dan',
        source: 'custom',
        target: 'dan reply',
        rule: { kind: 'custom_prompt', prompt: 'Watch for a reply from Dan.' },
        followUp: { expectation: 'a reply from Dan about the offer', deadlineAt: NOW + 1 * MINUTE },
        createdBy: 'orchestrator',
    })
    // Park it so the custom-due path stays quiet; only the deadline should fire.
    setWatchCheckpoint(followUp.id, { lastFiredAt: NOW })
    const FUTURE = NOW + 5 * MINUTE
    const deadlineWake = await runSmartMonitorCheapPass({
        priorState: {
            minWakeGapMs: 15 * MINUTE,
            maxWakeGapMs: 6 * HOUR,
            _smartGate: { lastWakeAt: FUTURE - 20 * MINUTE, pending: [], lastCheapRunAt: FUTURE - 5 * MINUTE },
        },
        now: FUTURE,
        taskId: 't_followup_deadline',
    })
    check('passed deadline → noteworthy wake', deadlineWake.noteworthy === true, deadlineWake.summary)
    check(
        'deadline item carries the expectation',
        deadlineWake.briefPrompt?.includes('FOLLOW-UP DEADLINE PASSED') === true &&
            deadlineWake.briefPrompt?.includes('a reply from Dan about the offer') === true,
    )
    check('brief carries the follow-up handling protocol', deadlineWake.briefPrompt?.includes('follow_up_outcome') === true)
    const completedFu = getMonitorWatch(followUp.id)
    check(
        'follow-up completed: disabled + deadlineFiredAt stamped',
        completedFu?.enabled === false && completedFu?.followUp?.deadlineFiredAt === FUTURE,
        completedFu?.followUp,
    )
    // A later pass must NOT re-buffer the same deadline (watch is disabled).
    const quietAfter = await runSmartMonitorCheapPass({
        priorState: {
            minWakeGapMs: 15 * MINUTE,
            maxWakeGapMs: 6 * HOUR,
            _smartGate: { lastWakeAt: FUTURE, pending: [], lastCheapRunAt: FUTURE },
        },
        now: FUTURE + 5 * MINUTE,
        taskId: 't_followup_after',
    })
    check('completed follow-up does not re-fire', quietAfter.noteworthy === false, quietAfter.summary)

    // --- pre-wake stale-pending recheck ------------------------------------
    // If a buffered connector match is handled by the user while the model is
    // still asleep, the final source recheck should drop it and keep the agent
    // asleep. Stub the Gmail adapter method directly; getSourceAdapter('gmail')
    // returns this same object, so no live Gmail connection is needed.
    const originalGmailRevalidate = gmailSourceAdapter.revalidatePending
    gmailSourceAdapter.revalidatePending = async () => ({
        active: false,
        reason: 'test message no longer unread',
        checkedAt: NOW,
    })
    const staleGmail = createMonitorWatch({
        title: 'Urgent Gmail',
        source: 'gmail',
        target: 'urgent mail',
        rule: { kind: 'gmail_from', senders: ['alerts@example.com'] },
        createdBy: 'user',
    })
    try {
        const stale = await runSmartMonitorCheapPass({
            priorState: {
                minWakeGapMs: 15 * MINUTE,
                maxWakeGapMs: 6 * HOUR,
                _smartGate: {
                    lastWakeAt: NOW - 20 * MINUTE,
                    pending: [{
                        watchId: staleGmail.id,
                        watchTitle: staleGmail.title,
                        source: 'gmail',
                        summary: 'alerts@example.com — Urgent',
                        externalId: 'msg_stale',
                        ts: NOW - 5 * MINUTE,
                        details: { messageId: 'msg_stale', labels: ['INBOX', 'UNREAD'] },
                    }],
                    lastCheapRunAt: NOW - 5 * MINUTE,
                },
            },
            now: NOW,
            taskId: 't_stale_recheck',
        })
        const staleGate = (stale.nextState as Record<string, unknown>)._smartGate as Record<string, unknown>
        check('pre-wake stale recheck drops pending item', Array.isArray(staleGate.pending) && staleGate.pending.length === 0, staleGate)
        check('pre-wake stale recheck avoids model wake', stale.noteworthy === false, stale.summary)
        check('stale recheck is reported in the run summary', stale.summary.includes('1 stale dropped'), stale.summary)
    } finally {
        gmailSourceAdapter.revalidatePending = originalGmailRevalidate
        deleteMonitorWatch(staleGmail.id)
    }

    // --- suppressed Gmail auto-archive -------------------------------------
    // A learned suppress pattern keeps the model asleep, but when the watch has
    // explicitly granted gmail_archive the cheap pass should remove routine
    // suppressed mail from Inbox immediately. This uses the real Gmail
    // integration function against a fake temp token and fetch stub.
    const { writeGoogleOAuthToken } = await import('@/lib/integrations/google-oauth')
    const { activeRuntimePaths } = await import('@/lib/runtime-paths')
    writeGoogleOAuthToken(path.join(activeRuntimePaths().privateStateDir, 'auth', 'gmail.json'), {
        version: 1,
        provider: 'gmail',
        clientId: 'smoke-client',
        accountEmail: 'smoke@example.com',
        accessToken: 'smoke-access-token',
        scope: ['https://www.googleapis.com/auth/gmail.modify'],
        scopesRequested: ['https://www.googleapis.com/auth/gmail.modify'],
        expiresAt: Date.now() + HOUR,
        obtainedAt: Date.now(),
        updatedAt: Date.now(),
    })

    const originalFetch = globalThis.fetch
    const originalGmailAvailable = gmailSourceAdapter.isAvailable
    const originalGmailCheapCheck = gmailSourceAdapter.cheapCheck
    const originalWebAvailable = webSourceAdapter.isAvailable
    const originalWebCheapCheck = webSourceAdapter.cheapCheck
    const gmailFetchCalls: Array<{ url: string; method: string; body: string }> = []
    let failGmailArchive = false

    function gmailSuppressedMatch(
        id: string,
        threadId: string,
        labels: string[] = ['INBOX', 'UNREAD'],
    ) {
        return {
            candidate: {
                source: 'gmail' as const,
                id,
                threadId,
                labels,
                from: 'newsletter@example.com',
                to: 'me@example.com',
                subject: 'Sale digest',
                snippet: 'Routine offer',
                timestamp: NOW,
            },
            summary: 'newsletter@example.com — Sale digest',
            externalId: id,
            details: {
                messageId: id,
                threadId,
                from: 'newsletter@example.com',
                subject: 'Sale digest',
                labels,
            },
        }
    }

    function autoArchivePriorState() {
        return {
            minWakeGapMs: 15 * MINUTE,
            maxWakeGapMs: 6 * HOUR,
            _smartGate: { lastWakeAt: NOW, pending: [], lastCheapRunAt: NOW - 5 * MINUTE },
        }
    }

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = typeof input === 'string'
            ? input
            : input instanceof URL
                ? input.toString()
                : input.url
        const method = init?.method ?? 'GET'
        const body = typeof init?.body === 'string' ? init.body : ''
        gmailFetchCalls.push({ url, method, body })
        if (!url.startsWith('https://gmail.googleapis.com/gmail/v1/')) {
            return new Response(JSON.stringify({ error: { message: 'unexpected fetch' } }), { status: 500 })
        }
        if (failGmailArchive) {
            return new Response(JSON.stringify({ error: { message: 'forced archive failure' } }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            })
        }
        return new Response(JSON.stringify({ id: 'thr_archive', messages: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }) as typeof fetch

    gmailSourceAdapter.isAvailable = async () => ({ available: true })
    webSourceAdapter.isAvailable = async () => ({ available: true })

    try {
        const archiveWatch = createMonitorWatch({
            title: 'Archive routine newsletters',
            source: 'gmail',
            target: 'newsletter@example.com',
            rule: { kind: 'gmail_from', senders: ['newsletter@example.com'] },
            allowedActions: [{ kind: 'gmail_archive' }],
            createdBy: 'user',
        })
        const archivePattern = addSuppressPattern(archiveWatch.id, {
            reason: 'routine newsletter',
            rule: { kind: 'gmail_subject_contains', substrings: ['Sale'] },
        })!
        gmailSourceAdapter.cheapCheck = async (input) => ({
            ok: true,
            matches: [gmailSuppressedMatch('msg_archive', 'thr_archive')],
            candidatesSeen: 1,
            stateUpdate: {},
            fetchedAt: input.now,
        })
        gmailFetchCalls.length = 0
        failGmailArchive = false
        const archived = await runSmartMonitorCheapPass({
            priorState: autoArchivePriorState(),
            now: NOW,
            taskId: 't_suppressed_gmail_archive',
        })
        const archiveCall = gmailFetchCalls.find((call) => call.url.includes('/users/me/threads/thr_archive/modify'))
        const archiveAction = listWatchEvents(archiveWatch.id, { kinds: ['action'] })
            .find((event) => event.payload?.actionKind === 'gmail_archive')
        check('suppressed Gmail archive keeps model asleep', archived.noteworthy === false, archived.summary)
        check('suppressed Gmail archive prefers thread target', Boolean(archiveCall), gmailFetchCalls)
        check('suppressed Gmail archive removes INBOX', archiveCall?.body.includes('"removeLabelIds":["INBOX"]') === true, archiveCall)
        check('suppressed Gmail archive summary reports success', archived.summary.includes('suppress auto-archive: 1 archived, 0 error(s)'), archived.summary)
        check(
            'suppressed Gmail archive records action event metadata',
            archiveAction?.payload?.status === 'succeeded' &&
                archiveAction.payload.targetType === 'thread' &&
                archiveAction.payload.targetId === 'thr_archive' &&
                archiveAction.payload.suppressPatternId === archivePattern.id,
            archiveAction?.payload,
        )
        check(
            'suppressed Gmail archive still increments suppress match count',
            getMonitorWatch(archiveWatch.id)?.suppressPatterns.find((p) => p.id === archivePattern.id)?.matchCount === 1,
            getMonitorWatch(archiveWatch.id)?.suppressPatterns,
        )
        deleteMonitorWatch(archiveWatch.id)

        const noGrantWatch = createMonitorWatch({
            title: 'Suppress but do not archive',
            source: 'gmail',
            target: 'newsletter@example.com',
            rule: { kind: 'gmail_from', senders: ['newsletter@example.com'] },
            createdBy: 'user',
        })
        addSuppressPattern(noGrantWatch.id, {
            reason: 'routine newsletter',
            rule: { kind: 'gmail_subject_contains', substrings: ['Sale'] },
        })
        gmailSourceAdapter.cheapCheck = async (input) => ({
            ok: true,
            matches: [gmailSuppressedMatch('msg_no_grant', 'thr_no_grant')],
            candidatesSeen: 1,
            stateUpdate: {},
            fetchedAt: input.now,
        })
        gmailFetchCalls.length = 0
        const noGrant = await runSmartMonitorCheapPass({
            priorState: autoArchivePriorState(),
            now: NOW,
            taskId: 't_suppressed_gmail_no_archive_grant',
        })
        check('suppressed Gmail without grant does not call Gmail archive', gmailFetchCalls.length === 0, gmailFetchCalls)
        check('suppressed Gmail without grant reports zero auto-archives', noGrant.summary.includes('suppress auto-archive: 0 archived, 0 error(s)'), noGrant.summary)
        check('suppressed Gmail without grant records no action event', listWatchEvents(noGrantWatch.id, { kinds: ['action'] }).length === 0)
        deleteMonitorWatch(noGrantWatch.id)

        const notInboxWatch = createMonitorWatch({
            title: 'Suppress already archived mail',
            source: 'gmail',
            target: 'newsletter@example.com',
            rule: { kind: 'gmail_from', senders: ['newsletter@example.com'] },
            allowedActions: [{ kind: 'gmail_archive' }],
            createdBy: 'user',
        })
        addSuppressPattern(notInboxWatch.id, {
            reason: 'routine newsletter',
            rule: { kind: 'gmail_subject_contains', substrings: ['Sale'] },
        })
        gmailSourceAdapter.cheapCheck = async (input) => ({
            ok: true,
            matches: [gmailSuppressedMatch('msg_not_inbox', 'thr_not_inbox', ['UNREAD'])],
            candidatesSeen: 1,
            stateUpdate: {},
            fetchedAt: input.now,
        })
        gmailFetchCalls.length = 0
        const notInbox = await runSmartMonitorCheapPass({
            priorState: autoArchivePriorState(),
            now: NOW,
            taskId: 't_suppressed_gmail_not_inbox',
        })
        check('suppressed Gmail not in Inbox does not call Gmail archive', gmailFetchCalls.length === 0, gmailFetchCalls)
        check('suppressed Gmail not in Inbox reports zero auto-archives', notInbox.summary.includes('suppress auto-archive: 0 archived, 0 error(s)'), notInbox.summary)
        check('suppressed Gmail not in Inbox records no action event', listWatchEvents(notInboxWatch.id, { kinds: ['action'] }).length === 0)
        deleteMonitorWatch(notInboxWatch.id)

        const webWatch = createMonitorWatch({
            title: 'Suppressed web signal',
            source: 'web',
            target: 'https://example.com/status',
            rule: { kind: 'web_text_contains', url: 'https://example.com/status', substrings: ['sale'] },
            allowedActions: [{ kind: 'gmail_archive' }],
            createdBy: 'user',
        })
        addSuppressPattern(webWatch.id, {
            reason: 'web noise',
            rule: { kind: 'web_text_contains', url: 'https://example.com/status', substrings: ['sale'] },
        })
        webSourceAdapter.cheapCheck = async (input) => ({
            ok: true,
            matches: [{
                candidate: {
                    source: 'web' as const,
                    url: 'https://example.com/status',
                    status: 200,
                    previousStatus: null,
                    text: 'sale',
                    json: null,
                    previousJson: null,
                    fetchedAt: input.now,
                },
                summary: 'web sale',
                externalId: 'web_sale',
            }],
            candidatesSeen: 1,
            stateUpdate: {},
            fetchedAt: input.now,
        })
        gmailFetchCalls.length = 0
        const webSuppressed = await runSmartMonitorCheapPass({
            priorState: autoArchivePriorState(),
            now: NOW,
            taskId: 't_suppressed_non_gmail',
        })
        check('suppressed non-Gmail candidate never calls Gmail archive', gmailFetchCalls.length === 0, gmailFetchCalls)
        check('suppressed non-Gmail candidate remains suppressed', webSuppressed.noteworthy === false, webSuppressed.summary)
        deleteMonitorWatch(webWatch.id)

        const failWatch = createMonitorWatch({
            title: 'Archive can fail safely',
            source: 'gmail',
            target: 'newsletter@example.com',
            rule: { kind: 'gmail_from', senders: ['newsletter@example.com'] },
            allowedActions: [{ kind: 'gmail_archive' }],
            createdBy: 'user',
        })
        addSuppressPattern(failWatch.id, {
            reason: 'routine newsletter',
            rule: { kind: 'gmail_subject_contains', substrings: ['Sale'] },
        })
        gmailSourceAdapter.cheapCheck = async (input) => ({
            ok: true,
            matches: [gmailSuppressedMatch('msg_fail', 'thr_fail')],
            candidatesSeen: 1,
            stateUpdate: {},
            fetchedAt: input.now,
        })
        gmailFetchCalls.length = 0
        failGmailArchive = true
        const failedArchive = await runSmartMonitorCheapPass({
            priorState: autoArchivePriorState(),
            now: NOW,
            taskId: 't_suppressed_gmail_archive_failure',
        })
        const failedGate = (failedArchive.nextState as Record<string, unknown>)._smartGate as Record<string, unknown>
        const failedAction = listWatchEvents(failWatch.id, { kinds: ['action'] })
            .find((event) => event.payload?.actionKind === 'gmail_archive')
        const failedError = listWatchEvents(failWatch.id, { kinds: ['error'] })
            .find((event) => event.payload?.phase === 'cheap_pass_suppress_archive')
        check('failed suppressed Gmail archive does not buffer candidate', Array.isArray(failedGate.pending) && failedGate.pending.length === 0, failedGate)
        check('failed suppressed Gmail archive keeps model asleep', failedArchive.noteworthy === false, failedArchive.summary)
        check('failed suppressed Gmail archive summary reports error', failedArchive.summary.includes('suppress auto-archive: 0 archived, 1 error(s)'), failedArchive.summary)
        check('failed suppressed Gmail archive records action failure', failedAction?.payload?.status === 'failed' && failedAction.payload.targetId === 'thr_fail', failedAction?.payload)
        check('failed suppressed Gmail archive records error event', Boolean(failedError), failedError?.payload)
        deleteMonitorWatch(failWatch.id)
    } finally {
        failGmailArchive = false
        globalThis.fetch = originalFetch
        gmailSourceAdapter.isAvailable = originalGmailAvailable
        gmailSourceAdapter.cheapCheck = originalGmailCheapCheck
        webSourceAdapter.isAvailable = originalWebAvailable
        webSourceAdapter.cheapCheck = originalWebCheapCheck
    }

    // --- finalizeSmartMonitorWake ------------------------------------------
    const gate = {
        minWakeGapMs: 15 * MINUTE,
        maxWakeGapMs: 6 * HOUR,
        lastWakeAt: NOW - 20 * MINUTE,
        pending: [{ watchId: 'w1', watchTitle: 'W', source: 'gmail', summary: 's', ts: NOW }],
        lastCheapRunAt: NOW,
    }

    const okFinal = finalizeSmartMonitorWake({
        aiState: { digestQueue: ['x'], minWakeGapMs: 30 * MINUTE },
        preWakeState: {},
        gate,
        firedAt: NOW,
        ok: true,
    })
    const okBk = okFinal._smartGate as Record<string, unknown>
    check('finalize keeps agent state', Array.isArray(okFinal.digestQueue))
    check('finalize honours an agent knob change', okFinal.minWakeGapMs === 30 * MINUTE, okFinal.minWakeGapMs)
    check('finalize advances lastWakeAt', okBk?.lastWakeAt === NOW, okBk)
    check('finalize clears pending on success', Array.isArray(okBk?.pending) && (okBk.pending as unknown[]).length === 0)

    const failFinal = finalizeSmartMonitorWake({
        aiState: undefined, // agent crashed before set_task_state
        preWakeState: { something: 1 },
        gate,
        firedAt: NOW,
        ok: false,
    })
    const failBk = failFinal._smartGate as Record<string, unknown>
    check('finalize preserves pending on failure', Array.isArray(failBk?.pending) && (failBk.pending as unknown[]).length === 1)
    check('finalize advances lastWakeAt even on failure (backoff)', failBk?.lastWakeAt === NOW)
    check('finalize falls back to prior knob when agent omits it', failFinal.minWakeGapMs === 15 * MINUTE, failFinal.minWakeGapMs)

    console.log('')
    if (failures > 0) {
        console.error(`❌ ${failures} check(s) failed`)
        process.exit(1)
    }
    console.log('✅ ALL OK')
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
