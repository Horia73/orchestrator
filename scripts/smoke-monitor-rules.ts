/**
 * Smoke test for the Smart Monitor rule evaluator + source registry.
 *
 * Pure logic — no DB, no network. Validates:
 *   - every predicate kind evaluates correctly on a representative candidate
 *   - cross-source candidates safely return false (defensive)
 *   - any_of / all_of compose correctly, including empty edge cases
 *   - HA transition semantics (state_equals fires on cross, not steady-state)
 *   - threshold transition semantics (same)
 *   - jsonPathGet handles dot + array index forms
 *   - jsonEquals handles primitives, arrays, objects (incl. key-order independence)
 *   - rule-target extractors return distinct URLs / entity_ids / contacts
 *   - buildGmailQueryFromRule produces a valid Gmail search string
 *   - source registry returns the right adapter
 *   - assertRuleMatchesSource accepts compatible and rejects incompatible
 *
 * Run: npx tsx scripts/smoke-monitor-rules.ts
 */
import {
    evaluateRule,
    jsonEquals,
    jsonPathGet,
    ruleMatchesSource,
    RULE_KINDS_BY_SOURCE,
    type EvalCandidate,
    type GmailCandidate,
    type HomeAssistantCandidate,
    type WebCandidate,
    type WhatsAppCandidate,
} from '@/lib/monitor/rules'
import type { MonitorRule } from '@/lib/monitor/schema'
import {
    buildGmailQueryFromRule,
    extractEntityIdsFromRule,
    extractUrlsFromRule,
    extractWaContactsFromRule,
} from '@/lib/monitor/sources/rule-targets'
import {
    assertRuleMatchesSource,
    getSourceAdapter,
    listSourceCapabilities,
} from '@/lib/monitor/sources'

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
    if (!ok) failures++
}
function expectThrow(label: string, fn: () => unknown) {
    let threw = false
    let err: unknown
    try { fn() } catch (e) { threw = true; err = e }
    check(label, threw, err instanceof Error ? err.message : err)
}

// ---- helpers to build candidates ------------------------------------------

function gmail(partial: Partial<GmailCandidate>): GmailCandidate {
    return {
        source: 'gmail',
        id: 'm1',
        threadId: 't1',
        labels: ['INBOX', 'UNREAD'],
        from: 'mom@example.com',
        to: 'me@example.com',
        subject: 'Urgent: car broke',
        snippet: 'Can you call?',
        timestamp: 1_700_000_000_000,
        ...partial,
    }
}
function wa(partial: Partial<WhatsAppCandidate>): WhatsAppCandidate {
    return {
        source: 'whatsapp',
        id: 'wa1',
        chatId: '40123@c.us',
        chatName: 'Mom',
        from: '40123@c.us',
        fromMe: false,
        body: 'Vino acasă',
        mentions: [],
        timestamp: 1_700_000_000_000,
        ...partial,
    }
}
function ha(partial: Partial<HomeAssistantCandidate>): HomeAssistantCandidate {
    return {
        source: 'home_assistant',
        entityId: 'binary_sensor.garage_door',
        state: 'on',
        attributes: { friendly_name: 'Garage', battery: 80 },
        numericValue: null,
        previousState: 'off',
        previousAttributes: { friendly_name: 'Garage', battery: 81 },
        previousNumericValue: null,
        lastChanged: 1_700_000_000_000,
        ...partial,
    }
}
function web(partial: Partial<WebCandidate>): WebCandidate {
    return {
        source: 'web',
        url: 'https://example.com/status',
        status: 200,
        previousStatus: 200,
        text: '{"items":[{"available":true,"price":9.99}]}',
        json: { items: [{ available: true, price: 9.99 }] },
        previousJson: { items: [{ available: false, price: 9.99 }] },
        fetchedAt: 1_700_000_000_000,
        ...partial,
    }
}

// ============================================================================
// 1. Gmail predicates
// ============================================================================
check('gmail_from substring matches header form', evaluateRule(
    { kind: 'gmail_from', senders: ['mom@example.com'] },
    gmail({ from: '"Mom" <mom@example.com>' }),
))
check('gmail_from misses unknown sender', !evaluateRule(
    { kind: 'gmail_from', senders: ['boss@work.com'] },
    gmail({}),
))
check('gmail_subject_contains case-insensitive default', evaluateRule(
    { kind: 'gmail_subject_contains', substrings: ['URGENT'] },
    gmail({ subject: 'urgent meeting' }),
))
check('gmail_subject_contains respects caseInsensitive=false', !evaluateRule(
    { kind: 'gmail_subject_contains', substrings: ['URGENT'], caseInsensitive: false },
    gmail({ subject: 'urgent meeting' }),
))
check('gmail_label hit', evaluateRule(
    { kind: 'gmail_label', labels: ['UNREAD'] },
    gmail({}),
))
check('gmail_label miss', !evaluateRule(
    { kind: 'gmail_label', labels: ['IMPORTANT'] },
    gmail({}),
))
check('gmail_query is true for gmail candidates (server-filtered)', evaluateRule(
    { kind: 'gmail_query', q: 'from:boss' },
    gmail({}),
))

// ============================================================================
// 2. WhatsApp predicates
// ============================================================================
check('wa_from matches chat name', evaluateRule(
    { kind: 'wa_from', contacts: ['Mom'] },
    wa({ chatName: 'Mom (Mama)' }),
))
check('wa_from matches phone id', evaluateRule(
    { kind: 'wa_from', contacts: ['40123'] },
    wa({}),
))
check('wa_text_contains hit', evaluateRule(
    { kind: 'wa_text_contains', substrings: ['acasă'] },
    wa({}),
))
check('wa_text_contains miss', !evaluateRule(
    { kind: 'wa_text_contains', substrings: ['xyz'] },
    wa({}),
))
check('wa_mention hit', evaluateRule(
    { kind: 'wa_mention', mentions: ['40987'] },
    wa({ mentions: ['40987'] }),
))

// ============================================================================
// 3. Home Assistant transition semantics
// ============================================================================
check('ha_state_equals fires on transition off→on', evaluateRule(
    { kind: 'ha_state_equals', entityId: 'binary_sensor.garage_door', state: 'on' },
    ha({ state: 'on', previousState: 'off' }),
))
check('ha_state_equals does NOT fire on steady state on→on', !evaluateRule(
    { kind: 'ha_state_equals', entityId: 'binary_sensor.garage_door', state: 'on' },
    ha({ state: 'on', previousState: 'on' }),
))
check('ha_state_equals fires on first observation matching', evaluateRule(
    { kind: 'ha_state_equals', entityId: 'binary_sensor.garage_door', state: 'on' },
    ha({ state: 'on', previousState: null }),
))
check('ha_state_changes fires on any transition', evaluateRule(
    { kind: 'ha_state_changes', entityId: 'binary_sensor.garage_door' },
    ha({ state: 'on', previousState: 'off' }),
))
check('ha_state_changes does NOT fire on steady state', !evaluateRule(
    { kind: 'ha_state_changes', entityId: 'binary_sensor.garage_door' },
    ha({ state: 'on', previousState: 'on' }),
))
check('ha_state_changes does NOT fire on first observation', !evaluateRule(
    { kind: 'ha_state_changes', entityId: 'binary_sensor.garage_door' },
    ha({ state: 'on', previousState: null }),
))
check('ha_attribute_changes fires on attribute diff', evaluateRule(
    { kind: 'ha_attribute_changes', entityId: 'binary_sensor.garage_door', attribute: 'battery' },
    ha({}),
))
check('ha_attribute_changes does NOT fire when attribute unchanged', !evaluateRule(
    { kind: 'ha_attribute_changes', entityId: 'binary_sensor.garage_door', attribute: 'friendly_name' },
    ha({}),
))
check('ha_threshold fires on crossing 30°→31°', evaluateRule(
    { kind: 'ha_threshold', entityId: 'sensor.temp', op: '>', value: 30 },
    ha({ entityId: 'sensor.temp', state: '31', numericValue: 31, previousNumericValue: 29 }),
))
check('ha_threshold does NOT fire steady above', !evaluateRule(
    { kind: 'ha_threshold', entityId: 'sensor.temp', op: '>', value: 30 },
    ha({ entityId: 'sensor.temp', state: '32', numericValue: 32, previousNumericValue: 31 }),
))
check('ha_threshold fires on first obs above', evaluateRule(
    { kind: 'ha_threshold', entityId: 'sensor.temp', op: '>', value: 30 },
    ha({ entityId: 'sensor.temp', state: '32', numericValue: 32, previousNumericValue: null }),
))

// ============================================================================
// 4. Web predicates
// ============================================================================
check('web_status equals', evaluateRule(
    { kind: 'web_status', url: 'https://example.com/status', op: 'equals', value: 200 },
    web({ status: 200 }),
))
check('web_status changes 200→500', evaluateRule(
    { kind: 'web_status', url: 'https://example.com/status', op: 'changes' },
    web({ status: 500, previousStatus: 200 }),
))
check('web_status changes false when same', !evaluateRule(
    { kind: 'web_status', url: 'https://example.com/status', op: 'changes' },
    web({ status: 200, previousStatus: 200 }),
))
check('web_json_path equals on nested', evaluateRule(
    { kind: 'web_json_path', url: 'https://example.com/status', jsonPath: 'items[0].available', op: 'equals', value: true },
    web({}),
))
check('web_json_path changes detects flip', evaluateRule(
    { kind: 'web_json_path', url: 'https://example.com/status', jsonPath: 'items[0].available', op: 'changes' },
    web({}),
))
check('web_text_contains hit', evaluateRule(
    { kind: 'web_text_contains', url: 'https://example.com/status', substrings: ['available'] },
    web({}),
))
check('web rules return false when URL mismatches', !evaluateRule(
    { kind: 'web_status', url: 'https://other.com', op: 'equals', value: 200 },
    web({ url: 'https://example.com/status', status: 200 }),
))

// ============================================================================
// 5. Cross-source defensive
// ============================================================================
check('gmail rule on HA candidate → false', !evaluateRule(
    { kind: 'gmail_from', senders: ['mom@x'] },
    ha({}) as EvalCandidate,
))
check('HA rule on web candidate → false', !evaluateRule(
    { kind: 'ha_state_changes', entityId: 'x' },
    web({}) as EvalCandidate,
))

// ============================================================================
// 6. Composition
// ============================================================================
check('any_of fires when first leaf hits', evaluateRule(
    { kind: 'any_of', rules: [
        { kind: 'gmail_from', senders: ['mom@example.com'] },
        { kind: 'gmail_subject_contains', substrings: ['nope'] },
    ] },
    gmail({ from: 'mom@example.com', subject: 'sth' }),
))
check('all_of fires only when both hit', evaluateRule(
    { kind: 'all_of', rules: [
        { kind: 'gmail_from', senders: ['mom@example.com'] },
        { kind: 'gmail_subject_contains', substrings: ['urgent'] },
    ] },
    gmail({}),
))
check('all_of misses when one fails', !evaluateRule(
    { kind: 'all_of', rules: [
        { kind: 'gmail_from', senders: ['mom@example.com'] },
        { kind: 'gmail_subject_contains', substrings: ['no-match'] },
    ] },
    gmail({}),
))
// Edge: empty arrays would never validate via Zod, but the evaluator must be safe.
check('any_of empty = false', !evaluateRule({ kind: 'any_of', rules: [] }, gmail({})))
check('all_of empty = true (vacuous)', evaluateRule({ kind: 'all_of', rules: [] }, gmail({})))

// ============================================================================
// 7. jsonPath + jsonEquals
// ============================================================================
check('jsonPathGet dot+array', jsonPathGet({ a: { b: [{ c: 42 }] } }, 'a.b[0].c') === 42)
check('jsonPathGet missing returns undefined', jsonPathGet({ a: 1 }, 'a.b.c') === undefined)
check('jsonEquals primitives', jsonEquals(1, 1) && !jsonEquals(1, 2))
check('jsonEquals arrays', jsonEquals([1, 2, [3]], [1, 2, [3]]))
check('jsonEquals objects key-order independent', jsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 }))
check('jsonEquals null/undefined', jsonEquals(null, null) && !jsonEquals(null, undefined))

// ============================================================================
// 8. Rule-target extractors
// ============================================================================
const multiUrl: MonitorRule = {
    kind: 'any_of', rules: [
        { kind: 'web_status', url: 'https://a.com', op: 'equals', value: 200 },
        { kind: 'web_json_path', url: 'https://b.com', jsonPath: 'x', op: 'changes' },
        { kind: 'web_status', url: 'https://a.com', op: 'changes' }, // dup
    ],
}
check('extractUrlsFromRule distinct', JSON.stringify(extractUrlsFromRule(multiUrl).sort()) === JSON.stringify(['https://a.com', 'https://b.com']))

const multiEntity: MonitorRule = {
    kind: 'all_of', rules: [
        { kind: 'ha_threshold', entityId: 'sensor.a', op: '>', value: 10 },
        { kind: 'ha_state_changes', entityId: 'sensor.b' },
    ],
}
check('extractEntityIdsFromRule distinct', JSON.stringify(extractEntityIdsFromRule(multiEntity).sort()) === JSON.stringify(['sensor.a', 'sensor.b']))

const waRule: MonitorRule = {
    kind: 'any_of', rules: [
        { kind: 'wa_from', contacts: ['Mom', 'Dad'] },
        { kind: 'wa_text_contains', substrings: ['urgent'] },
    ],
}
check('extractWaContactsFromRule', JSON.stringify(extractWaContactsFromRule(waRule).sort()) === JSON.stringify(['Dad', 'Mom']))

// ============================================================================
// 9. Gmail query builder
// ============================================================================
{
    const q = buildGmailQueryFromRule({
        kind: 'any_of', rules: [
            { kind: 'gmail_from', senders: ['mom@example.com'] },
            { kind: 'gmail_subject_contains', substrings: ['urgent', 'asap'] },
        ],
    })
    check('buildGmailQueryFromRule senders+subjects', q !== null && q.includes('from:mom@example.com') && q.includes('subject:urgent') && q.includes('subject:asap'))
}
{
    const q = buildGmailQueryFromRule({ kind: 'gmail_query', q: 'is:unread newer_than:1d' })
    check('buildGmailQueryFromRule passes raw query through', q === 'is:unread newer_than:1d')
}
check('buildGmailQueryFromRule returns null on non-gmail rule', buildGmailQueryFromRule({ kind: 'web_status', url: 'https://x', op: 'equals', value: 200 }) === null)
{
    const q = buildGmailQueryFromRule({ kind: 'gmail_subject_contains', substrings: ['has spaces in it'] })
    check('Gmail query quotes tokens with spaces', q?.includes('subject:"has spaces in it"') === true)
}

// ============================================================================
// 10. Source registry
// ============================================================================
check('registry returns gmail adapter', getSourceAdapter('gmail').source === 'gmail')
check('registry returns web adapter', getSourceAdapter('web').source === 'web')
check('registry returns ha adapter', getSourceAdapter('home_assistant').source === 'home_assistant')
check('registry returns wa adapter', getSourceAdapter('whatsapp').source === 'whatsapp')
check('registry returns custom adapter (stub)', getSourceAdapter('custom').source === 'custom')

const caps = listSourceCapabilities()
check('listSourceCapabilities covers all sources', caps.length === 5)

check('ruleMatchesSource accepts gmail rule on gmail', ruleMatchesSource(
    { kind: 'gmail_from', senders: ['x@y'] },
    'gmail',
))
check('ruleMatchesSource rejects HA rule on gmail', !ruleMatchesSource(
    { kind: 'ha_state_changes', entityId: 'x' },
    'gmail',
))
check('ruleMatchesSource accepts composed homogeneous rule', ruleMatchesSource(
    { kind: 'any_of', rules: [
        { kind: 'gmail_from', senders: ['x@y'] },
        { kind: 'gmail_subject_contains', substrings: ['z'] },
    ] },
    'gmail',
))
check('ruleMatchesSource rejects mixed-source composition', !ruleMatchesSource(
    { kind: 'any_of', rules: [
        { kind: 'gmail_from', senders: ['x@y'] },
        { kind: 'ha_state_changes', entityId: 'sensor.x' },
    ] },
    'gmail',
))

expectThrow('assertRuleMatchesSource throws on mismatch', () => assertRuleMatchesSource(
    { kind: 'web_status', url: 'https://x', op: 'equals', value: 200 },
    'gmail',
))

// Sanity: RULE_KINDS_BY_SOURCE has the expected counts and no duplicates.
check('RULE_KINDS_BY_SOURCE gmail count', RULE_KINDS_BY_SOURCE.gmail.length === 4)
check('RULE_KINDS_BY_SOURCE home_assistant count', RULE_KINDS_BY_SOURCE.home_assistant.length === 4)
check('RULE_KINDS_BY_SOURCE web count', RULE_KINDS_BY_SOURCE.web.length === 3)
check('RULE_KINDS_BY_SOURCE whatsapp count', RULE_KINDS_BY_SOURCE.whatsapp.length === 3)
check('RULE_KINDS_BY_SOURCE custom is empty', RULE_KINDS_BY_SOURCE.custom.length === 0)

console.log(`\n${failures === 0 ? '✅ ALL OK' : `❌ ${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
