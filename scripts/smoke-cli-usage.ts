import assert from "node:assert/strict"

import { claudeUsageHeaderShowsApiBilling, isClaudeApiUsageBillingText, parseClaudeUsageText } from "../lib/cli/usage"
import { normalizeTimezone } from "../lib/timezone"

assert.equal(normalizeTimezone("Europe/Buchrest"), "Europe/Bucharest")
assert.equal(normalizeTimezone(undefined, "Europe/Buchrest"), "Europe/Bucharest")

const parsed = parseClaudeUsageText(`
Current session
11% used
Resets 2:40am (Europe/Buchrest)

Current week (all models)
7% used
Resets Jun 30 (Europe/Buchrest)

Current week (Sonnet only)
3% used
Resets Jun 30 (Europe/Bucharest)
`)

assert.equal(parsed.fiveHour?.usedPercent, 11)
assert.ok(Number.isFinite(parsed.fiveHour?.resetsAt), "five-hour reset should parse")
assert.ok((parsed.fiveHour?.resetsAt ?? 0) > 0, "five-hour reset should be positive")

assert.equal(parsed.weekly?.usedPercent, 7)
assert.ok(Number.isFinite(parsed.weekly?.resetsAt), "weekly reset should parse")
assert.ok((parsed.weekly?.resetsAt ?? 0) > 0, "weekly reset should be positive")

assert.equal(parsed.weeklySonnet?.usedPercent, 3)
assert.ok(Number.isFinite(parsed.weeklySonnet?.resetsAt), "sonnet reset should parse")
assert.ok((parsed.weeklySonnet?.resetsAt ?? 0) > 0, "sonnet reset should be positive")

const API_BILLING_PANEL = `
Claude Code v2.1.196
Opus 4.8 (1M context) · API Usage Billing

Usage Stats
Session
Total cost: $0.0000
Total duration (API): 0s
Usage: 0 input, 0 output, 0 cache read, 0 cache write
`
assert.equal(isClaudeApiUsageBillingText(API_BILLING_PANEL), true)
assert.equal(claudeUsageHeaderShowsApiBilling(API_BILLING_PANEL), true)

assert.equal(isClaudeApiUsageBillingText(`
Usage Stats
Session
Total cost: $0.0000
Total duration (API): 0s
Usage: 0 input, 0 output, 0 cache read, 0 cache write
Esc to cancel
`), true)

// The TUI's absolute positioning can swallow the banner's spaces.
assert.equal(claudeUsageHeaderShowsApiBilling("Opus 4.8·APIUsageBilling"), true)

// Subscription tabbed panel (claude 2.1.197 capture): the tab bar reads
// "Settings Status Config Usage Stats" and a session-cost section renders
// alongside the plan quota — it must parse as quota, not as API billing, and
// the banner ("· Claude API" here) must not read as API-key billing.
const SUBSCRIPTION_TABBED_PANEL = `
ClaudeCode v2.1.197
Sonnet5·ClaudeAPI

Settings Status Config Usage Stats
Session
Total cst: $0.0000
Total duration (API): 0s
Usage: 0 input, 0 output, 0 cache read, 0 cache write
Current session ██████████████████████ 44%used Resets 1:10am (UTC)
Current week (all models) █████████████▌ 27%used Resets Jul 3, 4pm (UTC)
What's contributing to your limits usage?
Scanning local sessions… Refreshing… Esc to cancel
`
const tabbed = parseClaudeUsageText(SUBSCRIPTION_TABBED_PANEL)
assert.equal(tabbed.fiveHour?.usedPercent, 44)
assert.ok((tabbed.fiveHour?.resetsAt ?? 0) > 0, "tabbed five-hour reset should parse")
assert.equal(tabbed.weekly?.usedPercent, 27)
assert.ok((tabbed.weekly?.resetsAt ?? 0) > 0, "tabbed weekly reset should parse")
assert.equal(isClaudeApiUsageBillingText(SUBSCRIPTION_TABBED_PANEL), false)
assert.equal(claudeUsageHeaderShowsApiBilling(SUBSCRIPTION_TABBED_PANEL), false)

// The same panel BEFORE the quota windows load: session stats visible, no
// quota yet. The content heuristic alone matches (that is why it must be
// gated on the banner) — the banner check is what keeps the scrape waiting.
const SUBSCRIPTION_PANEL_LOADING = `
ClaudeCode v2.1.197
Sonnet5·ClaudeAPI

Settings Status Config Usage Stats
Session
Total cost: $0.0000
Usage: 0 input, 0 output, 0 cache read, 0 cache write
Loading…
`
assert.equal(isClaudeApiUsageBillingText(SUBSCRIPTION_PANEL_LOADING), true)
assert.equal(claudeUsageHeaderShowsApiBilling(SUBSCRIPTION_PANEL_LOADING), false)

console.log("cli usage smoke passed")
