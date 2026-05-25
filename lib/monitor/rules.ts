import type { MonitorRule } from './schema'

// ---------------------------------------------------------------------------
// Smart Monitor rule evaluator.
//
// Pure, deterministic, NO model and NO I/O. Each source adapter builds an
// `EvalCandidate` from its cheap fetch (one Gmail message, one HA state read,
// one WhatsApp message, one web response) and calls `evaluateRule(rule,
// candidate)`. Adapter, rule, and candidate are coordinated by source: a Gmail
// rule only ever sees Gmail candidates because the adapter is the one calling
// the evaluator. The cross-source guards below are defensive — they make the
// evaluator safe to call from anywhere even if a misconfigured watch ends up
// matched against the wrong source by mistake.
//
// `any_of`/`all_of` compose recursively. Empty arrays would never have passed
// schema validation (min 1), but we treat them safely anyway: empty `all_of`
// = true (vacuous), empty `any_of` = false.
// ---------------------------------------------------------------------------

// --- candidate shapes per source -----------------------------------------

/** One Gmail message produced by a cheap fetch since the last watermark. */
export interface GmailCandidate {
    source: 'gmail'
    /** Gmail message id. Used to dedupe via WatchState.lastSeenId / extra. */
    id: string
    threadId: string
    /** All labels (system + user). Schema rules match on label string. */
    labels: string[]
    /** Header "From". Lower-cased version used for matching. */
    from: string
    to: string
    subject: string
    snippet: string
    /** Epoch ms. */
    timestamp: number
}

/** One Google Calendar event in the watch's lookahead window. Calendar
 *  adapters suppress steady-state repeats; this candidate only expresses
 *  whether the event itself satisfies the user's predicate. */
export interface GoogleCalendarCandidate {
    source: 'google_calendar'
    calendarId: string
    eventId: string
    htmlLink: string
    status: string
    summary: string
    description: string
    location: string
    start: string
    end: string
    allDay: boolean
    startMs: number | null
    endMs: number | null
    updated: string | null
    eventType: string | null
    creator: { email: string; displayName: string; self: boolean } | null
    organizer: { email: string; displayName: string; self: boolean } | null
    attendees: Array<{ email: string; displayName: string; responseStatus: string; self: boolean }>
    selfResponseStatus: string | null
    minutesUntilStart: number | null
    fingerprint: string
    previousFingerprint: string | null
    isNew: boolean
    isUpdated: boolean
}

/** One Home Assistant entity state snapshot, paired with the previous snapshot
 *  the engine has on file for that entity (read out of WatchState.extra). The
 *  "previous" half is what lets `*_changes` and `*_threshold` rules express
 *  TRANSITIONS rather than firing every tick the state remains in range. */
export interface HomeAssistantCandidate {
    source: 'home_assistant'
    entityId: string
    state: string
    attributes: Record<string, unknown>
    /** Parsed-once numeric value when `state` looks like a number. */
    numericValue: number | null
    previousState: string | null
    previousAttributes: Record<string, unknown> | null
    previousNumericValue: number | null
    /** Epoch ms of the entity's last_changed, if HA returned it. */
    lastChanged: number | null
}

/** One WhatsApp message new since the last watermark. */
export interface WhatsAppCandidate {
    source: 'whatsapp'
    id: string
    chatId: string
    chatName: string | null
    /** Contact identifier (phone / wid). */
    from: string
    fromMe: boolean
    body: string
    /** Mentioned contact identifiers, if any. */
    mentions: string[]
    timestamp: number
}

/** One web fetch result, paired with the previous fetch's parsed shape so
 *  `*_changes` predicates can compare. */
export interface WebCandidate {
    source: 'web'
    url: string
    status: number
    previousStatus: number | null
    text: string | null
    json: unknown
    previousJson: unknown
    fetchedAt: number
}

/** One weather forecast snapshot for a location. Weather rules are steady-state
 *  here; the weather source adapter handles "fire only on threshold crossing"
 *  at the whole-rule level so composed rules behave correctly. */
export interface WeatherCandidate {
    source: 'weather'
    location: string
    timezone: string
    fetchedAt: number
    currentTemperature: number
    feelsLike: number
    highTemperature: number
    lowTemperature: number
    maxPrecipProbability: number
    maxUvIndex: number
    windSpeed: number
    windGust: number | null
    aqi: number | null
    currentCondition: string
    conditions: string[]
    windowHours: number
}

/** A model-owned recurring instruction. There is no external candidate feed;
 *  the Smart Monitor wake reads the prompt and uses its normal tool surface. */
export interface CustomCandidate {
    source: 'custom'
    watchId: string
    target: string
    prompt: string
    firedAt: number
}

/** Union of all candidate shapes. The adapter narrows by the `source` tag. */
export type EvalCandidate =
    | GmailCandidate
    | GoogleCalendarCandidate
    | HomeAssistantCandidate
    | WhatsAppCandidate
    | WebCandidate
    | WeatherCandidate
    | CustomCandidate

// --- helpers --------------------------------------------------------------

function containsAny(haystack: string, needles: string[], caseInsensitive: boolean | undefined): boolean {
    const ci = caseInsensitive !== false // default true
    const hay = ci ? haystack.toLowerCase() : haystack
    return needles.some((needle) => {
        const n = ci ? needle.toLowerCase() : needle
        return n.length > 0 && hay.includes(n)
    })
}

function emailMatchesAny(haystack: string, candidates: string[]): boolean {
    // Gmail "From" header is typically `"Name" <addr@host>` — accept both
    // a substring match (handles "mom@...") and a bare-equality match.
    const hay = haystack.toLowerCase()
    return candidates.some((c) => {
        const needle = c.toLowerCase().trim()
        return needle.length > 0 && hay.includes(needle)
    })
}

function calendarPeopleText(candidate: GoogleCalendarCandidate): string {
    const people = [
        candidate.creator,
        candidate.organizer,
        ...candidate.attendees,
    ].filter(Boolean) as Array<{ email?: string; displayName?: string }>
    return people
        .flatMap((p) => [p.email ?? '', p.displayName ?? ''])
        .filter(Boolean)
        .join(' ')
}

function calendarEventText(candidate: GoogleCalendarCandidate): string {
    return [
        candidate.summary,
        candidate.description,
        candidate.location,
        calendarPeopleText(candidate),
    ].filter(Boolean).join('\n')
}

function calendarPersonMatchesAny(candidate: GoogleCalendarCandidate, people: string[]): boolean {
    const hay = calendarPeopleText(candidate).toLowerCase()
    return people.some((p) => {
        const needle = p.toLowerCase().trim()
        return needle.length > 0 && hay.includes(needle)
    })
}

function compareNumeric(
    op: '>' | '<' | '>=' | '<=' | '==' | '!=',
    a: number,
    b: number,
): boolean {
    switch (op) {
        case '>': return a > b
        case '<': return a < b
        case '>=': return a >= b
        case '<=': return a <= b
        case '==': return a === b
        case '!=': return a !== b
    }
}

function compareStatus(
    op: 'equals' | 'not_equals' | '>=' | '<' | 'changes',
    status: number,
    value: number | undefined,
    previous: number | null,
): boolean {
    if (op === 'changes') return previous !== null && previous !== status
    if (value === undefined) return false
    switch (op) {
        case 'equals': return status === value
        case 'not_equals': return status !== value
        case '>=': return status >= value
        case '<': return status < value
    }
}

function locationMatches(ruleLocation: string | undefined, candidateLocation: string): boolean {
    if (!ruleLocation) return true
    const rule = normalizeLocation(ruleLocation)
    const candidate = normalizeLocation(candidateLocation)
    return candidate === rule || candidate.includes(rule) || rule.includes(candidate)
}

function normalizeLocation(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
}

/** Minimal dot-path lookup, supports `a.b.c` and `a.b[0].c`. Returns
 *  undefined for any miss — callers compare with `== undefined` to detect. */
export function jsonPathGet(root: unknown, path: string): unknown {
    if (root == null) return undefined
    const tokens = path.split(/[.[\]]+/).filter((t) => t.length > 0)
    let cur: unknown = root
    for (const tok of tokens) {
        if (cur == null) return undefined
        if (Array.isArray(cur)) {
            const idx = Number(tok)
            if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined
            cur = cur[idx]
        } else if (typeof cur === 'object') {
            cur = (cur as Record<string, unknown>)[tok]
        } else {
            return undefined
        }
    }
    return cur
}

/** Structural equality for JSON-safe values. Cheap and accurate enough for
 *  rule comparisons — we only ever compare values that came out of JSON. */
export function jsonEquals(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a == null || b == null) return a === b
    if (typeof a !== typeof b) return false
    if (typeof a !== 'object') return false
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false
        for (let i = 0; i < a.length; i++) if (!jsonEquals(a[i], b[i])) return false
        return true
    }
    if (Array.isArray(b)) return false
    const ka = Object.keys(a as Record<string, unknown>)
    const kb = Object.keys(b as Record<string, unknown>)
    if (ka.length !== kb.length) return false
    for (const key of ka) {
        if (!jsonEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
    }
    return true
}

// --- evaluator ------------------------------------------------------------

/** Apply `rule` to `candidate`. Returns true when the candidate satisfies the
 *  rule. Cross-source rules return false (defensive). */
export function evaluateRule(rule: MonitorRule, candidate: EvalCandidate): boolean {
    switch (rule.kind) {
        case 'any_of':
            if (rule.rules.length === 0) return false
            return rule.rules.some((r) => evaluateRule(r, candidate))
        case 'all_of':
            if (rule.rules.length === 0) return true
            return rule.rules.every((r) => evaluateRule(r, candidate))

        // --- gmail ---
        case 'gmail_from':
            if (candidate.source !== 'gmail') return false
            return emailMatchesAny(candidate.from, rule.senders)
        case 'gmail_subject_contains':
            if (candidate.source !== 'gmail') return false
            return containsAny(candidate.subject, rule.substrings, rule.caseInsensitive)
        case 'gmail_label':
            if (candidate.source !== 'gmail') return false
            return rule.labels.some((l) => candidate.labels.includes(l))
        case 'gmail_query':
            // gmail_query is server-evaluated by Gmail itself (the adapter runs the
            // query and only delivers matching messages). At eval time it's always
            // true — the cheap-check already filtered.
            return candidate.source === 'gmail'

        // --- google calendar ---
        case 'calendar_event_title_contains':
            if (candidate.source !== 'google_calendar') return false
            if (!calendarIdMatches(rule.calendarIds, candidate.calendarId)) return false
            return containsAny(candidate.summary, rule.substrings, rule.caseInsensitive)
        case 'calendar_event_description_contains':
            if (candidate.source !== 'google_calendar') return false
            if (!calendarIdMatches(rule.calendarIds, candidate.calendarId)) return false
            return containsAny(candidate.description, rule.substrings, rule.caseInsensitive)
        case 'calendar_event_location_contains':
            if (candidate.source !== 'google_calendar') return false
            if (!calendarIdMatches(rule.calendarIds, candidate.calendarId)) return false
            return containsAny(candidate.location, rule.substrings, rule.caseInsensitive)
        case 'calendar_event_attendee':
            if (candidate.source !== 'google_calendar') return false
            if (!calendarIdMatches(rule.calendarIds, candidate.calendarId)) return false
            return calendarPersonMatchesAny(candidate, rule.attendees)
        case 'calendar_event_needs_response':
            if (candidate.source !== 'google_calendar') return false
            if (!calendarIdMatches(rule.calendarIds, candidate.calendarId)) return false
            return candidate.selfResponseStatus === 'needsAction'
        case 'calendar_event_starts_within':
            if (candidate.source !== 'google_calendar') return false
            if (!calendarIdMatches(rule.calendarIds, candidate.calendarId)) return false
            return candidate.minutesUntilStart !== null &&
                candidate.minutesUntilStart >= 0 &&
                candidate.minutesUntilStart <= rule.minutes
        case 'calendar_event_query':
            if (candidate.source !== 'google_calendar') return false
            if (!calendarIdMatches(rule.calendarIds, candidate.calendarId)) return false
            return containsAny(calendarEventText(candidate), [rule.q], true)

        // --- whatsapp ---
        case 'wa_unread':
            return candidate.source === 'whatsapp'
        case 'wa_from': {
            if (candidate.source !== 'whatsapp') return false
            const from = candidate.from.toLowerCase()
            const chat = (candidate.chatName ?? '').toLowerCase()
            return rule.contacts.some((c) => {
                const n = c.toLowerCase()
                return n.length > 0 && (from.includes(n) || chat.includes(n))
            })
        }
        case 'wa_text_contains':
            if (candidate.source !== 'whatsapp') return false
            return containsAny(candidate.body, rule.substrings, rule.caseInsensitive)
        case 'wa_mention': {
            if (candidate.source !== 'whatsapp') return false
            const mentions = candidate.mentions.map((m) => m.toLowerCase())
            return rule.mentions.some((m) => mentions.includes(m.toLowerCase()))
        }

        // --- home assistant ---
        case 'ha_state_equals':
            if (candidate.source !== 'home_assistant') return false
            if (candidate.entityId !== rule.entityId) return false
            // Transition: now matches, previously didn't (or first observation).
            return (
                candidate.state === rule.state &&
                candidate.previousState !== rule.state
            )
        case 'ha_state_changes':
            if (candidate.source !== 'home_assistant') return false
            if (candidate.entityId !== rule.entityId) return false
            if (candidate.previousState === null) return false
            return candidate.previousState !== candidate.state
        case 'ha_attribute_changes': {
            if (candidate.source !== 'home_assistant') return false
            if (candidate.entityId !== rule.entityId) return false
            const cur = candidate.attributes?.[rule.attribute]
            const prev = candidate.previousAttributes?.[rule.attribute] ?? null
            if (prev === null && candidate.previousAttributes === null) return false
            return !jsonEquals(cur, prev)
        }
        case 'ha_threshold': {
            if (candidate.source !== 'home_assistant') return false
            if (candidate.entityId !== rule.entityId) return false
            if (candidate.numericValue === null) return false
            const matchesNow = compareNumeric(rule.op, candidate.numericValue, rule.value)
            if (!matchesNow) return false
            // Transition: previous didn't match (or no previous). Same anti-noise
            // principle as ha_state_equals — fire on cross, not on steady-state.
            if (candidate.previousNumericValue === null) return true
            const matchedBefore = compareNumeric(rule.op, candidate.previousNumericValue, rule.value)
            return !matchedBefore
        }

        // --- web ---
        case 'web_status':
            if (candidate.source !== 'web') return false
            if (candidate.url !== rule.url) return false
            return compareStatus(rule.op, candidate.status, rule.value, candidate.previousStatus)
        case 'web_json_path': {
            if (candidate.source !== 'web') return false
            if (candidate.url !== rule.url) return false
            const cur = jsonPathGet(candidate.json, rule.jsonPath)
            switch (rule.op) {
                case 'equals': return jsonEquals(cur, rule.value)
                case 'not_equals': return !jsonEquals(cur, rule.value)
                case 'changes': {
                    if (candidate.previousJson === null || candidate.previousJson === undefined) return false
                    const prev = jsonPathGet(candidate.previousJson, rule.jsonPath)
                    return !jsonEquals(cur, prev)
                }
            }
            // exhaustive — TS should know; defensive return.
            return false
        }
        case 'web_text_contains':
            if (candidate.source !== 'web') return false
            if (candidate.url !== rule.url) return false
            if (candidate.text === null) return false
            return containsAny(candidate.text, rule.substrings, rule.caseInsensitive)

        // --- weather ---
        case 'weather_precip_probability':
            if (candidate.source !== 'weather') return false
            if (!locationMatches(rule.location, candidate.location)) return false
            return compareNumeric(rule.op, candidate.maxPrecipProbability, rule.value)
        case 'weather_temperature': {
            if (candidate.source !== 'weather') return false
            if (!locationMatches(rule.location, candidate.location)) return false
            const value = rule.metric === 'current' ? candidate.currentTemperature
                : rule.metric === 'feels_like' ? candidate.feelsLike
                : rule.metric === 'high' ? candidate.highTemperature
                : candidate.lowTemperature
            return compareNumeric(rule.op, value, rule.value)
        }
        case 'weather_wind': {
            if (candidate.source !== 'weather') return false
            if (!locationMatches(rule.location, candidate.location)) return false
            const value = rule.metric === 'gust'
                ? (candidate.windGust ?? candidate.windSpeed)
                : candidate.windSpeed
            return compareNumeric(rule.op, value, rule.value)
        }
        case 'weather_uv':
            if (candidate.source !== 'weather') return false
            if (!locationMatches(rule.location, candidate.location)) return false
            return compareNumeric(rule.op, candidate.maxUvIndex, rule.value)
        case 'weather_aqi':
            if (candidate.source !== 'weather') return false
            if (!locationMatches(rule.location, candidate.location)) return false
            if (candidate.aqi === null) return false
            return compareNumeric(rule.op, candidate.aqi, rule.value)
        case 'weather_condition': {
            if (candidate.source !== 'weather') return false
            if (!locationMatches(rule.location, candidate.location)) return false
            const wanted = new Set<string>(rule.conditions)
            return candidate.conditions.some((condition) => wanted.has(condition))
        }

        // --- model-owned/internal ---
        case 'custom_prompt':
            return candidate.source === 'custom'
    }
    return false
}

function calendarIdMatches(ruleCalendarIds: string[] | undefined, candidateCalendarId: string): boolean {
    if (!ruleCalendarIds || ruleCalendarIds.length === 0) return true
    const candidate = candidateCalendarId.toLowerCase()
    return ruleCalendarIds.some((id) => id.toLowerCase() === candidate)
}

// --- source<->rule compatibility ------------------------------------------

/** All non-composition rule kinds supported per source. The composition kinds
 *  `any_of` / `all_of` are accepted by every source (they delegate). Used by
 *  source adapters to advertise what predicates they understand and by the
 *  tool/UI to validate input before persistence. */
export const RULE_KINDS_BY_SOURCE = {
    gmail: ['gmail_from', 'gmail_subject_contains', 'gmail_label', 'gmail_query'] as const,
    google_calendar: [
        'calendar_event_title_contains',
        'calendar_event_description_contains',
        'calendar_event_location_contains',
        'calendar_event_attendee',
        'calendar_event_needs_response',
        'calendar_event_starts_within',
        'calendar_event_query',
    ] as const,
    whatsapp: ['wa_unread', 'wa_from', 'wa_text_contains', 'wa_mention'] as const,
    home_assistant: ['ha_state_equals', 'ha_state_changes', 'ha_attribute_changes', 'ha_threshold'] as const,
    web: ['web_status', 'web_json_path', 'web_text_contains'] as const,
    weather: [
        'weather_precip_probability',
        'weather_temperature',
        'weather_wind',
        'weather_uv',
        'weather_aqi',
        'weather_condition',
    ] as const,
    custom: ['custom_prompt'] as const,
} satisfies Record<string, ReadonlyArray<MonitorRule['kind']>>

/** Walk a (possibly composed) rule and return true if every leaf predicate is
 *  in the source's supported list. Used to reject "watch a Gmail address but
 *  the rule contains an HA threshold" at creation time. */
export function ruleMatchesSource(rule: MonitorRule, source: keyof typeof RULE_KINDS_BY_SOURCE): boolean {
    if (rule.kind === 'any_of' || rule.kind === 'all_of') {
        return rule.rules.every((r) => ruleMatchesSource(r, source))
    }
    const allowed = RULE_KINDS_BY_SOURCE[source] as readonly MonitorRule['kind'][]
    return allowed.includes(rule.kind)
}
