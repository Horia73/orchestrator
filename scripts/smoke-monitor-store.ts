/**
 * Smoke test for the Smart Monitor store (step 1 foundation).
 *
 * Runs a full CRUD cycle against a TEMPORARY DB so it does NOT touch the
 * real .orchestrator/data.db. Validates:
 *   - schema accepts good input and produces a well-formed MonitorWatch
 *   - schema rejects bad input (cadence range, rule depth)
 *   - SQLite tables can be created, inserted, updated, queried, deleted
 *   - partial cadence update merges + re-validates
 *   - suppress patterns add/update/remove cycle works
 *   - watch events append, prune, and list correctly
 *   - listDueWatches returns null-nextCheckAt entries
 *
 * Run with: npx tsx scripts/smoke-monitor-store.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

// Force a private DB path BEFORE any module imports lib/db. The DB constructor
// reads process.cwd() — we cd into a fresh tmpdir, run the test, then exit.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-monitor-smoke-'))
process.chdir(tmpRoot)

async function main(): Promise<void> {
    const {
        addSuppressPattern,
        countEnabledWatches,
        createMonitorWatch,
        deleteMonitorWatch,
        getMonitorWatch,
        getNextDueTime,
        incrementSuppressPatternMatch,
        listDueWatches,
        listMonitorWatches,
        listWatchEvents,
        recordWatchEvent,
        completeWatchFollowUp,
        removeCompletedFollowUpWatches,
        reopenWatchFollowUp,
        removeSuppressPattern,
        setWatchCadenceCurrent,
        setWatchCheckpoint,
        setWatchEnabled,
        setWatchState,
        updateSuppressPatternExpiry,
        updateMonitorWatch,
    } = await import('@/lib/monitor/store')

    const { default: db } = await import('@/lib/db')
    const { MIN_CADENCE_SECONDS, MAX_CADENCE_SECONDS } = await import('@/lib/monitor/schema')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
        if (!ok) failures++
    }
    function expectThrow(label: string, fn: () => unknown) {
        let threw = false
        let err: unknown
        try {
            fn()
        } catch (e) {
            threw = true
            err = e
        }
        check(label, threw, err instanceof Error ? err.message : err)
    }

    // ---- 1. Happy path: create a Gmail watch ---------------------------------
    const created = createMonitorWatch({
        title: 'Mom @ Gmail',
        source: 'gmail',
        target: 'mom@example.com',
        rule: { kind: 'gmail_from', senders: ['mom@example.com'] },
        allowedActions: [{ kind: 'notify_inbox' }],
        notify: { onMatch: true },
    })
    check('create returns persisted MonitorWatch', created.id.startsWith('mw_'))
    check('default cadence.current is 15m', created.cadence.current === 15 * 60)
    check('cadence.min/max default to bounds', created.cadence.min === MIN_CADENCE_SECONDS && created.cadence.max === MAX_CADENCE_SECONDS)
    check('state.quietRuns defaults to 0', created.state.quietRuns === 0)
    check('nextCheckAt is null (unscheduled)', created.nextCheckAt === null)
    check('createdBy defaults to orchestrator', created.createdBy === 'orchestrator')

    // ---- 2. Round-trip: get + list -------------------------------------------
    const fetched = getMonitorWatch(created.id)
    check('getMonitorWatch round-trip matches', fetched?.id === created.id && fetched?.rule.kind === 'gmail_from')

    const all = listMonitorWatches()
    check('listMonitorWatches contains the new watch', all.find((w) => w.id === created.id) !== undefined)

    const byGmail = listMonitorWatches({ source: 'gmail' })
    check('filter by source=gmail', byGmail.length === 1)

    const byOther = listMonitorWatches({ source: 'home_assistant' })
    check('filter by source=home_assistant is empty', byOther.length === 0)

    check('countEnabledWatches = 1', countEnabledWatches() === 1)

    const legacyNow = Date.now()
    const legacyId = 'mw_legacy_cadence'
    db.prepare(`
        INSERT INTO monitor_watches (
            id, title, source, target, rule, allowedActions, cadence, notify, enabled,
            state, suppressPatterns, lastCheckedAt, nextCheckAt, lastFiredAt,
            consecutiveErrors, lastError, createdBy, createdAt, updatedAt
        ) VALUES (
            @id, @title, @source, @target, @rule, @allowedActions, @cadence, @notify, @enabled,
            @state, @suppressPatterns, NULL, NULL, NULL,
            0, NULL, @createdBy, @createdAt, @updatedAt
        )
    `).run({
        id: legacyId,
        title: 'Legacy 5 minute cadence',
        source: 'web',
        target: 'https://legacy.example.com',
        rule: JSON.stringify({ kind: 'web_status', url: 'https://legacy.example.com', op: 'equals', value: 200 }),
        allowedActions: JSON.stringify([{ kind: 'notify_inbox' }]),
        cadence: JSON.stringify({ current: 300, min: 300, max: 3600, adaptive: true }),
        notify: JSON.stringify({ onMatch: true }),
        enabled: 0,
        state: JSON.stringify({}),
        suppressPatterns: JSON.stringify([]),
        createdBy: 'orchestrator',
        createdAt: legacyNow,
        updatedAt: legacyNow,
    })
    const legacy = getMonitorWatch(legacyId)
    check('legacy stored 5m cadence normalizes to 15m slots', legacy?.cadence.current === 15 * 60 && legacy?.cadence.min === 15 * 60 && legacy?.cadence.max === 60 * 60)
    check('legacy disabled cadence row does not change enabled count', countEnabledWatches() === 1)
    deleteMonitorWatch(legacyId)

    // ---- 3. Schema rejections ------------------------------------------------
    expectThrow('reject cadence.current below MIN', () =>
        createMonitorWatch({
            title: 'too fast',
            source: 'web',
            target: 'https://example.com',
            rule: { kind: 'web_status', url: 'https://example.com', op: 'equals', value: 200 },
            cadence: { current: 60, min: MIN_CADENCE_SECONDS, max: MAX_CADENCE_SECONDS, adaptive: true },
        }),
    )
    expectThrow('reject cadence.min > cadence.max', () =>
        createMonitorWatch({
            title: 'inverted',
            source: 'web',
            target: 'https://example.com',
            rule: { kind: 'web_status', url: 'https://example.com', op: 'equals', value: 200 },
            cadence: { current: 15 * 60, min: 10 * 60, max: 9 * 60, adaptive: true },
        }),
    )
    expectThrow('reject rule nesting > MAX_RULE_DEPTH', () => {
        // 6 levels deep — exceeds limit
        const deep = (n: number): import('@/lib/monitor/schema').MonitorRule =>
            n <= 0
                ? { kind: 'gmail_from', senders: ['x@y.com'] }
                : { kind: 'any_of', rules: [deep(n - 1)] }
        createMonitorWatch({
            title: 'too deep',
            source: 'gmail',
            target: 'q',
            rule: deep(6),
        })
    })

    // ---- 4. Partial cadence update merges + re-validates --------------------
    const widened = updateMonitorWatch(created.id, { cadence: { current: 30 * 60 } })
    check('partial cadence update merges current', widened?.cadence.current === 30 * 60)
    check('partial cadence update keeps adaptive', widened?.cadence.adaptive === true)

    expectThrow('partial update rejects out-of-range current', () =>
        updateMonitorWatch(created.id, { cadence: { current: 99 * 60 * 60 } }),
    )

    // ---- 5. setWatchCadenceCurrent clamps and honors adaptive flag ----------
    const clamped = setWatchCadenceCurrent(created.id, 99 * 60 * 60)
    check('setWatchCadenceCurrent clamps to max', clamped?.cadence.current === MAX_CADENCE_SECONDS)

    updateMonitorWatch(created.id, { cadence: { adaptive: false } })
    const refused = setWatchCadenceCurrent(created.id, 30 * 60)
    check('setWatchCadenceCurrent is no-op when adaptive=false', refused?.cadence.current === MAX_CADENCE_SECONDS)
    const forced = setWatchCadenceCurrent(created.id, 10 * 60, { force: true })
    check('setWatchCadenceCurrent honors force flag and snaps to 15m', forced?.cadence.current === 15 * 60)

    // ---- 6. setWatchCheckpoint + listDueWatches -----------------------------
    const now = Date.now()
    setWatchCheckpoint(created.id, {
        lastCheckedAt: now,
        nextCheckAt: now + 5 * 60 * 1000,
    })
    const dueFuture = listDueWatches(now + 60 * 1000)
    check('not due yet at now+1m', dueFuture.length === 0)
    const dueNow = listDueWatches(now + 10 * 60 * 1000)
    check('due at now+10m', dueNow.length === 1)

    const nextDue = getNextDueTime()
    check('getNextDueTime returns scheduled time', nextDue !== null && nextDue >= now)

    // ---- 7. setWatchEnabled + disabled exclusion ----------------------------
    setWatchEnabled(created.id, false)
    check('disabled watch not counted', countEnabledWatches() === 0)
    check('disabled watch not in due list', listDueWatches(now + 10 * 60 * 1000).length === 0)
    setWatchEnabled(created.id, true)

    // ---- 8. setWatchState wholesale replace ---------------------------------
    setWatchState(created.id, {
        lastSeenId: 'msg_42',
        lastValue: null,
        lastValueAt: null,
        lastFetchedAt: now,
        quietRuns: 7,
        activeRuns: 0,
        lastNotifiedAt: null,
        lastNotifiedSummary: null,
        cumulativeMatches: 0,
        suppressedMatches: 0,
        extra: { gmailHistoryId: '12345' },
    })
    const stated = getMonitorWatch(created.id)
    check('state persisted', stated?.state.lastSeenId === 'msg_42' && stated?.state.quietRuns === 7)
    check('state.extra round-trips', (stated?.state.extra as Record<string, unknown>)?.gmailHistoryId === '12345')

    // ---- 9. Suppress patterns ------------------------------------------------
    const pattern = addSuppressPattern(created.id, {
        reason: 'newsletters never matter at night',
        rule: { kind: 'gmail_subject_contains', substrings: ['unsubscribe'] },
    })
    check('addSuppressPattern returns pattern', pattern !== null && pattern.id.startsWith('sp_'))

    const withPattern = getMonitorWatch(created.id)
    check('suppress pattern persisted', withPattern?.suppressPatterns.length === 1)

    const expiresAt = Date.now() + 7 * 86_400_000
    const updatedExpiry = updateSuppressPatternExpiry(created.id, pattern!.id, expiresAt)
    check('updateSuppressPatternExpiry sets expiry', updatedExpiry?.expiresAt === expiresAt)

    const madePermanent = updateSuppressPatternExpiry(created.id, pattern!.id, null)
    check('updateSuppressPatternExpiry can make permanent', madePermanent?.expiresAt === null)

    incrementSuppressPatternMatch(created.id, pattern!.id)
    incrementSuppressPatternMatch(created.id, pattern!.id)
    const counted = getMonitorWatch(created.id)
    check('suppress pattern matchCount bumps', counted?.suppressPatterns[0].matchCount === 2)

    const removed = removeSuppressPattern(created.id, pattern!.id)
    check('removeSuppressPattern returns true', removed === true)

    // Regression: learned patterns are durable and intentionally unbounded.
    // Crossing the old 64-entry ceiling must not make the watch unreadable.
    for (let i = 0; i < 70; i++) {
        addSuppressPattern(created.id, {
            reason: `learned noise pattern ${i}`,
            rule: { kind: 'gmail_subject_contains', substrings: [`noise-${i}`] },
        })
    }
    const beyondLegacyLimit = getMonitorWatch(created.id)
    check('suppress patterns remain readable beyond legacy limit', beyondLegacyLimit?.suppressPatterns.length === 70)

    // ---- 10. Watch events: append, list, kinds, prune -----------------------
    for (let i = 0; i < 5; i++) {
        recordWatchEvent(created.id, 'check', { i })
    }
    recordWatchEvent(created.id, 'match', { msgId: 'm1' })
    recordWatchEvent(created.id, 'wake', { reason: 'first match' })

    const events = listWatchEvents(created.id, { limit: 20 })
    // Plus the bootstrap event from create, plus the cadence_change/feedback
    // events from earlier setWatchCadenceCurrent and suppress-add/remove ops.
    check('events present', events.length >= 7)
    check('events sorted desc', events.every((e, i) => i === 0 || e.ts <= events[i - 1].ts))

    const checksOnly = listWatchEvents(created.id, { kinds: ['check'] })
    check('events filter by kind=check', checksOnly.length >= 5 && checksOnly.every((e) => e.kind === 'check'))

    const wakes = listWatchEvents(created.id, { kinds: ['wake'] })
    check('events filter by kind=wake', wakes.length === 1)

    // Prune: insert > MAX_EVENTS_PER_WATCH and ensure it's bounded.
    for (let i = 0; i < 600; i++) {
        recordWatchEvent(created.id, 'check', { burst: i })
    }
    const after = listWatchEvents(created.id, { limit: 1000 })
    check('event ring is bounded', after.length <= 500, { length: after.length })

    // ---- 11. Delete cascade --------------------------------------------------
    const eventsBefore = listWatchEvents(created.id).length
    check('events exist pre-delete', eventsBefore > 0)
    const ok = deleteMonitorWatch(created.id)
    check('deleteMonitorWatch returns true', ok)
    check('watch is gone', getMonitorWatch(created.id) === null)
    const eventsAfter = listWatchEvents(created.id).length
    check('events cascade-deleted', eventsAfter === 0)
    check('countEnabledWatches back to 0', countEnabledWatches() === 0)
    check('getNextDueTime returns null', getNextDueTime() === null)

    // ---- 12. Multi-source coexistence ---------------------------------------
    createMonitorWatch({
        title: 'Garage door',
        source: 'home_assistant',
        target: 'binary_sensor.garage_door',
        rule: { kind: 'ha_state_equals', entityId: 'binary_sensor.garage_door', state: 'open' },
        cadence: { current: 15 * 60, min: 15 * 60, max: 30 * 60, adaptive: true },
    })
    createMonitorWatch({
        title: 'Concert tickets page',
        source: 'web',
        target: 'https://tickets.example.com/event/42',
        rule: { kind: 'web_text_contains', url: 'https://tickets.example.com/event/42', substrings: ['Sold out'] },
    })
    createMonitorWatch({
        title: 'Calendar onboarding',
        source: 'google_calendar',
        target: 'primary',
        rule: { kind: 'calendar_event_query', q: 'onboarding' },
    })
    const sources = listMonitorWatches().map((w) => w.source).sort()
    check('multi-source coexistence', JSON.stringify(sources) === JSON.stringify(['google_calendar', 'home_assistant', 'web']))

    // ---- 13. Follow-up lifecycle (closed-loop actions) -----------------------
    const mainGmail = createMonitorWatch({
        title: 'Gmail triage',
        source: 'gmail',
        target: 'inbox',
        rule: { kind: 'gmail_query', q: 'in:inbox is:unread' },
    })
    const fuDeadline = Date.now() + 2 * 86_400_000
    const followUp = createMonitorWatch({
        title: 'Reply from Dan (offer thread)',
        source: 'gmail',
        target: 'dan@example.com',
        rule: { kind: 'gmail_from', senders: ['dan@example.com'] },
        followUp: { expectation: 'a reply from Dan about the Q3 offer', deadlineAt: fuDeadline, onDeadline: 'escalate' },
    })
    check('follow-up coexists with the main gmail watch', followUp.id.startsWith('mw_') && followUp.followUp?.expectation.includes('Dan'))
    check('follow-up starts uncompleted', followUp.followUp?.resolvedAt === null && followUp.followUp?.deadlineFiredAt === null)

    // Exemption is two-way: a second MAIN gmail watch is still rejected…
    expectThrow('second main gmail watch still rejected with follow-up present', () =>
        createMonitorWatch({
            title: 'Another gmail main',
            source: 'gmail',
            target: 'inbox',
            rule: { kind: 'gmail_query', q: 'in:inbox' },
        }),
    )
    // …and a lingering follow-up does not block a fresh main watch.
    deleteMonitorWatch(mainGmail.id)
    const mainAgain = createMonitorWatch({
        title: 'Gmail triage again',
        source: 'gmail',
        target: 'inbox',
        rule: { kind: 'gmail_query', q: 'in:inbox is:unread' },
    })
    check('follow-up does not count as the main gmail watch', mainAgain.id.startsWith('mw_'))

    expectThrow('follow-up with past deadline rejected', () =>
        createMonitorWatch({
            title: 'stale follow-up',
            source: 'gmail',
            target: 'x',
            rule: { kind: 'gmail_from', senders: ['x@y.com'] },
            followUp: { expectation: 'never', deadlineAt: Date.now() - 1000 },
        }),
    )

    // resolve → disabled + stamped; sweep removes it.
    const resolved = completeWatchFollowUp(followUp.id, 'resolved')
    check('completeWatchFollowUp stamps resolvedAt + disables', resolved?.followUp?.resolvedAt !== null && resolved?.enabled === false)
    check('completeWatchFollowUp is idempotent', completeWatchFollowUp(followUp.id, 'deadline')?.followUp?.deadlineFiredAt === null)
    const fuEvents = listWatchEvents(followUp.id, { kinds: ['followup'] })
    check('followup event recorded', fuEvents.length === 1 && fuEvents[0].payload?.outcome === 'resolved')

    // re-arm → enabled, stamps cleared, deadline extendable, survives the sweep.
    const reopened = reopenWatchFollowUp(followUp.id, { extendDeadlineToMs: fuDeadline + 86_400_000 })
    check('reopenWatchFollowUp re-arms', reopened?.enabled === true && reopened?.followUp?.resolvedAt === null)
    check('reopenWatchFollowUp extends deadline', reopened?.followUp?.deadlineAt === fuDeadline + 86_400_000)
    check('sweep skips re-armed follow-up', removeCompletedFollowUpWatches().length === 0 && getMonitorWatch(followUp.id) !== null)

    // deadline → completed; sweep removes exactly it.
    completeWatchFollowUp(followUp.id, 'deadline')
    const swept = removeCompletedFollowUpWatches()
    check('sweep removes completed follow-up', swept.length === 1 && swept[0] === followUp.id && getMonitorWatch(followUp.id) === null)
    check('sweep leaves ordinary watches alone', getMonitorWatch(mainAgain.id) !== null)

    // user_signal events (behavioral learning feed) are recordable + filterable.
    recordWatchEvent(mainAgain.id, 'user_signal', { signal: 'dismissed_unread', conversationId: 'inbox_x' })
    recordWatchEvent(mainAgain.id, 'user_signal', { signal: 'quick_action', tool: 'gmail.archive', conversationId: 'inbox_x' })
    const signals = listWatchEvents(mainAgain.id, { kinds: ['user_signal'] })
    check('user_signal events recorded + filtered', signals.length === 2 && signals.every((e) => e.kind === 'user_signal'))
    deleteMonitorWatch(mainAgain.id)

    console.log(`\n${failures === 0 ? '✅ ALL OK' : `❌ ${failures} failure(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error('Unhandled error in smoke test:', err)
    process.exit(2)
})
