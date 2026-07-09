import assert from "node:assert/strict"

import { isTransientCodexAppServerError, mapEffortForCodex } from "@/lib/ai/providers/codex"
import { codexModelsToLiveEntries, type CodexListedModel } from "@/lib/cli/codex-model-probe"

assert.equal(
  isTransientCodexAppServerError("Reconnecting... 2/5"),
  true,
  "Codex reconnect progress should be treated as transient"
)
assert.equal(
  isTransientCodexAppServerError(" Reconnecting… 4/5 "),
  true,
  "Codex reconnect progress may use an ellipsis and whitespace"
)
assert.equal(
  isTransientCodexAppServerError("Reconnecting failed"),
  false,
  "Reconnect failure text should remain terminal"
)
assert.equal(
  isTransientCodexAppServerError("codex app-server error"),
  false,
  "Generic app-server errors should remain terminal"
)

assert.equal(mapEffortForCodex("max"), "max", "Codex max effort must not be downgraded")
assert.equal(mapEffortForCodex("ultra"), "ultra", "New Codex effort ids should pass through")

const listedModels: CodexListedModel[] = [
  {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    hidden: false,
    isDefault: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "max", description: "Maximum" },
      { reasoningEffort: "ultra", description: "Delegated maximum" },
    ],
    defaultReasoningEffort: "low",
    inputModalities: ["text", "image"],
  },
  {
    id: "codex-auto-review",
    model: "codex-auto-review",
    displayName: "Codex Auto Review",
    description: "Internal model.",
    hidden: true,
    isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    defaultReasoningEffort: "medium",
  },
]

const liveModels = codexModelsToLiveEntries(listedModels)
assert.deepEqual(Object.keys(liveModels), ["gpt-5.6-sol"], "Hidden Codex models must stay out of the picker")
assert.equal(liveModels["gpt-5.6-sol"].name, "GPT-5.6-Sol")
assert.deepEqual(liveModels["gpt-5.6-sol"].thinkingLevels, ["low", "max", "ultra"])
assert.equal(liveModels["gpt-5.6-sol"].defaultThinkingLevel, "low")
assert.deepEqual(liveModels["gpt-5.6-sol"].pricing, { kind: "subscription" })
assert.deepEqual(liveModels["gpt-5.6-sol"].capabilities, ["text", "function_calling"])

console.log("smoke-codex-provider: ok")
