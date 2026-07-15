// Smart Monitor - model-led wake context for recurring work whose check needs
// model judgement. Deterministic gates belong in Microscripts.

import { describeAction, describeRule } from '../monitor/describe'
import type { MonitorWatch, SuppressPattern, WatchEvent } from '../monitor/schema'
import { getMonitorWatch, listMonitorWatches, listWatchEvents } from '../monitor/store'
import { listTaskRuns, type TaskRunRecord } from '../scheduling/store'
import { getConfig } from '../config'
import { isValidTimezone } from '../timezone'

const SMART_MONITOR_SOURCE_CAPABILITIES: Record<string, readonly string[]> = {
    gmail: ['gmail'],
    google_calendar: ['google-calendar'],
    whatsapp: ['whatsapp'],
    home_assistant: ['home-assistant'],
    weather: ['weather'],
}

export function getSmartMonitorWakePreactivatedCapabilities(
    watches: readonly MonitorWatch[] = listMonitorWatches({ enabled: true }),
): string[] {
    const ids = new Set<string>()
    for (const watch of watches) {
        for (const id of SMART_MONITOR_SOURCE_CAPABILITIES[watch.source] ?? []) {
            ids.add(id)
        }
    }
    return Array.from(ids)
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

const DETECTED_DETAILS_TOTAL_BUDGET = 40_000
const DETECTED_DETAILS_PER_ITEM_BUDGET = 12_000

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
}

function stringField(record: Record<string, unknown> | null, key: string): string {
    const value = record?.[key]
    return typeof value === 'string' ? value : ''
}

function recordArray(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
        ? value.map(asRecord).filter((record): record is Record<string, unknown> => record !== null)
        : []
}

function clipBlock(text: string, maxChars: number): { text: string; truncated: boolean } {
    if (text.length <= maxChars) return { text, truncated: false }
    return { text: text.slice(0, Math.max(0, maxChars)), truncated: true }
}

function indentBlock(text: string, prefix: string): string[] {
    if (!text) return []
    return text.split('\n').map((line) => `${prefix}${line}`)
}

function renderGmailDetectedDetails(details: Record<string, unknown>, maxChars: number): string {
    const lines: string[] = []
    let used = 0

    function push(line = ''): boolean {
        const next = used + line.length + 1
        if (next > maxChars) return false
        lines.push(line)
        used = next
        return true
    }

    function pushBody(label: string, body: string, indent = '    '): boolean {
        const available = maxChars - used - label.length - 120
        if (available <= 0) return false
        const clipped = clipBlock(body.trim(), available)
        if (!push(label)) return false
        for (const line of indentBlock(clipped.text, indent)) {
            if (!push(line)) return false
        }
        if (clipped.truncated) push(`${indent}[truncated in wake prompt; call GmailReadThread for the rest]`)
        return true
    }

    const thread = asRecord(details.gmailContext) ?? asRecord(details.gmailThread)
    const rawMessages = recordArray(thread?.messages)
    const messageId = stringField(details, 'messageId')
    const target = rawMessages.find((message) => stringField(message, 'id') === messageId)
    const orderedMessages = target
        ? [target, ...rawMessages.filter((message) => message !== target)]
        : rawMessages
    const fallbackMessage = orderedMessages.length === 0 ? [details] : orderedMessages
    const threadTruncated = thread?.truncated === true

    push('details:')
    push('  gmail:')
    push(`    messageId: ${messageId || '(unknown)'}`)
    push(`    threadId: ${stringField(details, 'threadId') || '(unknown)'}`)
    push(`    from: ${stringField(details, 'from') || '(unknown)'}`)
    push(`    subject: ${stringField(details, 'subject') || '(no subject)'}`)
    if (stringField(details, 'date')) push(`    date: ${stringField(details, 'date')}`)
    if (stringField(details, 'snippet')) push(`    snippet: ${clipLine(stringField(details, 'snippet'), 500)}`)
    if (thread) {
        push(`    messageRead: included, scope=${thread.scope ?? 'matched_message'}, maxChars=${thread.maxChars ?? '?'}, truncated=${threadTruncated ? 'yes' : 'no'}`)
    }
    const readError = stringField(details, 'gmailMessageReadError') || stringField(details, 'gmailThreadReadError')
    if (readError) {
        push(`    messageReadError: ${clipLine(readError, 500)}`)
    }

    push('  gmail_message_context:')
    let renderedMessages = 0
    for (const message of fallbackMessage) {
        const id = stringField(message, 'id') || messageId || '(unknown)'
        const from = stringField(message, 'from') || '(unknown sender)'
        const subject = stringField(message, 'subject') || stringField(details, 'subject') || '(no subject)'
        const date = stringField(message, 'date')
        const source = stringField(message, 'bodySourceMimeType') || stringField(details, 'bodySourceMimeType') || 'none'
        const body = stringField(message, 'body') || stringField(details, 'body')
        if (!push(`    - id: ${id}${id === messageId ? ' (matched message)' : ''}`)) break
        push(`      from: ${from}`)
        push(`      subject: ${subject}`)
        if (date) push(`      date: ${date}`)
        if (stringField(message, 'snippet')) push(`      snippet: ${clipLine(stringField(message, 'snippet'), 500)}`)
        if (body) {
            const label = source === 'text/html'
                ? '      body (text/html converted to text, links preserved where possible):'
                : `      body (${source}):`
            if (!pushBody(label, body, '        ')) break
        } else {
            push(`      body: (empty or unavailable; call GmailReadThread if needed)`)
        }
        renderedMessages++
    }

    if (renderedMessages < rawMessages.length) {
        push(`    - ${rawMessages.length - renderedMessages} more Gmail context message(s) omitted by prompt budget; call GmailReadThread for full thread.`)
    }
    return lines.join('\n')
}

function renderDetectedDetails(change: DetectedChange, maxChars: number): string[] {
    if (!change.details || maxChars <= 200) return []
    const details = asRecord(change.details)
    if (!details) return []

    const rendered = change.source === 'gmail'
        ? renderGmailDetectedDetails(details, maxChars)
        : `details:\n${clipUnknownJson(details, Math.min(maxChars, 2_000))}`
    return indentBlock(rendered, '      ')
}

function renderTaskRunLine(run: TaskRunRecord): string {
    const out = run.error || run.summary || '(no output)'
    const timezone = getConfig().timezone
    return [
        `${formatLocalDateTime(run.startedAt, timezone)} ${timezone}`,
        `utc=${new Date(run.startedAt).toISOString()}`,
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
    const config = getConfig()
    const configured = config.timezone
    if (configured && isValidTimezone(configured)) zones.add(configured)
    const globalQuietTimezone = config.smartMonitor?.quietHours?.timezone
    if (globalQuietTimezone && isValidTimezone(globalQuietTimezone)) zones.add(globalQuietTimezone)
    for (const watch of watches) {
        const tz = watch.notify.quietHours?.timezone
        if (tz && isValidTimezone(tz)) zones.add(tz)
    }
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
    lines.push(`The cheap pass already detected these ${detected.length} new item(s) since the last wake. Anchor this wake on them — do not blindly re-scan every source; fetch more only when an item needs context to judge. Gmail items may include body text from a pre-wake matched-message read; HTML mail is converted to text with links preserved where possible. If a Gmail body says truncated/omitted, call GmailReadThread for that thread before deciding.`)
    const byWatch = new Map<string, DetectedChange[]>()
    for (const d of detected) {
        const arr = byWatch.get(d.watchId) ?? []
        arr.push(d)
        byWatch.set(d.watchId, arr)
    }
    let detailBudget = DETECTED_DETAILS_TOTAL_BUDGET
    for (const [, items] of byWatch) {
        const head = items[0]
        lines.push(`- ${head.watchTitle} (${head.source}, ${items.length} item${items.length === 1 ? '' : 's'}):`)
        for (const it of items.slice(0, 12)) {
            lines.push(`    • ${clipLine(it.summary, 240)}`)
            if (it.details && detailBudget > 0) {
                const detailLines = renderDetectedDetails(it, Math.min(DETECTED_DETAILS_PER_ITEM_BUDGET, detailBudget))
                if (detailLines.length > 0) {
                    lines.push(...detailLines)
                    detailBudget -= detailLines.join('\n').length
                }
            } else if (it.details) {
                lines.push('      details omitted by prompt budget; use the source read tool if the summary is insufficient.')
            }
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
    // A completed follow-up watch is already disabled by the engine, but the
    // wake still needs its record (id, expectation, deadline) to judge the
    // buffered item and call monitor_wake_feedback on it — pull in any watch a
    // detected item references that the enabled list no longer contains.
    const listed = new Set(watches.map((w) => w.id))
    for (const d of detected) {
        if (listed.has(d.watchId)) continue
        const w = getMonitorWatch(d.watchId)
        if (w) {
            watches.push(w)
            listed.add(w.id)
        }
    }
    const hasFollowUps = watches.some((w) => w.followUp)
    const preactivated = getSmartMonitorWakePreactivatedCapabilities(watches)
    const lines: string[] = []
    const minMinutes = gate ? Math.round(gate.minWakeGapMs / 60_000) : 15
    const maxHours = gate ? Math.max(1, Math.round(gate.maxWakeGapMs / 3_600_000)) : 6

    lines.push('Role: Run one Smart Monitor wake for the consolidated recurring-monitoring agent.')
    lines.push('Goal: Judge the buffered changes and due model-owned checks, perform only authorized monitor actions, update compact state, and interrupt the user only when the watch intent and current evidence justify it.')
    if (wakeReason === 'ceiling') {
        lines.push(`You are awake because the safety ceiling (~${maxHours}h with no detected change) elapsed, not because the cheap pass found something. Re-derive intent, run any due model-owned (custom) checks, flush a digest if one is pending, and otherwise stay silent.`)
    } else {
        lines.push('You are awake because a cheap, no-model pass detected new items (listed under <detected_changes>) and your minimum sleep elapsed. Judge those items, decide what matters, notify sparingly, and update task state.')
    }
    lines.push('')
    lines.push('Success criteria: every detected item is judged once; required context is read without a blind source re-scan; notification/silence follows the watch intent; follow-ups receive feedback; state preserves watermarks and gate values; no unauthorized source write occurs.')
    lines.push('Stop when those criteria are met. Do not re-check unchanged sources or notify merely to prove the wake ran.')
    lines.push('')
    lines.push('Operating model:')
    lines.push('- A cheap, code-only pass runs every ~5 minutes and watermarks each connector source. It does NOT wake you on its own; it only buffers genuinely-new, rule-matching items and wakes you once the buffer is non-empty AND your minimum sleep has elapsed (or the safety ceiling is hit). When nothing changes, you stay asleep — that is intended.')
    lines.push('- There is one consolidated Smart Monitor agent for recurring monitoring, recurring summaries, and recurring model-owned maintenance. Do not create separate scheduled tasks or extra agents for urgent/digest/noise tiers.')
    lines.push('- Smart Monitor must have exactly one Scheduling runtime entry: this consolidated Smart monitor heartbeat. Do not create separate scheduled tasks for Smart Monitor digests, summaries, maintenance, source-specific wakeups, retries, or catch-up runs.')
    lines.push('- Store durable recurring requirements as Smart Monitor watch specs in MONITORS.md, and store execution bookkeeping in this Smart Monitor task_state. On every heartbeat, use current runtime time to perform overdue still-useful work that has not already been completed, skipped, or deduplicated for the relevant period.')
    lines.push('- Promote durable monitoring learnings into MONITORS.md the same way chat memory is promoted into MEMORY.md: when you notice a recurring noise source to keep quiet, a recurring signal that genuinely matters, or a learned notify/quiet preference, record it compactly in MONITORS.md (via the Write/Edit file tools) so future wakes and the nightly memory reflection build on it instead of re-learning it. Keep those notes curated — correct or remove ones that no longer hold. This is durable preference memory; per-run bookkeeping (watermarks, counters, digestQueue) still belongs in task_state, and noise you want the cheap pass to drop without waking you still goes through monitor_wake_feedback as a suppress pattern.')
    lines.push('- Beyond deciding what to notify, harvest non-secret knowledge from what you observe. When messages or changes reveal useful facts about the user\'s world — people/roles, commitments/dates, recurring contexts, orders/trips, preferences — keep the full useful signal in today\'s raw MEMORY_DAY ledger even when it is not worth interrupting the user. Encode it as one dense evidence capsule per related set of observations: source/time, fact or inference, concrete names/values/dates, confidence, consequence/open loop. Do not duplicate the wake narrative, connector readback, unchanged checks, or task-state bookkeeping already stored in runtime history. Never store secrets (codes, tokens, card numbers). Prompt construction compresses recent daily entries separately and semantic recall keeps the raw note reachable, so density improves context without requiring selective forgetting. The nightly Memory reflection promotes recurring or durable conclusions into USER.md/MEMORY.md/MONITORS.md.')
    lines.push('- Watch records below are recurring-work boundaries and user-intent hints. Connector rules are fetch hints; custom rules are model-owned check prompts. They are not preset notification rules and not proof that the user should be interrupted.')
    lines.push('- Do not invent canned urgent keyword lists. Extract the user intent from the watch title/target/rule, the durable memory already in your prompt, and your task state. If the intent is too vague, stay conservative and mention the missing capability in your normal output without notifying unless there is a real issue.')
    lines.push(`- Matching source capabilities are pre-activated for this wake when they have enabled watches: ${preactivated.join(', ')}. Their connected/read tools should already be visible; activate only additional capabilities that a custom watch genuinely needs.`)
    lines.push('- Use only the tools needed by each watch. For connector watches, read the matching source directly when its tools are already visible; if a needed capability is not visible, activate that exact integration before reading. For custom watches, follow the custom_prompt with the available workspace, memory, runtime-history, and integration tools that fit that instruction.')
    lines.push('- If a watch needs current public-web research, do not try to combine native web search with this wake\'s action tools. Use delegate_to with the Researcher for a compact search-only subtask, then use the returned facts in this wake to decide notify_inbox, monitor_wake_feedback, and set_task_state.')
    lines.push('- Notify Inbox only for things that are important, time-sensitive, personally directed, account/security/payment related, deadline/travel/order affecting, operationally relevant, or clearly actionable under the watch intent.')
    lines.push('- For non-urgent accumulated items, summarize only when the watch/user preference calls for it or the volume is meaningfully high. Otherwise stay silent.')
    lines.push('- Digest behavior is model-owned, not a fixed watch policy. If items should be batched for a later summary, store a compact digestQueue/lastDigestAt in task_state and widen your minimum sleep so the next wake lands at the digest time.')
    lines.push('- Never perform source-side write actions unless the watch allowed action explicitly permits it AND the user already approved the exact rule/action boundary. Notify-only remains the default.')
    lines.push('- When a surfaced item leaves the user with an obvious decision, include notify_inbox `actions` with short quick-reply labels. Use actions for archive/keep, mark read/unread, approve/skip, reply/dismiss, summarize now/later, or review-first choices; do not make the user type the same command manually.')
    lines.push('- For triage/digest messages, especially Gmail or WhatsApp routine cleanup, include 2-4 actions when you mention candidates. Example labels: "Archive candidates", "Keep all", "Review first". Each action value must state the exact scope and tell the agent to skip ambiguous items.')
    lines.push('- Be proactive, not only reactive: a matched-item alert is the floor, not the ceiling. When what you observe adds up to a concrete, actionable suggestion the user would plausibly want — an emerging pattern, an inferred upcoming date/obligation, an opportunity, a recurring annoyance you could remove — surface it as a PROPOSAL via notify_inbox: state the observation, then a specific offer ("I noticed X — want me to Y?", phrased in the user\'s language), with 2-4 quick-reply actions covering the obvious responses (do it / not now / never). Require a real action behind the offer: a vague observation with nothing to act on stays in today\'s MEMORY_DAY working memory, not the Inbox. Proposals obey the same interrupt bar and the same engagement/suppress learning loop as alerts — if engagement shows the user dismisses a shape of proposal, suppress it via monitor_wake_feedback; if they act on it, that shape earns more proactivity.')
    lines.push('- When the useful move is later, not now (a future-dated obligation like "order in 3 days" or "a review lands in 5 days", or something to revisit once a condition likely changes), make it actually return instead of parking it in a passive note that gets forgotten. For a discrete future obligation, back it with a real trigger: call ActivateIntegrationTools("scheduling") first (the scheduling subsystem is NOT pre-activated on wakes), then schedule_task with an agent action at the right time, carrying the context the future run will need. To merely revisit inside this same monitor loop, store the target time in task_state and widen minWakeGapMs so the next wake lands then. These are first-class user reminders — distinct from, and not a license to create, the Smart-Monitor infrastructure tasks the one-heartbeat rule forbids (digests, retries, source wakeups, catch-up).')
    if (hasFollowUps) {
        lines.push('- FOLLOW-UP watches (marked below) are closed-loop verifiers for an outward action: they wait for an expected effect until a deadline. When one resolved (its detected item says so), verify the matched item really IS the expected effect: if yes, notify the user briefly that the loop closed (e.g. "Dan replied to the offer") and call monitor_wake_feedback with follow_up_outcome="confirmed"; if the match was something else (your own message, unrelated mail), call monitor_wake_feedback with follow_up_outcome="not_yet" (optionally extend_deadline_days) to re-arm it and stay silent. When a follow-up DEADLINE PASSED item appears, escalate via notify_inbox: say what was expected, that it did not happen, and offer next steps (nudge/resend, wait longer, drop it) as quick actions. Confirmed/expired follow-up watches are auto-removed after this wake — do not recreate or manually clean them.')
    }
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
        if (w.followUp) {
            const status = w.followUp.resolvedAt
                ? `RESOLVED at ${new Date(w.followUp.resolvedAt).toISOString()} — verify the match, then follow_up_outcome confirmed/not_yet`
                : w.followUp.deadlineFiredAt
                    ? `DEADLINE PASSED at ${new Date(w.followUp.deadlineFiredAt).toISOString()} with no observed effect — escalate per the follow-up protocol`
                    : `waiting (deadline ${new Date(w.followUp.deadlineAt).toISOString()})`
            lines.push(`FOLLOW-UP watch: expecting "${w.followUp.expectation}". Status: ${status}.`)
        }
        lines.push(`Cadence hint: current=${w.cadence.current}s, min=${w.cadence.min}s, max=${w.cadence.max}s, adaptive=${w.cadence.adaptive}`)
        const allowed = w.allowedActions.length === 0
            ? 'notify_inbox only'
            : `notify_inbox plus: ${w.allowedActions.map(describeAction).join(', ')}`
        lines.push(`Allowed actions: ${allowed}`)
        if (w.notify.quietHours) {
            lines.push(`Quiet preference: ${w.notify.quietHours.from}-${w.notify.quietHours.to} ${w.notify.quietHours.timezone}`)
        }
        lines.push(`Per-watch counters: quietRuns=${w.state.quietRuns}, activeRuns=${w.state.activeRuns}, lastCheckedAt=${w.lastCheckedAt ? new Date(w.lastCheckedAt).toISOString() : 'never'}, lastFiredAt=${w.lastFiredAt ? new Date(w.lastFiredAt).toISOString() : 'never'}`)

        const engagement = renderEngagementLine(w.id)
        if (engagement) lines.push(engagement)

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
    lines.push('6. Proactivity counts as "something that matters": when observations yield a concrete, actionable suggestion, surface it as a proposal (observation + offer + quick actions); and when the right action is later, back it with a real trigger (activate scheduling, then schedule_task, or a widened wake) — never a passive note alone.')

    return lines.join('\n')
}

/** Aggregate the user's behavior on this watch's Inbox notifications into one
 *  compact line. Raw `user_signal` events are recorded by the Inbox surface
 *  (opened / replied / dismissed read|unread / quick actions); the wake and the
 *  nightly reflection read this aggregate to learn what to keep quiet — the
 *  interpretation is entirely model-owned, no thresholds live in code. */
function renderEngagementLine(watchId: string, limit = 40): string | null {
    const signals = listWatchEvents(watchId, { limit, kinds: ['user_signal'] })
    if (signals.length === 0) return null
    const counts = new Map<string, number>()
    for (const ev of signals) {
        const raw = ev.payload?.signal
        const tool = ev.payload?.tool
        const key = typeof raw === 'string'
            ? (raw === 'quick_action' && typeof tool === 'string' ? `quick_action:${tool}` : raw)
            : 'unknown'
        counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const parts = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, n]) => `${key.replace(/_/g, ' ')} ${n}`)
    return `User engagement with this watch's notifications (last ${signals.length} signal(s)): ${parts.join(', ')}. Repeated "dismissed unread" for a recognizable shape means those notifications are noise to this user — author a suppress pattern via monitor_wake_feedback (prefer expires_in_days while confidence builds) or stop surfacing that shape; repeated opens/replies mean the shape matters.`
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
        case 'followup':
            return `[${ts}] FOLLOW-UP ${typeof payload.outcome === 'string' ? payload.outcome : 'transition'} - "${typeof payload.expectation === 'string' ? payload.expectation : ''}"`
        case 'user_signal':
            return `[${ts}] USER ${typeof payload.signal === 'string' ? payload.signal : 'signal'}${typeof payload.tool === 'string' ? ` (${payload.tool})` : ''}`
        case 'check':
            return `[${ts}] check`
    }
}

function renderSuppressPattern(p: SuppressPattern): string {
    const expires = p.expiresAt ? ` (expires ${new Date(p.expiresAt).toISOString()})` : ''
    const hits = p.matchCount > 0 ? ` - hit ${p.matchCount} time(s)` : ''
    return `id=${p.id} "${p.reason}": ${describeRule(p.rule)}${hits}${expires}`
}
