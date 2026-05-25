import { z } from 'zod'

// ---------------------------------------------------------------------------
// Smart Monitor domain schema.
//
// A "watch" is one source/intention boundary for the Smart Monitor agent:
//   - source + target: WHAT is being observed or maintained.
//   - rule:            a structured fetch/candidate-scope hint or custom
//     model-owned prompt. The active agent wake decides importance; do not
//     treat this as the final notify rule.
//   - allowedActions:  permission boundary — what the model is allowed to do
//     when the rule matches (notify_inbox is the only default; everything
//     else is opt-in by the user.
//   - cadence/notify:  desired watch pacing and notification metadata. The
//     active Smart Monitor wake, digest behavior, and quiet/active windows are
//     agent-owned via the single scheduled task state and MONITORS.md specs.
//   - state:           the watch's private memory between ticks (last-seen
//     id, last value, quiet/noisy run counts, last-notified watermark, …).
//   - suppressPatterns: noise filter the model accumulates over time via
//     monitor_wake_feedback. Each pattern reuses MonitorRule semantics: if
//     it matches a candidate, the candidate is dropped before waking.
//
// This module imports nothing but zod — it sits at the bottom of the import
// graph so the store and tool registry can both depend on it without cycles.
// ---------------------------------------------------------------------------

// --- sources ---------------------------------------------------------------

/** Pluggable source kinds. Adding a new source = a new value here + a new
 *  adapter in lib/monitor/sources/. The `custom` slot is for model-owned
 *  recurring work that is described by a prompt instead of an external
 *  connector predicate. */
export const WatchSourceSchema = z.enum([
    'gmail',
    'google_calendar',
    'whatsapp',
    'home_assistant',
    'web',
    'weather',
    'custom',
])
export type WatchSource = z.infer<typeof WatchSourceSchema>

// --- cadence ---------------------------------------------------------------

/** Legacy per-watch cadence quantum. The active Smart Monitor agent task still
 *  defaults to this 15 minute floor, then self-paces with reschedule_task. */
export const MONITOR_CADENCE_STEP_SECONDS = 15 * 60

/** Legacy per-watch bounds retained for existing watch rows. */
export const MIN_CADENCE_SECONDS = MONITOR_CADENCE_STEP_SECONDS
export const MAX_CADENCE_SECONDS = 12 * 60 * 60
export const DEFAULT_CADENCE_SECONDS = 15 * 60

const CadenceSecondsSchema = z.number()
    .int()
    .min(MIN_CADENCE_SECONDS)
    .max(MAX_CADENCE_SECONDS)
    .refine((n) => n % MONITOR_CADENCE_STEP_SECONDS === 0, {
        message: 'cadence values must be multiples of 15 minutes',
    })

const CadenceFieldsSchema = z.object({
    /** Current effective cadence in seconds. Engine reads this when scheduling
     *  the next check. */
    current: CadenceSecondsSchema.default(DEFAULT_CADENCE_SECONDS),
    /** Minimum cadence the engine is allowed to use for this watch. */
    min: CadenceSecondsSchema.default(MIN_CADENCE_SECONDS),
    /** Maximum cadence the engine is allowed to use for this watch. */
    max: CadenceSecondsSchema.default(MAX_CADENCE_SECONDS),
    /** Whether the engine may widen/tighten `current` between [min, max] based
     *  on quiet/active runs. When false, the engine pins to `current`. */
    adaptive: z.boolean().default(true),
})

export const CadencePolicySchema = CadenceFieldsSchema
    .refine((c) => c.min <= c.max, { message: 'cadence.min must be <= cadence.max' })
    .refine((c) => c.current >= c.min && c.current <= c.max, {
        message: 'cadence.current must be within [min, max]',
    })
export type CadencePolicy = z.infer<typeof CadencePolicySchema>

/** Partial-input variant for updates. Two things differ from `.partial()`:
 *  (1) the cross-field refines live on the full schema only — callers merge
 *  this with existing values then re-parse via CadencePolicySchema to enforce
 *  them. Zod v4 disallows `.partial()` on a schema with refinements anyway.
 *  (2) NO defaults — Zod v4's `.partial()` preserves `.default()`s, which
 *  silently injects values for omitted fields and clobbers existing ones on
 *  spread-merge. So we hand-write the optional shape without defaults: an
 *  empty partial means "don't touch anything", not "reset to defaults". */
export const CadencePolicyPartialInputSchema = z.object({
    current: CadenceSecondsSchema.optional(),
    min: CadenceSecondsSchema.optional(),
    max: CadenceSecondsSchema.optional(),
    adaptive: z.boolean().optional(),
})
export type CadencePolicyPartialInput = z.infer<typeof CadencePolicyPartialInputSchema>

// --- notify policy ---------------------------------------------------------

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected "HH:MM"')

export const QuietHoursSchema = z.object({
    from: HHMM,
    to: HHMM,
    timezone: z.string().min(1).max(64),
})
export type QuietHours = z.infer<typeof QuietHoursSchema>

export const NotifyPolicySchema = z.object({
    /** Surface to Inbox as soon as the rule matches (subject to suppression). */
    onMatch: z.boolean().default(true),
    /** Legacy only. Digest behavior is model-owned task_state. */
    digestAt: HHMM.optional(),
    /** Legacy only. Quiet/active timing is model-owned task_state. */
    quietHours: QuietHoursSchema.optional(),
})
export type NotifyPolicy = z.infer<typeof NotifyPolicySchema>

/** Partial-input variant for updates — same rationale as
 *  CadencePolicyPartialInputSchema: no defaults so an omitted field stays
 *  truly absent and existing values are preserved across spread-merge. */
export const NotifyPolicyPartialInputSchema = z.object({
    onMatch: z.boolean().optional(),
    digestAt: HHMM.optional(),
    quietHours: QuietHoursSchema.optional(),
})
export type NotifyPolicyPartialInput = z.infer<typeof NotifyPolicyPartialInputSchema>

// --- rules (recursive discriminated union) --------------------------------

/** Predicates/instructions per source. Connector rules are evaluated by
 *  lib/monitor/rules.ts inside the cheap tick with NO model involved.
 *  `custom_prompt` is a model-owned recurring instruction consumed by the
 *  Smart Monitor wake. Composition via any_of (OR) / all_of (AND). */
export type MonitorRule =
    // gmail
    | { kind: 'gmail_from'; senders: string[] }
    | { kind: 'gmail_subject_contains'; substrings: string[]; caseInsensitive?: boolean }
    | { kind: 'gmail_label'; labels: string[] }
    | { kind: 'gmail_query'; q: string }
    // google calendar
    | { kind: 'calendar_event_title_contains'; substrings: string[]; caseInsensitive?: boolean; calendarIds?: string[]; lookaheadDays?: number }
    | { kind: 'calendar_event_description_contains'; substrings: string[]; caseInsensitive?: boolean; calendarIds?: string[]; lookaheadDays?: number }
    | { kind: 'calendar_event_location_contains'; substrings: string[]; caseInsensitive?: boolean; calendarIds?: string[]; lookaheadDays?: number }
    | { kind: 'calendar_event_attendee'; attendees: string[]; calendarIds?: string[]; lookaheadDays?: number }
    | { kind: 'calendar_event_needs_response'; calendarIds?: string[]; lookaheadDays?: number }
    | { kind: 'calendar_event_starts_within'; minutes: number; calendarIds?: string[]; lookaheadDays?: number }
    | { kind: 'calendar_event_query'; q: string; calendarIds?: string[]; lookaheadDays?: number }
    // whatsapp
    | { kind: 'wa_unread' }
    | { kind: 'wa_from'; contacts: string[] }
    | { kind: 'wa_text_contains'; substrings: string[]; caseInsensitive?: boolean }
    | { kind: 'wa_mention'; mentions: string[] }
    // home assistant
    | { kind: 'ha_state_equals'; entityId: string; state: string }
    | { kind: 'ha_state_changes'; entityId: string }
    | { kind: 'ha_attribute_changes'; entityId: string; attribute: string }
    | { kind: 'ha_threshold'; entityId: string; op: '>' | '<' | '>=' | '<=' | '==' | '!='; value: number }
    // web
    | { kind: 'web_status'; url: string; op: 'equals' | 'not_equals' | '>=' | '<' | 'changes'; value?: number }
    | { kind: 'web_json_path'; url: string; jsonPath: string; op: 'equals' | 'not_equals' | 'changes'; value?: unknown }
    | { kind: 'web_text_contains'; url: string; substrings: string[]; caseInsensitive?: boolean }
    // weather
    | { kind: 'weather_precip_probability'; location?: string; windowHours?: number; op: '>' | '<' | '>=' | '<=' | '==' | '!='; value: number }
    | { kind: 'weather_temperature'; location?: string; metric: 'current' | 'feels_like' | 'high' | 'low'; op: '>' | '<' | '>=' | '<=' | '==' | '!='; value: number }
    | { kind: 'weather_wind'; location?: string; metric: 'speed' | 'gust'; op: '>' | '<' | '>=' | '<=' | '==' | '!='; value: number }
    | { kind: 'weather_uv'; location?: string; windowHours?: number; op: '>' | '<' | '>=' | '<=' | '==' | '!='; value: number }
    | { kind: 'weather_aqi'; location?: string; op: '>' | '<' | '>=' | '<=' | '==' | '!='; value: number }
    | { kind: 'weather_condition'; location?: string; windowHours?: number; conditions: Array<'clear' | 'partly-cloudy' | 'cloudy' | 'overcast' | 'fog' | 'drizzle' | 'rain' | 'heavy-rain' | 'sleet' | 'snow' | 'heavy-snow' | 'hail' | 'thunderstorm' | 'windy' | 'unknown'> }
    // model-owned/internal
    | { kind: 'custom_prompt'; prompt: string }
    // composition
    | { kind: 'any_of'; rules: MonitorRule[] }
    | { kind: 'all_of'; rules: MonitorRule[] }

// Non-recursive cases as a discriminated union for cheap dispatch / nice errors.
const WeatherRuleLocationSchema = z.string().min(1).max(160).optional()
const WeatherWindowHoursSchema = z.number().int().min(1).max(240).optional()
const WeatherNumericOpSchema = z.enum(['>', '<', '>=', '<=', '==', '!='])
const CalendarIdsSchema = z.array(z.string().min(1).max(250)).min(1).max(25).optional()
const CalendarLookaheadDaysSchema = z.number().int().min(1).max(180).optional()
const WeatherMonitorConditionSchema = z.enum([
    'clear',
    'partly-cloudy',
    'cloudy',
    'overcast',
    'fog',
    'drizzle',
    'rain',
    'heavy-rain',
    'sleet',
    'snow',
    'heavy-snow',
    'hail',
    'thunderstorm',
    'windy',
    'unknown',
])
const LeafRuleSchema = z.discriminatedUnion('kind', [
    // gmail
    z.object({
        kind: z.literal('gmail_from'),
        senders: z.array(z.string().min(1).max(320)).min(1).max(64),
    }),
    z.object({
        kind: z.literal('gmail_subject_contains'),
        substrings: z.array(z.string().min(1).max(200)).min(1).max(32),
        caseInsensitive: z.boolean().optional(),
    }),
    z.object({
        kind: z.literal('gmail_label'),
        labels: z.array(z.string().min(1).max(120)).min(1).max(16),
    }),
    z.object({
        kind: z.literal('gmail_query'),
        q: z.string().min(1).max(500),
    }),
    // google calendar
    z.object({
        kind: z.literal('calendar_event_title_contains'),
        substrings: z.array(z.string().min(1).max(200)).min(1).max(32),
        caseInsensitive: z.boolean().optional(),
        calendarIds: CalendarIdsSchema,
        lookaheadDays: CalendarLookaheadDaysSchema,
    }),
    z.object({
        kind: z.literal('calendar_event_description_contains'),
        substrings: z.array(z.string().min(1).max(200)).min(1).max(32),
        caseInsensitive: z.boolean().optional(),
        calendarIds: CalendarIdsSchema,
        lookaheadDays: CalendarLookaheadDaysSchema,
    }),
    z.object({
        kind: z.literal('calendar_event_location_contains'),
        substrings: z.array(z.string().min(1).max(200)).min(1).max(32),
        caseInsensitive: z.boolean().optional(),
        calendarIds: CalendarIdsSchema,
        lookaheadDays: CalendarLookaheadDaysSchema,
    }),
    z.object({
        kind: z.literal('calendar_event_attendee'),
        attendees: z.array(z.string().min(1).max(320)).min(1).max(64),
        calendarIds: CalendarIdsSchema,
        lookaheadDays: CalendarLookaheadDaysSchema,
    }),
    z.object({
        kind: z.literal('calendar_event_needs_response'),
        calendarIds: CalendarIdsSchema,
        lookaheadDays: CalendarLookaheadDaysSchema,
    }),
    z.object({
        kind: z.literal('calendar_event_starts_within'),
        minutes: z.number().int().min(1).max(60 * 24 * 30),
        calendarIds: CalendarIdsSchema,
        lookaheadDays: CalendarLookaheadDaysSchema,
    }),
    z.object({
        kind: z.literal('calendar_event_query'),
        q: z.string().min(1).max(500),
        calendarIds: CalendarIdsSchema,
        lookaheadDays: CalendarLookaheadDaysSchema,
    }),
    // whatsapp
    z.object({
        kind: z.literal('wa_unread'),
    }),
    z.object({
        kind: z.literal('wa_from'),
        contacts: z.array(z.string().min(1).max(120)).min(1).max(64),
    }),
    z.object({
        kind: z.literal('wa_text_contains'),
        substrings: z.array(z.string().min(1).max(200)).min(1).max(32),
        caseInsensitive: z.boolean().optional(),
    }),
    z.object({
        kind: z.literal('wa_mention'),
        mentions: z.array(z.string().min(1).max(120)).min(1).max(32),
    }),
    // home assistant
    z.object({
        kind: z.literal('ha_state_equals'),
        entityId: z.string().min(1).max(200),
        state: z.string().min(1).max(200),
    }),
    z.object({
        kind: z.literal('ha_state_changes'),
        entityId: z.string().min(1).max(200),
    }),
    z.object({
        kind: z.literal('ha_attribute_changes'),
        entityId: z.string().min(1).max(200),
        attribute: z.string().min(1).max(120),
    }),
    z.object({
        kind: z.literal('ha_threshold'),
        entityId: z.string().min(1).max(200),
        op: z.enum(['>', '<', '>=', '<=', '==', '!=']),
        value: z.number(),
    }),
    // web
    z.object({
        kind: z.literal('web_status'),
        url: z.string().url().max(2048),
        op: z.enum(['equals', 'not_equals', '>=', '<', 'changes']),
        value: z.number().int().min(100).max(599).optional(),
    }),
    z.object({
        kind: z.literal('web_json_path'),
        url: z.string().url().max(2048),
        jsonPath: z.string().min(1).max(200),
        op: z.enum(['equals', 'not_equals', 'changes']),
        value: z.unknown().optional(),
    }),
    z.object({
        kind: z.literal('web_text_contains'),
        url: z.string().url().max(2048),
        substrings: z.array(z.string().min(1).max(200)).min(1).max(16),
        caseInsensitive: z.boolean().optional(),
    }),
    // weather
    z.object({
        kind: z.literal('weather_precip_probability'),
        location: WeatherRuleLocationSchema,
        windowHours: WeatherWindowHoursSchema,
        op: WeatherNumericOpSchema,
        value: z.number().min(0).max(100),
    }),
    z.object({
        kind: z.literal('weather_temperature'),
        location: WeatherRuleLocationSchema,
        metric: z.enum(['current', 'feels_like', 'high', 'low']),
        op: WeatherNumericOpSchema,
        value: z.number(),
    }),
    z.object({
        kind: z.literal('weather_wind'),
        location: WeatherRuleLocationSchema,
        metric: z.enum(['speed', 'gust']),
        op: WeatherNumericOpSchema,
        value: z.number().min(0),
    }),
    z.object({
        kind: z.literal('weather_uv'),
        location: WeatherRuleLocationSchema,
        windowHours: WeatherWindowHoursSchema,
        op: WeatherNumericOpSchema,
        value: z.number().min(0).max(20),
    }),
    z.object({
        kind: z.literal('weather_aqi'),
        location: WeatherRuleLocationSchema,
        op: WeatherNumericOpSchema,
        value: z.number().min(0).max(1000),
    }),
    z.object({
        kind: z.literal('weather_condition'),
        location: WeatherRuleLocationSchema,
        windowHours: WeatherWindowHoursSchema,
        conditions: z.array(WeatherMonitorConditionSchema).min(1).max(16),
    }),
    // model-owned/internal
    z.object({
        kind: z.literal('custom_prompt'),
        prompt: z.string().min(1).max(8000),
    }),
])

/** Recursive schema: leaves + any_of/all_of composition. Composition depth is
 *  not formally bounded by Zod, but `assertRuleDepth` (below) is used by the
 *  store at insert time to reject pathological nesting. */
export const MonitorRuleSchema: z.ZodType<MonitorRule> = z.lazy(() =>
    z.union([
        LeafRuleSchema,
        z.object({
            kind: z.literal('any_of'),
            rules: z.array(MonitorRuleSchema).min(1).max(16),
        }),
        z.object({
            kind: z.literal('all_of'),
            rules: z.array(MonitorRuleSchema).min(1).max(16),
        }),
    ]),
)

const MAX_RULE_DEPTH = 4

/** Defensive: prevent a malformed/adversarial rule from blowing the stack. */
export function assertRuleDepth(rule: MonitorRule, depth = 0): void {
    if (depth > MAX_RULE_DEPTH)
        throw new Error(`Rule nesting too deep (max ${MAX_RULE_DEPTH}).`)
    if (rule.kind === 'any_of' || rule.kind === 'all_of') {
        for (const child of rule.rules) assertRuleDepth(child, depth + 1)
    }
}

// --- actions (permission boundary) ----------------------------------------

/** What the model is allowed to do when a watch matches. notify_inbox is the
 *  baseline; anything that modifies external state must be explicitly allowed
 *  per watch by the user. The engine enforces this list — the model cannot
 *  bypass it even if the prompt asks. */
export const MonitorActionSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('notify_inbox') }),
    z.object({ kind: z.literal('gmail_archive') }),
    z.object({ kind: z.literal('gmail_mark_read') }),
    z.object({ kind: z.literal('gmail_label_add'), label: z.string().min(1).max(120) }),
    z.object({
        kind: z.literal('ha_call_service'),
        domain: z.string().min(1).max(64),
        service: z.string().min(1).max(64),
        /** Optional fixed payload merged with whatever the model wants to add.
         *  Empty / absent = unrestricted within the (domain, service) pair. */
        fixedData: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({
        kind: z.literal('wa_send_reply'),
        /** Pre-approved template (string-interpolated). Free-form replies are
         *  not allowed without an explicit user-authored template. */
        template: z.string().min(1).max(1000),
    }),
])
export type MonitorAction = z.infer<typeof MonitorActionSchema>

// --- suppress patterns (learning loop) ------------------------------------

/** A noise filter the model accumulates over time. The same MonitorRule
 *  semantics are reused: if `rule` matches a candidate during cheap-check,
 *  the candidate is dropped (counted as suppressedMatches) BEFORE the model
 *  would have been woken. Authored by the model via monitor_wake_feedback. */
export const SuppressPatternSchema = z.object({
    id: z.string().min(1).max(64),
    createdAt: z.number().int().positive(),
    /** Plain-English reason the model recorded — shown in the detail UI so the
     *  user can see why noise is being filtered, and remove the pattern if it's
     *  over-suppressing. */
    reason: z.string().min(1).max(500),
    rule: MonitorRuleSchema,
    /** Optional expiry — defensive against an over-eager suppression that
     *  shouldn't outlive a few days. null = permanent. */
    expiresAt: z.number().int().positive().nullable().default(null),
    /** How many times this pattern has already suppressed a candidate. */
    matchCount: z.number().int().nonnegative().default(0),
    lastMatchedAt: z.number().int().positive().nullable().default(null),
})
export type SuppressPattern = z.infer<typeof SuppressPatternSchema>

// --- per-watch private state ----------------------------------------------

/** Bag of bookkeeping the engine reads/writes each tick. Source adapters may
 *  stash arbitrary JSON-safe data under `extra` (e.g. Gmail's lastHistoryId,
 *  HA's last full state snapshot for diffing). Never exposed to the user UI
 *  except in the detail/debug panel. */
export const WatchStateSchema = z.object({
    lastSeenId: z.string().nullable().default(null),
    lastValue: z.unknown().nullable().default(null),
    lastValueAt: z.number().int().positive().nullable().default(null),
    lastFetchedAt: z.number().int().positive().nullable().default(null),
    quietRuns: z.number().int().nonnegative().default(0),
    activeRuns: z.number().int().nonnegative().default(0),
    lastNotifiedAt: z.number().int().positive().nullable().default(null),
    lastNotifiedSummary: z.string().max(2000).nullable().default(null),
    cumulativeMatches: z.number().int().nonnegative().default(0),
    suppressedMatches: z.number().int().nonnegative().default(0),
    extra: z.record(z.string(), z.unknown()).default({}),
})
export type WatchState = z.infer<typeof WatchStateSchema>

export const EMPTY_WATCH_STATE: WatchState = WatchStateSchema.parse({})

// --- watch ----------------------------------------------------------------

export const WatchCreatedBySchema = z.enum(['user', 'orchestrator', 'system'])
export type WatchCreatedBy = z.infer<typeof WatchCreatedBySchema>

/** Full persisted watch. UI lists, engine ticks, and the model all read this. */
export const MonitorWatchSchema = z.object({
    id: z.string().min(1),
    title: z.string().min(1).max(200),
    source: WatchSourceSchema,
    /** Human-meaningful identifier for the thing being watched. Format is
     *  source-specific (Gmail: address/query, Calendar: primary/all/calendar
     *  ids, HA: entity_id, Web: URL, Weather: location, etc.). */
    target: z.string().min(1).max(500),
    rule: MonitorRuleSchema,
    allowedActions: z.array(MonitorActionSchema).max(16).default([]),
    cadence: CadencePolicySchema,
    notify: NotifyPolicySchema,
    enabled: z.boolean(),
    state: WatchStateSchema,
    suppressPatterns: z.array(SuppressPatternSchema).max(64).default([]),
    /** Last completed cheap-tick attempt (ok or error). */
    lastCheckedAt: z.number().int().positive().nullable(),
    /** Engine-scheduled next tick. The master timer wakes at min(nextCheckAt). */
    nextCheckAt: z.number().int().positive().nullable(),
    /** Last time this watch actually triggered the model wake (after suppression). */
    lastFiredAt: z.number().int().positive().nullable(),
    consecutiveErrors: z.number().int().nonnegative(),
    lastError: z.string().max(2000).nullable(),
    createdBy: WatchCreatedBySchema,
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
})
export type MonitorWatch = z.infer<typeof MonitorWatchSchema>

// --- create / update inputs -----------------------------------------------

/** Accepted on create (UI form OR monitor_watch_add tool). State, watermarks,
 *  and timestamps are server-generated. */
export const CreateMonitorWatchInputSchema = z.object({
    title: z.string().min(1).max(200),
    source: WatchSourceSchema,
    target: z.string().min(1).max(500),
    rule: MonitorRuleSchema,
    allowedActions: z.array(MonitorActionSchema).max(16).default([]),
    cadence: CadencePolicySchema.optional(),
    notify: NotifyPolicySchema.optional(),
    enabled: z.boolean().default(true),
    createdBy: WatchCreatedBySchema.default('orchestrator'),
})
export type CreateMonitorWatchInput = z.input<typeof CreateMonitorWatchInputSchema>

/** Accepted on update — every field optional; cadence/notify partial-merge so
 *  callers can flip a single sub-field (e.g. cadence.adaptive) without re-sending
 *  the whole policy. */
export const UpdateMonitorWatchInputSchema = z.object({
    title: z.string().min(1).max(200).optional(),
    target: z.string().min(1).max(500).optional(),
    rule: MonitorRuleSchema.optional(),
    allowedActions: z.array(MonitorActionSchema).max(16).optional(),
    cadence: CadencePolicyPartialInputSchema.optional(),
    notify: NotifyPolicyPartialInputSchema.optional(),
    enabled: z.boolean().optional(),
})
export type UpdateMonitorWatchInput = z.infer<typeof UpdateMonitorWatchInputSchema>

// --- watch events (audit log) ---------------------------------------------

/** Append-only timeline of what happened to a watch. Surfaced in the detail
 *  panel so the user can see *why* a watch fired or didn't, and so the model
 *  can read recent history when building suppression patterns. */
export const WatchEventKindSchema = z.enum([
    'check',          // cheap tick happened, no match
    'match',          // cheap tick matched the rule
    'suppress',       // candidate matched but a suppress pattern dropped it
    'wake',           // model was woken because of one or more matches
    'notify',         // model called notify_inbox for this watch
    'action',         // model executed an allowed action (e.g. gmail_archive)
    'feedback',       // model recorded was_worth_it judgment after a wake
    'cadence_change', // engine widened/tightened current cadence
    'error',          // cheap tick failed (network, integration, parse, …)
])
export type WatchEventKind = z.infer<typeof WatchEventKindSchema>

export const WatchEventSchema = z.object({
    id: z.string().min(1),
    watchId: z.string().min(1),
    ts: z.number().int().positive(),
    kind: WatchEventKindSchema,
    /** Small bag of details. Engine-authored kinds use known shapes (e.g.
     *  cadence_change: { from: number; to: number; reason: string }); error
     *  uses { message: string }; the model can attach free-form payload for
     *  feedback/notify. */
    payload: z.record(z.string(), z.unknown()).nullable().default(null),
})
export type WatchEvent = z.infer<typeof WatchEventSchema>
