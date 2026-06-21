// Global agent concurrency gate.
//
// Why this exists: on 2026-06-21 the production box (16 GB, 0 swap) OOM-killed
// the Node server because ~30 agents ran at once and the main process heap
// ballooned to 9 GB. There was no global cap — only a per-`delegate_to`-call
// limit. A fan-out burst (orchestrator → N sub-agents → M each) had nothing
// stopping it. This gate bounds how many agents *actively* run at once so the
// peak can never exhaust RAM, no matter what shape the call tree takes.
//
// The model is REACTIVE — it never predicts the tree. Three knobs:
//   • main pool  — concurrent TOP-LEVEL runs (a run whose parent is synthetic:
//     a scheduled task, an inbox reply, a microscript wake, an artifact repair).
//     Default 10.
//   • total pool — concurrent ACTIVE agents at ANY depth (top-level + every
//     sub-agent spawned via delegate_to). Default 15.
//   • tree budget — max agents a single top-level run may spawn across its whole
//     sub-tree. Default 100. Backstop against runaway recursion: when hit,
//     delegate_to degrades gracefully ("solve it directly") instead of queueing
//     forever.
//
// Deadlock freedom: a parent that called delegate_to and is AWAITING its
// children is idle (its CLI/model turn is paused). It therefore RELEASES its
// total slot for the duration (`releaseForChildren`) and re-acquires it with
// the highest priority before resuming (`reacquireForResume`). The N total
// slots are thus always available to the agents actually doing work, so there
// is no hold-and-wait cycle — the deepest active agents always make progress.
//
// All state lives on globalThis so it survives Next.js hot reloads (same trick
// as lib/agent-runs.ts, lib/chat-streams.ts).

function envInt(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
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

interface GateState {
    main: PrioritySemaphore
    total: PrioritySemaphore
    /** rootRunId -> agents spawned across this top-level run's whole sub-tree. */
    treeSpawns: Map<string, number>
    treeBudget: number
}

const globalForGate = globalThis as unknown as {
    __orchestratorAgentGate?: GateState
}

const state: GateState =
    globalForGate.__orchestratorAgentGate ??
    {
        main: new PrioritySemaphore(envInt('AGENT_MAIN_CONCURRENCY', 10)),
        total: new PrioritySemaphore(envInt('AGENT_TOTAL_CONCURRENCY', 15)),
        treeSpawns: new Map<string, number>(),
        treeBudget: envInt('AGENT_TREE_BUDGET', 100),
    }

if (!globalForGate.__orchestratorAgentGate) {
    globalForGate.__orchestratorAgentGate = state
}

/** A held slot for one agent run. Always `dispose()` it in a finally. */
export interface RunPermit {
    /** Release the total slot while this agent awaits delegated children, so the
     *  children can run. Safe to call repeatedly; only the first has effect. */
    releaseForChildren(): void
    /** Re-acquire the total slot (highest priority) before resuming the agent's
     *  own turn after its children finished. No-op if the slot is still held. */
    reacquireForResume(): Promise<void>
    /** Final release of every slot this run holds (total + main). */
    dispose(): void
}

interface AcquireOpts {
    /** True for runs whose parent is synthetic (scheduler/inbox/microscript/
     *  repair) — these consume a `main` slot in addition to a `total` slot. */
    topLevel: boolean
    priority: GatePriority
}

/** Acquire the slots for one agent run. Resolves once the agent may start. */
export async function acquireRun(opts: AcquireOpts): Promise<RunPermit> {
    const prio = PRIORITY[opts.priority]
    let holdsMain = false
    if (opts.topLevel) {
        await state.main.acquire(prio)
        holdsMain = true
    }
    await state.total.acquire(prio)
    let holdsTotal = true

    return {
        releaseForChildren() {
            if (holdsTotal) {
                holdsTotal = false
                state.total.release()
            }
        },
        async reacquireForResume() {
            if (!holdsTotal) {
                await state.total.acquire(PRIORITY.resume)
                holdsTotal = true
            }
        },
        dispose() {
            if (holdsTotal) {
                holdsTotal = false
                state.total.release()
            }
            if (holdsMain) {
                holdsMain = false
                state.main.release()
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
    if (rootRunId) state.treeSpawns.delete(rootRunId)
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
    return {
        mainActive: state.main.active,
        mainQueued: state.main.queued,
        totalActive: state.total.active,
        totalQueued: state.total.queued,
        liveTrees: state.treeSpawns.size,
        limits: { main: state.main.capacity, total: state.total.capacity, treeBudget: state.treeBudget },
    }
}

/** Test-only: override capacities so a smoke can exercise small pools without
 *  touching env. Not used by production code. */
export function __setGateCapacitiesForTest(main: number, total: number, treeBudget: number): void {
    state.main.capacity = main
    state.total.capacity = total
    state.treeBudget = treeBudget
    state.treeSpawns.clear()
}
