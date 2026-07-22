import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-secrets-smoke-"))
process.env.ORCHESTRATOR_STATE_DIR = path.join(tempRoot, "state")
process.env.UNRELATED_PARENT_SMOKE_SECRET = "must-not-reach-agent-command"

async function main(): Promise<void> {
  const { activeRuntimePaths } = await import("@/lib/runtime-paths")
  const {
    contentForModel,
    getCapturedSecretValue,
    protectUserMessage,
    revealMessageSecret,
  } = await import("@/lib/secrets/store")
  const { detectSecretCandidates } = await import("@/lib/secrets/detection")
  const { resolveEnvVarInjection } = await import("@/lib/ai/tools/env-vars")
  const { executeBash } = await import("@/lib/ai/tools/bash")
  const { agentCommandEnv } = await import("@/lib/cli/resolve-bin")
  const { createConversation, getConversation } = await import("@/lib/db")
  const { runtimeBuiltinsForProvider } = await import(
    "@/lib/ai/agents/runtime-agent-config"
  )
  const { orchestrator } = await import("@/lib/ai/agents/orchestrator")
  const { coder } = await import("@/lib/ai/agents/coder")
  const { customToolsForCodex } = await import(
    "@/lib/ai/providers/codex-helpers"
  )
  const { bashTool } = await import("@/lib/ai/tools/bash-def")
  const { listEnvVarsTool } = await import("@/lib/ai/tools/env-vars")

  fs.mkdirSync(activeRuntimePaths().agentWorkspaceDir, {
    recursive: true,
    mode: 0o700,
  })
  fs.writeFileSync(
    activeRuntimePaths().workspaceEnvPath,
    "# this comment must survive automatic secret storage\nEXISTING=value\n",
    { mode: 0o600 }
  )

  const rawSecret = `sk-proj-${"A1".repeat(20)}`
  const rawContent = `Use this from now on: OPENAI_API_KEY=${rawSecret}`
  const protectedResult = protectUserMessage({
    id: "secret-user-message",
    role: "user",
    content: rawContent,
    timestamp: Date.now(),
  })
  const protectedMessage = protectedResult.message
  const ref = protectedMessage.secretRefs?.[0]

  assert.ok(ref, "a safe secret reference should be attached")
  assert.equal(ref.key, "OPENAI_API_KEY")
  assert.ok(protectedMessage.content.includes(ref.marker))
  assert.ok(!protectedMessage.content.includes(rawSecret))
  assert.ok(!JSON.stringify(protectedMessage).includes(rawSecret))
  assert.equal(getCapturedSecretValue("OPENAI_API_KEY"), rawSecret)
  assert.equal(revealMessageSecret(protectedMessage.id, ref.id), rawSecret)
  assert.equal(revealMessageSecret("different-message", ref.id), null)

  const modelContent = contentForModel(protectedMessage)
  assert.match(modelContent, /Secret saved as OPENAI_API_KEY/)
  assert.ok(!modelContent.includes(rawSecret))

  const envContent = fs.readFileSync(activeRuntimePaths().workspaceEnvPath, "utf-8")
  assert.match(envContent, /^# this comment must survive automatic secret storage/m)
  assert.match(envContent, /^OPENAI_API_KEY=/m)
  assert.equal(fs.statSync(activeRuntimePaths().workspaceEnvPath).mode & 0o777, 0o600)

  const vaultPath = path.join(
    activeRuntimePaths().privateStateDir,
    "secrets",
    "chat-secrets.json"
  )
  assert.equal(fs.statSync(vaultPath).mode & 0o777, 0o600)

  const injection = resolveEnvVarInjection(["OPENAI_API_KEY"])
  assert.equal(injection.ok, true)
  if (injection.ok) {
    assert.equal(injection.injection.env.OPENAI_API_KEY, rawSecret)
    assert.equal(injection.injection.sources.OPENAI_API_KEY, "secret_store")
  }

  createConversation({
    id: "secret-conversation",
    title: "Secret smoke",
    messages: [protectedMessage],
    createdAt: Date.now(),
  })
  const persisted = getConversation("secret-conversation")?.messages[0]
  assert.ok(persisted?.secretRefs?.[0])
  assert.ok(!JSON.stringify(persisted).includes(rawSecret))

  const dbBoundarySecret = `ghp_${"B7".repeat(20)}`
  createConversation({
    id: "raw-db-boundary-conversation",
    title: "DB boundary",
    messages: [{
      id: "raw-db-boundary-message",
      role: "user",
      content: `GITHUB_TOKEN=${dbBoundarySecret}`,
      timestamp: Date.now(),
    }],
    createdAt: Date.now(),
  })
  const dbBoundaryMessage = getConversation(
    "raw-db-boundary-conversation"
  )?.messages[0]
  assert.ok(dbBoundaryMessage?.secretRefs?.[0])
  assert.ok(!JSON.stringify(dbBoundaryMessage).includes(dbBoundarySecret))

  const romanian = detectSecretCandidates(
    `cheie api pentru OpenAI este sk-proj-${"Z9".repeat(20)}`
  )
  assert.equal(romanian[0]?.suggestedKey, "OPENAI_API_KEY")
  assert.equal(
    detectSecretCandidates("Use token budgeting and passwordless login.").length,
    0,
    "ordinary security prose must not be masked"
  )

  const commandEnv = agentCommandEnv()
  assert.equal(commandEnv.UNRELATED_PARENT_SMOKE_SECRET, undefined)
  const noLeak = await executeBash({
    command: 'test -z "${UNRELATED_PARENT_SMOKE_SECRET:-}"',
    timeout: 10_000,
  })
  assert.equal(noLeak.success, true, JSON.stringify(noLeak))

  const injected = await executeBash({
    command: 'printf "%s" "$OPENAI_API_KEY"',
    env_keys: ["OPENAI_API_KEY"],
    timeout: 10_000,
  })
  assert.equal(injected.success, true, JSON.stringify(injected))
  assert.ok(!JSON.stringify(injected).includes(rawSecret))
  assert.match(JSON.stringify(injected), /redacted:OPENAI_API_KEY/)

  const blockedEnvRead = await executeBash({
    command: "cat .env.local",
    timeout: 10_000,
  })
  assert.equal(blockedEnvRead.success, false)
  assert.match(blockedEnvRead.error ?? "", /Direct \.env file access is blocked/)

  assert.deepEqual(runtimeBuiltinsForProvider(orchestrator, "codex"), [
    "web_search",
  ])
  assert.ok(runtimeBuiltinsForProvider(coder, "codex").includes("bash"))
  assert.deepEqual(
    customToolsForCodex([bashTool, listEnvVarsTool], ["web_search"]).map(
      (tool) => tool.id
    ),
    ["Bash", "ListEnvVars"]
  )
  assert.deepEqual(
    customToolsForCodex([bashTool, listEnvVarsTool], ["bash"]).map(
      (tool) => tool.id
    ),
    ["ListEnvVars"]
  )

  console.log("Chat secret smoke passed.")
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    delete process.env.UNRELATED_PARENT_SMOKE_SECRET
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })
