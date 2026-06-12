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
    const { createMonitorWatch, getMonitorWatch, setWatchCheckpoint } = await import(
        '@/lib/monitor/store'
    )

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
