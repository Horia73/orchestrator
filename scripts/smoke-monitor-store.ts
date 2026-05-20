/**
 * Smoke test for the Smart Monitor store (step 1 foundation).
 *
 * Runs a full CRUD cycle against a TEMPORARY DB so it does NOT touch the
 * real .orchestrator/data.db. Validates:
 *   - schema accepts good input and produces a well-formed MonitorWatch
 *   - schema rejects bad input (cadence range, rule depth)
 *   - SQLite tables can be created, inserted, updated, queried, deleted
 *   - partial cadence update merges + re-validates
 *   - suppress patterns add/remove cycle works
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
        removeSuppressPattern,
        setWatchCadenceCurrent,
        setWatchCheckpoint,
        setWatchEnabled,
        setWatchState,
        updateMonitorWatch,
    } = await import('@/lib/monitor/store')

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
    const refused = setWatchCadenceCurrent(created.id, 10 * 60)
    check('setWatchCadenceCurrent is no-op when adaptive=false', refused?.cadence.current === MAX_CADENCE_SECONDS)
    const forced = setWatchCadenceCurrent(created.id, 10 * 60, { force: true })
    check('setWatchCadenceCurrent honors force flag', forced?.cadence.current === 10 * 60)

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

    incrementSuppressPatternMatch(created.id, pattern!.id)
    incrementSuppressPatternMatch(created.id, pattern!.id)
    const counted = getMonitorWatch(created.id)
    check('suppress pattern matchCount bumps', counted?.suppressPatterns[0].matchCount === 2)

    const removed = removeSuppressPattern(created.id, pattern!.id)
    check('removeSuppressPattern returns true', removed === true)

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
        cadence: { current: 5 * 60, min: 5 * 60, max: 30 * 60, adaptive: true },
    })
    createMonitorWatch({
        title: 'Concert tickets page',
        source: 'web',
        target: 'https://tickets.example.com/event/42',
        rule: { kind: 'web_text_contains', url: 'https://tickets.example.com/event/42', substrings: ['Sold out'] },
    })
    const sources = listMonitorWatches().map((w) => w.source).sort()
    check('multi-source coexistence', JSON.stringify(sources) === JSON.stringify(['home_assistant', 'web']))

    console.log(`\n${failures === 0 ? '✅ ALL OK' : `❌ ${failures} failure(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error('Unhandled error in smoke test:', err)
    process.exit(2)
})
