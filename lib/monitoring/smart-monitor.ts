// Smart Monitor — consolidated cheap tick across all user-configured watches.
//
// Runs at a FIXED cadence (the scheduled task's `every` schedule, 5 min). No
// model in the hot loop:
//   1. listDueWatches(now) — only enabled watches whose nextCheckAt has come due
//   2. per watch: source-adapter availability check → cheapCheck → suppress
//      patterns → quiet hours → adaptive cadence update → checkpoint persist
//   3. After all watches: if any candidate survived, build ONE consolidated
//      `briefPrompt` for the orchestrator wake. Multiple watches with matches
//      are batched into a single model wake (never one wake per watch).
//
// The model wake itself is handled by lib/scheduling/run.ts via the existing
// monitor-action wake path (same wiring as Markets monitor). The model's
// learning-loop refinements (wake_reason context, monitor_wake_feedback tool,
// suppress-pattern authoring, action execution) are added in Step 4.

import { evaluateRule } from '../monitor/rules'
import { describeAction, describeRule } from '../monitor/describe'
import type {
    MonitorWatch,
    NotifyPolicy,
    SuppressPattern,
    WatchEvent,
    WatchState,
} from '../monitor/schema'
import {
    incrementSuppressPatternMatch,
    listDueWatches,
    listWatchEvents,
    recordWatchEvent,
    setWatchCadenceCurrent,
    setWatchCheckpoint,
    setWatchState,
} from '../monitor/store'
import {
    getSourceAdapter,
    type MatchedCandidate,
    type SourceAdapter,
} from '../monitor/sources'
import { safeAdapterCall, withTimeout } from '../monitor/sources/types'

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Per-watch hard timeout for one cheap-check. The master tick fires every
 *  5 min and processes watches sequentially; this bound × N watches must stay
 *  comfortably under that. With 10 watches and a 6s ceiling we cap at 60s
 *  worst case (every adapter timing out), well under the next tick. */
const PER_WATCH_TIMEOUT_MS = 6000

/** Adaptive cadence steps. The model can author suppress patterns to silence
 *  noise (lib/monitor/schema.ts), but cadence widening is engine-driven so a
 *  truly quiet watch eventually polls less frequently without model input. */
const QUIET_RUNS_BEFORE_FIRST_WIDEN = 4
const QUIET_RUNS_BEFORE_SECOND_WIDEN = 12   // 4 + 8 (matches the design note)
const WIDEN_MULTIPLIER_1 = 1.5
const WIDEN_MULTIPLIER_2 = 2.0
const TIGHTEN_MULTIPLIER = 0.7

/** Exponential backoff on consecutive integration errors. Bounded by the
 *  watch's own cadence.max so we never pause forever on a transient outage —
 *  the next normal tick will retry. */
const ERROR_BACKOFF_BASE_MS = 60_000
const ERROR_BACKOFF_MAX_MS = 30 * 60_000

// ---------------------------------------------------------------------------
// Return shape — mirrors markets-heartbeat.ts:CheapPassResult so the scheduler
// dispatch path is symmetric.
// ---------------------------------------------------------------------------

export interface SmartMonitorPassResult {
    /** True iff at least one match survived suppress + quiet hours and the
     *  scheduler should wake the model with the briefPrompt below. */
    noteworthy: boolean
    /** One-line audit summary recorded in Past runs even when silent. */
    summary: string
    /** Consolidated wake prompt — only set when noteworthy. Built from ALL
     *  watches that produced surviving matches this tick. */
    briefPrompt?: string
    /** Optional fields for tests / detail UI. The scheduler ignores them. */
    debug: {
        watchesProcessed: number
        watchesUnavailable: number
        watchesErrored: number
        matchesProduced: number
        matchesSuppressed: number
        matchesQuietHours: number
        matchesSurviving: number
    }
}

// ---------------------------------------------------------------------------
// Dependency injection seam for tests.
//
// Production callers don't pass `getAdapter` — they get the real registry.
// Tests inject a custom function that returns mock adapters, so we can verify
// the engine end-to-end without hitting Gmail / HA / WhatsApp / the network.
// ---------------------------------------------------------------------------

export interface RunCheapPassOptions {
    now: number
    /** Override adapter lookup. Defaults to the real registry. */
    getAdapter?: (source: MonitorWatch['source']) => SourceAdapter
    /** Override per-watch timeout (default 6s). */
    perWatchTimeoutMs?: number
    /** Global default quiet hours used when a watch has no per-watch
     *  `notify.quietHours` set. When undefined, the engine fetches the
     *  active config once and uses its `smartMonitor.quietHours`. Pass
     *  `null` to explicitly disable any global fallback (used in tests). */
    globalQuietHours?: { from: string; to: string; timezone: string } | null
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Execute one cheap pass across all due watches. Never throws — adapter
 * failures are converted to recorded errors + checkpoint updates.
 */
export async function runSmartMonitorCheapPass(
    options: RunCheapPassOptions,
): Promise<SmartMonitorPassResult> {
    const now = options.now
    const getAdapter = options.getAdapter ?? getSourceAdapter
    const timeoutMs = options.perWatchTimeoutMs ?? PER_WATCH_TIMEOUT_MS

    // Resolve global quiet hours fallback. `null` from the caller = disable
    // entirely; `undefined` = read live config once for this tick.
    let globalQuietHours = options.globalQuietHours
    if (globalQuietHours === undefined) {
        try {
            const { getConfig } = await import('@/lib/config')
            globalQuietHours = getConfig().smartMonitor?.quietHours ?? null
        } catch {
            globalQuietHours = null
        }
    }

    const due = listDueWatches(now)
    const debug = {
        watchesProcessed: 0,
        watchesUnavailable: 0,
        watchesErrored: 0,
        matchesProduced: 0,
        matchesSuppressed: 0,
        matchesQuietHours: 0,
        matchesSurviving: 0,
    }

    if (due.length === 0) {
        return {
            noteworthy: false,
            summary: 'Smart monitor: no watches due — idle tick.',
            debug,
        }
    }

    // Accumulator for the consolidated model wake. One entry per watch that
    // produced at least one surviving match; brief prompt iterates these.
    const watchBuckets: Array<{
        watch: MonitorWatch
        matches: MatchedCandidate[]
    }> = []

    for (const watch of due) {
        debug.watchesProcessed += 1
        const adapter = getAdapter(watch.source)

        // --- availability ----------------------------------------------------
        const availability = await adapter.isAvailable().catch((err) => ({
            available: false as const,
            reason: err instanceof Error ? err.message : String(err),
        }))
        if (!availability.available) {
            debug.watchesUnavailable += 1
            recordWatchEvent(watch.id, 'check', {
                skipped: true,
                reason: availability.reason ?? 'integration unavailable',
            })
            // We don't bump consecutiveErrors — an integration outage is not
            // the watch's fault. Schedule the next try at the normal cadence
            // so it auto-recovers when the integration comes back.
            setWatchCheckpoint(watch.id, {
                lastCheckedAt: now,
                nextCheckAt: now + watch.cadence.current * 1000,
                lastError: availability.reason ?? 'integration unavailable',
            })
            continue
        }

        // --- cheap fetch + rule eval ----------------------------------------
        const result = await safeAdapterCall(`${watch.source} cheap check`, () =>
            withTimeout(
                adapter.cheapCheck({ watch, now, timeoutMs }),
                timeoutMs,
                `${watch.source} cheap check`,
            )
        )

        if (!result.ok) {
            debug.watchesErrored += 1
            const errMsg = result.error ?? 'cheap check failed'
            recordWatchEvent(watch.id, 'error', { message: errMsg })

            const nextErrors = watch.consecutiveErrors + 1
            // Exponential backoff capped at min(cadence.max, ERROR_BACKOFF_MAX).
            const backoff = Math.min(
                ERROR_BACKOFF_MAX_MS,
                ERROR_BACKOFF_BASE_MS * Math.pow(2, Math.min(6, nextErrors - 1)),
            )
            const cadenceMs = watch.cadence.current * 1000
            const nextCheckIn = Math.max(cadenceMs, backoff)

            setWatchCheckpoint(watch.id, {
                lastCheckedAt: now,
                nextCheckAt: now + nextCheckIn,
                consecutiveErrors: nextErrors,
                lastError: errMsg,
            })

            // Persist any state update the adapter did manage to return
            // (e.g., partial extra updates). Wholesale merge below.
            if (Object.keys(result.stateUpdate).length > 0) {
                setWatchState(watch.id, mergeState(watch.state, result.stateUpdate))
            }
            continue
        }

        // --- success path ---------------------------------------------------
        // Record one `check` event per tick for visibility, even when nothing
        // matched — the detail UI uses these to render the tick history.
        recordWatchEvent(watch.id, 'check', {
            candidatesSeen: result.candidatesSeen,
            matchesProduced: result.matches.length,
        })

        debug.matchesProduced += result.matches.length

        // --- suppression ----------------------------------------------------
        const { surviving, suppressed } = applySuppressPatterns(
            result.matches,
            watch.suppressPatterns,
            now,
        )
        debug.matchesSuppressed += suppressed.length
        for (const drop of suppressed) {
            recordWatchEvent(watch.id, 'suppress', {
                patternId: drop.patternId,
                patternReason: drop.patternReason,
                externalId: drop.externalId,
                summary: drop.summary,
            })
            incrementSuppressPatternMatch(watch.id, drop.patternId)
        }

        // --- quiet hours ----------------------------------------------------
        // Per-watch quiet hours win; fall back to the global default. Wrap
        // the global into a NotifyPolicy-shaped object so we can reuse the
        // existing wrap-around-aware isInQuietHours helper.
        const effectivePolicy = watch.notify.quietHours
            ? watch.notify
            : (globalQuietHours
                ? { ...watch.notify, quietHours: globalQuietHours }
                : watch.notify)
        const inQuiet = isInQuietHours(effectivePolicy, now)
        const visibleMatches = inQuiet ? [] : surviving
        if (inQuiet) {
            debug.matchesQuietHours += surviving.length
            for (const m of surviving) {
                recordWatchEvent(watch.id, 'suppress', {
                    reason: 'quiet_hours',
                    externalId: m.externalId,
                    summary: m.summary,
                })
            }
        }

        // Engine-emitted `match` events (one per surviving, regardless of
        // notify suppression) — they belong in the audit log so the user can
        // see what was found even during quiet hours.
        for (const m of surviving) {
            recordWatchEvent(watch.id, 'match', {
                externalId: m.externalId,
                summary: m.summary,
                details: m.details ?? null,
            })
        }
        debug.matchesSurviving += visibleMatches.length

        // --- state + cadence + checkpoint ----------------------------------
        const stateAfter = applyActivityCounters(
            mergeState(watch.state, result.stateUpdate),
            visibleMatches.length > 0,
            suppressed.length,
            now,
        )
        setWatchState(watch.id, stateAfter)

        const desiredCadence = computeAdaptiveCadence(
            watch.cadence.current,
            watch.cadence.min,
            watch.cadence.max,
            stateAfter.quietRuns,
            visibleMatches.length > 0,
        )
        if (desiredCadence !== watch.cadence.current) {
            setWatchCadenceCurrent(watch.id, desiredCadence)
        }

        const effectiveCadence = desiredCadence
        setWatchCheckpoint(watch.id, {
            lastCheckedAt: now,
            nextCheckAt: now + effectiveCadence * 1000,
            lastFiredAt: visibleMatches.length > 0 ? now : undefined,
            consecutiveErrors: 0,
            lastError: null,
        })

        if (visibleMatches.length > 0) {
            watchBuckets.push({ watch, matches: visibleMatches })
            recordWatchEvent(watch.id, 'wake', {
                matches: visibleMatches.length,
            })
        }
    }

    if (watchBuckets.length === 0) {
        return {
            noteworthy: false,
            summary: summarizeIdle(debug),
            debug,
        }
    }

    return {
        noteworthy: true,
        summary: summarizeNoteworthy(watchBuckets, debug),
        briefPrompt: buildBriefPrompt(watchBuckets, now),
        debug,
    }
}

// ---------------------------------------------------------------------------
// Suppress patterns
// ---------------------------------------------------------------------------

interface SuppressedDrop {
    externalId?: string
    summary: string
    patternId: string
    patternReason: string
}

function applySuppressPatterns(
    matches: MatchedCandidate[],
    patterns: SuppressPattern[],
    now: number,
): { surviving: MatchedCandidate[]; suppressed: SuppressedDrop[] } {
    if (patterns.length === 0) return { surviving: matches, suppressed: [] }
    const active = patterns.filter((p) => p.expiresAt === null || p.expiresAt > now)
    if (active.length === 0) return { surviving: matches, suppressed: [] }

    const surviving: MatchedCandidate[] = []
    const suppressed: SuppressedDrop[] = []
    for (const m of matches) {
        const hit = active.find((p) => evaluateRule(p.rule, m.candidate))
        if (hit) {
            suppressed.push({
                externalId: m.externalId,
                summary: m.summary,
                patternId: hit.id,
                patternReason: hit.reason,
            })
        } else {
            surviving.push(m)
        }
    }
    return { surviving, suppressed }
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

/** Tests whether `now` falls inside the watch's quiet-hours window. Window is
 *  expressed as a clock range in a named IANA tz — handles wrap-around (e.g.,
 *  23:00–07:00 spans midnight). When `notify.quietHours` is absent, never
 *  suppress (Step 10 will add a global default). */
export function isInQuietHours(notify: NotifyPolicy, now: number): boolean {
    const qh = notify.quietHours
    if (!qh) return false
    const minutesNow = clockMinutesAt(now, qh.timezone)
    if (minutesNow === null) return false
    const from = parseClockMinutes(qh.from)
    const to = parseClockMinutes(qh.to)
    if (from === null || to === null) return false
    if (from === to) return false // zero-length window = disabled
    if (from < to) {
        return minutesNow >= from && minutesNow < to
    }
    // Wrap-around (e.g., 23:00 → 07:00)
    return minutesNow >= from || minutesNow < to
}

function parseClockMinutes(hhmm: string): number | null {
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
    if (!m) return null
    const h = Number(m[1])
    const mm = Number(m[2])
    if (h > 23 || mm > 59) return null
    return h * 60 + mm
}

function clockMinutesAt(epochMs: number, timezone: string): number | null {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(new Date(epochMs))
        let h = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN)
        const m = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN)
        // Intl renders 00 as "24" in some locales; normalize.
        if (h === 24) h = 0
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null
        return h * 60 + m
    } catch {
        return null
    }
}

// ---------------------------------------------------------------------------
// State + cadence
// ---------------------------------------------------------------------------

function mergeState(prev: WatchState, patch: Partial<WatchState>): WatchState {
    return {
        ...prev,
        ...patch,
        // `extra` always merges (caller is supposed to pass a fully-merged
        // extra in the patch, but we re-merge defensively).
        extra: { ...(prev.extra ?? {}), ...(patch.extra ?? {}) },
    }
}

function applyActivityCounters(
    state: WatchState,
    hadMatches: boolean,
    suppressedCount: number,
    now: number,
): WatchState {
    if (hadMatches) {
        return {
            ...state,
            quietRuns: 0,
            activeRuns: state.activeRuns + 1,
            cumulativeMatches: state.cumulativeMatches + 1,
            suppressedMatches: state.suppressedMatches + suppressedCount,
            lastNotifiedAt: now,
        }
    }
    return {
        ...state,
        quietRuns: state.quietRuns + 1,
        suppressedMatches: state.suppressedMatches + suppressedCount,
    }
}

/** Continuous cadence adjustment — adaptive widen on sustained quiet, tighten
 *  on activity. Bounded to [min, max]. Identity when adaptive is off (caller
 *  also guards via setWatchCadenceCurrent which honors the flag). */
export function computeAdaptiveCadence(
    current: number,
    min: number,
    max: number,
    quietRuns: number,
    hadMatches: boolean,
): number {
    if (hadMatches) {
        return Math.max(min, Math.round(current * TIGHTEN_MULTIPLIER))
    }
    // Widen only at the tier thresholds, not every quiet run — prevents
    // unbounded drift. Step 4 may add learned-routine adjustments on top.
    let target = current
    if (quietRuns >= QUIET_RUNS_BEFORE_SECOND_WIDEN && quietRuns % 4 === 0) {
        target = Math.round(current * WIDEN_MULTIPLIER_2)
    } else if (quietRuns === QUIET_RUNS_BEFORE_FIRST_WIDEN) {
        target = Math.round(current * WIDEN_MULTIPLIER_1)
    }
    return Math.min(max, Math.max(min, target))
}

// ---------------------------------------------------------------------------
// Brief prompt + summaries
// ---------------------------------------------------------------------------

function summarizeIdle(debug: SmartMonitorPassResult['debug']): string {
    const parts: string[] = [
        `Smart monitor: ${debug.watchesProcessed} watch(es) checked`,
    ]
    if (debug.watchesUnavailable > 0)
        parts.push(`${debug.watchesUnavailable} integration unavailable`)
    if (debug.watchesErrored > 0)
        parts.push(`${debug.watchesErrored} errored`)
    if (debug.matchesSuppressed > 0)
        parts.push(`${debug.matchesSuppressed} suppressed`)
    if (debug.matchesQuietHours > 0)
        parts.push(`${debug.matchesQuietHours} held by quiet hours`)
    parts.push('nothing noteworthy.')
    return parts.join(' — ')
}

function summarizeNoteworthy(
    buckets: Array<{ watch: MonitorWatch; matches: MatchedCandidate[] }>,
    debug: SmartMonitorPassResult['debug'],
): string {
    const totalMatches = buckets.reduce((n, b) => n + b.matches.length, 0)
    const titles = buckets.map((b) => b.watch.title).slice(0, 4)
    const more = buckets.length > 4 ? ` +${buckets.length - 4} more` : ''
    return `Smart monitor: ${totalMatches} match(es) across ${buckets.length} watch(es) — ${titles.join(', ')}${more}.${debug.matchesSuppressed > 0 ? ` (${debug.matchesSuppressed} suppressed)` : ''}`
}

function clipDetailJson(details: unknown, maxChars = 400): string {
    let s: string
    try {
        s = JSON.stringify(details)
    } catch {
        return '(non-serializable details)'
    }
    if (s.length <= maxChars) return s
    return `${s.slice(0, maxChars)}…`
}

/** History kinds the model is interested in when judging this wake. We exclude
 *  raw `check` events (very noisy — one per tick) and `cadence_change` (engine
 *  bookkeeping). Wake/notify/suppress/feedback/match/action/error are signal. */
const WAKE_HISTORY_KINDS = ['wake', 'notify', 'suppress', 'feedback', 'match', 'action', 'error'] as const

function renderHistoryLine(ev: WatchEvent): string {
    const ts = new Date(ev.ts).toISOString()
    const payload = ev.payload ?? {}
    switch (ev.kind) {
        case 'wake':
            return `[${ts}] WAKE — ${typeof payload.matches === 'number' ? payload.matches : '?'} match(es) escalated`
        case 'notify':
            return `[${ts}] NOTIFY — "${typeof payload.summary === 'string' ? payload.summary : ''}"`
        case 'suppress': {
            const reason = typeof payload.reason === 'string' ? payload.reason
                : typeof payload.patternReason === 'string' ? `pattern: ${payload.patternReason}`
                    : 'pattern matched'
            const summary = typeof payload.summary === 'string' ? payload.summary : ''
            return `[${ts}] SUPPRESS (${reason}) — ${summary}`
        }
        case 'feedback': {
            const verdict = payload.was_worth_it === true ? 'worth-it' : payload.was_worth_it === false ? 'NOT worth-it' : 'unknown'
            const reason = typeof payload.reason === 'string' ? `: ${payload.reason}` : ''
            return `[${ts}] FEEDBACK (${verdict})${reason}`
        }
        case 'match':
            return `[${ts}] MATCH — "${typeof payload.summary === 'string' ? payload.summary : ''}"`
        case 'action':
            return `[${ts}] ACTION — ${typeof payload.kind === 'string' ? payload.kind : 'unknown'}`
        case 'error':
            return `[${ts}] ERROR — ${typeof payload.message === 'string' ? payload.message : ''}`
        case 'cadence_change':
            return `[${ts}] cadence ${payload.from}s → ${payload.to}s`
        case 'check':
            return `[${ts}] check`
    }
}

function renderSuppressPattern(p: SuppressPattern): string {
    const expires = p.expiresAt ? ` (expires ${new Date(p.expiresAt).toISOString()})` : ''
    const hits = p.matchCount > 0 ? ` — hit ${p.matchCount} time(s)` : ''
    return `id=${p.id} "${p.reason}": ${describeRule(p.rule)}${hits}${expires}`
}

function buildBriefPrompt(
    buckets: Array<{ watch: MonitorWatch; matches: MatchedCandidate[] }>,
    now: number,
): string {
    const lines: string[] = []
    lines.push('You are a Smart Monitor consolidated wake. The cheap tick produced matches across the user\'s active watches. Decide what to surface, and record feedback so future ticks get smarter.')
    lines.push('')
    lines.push(`Tick at ${new Date(now).toISOString()}.`)
    lines.push('')
    lines.push('<wake_reason>')
    lines.push(`This wake was triggered by ${buckets.reduce((n, b) => n + b.matches.length, 0)} match(es) across ${buckets.length} watch(es). For each watch below: the rule that captured the match (so you remember the user\'s intent), recent decision history (so you stay consistent with past choices), active suppress patterns (already filtering noise), and the matches that fired this tick.`)
    lines.push('')

    for (const bucket of buckets) {
        const w = bucket.watch
        lines.push(`## Watch ${w.id} — "${w.title}"`)
        lines.push(`Source: ${w.source}   Target: ${w.target}`)
        lines.push(`Rule: ${describeRule(w.rule)}`)
        const allowed = w.allowedActions.length === 0
            ? '(only notify_inbox is allowed)'
            : w.allowedActions.map(describeAction).join(', ')
        lines.push(`Allowed actions: ${allowed}`)
        if (w.notify.quietHours) {
            lines.push(`Quiet hours: ${w.notify.quietHours.from}-${w.notify.quietHours.to} ${w.notify.quietHours.timezone}`)
        }
        lines.push(`Cadence: ${w.cadence.current}s${w.cadence.adaptive ? ' (adaptive)' : ' (fixed)'}  ·  state.quietRuns=${w.state.quietRuns} state.activeRuns=${w.state.activeRuns}`)

        const recent = listWatchEvents(w.id, {
            limit: 12,
            kinds: [...WAKE_HISTORY_KINDS],
        })
        if (recent.length === 0) {
            lines.push('Recent decisions: (first wake for this watch)')
        } else {
            lines.push('Recent decisions (most recent first):')
            for (const ev of recent) lines.push(`  ${renderHistoryLine(ev)}`)
        }

        const active = w.suppressPatterns.filter((p) => p.expiresAt === null || p.expiresAt > now)
        if (active.length === 0) {
            lines.push('Active suppress patterns: none.')
        } else {
            lines.push(`Active suppress patterns (${active.length}):`)
            for (const p of active) lines.push(`  - ${renderSuppressPattern(p)}`)
        }

        lines.push('')
        lines.push(`Matches this tick (${bucket.matches.length}):`)
        for (const m of bucket.matches) {
            lines.push(`- ${m.summary}`)
            if (m.details && Object.keys(m.details).length > 0) {
                lines.push(`  details: ${clipDetailJson(m.details)}`)
            }
        }
        lines.push('')
    }
    lines.push('</wake_reason>')
    lines.push('')

    lines.push('How to act:')
    lines.push('1) For each watch separately, decide if THIS tick\'s matches deserve the user\'s attention NOW. Use the recent decisions to stay consistent — if you suppressed a near-identical pattern moments ago, suppress again.')
    lines.push('2) For things worth surfacing: call `notify_inbox` ONCE per logically distinct issue. Group related matches across watches into a single message when they belong together. Be specific: who, what, value, link.')
    lines.push('3) For each watch you touched (notified or not), call `monitor_wake_feedback({ watch_id, was_worth_it, reason })`:')
    lines.push('   - `was_worth_it: true` when matches deserved attention (you notified, or could have but chose to consolidate).')
    lines.push('   - `was_worth_it: false` when matches were noise/routine. In that case ALSO pass `add_suppress_pattern` with a structured MonitorRule that captures the noise (same predicate kinds the watch itself supports) so future ticks drop similar candidates BEFORE the model is woken. Use `expires_in_days` when you are not certain the pattern is permanent.')
    lines.push('   - If a previously-added suppress pattern is over-suppressing, retract it via `remove_suppress_pattern_id` in the same call.')
    lines.push('4) Do NOT schedule anything. Do NOT modify watches (no monitor_watch_* in a wake). The only tools you may call are `notify_inbox` and `monitor_wake_feedback`.')
    lines.push('5) Quiet hours and existing suppress patterns have ALREADY filtered out their candidates — anything you see here passed those filters, so be sparing only based on intent, not redundancy.')

    return lines.join('\n')
}
