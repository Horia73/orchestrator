import assert from "node:assert/strict"

import { parseClaudeUsageText } from "../lib/cli/usage"
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

console.log("cli usage smoke passed")
