/**
 * Smoke tests for the weekly Capability audit system task + the ResolveAgentNeed
 * loop-closer:
 *  - The weekly "Capability audit" system task is well-formed and idempotent.
 *  - Its prompt holds the production-critical invariants (propose-only, never
 *    dev activation in the run, silent on empty weeks, evidence-gated).
 *  - ResolveAgentNeed is registered (catalog + workspace builtins + executor)
 *    and moves an open AGENT_NEEDS entry into Resolved by dedupe_key.
 *
 * Run: npx tsx scripts/smoke-capability-audit.ts
 */
import fs from "fs"
import os from "os"
import path from "path"

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capability-audit-smoke-"))
process.chdir(tmpRoot)

async function main(): Promise<void> {
  let failures = 0
  function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(
      `${ok ? "✓" : "✗"} ${label}${ok ? "" : "  (" + JSON.stringify(detail) + ")"}`
    )
    if (!ok) failures++
  }

  // 1. Audit task spec is schema-valid --------------------------------------
  const { CreateScheduledTaskInputSchema } = await import("@/lib/scheduling/schema")
  const {
    buildCapabilityAuditTaskInput,
    resolveCapabilityAuditTimezone,
    ensureCapabilityAuditTask,
    CAPABILITY_AUDIT_TASK_TITLE,
  } = await import("@/lib/self-dev/capability-audit-adapter")
  const { updateConfig } = await import("@/lib/config")

  updateConfig({ timezone: "Pacific/Kiritimati" })
  const tz = resolveCapabilityAuditTimezone()
  check("resolveCapabilityAuditTimezone uses app-configured timezone", tz === "Pacific/Kiritimati", tz)

  const spec = buildCapabilityAuditTaskInput(tz)
  const parsed = CreateScheduledTaskInputSchema.safeParse(spec)
  check(
    "audit task spec validates against CreateScheduledTaskInputSchema",
    parsed.success,
    parsed.success ? undefined : parsed.error.issues
  )
  if (parsed.success) {
    check(
      "audit fires weekly as an agent wake on the orchestrator",
      parsed.data.schedule.kind === "weeklyAt" &&
        parsed.data.action.kind === "agent" &&
        parsed.data.action.agentId === "orchestrator",
      { schedule: parsed.data.schedule, action: parsed.data.action }
    )
    const prompt =
      parsed.data.action.kind === "agent" ? parsed.data.action.prompt : ""
    check(
      "audit prompt is present and within the 8000-char limit",
      prompt.length > 0 && prompt.length <= 8000,
      prompt.length
    )
    check(
      "audit prompt reads AGENT_NEEDS.md as its primary input",
      prompt.includes("EVERY profile-scoped AGENT_NEEDS.md") &&
        prompt.includes("profile_id") &&
        /PRIMARY INPUT/i.test(prompt)
    )
    check(
      "audit prompt is propose-only — forbids implementing / dev activation in this run",
      /must NOT activate self_dev/i.test(prompt) &&
        /project_dev/i.test(prompt) &&
        /NEVER in this run/i.test(prompt)
    )
    check(
      "audit prompt stays silent on an empty week",
      /STAY SILENT/i.test(prompt) && prompt.includes("notify_inbox")
    )
    check(
      "audit prompt emphasizes new features and is evidence-gated",
      /features predominantly/i.test(prompt) &&
        /Every line MUST trace to an AGENT_NEEDS entry/i.test(prompt)
    )
    check(
      "audit prompt surfaces Build action buttons and closes the loop via ResolveAgentNeed",
      prompt.includes("Build all approved") && prompt.includes("ResolveAgentNeed")
    )
    check(
      "audit is created as an always-on system task",
      parsed.data.enabled === true && parsed.data.createdBy === "system"
    )
  }

  // 2. ensureCapabilityAuditTask is idempotent ------------------------------
  const { listScheduledTasks } = await import("@/lib/scheduling/store")
  const { runWithProfileContext } = await import("@/lib/profiles/context")
  const { createProfile } = await import("@/lib/profiles/store")
  const countAudit = () =>
    listScheduledTasks().filter(
      (t) =>
        t.createdBy === "system" &&
        t.action.kind === "agent" &&
        t.title === CAPABILITY_AUDIT_TASK_TITLE
    )

  check("no audit task before wiring", countAudit().length === 0)
  await ensureCapabilityAuditTask()
  check("ensure creates exactly one audit task", countAudit().length === 1)
  await ensureCapabilityAuditTask()
  check(
    "ensure is idempotent (still exactly one)",
    countAudit().length === 1,
    countAudit().length
  )
  const created = countAudit()[0]
  check(
    "created audit task is enabled, weeklyAt, agent-kind",
    Boolean(created) &&
      created.enabled === true &&
      created.schedule.kind === "weeklyAt" &&
      created.action.kind === "agent",
    created?.schedule
  )

  const member = createProfile({ name: "Member Smoke", role: "member" })
  await runWithProfileContext(
    { profileId: member.id, role: "member" },
    () => ensureCapabilityAuditTask()
  )
  const memberAudits = runWithProfileContext(
    { profileId: member.id, role: "member" },
    countAudit
  )
  check(
    "member profile does not get a capability-audit self-dev task",
    memberAudits.length === 0,
    memberAudits
  )

  // 3. ResolveAgentNeed is registered everywhere ----------------------------
  {
    const { ALL_TOOL_DEFS } = await import("@/lib/ai/tools/tool-catalog")
    const { WORKSPACE_TOOL_IDS } = await import("@/lib/ai/agents/builtins")
    const { coreToolExecutors } = await import("@/lib/ai/tools/executors/core")
    check(
      "ResolveAgentNeed registered in the tool catalog",
      ALL_TOOL_DEFS.some((t) => t.id === "ResolveAgentNeed")
    )
    check(
      "ResolveAgentNeed exposed as a workspace builtin",
      WORKSPACE_TOOL_IDS.includes("ResolveAgentNeed")
    )
    check(
      "ResolveAgentNeed wired into the core executor dispatch",
      typeof coreToolExecutors.ResolveAgentNeed === "function"
    )
  }

  // 4. ResolveAgentNeed moves an open entry into Resolved -------------------
  {
    const { recordAgentNeed, ensureAgentNeedsFile } = await import("@/lib/agent-needs")
    const { executeResolveAgentNeed } = await import("@/lib/ai/tools/agent-needs")

    const dedupeKey = "audit-smoke-test"
    recordAgentNeed({
      severity: "high",
      category: "missing_capability",
      summary: "Smoke: a capability the audit should be able to resolve",
      needed: "A test capability that gets shipped and then closed.",
      dedupeKey,
    })
    const filePath = ensureAgentNeedsFile()
    const before = fs.readFileSync(filePath, "utf-8")
    const openBefore = before.split("## Resolved")[0]
    check(
      "recorded need lands under Open with its dedupe_key",
      openBefore.includes(`dedupe_key: ${dedupeKey}`),
      openBefore.slice(-200)
    )

    const res = executeResolveAgentNeed({
      dedupe_key: dedupeKey,
      resolution: "shipped in the capability-audit smoke run",
    })
    check("ResolveAgentNeed succeeds for a known open entry", res.success === true, res.error)

    const after = fs.readFileSync(filePath, "utf-8")
    const [openAfter, resolvedAfter = ""] = after.split("## Resolved")
    check(
      "entry no longer appears under Open",
      !openAfter.includes(`dedupe_key: ${dedupeKey}`),
      openAfter
    )
    check(
      "entry now appears under Resolved as status: resolved with the note",
      resolvedAfter.includes(`dedupe_key: ${dedupeKey}`) &&
        resolvedAfter.includes("status: resolved") &&
        resolvedAfter.includes("shipped in the capability-audit smoke run"),
      resolvedAfter
    )

    const again = executeResolveAgentNeed({
      dedupe_key: dedupeKey,
      resolution: "second attempt should not find it",
    })
    check(
      "resolving an already-resolved key reports not found",
      again.success === false,
      again
    )

    const memberDedupeKey = "audit-smoke-member-profile"
    await runWithProfileContext(
      { profileId: member.id, role: "member" },
      () => recordAgentNeed({
        severity: "medium",
        category: "repo_gap",
        summary: "Smoke: a member-profile need the admin should resolve",
        needed: "A test member backlog entry resolved by the admin audit.",
        dedupeKey: memberDedupeKey,
      })
    )
    const crossProfile = executeResolveAgentNeed({
      dedupe_key: memberDedupeKey,
      profile_id: member.id,
      resolution: "closed by admin capability audit",
    })
    check(
      "admin ResolveAgentNeed can close a member profile entry with profile_id",
      crossProfile.success === true,
      crossProfile
    )
    const memberNeeds = fs.readFileSync(ensureAgentNeedsFile(member.id), "utf-8")
    const [, memberResolved = ""] = memberNeeds.split("## Resolved")
    check(
      "member entry moved to that member profile's Resolved section",
      memberResolved.includes(`dedupe_key: ${memberDedupeKey}`) &&
        memberResolved.includes("closed by admin capability audit"),
      memberResolved
    )
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log("\nAll capability-audit smoke checks passed")
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })
