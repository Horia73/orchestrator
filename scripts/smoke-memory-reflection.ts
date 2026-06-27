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

  // 1b. MEMORY_ARCHIVE.md registration (cold tier) --------------------------
  const archive = WORKSPACE_FILE_DEFINITIONS.find((d) => d.id === "memory-archive")
  check(
    "MEMORY_ARCHIVE.md registered as a markdown durable file with a template",
    archive?.relativePath === "MEMORY_ARCHIVE.md" &&
      archive?.kind === "markdown" &&
      Boolean(archive?.defaultContent),
    archive
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
  const { updateConfig } = await import("@/lib/config")

  updateConfig({ timezone: "Pacific/Kiritimati" })
  const tz = resolveReflectionTimezone()
  check("resolveReflectionTimezone uses app-configured timezone", tz === "Pacific/Kiritimati", tz)

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
      "reflection prompt drives hot/cold curation + lossless densification",
      parsed.data.action.kind === "agent" &&
        parsed.data.action.prompt.includes("MEMORY_ARCHIVE.md") &&
        /densify/i.test(parsed.data.action.prompt),
      parsed.data.action.kind === "agent" ? parsed.data.action.prompt.slice(0, 200) : undefined
    )
    check(
      "reflection prompt drives playbook synthesis from repeated workflows",
      parsed.data.action.kind === "agent" &&
        parsed.data.action.prompt.includes("memory_recent_activity") &&
        parsed.data.action.prompt.includes("PLAYBOOKS.md") &&
        /playbook/i.test(parsed.data.action.prompt)
    )
    check(
      "reflection prompt audits hot-file sizes and handles truncation",
      parsed.data.action.kind === "agent" &&
        parsed.data.action.prompt.includes("wc -c USER.md") &&
        parsed.data.action.prompt.includes("50,000") &&
        parsed.data.action.prompt.includes("60,000") &&
        parsed.data.action.prompt.includes("[truncated: file exceeded context budget]")
    )
    check(
      "reflection prompt allows the single new-playbook notification only",
      parsed.data.action.kind === "agent" &&
        parsed.data.action.prompt.includes("ONE exception") &&
        parsed.data.action.prompt.includes("notify_inbox")
    )
    check(
      "reflection prompt reviews watch engagement signals",
      parsed.data.action.kind === "agent" &&
        parsed.data.action.prompt.includes("user_signal")
    )
    check(
      "reflection is created as an always-on system task",
      parsed.data.enabled === true && parsed.data.createdBy === "system"
    )
  }

  // 2b. memory_recent_activity tool + enumeration plumbing ------------------
  {
    const { ALL_TOOL_DEFS } = await import("@/lib/ai/tools/tool-catalog")
    const recentTool = ALL_TOOL_DEFS.find((t) => t.id === "memory_recent_activity")
    check("memory_recent_activity registered in the tool catalog", Boolean(recentTool))
    check(
      "memory_recent_activity tagged like memory_search (read + memory)",
      recentTool?.tags?.includes("memory") === true && recentTool?.tags?.includes("read") === true,
      recentTool?.tags
    )

    // Seed two conversations: one inside the window, one ancient.
    const { default: db } = await import("@/lib/db")
    const now = Date.now()
    const seedConversation = (id: string, title: string, ts: number, asks: string[]) => {
      db.prepare(
        `INSERT INTO conversations (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)`
      ).run(id, title, ts, ts)
      asks.forEach((ask, i) => {
        const at = ts + i * 60_000
        db.prepare(
          `INSERT INTO messages (id, conversationId, role, content, timestamp) VALUES (?, ?, 'user', ?, ?)`
        ).run(`${id}_u${i}`, id, ask, at)
        db.prepare(
          `INSERT INTO messages (id, conversationId, role, content, timestamp) VALUES (?, ?, 'assistant', 'done', ?)`
        ).run(`${id}_a${i}`, id, at + 1000)
      })
    }
    seedConversation("conv_recent", "Weekly invoice run", now - 2 * 86_400_000, [
      "generate the invoice for client X and email it",
      "now do the same for client Y",
    ])
    seedConversation("conv_old", "Ancient chat", now - 40 * 86_400_000, [
      "an old request that must not appear",
    ])

    const { executeMemoryRecentActivity } = await import("@/lib/ai/tools/memory-search")
    const r = await executeMemoryRecentActivity({ days: 14 })
    check("memory_recent_activity succeeds", r.success === true, r.error)
    const data = r.data as {
      conversation_count: number
      conversations: Array<{ conversation_id: string; title: string; exchange_count: number; user_requests: string[] }>
    }
    const recent = data.conversations.find((c) => c.conversation_id === "conv_recent")
    check(
      "recent conversation enumerated with its user requests",
      recent?.title === "Weekly invoice run" &&
        recent?.exchange_count === 2 &&
        recent?.user_requests[0]?.includes("generate the invoice"),
      recent
    )
    check(
      "out-of-window conversation excluded",
      data.conversations.every((c) => c.conversation_id !== "conv_old")
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
