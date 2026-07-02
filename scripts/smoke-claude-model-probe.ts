import assert from "node:assert/strict"

import { claudeModelNameFromId, parseClaudeModelAliasesFromHelp } from "@/lib/cli/model-probe"

assert.equal(claudeModelNameFromId("claude-sonnet-5"), "Sonnet 5")
assert.equal(claudeModelNameFromId("claude-sonnet-5[1m]"), "Sonnet 5 (1M context)")
assert.equal(claudeModelNameFromId("claude-opus-4-8"), "Opus 4.8")
assert.equal(claudeModelNameFromId("claude-opus-4-8[1m]"), "Opus 4.8 (1M context)")
assert.equal(claudeModelNameFromId("claude-haiku-4-5-20251001"), "Haiku 4.5")
assert.equal(claudeModelNameFromId("claude-fable-5"), "Fable 5")
assert.equal(claudeModelNameFromId("claude-3-5-sonnet-20241022"), "Sonnet 3.5")
assert.equal(claudeModelNameFromId("not-claude-sonnet-5"), null)

// Alias discovery — pinned against the claude 2.1.198 --help wording. Aliases
// come from the quoted examples; full ids ('claude-fable-5') are excluded, and
// the block must stop before the next option flag.
const HELP_SNIPPET = `
Options:
  --fallback-model <model>              Enable automatic fallback to specified
                                        model(s) when the default model is
                                        overloaded or not available.
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
                                        (shown in the prompt box with 'quotes')
`
assert.deepEqual(
    parseClaudeModelAliasesFromHelp(HELP_SNIPPET).sort(),
    ["fable", "opus", "sonnet"]
)
assert.deepEqual(parseClaudeModelAliasesFromHelp("no model flag here"), [])

console.log("claude model probe smoke passed")
