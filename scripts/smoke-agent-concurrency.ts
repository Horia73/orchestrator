/**
 * Smoke test for the agent concurrency gate (lib/ai/concurrency-gate.ts).
 *
 * This is the safety net for the 2026-06-21 OOM incident: ~30 agents ran at
 * once with no global cap and the Node heap ballooned to 9 GB until the kernel
 * OOM-killed it. The gate bounds how many agents run at once. This smoke proves
 * the three guarantees WITHOUT spinning up real agents (pure gate logic):
 *
 *   1. The total-active cap is never exceeded, no matter the tree shape.
 *   2. The top-level (main) cap is never exceeded.
 *   3. Nested fan-out is DEADLOCK-FREE — a 1 → 10 → 5 tree completes even when
 *      the caps are far smaller than the tree (parents release their slot while
 *      awaiting children).
 *   4. Large trees are not rejected by a cumulative quota; they drain through
 *      the bounded active pools and complete under backpressure.
 *
 * Run with: npx tsx scripts/smoke-agent-concurrency.ts
 */
// Disable the staggered-admission ramp so the smoke runs fast (the ramp adds
// real setTimeout spacing between fresh starts in production).
process.env.AGENT_RAMP_MS = '0'
// Exercise the explicit process-memory backstop independently from the
// production RAM-derived default (which intentionally stays above Codex's
// active provider cap).
process.env.AGENT_MAX_RESIDENT_CODEX_PER_DEPTH = '2'

import {
    acquireRun,
    __setGateCapacitiesForTest,
    __setProviderCapForTest,
    getAgentGateStats,
} from '@/lib/ai/concurrency-gate'

let failures = 0
function check(label: string, ok: boolean, detail?: string) {
    if (ok) {
        console.log(`  ✓ ${label}`)
    } else {
        failures++
        console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Live counters that mirror exactly what the gate accounts for: an agent
// "holds a total slot" between acquire/reacquire completing and
// releaseForChildren/dispose. Peak of these must stay within the caps.
let liveTotal = 0
let maxTotal = 0
let liveMain = 0
let maxMain = 0
let completedRuns = 0
const maxResidentsByDepth = new Map<number, number>()

function enterTotal() {
    liveTotal++
    if (liveTotal > maxTotal) maxTotal = liveTotal
}
function leaveTotal() {
    liveTotal--
}

interface ChildPlan {
    count: number
    next: ChildPlan | null
}

/** Simulate one agent run using the gate exactly the way runner.ts +
 *  delegate-to.ts do: acquire → work → (release → run children → reacquire) →
 *  dispose. */
async function simulateAgent(opts: {
    depth: number
    isTopLevel: boolean
    plan: ChildPlan | null
    provider?: string
}): Promise<void> {
    const permit = await acquireRun({
        topLevel: opts.isTopLevel,
        priority: opts.isTopLevel ? 'background' : 'interactive',
        provider: opts.provider,
        depth: opts.depth,
    })
    if (opts.provider === 'codex') {
        const active = getAgentGateStats().residents[`codex:${opts.depth}`]?.active ?? 0
        maxResidentsByDepth.set(
            opts.depth,
            Math.max(maxResidentsByDepth.get(opts.depth) ?? 0, active),
        )
    }
    enterTotal()
    if (opts.isTopLevel) {
        liveMain++
        if (liveMain > maxMain) maxMain = liveMain
    }
    try {
        await sleep(2) // pre-delegation "model work"

        if (opts.plan && opts.plan.count > 0) {
            const children: Array<() => Promise<void>> = []
            for (let i = 0; i < opts.plan.count; i++) {
                children.push(() =>
                    simulateAgent({
                        depth: opts.depth + 1,
                        isTopLevel: false,
                        plan: opts.plan!.next,
                        provider: opts.provider,
                    })
                )
            }

            if (children.length > 0) {
                // delegate_parallel: release-while-waiting, then reclaim.
                leaveTotal()
                if (opts.isTopLevel) liveMain--
                permit.releaseForChildren()
                try {
                    await Promise.all(children.map(run => run()))
                } finally {
                    await permit.reacquireForResume()
                    enterTotal()
                    if (opts.isTopLevel) {
                        liveMain++
                        if (liveMain > maxMain) maxMain = liveMain
                    }
                }
                await sleep(2) // post-delegation "model work"
            }
        }
    } finally {
        leaveTotal()
        if (opts.isTopLevel) liveMain--
        completedRuns++
        permit.dispose()
    }
}

function resetCounters() {
    liveTotal = 0
    maxTotal = 0
    liveMain = 0
    maxMain = 0
    completedRuns = 0
    maxResidentsByDepth.clear()
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> {
    let timer: NodeJS.Timeout
    const timeout = new Promise<'TIMEOUT'>(resolve => {
        timer = setTimeout(() => resolve('TIMEOUT'), ms)
    })
    const result = await Promise.race([p.then(v => v as T), timeout])
    clearTimeout(timer!)
    return result
}

async function main() {
    console.log('Agent concurrency gate smoke\n')

    // ---- Scenario 1: the user's tree, caps far smaller than the tree --------
    // 1 orchestrator → 10 children → each 5 (= 61 agents) under MAIN=2/TOTAL=3.
    // A naive "gate everything" semaphore would DEADLOCK here. Release-while-
    // waiting must let it complete with peak active ≤ caps.
    console.log('Scenario 1 — deep fan-out (1→10→5) under tiny caps (main=2,total=3):')
    __setGateCapacitiesForTest(2, 3)
    resetCounters()
    const plan1: ChildPlan = { count: 10, next: { count: 5, next: null } }
    const r1 = await withTimeout(
        simulateAgent({ depth: 0, isTopLevel: true, plan: plan1 }),
        15_000
    )
    check('completed (no deadlock)', r1 !== 'TIMEOUT')
    check('total-active never exceeded cap (3)', maxTotal <= 3, `peak=${maxTotal}`)
    check('main never exceeded cap (2)', maxMain <= 2, `peak=${maxMain}`)
    check('counters drained to zero', liveTotal === 0 && liveMain === 0, `total=${liveTotal} main=${liveMain}`)

    // ---- Scenario 2: many top-level runs at once ----------------------------
    // 8 independent top-level runs (each delegating 4) with main=3/total=6.
    // Verifies the main cap throttles top-level stampede.
    console.log('\nScenario 2 — 8 concurrent top-level runs (main=3,total=6):')
    __setGateCapacitiesForTest(3, 6)
    resetCounters()
    const r2 = await withTimeout(
        Promise.all(
            Array.from({ length: 8 }, () =>
                simulateAgent({
                    depth: 0,
                    isTopLevel: true,
                    plan: { count: 4, next: null },
                })
            )
        ),
        15_000
    )
    check('completed (no deadlock)', r2 !== 'TIMEOUT')
    check('total-active never exceeded cap (6)', maxTotal <= 6, `peak=${maxTotal}`)
    check('main never exceeded cap (3)', maxMain <= 3, `peak=${maxMain}`)
    check('reached the main cap (throttling actually engaged)', maxMain === 3, `peak=${maxMain}`)
    check('counters drained to zero', liveTotal === 0 && liveMain === 0, `total=${liveTotal} main=${liveMain}`)

    // ---- Scenario 3: cumulative tree size is unlimited ----------------------
    // A 1→10→10 tree (111 total runs) must fully drain through an active cap of
    // 8. No completed child consumes a lifetime quota and no branch is rejected.
    // Codex residency is capped independently at each depth, which bounds RAM
    // without blocking the next depth's children.
    console.log('\nScenario 3 — large Codex tree (1→10→10), unlimited cumulative size:')
    __setGateCapacitiesForTest(4, 8)
    resetCounters()
    const plan3: ChildPlan = { count: 10, next: { count: 10, next: null } }
    const r3 = await withTimeout(
        simulateAgent({
            depth: 1,
            isTopLevel: true,
            plan: plan3,
            provider: 'codex',
        }),
        15_000
    )
    check('completed (no deadlock)', r3 !== 'TIMEOUT')
    check('all 111 runs completed', completedRuns === 111, `completed=${completedRuns}`)
    check('total-active never exceeded cap (8)', maxTotal <= 8, `peak=${maxTotal}`)
    check(
        'explicit Codex process-memory backstop stayed at ≤2 per depth',
        Array.from(maxResidentsByDepth.values()).every(peak => peak <= 2),
        JSON.stringify(Object.fromEntries(maxResidentsByDepth)),
    )
    check(
        'all three delegation-depth pools made progress',
        [1, 2, 3].every(depth => (maxResidentsByDepth.get(depth) ?? 0) > 0),
        JSON.stringify(Object.fromEntries(maxResidentsByDepth)),
    )
    check('counters drained to zero', liveTotal === 0 && liveMain === 0, `total=${liveTotal} main=${liveMain}`)

    // ---- Scenario 4: per-provider rate-limit cap ----------------------------
    // 10 agents all on the same backend with a generous total pool but a
    // provider cap of 3 — at most 3 may hit that backend at once (so a burst
    // can't trip the upstream 429/529).
    console.log('\nScenario 4 — per-provider cap (claude=3) with generous total (20):')
    __setGateCapacitiesForTest(20, 20)
    __setProviderCapForTest('claude', 3)
    let claudeLive = 0
    let claudeMax = 0
    const r4 = await withTimeout(
        Promise.all(
            Array.from({ length: 10 }, () => async () => {
                const permit = await acquireRun({ topLevel: false, priority: 'interactive', provider: 'claude' })
                claudeLive += 1
                if (claudeLive > claudeMax) claudeMax = claudeLive
                try {
                    await sleep(4)
                } finally {
                    claudeLive -= 1
                    permit.dispose()
                }
            }).map(run => run())
        ),
        15_000
    )
    check('completed (no deadlock)', r4 !== 'TIMEOUT')
    check('provider-active never exceeded cap (3)', claudeMax <= 3, `peak=${claudeMax}`)
    check('reached the provider cap (throttling engaged)', claudeMax === 3, `peak=${claudeMax}`)
    check('provider counter drained to zero', claudeLive === 0, `live=${claudeLive}`)

    // ---- Scenario 5: onQueued fires for runs that have to wait --------------
    // Drives the UI "queued" card. With total=2 and 5 runs, the 3 that wait for
    // a slot must each get an onQueued callback; the 2 that start immediately
    // must not.
    console.log('\nScenario 5 — onQueued fires for waiting runs (total=2, 5 runs):')
    __setGateCapacitiesForTest(2, 2)
    let onQueuedCount = 0
    const r5 = await withTimeout(
        Promise.all(
            Array.from({ length: 5 }, () => async () => {
                const permit = await acquireRun({
                    topLevel: false,
                    priority: 'interactive',
                    onQueued: () => {
                        onQueuedCount += 1
                    },
                })
                try {
                    await sleep(4)
                } finally {
                    permit.dispose()
                }
            }).map(run => run())
        ),
        15_000
    )
    check('completed', r5 !== 'TIMEOUT')
    check('onQueued fired for the 3 runs that waited', onQueuedCount === 3, `fired=${onQueuedCount}`)

    // ---- Scenario 6: cancellation removes a queued run ---------------------
    console.log('\nScenario 6 — cancelled queued admission is removed immediately:')
    __setGateCapacitiesForTest(1, 1)
    const blocker = await acquireRun({ topLevel: false, priority: 'interactive' })
    const abortController = new AbortController()
    let cancelledQueued = false
    const cancelled = acquireRun({
        topLevel: false,
        priority: 'interactive',
        signal: abortController.signal,
        onQueued: () => {
            cancelledQueued = true
        },
    }).then(
        permit => {
            permit.dispose()
            return false
        },
        error => error instanceof Error && error.name === 'AbortError',
    )
    await sleep(2)
    abortController.abort()
    check('cancelled waiter rejected as AbortError', await cancelled)
    check('cancelled waiter had entered the queue', cancelledQueued)
    check('cancelled waiter was removed from the queue', getAgentGateStats().totalQueued === 0)
    blocker.dispose()

    // A removed waiter must not consume the next released slot.
    const afterCancel = await withTimeout(
        acquireRun({ topLevel: false, priority: 'interactive' }),
        1_000,
    )
    check('next legitimate run starts normally', afterCancel !== 'TIMEOUT')
    if (afterCancel !== 'TIMEOUT') afterCancel.dispose()

    // ---- Scenario 7: gate accounting returns to idle ------------------------
    const stats = getAgentGateStats()
    check(
        'gate idle after all runs',
        stats.totalActive === 0 && stats.mainActive === 0,
        JSON.stringify(stats)
    )

    console.log('')
    if (failures > 0) {
        console.error(`❌ ${failures} check(s) failed`)
        process.exit(1)
    }
    console.log('✅ ALL OK')
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
