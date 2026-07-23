// Global agent concurrency gate.
//
// Why this exists: on 2026-06-21 the production box (16 GB, 0 swap) OOM-killed
// the Node server because ~30 agents ran at once and the main process heap
// ballooned to 9 GB. There was no global cap. Beyond the crash, even 3-4 agents
// streaming at once starve the single Node event loop enough that the SSE
// connection drops ("reconnecting"). This gate bounds concurrency on three
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
//
// There is deliberately no cumulative per-tree spawn quota. Large trees are
// backpressured by these active-run semaphores: excess children wait in the
// queue and start as capacity returns. Delegation depth and per-call shape stay
// bounded separately, but completed work never consumes a lifetime allowance.
// CLI app-server providers also have a small resident-process pool PER DEPTH.
// Their parent process stays in RAM while a synchronous tool call awaits a
// child; separate depth pools bound that memory without a hold-and-wait
// deadlock (depth N parents never consume depth N+1 child capacity).
//
// Staggered admission ("pe rand"): fresh agent starts are spaced by ~800ms (and
// further when the event loop is already lagging) so a fan-out burst doesn't
// slam the loop and drop the user's SSE. Resume re-acquisitions skip the ramp.
//
// Deadlock freedom: a parent that called delegate_to and is AWAITING its
// children is idle (its model turn is paused). It RELEASES its active total +
// provider + main slots for the duration (`releaseForChildren`) and re-acquires
// them at the highest priority before resuming (`reacquireForResume`). The slots are thus
// always available to the agents actually doing work — no hold-and-wait cycle.
// All acquisitions use the same order (resident-depth → provider → main →
// total), so there is no lock-ordering deadlock either.
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
    signal?: AbortSignal
    onAbort?: () => void
}

function gateAbortError(): Error {
    const error = new Error('Agent run cancelled while waiting for capacity.')
    error.name = 'AbortError'
    return error
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

    acquire(priority: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) return Promise.reject(gateAbortError())
        if (this.inUse < this.capacity) {
            this.inUse++
            return Promise.resolve()
        }
        return new Promise<void>((resolve, reject) => {
            const waiter: Waiter = {
                priority,
                seq: this.seqCounter++,
                resolve,
                signal,
            }
            if (signal) {
                waiter.onAbort = () => {
                    const index = this.waiters.indexOf(waiter)
                    if (index >= 0) this.waiters.splice(index, 1)
                    reject(gateAbortError())
                }
                signal.addEventListener('abort', waiter.onAbort, { once: true })
            }
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
            if (next.signal && next.onAbort) {
                next.signal.removeEventListener('abort', next.onAbort)
            }
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
        // Keep simultaneous streaming/model work conservative; the separate
        // resident-per-depth pool below bounds waiting app-server processes.
        codex: 3,
        openai: 6,
        google: 8,
        gemini: 8,
        browser: 2,
    }
    const envName = `AGENT_MAX_PROVIDER_${key.replace(/[^a-z0-9]+/g, '_').toUpperCase()}`
    const fallback = defaults[key] ?? envInt('AGENT_MAX_PROVIDER_DEFAULT', 4)
    return envInt(envName, fallback)
}

/** CLI providers keep an app-server process alive while a dynamic tool call is
 * awaiting a child. API providers finish their HTTP stream before our local
 * tool loop, so they do not need this second, lifetime-long admission pool. */
function providerResidentDepthCap(provider: string): number | null {
    const key = provider.toLowerCase()
    if (key !== 'codex' && key !== 'claude-code') return null
    // This is a process-memory safety budget, not an active-agent throttle.
    // A synchronous CLI parent keeps its app-server resident while awaiting a
    // child even though it releases every active slot. Size the per-depth
    // backstop from RAM and keep it above the provider's active cap, so normal
    // model work is governed only by active concurrency (on the 16 GB
    // production host this is 9, versus Codex's active cap of 3). Separate
    // depth pools preserve deadlock freedom for nested delegation.
    const totalMB = Math.max(1024, Math.floor(os.totalmem() / (1024 * 1024)))
    const reserveMB = envInt('AGENT_RESIDENT_RESERVE_MB', 2500)
    const perProcessMB = envInt('AGENT_RESIDENT_PROCESS_MB', 350)
    const depthPools = envInt('AGENT_RESIDENT_DEPTH_POOLS', 4)
    const ramBackstop = Math.max(1, Math.floor((totalMB - reserveMB) / perProcessMB / depthPools))
    const fallback = Math.max(providerCap(key), ramBackstop)
    const envName = `AGENT_MAX_RESIDENT_${key.replace(/[^a-z0-9]+/g, '_').toUpperCase()}_PER_DEPTH`
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
    /** Process-resident CLI runs, keyed by provider + delegation depth. */
    residents: Map<string, PrioritySemaphore>
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
        residents: new Map<string, PrioritySemaphore>(),
        nextAdmitAt: 0,
    }
}

const state: GateState = globalForGate.__orchestratorAgentGate ?? createState()

if (!globalForGate.__orchestratorAgentGate) {
    globalForGate.__orchestratorAgentGate = state
}
// Development hot reload can preserve a gate created by the previous module
// shape. Production workers restart, but keeping HMR compatible prevents a
// confusing local-only crash after this field was introduced.
state.residents ??= new Map<string, PrioritySemaphore>()

function getProviderSemaphore(provider: string): PrioritySemaphore {
    const key = provider.toLowerCase()
    let sem = state.providers.get(key)
    if (!sem) {
        sem = new PrioritySemaphore(providerCap(key))
        state.providers.set(key, sem)
    }
    return sem
}

function residentKey(provider: string, depth: number): string {
    return `${provider.toLowerCase()}:${Math.max(0, Math.floor(depth))}`
}

function getResidentSemaphore(provider: string, depth: number): PrioritySemaphore | null {
    const cap = providerResidentDepthCap(provider)
    if (cap === null) return null
    const key = residentKey(provider, depth)
    let sem = state.residents.get(key)
    if (!sem) {
        sem = new PrioritySemaphore(cap)
        state.residents.set(key, sem)
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
    /** Release active total + provider + main slots while this agent awaits
     *  delegated children. A process-memory CLI slot stays held. Idempotent. */
    releaseForChildren(): void
    /** Re-acquire the total + provider slots (highest priority) before resuming
     *  the agent's own turn after its children finished. No-op if still held. */
    reacquireForResume(): Promise<void>
    /** Final release of every slot this run holds, including CLI residency. */
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
    /** Delegation depth of this run (root conversation is 0, children 1-3). */
    depth?: number
    /** Stop queued admission immediately when the owning tree is cancelled. */
    signal?: AbortSignal
    /** Fired once if this run has to WAIT before it can start (a pool is at
     *  capacity, or the staggered ramp is spacing it out). Lets the UI show a
     *  "queued" indicator until the run is admitted. */
    onQueued?: () => void
}

/** Acquire the slots for one agent run. Resolves once the agent may start.
 *  Acquisition order is fixed (ramp → resident-depth → provider → main →
 *  total) so concurrent acquisitions cannot deadlock on lock ordering. */
export async function acquireRun(opts: AcquireOpts): Promise<RunPermit> {
    const prio = PRIORITY[opts.priority]

    const providerSem = opts.provider ? getProviderSemaphore(opts.provider) : null
    const residentSem = opts.provider
        ? getResidentSemaphore(opts.provider, opts.depth ?? 0)
        : null

    // Will this run have to wait? (a pool is saturated, or the ramp is spacing
    // it out). If so, tell the caller so the UI can show a "queued" card.
    const willBlock =
        (providerSem ? providerSem.active >= providerSem.capacity : false) ||
        (residentSem ? residentSem.active >= residentSem.capacity : false) ||
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
    let holdsResident = false
    let holdsProvider = false
    let holdsMain = false
    let holdsTotal = false

    let fleetPermit
    try {
        if (rampWait > 0) await abortableDelay(rampWait, opts.signal)

        // A resident lease is held until dispose(), including while the parent
        // awaits children. Acquire it before the active provider lease.
        if (residentSem) {
            await residentSem.acquire(prio, opts.signal)
            holdsResident = true
        }
        if (providerSem) {
            await providerSem.acquire(prio, opts.signal)
            holdsProvider = true
        }
        if (opts.topLevel) {
            await state.main.acquire(prio, opts.signal)
            holdsMain = true
        }
        await state.total.acquire(prio, opts.signal)
        holdsTotal = true

        fleetPermit = await acquireFleetRun({
            topLevel: opts.topLevel,
            provider: opts.provider,
            limits: {
                total: state.total.capacity,
                main: state.main.capacity,
                provider: opts.provider ? providerCap(opts.provider) : state.total.capacity,
                residentPerDepth: opts.provider
                    ? providerResidentDepthCap(opts.provider) ?? undefined
                    : undefined,
            },
            depth: opts.depth,
            residentProvider: residentSem ? opts.provider : undefined,
            signal: opts.signal,
            onQueued: opts.onQueued,
        })
    } catch (error) {
        if (holdsTotal) state.total.release()
        if (holdsMain) state.main.release()
        if (holdsProvider && providerSem) providerSem.release()
        if (holdsResident && residentSem) residentSem.release()
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
            if (holdsMain) {
                holdsMain = false
                state.main.release()
            }
        },
        async reacquireForResume() {
            if (opts.signal?.aborted) throw gateAbortError()
            // Same order as acquisition: provider before total.
            let acquiredProviderNow = false
            let acquiredMainNow = false
            let acquiredTotalNow = false
            try {
                if (providerSem && !holdsProvider) {
                    await providerSem.acquire(PRIORITY.resume, opts.signal)
                    holdsProvider = true
                    acquiredProviderNow = true
                }
                if (opts.topLevel && !holdsMain) {
                    await state.main.acquire(PRIORITY.resume, opts.signal)
                    holdsMain = true
                    acquiredMainNow = true
                }
                if (!holdsTotal) {
                    await state.total.acquire(PRIORITY.resume, opts.signal)
                    holdsTotal = true
                    acquiredTotalNow = true
                }
                await fleetPermit.reacquireForResume()
            } catch (error) {
                if (acquiredTotalNow && holdsTotal) {
                    holdsTotal = false
                    state.total.release()
                }
                if (acquiredProviderNow && holdsProvider && providerSem) {
                    holdsProvider = false
                    providerSem.release()
                }
                if (acquiredMainNow && holdsMain) {
                    holdsMain = false
                    state.main.release()
                }
                throw error
            }
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
            if (holdsResident && residentSem) {
                holdsResident = false
                residentSem.release()
            }
        },
    }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise(resolve => setTimeout(resolve, ms))
    if (signal.aborted) return Promise.reject(gateAbortError())
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            reject(gateAbortError())
        }
        signal.addEventListener('abort', onAbort, { once: true })
    })
}

export const agentGateLimits = {
    get main() {
        return state.main.capacity
    },
    get total() {
        return state.total.capacity
    },
}

/** Live snapshot for observability (e.g. the /monitor page). */
export function getAgentGateStats() {
    const providers: Record<string, { active: number; queued: number; cap: number }> = {}
    for (const [name, sem] of state.providers) {
        providers[name] = { active: sem.active, queued: sem.queued, cap: sem.capacity }
    }
    const residents: Record<string, { active: number; queued: number; cap: number }> = {}
    for (const [name, sem] of state.residents) {
        residents[name] = { active: sem.active, queued: sem.queued, cap: sem.capacity }
    }
    return {
        mainActive: state.main.active,
        mainQueued: state.main.queued,
        totalActive: state.total.active,
        totalQueued: state.total.queued,
        loopLagMs: Math.round(loopLagMs() * 10) / 10,
        providers,
        residents,
        fleet: getFleetConcurrencyStats(),
        limits: {
            main: state.main.capacity,
            total: state.total.capacity,
            cores: state.limits.cores,
            totalMB: state.limits.totalMB,
            ramCap: state.limits.ramCap,
            coreCap: state.limits.coreCap,
        },
    }
}

/** Test-only: override capacities so a smoke can exercise small pools without
 *  touching env. Not used by production code. */
export function __setGateCapacitiesForTest(main: number, total: number): void {
    state.main.capacity = main
    state.total.capacity = total
    state.providers.clear()
    state.residents.clear()
    state.nextAdmitAt = 0
}

/** Test-only: set a per-provider cap. */
export function __setProviderCapForTest(provider: string, cap: number): void {
    state.providers.set(provider.toLowerCase(), new PrioritySemaphore(cap))
}

/** Test-only: set the resident cap for one provider/depth pool. */
export function __setProviderResidentDepthCapForTest(provider: string, depth: number, cap: number): void {
    state.residents.set(residentKey(provider, depth), new PrioritySemaphore(cap))
}
