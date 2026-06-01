/**
 * Smoke tests for the model-driven memory layer:
 *  - PLAYBOOKS.md is registered as a durable, exportable, injectable memory file.
 *  - The nightly Memory reflection system task is well-formed and idempotent.
 *
 * Run: npx tsx scripts/smoke-memory-reflection.ts
 */
import fs from "fs"
import os from "os"
import path from "path"

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-reflection-smoke-"))
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

  // 1. PLAYBOOKS.md registration --------------------------------------------
  const { WORKSPACE_FILE_DEFINITIONS } = await import(
    "@/lib/settings/workspace-files"
  )
  const playbooks = WORKSPACE_FILE_DEFINITIONS.find((d) => d.id === "playbooks")
  check("PLAYBOOKS.md registered in WORKSPACE_FILE_DEFINITIONS", Boolean(playbooks))
  check(
    "playbooks def points at PLAYBOOKS.md markdown with a template",
    playbooks?.relativePath === "PLAYBOOKS.md" &&
      playbooks?.kind === "markdown" &&
      Boolean(playbooks?.defaultContent),
    playbooks
  )

  // 2. Reflection task spec is schema-valid ---------------------------------
  const { CreateScheduledTaskInputSchema } = await import(
    "@/lib/scheduling/schema"
  )
  const {
    buildReflectionTaskInput,
    resolveReflectionTimezone,
    ensureMemoryReflectionTask,
    REFLECTION_TASK_TITLE,
  } = await import("@/lib/monitoring/memory-reflection-adapter")

  const tz = resolveReflectionTimezone()
  check("resolveReflectionTimezone returns a non-empty tz", Boolean(tz), tz)

  const spec = buildReflectionTaskInput(tz)
  const parsed = CreateScheduledTaskInputSchema.safeParse(spec)
  check(
    "reflection task spec validates against CreateScheduledTaskInputSchema",
    parsed.success,
    parsed.success ? undefined : parsed.error.issues
  )
  if (parsed.success) {
    check(
      "reflection fires daily as an agent wake on the orchestrator",
      parsed.data.schedule.kind === "dailyAt" &&
        parsed.data.action.kind === "agent" &&
        parsed.data.action.agentId === "orchestrator",
      { schedule: parsed.data.schedule, action: parsed.data.action }
    )
    check(
      "reflection prompt is present and within the 8000-char limit",
      parsed.data.action.kind === "agent" &&
        parsed.data.action.prompt.length > 0 &&
        parsed.data.action.prompt.length <= 8000
    )
    check(
      "reflection is created as an always-on system task",
      parsed.data.enabled === true && parsed.data.createdBy === "system"
    )
  }

  // 3. ensureMemoryReflectionTask is idempotent -----------------------------
  const { listScheduledTasks } = await import("@/lib/scheduling/store")
  const countReflection = () =>
    listScheduledTasks().filter(
      (t) =>
        t.createdBy === "system" &&
        t.action.kind === "agent" &&
        t.title === REFLECTION_TASK_TITLE
    )

  check("no reflection task before wiring", countReflection().length === 0)
  await ensureMemoryReflectionTask()
  check("ensure creates exactly one reflection task", countReflection().length === 1)
  await ensureMemoryReflectionTask()
  check(
    "ensure is idempotent (still exactly one)",
    countReflection().length === 1,
    countReflection().length
  )

  const created = countReflection()[0]
  check(
    "created reflection task is enabled, dailyAt, agent-kind",
    Boolean(created) &&
      created.enabled === true &&
      created.schedule.kind === "dailyAt" &&
      created.action.kind === "agent",
    created?.schedule
  )

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log("\nAll memory-reflection smoke checks passed")
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
