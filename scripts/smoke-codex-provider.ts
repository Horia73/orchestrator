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
import { delegateAsyncTool, delegateToTool } from "@/lib/ai/tools/delegate-to"
import { codexImageTestHooks, generateCodexImage } from "@/lib/ai/providers/codex-image"
import { imageGenerator } from "@/lib/ai/agents/image-generator"
import { migrateLegacyAgentModelSelection } from "@/lib/config"
import { clearCodexAuthFiles, codexAuthRejectedByBoth } from "@/lib/cli/codex-env"
import { codexModelsToLiveEntries, type CodexListedModel } from "@/lib/cli/codex-model-probe"
import { CODEX_CLI_PACKAGE } from "@/lib/cli/specs"
import { getEffectiveModel } from "@/lib/models/registry"
import { latestUserPromptWithPortableHistory } from "@/lib/ai/providers/history"

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
for (const feature of ["multi_agent", "multi_agent_v2", "enable_fanout"]) {
  const index = managedAppServerArgs.findIndex((arg, offset) => arg === "--disable" && managedAppServerArgs[offset + 1] === feature)
  assert.ok(index >= 0, `Managed Codex process must hard-disable ${feature}`)
}
assert.ok(
  managedAppServerArgs.includes('features.code_mode.direct_only_tool_namespaces=["orchestrator"]'),
  "Managed Codex runs must keep the Orchestrator namespace direct and blocking"
)
const nativeCoderAppServerArgs = codexProviderTestHooks.buildAppServerArgs(true, [])
for (const feature of ["multi_agent", "multi_agent_v2", "enable_fanout"]) {
  const index = nativeCoderAppServerArgs.findIndex((arg, offset) => arg === "--disable" && nativeCoderAppServerArgs[offset + 1] === feature)
  assert.ok(index >= 0, `Native coder process must hard-disable ${feature}`)
}
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
  features?: {
    code_mode?: { direct_only_tool_namespaces?: string[] }
    multi_agent?: boolean
    multi_agent_v2?: boolean
    enable_fanout?: boolean
  }
}
const managedThreadConfig = managedThreadParams.config as CodexThreadConfig
assert.deepEqual(
  managedThreadConfig.features?.code_mode?.direct_only_tool_namespaces,
  ["orchestrator"],
  "Managed thread configuration must keep Orchestrator tools direct even when the model forces code_mode_only"
)
assert.equal(
  managedThreadConfig.features?.multi_agent,
  false,
  "Managed threads must disable stable Codex-native multi-agent tools"
)
assert.equal(
  managedThreadConfig.features?.multi_agent_v2,
  false,
  "Managed threads must disable Codex-native multi-agent v2 as a boolean feature"
)
assert.equal(
  managedThreadConfig.features?.enable_fanout,
  false,
  "Managed threads must disable Codex-native fan-out"
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
  nativeCoderThreadConfig.features?.multi_agent_v2,
  false,
  "Native coder runs must not expose Codex-native collaboration"
)

assert.equal(
  codexProviderTestHooks.decodeAppServerSessionId("appserver:legacy-managed-thread", false),
  undefined,
  "Managed sessions born before the standing delegation policy must refresh with portable history"
)
const managedSessionId = codexProviderTestHooks.encodeAppServerSessionId("managed-thread", false)
assert.equal(managedSessionId, "appserver:managed-policy-v8:managed-thread")
assert.deepEqual(
  codexProviderTestHooks.decodeAppServerSessionId(managedSessionId, false),
  { threadId: "managed-thread" },
  "Current managed app-server sessions must remain resumable"
)
assert.deepEqual(
  codexProviderTestHooks.decodeAppServerSessionId("appserver:legacy-native-thread", true),
  { threadId: "legacy-native-thread" },
  "Promptless native coder sessions must remain resumable across the managed-policy migration"
)
assert.deepEqual(
  codexProviderTestHooks.decodeAppServerSessionId("appserver:direct:legacy-direct-thread", true),
  { threadId: "legacy-direct-thread" },
  "Former appserver:direct native sessions must migrate through normal resume"
)
assert.equal(
  codexProviderTestHooks.decodeAppServerSessionId("appserver:direct:legacy-managed-thread", false),
  undefined,
  "Legacy direct managed sessions must refresh instead of retaining the stale Codex policy"
)
const migratedManagedPrompt = latestUserPromptWithPortableHistory([
  { role: "user", content: "Original request" },
  { role: "assistant", content: "Earlier answer" },
  { role: "user", content: "Continue with the browser agent" },
] as never, Boolean(
  codexProviderTestHooks.decodeAppServerSessionId("appserver:legacy-managed-thread", false)
))
assert.match(
  migratedManagedPrompt,
  /<conversation_history>[\s\S]*Original request[\s\S]*Earlier answer[\s\S]*<new_user_message>[\s\S]*Continue with the browser agent/,
  "Refreshing a stale managed Codex thread must carry the app conversation as portable history"
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
const steeredIntervention = process.env.FAKE_STEERED_INTERVENTION === "1"
const asyncDelegation = process.env.FAKE_ASYNC_DELEGATION === "1"
const nativeCollaboration = process.env.FAKE_NATIVE_COLLABORATION === "1"
const codeModeWait = process.env.FAKE_CODE_MODE_WAIT === "1"
const interleavedMessages = process.env.FAKE_INTERLEAVED_MESSAGES === "1"
const rl = readline.createInterface({ input: process.stdin })
rl.on("line", line => {
  const message = JSON.parse(line)
  if (message.id === 700 && !message.method) {
    send({ method: "item/completed", params: { item: {
      id: "delegate-call", type: "dynamicToolCall", namespace: "orchestrator", tool: asyncDelegation ? "delegate_async" : "delegate_to",
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
    if (process.env.FAKE_CAPTURE_PATH) {
      writeFileSync(process.env.FAKE_CAPTURE_PATH, JSON.stringify({ method: message.method, params: message.params }))
    }
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
  if (message.method === "turn/steer") {
    if (process.env.FAKE_INTERVENTION_CAPTURE) {
      writeFileSync(process.env.FAKE_INTERVENTION_CAPTURE, JSON.stringify(message.params))
    }
    send({ id: message.id, result: {} })
    if (steeredIntervention) {
      send({ method: "item/started", params: { item: {
        id: "intervention-shell", type: "commandExecution", command: "git status --short", cwd: "/tmp",
      } } })
      send({ method: "item/commandExecution/outputDelta", params: {
        itemId: "intervention-shell", delta: "M package.json\\n",
      } })
      send({ method: "item/completed", params: { item: {
        id: "intervention-shell", type: "commandExecution", command: "git status --short", cwd: "/tmp",
        status: "completed", exitCode: 0, aggregatedOutput: "M package.json\\n",
      } } })
    }
    return
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "fake-turn" } } })
    send({ method: "turn/started", params: { turn: { id: "fake-turn" } } })
    if (nativeCollaboration) {
      send({ method: "item/started", params: { turnId: "fake-turn", item: {
        id: "native-agent-call", type: "collabAgentToolCall", tool: "spawnAgent", status: "inProgress",
      } } })
      return
    }
    if (interleavedMessages) {
      send({ method: "item/started", params: { turnId: "fake-turn", item: {
        id: "message-a", type: "agentMessage",
      } } })
      send({ method: "item/started", params: { turnId: "fake-turn", item: {
        id: "message-b", type: "agentMessage",
      } } })
      send({ method: "item/agentMessage/delta", params: {
        turnId: "fake-turn", itemId: "message-a", delta: "First message.",
      } })
      send({ method: "item/agentMessage/delta", params: {
        turnId: "fake-turn", itemId: "message-b", delta: "Second message.",
      } })
      send({ method: "item/agentMessage/delta", params: {
        turnId: "stale-turn", itemId: "stale-message", delta: "MUST NOT LEAK",
      } })
      send({ method: "item/completed", params: { turnId: "fake-turn", item: {
        id: "message-a", type: "agentMessage", text: "First message.",
      } } })
      send({ method: "item/completed", params: { turnId: "fake-turn", item: {
        id: "message-b", type: "agentMessage", text: "Second message.",
      } } })
      send({ method: "turn/completed", params: { turn: { id: "fake-turn", status: "completed" } } })
      return
    }
    send({ method: "item/started", params: { item: {
      id: "pre-delegation-reasoning", type: "reasoning",
    } } })
    send({ method: "item/reasoning/summaryTextDelta", params: {
      itemId: "pre-delegation-reasoning", delta: "Delegate synchronously.",
    } })
    const delegationTool = asyncDelegation ? "delegate_async" : "delegate_to"
    const delegationArgs = asyncDelegation
      ? { jobs: [{ agent_id: "browser_agent", prompt: "diagnostic" }], independent_parent_work: "inspect repository status" }
      : { agent_id: "browser_agent", prompt: "diagnostic" }
    send({ method: "item/started", params: { item: {
      id: "delegate-call", type: "dynamicToolCall", namespace: "orchestrator", tool: delegationTool,
      status: "inProgress", arguments: delegationArgs,
    } } })
    send({ id: 700, method: "item/tool/call", params: {
      callId: "delegate-call", namespace: "orchestrator", tool: delegationTool,
      arguments: delegationArgs,
    } })
    // Codex 0.144.4 can close the already-started reasoning item after the
    // direct client tool request is in flight. This is stream tail, not the
    // parent resuming, and must not trip the fail-closed guard.
    send({ method: "item/completed", params: { item: {
      id: "pre-delegation-reasoning", type: "reasoning",
    } } })
    if (codeModeWait) {
      // A legacy flat dynamic tool can be called from inside Code Mode. Once
      // exec yields its live cell, Codex starts a small reasoning item before
      // issuing the provider-internal wait(cell_id) call. That reasoning must
      // stay invisible without being mistaken for parent work.
      send({ method: "item/started", params: { item: {
        id: "code-mode-wait-reasoning", type: "reasoning",
      } } })
      send({ method: "item/reasoning/summaryTextDelta", params: {
        itemId: "code-mode-wait-reasoning", delta: "Wait for the live Code Mode cell.",
      } })
      send({ method: "item/completed", params: { item: {
        id: "code-mode-wait-reasoning", type: "reasoning",
      } } })
    }
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
      spawnEnv: { FAKE_CAPTURE_PATH: capturePath },
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
  assert.deepEqual(sessions, ["appserver:managed-policy-v8:legacy-thread"])
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
  assert.equal(
    capture.params.dynamicTools,
    undefined,
    "Codex 0.144.x cannot replace a thread's stored dynamic-tool catalog during resume"
  )
  assert.deepEqual(
    capture.params.config?.features?.code_mode?.direct_only_tool_namespaces,
    ["orchestrator"],
    "thread/resume should still apply the current direct-only process configuration"
  )

  const codeModeWaitErrors: string[] = []
  const codeModeWaitToolCalls: string[] = []
  const codeModeWaitThinking: string[] = []
  const codeModeWaitContent: string[] = []
  process.env.FAKE_CODE_MODE_WAIT = "1"
  try {
    await codexProviderTestHooks.runCodexAppServer({
      bin: fakeCodex,
      prompt: "Exercise a legacy Code Mode delegation wait.",
      model: "gpt-5.6-sol",
      tools: [delegateToTool],
      builtins: [],
      prevSession: { threadId: "legacy-thread" },
      nativeCoderRun: false,
      spawnEnv: { FAKE_CODE_MODE_WAIT: "1" },
      callbacks: {
        onThinking(text) { codeModeWaitThinking.push(text) },
        onThinkingDone() {},
        onContent(text) { codeModeWaitContent.push(text) },
        onToolCall(call) { codeModeWaitToolCalls.push(call.name) },
        onToolResult() {},
        onDone() {},
        onError(error) { codeModeWaitErrors.push(error) },
      },
    })
  } finally {
    delete process.env.FAKE_CODE_MODE_WAIT
  }
  assert.deepEqual(codeModeWaitErrors, [], "Code Mode's native wait cycle must not abort the parent")
  assert.equal(codeModeWaitContent.join(""), "DONE")
  assert.deepEqual(codeModeWaitToolCalls, ["delegate_to"])
  assert.equal(
    codeModeWaitThinking.join(""),
    "Delegate synchronously.",
    "Internal wait-loop reasoning must stay out of the user-visible thinking stream"
  )

  const orderedContent: string[] = []
  const orderedErrors: string[] = []
  process.env.FAKE_INTERLEAVED_MESSAGES = "1"
  try {
    await codexProviderTestHooks.runCodexAppServer({
      bin: fakeCodex,
      prompt: "Exercise overlapping message items.",
      model: "gpt-5.6-sol",
      tools: [],
      builtins: [],
      nativeCoderRun: false,
      spawnEnv: { FAKE_INTERLEAVED_MESSAGES: "1" },
      callbacks: {
        onThinking() {},
        onThinkingDone() {},
        onContent(text) { orderedContent.push(text) },
        onToolCall() {},
        onToolResult() {},
        onDone() {},
        onError(error) { orderedErrors.push(error) },
      },
    })
  } finally {
    delete process.env.FAKE_INTERLEAVED_MESSAGES
  }
  assert.deepEqual(orderedErrors, [], "Overlapping message items must remain a valid turn")
  assert.equal(
    orderedContent.join(""),
    "First message.Second message.",
    "Agent message items must serialize by item order and ignore foreign-turn deltas"
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
      spawnEnv: { FAKE_PARENT_VIOLATION: "1" },
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

  const interventionErrors: string[] = []
  const interventionToolCalls: string[] = []
  const interventionContent: string[] = []
  const interventionCapture = join(directToolFixtureRoot, "intervention.json")
  let steerDuringDelegation: ((text: string) => Promise<boolean>) | null = null
  let interventionDelivery: Promise<boolean> | null = null
  process.env.FAKE_STEERED_INTERVENTION = "1"
  try {
    await codexProviderTestHooks.runCodexAppServer({
      bin: fakeCodex,
      prompt: "Exercise an explicit user intervention over synchronous delegation.",
      model: "gpt-5.6-sol",
      tools: [delegateToTool],
      builtins: [],
      nativeCoderRun: false,
      spawnEnv: {
        FAKE_STEERED_INTERVENTION: "1",
        FAKE_INTERVENTION_CAPTURE: interventionCapture,
      },
      callbacks: {
        onThinking() {},
        onThinkingDone() {},
        onSteeringAvailable(steer) { steerDuringDelegation = steer },
        onContent(text) { interventionContent.push(text) },
        onToolCall(call) {
          interventionToolCalls.push(call.name)
          if (call.name === "delegate_to" && steerDuringDelegation) {
            interventionDelivery = steerDuringDelegation("Change course while the child is running.")
          }
        },
        onToolResult() {},
        onDone() {},
        onError(error) { interventionErrors.push(error) },
      },
    })
  } finally {
    delete process.env.FAKE_STEERED_INTERVENTION
  }
  assert.equal(await interventionDelivery, true, "Steering must land while synchronous delegation is pending")
  assert.deepEqual(interventionErrors, [], "Explicit user steering must not trip the spontaneous-resume guard")
  assert.equal(interventionContent.join(""), "DONE")
  assert.deepEqual(
    interventionToolCalls,
    ["delegate_to", "shell"],
    "A steered parent may act during the scoped intervention window"
  )
  const interventionParams = JSON.parse(readFileSync(interventionCapture, "utf8")) as {
    input?: Array<{ text?: string }>
  }
  assert.match(
    interventionParams.input?.[0]?.text ?? "",
    /orchestrator_user_intervention[\s\S]*manage_delegations[\s\S]*Change course/,
    "Steering over synchronous work must carry the bounded intervention contract"
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
      tools: [delegateAsyncTool],
      builtins: [],
      nativeCoderRun: false,
      spawnEnv: { FAKE_ASYNC_DELEGATION: "1" },
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
  assert.deepEqual(asyncErrors, [], "delegate_async must permit subsequent parent activity")
  assert.equal(asyncContent.join(""), "DONE")
  assert.deepEqual(
    asyncToolCalls,
    ["delegate_async", "shell"],
    "Explicit async delegation must attribute and surface both child launch and later parent tool work"
  )

  const nativeCollaborationErrors: string[] = []
  const nativeCollaborationTools: string[] = []
  await codexProviderTestHooks.runCodexAppServer({
    bin: fakeCodex,
    prompt: "Attempt a forbidden native Codex sub-agent.",
    model: "gpt-5.6-sol",
    tools: [delegateToTool],
    builtins: [],
    nativeCoderRun: false,
    spawnEnv: { FAKE_NATIVE_COLLABORATION: "1" },
    callbacks: {
      onThinking() {},
      onThinkingDone() {},
      onContent() {},
      onToolCall(call) { nativeCollaborationTools.push(call.name) },
      onToolResult() {},
      onDone() {},
      onError(error) { nativeCollaborationErrors.push(error) },
    },
  })
  assert.equal(nativeCollaborationErrors.length, 1, "Native Codex collaboration must fail closed exactly once")
  assert.match(nativeCollaborationErrors[0] ?? "", /Blocked a Codex-native sub-agent operation/)
  assert.deepEqual(nativeCollaborationTools, [], "A native Codex agent call must never surface as an allowed tool")
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
