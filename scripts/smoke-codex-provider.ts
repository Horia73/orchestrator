import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isTransientCodexAppServerError, mapEffortForCodex } from "@/lib/ai/providers/codex"
import { clearCodexAuthFiles, codexAuthRejectedByBoth } from "@/lib/cli/codex-env"
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

assert.equal(
  codexAuthRejectedByBoth(
    'GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; code: "token_expired"',
    "Codex quota endpoint rejected auth after an automatic refresh."
  ),
  true,
  "Dual Codex auth rejection should invalidate dead credentials"
)
assert.equal(
  codexAuthRejectedByBoth(
    "Timed out waiting for Codex app-server rate limits.",
    "Codex quota endpoint rejected auth after an automatic refresh."
  ),
  false,
  "One endpoint failure must not invalidate credentials when model auth was inconclusive"
)

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

const authFixtureRoot = mkdtempSync(join(tmpdir(), "orchestrator-codex-logout-"))
try {
  const runtimeAuth = join(authFixtureRoot, "runtime", ".codex", "auth.json")
  const sourceAuth = join(authFixtureRoot, "source", ".codex", "auth.json")
  mkdirSync(join(runtimeAuth, ".."), { recursive: true })
  mkdirSync(join(sourceAuth, ".."), { recursive: true })
  writeFileSync(runtimeAuth, '{"tokens":"runtime"}')
  writeFileSync(sourceAuth, '{"tokens":"source"}')

  clearCodexAuthFiles([runtimeAuth, sourceAuth])

  assert.equal(existsSync(runtimeAuth), false, "Codex logout must remove the isolated runtime credentials")
  assert.equal(existsSync(sourceAuth), false, "Codex logout must remove the source credentials that seed the runtime")
} finally {
  rmSync(authFixtureRoot, { recursive: true, force: true })
}

console.log("smoke-codex-provider: ok")
