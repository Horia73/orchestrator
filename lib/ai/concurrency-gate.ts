// Global agent concurrency gate.
//
// Why this exists: on 2026-06-21 the production box (16 GB, 0 swap) OOM-killed
// the Node server because ~30 agents ran at once and the main process heap
// ballooned to 9 GB. There was no global cap. Beyond the crash, even 3-4 agents
// streaming at once starve the single Node event loop enough that the SSE
// connection drops ("reconnecting"). This gate bounds concurrency on THREE
// independent axes, each guarding a distinct failure mode:
//
//   • total pool   — concurrent ACTIVE agents at ANY depth. Guards RAM (crash)
//     and, with staggered admission, the event loop (lag). Sized ADAPTIVELY
//     from the machine: min(RAM budget, core budget). Env override:
//     AGENT_TOTAL_CONCURRENCY.
//   • main pool    — concurrent TOP-LEVEL runs (parent is synthetic: scheduler,
//     inbox reply, microscript wake, artifact repair). Defaults to total/2.
//     Env override: AGENT_MAIN_CONCURRENCY.
//   • provider pool — concurrent active agents PER backend (claude / codex /
//     google / browser). Guards the upstream API rate limit (429/529): 10
//     Claude agents at once tripped a 529, so claude is capped well under that.
//     Env override: AGENT_MAX_PROVIDER_<NAME> (e.g. AGENT_MAX_PROVIDER_CLAUDE).
//   • tree budget  — max agents a single top-level run may spawn across its
//     whole sub-tree. Default 12. Backstop against runaway recursion: when
//     hit, delegate_to degrades gracefully instead of queueing forever.
//
// Staggered admission ("pe rand"): fresh agent starts are spaced by ~800ms (and
// further when the event loop is already lagging) so a fan-out burst doesn't
// slam the loop and drop the user's SSE. Resume re-acquisitions skip the ramp.
//
// Deadlock freedom: a parent that called delegate_to and is AWAITING its
// children is idle (its model turn is paused). It RELEASES its total + provider
// slots for the duration (`releaseForChildren`) and re-acquires them at the
// highest priority before resuming (`reacquireForResume`). The slots are thus
// always available to the agents actually doing work — no hold-and-wait cycle.
// All acquisitions use the same order (provider → main → total), so there is no
// lock-ordering deadlock either.
//
// All state lives on globalThis so it survives Next.js hot reloads.

import os from 'os'
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks'
import { acquireFleetRun, getFleetConcurrencyStats } from '@/lib/ai/fleet-concurrency'

/** Parse a positive integer env var; fall back when unset/invalid. */
function envInt(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Like envInt but allows 0 (used for knobs where 0 = "disabled"). */
function envIntNonNeg(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Higher number = served first. Resuming parents beat fresh children beat new
 *  top-level runs, so started trees drain before new ones start. */
const PRIORITY = { resume: 3, interactive: 2, background: 1 } as const
export type GatePriority = keyof typeof PRIORITY

interface Waiter {
    priority: number
    seq: number
    resolve: () => void
}

/** Counting semaphore with a priority waiter queue. A released permit is handed
 *  directly to the highest-priority waiter (FIFO within a priority) rather than
 *  bumping the free count, so in-flight work is never starved by a thundering
 *  herd of equal-priority newcomers. */
class PrioritySemaphore {
    private inUse = 0
    private waiters: Waiter[] = []
    private seqCounter = 0

    constructor(public capacity: number) {}

    get active(): number {
        return this.inUse
    }

    get queued(): number {
        return this.waiters.length
    }

    acquire(priority: number): Promise<void> {
        if (this.inUse < this.capacity) {
            this.inUse++
            return Promise.resolve()
        }
        return new Promise<void>(resolve => {
            const waiter: Waiter = { priority, seq: this.seqCounter++, resolve }
            // Insert keeping the queue sorted: priority desc, then seq asc.
            let i = this.waiters.length
            while (i > 0) {
                const w = this.waiters[i - 1]
                if (w.priority > priority || (w.priority === priority && w.seq < waiter.seq)) break
                i--
            }
            this.waiters.splice(i, 0, waiter)
        })
    }

    release(): void {
        const next = this.waiters.shift()
        if (next) {
            // Transfer the permit directly — inUse is unchanged (still held, now
            // by the woken waiter).
            next.resolve()
        } else if (this.inUse > 0) {
            this.inUse--
        }
    }
}

// ---------------------------------------------------------------------------
// Adaptive limits — derived from the machine, overridable by env.
// ---------------------------------------------------------------------------

interface AdaptiveLimits {
    total: number
    main: number
    cores: number
    totalMB: number
    ramCap: number
    coreCap: number
}

function computeAdaptiveLimits(): AdaptiveLimits {
    const cores = Math.max(1, os.cpus().length)
    const totalMB = Math.max(1024, Math.floor(os.totalmem() / (1024 * 1024)))
    // Leave headroom for the main Node process, the OS, and neighbour
    // containers; budget the rest at a conservative per-agent working set.
    const reserveMB = envInt('AGENT_RESERVE_MB', 2000)
    const perAgentMB = envInt('AGENT_PER_AGENT_MB', 300)
    const ramCap = Math.max(2, Math.floor((totalMB - reserveMB) / perAgentMB))
    // Event-loop budget: agents are mostly API-bound (idle, waiting on the
    // upstream), but their streaming hits the single loop. ~1.5 per core keeps
    // the loop responsive; the staggered ramp absorbs the startup spikes.
    const coreCap = Math.max(2, Math.floor(cores * 1.5))
    const hardMax = envInt('AGENT_TOTAL_HARD_MAX', 64)
    const autoTotal = Math.min(ramCap, coreCap, hardMax)
    const total = Math.max(2, envInt('AGENT_TOTAL_CONCURRENCY', autoTotal))
    const autoMain = Math.max(1, Math.floor(total / 2))
    const main = Math.min(total, Math.max(1, envInt('AGENT_MAIN_CONCURRENCY', autoMain)))
    return { total, main, cores, totalMB, ramCap, coreCap }
}

/** Per-provider concurrency cap — the rate-limit guard. Claude is capped well
 *  under the level that tripped a 529 (10 concurrent). */
function providerCap(provider: string): number {
    const key = provider.toLowerCase()
    const defaults: Record<string, number> = {
        claude: 5,
        'claude-code': 5,
        anthropic: 5,
        codex: 6,
        openai: 6,
        google: 8,
        gemini: 8,
        browser: 2,
    }
    const envName = `AGENT_MAX_PROVIDER_${key.replace(/[^a-z0-9]+/g, '_').toUpperCase()}`
    const fallback = defaults[key] ?? envInt('AGENT_MAX_PROVIDER_DEFAULT', 4)
    return envInt(envName, fallback)
}

// ---------------------------------------------------------------------------
// Event-loop lag monitor (drives the adaptive ramp).
// ---------------------------------------------------------------------------

let loopMonitor: IntervalHistogram | null = null
let loopMonitorTried = false

function loopLagMs(): number {
    if (!loopMonitorTried) {
        loopMonitorTried = true
        try {
            loopMonitor = monitorEventLoopDelay({ resolution: 20 })
            loopMonitor.enable()
            // Reset on an interval so `mean` reflects a recent window, not the
            // whole process lifetime. Unref'd so it never holds the process up.
            const t = setInterval(() => {
                try {
                    loopMonitor?.reset()
                } catch {
                    /* ignore */
                }
            }, 5000)
            t.unref?.()
        } catch {
            loopMonitor = null
        }
    }
    if (!loopMonitor) return 0
    const mean = loopMonitor.mean / 1e6 // ns → ms
    return Number.isFinite(mean) ? mean : 0
}

// ---------------------------------------------------------------------------
// Gate state.
// ---------------------------------------------------------------------------

interface GateState {
    limits: AdaptiveLimits
    main: PrioritySemaphore
    total: PrioritySemaphore
    providers: Map<string, PrioritySemaphore>
    /** rootRunId -> agents spawned across this top-level run's whole sub-tree. */
    treeSpawns: Map<string, number>
    /** Detached async children keep the root budget alive after an intermediate
     *  parent run finishes. The owner release is deferred until every lease is
     *  returned. */
    treeRetainers: Map<string, number>
    treeOwnerReleasePending: Set<string>
    treeBudget: number
    /** Timestamp (ms) the next fresh admission is allowed — drives the ramp. */
    nextAdmitAt: number
}

const globalForGate = globalThis as unknown as {
    __orchestratorAgentGate?: GateState
}

function createState(): GateState {
    const limits = computeAdaptiveLimits()
    return {
        limits,
        main: new PrioritySemaphore(limits.main),
        total: new PrioritySemaphore(limits.total),
        providers: new Map<string, PrioritySemaphore>(),
        treeSpawns: new Map<string, number>(),
        treeRetainers: new Map<string, number>(),
        treeOwnerReleasePending: new Set<string>(),
        treeBudget: envInt('AGENT_TREE_BUDGET', 12),
        nextAdmitAt: 0,
    }
}

const state: GateState = globalForGate.__orchestratorAgentGate ?? createState()

if (!globalForGate.__orchestratorAgentGate) {
    globalForGate.__orchestratorAgentGate = state
}
// Hot-reload/backward compatibility for a process whose global gate predates
// async tree leases.
state.treeRetainers ??= new Map<string, number>()
state.treeOwnerReleasePending ??= new Set<string>()

function getProviderSemaphore(provider: string): PrioritySemaphore {
    const key = provider.toLowerCase()
    let sem = state.providers.get(key)
    if (!sem) {
        sem = new PrioritySemaphore(providerCap(key))
        state.providers.set(key, sem)
    }
    return sem
}

/** Staggered admission. Spaces fresh agent starts by AGENT_RAMP_MS (default
 *  800ms), widening the gap when the event loop is already lagging, so a burst
 *  of starts doesn't drop the user's SSE. Returns the ms to wait. */
function reserveRampSlot(): number {
    const base = envIntNonNeg('AGENT_RAMP_MS', 800)
    if (base <= 0) return 0
    const lagThreshold = envIntNonNeg('AGENT_RAMP_LAG_MS', 100)
    const maxSpacing = envIntNonNeg('AGENT_RAMP_MAX_MS', 4000)
    let spacing = base
    const lag = loopLagMs()
    if (lag > lagThreshold) {
        spacing = Math.min(maxSpacing, base + Math.round((lag - lagThreshold) * 10))
    }
    const now = Date.now()
    const earliest = Math.max(now, state.nextAdmitAt)
    state.nextAdmitAt = earliest + spacing
    return earliest - now
}

/** A held slot for one agent run. Always `dispose()` it in a finally. */
export interface RunPermit {
    /** Release the total + provider slots while this agent awaits delegated
     *  children, so the children can run. Idempotent. */
    releaseForChildren(): void
    /** Re-acquire the total + provider slots (highest priority) before resuming
     *  the agent's own turn after its children finished. No-op if still held. */
    reacquireForResume(): Promise<void>
    /** Final release of every slot this run holds (total + main + provider). */
    dispose(): void
}

interface AcquireOpts {
    /** True for runs whose parent is synthetic (scheduler/inbox/microscript/
     *  repair) — these consume a `main` slot in addition to a `total` slot. */
    topLevel: boolean
    priority: GatePriority
    /** Backend this run will call (claude/codex/google/browser). Gated by the
     *  per-provider rate-limit cap. Omit for runs with no upstream call. */
    provider?: string
    /** Fired once if this run has to WAIT before it can start (a pool is at
     *  capacity, or the staggered ramp is spacing it out). Lets the UI show a
     *  "queued" indicator until the run is admitted. */
    onQueued?: () => void
}

/** Acquire the slots for one agent run. Resolves once the agent may start.
 *  Acquisition order is fixed (ramp → provider → main → total) so concurrent
 *  acquisitions can never deadlock on lock ordering. */
export async function acquireRun(opts: AcquireOpts): Promise<RunPermit> {
    const prio = PRIORITY[opts.priority]

    const providerSem = opts.provider ? getProviderSemaphore(opts.provider) : null

    // Will this run have to wait? (a pool is saturated, or the ramp is spacing
    // it out). If so, tell the caller so the UI can show a "queued" card.
    const willBlock =
        (providerSem ? providerSem.active >= providerSem.capacity : false) ||
        (opts.topLevel ? state.main.active >= state.main.capacity : false) ||
        state.total.active >= state.total.capacity
    // Stagger fresh starts so a fan-out burst doesn't slam the event loop.
    const rampWait = reserveRampSlot()
    if (opts.onQueued && (willBlock || rampWait > 0)) {
        try {
            opts.onQueued()
        } catch {
            /* never let an observer hook break admission */
        }
    }
    if (rampWait > 0) await new Promise<void>(r => setTimeout(r, rampWait))

    if (providerSem) await providerSem.acquire(prio)
    let holdsProvider = Boolean(providerSem)

    let holdsMain = false
    if (opts.topLevel) {
        await state.main.acquire(prio)
        holdsMain = true
    }

    await state.total.acquire(prio)
    let holdsTotal = true

    let fleetPermit
    try {
        fleetPermit = await acquireFleetRun({
            topLevel: opts.topLevel,
            provider: opts.provider,
            limits: {
                total: state.total.capacity,
                main: state.main.capacity,
                provider: opts.provider ? providerCap(opts.provider) : state.total.capacity,
            },
            onQueued: opts.onQueued,
        })
    } catch (error) {
        state.total.release()
        if (holdsMain) state.main.release()
        if (holdsProvider && providerSem) providerSem.release()
        throw error
    }

    return {
        releaseForChildren() {
            fleetPermit.releaseForChildren()
            if (holdsTotal) {
                holdsTotal = false
                state.total.release()
            }
            if (holdsProvider && providerSem) {
                holdsProvider = false
                providerSem.release()
            }
        },
        async reacquireForResume() {
            // Same order as acquisition: provider before total.
            if (providerSem && !holdsProvider) {
                await providerSem.acquire(PRIORITY.resume)
                holdsProvider = true
            }
            if (!holdsTotal) {
                await state.total.acquire(PRIORITY.resume)
                holdsTotal = true
            }
            await fleetPermit.reacquireForResume()
        },
        dispose() {
            fleetPermit.dispose()
            if (holdsTotal) {
                holdsTotal = false
                state.total.release()
            }
            if (holdsMain) {
                holdsMain = false
                state.main.release()
            }
            if (holdsProvider && providerSem) {
                holdsProvider = false
                providerSem.release()
            }
        },
    }
}

/** Reserve a spawn slot in the given top-level run's tree budget. Returns false
 *  when the tree has already spawned `treeBudget` agents — the caller should
 *  then solve the task directly instead of delegating. */
export function tryReserveTreeSpawn(rootRunId: string | undefined): boolean {
    if (!rootRunId) return true // untracked caller — never block legitimate work
    const spawned = state.treeSpawns.get(rootRunId) ?? 0
    if (spawned >= state.treeBudget) return false
    state.treeSpawns.set(rootRunId, spawned + 1)
    return true
}

/** Drop a finished top-level run's tree-budget counter. Call once when the
 *  top-level run completes (in its finally). */
export function releaseTree(rootRunId: string | undefined): void {
    if (!rootRunId) return
    if ((state.treeRetainers.get(rootRunId) ?? 0) > 0) {
        state.treeOwnerReleasePending.add(rootRunId)
        return
    }
    state.treeSpawns.delete(rootRunId)
    state.treeOwnerReleasePending.delete(rootRunId)
}

/** Keep one root tree's spawn budget alive while detached async descendants
 *  outlive the parent agent that originally owned the tree. */
export function retainTreeForAsync(rootRunId: string | undefined): void {
    if (!rootRunId) return
    state.treeRetainers.set(rootRunId, (state.treeRetainers.get(rootRunId) ?? 0) + 1)
}

/** Return a detached async lease. If the owner already finished, this final
 *  release also drops the tree budget counter. */
export function releaseAsyncTree(rootRunId: string | undefined): void {
    if (!rootRunId) return
    const next = Math.max(0, (state.treeRetainers.get(rootRunId) ?? 0) - 1)
    if (next > 0) {
        state.treeRetainers.set(rootRunId, next)
        return
    }
    state.treeRetainers.delete(rootRunId)
    if (state.treeOwnerReleasePending.delete(rootRunId)) {
        state.treeSpawns.delete(rootRunId)
    }
}

export const agentGateLimits = {
    get main() {
        return state.main.capacity
    },
    get total() {
        return state.total.capacity
    },
    get treeBudget() {
        return state.treeBudget
    },
}

/** Live snapshot for observability (e.g. the /monitor page). */
export function getAgentGateStats() {
    const providers: Record<string, { active: number; queued: number; cap: number }> = {}
    for (const [name, sem] of state.providers) {
        providers[name] = { active: sem.active, queued: sem.queued, cap: sem.capacity }
    }
    return {
        mainActive: state.main.active,
        mainQueued: state.main.queued,
        totalActive: state.total.active,
        totalQueued: state.total.queued,
        liveTrees: state.treeSpawns.size,
        loopLagMs: Math.round(loopLagMs() * 10) / 10,
        providers,
        fleet: getFleetConcurrencyStats(),
        limits: {
            main: state.main.capacity,
            total: state.total.capacity,
            treeBudget: state.treeBudget,
            cores: state.limits.cores,
            totalMB: state.limits.totalMB,
            ramCap: state.limits.ramCap,
            coreCap: state.limits.coreCap,
        },
    }
}

/** Test-only: override capacities so a smoke can exercise small pools without
 *  touching env. Not used by production code. */
export function __setGateCapacitiesForTest(main: number, total: number, treeBudget: number): void {
    state.main.capacity = main
    state.total.capacity = total
    state.treeBudget = treeBudget
    state.treeSpawns.clear()
    state.treeRetainers.clear()
    state.treeOwnerReleasePending.clear()
    state.providers.clear()
    state.nextAdmitAt = 0
}

/** Test-only: set a per-provider cap. */
export function __setProviderCapForTest(provider: string, cap: number): void {
    state.providers.set(provider.toLowerCase(), new PrioritySemaphore(cap))
}
