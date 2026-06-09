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
    check(
      "smart monitor prompt routes public web research through researcher delegation",
      prompt.includes("Use delegate_to with the Researcher") &&
        prompt.includes("search-only subtask"),
      prompt.match(/current public-web research.*/)?.[0]
    )

    // --- terminal one-shot pruning -------------------------------------------
    const { finishRun, pruneTerminalOneShots, listTaskRuns, recordTaskRun } =
      await import("@/lib/scheduling/store")

    const day = 24 * hourMs
    const mkOnce = (title: string) =>
      createScheduledTask({
        title,
        action: { kind: "tool", toolId: "noop", args: {}, summary: "noop" },
        schedule: { kind: "once", fireAt: base + 1000 * hourMs },
        enabled: true,
        createdBy: "user",
      })

    // done + old → pruned, together with its run history
    const doneOld = mkOnce("done old")
    recordTaskRun({
      taskId: doneOld.id,
      startedAt: base - 2 * day,
      status: "ok",
      trigger: "schedule",
      surfaced: false,
      conversationId: null,
      summary: "done",
    })
    finishRun(doneOld.id, {
      ok: true,
      isOnce: true,
      conversationId: null,
      nowMs: base - 2 * day,
    })

    // done + recent → kept (inside the 24h window)
    const doneRecent = mkOnce("done recent")
    finishRun(doneRecent.id, {
      ok: true,
      isOnce: true,
      conversationId: null,
      nowMs: base - hourMs,
    })

    // error linger longer (72h): old → pruned, recent → kept
    const errOld = mkOnce("error old")
    finishRun(errOld.id, {
      ok: false,
      isOnce: true,
      conversationId: null,
      error: "boom",
      nowMs: base - 4 * day,
    })
    const errRecent = mkOnce("error recent")
    finishRun(errRecent.id, {
      ok: false,
      isOnce: true,
      conversationId: null,
      error: "boom",
      nowMs: base - 2 * day,
    })

    // a still-scheduled one-shot must never be pruned regardless of age
    const pending = mkOnce("pending")

    const pruned = pruneTerminalOneShots(base)
    check(
      "prune removes done one-shot past 24h TTL",
      getScheduledTask(doneOld.id) === null
    )
    check(
      "prune drops the pruned task's run history too",
      listTaskRuns(doneOld.id).length === 0
    )
    check(
      "prune keeps a recent done one-shot",
      getScheduledTask(doneRecent.id) !== null
    )
    check(
      "prune removes errored one-shot past 72h TTL",
      getScheduledTask(errOld.id) === null
    )
    check(
      "prune keeps an errored one-shot within 72h",
      getScheduledTask(errRecent.id) !== null
    )
    check(
      "prune never touches a still-scheduled one-shot",
      getScheduledTask(pending.id) !== null
    )
    check(
      "prune returns exactly the removed ids",
      pruned.length === 2 &&
        pruned.includes(doneOld.id) &&
        pruned.includes(errOld.id),
      pruned
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
