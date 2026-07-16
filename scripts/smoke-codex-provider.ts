import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CodexProvider,
  codexProviderTestHooks,
  isTransientCodexAppServerError,
  mapEffortForCodex,
} from "@/lib/ai/providers/codex"
import { delegateToTool } from "@/lib/ai/tools/delegate-to"
import { codexImageTestHooks, generateCodexImage } from "@/lib/ai/providers/codex-image"
import { imageGenerator } from "@/lib/ai/agents/image-generator"
import { migrateLegacyAgentModelSelection } from "@/lib/config"
import { clearCodexAuthFiles, codexAuthRejectedByBoth } from "@/lib/cli/codex-env"
import { codexModelsToLiveEntries, type CodexListedModel } from "@/lib/cli/codex-model-probe"
import { CODEX_CLI_PACKAGE } from "@/lib/cli/specs"
import { getEffectiveModel } from "@/lib/models/registry"

assert.ok(
  new CodexProvider("").capabilities.kinds.includes("image"),
  "Codex provider should advertise image generation"
)
assert.equal(imageGenerator.provider, "codex", "Image Generator should default to the Codex subscription route")
assert.equal(imageGenerator.model, "imagegen")
assert.deepEqual(
  migrateLegacyAgentModelSelection("image_generator", "google", "gemini-3.1-flash-image"),
  { provider: "codex", model: "imagegen", migrated: true },
  "The retired per-profile Gemini image override should move to Codex ImageGen"
)
assert.deepEqual(
  migrateLegacyAgentModelSelection("image_generator", "google", "gemini-3.1-flash-image-preview"),
  { provider: "google", model: "gemini-3.1-flash-image-preview", migrated: false },
  "The current Google image route must remain an explicit selectable alternative"
)
const imagegenModel = getEffectiveModel("codex", "imagegen")
assert.ok(imagegenModel?.kinds.includes("image"), "Codex ImageGen should be a selectable image model")
assert.deepEqual(imagegenModel?.pricing, { kind: "subscription" })

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

const managedAppServerArgs = codexProviderTestHooks.buildAppServerArgs(false, ["web_search"])
assert.ok(
  managedAppServerArgs.includes('features.code_mode.direct_only_tool_namespaces=["orchestrator"]'),
  "Managed Codex runs must keep the Orchestrator namespace direct and blocking"
)
const nativeCoderAppServerArgs = codexProviderTestHooks.buildAppServerArgs(true, [])
assert.equal(
  nativeCoderAppServerArgs.some(arg => arg.includes("direct_only_tool_namespaces")),
  false,
  "Native coder runs have no Orchestrator dynamic-tool namespace override"
)
const managedThreadParams = codexProviderTestHooks.buildThreadParams({
  model: "gpt-5.6-sol",
  tools: [delegateToTool],
  builtins: ["web_search"],
  nativeCoderRun: false,
  cwd: "/tmp/orchestrator-codex-provider-smoke",
})
type CodexThreadConfig = {
  features?: { code_mode?: { direct_only_tool_namespaces?: string[] } }
  multi_agent_v2?: { multi_agent_mode_hint_text?: string }
}
const managedThreadConfig = managedThreadParams.config as CodexThreadConfig
assert.deepEqual(
  managedThreadConfig.features?.code_mode?.direct_only_tool_namespaces,
  ["orchestrator"],
  "Managed thread configuration must keep Orchestrator tools direct even when the model forces code_mode_only"
)
assert.deepEqual(
  managedThreadParams.dynamicTools,
  [{
    type: "namespace",
    name: "orchestrator",
    description: "Tools provided by Orchestrator for managed workflows, integrations, and specialist delegation.",
    tools: [{
      type: "function",
      name: delegateToTool.name,
      description: delegateToTool.description,
      inputSchema: delegateToTool.input_schema,
    }],
  }],
  "Managed dynamic tools must use the official namespaced app-server schema"
)
assert.match(
  managedThreadConfig.multi_agent_v2?.multi_agent_mode_hint_text ?? "",
  /delegate_to or delegate_parallel/,
  "Managed Codex runs must receive the Orchestrator delegation policy override"
)
assert.match(
  managedThreadConfig.multi_agent_v2?.multi_agent_mode_hint_text ?? "",
  /explicit user request for sub-agents is not required/,
  "Codex must not suppress Orchestrator-managed delegation on non-Ultra runs"
)
const nativeCoderThreadParams = codexProviderTestHooks.buildThreadParams({
  model: "gpt-5.6-sol",
  tools: [],
  builtins: [],
  nativeCoderRun: true,
})
const nativeCoderThreadConfig = nativeCoderThreadParams.config as CodexThreadConfig
assert.equal(
  nativeCoderThreadConfig.features?.code_mode,
  undefined,
  "Native coder thread configuration should not override Codex tool exposure"
)
assert.equal(
  nativeCoderThreadConfig.multi_agent_v2,
  undefined,
  "Native coder runs must retain Codex's own multi-agent policy"
)

const legacyManagedSession = codexProviderTestHooks.decodeAppServerSessionId("appserver:legacy-thread")
assert.deepEqual(
  legacyManagedSession,
  { threadId: "legacy-thread" },
  "Unversioned app-server sessions must remain resumable"
)
const directManagedSessionId = codexProviderTestHooks.encodeAppServerSessionId("direct-thread")
assert.equal(directManagedSessionId, "appserver:direct-thread")
assert.deepEqual(
  codexProviderTestHooks.decodeAppServerSessionId("appserver:direct:legacy-direct-thread"),
  { threadId: "legacy-direct-thread" },
  "Former appserver:direct sessions must migrate through normal resume"
)
assert.equal(CODEX_CLI_PACKAGE, "@openai/codex@0.144.4", "Codex installer must use the production-verified release")
assert.match(
  readFileSync(join(process.cwd(), "scripts/docker-update-bridge.py"), "utf8"),
  /@openai\/codex@0\.144\.4/,
  "Docker CLI updates must use the same production-verified Codex release"
)

const directToolFixtureRoot = mkdtempSync(join(tmpdir(), "orchestrator-codex-direct-tools-"))
try {
  const fakeCodex = join(directToolFixtureRoot, "fake-codex.mjs")
  const capturePath = join(directToolFixtureRoot, "capture.json")
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import readline from "node:readline"
import { writeFileSync } from "node:fs"

const send = value => process.stdout.write(JSON.stringify(value) + "\\n")
const parentViolation = process.env.FAKE_PARENT_VIOLATION === "1"
const asyncDelegation = process.env.FAKE_ASYNC_DELEGATION === "1"
const rl = readline.createInterface({ input: process.stdin })
rl.on("line", line => {
  const message = JSON.parse(line)
  if (message.id === 700 && !message.method) {
    send({ method: "item/completed", params: { item: {
      id: "delegate-call", type: "dynamicToolCall", namespace: "orchestrator", tool: "delegate_to",
      status: "completed", success: false, contentItems: [{ type: "inputText", text: "diagnostic failure" }],
    } } })
    if (asyncDelegation) {
      send({ method: "item/started", params: { item: {
        id: "allowed-shell", type: "commandExecution", command: "git status --short", cwd: "/tmp",
      } } })
      send({ method: "item/commandExecution/outputDelta", params: {
        itemId: "allowed-shell", delta: "M package.json\\n",
      } })
      send({ method: "item/completed", params: { item: {
        id: "allowed-shell", type: "commandExecution", command: "git status --short", cwd: "/tmp",
        status: "completed", exitCode: 0, aggregatedOutput: "M package.json\\n",
      } } })
    }
    if (!parentViolation) {
      send({ method: "item/agentMessage/delta", params: { itemId: "final-message", delta: "DONE" } })
      send({ method: "item/completed", params: { item: { id: "final-message", type: "agentMessage", text: "DONE" } } })
      send({ method: "turn/completed", params: { turn: { id: "fake-turn", status: "completed" } } })
    }
    return
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } })
    return
  }
  if (message.method === "thread/resume") {
    writeFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({ method: message.method, params: message.params }))
    send({ id: message.id, result: { thread: { id: message.params.threadId } } })
    return
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "fresh-thread" } } })
    return
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} })
    send({ method: "turn/completed", params: { turn: { id: "fake-turn", status: "interrupted" } } })
    return
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "fake-turn" } } })
    send({ method: "turn/started", params: { turn: { id: "fake-turn" } } })
    send({ method: "item/started", params: { item: {
      id: "pre-delegation-reasoning", type: "reasoning",
    } } })
    send({ method: "item/reasoning/summaryTextDelta", params: {
      itemId: "pre-delegation-reasoning", delta: "Delegate synchronously.",
    } })
    send({ method: "item/started", params: { item: {
      id: "delegate-call", type: "dynamicToolCall", namespace: "orchestrator", tool: "delegate_to",
      status: "inProgress", arguments: { agent_id: "browser_agent", prompt: "diagnostic", ...(asyncDelegation ? { run_async: true } : {}) },
    } } })
    send({ id: 700, method: "item/tool/call", params: {
      callId: "delegate-call", namespace: "orchestrator", tool: "delegate_to",
      arguments: { agent_id: "browser_agent", prompt: "diagnostic", ...(asyncDelegation ? { run_async: true } : {}) },
    } })
    // Codex 0.144.4 can close the already-started reasoning item after the
    // direct client tool request is in flight. This is stream tail, not the
    // parent resuming, and must not trip the fail-closed guard.
    send({ method: "item/completed", params: { item: {
      id: "pre-delegation-reasoning", type: "reasoning",
    } } })
    if (parentViolation) {
      send({ method: "item/started", params: { item: {
        id: "forbidden-shell", type: "commandExecution", command: "git status --short", cwd: "/tmp",
      } } })
      send({ method: "item/commandExecution/outputDelta", params: {
        itemId: "forbidden-shell", delta: "M package.json\\n",
      } })
    }
  }
})
`)
  chmodSync(fakeCodex, 0o755)

  const content: string[] = []
  const sessions: string[] = []
  const errors: string[] = []
  const toolCalls: string[] = []
  const previousCapturePath = process.env.FAKE_CAPTURE_PATH
  process.env.FAKE_CAPTURE_PATH = capturePath
  try {
    await codexProviderTestHooks.runCodexAppServer({
      bin: fakeCodex,
      prompt: "Run the diagnostic.",
      model: "gpt-5.6-sol",
      tools: [delegateToTool],
      builtins: [],
      prevSession: { threadId: "legacy-thread" },
      nativeCoderRun: false,
      callbacks: {
        onThinking() {},
        onThinkingDone() {},
        onContent(text) { content.push(text) },
        onToolCall(call) { toolCalls.push(call.name) },
        onToolResult() {},
        onDone(meta) { if (meta.sessionId) sessions.push(meta.sessionId) },
        onError(error) { errors.push(error) },
      },
    })
  } finally {
    if (previousCapturePath === undefined) delete process.env.FAKE_CAPTURE_PATH
    else process.env.FAKE_CAPTURE_PATH = previousCapturePath
  }

  assert.deepEqual(errors, [], "A direct namespaced delegation must finish without provider errors")
  assert.equal(content.join(""), "DONE", "The parent may resume only after the delegation item completes")
  assert.deepEqual(toolCalls, ["delegate_to"], "The direct path must not create an exec/wait/shell wrapper")
  assert.deepEqual(sessions, ["appserver:legacy-thread"])
  const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
    method: string
    params: {
      threadId: string
      dynamicTools?: Array<{ type?: string; name?: string; tools?: Array<{ name?: string }> }>
      config?: { features?: { code_mode?: { direct_only_tool_namespaces?: string[] } } }
    }
  }
  assert.equal(capture.method, "thread/resume")
  assert.equal(capture.params.threadId, "legacy-thread")
  assert.equal(capture.params.dynamicTools?.[0]?.type, "namespace")
  assert.equal(capture.params.dynamicTools?.[0]?.name, "orchestrator")
  assert.equal(capture.params.dynamicTools?.[0]?.tools?.[0]?.name, "delegate_to")
  assert.deepEqual(
    capture.params.config?.features?.code_mode?.direct_only_tool_namespaces,
    ["orchestrator"],
    "thread/resume must replace a legacy flat catalog with direct-only namespaced tools"
  )

  const violationErrors: string[] = []
  const violationToolCalls: string[] = []
  process.env.FAKE_PARENT_VIOLATION = "1"
  try {
    await codexProviderTestHooks.runCodexAppServer({
      bin: fakeCodex,
      prompt: "Exercise the fail-closed guard.",
      model: "gpt-5.6-sol",
      tools: [delegateToTool],
      builtins: [],
      nativeCoderRun: false,
      callbacks: {
        onThinking() {},
        onThinkingDone() {},
        onContent() {},
        onToolCall(call) { violationToolCalls.push(call.name) },
        onToolResult() {},
        onDone() {},
        onError(error) { violationErrors.push(error) },
      },
    })
  } finally {
    delete process.env.FAKE_PARENT_VIOLATION
  }
  assert.equal(violationErrors.length, 1, "A resumed parent must fail closed exactly once")
  assert.match(violationErrors[0] ?? "", /resumed the parent while a synchronous delegation was still running/)
  assert.deepEqual(
    violationToolCalls,
    ["delegate_to"],
    "Forbidden parent shell activity must be interrupted before it reaches the UI/tool log"
  )

  const asyncErrors: string[] = []
  const asyncToolCalls: string[] = []
  const asyncContent: string[] = []
  process.env.FAKE_ASYNC_DELEGATION = "1"
  try {
    await codexProviderTestHooks.runCodexAppServer({
      bin: fakeCodex,
      prompt: "Exercise explicit async delegation.",
      model: "gpt-5.6-sol",
      tools: [delegateToTool],
      builtins: [],
      nativeCoderRun: false,
      callbacks: {
        onThinking() {},
        onThinkingDone() {},
        onContent(text) { asyncContent.push(text) },
        onToolCall(call) { asyncToolCalls.push(call.name) },
        onToolResult() {},
        onDone() {},
        onError(error) { asyncErrors.push(error) },
      },
    })
  } finally {
    delete process.env.FAKE_ASYNC_DELEGATION
  }
  assert.deepEqual(asyncErrors, [], "run_async delegation must permit subsequent parent activity")
  assert.equal(asyncContent.join(""), "DONE")
  assert.deepEqual(
    asyncToolCalls,
    ["delegate_to", "shell"],
    "Explicit async delegation must attribute and surface both child launch and later parent tool work"
  )
} finally {
  rmSync(directToolFixtureRoot, { recursive: true, force: true })
}

assert.deepEqual(
  codexProviderTestHooks.buildCodexTurnInput("Inspect these.", [
    { filePath: "/tmp/photo.jpg", mimeType: "image/jpeg" },
    { filePath: "/tmp/notes.pdf", mimeType: "application/pdf" },
  ]),
  [
    { type: "text", text: "Inspect these.", text_elements: [] },
    { type: "localImage", path: "/tmp/photo.jpg" },
  ],
  "Codex should receive supported photos as localImage inputs without exposing arbitrary files"
)

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

const imageFixtureRoot = mkdtempSync(join(tmpdir(), "orchestrator-codex-image-smoke-"))
try {
  const fakeCodex = join(imageFixtureRoot, "fake-codex.mjs")
  const capturePath = join(imageFixtureRoot, "capture.json")
  const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import readline from "node:readline"
import path from "node:path"
import { existsSync, writeFileSync } from "node:fs"

const send = value => process.stdout.write(JSON.stringify(value) + "\\n")
const rl = readline.createInterface({ input: process.stdin })
rl.on("line", line => {
  const message = JSON.parse(line)
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } })
    return
  }
  if (message.method === "modelProvider/capabilities/read") {
    send({ id: message.id, result: {
      imageGeneration: process.env.FAKE_IMAGE_CAPABILITY !== "false",
      namespaceTools: true,
      webSearch: false,
    } })
    return
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "fake-image-thread" } } })
    return
  }
  if (message.method === "turn/start") {
    writeFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({
      args: process.argv.slice(2),
      cwd: process.cwd(),
      turn: message.params,
      referenceExists: existsSync(message.params.input[1]?.path ?? ""),
    }))
    const savedPath = path.join(process.cwd(), "fake-output.png")
    writeFileSync(savedPath, Buffer.from("${tinyPngBase64}", "base64"))
    send({ id: message.id, result: { turn: { id: "fake-turn" } } })
    send({ method: "item/completed", params: { item: {
      id: "fake-image-item",
      type: "imageGeneration",
      status: "completed",
      result: "",
      revisedPrompt: "revised smoke prompt",
      savedPath,
    } } })
    send({ method: "thread/tokenUsage/updated", params: { tokenUsage: { totalTokens: 7 } } })
    send({ method: "turn/completed", params: { turn: { id: "fake-turn", status: "completed" } } })
  }
})
`)
  chmodSync(fakeCodex, 0o755)

  const generated = await generateCodexImage({
    model: "imagegen",
    prompt: "Create a polished blue dashboard mockup.",
    aspectRatio: "16:9",
    referenceImages: [{ mimeType: "image/png", data: Buffer.from(tinyPngBase64, "base64") }],
  }, {
    bin: fakeCodex,
    env: { ...process.env, FAKE_CAPTURE_PATH: capturePath },
    timeoutMs: 5_000,
  })

  assert.equal(generated.images.length, 1)
  assert.equal(generated.images[0].mimeType, "image/png")
  assert.equal(generated.images[0].revisedPrompt, "revised smoke prompt")
  assert.deepEqual(generated.usage, { totalTokens: 7 })
  const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
    args: string[]
    cwd: string
    turn: { input: Array<{ type: string; text?: string; path?: string }> }
    referenceExists: boolean
  }
  assert.ok(capture.args.includes("features.image_generation=true"))
  assert.ok(capture.turn.input[0]?.text?.includes("Target aspect ratio: 16:9."))
  assert.equal(capture.turn.input[1]?.type, "localImage")
  assert.equal(capture.referenceExists, true, "Codex should receive a readable localImage path")
  assert.equal(existsSync(capture.cwd), false, "Codex ImageGen temp workspace should be cleaned")

  await assert.rejects(
    generateCodexImage({ model: "imagegen", prompt: "A blocked image." }, {
      bin: fakeCodex,
      env: {
        ...process.env,
        FAKE_CAPTURE_PATH: capturePath,
        FAKE_IMAGE_CAPABILITY: "false",
      },
      timeoutMs: 5_000,
    }),
    /does not expose image generation/
  )

  const inline = codexImageTestHooks.parseInlineImage(`data:image/png;base64,${tinyPngBase64}`)
  assert.equal(inline?.mimeType, "image/png")
  assert.ok(inline?.data.length)
} finally {
  rmSync(imageFixtureRoot, { recursive: true, force: true })
}

console.log("smoke-codex-provider: ok")
