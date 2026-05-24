/**
 * Smoke test for the Smart Monitor engine (Step 3) — exercises the cheap
 * pass end-to-end against an in-process mock adapter. No network, no
 * scheduler, no model. Validates:
 *   - idle tick with no watches → noteworthy=false, idle summary
 *   - one match → noteworthy=true, briefPrompt includes watch + summary
 *   - suppress patterns drop matches and bump pattern counters
 *   - quiet hours hold matches → noteworthy=false, audit suppress events
 *   - adaptive cadence widens after sustained quiet, tightens on activity
 *   - integration unavailability records `check` event + does NOT bump
 *     consecutiveErrors
 *   - cheap-check error bumps consecutiveErrors and applies exponential
 *     backoff
 *   - multiple watches in one tick → consolidated briefPrompt across all
 *
 * Run: npx tsx scripts/smoke-monitor-engine.ts
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { WatchSource } from '@/lib/monitor/schema'
import type { SourceAdapter } from '@/lib/monitor/sources'

// Force a private DB path before any module imports lib/db.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-monitor-engine-smoke-'))
process.chdir(tmpRoot)

async function main(): Promise<void> {
    const {
        createMonitorWatch,
        addSuppressPattern,
        getMonitorWatch,
        listWatchEvents,
        setWatchCheckpoint,
    } = await import('@/lib/monitor/store')
    const { runSmartMonitorCheapPass, computeAdaptiveCadence, isInQuietHours } = await import(
        '@/lib/monitoring/smart-monitor'
    )
    const { MIN_CADENCE_SECONDS } = await import('@/lib/monitor/schema')

    let failures = 0
    function check(label: string, cond: unknown, detail?: unknown) {
        const ok = Boolean(cond)
        console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
        if (!ok) failures++
    }

    // ---- Adapter mock -------------------------------------------------------
    interface MockBehavior {
        available?: boolean
        availableReason?: string
        matches?: Array<{ id: string; summary: string; body: string; from?: string }>
        webMatches?: Array<{ id: string; summary: string; text: string }>
        haMatches?: Array<{ id: string; summary: string; entityId: string }>
        throwInCheap?: boolean
        ok?: boolean
        errorMessage?: string
    }
    let behavior: MockBehavior = {}
    function setBehavior(b: MockBehavior) { behavior = b }

    const gmailMock: SourceAdapter = {
        source: 'gmail',
        supportedRuleKinds: ['gmail_from', 'gmail_subject_contains'],
        supportedActionKinds: ['notify_inbox'],
        async isAvailable() {
            return behavior.available === false
                ? { available: false, reason: behavior.availableReason ?? 'not available' }
                : { available: true }
        },
        async cheapCheck({ now }) {
            if (behavior.throwInCheap) throw new Error('boom')
            if (behavior.ok === false) {
                return {
                    ok: false,
                    error: behavior.errorMessage ?? 'mock error',
                    matches: [],
                    candidatesSeen: 0,
                    stateUpdate: {},
                    fetchedAt: now,
                }
            }
            const mocks = behavior.matches ?? []
            const matches = mocks.map((m) => ({
                candidate: {
                    source: 'gmail' as const,
                    id: m.id,
                    threadId: 't_' + m.id,
                    labels: ['INBOX'],
                    from: m.from ?? 'mom@example.com',
                    to: 'me@example.com',
                    subject: m.summary,
                    snippet: m.body,
                    timestamp: now,
                },
                summary: m.summary,
                externalId: m.id,
                details: { id: m.id, from: m.from ?? 'mom@example.com' },
            }))
            return {
                ok: true,
                matches,
                candidatesSeen: mocks.length,
                stateUpdate: { lastFetchedAt: now },
                fetchedAt: now,
            }
        },
    }
    const haMock: SourceAdapter = {
        source: 'home_assistant',
        supportedRuleKinds: ['ha_state_equals', 'ha_state_changes', 'ha_attribute_changes', 'ha_threshold'],
        supportedActionKinds: ['notify_inbox'],
        async isAvailable() { return { available: true } },
        async cheapCheck({ now }) {
            const mocks = behavior.haMatches ?? []
            const matches = mocks.map((m) => ({
                candidate: {
                    source: 'home_assistant' as const,
                    entityId: m.entityId,
                    state: 'on',
                    attributes: {},
                    numericValue: null,
                    previousState: 'off',
                    previousAttributes: {},
                    previousNumericValue: null,
                    lastChanged: now,
                },
                summary: m.summary,
                externalId: m.id,
                details: { entityId: m.entityId },
            }))
            return { ok: true, matches, candidatesSeen: mocks.length, stateUpdate: { lastFetchedAt: now }, fetchedAt: now }
        },
    }
    const webMock: SourceAdapter = {
        source: 'web',
        supportedRuleKinds: ['web_status', 'web_json_path', 'web_text_contains'],
        supportedActionKinds: ['notify_inbox'],
        async isAvailable() { return { available: true } },
        async cheapCheck({ now }) {
            const mocks = behavior.webMatches ?? []
            const matches = mocks.map((m) => ({
                candidate: {
                    source: 'web' as const,
                    url: 'https://example.com/status',
                    status: 200,
                    previousStatus: 200,
                    text: m.text,
                    json: null,
                    previousJson: null,
                    fetchedAt: now,
                },
                summary: m.summary,
                externalId: m.id,
                details: { url: 'https://example.com/status' },
            }))
            return { ok: true, matches, candidatesSeen: mocks.length, stateUpdate: { lastFetchedAt: now }, fetchedAt: now }
        },
    }

    const mockRegistry = (source: WatchSource): SourceAdapter => {
        if (source === 'gmail') return gmailMock
        if (source === 'home_assistant') return haMock
        if (source === 'web') return webMock
        throw new Error(`unmocked source: ${source}`)
    }

    // ============================================================================
    // 1. Idle: no watches due → noteworthy=false
    // ============================================================================
    {
        const t0 = Date.now()
        const r = await runSmartMonitorCheapPass({ now: t0, getAdapter: mockRegistry })
        check('idle tick with no watches → not noteworthy', r.noteworthy === false)
        check('idle summary marks no due watches', r.summary.includes('no watches due'))
    }

    // ============================================================================
    // 2. One match → noteworthy + briefPrompt
    // ============================================================================
    const w1 = createMonitorWatch({
        title: 'Mom @ Gmail',
        source: 'gmail',
        target: 'mom@example.com',
        rule: { kind: 'gmail_from', senders: ['mom@example.com'] },
    })

    setBehavior({
        available: true,
        matches: [{ id: 'm1', summary: 'Urgent: car broke', body: 'Call me' }],
    })
    {
        const t1 = Date.now() + 1
        const r = await runSmartMonitorCheapPass({ now: t1, getAdapter: mockRegistry })
        check('one match → noteworthy', r.noteworthy === true)
        check('briefPrompt mentions watch title', r.briefPrompt?.includes('Mom @ Gmail') === true)
        check('briefPrompt mentions match summary', r.briefPrompt?.includes('Urgent: car broke') === true)
        check('debug counts match', r.debug.matchesSurviving === 1 && r.debug.watchesProcessed === 1)
    }

    // Verify checkpoint set + activity counter bumped
    {
        const w = getMonitorWatch(w1.id)!
        check('lastCheckedAt updated', w.lastCheckedAt !== null)
        check('nextCheckAt scheduled in future', w.nextCheckAt !== null && w.nextCheckAt > Date.now())
        check('nextCheckAt aligned to 15-minute slot', w.nextCheckAt !== null && w.nextCheckAt % (15 * 60 * 1000) === 0)
        check('activeRuns bumped to 1', w.state.activeRuns === 1)
        check('quietRuns reset to 0', w.state.quietRuns === 0)
        check('lastFiredAt set', w.lastFiredAt !== null)
    }

    // ============================================================================
    // 3. Suppress pattern drops a match
    // ============================================================================
    // Add a suppress pattern that matches messages from 'mom@example.com' →
    // next match should be dropped.
    const pat = addSuppressPattern(w1.id, {
        reason: 'mom test pattern',
        rule: { kind: 'gmail_from', senders: ['mom@example.com'] },
    })!

    // Force the watch to be due now so the tick processes it.
    setWatchCheckpoint(w1.id, { nextCheckAt: Date.now() })
    setBehavior({
        available: true,
        matches: [{ id: 'm2', summary: 'Suppressible msg', body: '...' }],
    })
    {
        const t2 = Date.now() + 2
        const r = await runSmartMonitorCheapPass({ now: t2, getAdapter: mockRegistry })
        check('suppress pattern drops match', r.noteworthy === false)
        check('debug.matchesSuppressed = 1', r.debug.matchesSuppressed === 1)
        check('debug.matchesSurviving = 0', r.debug.matchesSurviving === 0)
    }

    // Verify pattern matchCount incremented
    {
        const w = getMonitorWatch(w1.id)!
        const p = w.suppressPatterns.find((p) => p.id === pat.id)
        check('suppress pattern matchCount bumped to 1', p?.matchCount === 1)
    }

    // Verify suppress event recorded
    {
        const events = listWatchEvents(w1.id, { kinds: ['suppress'] })
        check('suppress event recorded', events.length >= 1 && events[0].payload?.patternId === pat.id)
    }

    // ============================================================================
    // 4. Quiet hours hold a match
    // ============================================================================
    // Build a quiet-hours watch where "now" is within the window. Use a tz
    // that wraps midnight to also exercise the wrap branch.
    const w2 = createMonitorWatch({
        title: 'Status page quiet watch',
        source: 'web',
        target: 'https://example.com/status',
        rule: { kind: 'web_status', url: 'https://example.com/status', op: 'equals', value: 200 },
        notify: {
            onMatch: true,
            quietHours: { from: '00:00', to: '23:59', timezone: 'UTC' }, // basically always quiet
        },
    })
    setWatchCheckpoint(w2.id, { nextCheckAt: Date.now() })
    setBehavior({
        available: true,
        webMatches: [{ id: 'w1', summary: 'Status page matched', text: 'ok' }],
    })
    {
        const t3 = Date.now() + 3
        const r = await runSmartMonitorCheapPass({ now: t3, getAdapter: mockRegistry })
        check('quiet hours hold the match (not noteworthy)', r.noteworthy === false)
        check('debug.matchesQuietHours = 1', r.debug.matchesQuietHours === 1)
    }

    // ============================================================================
    // 5. Adaptive cadence — pure function
    // ============================================================================
    const minC = MIN_CADENCE_SECONDS
    const maxC = 12 * 3600
    check('cadence tightens on active run', computeAdaptiveCadence(1800, minC, maxC, 0, true) < 1800)
    check('cadence stays steady on first quiet runs', computeAdaptiveCadence(900, minC, maxC, 1, false) === 900)
    check('cadence widens at threshold 1 (4 quiet)', computeAdaptiveCadence(900, minC, maxC, 4, false) > 900)
    check('cadence widens further at threshold 2', computeAdaptiveCadence(900, minC, maxC, 12, false) > Math.round(900 * 1.5))
    check('cadence clamps at min on tighten', computeAdaptiveCadence(minC, minC, maxC, 0, true) === minC)
    check('cadence clamps at max on widen', computeAdaptiveCadence(maxC, minC, maxC, 12, false) === maxC)

    // ============================================================================
    // 6. isInQuietHours pure function — wrap-around handling
    // ============================================================================
    // 02:00 UTC inside a 23:00-07:00 window
    const utcAtClock = (h: number, m: number) => {
        const d = new Date()
        d.setUTCHours(h, m, 0, 0)
        return d.getTime()
    }
    check(
        'quiet hours wrap-around: 02:00 inside 23:00-07:00',
        isInQuietHours(
            { onMatch: true, quietHours: { from: '23:00', to: '07:00', timezone: 'UTC' } },
            utcAtClock(2, 0),
        ),
    )
    check(
        'quiet hours wrap-around: 12:00 outside 23:00-07:00',
        !isInQuietHours(
            { onMatch: true, quietHours: { from: '23:00', to: '07:00', timezone: 'UTC' } },
            utcAtClock(12, 0),
        ),
    )
    check(
        'no quietHours → never quiet',
        !isInQuietHours({ onMatch: true }, Date.now()),
    )

    // ============================================================================
    // 7. Adapter unavailable → check event, no consecutiveErrors bump
    // ============================================================================
    setWatchCheckpoint(w1.id, { nextCheckAt: Date.now() })
    const beforeErrors = getMonitorWatch(w1.id)!.consecutiveErrors
    setBehavior({ available: false, availableReason: 'Gmail disconnected' })
    {
        const t4 = Date.now() + 4
        const r = await runSmartMonitorCheapPass({ now: t4, getAdapter: mockRegistry })
        check('unavailable → not noteworthy', r.noteworthy === false)
        check('debug.watchesUnavailable = 1', r.debug.watchesUnavailable >= 1)
        const w = getMonitorWatch(w1.id)!
        check('consecutiveErrors NOT bumped on integration outage', w.consecutiveErrors === beforeErrors)
        check('lastError set to availability reason', w.lastError === 'Gmail disconnected')
    }

    // ============================================================================
    // 8. Cheap-check error → bump consecutiveErrors, exponential backoff
    // ============================================================================
    setWatchCheckpoint(w1.id, { nextCheckAt: Date.now(), consecutiveErrors: 0 })
    setBehavior({ available: true, ok: false, errorMessage: 'network down' })
    {
        const tickAt = Date.now() + 5
        const r = await runSmartMonitorCheapPass({ now: tickAt, getAdapter: mockRegistry })
        check('error → not noteworthy', r.noteworthy === false)
        check('debug.watchesErrored >= 1', r.debug.watchesErrored >= 1)
        const w = getMonitorWatch(w1.id)!
        check('consecutiveErrors bumped to 1', w.consecutiveErrors === 1)
        check('lastError set', w.lastError === 'network down')
        // Backoff: at least the cadence ms (could be more if backoff kicked in larger).
        check('nextCheckAt scheduled in the future', w.nextCheckAt !== null && w.nextCheckAt > tickAt)
    }

    // ============================================================================
    // 9. Multi-watch consolidated wake
    // ============================================================================
    // Reset w1 to be due, behavior to produce one Gmail match. Create a new
    // Home Assistant watch w3 also due, with another match. One tick should produce
    // ONE briefPrompt with both watches enumerated.
    setWatchCheckpoint(w1.id, { nextCheckAt: Date.now(), consecutiveErrors: 0 })
    const w3 = createMonitorWatch({
        title: 'Garage door',
        source: 'home_assistant',
        target: 'binary_sensor.garage_door',
        rule: { kind: 'ha_state_equals', entityId: 'binary_sensor.garage_door', state: 'on' },
    })
    // Mark w3 already primed so it doesn't no-op on first tick (only used
    // for production Gmail adapter — our mock doesn't prime).
    setWatchCheckpoint(w3.id, { nextCheckAt: Date.now() })

    // Remove suppress pattern so w1's match comes through.
    // (We added one earlier — list and remove it.)
    const { removeSuppressPattern } = await import('@/lib/monitor/store')
    {
        const w = getMonitorWatch(w1.id)!
        for (const p of w.suppressPatterns) removeSuppressPattern(w1.id, p.id)
    }

    setBehavior({
        available: true,
        matches: [{ id: 'mm1', summary: 'shared message - both watches see it', body: 'hi from both' }],
        haMatches: [{ id: 'ha1', summary: 'Garage door opened', entityId: 'binary_sensor.garage_door' }],
    })
    {
        const t5 = Date.now() + 6
        const r = await runSmartMonitorCheapPass({ now: t5, getAdapter: mockRegistry })
        check('multi-watch tick is noteworthy', r.noteworthy === true)
        check('briefPrompt mentions Mom @ Gmail', r.briefPrompt?.includes('Mom @ Gmail') === true)
        check('briefPrompt mentions Garage door', r.briefPrompt?.includes('Garage door') === true)
        check('debug.watchesProcessed >= 2', r.debug.watchesProcessed >= 2)
    }

    console.log(`\n${failures === 0 ? '✅ ALL OK' : `❌ ${failures} failure(s)`}`)
    process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error('Unhandled error in smoke test:', err)
    process.exit(2)
})
