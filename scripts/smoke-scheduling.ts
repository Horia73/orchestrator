/**
 * Smoke tests for recurring schedule anchoring.
 *
 * Run: npx tsx scripts/smoke-scheduling.ts
 */
import fs from "fs"
import os from "os"
import path from "path"

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-smoke-"))
process.chdir(tmpRoot)

async function main(): Promise<void> {
  const realDateNow = Date.now
  const base = Date.UTC(2026, 4, 25, 21, 30, 0)
  const hourMs = 60 * 60 * 1000
  const quarterMs = 15 * 60 * 1000

  let failures = 0
  function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(
      `${ok ? "✓" : "✗"} ${label}${ok ? "" : "  (" + JSON.stringify(detail) + ")"}`
    )
    if (!ok) failures++
  }

  try {
    Date.now = () => base

    const { createScheduledTask, getScheduledTask, claimForRun } =
      await import("@/lib/scheduling/store")
    const { executeRescheduleTask } = await import("@/lib/ai/tools/schedule")
    const { updateConfig } = await import("@/lib/config")
    const { buildSmartMonitorAgentPrompt } = await import(
      "@/lib/monitoring/smart-monitor"
    )

    const recurring = createScheduledTask({
      title: "Hourly anchored smoke",
      action: { kind: "tool", toolId: "noop", args: {}, summary: "noop" },
      schedule: { kind: "every", everyMs: hourMs },
      enabled: true,
      createdBy: "system",
    })
    check(
      "new every schedule stores explicit startAt",
      recurring.schedule.kind === "every" &&
        recurring.schedule.startAt === base + hourMs,
      recurring.schedule
    )

    const claimed = claimForRun(recurring.id, base + hourMs + 23_000)
    const advanced = getScheduledTask(recurring.id)
    check("claim succeeds", claimed !== null)
    check(
      "late tick advances from anchor, not claim time",
      advanced?.nextRunAt === base + 2 * hourMs,
      { nextRunAt: advanced?.nextRunAt, expected: base + 2 * hourMs }
    )

    Date.now = () => base + 60_000
    const smart = createScheduledTask({
      title: "Smart monitor",
      action: { kind: "monitor", monitorKind: "smart" },
      schedule: { kind: "every", everyMs: quarterMs, startAt: base },
      enabled: true,
      createdBy: "system",
    })
    const rescheduled = await executeRescheduleTask(
      { task_id: smart.id, when: { every: "1h" } },
      {
        callerAgentId: "orchestrator",
        depth: 0,
        conversationId: "smoke",
        parentRequestId: "smoke",
        scheduledTaskId: smart.id,
        scheduledFiredAt: base + 23_000,
      }
    )
    const widened = getScheduledTask(smart.id)
    check("smart monitor reschedule succeeds", rescheduled.success, rescheduled)
    check(
      "smart monitor preserves existing slot anchor when widening",
      widened?.schedule.kind === "every" && widened.schedule.startAt === base,
      widened?.schedule
    )
    check(
      "smart monitor next run stays on the original grid",
      widened?.nextRunAt === base + hourMs,
      { nextRunAt: widened?.nextRunAt, expected: base + hourMs }
    )

    updateConfig({
      smartMonitor: {
        quietHours: {
          from: "23:00",
          to: "07:00",
          timezone: "Europe/Bucharest",
        },
      },
    })
    const prompt = buildSmartMonitorAgentPrompt({
      now: Date.UTC(2026, 4, 25, 22, 31, 23),
      taskId: smart.id,
      taskState: {},
    })
    check(
      "smart monitor prompt includes DST-correct local wake time",
      prompt.includes("Europe/Bucharest: 2026-05-26 01:31:23 GMT+3"),
      prompt.match(/Europe\/Bucharest: .*/)?.[0]
    )
  } finally {
    Date.now = realDateNow
  }

  if (failures > 0) {
    console.error(`scheduling smoke failed: ${failures}`)
    process.exit(1)
  }
  console.log("scheduling smoke passed")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
