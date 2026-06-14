import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'

// ---------------------------------------------------------------------------
// Smart Monitor management tools (Step 5).
//
// These are the tools the orchestrator uses IN A USER CONVERSATION to set up,
// adjust, and inspect Smart Monitor watches. Wakes (Step 4) must NOT call
// these lifecycle tools; they may use notify_inbox, monitor_wake_feedback, and
// source connector tools warmed up from enabled watch sources. Watch lifecycle
// remains a deliberate conversation.
//
// Six tools in one file because they share validators and adapters:
//   - monitor_describe_sources : capability snapshot (sources, predicate
//                                 kinds, action kinds). Read-only.
//   - monitor_watch_list       : compact list of every watch with status.
//   - monitor_watch_get        : full detail of one watch, incl. state.
//   - monitor_watch_add        : create a new watch (rule/prompt + cadence + notify).
//   - monitor_watch_update     : partial patch of an existing watch.
//   - monitor_watch_remove     : delete a watch by id.
//
// Cadence values are accepted as seconds (number) OR as a duration string
// for the model's ergonomics — same form used by schedule_task. These fields
// describe desired per-watch pacing; the active
// Smart Monitor wake is still one consolidated scheduled agent task.
// ---------------------------------------------------------------------------

// --- duration parsing ------------------------------------------------------

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/i
const SECONDS_PER_UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

function parseDurationSeconds(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null
    if (typeof value !== 'string') return null
    const m = DURATION_RE.exec(value)
    if (!m) {
        // Allow bare numeric strings ("900").
        const n = Number(value)
        return Number.isFinite(n) && n > 0 ? Math.round(n) : null
    }
    return Math.round(Number(m[1]) * SECONDS_PER_UNIT[m[2].toLowerCase()])
}

function normalizeCadenceInput(raw: unknown): Record<string, unknown> | undefined {
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const input = raw as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of ['current', 'min', 'max'] as const) {
        if (input[key] !== undefined) {
            const secs = parseDurationSeconds(input[key])
            if (secs === null) {
                throw new Error(`cadence.${key} must be a positive number of seconds or a duration string.`)
            }
            out[key] = secs
        }
    }
    if (input.adaptive !== undefined) {
        if (typeof input.adaptive !== 'boolean') {
            throw new Error('cadence.adaptive must be boolean.')
        }
        out.adaptive = input.adaptive
    }
    return out
}

function normalizeNotifyInput(raw: unknown): Record<string, unknown> | undefined {
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const input = raw as Record<string, unknown>
    const out: Record<string, unknown> = {}
    if (input.onMatch !== undefined) {
        if (typeof input.onMatch !== 'boolean') throw new Error('notify.onMatch must be boolean.')
        out.onMatch = input.onMatch
    }
    return Object.keys(out).length > 0 ? out : undefined
}

// ---------------------------------------------------------------------------
// monitor_describe_sources
// ---------------------------------------------------------------------------

export const monitorDescribeSourcesTool: ToolDef = {
    id: 'monitor_describe_sources',
    name: 'monitor_describe_sources',
    description: [
        'List every Smart Monitor source and its capabilities: which MonitorRule predicate kinds or model-owned instruction kinds it supports, and which MonitorAction kinds the user may grant for watches on that source.',
        'Call this BEFORE proposing a watch to the user so you propose only predicates / actions the source actually understands. The any_of/all_of composition is allowed for every source. Use custom/custom_prompt for recurring checks described by instructions instead of a connector predicate.',
        'Read-only; safe to call as often as needed.',
    ].join(' '),
    input_schema: { type: 'object', properties: {} },
    tags: ['monitoring'],
}

export async function executeMonitorDescribeSources(): Promise<ToolResult> {
    const { listSourceCapabilities } = await import('@/lib/monitor/sources')
    const { MIN_CADENCE_SECONDS, MAX_CADENCE_SECONDS, DEFAULT_CADENCE_SECONDS } =
        await import('@/lib/monitor/schema')
    const sources = listSourceCapabilities().map((c) => ({
        source: c.source,
        supported_rule_kinds: [...c.supportedRuleKinds, 'any_of', 'all_of'],
        supported_action_kinds: c.supportedActionKinds,
    }))
    return {
        success: true,
        data: {
            sources,
            cadence_bounds_seconds: {
                min: MIN_CADENCE_SECONDS,
                max: MAX_CADENCE_SECONDS,
                default: DEFAULT_CADENCE_SECONDS,
            },
            notes: [
                'Create broad watches that express the user intent, candidate scope, and recurring check instructions. Connector predicates are fetch hints; custom_prompt is the direct model-owned check instruction.',
                'For recurring work, record cadence and check instructions in the watch and document the durable preference/spec in MONITORS.md. Do not create a separate recurring scheduled task for the same ongoing monitor.',
                'Cadence fields on watches describe desired pacing. The active Smart Monitor agent wake starts from the consolidated heartbeat and may self-pace by rescheduling the single Smart Monitor scheduled task.',
                'notify_inbox is implicitly allowed on every watch; everything else needs explicit user consent in allowedActions.',
                'Digest/quiet timing is model-owned at wake time via task_state and reschedule_task, not stored as fixed watch policy.',
                'For the actual rule/action object schemas see lib/monitor/schema.ts on the project.',
            ],
        },
    }
}

// ---------------------------------------------------------------------------
// Shared compact-row renderer for list/get
// ---------------------------------------------------------------------------

async function compactWatchRow(watchId: string): Promise<Record<string, unknown> | null> {
    const { getMonitorWatch } = await import('@/lib/monitor/store')
    const { describeRule, describeAction } = await import('@/lib/monitor/describe')
    const w = getMonitorWatch(watchId)
    if (!w) return null
    return {
        id: w.id,
        title: w.title,
        source: w.source,
        target: w.target,
        rule: describeRule(w.rule),
        enabled: w.enabled,
        follow_up: w.followUp
            ? {
                expectation: w.followUp.expectation,
                deadline_at: new Date(w.followUp.deadlineAt).toISOString(),
                on_deadline: w.followUp.onDeadline,
                status: w.followUp.resolvedAt
                    ? 'resolved'
                    : w.followUp.deadlineFiredAt
                        ? 'deadline_passed'
                        : 'waiting',
            }
            : null,
        cadence_seconds: w.cadence.current,
        cadence_adaptive: w.cadence.adaptive,
        allowed_actions: w.allowedActions.map(describeAction),
        next_check_at: w.nextCheckAt ? new Date(w.nextCheckAt).toISOString() : null,
        last_checked_at: w.lastCheckedAt ? new Date(w.lastCheckedAt).toISOString() : null,
        last_fired_at: w.lastFiredAt ? new Date(w.lastFiredAt).toISOString() : null,
        consecutive_errors: w.consecutiveErrors,
        last_error: w.lastError,
        suppress_pattern_count: w.suppressPatterns.length,
        active_runs: w.state.activeRuns,
        quiet_runs: w.state.quietRuns,
    }
}

async function syncHeartbeatBestEffort(): Promise<void> {
    try {
        const { syncSmartMonitorActivation } = await import('@/lib/monitoring/smart-monitor-adapter')
        await syncSmartMonitorActivation()
    } catch {
        // Management tools should still return the watch mutation result; the
        // status endpoint and boot hook also reconcile the system wake task.
    }
}

// ---------------------------------------------------------------------------
// monitor_watch_list
// ---------------------------------------------------------------------------

export const monitorWatchListTool: ToolDef = {
    id: 'monitor_watch_list',
    name: 'monitor_watch_list',
    description: [
        'List Smart Monitor watches with status. Optional source / enabled filters.',
        'Returns a compact view (id, title, source, target, rule description, cadence, last check, last fired, suppress pattern count). Call monitor_watch_get for full detail incl. state and suppress patterns.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            source: { type: 'string', description: 'Optional filter: gmail / google_calendar / whatsapp / home_assistant / web / weather / custom.' },
            enabled: { type: 'boolean', description: 'Optional filter on enabled state.' },
        },
    },
    tags: ['monitoring'],
}

export async function executeMonitorWatchList(args: Record<string, unknown>): Promise<ToolResult> {
    const filter: { source?: string; enabled?: boolean } = {}
    if (typeof args.source === 'string' && args.source.trim()) filter.source = args.source.trim()
    if (typeof args.enabled === 'boolean') filter.enabled = args.enabled

    const { listMonitorWatches } = await import('@/lib/monitor/store')
    const { WatchSourceSchema } = await import('@/lib/monitor/schema')
    if (filter.source !== undefined) {
        const parsed = WatchSourceSchema.safeParse(filter.source)
        if (!parsed.success) return { success: false, error: `Unknown source "${filter.source}". Call monitor_describe_sources to list valid values.` }
    }

    const watches = listMonitorWatches({
        source: filter.source as Parameters<typeof listMonitorWatches>[0] extends infer T
            ? T extends { source?: infer S } ? S : never : never,
        enabled: filter.enabled,
    })

    const rows = await Promise.all(watches.map((w) => compactWatchRow(w.id)))
    return {
        success: true,
        data: {
            count: rows.filter((r) => r !== null).length,
            watches: rows.filter((r): r is Record<string, unknown> => r !== null),
        },
    }
}

// ---------------------------------------------------------------------------
// monitor_watch_get
// ---------------------------------------------------------------------------

export const monitorWatchGetTool: ToolDef = {
    id: 'monitor_watch_get',
    name: 'monitor_watch_get',
    description: 'Full detail of one Smart Monitor watch by id: rule object, allowed actions, cadence policy, notify policy, suppress patterns with hit counts, private state, and recent audit events.',
    input_schema: {
        type: 'object',
        properties: {
            watch_id: { type: 'string', description: 'The watch id (mw_…) — the value returned as `id` by monitor_watch_list / monitor_watch_get. Pass it as `watch_id`, not `id`.' },
            event_limit: { type: 'number', description: 'How many recent audit events to include (default 20, max 100).' },
        },
        required: ['watch_id'],
    },
    tags: ['monitoring'],
}

export async function executeMonitorWatchGet(args: Record<string, unknown>): Promise<ToolResult> {
    const id = typeof args.watch_id === 'string' ? args.watch_id.trim() : ''
    if (!id) return { success: false, error: 'watch_id is required.' }
    const eventLimit = Math.max(1, Math.min(100, Math.floor(Number(args.event_limit) || 20)))

    const { getMonitorWatch, listWatchEvents } = await import('@/lib/monitor/store')
    const { describeRule, describeAction } = await import('@/lib/monitor/describe')
    const w = getMonitorWatch(id)
    if (!w) return { success: false, error: `No watch with id ${id}.` }

    const events = listWatchEvents(id, { limit: eventLimit })

    return {
        success: true,
        data: {
            id: w.id,
            title: w.title,
            source: w.source,
            target: w.target,
            enabled: w.enabled,
            rule: w.rule,
            rule_description: describeRule(w.rule),
            allowed_actions: w.allowedActions.map((a) => ({ raw: a, description: describeAction(a) })),
            cadence: w.cadence,
            notify: w.notify,
            state: w.state,
            suppress_patterns: w.suppressPatterns.map((p) => ({
                id: p.id,
                reason: p.reason,
                rule: p.rule,
                rule_description: describeRule(p.rule),
                created_at: new Date(p.createdAt).toISOString(),
                expires_at: p.expiresAt ? new Date(p.expiresAt).toISOString() : null,
                match_count: p.matchCount,
                last_matched_at: p.lastMatchedAt ? new Date(p.lastMatchedAt).toISOString() : null,
            })),
            next_check_at: w.nextCheckAt ? new Date(w.nextCheckAt).toISOString() : null,
            last_checked_at: w.lastCheckedAt ? new Date(w.lastCheckedAt).toISOString() : null,
            last_fired_at: w.lastFiredAt ? new Date(w.lastFiredAt).toISOString() : null,
            consecutive_errors: w.consecutiveErrors,
            last_error: w.lastError,
            created_by: w.createdBy,
            created_at: new Date(w.createdAt).toISOString(),
            updated_at: new Date(w.updatedAt).toISOString(),
            recent_events: events.map((e) => ({
                ts: new Date(e.ts).toISOString(),
                kind: e.kind,
                payload: e.payload,
            })),
        },
    }
}

// ---------------------------------------------------------------------------
// monitor_watch_add
// ---------------------------------------------------------------------------

export const monitorWatchAddTool: ToolDef = {
    id: 'monitor_watch_add',
    name: 'monitor_watch_add',
    description: [
        'Create a Smart Monitor watch.',
        'Use this for ongoing recurring monitoring, recurring summaries, and model-owned recurring maintenance. Extract the main user intent and translate it either to a source predicate or to a custom_prompt instruction; call monitor_describe_sources first if unsure of supported predicates.',
        'Do not create canned preset rules or fixed keyword tiers. Use source predicates as broad candidate hints, and let the Smart Monitor wake decide what deserves notification, silence, digesting, or a cadence change.',
        'Confirm only the source/scope, what the user cares about, desired cadence/check timing, and any non-notify actions they explicitly authorize. Digest timing and quiet/active windows are decided by the Smart Monitor agent at wake time using task_state.',
        'For connector integrations, use at most one watch per source by default. If a watch already exists for that integration, update it instead of adding another unless the user wants separate behavior. Custom model-owned watches may be separate when they represent distinct recurring instructions.',
        'EXCEPTION — closed-loop follow-ups: pass `follow_up` to create a short-lived one-shot watch that verifies the EFFECT of an outward action you just performed (a sent email, a created event, a WhatsApp message). Follow-up watches are exempt from the one-per-source rule, auto-disable on the first match (effect observed) or at the deadline (escalated to the Inbox unless on_deadline="silent"), and are auto-removed after the wake that handles them — no manual cleanup. Scope the rule tightly to the expected effect (e.g. gmail_from on the counterparty, optionally composed with gmail_subject_contains on the subject stem; wa_from on the chat). Do NOT use follow_up for ongoing monitoring.',
        'After creating or updating a watch, document the durable spec in MONITORS.md: watchId, status, cadence, source/scope, check prompt, notify rule, and silence rule. Follow-up watches are transient — skip MONITORS.md for them.',
        'Watches start ENABLED unless the user explicitly asks to pause. The single Smart Monitor scheduled agent task defaults to the consolidated heartbeat and self-paces with reschedule_task.',
        'Returns the new watch id. The Smart Monitor agent-wake system task auto-arms on first enabled watch.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            title: { type: 'string', description: 'Short human-readable label shown in /monitor and the wake brief.' },
            source: { type: 'string', description: 'One of: gmail, google_calendar, whatsapp, home_assistant, web, weather, custom. Use custom for model-owned recurring instructions.' },
            target: { type: 'string', description: 'Human-readable scope of the thing being watched. Format is source-specific; for custom, describe the recurring responsibility.' },
            rule: { type: 'object', description: 'Structured MonitorRule: an object with a `kind` plus kind-specific fields. Field names are exact — e.g. gmail: {kind:"gmail_query", q:"in:inbox is:unread -in:spam"} (the field is `q`, NOT `query`); whatsapp: {kind:"wa_unread"}; calendar: {kind:"calendar_event_needs_response"}; custom: {kind:"custom_prompt", prompt:"…"}. Predicate kinds must match the source; use any_of / all_of for composition. Call monitor_describe_sources for the supported kinds per source.' },
            allowed_actions: { type: 'array', description: 'MonitorAction objects the model may execute when matches survive. Each entry is an OBJECT, not a string — e.g. {kind:"gmail_archive"} or {kind:"gmail_label_add", label:"…"}. Do NOT include notify_inbox (it is always implicitly allowed). Everything else requires explicit user consent and must be valid for the watch source (gmail: gmail_archive, gmail_mark_read, gmail_label_add, gmail_send; home_assistant: ha_call_service; whatsapp: wa_send_reply). gmail_send is the standing authorization to auto send/forward email — {kind:"gmail_send", mode:"forward"|"send", recipients:["addr"|"@domain"], template:"…", senderScope?:["…"], includeAttachments?:bool}; grant it only when the user explicitly asks for autonomous sending/forwarding and confirms the recipients.' },
            cadence: {
                type: 'object',
                description: 'Cadence policy. Accepts {current, min, max} as numbers (seconds) OR duration strings, plus {adaptive: bool}.',
                properties: {
                    current: { type: 'string', description: 'Default cadence as seconds or a duration string. Defaults to 900s.' },
                    min: { type: 'string', description: 'Lower bound for adaptive widening. Defaults to 900s.' },
                    max: { type: 'string', description: 'Upper bound for adaptive widening. Defaults to 43200s (12h).' },
                    adaptive: { type: 'boolean', description: 'Whether the engine may widen on quiet runs / tighten on activity. Defaults to true.' },
                },
            },
            notify: {
                type: 'object',
                description: 'Legacy notify metadata. Usually omit. Only onMatch is accepted; digest/quiet timing belongs in the agent task state.',
                properties: {
                    onMatch: { type: 'boolean', description: 'Legacy flag; defaults true. The agent still decides whether to notify at wake time.' },
                },
            },
            follow_up: {
                type: 'object',
                description: 'Optional closed-loop lifecycle: makes this a one-shot follow-up watch verifying the effect of an outward action. Auto-disables on first match or at the deadline; auto-removed after the wake that handles it.',
                properties: {
                    expectation: { type: 'string', description: 'The expected effect in plain language, e.g. "a reply from dan@x.com on the Q3 offer thread". Shown in the wake brief and any escalation.' },
                    deadline: { type: 'string', description: 'When the effect should have happened: a duration from now ("2d", "36h", "45m") or an ISO datetime. If it passes with no match, the wake escalates to the Inbox (unless on_deadline="silent").' },
                    on_deadline: { type: 'string', enum: ['escalate', 'silent'], description: 'Default "escalate": surface "no effect happened by the deadline" to the user. Use "silent" only when the user explicitly does not want to hear about the no-reply case.' },
                },
                required: ['expectation', 'deadline'],
            },
            enabled: { type: 'boolean', description: 'Start enabled? Default true.' },
        },
        required: ['title', 'source', 'target', 'rule'],
    },
    tags: ['monitoring'],
}

/** Parse follow_up tool input → WatchFollowUp create shape. Deadline accepts a
 *  duration from now ("2d", "36h") or an ISO datetime; must land in the future
 *  within a sane horizon. */
function normalizeFollowUpInput(raw: unknown, now: number):
    | { expectation: string; deadlineAt: number; onDeadline: 'escalate' | 'silent' }
    | undefined {
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('follow_up must be an object.')
    const input = raw as Record<string, unknown>
    const expectation = typeof input.expectation === 'string' ? input.expectation.trim() : ''
    if (!expectation) throw new Error('follow_up.expectation is required.')
    if (expectation.length > 500) throw new Error('follow_up.expectation must be ≤500 characters.')

    const deadlineRaw = input.deadline
    let deadlineAt: number | null = null
    if (typeof deadlineRaw === 'string' && DURATION_RE.test(deadlineRaw)) {
        deadlineAt = now + (parseDurationSeconds(deadlineRaw) ?? 0) * 1000
    } else if (typeof deadlineRaw === 'string' && deadlineRaw.trim()) {
        const parsed = Date.parse(deadlineRaw)
        deadlineAt = Number.isFinite(parsed) ? parsed : null
    } else if (typeof deadlineRaw === 'number' && Number.isFinite(deadlineRaw)) {
        deadlineAt = Math.round(deadlineRaw)
    }
    if (deadlineAt === null) throw new Error('follow_up.deadline must be a duration ("2d", "36h") or an ISO datetime.')
    if (deadlineAt <= now) throw new Error('follow_up.deadline must be in the future.')
    const MAX_HORIZON_MS = 180 * 86_400_000
    if (deadlineAt > now + MAX_HORIZON_MS) throw new Error('follow_up.deadline must be within 180 days.')

    const onDeadline = input.on_deadline === 'silent' ? 'silent' as const : 'escalate' as const
    if (input.on_deadline !== undefined && input.on_deadline !== 'escalate' && input.on_deadline !== 'silent') {
        throw new Error('follow_up.on_deadline must be "escalate" or "silent".')
    }
    return { expectation, deadlineAt, onDeadline }
}

export async function executeMonitorWatchAdd(args: Record<string, unknown>): Promise<ToolResult> {
    const title = typeof args.title === 'string' ? args.title.trim() : ''
    if (!title) return { success: false, error: 'title is required.' }
    const source = typeof args.source === 'string' ? args.source.trim() : ''
    if (!source) return { success: false, error: 'source is required.' }
    const target = typeof args.target === 'string' ? args.target.trim() : ''
    if (!target) return { success: false, error: 'target is required.' }
    if (!args.rule || typeof args.rule !== 'object' || Array.isArray(args.rule)) {
        return { success: false, error: 'rule is required and must be a MonitorRule object.' }
    }

    const {
        MonitorRuleSchema,
        MonitorActionSchema,
        WatchSourceSchema,
        NotifyPolicySchema,
    } = await import('@/lib/monitor/schema')

    const sourceParsed = WatchSourceSchema.safeParse(source)
    if (!sourceParsed.success) return { success: false, error: `Unknown source "${source}". Call monitor_describe_sources for the list.` }

    const ruleParsed = MonitorRuleSchema.safeParse(args.rule)
    if (!ruleParsed.success) return { success: false, error: `rule is invalid: ${ruleParsed.error.message}` }

    const allowedActions: Array<Record<string, unknown>> = []
    if (Array.isArray(args.allowed_actions) && args.allowed_actions.length > 0) {
        const { actionKindAllowedForSource } = await import('@/lib/monitor/sources')
        for (const raw of args.allowed_actions) {
            const parsed = MonitorActionSchema.safeParse(raw)
            if (!parsed.success) return { success: false, error: `allowed_actions contains invalid entry: ${parsed.error.message}` }
            if (!actionKindAllowedForSource(parsed.data.kind, sourceParsed.data)) {
                return { success: false, error: `allowed_actions contains "${parsed.data.kind}", which source "${sourceParsed.data}" does not support. Call monitor_describe_sources for the action kinds valid on this source.` }
            }
            allowedActions.push(parsed.data as unknown as Record<string, unknown>)
        }
    }

    let cadence: Record<string, unknown> | undefined
    try {
        cadence = normalizeCadenceInput(args.cadence)
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Invalid cadence.' }
    }

    let notify: Record<string, unknown> | undefined
    if (args.notify !== undefined) {
        let normalized: Record<string, unknown> | undefined
        try {
            normalized = normalizeNotifyInput(args.notify)
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : 'Invalid notify.' }
        }
        if (!normalized) normalized = {}
        const parsedNotify = NotifyPolicySchema.safeParse(normalized)
        if (!parsedNotify.success) return { success: false, error: `notify is invalid: ${parsedNotify.error.message}` }
        notify = parsedNotify.data as unknown as Record<string, unknown>
    }

    let followUp: ReturnType<typeof normalizeFollowUpInput>
    try {
        followUp = normalizeFollowUpInput(args.follow_up, Date.now())
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Invalid follow_up.' }
    }
    // Follow-ups are deadline-bound: unless the caller chose a pacing, keep the
    // adaptive ceiling at 1h so a reply is noticed promptly instead of widening
    // toward the 12h default during the quiet wait.
    if (followUp && cadence === undefined) {
        cadence = { current: 900, min: 900, max: 3600 }
    }

    const enabled = typeof args.enabled === 'boolean' ? args.enabled : true

    try {
        const { createMonitorWatch } = await import('@/lib/monitor/store')
        // Cast through unknown — the input shape is verified piecewise above.
        const created = createMonitorWatch({
            title,
            source: sourceParsed.data,
            target,
            rule: ruleParsed.data,
            allowedActions: allowedActions as never,
            cadence: cadence as never,
            notify: notify as never,
            followUp: followUp ?? null,
            enabled,
            createdBy: 'orchestrator',
        })
        await syncHeartbeatBestEffort()
        const compact = await compactWatchRow(created.id)
        return { success: true, data: { watch_id: created.id, watch: compact } }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to create watch.' }
    }
}

// ---------------------------------------------------------------------------
// monitor_watch_update
// ---------------------------------------------------------------------------

export const monitorWatchUpdateTool: ToolDef = {
    id: 'monitor_watch_update',
    name: 'monitor_watch_update',
    description: [
        'Partial-update an existing Smart Monitor watch. Every field is optional — only the ones you pass are touched. Use this to change the source-scope rule or custom_prompt, grant/revoke an allowed action, adjust cadence, or pause/resume via `enabled`.',
        'Source is immutable (would invalidate the rule). To switch source, remove + add. Suppress patterns are managed via monitor_wake_feedback, NOT here.',
        'After materially updating a watch, update its MONITORS.md durable spec so the prompt-facing documentation matches runtime.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            watch_id: { type: 'string', description: 'The watch id (mw_…) — the value returned as `id` by monitor_watch_list / monitor_watch_get. Pass it as `watch_id`, not `id`.' },
            title: { type: 'string' },
            target: { type: 'string' },
            rule: { type: 'object', description: 'Full replacement rule. Must be source-compatible.' },
            allowed_actions: { type: 'array', description: 'Replacement list (not a delta). Pass [] to revoke all non-notify_inbox actions.' },
            cadence: { type: 'object', description: 'Partial cadence patch (any of current/min/max/adaptive). Values accept seconds or duration strings.' },
            notify: { type: 'object', description: 'Legacy notify patch. Only onMatch is accepted; digest/quiet timing is model-owned task state.' },
            enabled: { type: 'boolean' },
        },
        required: ['watch_id'],
    },
    tags: ['monitoring'],
}

export async function executeMonitorWatchUpdate(args: Record<string, unknown>): Promise<ToolResult> {
    const id = typeof args.watch_id === 'string' ? args.watch_id.trim() : ''
    if (!id) return { success: false, error: 'watch_id is required.' }

    const {
        MonitorRuleSchema,
        MonitorActionSchema,
        NotifyPolicyPartialInputSchema,
    } = await import('@/lib/monitor/schema')

    const patch: Record<string, unknown> = {}
    if (typeof args.title === 'string') patch.title = args.title.trim()
    if (typeof args.target === 'string') patch.target = args.target.trim()
    if (args.rule !== undefined) {
        const parsed = MonitorRuleSchema.safeParse(args.rule)
        if (!parsed.success) return { success: false, error: `rule is invalid: ${parsed.error.message}` }
        patch.rule = parsed.data
    }
    if (args.allowed_actions !== undefined) {
        if (!Array.isArray(args.allowed_actions)) return { success: false, error: 'allowed_actions must be an array.' }
        const { getMonitorWatch } = await import('@/lib/monitor/store')
        const existing = getMonitorWatch(id)
        if (!existing) return { success: false, error: `No watch with id ${id}.` }
        const { actionKindAllowedForSource } = await import('@/lib/monitor/sources')
        const list: Array<unknown> = []
        for (const raw of args.allowed_actions) {
            const parsed = MonitorActionSchema.safeParse(raw)
            if (!parsed.success) return { success: false, error: `allowed_actions contains invalid entry: ${parsed.error.message}` }
            if (!actionKindAllowedForSource(parsed.data.kind, existing.source)) {
                return { success: false, error: `allowed_actions contains "${parsed.data.kind}", which source "${existing.source}" does not support. Call monitor_describe_sources for the action kinds valid on this source.` }
            }
            list.push(parsed.data)
        }
        patch.allowedActions = list
    }
    if (args.cadence !== undefined) {
        try {
            const norm = normalizeCadenceInput(args.cadence)
            if (norm && Object.keys(norm).length > 0) patch.cadence = norm
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : 'Invalid cadence.' }
        }
    }
    if (args.notify !== undefined) {
        let normalized: Record<string, unknown> | undefined
        try {
            normalized = normalizeNotifyInput(args.notify)
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : 'Invalid notify.' }
        }
        if (!normalized) normalized = {}
        const parsed = NotifyPolicyPartialInputSchema.safeParse(normalized)
        if (!parsed.success) return { success: false, error: `notify patch invalid: ${parsed.error.message}` }
        patch.notify = parsed.data
    }
    if (typeof args.enabled === 'boolean') patch.enabled = args.enabled

    if (Object.keys(patch).length === 0) {
        return { success: false, error: 'Provide at least one field to update.' }
    }

    try {
        const { updateMonitorWatch } = await import('@/lib/monitor/store')
        const updated = updateMonitorWatch(id, patch as never)
        if (!updated) return { success: false, error: `No watch with id ${id}.` }
        await syncHeartbeatBestEffort()
        const compact = await compactWatchRow(updated.id)
        return { success: true, data: { watch_id: updated.id, watch: compact } }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to update watch.' }
    }
}

// ---------------------------------------------------------------------------
// monitor_watch_remove
// ---------------------------------------------------------------------------

export const monitorWatchRemoveTool: ToolDef = {
    id: 'monitor_watch_remove',
    name: 'monitor_watch_remove',
    description: 'Delete a Smart Monitor watch by id. Suppress patterns, audit events, and private state are cascade-deleted with it. If this was the last enabled watch, the Smart Monitor system wake task auto-pauses.',
    input_schema: {
        type: 'object',
        properties: { watch_id: { type: 'string', description: 'The watch id (mw_…) — the value returned as `id` by monitor_watch_list / monitor_watch_get. Pass it as `watch_id`, not `id`.' } },
        required: ['watch_id'],
    },
    tags: ['monitoring'],
}

export async function executeMonitorWatchRemove(args: Record<string, unknown>): Promise<ToolResult> {
    const id = typeof args.watch_id === 'string' ? args.watch_id.trim() : ''
    if (!id) return { success: false, error: 'watch_id is required.' }
    const { deleteMonitorWatch, getMonitorWatch } = await import('@/lib/monitor/store')
    const before = getMonitorWatch(id)
    if (!before) return { success: false, error: `No watch with id ${id}.` }
    const ok = deleteMonitorWatch(id)
    if (ok) await syncHeartbeatBestEffort()
    return ok
        ? { success: true, data: { watch_id: id, removed: true, title: before.title, source: before.source } }
        : { success: false, error: `Failed to delete watch ${id}.` }
}

// ---------------------------------------------------------------------------
// Aggregated export for registry.ts
// ---------------------------------------------------------------------------

export const smartMonitorManageTools: ToolDef[] = [
    monitorDescribeSourcesTool,
    monitorWatchListTool,
    monitorWatchGetTool,
    monitorWatchAddTool,
    monitorWatchUpdateTool,
    monitorWatchRemoveTool,
]
