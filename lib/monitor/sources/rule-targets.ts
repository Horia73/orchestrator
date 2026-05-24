import type { MonitorRule } from '../schema'

// ---------------------------------------------------------------------------
// Pure helpers that walk a (possibly composed) rule and extract the concrete
// targets each adapter needs to fetch: URLs for the web adapter, entity_ids
// for Home Assistant, Gmail search queries, Calendar ids, WhatsApp contacts.
//
// Sharing them keeps adapter code small and consistent — and lets the engine
// preview "what will this watch actually hit" for the detail UI.
// ---------------------------------------------------------------------------

function walk(rule: MonitorRule, visit: (leaf: MonitorRule) => void): void {
    if (rule.kind === 'any_of' || rule.kind === 'all_of') {
        for (const child of rule.rules) walk(child, visit)
        return
    }
    visit(rule)
}

/** All distinct URLs referenced by web_* leaves. */
export function extractUrlsFromRule(rule: MonitorRule): string[] {
    const seen = new Set<string>()
    walk(rule, (leaf) => {
        if (
            leaf.kind === 'web_status' ||
            leaf.kind === 'web_json_path' ||
            leaf.kind === 'web_text_contains'
        ) {
            seen.add(leaf.url)
        }
    })
    return [...seen]
}

/** All distinct HA entity_ids referenced by ha_* leaves. */
export function extractEntityIdsFromRule(rule: MonitorRule): string[] {
    const seen = new Set<string>()
    walk(rule, (leaf) => {
        if (
            leaf.kind === 'ha_state_equals' ||
            leaf.kind === 'ha_state_changes' ||
            leaf.kind === 'ha_attribute_changes' ||
            leaf.kind === 'ha_threshold'
        ) {
            seen.add(leaf.entityId)
        }
    })
    return [...seen]
}

/** Build a Gmail search query that pre-filters server-side to only the
 *  messages a watch's rule could match. We OR the sender filters, label
 *  filters, and subject-substring filters together (since the rule's
 *  any_of/all_of composition still gets evaluated client-side after the
 *  fetch). If the rule contains a raw `gmail_query`, that query is used
 *  verbatim — the user told us exactly what they want.
 *
 *  Returns null if the rule references no Gmail predicates; the engine
 *  treats that as a misconfigured watch (no Gmail rule on a Gmail watch). */
export function buildGmailQueryFromRule(rule: MonitorRule): string | null {
    const senders = new Set<string>()
    const subjects = new Set<string>()
    const labels = new Set<string>()
    const raw: string[] = []
    let sawGmailLeaf = false

    walk(rule, (leaf) => {
        if (leaf.kind === 'gmail_from') {
            sawGmailLeaf = true
            for (const s of leaf.senders) senders.add(s)
        } else if (leaf.kind === 'gmail_subject_contains') {
            sawGmailLeaf = true
            for (const s of leaf.substrings) subjects.add(s)
        } else if (leaf.kind === 'gmail_label') {
            sawGmailLeaf = true
            for (const l of leaf.labels) labels.add(l)
        } else if (leaf.kind === 'gmail_query') {
            sawGmailLeaf = true
            raw.push(leaf.q)
        }
    })

    if (!sawGmailLeaf) return null

    // A raw query trumps everything — the user wrote Gmail syntax themselves.
    if (raw.length > 0) {
        return raw.length === 1 ? raw[0] : raw.map((q) => `(${q})`).join(' OR ')
    }

    const parts: string[] = []
    if (senders.size > 0) {
        parts.push(`(${[...senders].map((s) => `from:${quoteGmailToken(s)}`).join(' OR ')})`)
    }
    if (labels.size > 0) {
        parts.push(`(${[...labels].map((l) => `label:${quoteGmailToken(l)}`).join(' OR ')})`)
    }
    if (subjects.size > 0) {
        parts.push(`(${[...subjects].map((s) => `subject:${quoteGmailToken(s)}`).join(' OR ')})`)
    }
    // If we had only gmail_label leaves the parts may still be empty when the
    // label set is empty — guarded by min-1 schema, so this is just defensive.
    return parts.length > 0 ? parts.join(' ') : '*'
}

/** Quote a Gmail search token if it contains whitespace or special chars,
 *  otherwise leave it bare so simple forms like `from:mom@example.com` keep
 *  working. */
function quoteGmailToken(value: string): string {
    if (/^[A-Za-z0-9._@\-+]+$/.test(value)) return value
    return `"${value.replace(/"/g, '\\"')}"`
}

/** Distinct Google Calendar ids referenced by calendar_* leaves. Empty means
 *  the adapter should derive calendars from the watch target. */
export function extractCalendarIdsFromRule(rule: MonitorRule): string[] {
    const seen = new Set<string>()
    walk(rule, (leaf) => {
        if (
            leaf.kind === 'calendar_event_title_contains' ||
            leaf.kind === 'calendar_event_description_contains' ||
            leaf.kind === 'calendar_event_location_contains' ||
            leaf.kind === 'calendar_event_attendee' ||
            leaf.kind === 'calendar_event_needs_response' ||
            leaf.kind === 'calendar_event_starts_within' ||
            leaf.kind === 'calendar_event_query'
        ) {
            for (const id of leaf.calendarIds ?? []) {
                const clean = id.trim()
                if (clean) seen.add(clean)
            }
        }
    })
    return [...seen]
}

/** Largest lookahead requested by calendar_* leaves. The adapter caps this
 *  further so a broad watch cannot page through unbounded history. */
export function extractCalendarLookaheadDaysFromRule(rule: MonitorRule): number | null {
    let max: number | null = null
    walk(rule, (leaf) => {
        if (
            leaf.kind === 'calendar_event_title_contains' ||
            leaf.kind === 'calendar_event_description_contains' ||
            leaf.kind === 'calendar_event_location_contains' ||
            leaf.kind === 'calendar_event_attendee' ||
            leaf.kind === 'calendar_event_needs_response' ||
            leaf.kind === 'calendar_event_starts_within' ||
            leaf.kind === 'calendar_event_query'
        ) {
            if (typeof leaf.lookaheadDays === 'number') {
                max = max === null ? leaf.lookaheadDays : Math.max(max, leaf.lookaheadDays)
            }
        }
    })
    return max
}

export function ruleContainsCalendarStartWindow(rule: MonitorRule): boolean {
    let found = false
    walk(rule, (leaf) => {
        if (leaf.kind === 'calendar_event_starts_within') found = true
    })
    return found
}

export function matchingCalendarStartWindows(rule: MonitorRule, minutesUntilStart: number | null): number[] {
    if (minutesUntilStart === null || minutesUntilStart < 0) return []
    const windows = new Set<number>()
    walk(rule, (leaf) => {
        if (
            leaf.kind === 'calendar_event_starts_within' &&
            minutesUntilStart <= leaf.minutes
        ) {
            windows.add(leaf.minutes)
        }
    })
    return [...windows].sort((a, b) => a - b)
}

/** Distinct WhatsApp contact tokens referenced by wa_from leaves. The
 *  WhatsApp adapter does its own substring matching client-side, but the
 *  preview UI can show "this watch is waiting on: …". */
export function extractWaContactsFromRule(rule: MonitorRule): string[] {
    const seen = new Set<string>()
    walk(rule, (leaf) => {
        if (leaf.kind === 'wa_from') {
            for (const c of leaf.contacts) seen.add(c)
        }
    })
    return [...seen]
}

/** Distinct weather locations referenced by weather_* leaves. Empty means
 *  the adapter should use the watch target as the location. */
export function extractWeatherLocationsFromRule(rule: MonitorRule): string[] {
    const seen = new Set<string>()
    walk(rule, (leaf) => {
        if (
            leaf.kind === 'weather_precip_probability' ||
            leaf.kind === 'weather_temperature' ||
            leaf.kind === 'weather_wind' ||
            leaf.kind === 'weather_uv' ||
            leaf.kind === 'weather_aqi' ||
            leaf.kind === 'weather_condition'
        ) {
            if (leaf.location?.trim()) seen.add(leaf.location.trim())
        }
    })
    return [...seen]
}
