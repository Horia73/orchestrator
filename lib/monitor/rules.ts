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

/** Union of all candidate shapes. The adapter narrows by the `source` tag. */
export type EvalCandidate =
    | GmailCandidate
    | HomeAssistantCandidate
    | WhatsAppCandidate
    | WebCandidate

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

        // --- whatsapp ---
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
    }
}

// --- source<->rule compatibility ------------------------------------------

/** All non-composition rule kinds supported per source. The composition kinds
 *  `any_of` / `all_of` are accepted by every source (they delegate). Used by
 *  source adapters to advertise what predicates they understand and by the
 *  tool/UI to validate input before persistence. */
export const RULE_KINDS_BY_SOURCE = {
    gmail: ['gmail_from', 'gmail_subject_contains', 'gmail_label', 'gmail_query'] as const,
    whatsapp: ['wa_from', 'wa_text_contains', 'wa_mention'] as const,
    home_assistant: ['ha_state_equals', 'ha_state_changes', 'ha_attribute_changes', 'ha_threshold'] as const,
    web: ['web_status', 'web_json_path', 'web_text_contains'] as const,
    custom: [] as const,
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
