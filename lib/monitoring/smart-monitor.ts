// Smart Monitor — model-led wake context for all user-configured watches.
//
// The active production path wakes the orchestrator directly from the single
// Smart Monitor scheduled task. The cheap-pass engine below is retained for
// legacy smoke tests and old audit tooling, but it is no longer the gate that
// decides whether the model wakes.
//
// Legacy cheap-pass behavior:
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
import { nextMonitorCheckAt, snapCadenceSeconds } from '../monitor/cadence'
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
    listMonitorWatches,
    listWatchEvents,
    recordWatchEvent,
    setWatchCadenceCurrent,
    setWatchCheckpoint,
    setWatchState,
} from '../monitor/store'
import { listTaskRuns, type TaskRunRecord } from '../scheduling/store'
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
 *  15 minutes and processes watches sequentially; this bound × N watches must stay
 *  comfortably under that. With 10 watches and a 6s ceiling we cap at 60s
 *  worst case (every adapter timing out), well under the next 15-minute tick. */
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
                nextCheckAt: nextMonitorCheckAt(now, watch.cadence.current),
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
                nextCheckAt: nextMonitorCheckAt(now, Math.ceil(nextCheckIn / 1000)),
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
            nextCheckAt: nextMonitorCheckAt(now, effectiveCadence),
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
        return snapCadenceSeconds(current * TIGHTEN_MULTIPLIER, min, max)
    }
    // Widen only at the tier thresholds, not every quiet run — prevents
    // unbounded drift. Step 4 may add learned-routine adjustments on top.
    let target = current
    if (quietRuns >= QUIET_RUNS_BEFORE_SECOND_WIDEN && quietRuns % 4 === 0) {
        target = current * WIDEN_MULTIPLIER_2
    } else if (quietRuns === QUIET_RUNS_BEFORE_FIRST_WIDEN) {
        target = current * WIDEN_MULTIPLIER_1
    }
    return snapCadenceSeconds(target, min, max)
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

function clipUnknownJson(value: unknown, maxChars = 4000): string {
    let s: string
    try {
        s = JSON.stringify(value ?? {}, null, 2)
    } catch {
        return '(non-serializable state)'
    }
    if (s.length <= maxChars) return s
    return `${s.slice(0, maxChars)}\n...(truncated)`
}

function clipLine(text: string, maxChars = 500): string {
    const compact = text.replace(/\s+/g, ' ').trim()
    if (compact.length <= maxChars) return compact
    return `${compact.slice(0, maxChars)}...`
}

function renderTaskRunLine(run: TaskRunRecord): string {
    const out = run.error || run.summary || '(no output)'
    return [
        new Date(run.startedAt).toISOString(),
        run.status,
        run.surfaced ? 'Inbox' : 'silent',
        run.trigger,
        clipLine(out),
    ].join(' | ')
}

function buildRecentRunHistoryBlock(taskId: string, now: number): string[] {
    const runs = listTaskRuns(taskId, 20)
    const since = now - 24 * 60 * 60 * 1000
    const lastDay = runs.filter((run) => run.startedAt >= since)
    if (runs.length === 0) {
        return ['Recent scheduled-run history: none yet.']
    }
    const lines = [
        `Recent scheduled-run history: ${lastDay.length} run(s) in the last 24h; showing latest ${Math.min(10, runs.length)}.`,
    ]
    for (const run of runs.slice(0, 10)) lines.push(`  ${renderTaskRunLine(run)}`)
    return lines
}

/** History kinds the model is interested in when judging this wake. We exclude
 *  raw `check` events (very noisy — one per tick) and `cadence_change` (engine
 *  bookkeeping). Wake/notify/suppress/feedback/match/action/error are signal. */
const WAKE_HISTORY_KINDS = ['wake', 'notify', 'suppress', 'feedback', 'match', 'action', 'error'] as const

export function buildSmartMonitorAgentPrompt(options: {
    now: number
    taskId: string
    taskState: unknown
}): string {
    const { now, taskId, taskState } = options
    const watches = listMonitorWatches({ enabled: true })
    const lines: string[] = []

    lines.push('You are the Smart Monitor agent wake.')
    lines.push('The old cheap rule gate is NOT running for Smart Monitor anymore. You are awake because the single Smart Monitor schedule fired. Your job is to inspect the enabled watch intents directly, decide what matters, notify sparingly, update task state, and adjust your next cadence when useful.')
    lines.push('')
    lines.push('Operating model:')
    lines.push('- There is one consolidated Smart Monitor agent for Gmail, Google Calendar, WhatsApp, Home Assistant, Web, and Weather. Do not create separate scheduled tasks or extra agents for urgent/digest/noise tiers.')
    lines.push('- Watch records below are source boundaries and user-intent hints. Their structured rule is a fetch hint, not a preset notification rule and not proof that the user should be interrupted.')
    lines.push('- Do not invent canned urgent keyword lists. Extract the user intent from the watch title/target/rule, the durable memory already in your prompt, and your task state. If the intent is too vague, stay conservative and mention the missing capability in your normal output without notifying unless there is a real issue.')
    lines.push('- Use integration read tools to inspect only what is needed. Activate the specific integrations you need first: gmail, whatsapp, google-calendar, home-assistant, weather, maps, etc. If a direct tool is not visible after activation, use RunActivatedIntegrationTool with the target tool id.')
    lines.push('- Notify Inbox only for things that are important, time-sensitive, personally directed, account/security/payment related, deadline/travel/order affecting, operationally relevant, or clearly actionable under the watch intent.')
    lines.push('- For non-urgent accumulated items, summarize only when the watch/user preference calls for it or the volume is meaningfully high. Otherwise stay silent.')
    lines.push('- Digest behavior is model-owned, not a fixed watch policy. If items should be batched for a later summary, store a compact digestQueue/lastDigestAt in task_state and choose an appropriate future wake cadence.')
    lines.push('- Never perform source-side write actions unless the watch allowed action explicitly permits it AND the user already approved the exact rule/action boundary. Notify-only remains the default.')
    lines.push('')
    lines.push('Cadence policy:')
    lines.push(`- Current task id: ${taskId}. Default cadence is 15m.`)
    lines.push('- You MAY call reschedule_task for this task to self-pace. Keep the 15m default when it still fits; tighten only for clearly time-sensitive periods; widen to 30m, 1h, 2h, or longer after sustained quiet periods, low-signal hours, or known inactive windows. Do not thrash; reschedule only on a clear tier change.')
    lines.push('- Legacy quiet-hours fields are context only, not a hard upstream gate. Use local time, task history, and urgency to decide whether to notify now, defer, or widen cadence.')
    lines.push('- Always call set_task_state with the full updated small state: per-source watermarks/lastSeen ids, quietRuns/activeRuns, lastNotifiedAt, cadenceTier, lastCheckedAt, digestQueue/lastDigestAt if useful, and any useful time-of-day signal.')
    lines.push('')
    lines.push(`Wake time: ${new Date(now).toISOString()}.`)
    lines.push('')
    lines.push('<task_state>')
    lines.push(clipUnknownJson(taskState))
    lines.push('</task_state>')
    lines.push('')
    lines.push('<recent_smart_monitor_runs>')
    lines.push(...buildRecentRunHistoryBlock(taskId, now))
    lines.push('</recent_smart_monitor_runs>')
    lines.push('')

    if (watches.length === 0) {
        lines.push('No enabled Smart Monitor watches exist. Do not notify. Call set_task_state with lastCheckedAt and finish.')
        return lines.join('\n')
    }

    lines.push('<smart_monitor_watches>')
    lines.push(`Enabled watches: ${watches.length}`)
    lines.push('')

    for (const w of watches) {
        lines.push(`## Watch ${w.id} - "${w.title}"`)
        lines.push(`Source: ${w.source}`)
        lines.push(`Target: ${w.target}`)
        lines.push(`Intent/fetch hint: ${describeRule(w.rule)}`)
        const allowed = w.allowedActions.length === 0
            ? 'notify_inbox only'
            : `notify_inbox plus: ${w.allowedActions.map(describeAction).join(', ')}`
        lines.push(`Allowed actions: ${allowed}`)
        if (w.notify.quietHours) {
            lines.push(`Legacy quiet preference: ${w.notify.quietHours.from}-${w.notify.quietHours.to} ${w.notify.quietHours.timezone}`)
        }
        lines.push(`Legacy per-watch counters: quietRuns=${w.state.quietRuns}, activeRuns=${w.state.activeRuns}, lastCheckedAt=${w.lastCheckedAt ? new Date(w.lastCheckedAt).toISOString() : 'never'}, lastFiredAt=${w.lastFiredAt ? new Date(w.lastFiredAt).toISOString() : 'never'}`)

        const recent = listWatchEvents(w.id, {
            limit: 8,
            kinds: [...WAKE_HISTORY_KINDS],
        })
        if (recent.length > 0) {
            lines.push('Recent watch decisions:')
            for (const ev of recent) lines.push(`  ${renderHistoryLine(ev)}`)
        }

        const active = w.suppressPatterns.filter((p) => p.expiresAt === null || p.expiresAt > now)
        if (active.length > 0) {
            lines.push('Learned suppress patterns to consider:')
            for (const p of active) lines.push(`  - ${renderSuppressPattern(p)}`)
        }
        lines.push('')
    }

    lines.push('</smart_monitor_watches>')
    lines.push('')
    lines.push('Suggested source strategy:')
    lines.push('- Gmail: search only the relevant query/scope, usually unread Primary or watch target. Read threads only for new or potentially important results. Compare message/thread ids with task_state before notifying.')
    lines.push('- WhatsApp: start with WhatsAppUnreadSummary. For unread chats that match the watch intent or important contacts, read recent messages and compare message ids with task_state. For the current user preference, Anduța/Anduta is highest priority.')
    lines.push('- Google Calendar: list upcoming bounded windows and RSVP-needed items. If there are no relevant events, stop that branch. Route-aware logic should first read Calendar; only then use location/routes if an event with a real location exists.')
    lines.push('- Home Assistant/Web/Weather: read only the entities/URLs/locations implied by the watch. Avoid broad scans unless the watch explicitly asks for them.')
    lines.push('')
    lines.push('Finish criteria:')
    lines.push('1. If nothing is noteworthy, do not call notify_inbox. Return a short internal summary only; it will stay in Past runs.')
    lines.push('2. If something matters, call notify_inbox with one compact, specific message per real issue. Group related source findings.')
    lines.push('3. Persist set_task_state every run, even when silent.')
    lines.push('4. Optionally call reschedule_task if the next cadence should change based on the activity/time pattern. For this ongoing Smart Monitor task, use recurring timing such as when.every/daily_at/cron, not one-shot when.in/at.')

    return lines.join('\n')
}

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
    lines.push('You are a Smart Monitor consolidated wake. A legacy candidate pass produced matches across the user\'s active watches. Decide what to surface, and record feedback so future runs get smarter.')
    lines.push('Important operating model: this is one consolidated monitor wake, not one agent per source or one agent per urgency tier. You can evaluate many Gmail, Calendar, Home Assistant, WhatsApp, Web, and Weather candidates in this single turn. Group related items and notify sparingly.')
    lines.push('Work through the watch sections in order. For each watch: read the user intent from its title/rule/target, inspect all matches for that watch, decide notify vs suppress/summary/action within its allowed actions, then move to the next watch. After all watches are assessed, send the fewest useful Inbox notifications by grouping related items across watches, and record monitor_wake_feedback once per watch involved.')
    lines.push('For broad triage watches, treat the rule as the candidate feed, not as a reason to interrupt for every match. Interrupt only for matches that look important, time-sensitive, personally directed, account/security/payment related, deadline/travel/order affecting, operationally relevant, or clearly actionable under the watch intent. Routine automated messages and repeated low-value matches are usually noise or summary material. If only notify_inbox is allowed, never perform source-side changes; only suggest choices in an Inbox note when useful and learn from feedback with narrow suppress patterns.')
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
            lines.push(`Legacy quiet context: ${w.notify.quietHours.from}-${w.notify.quietHours.to} ${w.notify.quietHours.timezone}`)
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
    lines.push('5) Existing suppress patterns may have filtered candidates before this prompt. Be sparing based on intent and avoid treating legacy quiet-hour metadata as a hard gate.')

    return lines.join('\n')
}
