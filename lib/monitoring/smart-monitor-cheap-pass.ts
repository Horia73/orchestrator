// Smart Monitor — the cheap, no-model gate in front of the AI wake.
//
// Mirrors lib/monitoring/markets-heartbeat.ts: this is the CHEAP CODE LOOP for
// the consolidated Smart Monitor heartbeat. The single "Smart monitor" system
// task fires on a FIXED, frequent cadence (SMART_MONITOR_POLL_INTERVAL_MS), and
// every tick runs THIS pass — pure I/O + rule evaluation, ZERO LLM cost:
//
//   1. For each enabled connector watch, ask its source adapter
//      (lib/monitor/sources/*) whether the integration is reachable, then run
//      its cheapCheck() — a watermarked, deduped fetch that returns only
//      candidates that arrived since the last tick AND passed the watch rule.
//   2. Drop candidates matched by a learned suppress pattern.
//   3. Buffer the survivors in the gate's `pending` queue (in task_state).
//   4. Custom (model-owned) watches have no code predicate, so they become
//      "due" purely by their per-watch cadence and join the pending queue then.
//
// The AI agent is woken ONLY when the gate opens:
//   - `pending` is non-empty AND the user/agent-chosen minimum sleep
//     (minWakeGapMs) has elapsed since the last wake — i.e. a real change
//     appeared and we are past the debounce floor; OR
//   - the safety ceiling (maxWakeGapMs) elapsed since the last wake, so the
//     agent re-derives intent / digests / housekeeps even in total quiet.
//
// When the gate stays shut, the tick is silent: no LLM, the pass just advances
// watermarks and keeps the buffer. This is the "keep it asleep while everything
// is OK, wake it on the next change" behaviour.
//
// task_state ownership split (the agent also writes task_state on a wake):
//   - TOP LEVEL knobs the AGENT owns and may tune: `minWakeGapMs`,
//     `maxWakeGapMs`, plus its own digestQueue/watermarks/etc.
//   - `_smartGate` reserved key the CODE owns: `lastWakeAt`, `pending`,
//     `lastCheapRunAt`. The agent is told not to touch it; finalizeSmartMonitorWake
//     re-attaches it after the wake so the agent's set_task_state cannot clobber
//     the gate bookkeeping.

import { evaluateRule } from '../monitor/rules'
import { getSourceAdapter } from '../monitor/sources'
import {
    incrementSuppressPatternMatch,
    listMonitorWatches,
    recordWatchEvent,
    setWatchCheckpoint,
    setWatchState,
} from '../monitor/store'
import type { MonitorWatch } from '../monitor/schema'
import {
    buildSmartMonitorAgentPrompt,
    type DetectedChange,
} from './smart-monitor'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Fixed cheap-poll cadence for the Smart Monitor system task. The pass is pure
 *  code, so it can run often and cheaply; responsiveness comes from here, not
 *  from waking the model. The smart-monitor-adapter pins the system task to this. */
export const SMART_MONITOR_POLL_INTERVAL_MS = 5 * 60_000

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Default minimum sleep between AI wakes (the debounce floor the agent owns). */
const DEFAULT_MIN_WAKE_GAP_MS = 15 * MINUTE
/** Default safety ceiling: wake at least this often even with no change. */
const DEFAULT_MAX_WAKE_GAP_MS = 6 * HOUR
/** Hard upper bound for either knob, so a bad agent value can't park forever. */
const MAX_WAKE_GAP_CEIL_MS = DAY

/** Per-watch cheap-check budget. Adapters honour this via AbortController/race;
 *  a slow integration can't stall the whole pass or the scheduler. */
const CHEAP_CHECK_TIMEOUT_MS = 20_000

/** Buffer cap. A noisy quiet-period can't grow task_state without bound; we keep
 *  the most-recent items and note the truncation in the wake prompt. */
const PENDING_CAP = 50

const GATE_KEY = '_smartGate'

// ---------------------------------------------------------------------------
// Gate state
// ---------------------------------------------------------------------------

export interface SmartPendingMatch {
    watchId: string
    watchTitle: string
    source: string
    summary: string
    externalId?: string
    ts: number
    details?: Record<string, unknown>
}

export interface SmartGateState {
    /** Agent-owned minimum sleep between wakes (debounce floor). */
    minWakeGapMs: number
    /** Agent-owned safety ceiling: force a wake at least this often. */
    maxWakeGapMs: number
    /** Code-owned: epoch ms of the last actual model wake (null before first). */
    lastWakeAt: number | null
    /** Code-owned: buffered survivors awaiting the next wake. */
    pending: SmartPendingMatch[]
    /** Code-owned: epoch ms of the last cheap pass (telemetry/UI). */
    lastCheapRunAt: number | null
}

export type WakeReason = 'matches' | 'ceiling'

export interface SmartCheapPassResult {
    /** True when the model should be woken this tick. */
    noteworthy: boolean
    /** One-line summary recorded in Past runs even when silent. */
    summary: string
    /** Self-contained wake prompt — present only when noteworthy. */
    briefPrompt?: string
    /** task_state to persist BEFORE the wake. Carries the full pending buffer and
     *  the prior lastWakeAt so a crashed wake never loses buffered items. */
    nextState: Record<string, unknown>
    /** The gate snapshot embedded in nextState — used by finalizeSmartMonitorWake. */
    gate: SmartGateState
}

function isFiniteNumber(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v)
}

function clampMs(value: unknown, lo: number, hi: number, fallback: number): number {
    const n = isFiniteNumber(value) ? value : fallback
    return Math.min(hi, Math.max(lo, Math.round(n)))
}

function sanitizePending(value: unknown): SmartPendingMatch[] {
    if (!Array.isArray(value)) return []
    const out: SmartPendingMatch[] = []
    for (const raw of value) {
        if (!raw || typeof raw !== 'object') continue
        const m = raw as Record<string, unknown>
        if (typeof m.watchId !== 'string' || typeof m.summary !== 'string') continue
        out.push({
            watchId: m.watchId,
            watchTitle: typeof m.watchTitle === 'string' ? m.watchTitle : m.watchId,
            source: typeof m.source === 'string' ? m.source : 'unknown',
            summary: m.summary,
            externalId: typeof m.externalId === 'string' ? m.externalId : undefined,
            ts: isFiniteNumber(m.ts) ? m.ts : 0,
            details:
                m.details && typeof m.details === 'object' && !Array.isArray(m.details)
                    ? (m.details as Record<string, unknown>)
                    : undefined,
        })
    }
    return out.slice(-PENDING_CAP)
}

/** Read the gate out of a task_state document, applying defaults + clamps. The
 *  agent-owned knobs live at the top level; the code-owned bookkeeping lives
 *  under GATE_KEY. */
export function readGate(state: Record<string, unknown> | null | undefined): SmartGateState {
    const s = (state ?? {}) as Record<string, unknown>
    const bk = (s[GATE_KEY] && typeof s[GATE_KEY] === 'object' && !Array.isArray(s[GATE_KEY])
        ? (s[GATE_KEY] as Record<string, unknown>)
        : {}) as Record<string, unknown>

    const minWakeGapMs = clampMs(s.minWakeGapMs, SMART_MONITOR_POLL_INTERVAL_MS, DAY, DEFAULT_MIN_WAKE_GAP_MS)
    const maxWakeGapMs = clampMs(
        s.maxWakeGapMs,
        minWakeGapMs,
        MAX_WAKE_GAP_CEIL_MS,
        Math.max(minWakeGapMs, DEFAULT_MAX_WAKE_GAP_MS),
    )

    return {
        minWakeGapMs,
        maxWakeGapMs,
        lastWakeAt: isFiniteNumber(bk.lastWakeAt) ? bk.lastWakeAt : null,
        pending: sanitizePending(bk.pending),
        lastCheapRunAt: isFiniteNumber(bk.lastCheapRunAt) ? bk.lastCheapRunAt : null,
    }
}

/** Merge `gate` back into a base task_state document: agent knobs at top level,
 *  bookkeeping under GATE_KEY. Preserves every other field on `base`. */
function composeState(
    base: Record<string, unknown> | null | undefined,
    gate: SmartGateState,
): Record<string, unknown> {
    return {
        ...(base ?? {}),
        minWakeGapMs: gate.minWakeGapMs,
        maxWakeGapMs: gate.maxWakeGapMs,
        [GATE_KEY]: {
            lastWakeAt: gate.lastWakeAt,
            pending: gate.pending,
            lastCheapRunAt: gate.lastCheapRunAt,
        },
    }
}

function pendingKey(m: SmartPendingMatch): string {
    return m.externalId ? `${m.watchId}:${m.externalId}` : `${m.watchId}:${m.source}`
}

/** Union existing + fresh, dedup by key (first occurrence wins so the debounce
 *  window is measured from first arrival), keep the newest PENDING_CAP. */
function mergePending(
    existing: SmartPendingMatch[],
    fresh: SmartPendingMatch[],
): SmartPendingMatch[] {
    const map = new Map<string, SmartPendingMatch>()
    for (const m of existing) map.set(pendingKey(m), m)
    for (const m of fresh) {
        const k = pendingKey(m)
        if (!map.has(k)) map.set(k, m)
    }
    const all = [...map.values()].sort((a, b) => a.ts - b.ts)
    return all.length > PENDING_CAP ? all.slice(all.length - PENDING_CAP) : all
}

function safeEvaluate(rule: Parameters<typeof evaluateRule>[0], candidate: Parameters<typeof evaluateRule>[1]): boolean {
    try {
        return evaluateRule(rule, candidate)
    } catch {
        return false
    }
}

/** A custom (model-owned) watch is "due" when its per-watch cadence has elapsed
 *  since it last fired. These have no connector predicate, so cadence is the
 *  only gate available for them. */
function customWatchDue(watch: MonitorWatch, now: number): boolean {
    if (watch.lastFiredAt == null) return true
    return now - watch.lastFiredAt >= watch.cadence.current * 1000
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export async function runSmartMonitorCheapPass(args: {
    priorState: Record<string, unknown> | null
    now: number
    taskId: string
}): Promise<SmartCheapPassResult> {
    const { now, taskId } = args
    const prior = args.priorState ?? {}
    const gate = readGate(prior)
    // First run ever: anchor the ceiling timer to "now" so we don't fire an
    // immediate safety wake the moment the task is created.
    if (gate.lastWakeAt == null) gate.lastWakeAt = now

    let watches: MonitorWatch[]
    try {
        watches = listMonitorWatches({ enabled: true })
    } catch (err) {
        gate.lastCheapRunAt = now
        return {
            noteworthy: false,
            summary: `Smart monitor cheap pass: failed to read watches — ${err instanceof Error ? err.message : 'unknown error'}.`,
            nextState: composeState(prior, gate),
            gate,
        }
    }

    if (watches.length === 0) {
        gate.pending = []
        gate.lastCheapRunAt = now
        return {
            noteworthy: false,
            summary: 'Smart monitor cheap pass: no enabled watches.',
            nextState: composeState(prior, gate),
            gate,
        }
    }

    const fresh: SmartPendingMatch[] = []
    let checkedCount = 0
    let unavailableCount = 0
    let errorCount = 0
    let suppressedCount = 0

    for (const watch of watches) {
        try {
            // --- custom (model-owned) watches: cadence-gated, no connector ---
            if (watch.source === 'custom') {
                if (customWatchDue(watch, now)) {
                    fresh.push({
                        watchId: watch.id,
                        watchTitle: watch.title,
                        source: 'custom',
                        summary: `Model-owned check due: ${watch.title}`,
                        ts: now,
                        details: { target: watch.target },
                    })
                }
                continue
            }

            // --- connector watches: availability + cheapCheck ---
            const adapter = getSourceAdapter(watch.source)
            let available = false
            let reason: string | undefined
            try {
                const a = await adapter.isAvailable()
                available = a.available
                reason = a.reason
            } catch (err) {
                available = false
                reason = err instanceof Error ? err.message : 'availability check failed'
            }
            if (!available) {
                unavailableCount++
                recordWatchEvent(watch.id, 'check', { available: false, reason: reason ?? 'unavailable' }, now)
                // Integration outage is not the watch's fault — surface a reason
                // but do not bump consecutiveErrors.
                setWatchCheckpoint(watch.id, { lastCheckedAt: now, lastError: reason ?? 'integration unavailable' })
                continue
            }

            const result = await adapter.cheapCheck({ watch, now, timeoutMs: CHEAP_CHECK_TIMEOUT_MS })
            checkedCount++

            // Persist the watermark/state delta regardless of outcome.
            try {
                setWatchState(watch.id, { ...watch.state, ...result.stateUpdate })
            } catch {
                /* state delta best-effort; a parse failure must not abort the pass */
            }

            if (!result.ok) {
                errorCount++
                recordWatchEvent(watch.id, 'error', { message: result.error ?? 'cheap-check failed' }, result.fetchedAt)
                setWatchCheckpoint(watch.id, {
                    lastCheckedAt: result.fetchedAt,
                    consecutiveErrors: watch.consecutiveErrors + 1,
                    lastError: result.error ?? 'cheap-check failed',
                })
                continue
            }

            setWatchCheckpoint(watch.id, {
                lastCheckedAt: result.fetchedAt,
                consecutiveErrors: 0,
                lastError: null,
            })

            // Apply learned suppress patterns over the matches.
            const activePatterns = watch.suppressPatterns.filter(
                (p) => p.expiresAt === null || p.expiresAt > now,
            )
            let watchMatches = 0
            for (const m of result.matches) {
                const suppressedBy = activePatterns.find((p) => safeEvaluate(p.rule, m.candidate))
                if (suppressedBy) {
                    suppressedCount++
                    incrementSuppressPatternMatch(watch.id, suppressedBy.id)
                    recordWatchEvent(watch.id, 'suppress', {
                        patternReason: suppressedBy.reason,
                        summary: m.summary,
                    }, now)
                    continue
                }
                watchMatches++
                recordWatchEvent(watch.id, 'match', { summary: m.summary }, now)
                fresh.push({
                    watchId: watch.id,
                    watchTitle: watch.title,
                    source: watch.source,
                    summary: m.summary,
                    externalId: m.externalId,
                    ts: now,
                    details: m.details,
                })
            }
            if (watchMatches === 0) {
                recordWatchEvent(watch.id, 'check', {
                    matches: 0,
                    candidatesSeen: result.candidatesSeen,
                }, result.fetchedAt)
            }
        } catch (err) {
            // One bad watch must never abort the consolidated pass.
            errorCount++
            try {
                recordWatchEvent(watch.id, 'error', {
                    message: err instanceof Error ? err.message : 'watch pass failed',
                }, now)
            } catch {
                /* best-effort */
            }
        }
    }

    // Buffer survivors and decide whether the gate opens.
    gate.pending = mergePending(gate.pending, fresh)
    gate.lastCheapRunAt = now

    const sinceWake = now - (gate.lastWakeAt ?? now)
    const hasPending = gate.pending.length > 0
    const minElapsed = sinceWake >= gate.minWakeGapMs
    const ceilingHit = sinceWake >= gate.maxWakeGapMs

    let wakeReason: WakeReason | null = null
    if (hasPending && minElapsed) wakeReason = 'matches'
    else if (ceilingHit) wakeReason = 'ceiling'

    if (!wakeReason) {
        const heldNote = hasPending
            ? `holding ${gate.pending.length} item(s) for min sleep (${Math.max(0, Math.round((gate.minWakeGapMs - sinceWake) / MINUTE))}m left)`
            : 'nothing new'
        return {
            noteworthy: false,
            summary: `Smart monitor cheap pass: ${checkedCount} checked, ${fresh.length} new, ${suppressedCount} suppressed, ${unavailableCount} unavailable, ${errorCount} error(s) — ${heldNote}; agent stays asleep.`,
            nextState: composeState(prior, gate),
            gate,
        }
    }

    // Gate opens: record wake events + advance lastFiredAt for contributing
    // watches, then build the wake prompt with the concrete detected items.
    const contributing = new Set(gate.pending.map((p) => p.watchId))
    for (const watchId of contributing) {
        try {
            recordWatchEvent(watchId, 'wake', {
                matches: gate.pending.filter((p) => p.watchId === watchId).length,
                reason: wakeReason,
            }, now)
            setWatchCheckpoint(watchId, { lastFiredAt: now })
        } catch {
            /* watch may have been deleted mid-pass — ignore */
        }
    }

    const detected: DetectedChange[] = gate.pending.map((p) => ({
        watchId: p.watchId,
        watchTitle: p.watchTitle,
        source: p.source,
        summary: p.summary,
        ts: p.ts,
        details: p.details,
    }))

    const briefPrompt = buildSmartMonitorAgentPrompt({
        now,
        taskId,
        taskState: prior,
        detected,
        wakeReason,
        gate: { minWakeGapMs: gate.minWakeGapMs, maxWakeGapMs: gate.maxWakeGapMs },
    })

    const summary =
        wakeReason === 'ceiling'
            ? `Smart monitor safety wake (${Math.round(gate.maxWakeGapMs / HOUR)}h ceiling): ${gate.pending.length} buffered item(s) across ${contributing.size} watch(es).`
            : `Smart monitor wake: ${gate.pending.length} new item(s) across ${contributing.size} watch(es).`

    return {
        noteworthy: true,
        summary,
        briefPrompt,
        // Persist BEFORE the wake with the FULL pending buffer and the PRIOR
        // lastWakeAt: if the wake crashes we keep everything and retry later.
        nextState: composeState(prior, gate),
        gate,
    }
}

// ---------------------------------------------------------------------------
// Post-wake finalize
// ---------------------------------------------------------------------------

/**
 * Merge the agent's post-wake task_state with the gate bookkeeping. Called by
 * the scheduler after a Smart Monitor wake completes. The agent owns the
 * top-level state (its digest queue, watermarks, and the minWakeGapMs/
 * maxWakeGapMs knobs); the code re-attaches `_smartGate` so the agent's
 * set_task_state cannot clobber it.
 *
 *  - `lastWakeAt` advances to `firedAt` on BOTH success and failure (the floor
 *    acts as a natural backoff so a persistently-failing wake doesn't retry
 *    every 5 minutes).
 *  - `pending` is cleared only on success; on failure the buffer survives so the
 *    next eligible pass retries the same items.
 */
export function finalizeSmartMonitorWake(args: {
    aiState: Record<string, unknown> | undefined
    preWakeState: Record<string, unknown>
    gate: SmartGateState
    firedAt: number
    ok: boolean
}): Record<string, unknown> {
    const base = args.aiState ?? args.preWakeState
    const baseObj = (base ?? {}) as Record<string, unknown>
    // Honour any minWakeGapMs/maxWakeGapMs the agent tuned during the wake, but
    // fall back to the pre-wake values when the agent omitted them (so a custom
    // sleep window the user set earlier is not silently reset to the default).
    const minWakeGapMs = isFiniteNumber(baseObj.minWakeGapMs)
        ? clampMs(baseObj.minWakeGapMs, SMART_MONITOR_POLL_INTERVAL_MS, DAY, args.gate.minWakeGapMs)
        : args.gate.minWakeGapMs
    const maxWakeGapMs = isFiniteNumber(baseObj.maxWakeGapMs)
        ? clampMs(baseObj.maxWakeGapMs, minWakeGapMs, MAX_WAKE_GAP_CEIL_MS, args.gate.maxWakeGapMs)
        : Math.max(minWakeGapMs, args.gate.maxWakeGapMs)
    const nextGate: SmartGateState = {
        minWakeGapMs,
        maxWakeGapMs,
        lastWakeAt: args.firedAt,
        pending: args.ok ? [] : args.gate.pending,
        lastCheapRunAt: args.gate.lastCheapRunAt,
    }
    return composeState(base, nextGate)
}
