/**
 * Smoke test: recent-memory prompt compaction and canonical context priority.
 *
 * The raw MEMORY_DAY ledger must remain complete. Large recent days are exposed
 * through a bounded extractive prompt view in which every entry is represented,
 * while MONITORS/PLAYBOOKS retain priority and recent raw notes remain eligible
 * for semantic recall.
 */
import fs from "fs"
import os from "os"
import path from "path"

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-memory-context-"))
process.env.ORCHESTRATOR_STATE_DIR = stateDir

let failures = 0

function check(label: string, condition: unknown, detail?: unknown): void {
  const ok = Boolean(condition)
  console.log(
    `${ok ? "✓" : "✗"} ${label}${ok ? "" : `  (${JSON.stringify(detail)})`}`
  )
  if (!ok) failures++
}

function dailyEntry(source: number, entry: number, bodyChars = 900): string {
  const head = `HEAD_${source}_${entry} goal and evidence`
  const tail = `outcome and open loop TAIL_${source}_${entry}`
  const fill = " dense-context"
    .repeat(Math.ceil(bodyChars / 14))
    .slice(0, bodyChars)
  return `- ${head}${fill} ${tail}`
}

function sizedMarkdown(
  title: string,
  targetChars: number,
  sentinel: string
): string {
  const prefix = `# ${title}\n\n`
  const suffix = `\n\n- ${sentinel}`
  const fill = "dense fact; ".repeat(Math.ceil(targetChars / 12))
  return `${prefix}${fill.slice(0, Math.max(0, targetChars - prefix.length - suffix.length))}${suffix}`
}

async function main(): Promise<void> {
  const {
    compactRecentDailyMemory,
    MAX_MONITORS_CONTEXT_CHARS,
    MAX_PLAYBOOKS_CONTEXT_CHARS,
    MAX_RECENT_DAILY_CONTEXT_CHARS,
    MAX_USER_CONTEXT_CHARS,
  } = await import("@/lib/memory/recent-context")

  const smallSources = [
    {
      relativePath: "MEMORY_DAY/2026-01-01.md",
      content: "# MEMORY DAY\n\n- Full short fact.",
    },
  ]
  const small = compactRecentDailyMemory(smallSources, 1_000)
  check(
    "small recent memory stays verbatim",
    small[0]?.content === smallSources[0].content
  )
  check(
    "small recent memory is not labeled compacted",
    small[0]?.compacted === false
  )

  const oversizedSources = Array.from({ length: 3 }, (_, source) => ({
    relativePath: `MEMORY_DAY/2026-01-0${source + 1}.md`,
    content: [
      `# MEMORY DAY 2026-01-0${source + 1}`,
      "",
      ...Array.from({ length: 12 }, (_, entry) => dailyEntry(source, entry)),
    ].join("\n"),
  }))
  const compactBudget = 9_000
  const compacted = compactRecentDailyMemory(oversizedSources, compactBudget)
  const compactedText = compacted.map((block) => block.content).join("\n")
  check(
    "oversized recent memory respects its content budget",
    compacted.reduce((sum, block) => sum + block.content.length, 0) <=
      compactBudget,
    compacted.map((block) => block.content.length)
  )
  check(
    "every oversized source is compacted",
    compacted.every((block) => block.compacted)
  )
  check(
    "compact view explains that raw spans remain available",
    compactedText.includes("semantic-recall eligible")
  )
  check(
    "compact view represents every entry beginning and outcome",
    oversizedSources.every((_, source) =>
      Array.from({ length: 12 }, (_, entry) => entry).every(
        (entry) =>
          compactedText.includes(`HEAD_${source}_${entry}`) &&
          compactedText.includes(`TAIL_${source}_${entry}`)
      )
    )
  )
  check(
    "compaction is pure and leaves raw source strings unchanged",
    oversizedSources.every((source, index) =>
      source.content.includes(`TAIL_${index}_11`)
    )
  )

  const { ensureWorkspaceTemplates } =
    await import("@/lib/settings/workspace-files")
  const { getConfig } = await import("@/lib/config")
  const { dateStampInTimezone } = await import("@/lib/timezone")
  const { smartMonitorAgent } =
    await import("@/lib/ai/agents/smart-monitor-agent")
  const { orchestrator } = await import("@/lib/ai/agents/orchestrator")
  const { getToolsForAgent, getToolsForBuiltins } =
    await import("@/lib/ai/tools/registry")
  const {
    PROMPT_BUDGET_CHARS_PER_TOKEN,
    PROMPT_SYSTEM_TOOL_MAX_FRACTION,
  } = await import("@/lib/ai/prompts/orchestrator")
  const { filterIntegrationToolExposure } =
    await import("@/lib/integrations/exposure")
  const { MAX_AGENT_DEPTH } = await import("@/lib/ai/agents/types")
  const { MAX_CONTEXT_TOTAL_CHARS } = await import("@/lib/ai/prompts/shared")
  const { inContextSources } = await import("@/lib/memory/recall")

  ensureWorkspaceTemplates()
  const workspace = path.join(stateDir, "workspace")
  fs.rmSync(path.join(workspace, "BOOT.md"), { force: true })
  fs.writeFileSync(
    path.join(workspace, "USER.md"),
    sizedMarkdown("USER", 50_000, "USER_END_SENTINEL")
  )
  fs.writeFileSync(
    path.join(workspace, "MEMORY.md"),
    sizedMarkdown("MEMORY", 21_000, "MEMORY_END_SENTINEL")
  )
  fs.writeFileSync(
    path.join(workspace, "MONITORS.md"),
    sizedMarkdown("MONITORS", 44_000, "MONITORS_END_SENTINEL")
  )
  fs.writeFileSync(
    path.join(workspace, "PLAYBOOKS.md"),
    sizedMarkdown("PLAYBOOKS", 34_000, "PLAYBOOKS_END_SENTINEL")
  )

  const timezone = getConfig().timezone
  const rawDaily = new Map<string, string>()
  for (let back = 2; back >= 0; back--) {
    const stamp = dateStampInTimezone(Date.now() - back * 86_400_000, timezone)
    const relativePath = `MEMORY_DAY/${stamp}.md`
    const content = [
      `# MEMORY DAY ${stamp}`,
      "",
      ...Array.from({ length: 30 }, (_, entry) =>
        dailyEntry(2 - back, entry, 1_000)
      ),
    ].join("\n")
    rawDaily.set(relativePath, content)
    fs.writeFileSync(path.join(workspace, relativePath), content)
  }

  const declaredTools = getToolsForAgent(smartMonitorAgent.tools)
  const exposedSmartTools = new Set(
    filterIntegrationToolExposure(declaredTools, {
      conversationId: "memory-context-smoke",
      agentId: smartMonitorAgent.id,
    }).map((tool) => tool.id)
  )
  const prompt = smartMonitorAgent.buildPrompt!({
    agentId: "smart-monitor-agent",
    userName: "Test",
    assistantName: "Test",
    availableTools: [],
    availableBuiltins: smartMonitorAgent.builtins ?? [],
    availableAgents: [],
    conversationId: "memory-context-smoke",
    declaredToolIds: smartMonitorAgent.tools,
    declaredTools,
    includeMonitorsFile: true,
    delegationDepth: 0,
    maxDelegationDepth: MAX_AGENT_DEPTH,
  })

  const workspaceStart = prompt.lastIndexOf("<workspace_context_files>")
  const workspaceEnd = prompt.indexOf(
    "</workspace_context_files>",
    workspaceStart
  )
  const workspaceBlock = prompt.slice(workspaceStart, workspaceEnd)
  const monitorAt = workspaceBlock.indexOf("--- BEGIN MONITORS.md")
  const playbookAt = workspaceBlock.indexOf("--- BEGIN PLAYBOOKS.md")
  const dailyAt = workspaceBlock.indexOf("(memory-day-compact)")

  check(
    "Smart Monitor prompt pack keeps core safety/memory/integration/delegation/output",
    prompt.includes("<safety_core>") &&
      prompt.includes("<memory_protocol>") &&
      prompt.includes("<integration_model>") &&
      prompt.includes("<delegation_policy>") &&
      prompt.includes("<output_contract>")
  )
  check(
    "Smart Monitor prompt pack omits chat-only action/artifact/skill doctrine",
    !/^<task_taxonomy>$/m.test(prompt) &&
      !/^<artifact_authoring>$/m.test(prompt) &&
      !/^<skills_index>$/m.test(prompt)
  )
  check(
    "Smart Monitor grant keeps wake primitives but drops lifecycle/chat tools",
    exposedSmartTools.has("notify_inbox") &&
      exposedSmartTools.has("set_task_state") &&
      exposedSmartTools.has("monitor_wake_feedback") &&
      !exposedSmartTools.has("monitor_watch_add") &&
      !exposedSmartTools.has("ask_user") &&
      !exposedSmartTools.has("apply_update")
  )
  check(
    "Smart Monitor delegation is Researcher-only",
    smartMonitorAgent.canCallAgents?.length === 1 &&
      smartMonitorAgent.canCallAgents[0] === "researcher"
  )

  check(
    "Smart Monitor compact MONITORS view keeps the raw tail pointer",
    workspaceBlock.includes("MONITORS_END_SENTINEL") &&
      workspaceBlock.includes("(monitors-compact)")
  )
  check(
    "large USER and PLAYBOOKS keep tail pointers in compact views",
    workspaceBlock.includes("USER_END_SENTINEL") &&
      workspaceBlock.includes("PLAYBOOKS_END_SENTINEL") &&
      workspaceBlock.includes("(user-compact)") &&
      workspaceBlock.includes("(playbooks-compact)")
  )
  check(
    "canonical monitor/playbook context precedes compact daily memory",
    monitorAt >= 0 && playbookAt > monitorAt && dailyAt > playbookAt,
    { monitorAt, playbookAt, dailyAt }
  )

  const contextMatches = [
    ...workspaceBlock.matchAll(
      /--- BEGIN ([^\n]+) ---\n([\s\S]*?)\n--- END [^\n]+ ---/g
    ),
  ]
  const contextContentChars = contextMatches.reduce(
    (sum, match) => sum + match[2].length,
    0
  )
  const dailyContentChars = contextMatches
    .filter((match) => match[1].includes("(memory-day-compact)"))
    .reduce((sum, match) => sum + match[2].length, 0)
  const userContentChars =
    contextMatches.find((match) => match[1].includes("(user-compact)"))?.[2]
      .length ?? 0
  const playbookContentChars =
    contextMatches.find((match) =>
      match[1].includes("(playbooks-compact)")
    )?.[2].length ?? 0
  const monitorContentChars =
    contextMatches.find((match) =>
      match[1].includes("(monitors-compact)")
    )?.[2].length ?? 0
  check(
    "all workspace content respects the global content budget",
    contextContentChars <= MAX_CONTEXT_TOTAL_CHARS,
    contextContentChars
  )
  check(
    "recent daily prompt view respects its dedicated budget",
    dailyContentChars <= MAX_RECENT_DAILY_CONTEXT_CHARS,
    dailyContentChars
  )
  check(
    "durable compact views respect USER/MONITORS/PLAYBOOKS budgets",
    userContentChars <= MAX_USER_CONTEXT_CHARS &&
      monitorContentChars <= MAX_MONITORS_CONTEXT_CHARS &&
      playbookContentChars <= MAX_PLAYBOOKS_CONTEXT_CHARS,
    { userContentChars, monitorContentChars, playbookContentChars }
  )

  check(
    "integrated prompt represents every recent daily entry",
    Array.from({ length: 3 }, (_, source) => source).every((source) =>
      Array.from({ length: 30 }, (_, entry) => entry).every(
        (entry) =>
          workspaceBlock.includes(`HEAD_${source}_${entry}`) &&
          workspaceBlock.includes(`TAIL_${source}_${entry}`)
      )
    )
  )
  check(
    "prompt construction never rewrites raw daily files",
    [...rawDaily].every(
      ([relativePath, content]) =>
        fs.readFileSync(path.join(workspace, relativePath), "utf8") === content
    )
  )

  const inContext = inContextSources()
  check(
    "fully loaded MEMORY remains excluded from duplicate recall",
    inContext.has("MEMORY.md")
  )
  check(
    "compacted USER/PLAYBOOKS remain semantic-recall eligible",
    !inContext.has("USER.md") && !inContext.has("PLAYBOOKS.md")
  )
  check(
    "recent raw daily files remain semantic-recall eligible",
    [...rawDaily.keys()].every((relativePath) => !inContext.has(relativePath)),
    [...inContext]
  )

  const seen = new Set<string>()
  const mainCandidateTools = [
    ...getToolsForAgent(orchestrator.tools),
    ...getToolsForBuiltins(orchestrator.builtins ?? []),
  ].filter((tool) => (seen.has(tool.id) ? false : (seen.add(tool.id), true)))
  const mainTools = filterIntegrationToolExposure(mainCandidateTools, {
    conversationId: "memory-context-main-budget",
    agentId: orchestrator.id,
  })
  const modelContextWindow = 128_000
  const budgetedMainPrompt = orchestrator.buildPrompt!({
    agentId: orchestrator.id,
    userName: "Test",
    assistantName: "Test",
    availableTools: mainTools,
    availableBuiltins: orchestrator.builtins ?? [],
    availableAgents: [],
    conversationId: "memory-context-main-budget",
    declaredToolIds: orchestrator.tools,
    declaredTools: getToolsForAgent(orchestrator.tools),
    delegationDepth: 0,
    maxDelegationDepth: MAX_AGENT_DEPTH,
    modelContextWindow,
  })
  const mainToolChars = JSON.stringify(
    mainTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }))
  ).length
  const systemToolTarget = Math.floor(
    modelContextWindow *
      PROMPT_BUDGET_CHARS_PER_TOKEN *
      PROMPT_SYSTEM_TOOL_MAX_FRACTION
  )
  check(
    "model-aware planner keeps system + tools within the reserved context share",
    budgetedMainPrompt.length + mainToolChars <= systemToolTarget,
    {
      promptChars: budgetedMainPrompt.length,
      mainToolChars,
      systemToolTarget,
    }
  )
  check(
    "model-aware reduction keeps USER and MEMORY orientation available",
    budgetedMainPrompt.includes("--- BEGIN USER.md") &&
      budgetedMainPrompt.includes("--- BEGIN MEMORY.md")
  )

  fs.rmSync(stateDir, { recursive: true, force: true })
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log("\nAll memory-context checks passed")
}

main().catch((error) => {
  fs.rmSync(stateDir, { recursive: true, force: true })
  console.error(error)
  process.exit(1)
})
