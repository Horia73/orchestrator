import assert from "node:assert/strict"

import { claudeModelNameFromId } from "@/lib/cli/model-probe"

assert.equal(claudeModelNameFromId("claude-sonnet-5"), "Sonnet 5")
assert.equal(claudeModelNameFromId("claude-sonnet-5[1m]"), "Sonnet 5 (1M context)")
assert.equal(claudeModelNameFromId("claude-opus-4-8"), "Opus 4.8")
assert.equal(claudeModelNameFromId("claude-opus-4-8[1m]"), "Opus 4.8 (1M context)")
assert.equal(claudeModelNameFromId("claude-haiku-4-5-20251001"), "Haiku 4.5")
assert.equal(claudeModelNameFromId("claude-3-5-sonnet-20241022"), "Sonnet 3.5")
assert.equal(claudeModelNameFromId("not-claude-sonnet-5"), null)

console.log("claude model probe smoke passed")
