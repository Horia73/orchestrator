// Smart Monitor - model-led wake context for recurring work whose check needs
// model judgement. Deterministic gates belong in Microscripts.

import { describeAction, describeRule } from '../monitor/describe'
import type { SuppressPattern, WatchEvent } from '../monitor/schema'
import { listMonitorWatches, listWatchEvents } from '../monitor/store'
import { listTaskRuns, type TaskRunRecord } from '../scheduling/store'
import { getConfig } from '../config'

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

function systemTimezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
        return 'UTC'
    }
}

function validTimezone(tz: string): boolean {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0))
        return true
    } catch {
        return false
    }
}

function formatLocalDateTime(ms: number, timezone: string): string {
    const date = new Date(ms)
    const local = new Intl.DateTimeFormat('sv-SE', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).format(date)
    const offset =
        new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            hour: '2-digit',
            hourCycle: 'h23',
            timeZoneName: 'shortOffset',
        })
            .formatToParts(date)
            .find((part) => part.type === 'timeZoneName')?.value ?? ''
    const localDate = local.slice(0, 10)
    return offset ? `${local} ${offset} (local_date ${localDate})` : `${local} (local_date ${localDate})`
}

function buildRuntimeTimeBlock(now: number, watches: Array<{ notify: { quietHours?: { timezone: string } } }>): string[] {
    const zones = new Set<string>()
    const configured = getConfig().smartMonitor?.quietHours?.timezone
    if (configured && validTimezone(configured)) zones.add(configured)
    for (const watch of watches) {
        const tz = watch.notify.quietHours?.timezone
        if (tz && validTimezone(tz)) zones.add(tz)
    }
    const system = systemTimezone()
    if (validTimezone(system)) zones.add(system)
    if (zones.size === 0) zones.add('UTC')

    const lines = ['Runtime time:', `- UTC wake time: ${new Date(now).toISOString()}`]
    for (const tz of zones) {
        lines.push(`- ${tz}: ${formatLocalDateTime(now, tz)}`)
    }
    lines.push('- Treat the local time lines above as authoritative; do not manually infer DST from the UTC timestamp.')
    return lines
}

/** History kinds the model is interested in when judging this wake. We exclude
 * raw `check` events (very noisy) and `cadence_change` (bookkeeping). */
const WAKE_HISTORY_KINDS = ['wake', 'notify', 'suppress', 'feedback', 'match', 'action', 'error'] as const

/** One concrete change the cheap pass detected and is escalating to this wake.
 *  Structurally compatible with SmartPendingMatch in smart-monitor-cheap-pass.ts
 *  (kept defined here so the cheap pass imports the builder, not vice-versa). */
export interface DetectedChange {
    watchId: string
    watchTitle: string
    source: string
    summary: string
    ts: number
    details?: Record<string, unknown>
}

function buildDetectedBlock(detected: DetectedChange[]): string[] {
    const lines = ['<detected_changes>']
    lines.push(`The cheap pass already detected these ${detected.length} new item(s) since the last wake. Anchor this wake on them — do not blindly re-scan every source; fetch more only when an item needs context to judge.`)
    const byWatch = new Map<string, DetectedChange[]>()
    for (const d of detected) {
        const arr = byWatch.get(d.watchId) ?? []
        arr.push(d)
        byWatch.set(d.watchId, arr)
    }
    for (const [, items] of byWatch) {
        const head = items[0]
        lines.push(`- ${head.watchTitle} (${head.source}, ${items.length} item${items.length === 1 ? '' : 's'}):`)
        for (const it of items.slice(0, 12)) {
            lines.push(`    • ${clipLine(it.summary, 240)}`)
        }
        if (items.length > 12) lines.push(`    • …and ${items.length - 12} more`)
    }
    lines.push('</detected_changes>')
    return lines
}

export function buildSmartMonitorAgentPrompt(options: {
    now: number
    taskId: string
    taskState: unknown
    /** Concrete changes the cheap pass surfaced for this wake. Empty/undefined
     *  on a safety-ceiling wake where nothing new was detected. */
    detected?: DetectedChange[]
    /** Why this wake fired: 'matches' (new items past min sleep) or 'ceiling'
     *  (periodic safety wake during quiet). */
    wakeReason?: 'matches' | 'ceiling'
    /** Current gate knobs, so the agent knows the floor/ceiling it can tune. */
    gate?: { minWakeGapMs: number; maxWakeGapMs: number }
}): string {
    const { now, taskId, taskState, detected = [], wakeReason, gate } = options
    const watches = listMonitorWatches({ enabled: true })
    const lines: string[] = []
    const minMinutes = gate ? Math.round(gate.minWakeGapMs / 60_000) : 15
    const maxHours = gate ? Math.max(1, Math.round(gate.maxWakeGapMs / 3_600_000)) : 6

    lines.push('You are the Smart Monitor agent wake.')
    if (wakeReason === 'ceiling') {
        lines.push(`You are awake because the safety ceiling (~${maxHours}h with no detected change) elapsed, not because the cheap pass found something. Re-derive intent, run any due model-owned (custom) checks, flush a digest if one is pending, and otherwise stay silent.`)
    } else {
        lines.push('You are awake because a cheap, no-model pass detected new items (listed under <detected_changes>) and your minimum sleep elapsed. Judge those items, decide what matters, notify sparingly, and update task state.')
    }
    lines.push('')
    lines.push('Operating model:')
    lines.push('- A cheap, code-only pass runs every ~5 minutes and watermarks each connector source. It does NOT wake you on its own; it only buffers genuinely-new, rule-matching items and wakes you once the buffer is non-empty AND your minimum sleep has elapsed (or the safety ceiling is hit). When nothing changes, you stay asleep — that is intended.')
    lines.push('- There is one consolidated Smart Monitor agent for recurring monitoring, recurring summaries, and recurring model-owned maintenance. Do not create separate scheduled tasks or extra agents for urgent/digest/noise tiers.')
    lines.push('- Smart Monitor must have exactly one Scheduling runtime entry: this consolidated Smart monitor heartbeat. Do not create separate scheduled tasks for Smart Monitor digests, summaries, maintenance, source-specific wakeups, retries, or catch-up runs.')
    lines.push('- Store durable recurring requirements as Smart Monitor watch specs in MONITORS.md, and store execution bookkeeping in this Smart Monitor task_state. On every heartbeat, use current runtime time to perform overdue still-useful work that has not already been completed, skipped, or deduplicated for the relevant period.')
    lines.push('- Watch records below are recurring-work boundaries and user-intent hints. Connector rules are fetch hints; custom rules are model-owned check prompts. They are not preset notification rules and not proof that the user should be interrupted.')
    lines.push('- Do not invent canned urgent keyword lists. Extract the user intent from the watch title/target/rule, the durable memory already in your prompt, and your task state. If the intent is too vague, stay conservative and mention the missing capability in your normal output without notifying unless there is a real issue.')
    lines.push('- Use only the tools needed by each watch. For connector watches, activate the matching integration before reading. For custom watches, follow the custom_prompt with the available workspace, memory, runtime-history, and integration tools that fit that instruction.')
    lines.push('- If a watch needs current public-web research, do not try to combine native web search with this wake\'s action tools. Use delegate_to with the Researcher for a compact search-only subtask, then use the returned facts in this wake to decide notify_inbox, monitor_wake_feedback, and set_task_state.')
    lines.push('- Notify Inbox only for things that are important, time-sensitive, personally directed, account/security/payment related, deadline/travel/order affecting, operationally relevant, or clearly actionable under the watch intent.')
    lines.push('- For non-urgent accumulated items, summarize only when the watch/user preference calls for it or the volume is meaningfully high. Otherwise stay silent.')
    lines.push('- Digest behavior is model-owned, not a fixed watch policy. If items should be batched for a later summary, store a compact digestQueue/lastDigestAt in task_state and widen your minimum sleep so the next wake lands at the digest time.')
    lines.push('- Never perform source-side write actions unless the watch allowed action explicitly permits it AND the user already approved the exact rule/action boundary. Notify-only remains the default.')
    lines.push('- When a surfaced item leaves the user with an obvious decision, include notify_inbox `actions` with short quick-reply labels. Use actions for archive/keep, mark read/unread, approve/skip, reply/dismiss, summarize now/later, or review-first choices; do not make the user type the same command manually.')
    lines.push('- For triage/digest messages, especially Gmail or WhatsApp routine cleanup, include 2-4 actions when you mention candidates. Example labels: "Archive candidates", "Keep all", "Review first". Each action value must state the exact scope and tell the agent to skip ambiguous items.')
    lines.push('')
    if (detected.length > 0) {
        lines.push(...buildDetectedBlock(detected))
        lines.push('')
    }
    lines.push('Sleep policy (you control how soon the cheap pass may wake you again):')
    lines.push(`- The cheap poll itself is FIXED at ~5 minutes and is not yours to reschedule. Do NOT call reschedule_task for this task; it stays on its cheap cadence.`)
    lines.push(`- You control two knobs by writing them at the TOP LEVEL of task_state via set_task_state (milliseconds):`)
    lines.push(`  • minWakeGapMs — minimum sleep between wakes / debounce floor. Currently ~${minMinutes}m. Lower it (down to 5m) for clearly time-sensitive periods so changes reach you faster; raise it (30m, 1h, 2h+) during sustained quiet, low-signal hours, or known inactive windows. New matches keep buffering during the floor and arrive together at the next wake.`)
    lines.push(`  • maxWakeGapMs — safety ceiling. Currently ~${maxHours}h. You will be woken at least this often even with zero detected changes, to re-derive intent / flush digests / run due custom checks. Widen it during long quiet stretches, tighten it if you need guaranteed periodic housekeeping.`)
    lines.push('- Do NOT touch the reserved `_smartGate` field in task_state; the engine owns it (last wake time + buffered items). Changing it can drop pending notifications.')
    lines.push('- Quiet-hour preferences are context, not a hard gate. Use local time, task history, and urgency to decide whether to notify now, defer, or widen minWakeGapMs.')
    lines.push('- Always call set_task_state with the full updated small state: per-source watermarks/lastSeen ids, quietRuns/activeRuns, lastNotifiedAt, lastCheckedAt, digestQueue/lastDigestAt if useful, minWakeGapMs/maxWakeGapMs, and any useful time-of-day signal.')
    lines.push('')
    lines.push(...buildRuntimeTimeBlock(now, watches))
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
        lines.push(`Intent/check instruction: ${describeRule(w.rule)}`)
        lines.push(`Cadence hint: current=${w.cadence.current}s, min=${w.cadence.min}s, max=${w.cadence.max}s, adaptive=${w.cadence.adaptive}`)
        const allowed = w.allowedActions.length === 0
            ? 'notify_inbox only'
            : `notify_inbox plus: ${w.allowedActions.map(describeAction).join(', ')}`
        lines.push(`Allowed actions: ${allowed}`)
        if (w.notify.quietHours) {
            lines.push(`Quiet preference: ${w.notify.quietHours.from}-${w.notify.quietHours.to} ${w.notify.quietHours.timezone}`)
        }
        lines.push(`Per-watch counters: quietRuns=${w.state.quietRuns}, activeRuns=${w.state.activeRuns}, lastCheckedAt=${w.lastCheckedAt ? new Date(w.lastCheckedAt).toISOString() : 'never'}, lastFiredAt=${w.lastFiredAt ? new Date(w.lastFiredAt).toISOString() : 'never'}`)

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
    lines.push('Source strategy:')
    lines.push('- For each watch, inspect the smallest source scope that can satisfy its intent/check instruction.')
    lines.push('- Compare source identifiers, timestamps, values, or prior summaries with task_state before notifying so repeated steady state stays silent.')
    lines.push('- For custom watches, execute the prompt as recurring model-owned work, using MONITORS.md as the durable spec and task_state as the run ledger.')
    lines.push('- If a runtime watch exists but MONITORS.md lacks its durable spec, mention that as an internal audit gap in the run summary; do not notify unless the gap blocks user-visible behavior.')
    lines.push('')
    lines.push('Finish criteria:')
    lines.push('1. If nothing is noteworthy, do not call notify_inbox. Return a short internal summary only; it will stay in Past runs.')
    lines.push('2. If something matters, call notify_inbox with a specific email-style `title` plus one compact message per real issue. Group related source findings.')
    lines.push('3. If the notification asks for or implies a user decision, include notify_inbox.actions in the same tool call. Missing quick actions is a UX failure for digest/triage notifications.')
    lines.push('4. Persist set_task_state every wake, even when silent — include minWakeGapMs/maxWakeGapMs so your sleep preference sticks.')
    lines.push('5. Do NOT call reschedule_task for this task. Tune minWakeGapMs/maxWakeGapMs in task_state instead; the cheap 5-minute poll cadence is fixed and engine-owned.')

    return lines.join('\n')
}

function renderHistoryLine(ev: WatchEvent): string {
    const ts = new Date(ev.ts).toISOString()
    const payload = ev.payload ?? {}
    switch (ev.kind) {
        case 'wake':
            return `[${ts}] WAKE - ${typeof payload.matches === 'number' ? payload.matches : '?'} match(es) escalated`
        case 'notify':
            return `[${ts}] NOTIFY - "${typeof payload.summary === 'string' ? payload.summary : ''}"`
        case 'suppress': {
            const reason = typeof payload.reason === 'string' ? payload.reason
                : typeof payload.patternReason === 'string' ? `pattern: ${payload.patternReason}`
                    : 'pattern matched'
            const summary = typeof payload.summary === 'string' ? payload.summary : ''
            return `[${ts}] SUPPRESS (${reason}) - ${summary}`
        }
        case 'feedback': {
            const verdict = payload.was_worth_it === true ? 'worth-it' : payload.was_worth_it === false ? 'NOT worth-it' : 'unknown'
            const reason = typeof payload.reason === 'string' ? `: ${payload.reason}` : ''
            return `[${ts}] FEEDBACK (${verdict})${reason}`
        }
        case 'match':
            return `[${ts}] MATCH - "${typeof payload.summary === 'string' ? payload.summary : ''}"`
        case 'action':
            return `[${ts}] ACTION - ${typeof payload.kind === 'string' ? payload.kind : 'unknown'}`
        case 'error':
            return `[${ts}] ERROR - ${typeof payload.message === 'string' ? payload.message : ''}`
        case 'cadence_change':
            return `[${ts}] cadence ${payload.from}s -> ${payload.to}s`
        case 'check':
            return `[${ts}] check`
    }
}

function renderSuppressPattern(p: SuppressPattern): string {
    const expires = p.expiresAt ? ` (expires ${new Date(p.expiresAt).toISOString()})` : ''
    const hits = p.matchCount > 0 ? ` - hit ${p.matchCount} time(s)` : ''
    return `id=${p.id} "${p.reason}": ${describeRule(p.rule)}${hits}${expires}`
}
