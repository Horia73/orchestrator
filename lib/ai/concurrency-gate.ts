// Global agent concurrency gate.
//
// Why this exists: on 2026-06-21 the production box (16 GB, 0 swap) OOM-killed
// the Node server because ~30 agents ran at once and the main process heap
// ballooned to 9 GB. There was no global cap. Beyond the crash, simultaneous
// startup bursts can starve the single Node event loop enough that the SSE
// connection drops ("reconnecting"). This gate now has exactly one active-run
// budget:
//
//   • global active pool — 12 concurrent ACTIVE agents overall, regardless of
//     depth, parentage, or provider. Env override: AGENT_TOTAL_CONCURRENCY.
//
// There is deliberately no cumulative per-tree spawn quota. Large trees are
// backpressured by this one active-run semaphore: excess children wait in the
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
// children is idle (its model turn is paused). It RELEASES its global active
// slot for the duration (`releaseForChildren`) and re-acquires it at the highest
// priority before resuming (`reacquireForResume`). The slots are thus
// always available to the agents actually doing work — no hold-and-wait cycle.
// Durable workers use the SQLite fleet pool directly; standalone processes use
// the in-memory pool, so a queued run never pre-holds a second active permit.
//
// All state lives on globalThis so it survives Next.js hot reloads.

import os from 'os'
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks'
import {
    acquireFleetRun,
    getFleetConcurrencyStats,
    isFleetConcurrencyEnabled,
} from '@/lib/ai/fleet-concurrency'

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
// Global limit and host facts.
// ---------------------------------------------------------------------------

interface GateLimits {
    total: number
    cores: number
    totalMB: number
}

function computeGateLimits(): GateLimits {
    const cores = Math.max(1, os.cpus().length)
    const totalMB = Math.max(1024, Math.floor(os.totalmem() / (1024 * 1024)))
    return {
        total: envInt('AGENT_TOTAL_CONCURRENCY', 12),
        cores,
        totalMB,
    }
}

/** CLI providers keep an app-server process alive while a dynamic tool call is
 * awaiting a child. API providers finish their HTTP stream before our local
 * tool loop, so they do not need this second, lifetime-long admission pool. */
function providerResidentDepthCap(provider: string): number | null {
    const key = provider.toLowerCase()
    if (key !== 'codex' && key !== 'claude-code') return null
    // This is a process-memory safety budget, not an active-agent throttle.
    // A synchronous CLI parent keeps its app-server resident while awaiting a
    // child even though it releases its global active slot. Size the per-depth
    // backstop independently from the active pool. Separate depth pools
    // preserve deadlock freedom for nested delegation.
    const totalMB = Math.max(1024, Math.floor(os.totalmem() / (1024 * 1024)))
    const reserveMB = envInt('AGENT_RESIDENT_RESERVE_MB', 2500)
    const perProcessMB = envInt('AGENT_RESIDENT_PROCESS_MB', 350)
    const depthPools = envInt('AGENT_RESIDENT_DEPTH_POOLS', 4)
    const ramBackstop = Math.max(1, Math.floor((totalMB - reserveMB) / perProcessMB / depthPools))
    // Never let process residency become a smaller active-agent partition. All
    // 12 global slots must remain usable by CLI agents at the same depth. The
    // backstop only becomes observable after suspended parents accumulate.
    const fallback = Math.max(envInt('AGENT_TOTAL_CONCURRENCY', 12), ramBackstop)
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
    limits: GateLimits
    total: PrioritySemaphore
    /** Process-resident CLI runs, keyed by provider + delegation depth. */
    residents: Map<string, PrioritySemaphore>
    /** Timestamp (ms) the next fresh admission is allowed — drives the ramp. */
    nextAdmitAt: number
}

const globalForGate = globalThis as unknown as {
    __orchestratorAgentGate?: GateState
}

function createState(): GateState {
    const limits = computeGateLimits()
    return {
        limits,
        total: new PrioritySemaphore(limits.total),
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
    /** Release the global active slot while this agent awaits delegated
     *  children. A process-memory CLI slot stays held. Idempotent. */
    releaseForChildren(): void
    /** Re-acquire the global active slot (highest priority) before resuming the
     *  agent's own turn after its children finished. No-op if still held. */
    reacquireForResume(): Promise<void>
    /** Final release of every slot this run holds, including CLI residency. */
    dispose(): void
}

interface AcquireOpts {
    /** True for runs whose parent is synthetic. Used for queue priority only;
     *  top-level and nested work share the same global active pool. */
    topLevel: boolean
    priority: GatePriority
    /** Backend this run will call. Used only to identify process-resident CLI
     *  runtimes; providers do not have separate active pools. */
    provider?: string
    /** Delegation depth of this run (root conversation is 0, children 1-3). */
    depth?: number
    /** Stop queued admission immediately when the owning tree is cancelled. */
    signal?: AbortSignal
    /** Fired once if this run has to WAIT before it can start (the pool is at
     *  capacity, or the staggered ramp is spacing it out). Lets the UI show a
     *  "queued" indicator until the run is admitted. */
    onQueued?: () => void
}

/** Acquire the one global active slot for an agent run. Durable workers acquire
 *  directly from the cross-process fleet pool; standalone runs acquire from
 *  the in-memory pool. This avoids double-gate hold-and-wait. */
export async function acquireRun(opts: AcquireOpts): Promise<RunPermit> {
    const prio = PRIORITY[opts.priority]
    const fleetEnabled = isFleetConcurrencyEnabled()
    const residentPerDepth = opts.provider
        ? providerResidentDepthCap(opts.provider) ?? undefined
        : undefined
    const residentSem = !fleetEnabled && opts.provider && residentPerDepth
        ? getResidentSemaphore(opts.provider, opts.depth ?? 0)
        : null

    // Will this standalone run have to wait? Fleet waiting is reported by the
    // fleet gate itself. The ramp also counts as queued until admission.
    const willBlock =
        (residentSem ? residentSem.active >= residentSem.capacity : false) ||
        (!fleetEnabled && state.total.active >= state.total.capacity)
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
    let holdsTotal = false

    let fleetPermit
    try {
        if (rampWait > 0) await abortableDelay(rampWait, opts.signal)

        // Standalone CLI runs hold a local resident lease until dispose(),
        // including while a parent awaits children. Fleet workers account for
        // the same residency atomically in acquireFleetRun below.
        if (residentSem) {
            await residentSem.acquire(prio, opts.signal)
            holdsResident = true
        }
        if (!fleetEnabled) {
            await state.total.acquire(prio, opts.signal)
            holdsTotal = true
        }

        fleetPermit = await acquireFleetRun({
            limits: {
                total: state.total.capacity,
                residentPerDepth,
            },
            depth: opts.depth,
            residentProvider: residentPerDepth ? opts.provider : undefined,
            signal: opts.signal,
            onQueued: opts.onQueued,
        })
    } catch (error) {
        if (holdsTotal) state.total.release()
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
        },
        async reacquireForResume() {
            if (opts.signal?.aborted) throw gateAbortError()
            let acquiredTotalNow = false
            try {
                if (!fleetEnabled && !holdsTotal) {
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
                throw error
            }
        },
        dispose() {
            fleetPermit.dispose()
            if (holdsTotal) {
                holdsTotal = false
                state.total.release()
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
    get total() {
        return state.total.capacity
    },
}

/** Live snapshot for observability (e.g. the /monitor page). */
export function getAgentGateStats() {
    const residents: Record<string, { active: number; queued: number; cap: number }> = {}
    for (const [name, sem] of state.residents) {
        residents[name] = { active: sem.active, queued: sem.queued, cap: sem.capacity }
    }
    const fleet = getFleetConcurrencyStats()
    return {
        totalActive: fleet.enabled ? fleet.totalActive : state.total.active,
        totalQueued: fleet.enabled ? 0 : state.total.queued,
        loopLagMs: Math.round(loopLagMs() * 10) / 10,
        residents,
        fleet,
        limits: {
            total: state.total.capacity,
            cores: state.limits.cores,
            totalMB: state.limits.totalMB,
        },
    }
}

/** Test-only: override the global capacity so a smoke can exercise a small pool without
 *  touching env. Not used by production code. */
export function __setGlobalAgentCapForTest(total: number): void {
    state.total.capacity = total
    state.residents.clear()
    state.nextAdmitAt = 0
}

/** Test-only: set the resident cap for one provider/depth pool. */
export function __setProviderResidentDepthCapForTest(provider: string, depth: number, cap: number): void {
    state.residents.set(residentKey(provider, depth), new PrioritySemaphore(cap))
}
