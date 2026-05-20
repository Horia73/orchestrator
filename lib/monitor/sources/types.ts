import type { MonitorAction, MonitorRule, MonitorWatch, WatchState, WatchSource } from '../schema'
import type { EvalCandidate } from '../rules'

// ---------------------------------------------------------------------------
// SourceAdapter contract.
//
// One adapter per `WatchSource`. The engine knows nothing source-specific —
// it just calls cheapCheck() and is handed back a list of MatchedCandidates
// (already-passed-the-rule), a state delta to persist, and any errors.
// Adapters are stateless: per-watch memory lives in WatchState (persisted by
// the store) and is read out of `watch.state` on entry, with deltas returned
// on exit.
// ---------------------------------------------------------------------------

/** One rule match produced by an adapter's cheap-check. The `candidate` is
 *  the source-specific raw shape used by the rule evaluator (and later by the
 *  suppress-pattern evaluator). `summary` is a short human-readable
 *  description for the Inbox/wake prompt. `externalId` is an optional
 *  stable id used by the engine for dedup (e.g., a Gmail msg id so the same
 *  message is never surfaced twice across ticks). */
export interface MatchedCandidate {
    candidate: EvalCandidate
    summary: string
    externalId?: string
    /** Free-form structured details for the model wake prompt + audit log. */
    details?: Record<string, unknown>
}

/** Outcome of one cheap-check run. The engine merges `stateUpdate` into
 *  the watch's state and applies `checkpoint` to the bookkeeping columns. */
export interface CheapCheckResult {
    /** Whether the fetch itself succeeded. Rule misses are still ok=true. */
    ok: boolean
    /** Error message if !ok (network, integration disconnected, parse, …). */
    error?: string
    /** Matched candidates AFTER rule eval, BEFORE suppress patterns. The
     *  engine runs suppress patterns over this list. */
    matches: MatchedCandidate[]
    /** Total candidates the adapter considered (matched or not) — for stats. */
    candidatesSeen: number
    /** Partial state delta the engine should merge into watch.state. */
    stateUpdate: Partial<WatchState>
    /** Epoch ms — when the fetch completed. */
    fetchedAt: number
}

/** Result of asking whether the integration backing this source is reachable
 *  right now. The engine consults this each tick before calling cheapCheck;
 *  if not available, it records a `check` audit event with a reason and skips
 *  the watch (without bumping consecutiveErrors as an integration outage is
 *  not a fault of the watch). */
export interface AvailabilityResult {
    available: boolean
    /** Short reason when unavailable — surfaced in the watch's lastError so
     *  the UI can show "Gmail disconnected — reconnect to resume". */
    reason?: string
}

export interface CheapCheckInput {
    watch: MonitorWatch
    now: number
    /** Hard upper bound (ms) on the cheap-check duration. Adapters MUST respect
     *  it via AbortController / Promise.race — a slow integration must not
     *  block the master tick or starve other watches. */
    timeoutMs: number
}

export interface SourceAdapter {
    readonly source: WatchSource
    /** Predicate kinds this adapter understands. Composition (any_of/all_of)
     *  is implicitly allowed for every adapter. */
    readonly supportedRuleKinds: ReadonlyArray<MonitorRule['kind']>
    /** Permission kinds the user may grant the model for a watch on this
     *  source. `notify_inbox` is implicit for every source and need not be
     *  listed; everything else is opt-in. */
    readonly supportedActionKinds: ReadonlyArray<MonitorAction['kind']>
    /** Is the backing integration configured AND connected right now? */
    isAvailable(): Promise<AvailabilityResult>
    /** Run the cheap fetch + rule eval for one watch. Never throws — failures
     *  come back as `{ ok: false, error }`. */
    cheapCheck(input: CheapCheckInput): Promise<CheapCheckResult>
}

// --- small helpers shared by adapters -------------------------------------

/** Wrap a promise with a hard timeout. If `ms` elapses first, the result
 *  rejects with `Timed out after Nms` — adapters convert this into a
 *  CheapCheckResult with `ok: false, error: ...`. Abort semantics are passed
 *  to the optional `onAbort` callback so callers can cancel work in flight. */
export async function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
    onAbort?: () => void,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => {
                    onAbort?.()
                    reject(new Error(`${label}: timed out after ${ms}ms`))
                }, ms)
            }),
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

/** Wrap an adapter call so any unexpected throw is converted to an ok=false
 *  CheapCheckResult — the engine relies on cheapCheck() never throwing. */
export async function safeAdapterCall(
    label: string,
    fn: () => Promise<CheapCheckResult>,
): Promise<CheapCheckResult> {
    try {
        return await fn()
    } catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? `${label}: ${err.message}` : `${label}: ${String(err)}`,
            matches: [],
            candidatesSeen: 0,
            stateUpdate: {},
            fetchedAt: Date.now(),
        }
    }
}
