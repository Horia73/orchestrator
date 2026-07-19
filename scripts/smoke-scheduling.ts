/**
 * Smoke tests for recurring schedule anchoring.
 *
 * Run: npx tsx scripts/smoke-scheduling.ts
 */
import fs from "fs"
import os from "os"
import path from "path"
import Database from "better-sqlite3"

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scheduling-smoke-"))
const originalStateDir = process.env.ORCHESTRATOR_STATE_DIR
process.env.ORCHESTRATOR_STATE_DIR = tmpRoot
process.chdir(tmpRoot)

async function main(): Promise<void> {
  const realDateNow = Date.now
  const base = Date.UTC(2026, 4, 25, 21, 30, 0)
  const hourMs = 60 * 60 * 1000
  const quarterMs = 15 * 60 * 1000
  const day = 24 * hourMs

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

    const {
      createScheduledTask,
      getScheduledTask,
      getTaskState,
      claimForRun,
      deferClaimedRun,
      markTaskError,
      setTaskState,
    } =
      await import("@/lib/scheduling/store")
    const schedulingDb = (await import("@/lib/db")).default
    const { isTransientSqliteContentionError } = await import(
      "@/lib/scheduling/sqlite-errors"
    )
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
    if (claimed) deferClaimedRun(claimed.task, base + hourMs + 24_000)
    const deferred = getScheduledTask(recurring.id)
    check(
      "update deferral restores the claimed schedule without consuming it",
      deferred?.status === "scheduled" && deferred.nextRunAt === base + hourMs,
      { status: deferred?.status, nextRunAt: deferred?.nextRunAt }
    )

    // A competing WAL writer must leave the due task untouched so the
    // scheduler can retry it on its next tick.
    const contentionTask = createScheduledTask({
      title: "SQLite contention smoke",
      action: { kind: "tool", toolId: "noop", args: {}, summary: "noop" },
      schedule: { kind: "every", everyMs: hourMs },
      enabled: true,
      createdBy: "system",
    })
    const contentionNextRunAt = contentionTask.nextRunAt
    const blocker = new Database(path.join(tmpRoot, "data.db"))
    blocker.pragma("journal_mode = WAL")
    blocker.exec("BEGIN IMMEDIATE")
    schedulingDb.pragma("busy_timeout = 25")
    let contentionError: unknown = null
    try {
      claimForRun(contentionTask.id, base + hourMs)
    } catch (error) {
      contentionError = error
    } finally {
      blocker.exec("ROLLBACK")
      blocker.close()
      schedulingDb.pragma("busy_timeout = 10000")
    }
    const afterContention = getScheduledTask(contentionTask.id)
    check(
      "SQLite writer contention is classified as transient",
      isTransientSqliteContentionError(contentionError),
      contentionError instanceof Error
        ? { message: contentionError.message, code: (contentionError as Error & { code?: string }).code }
        : contentionError
    )
    check(
      "failed claim leaves recurring task armed for retry",
      afterContention?.status === "scheduled" &&
        afterContention.nextRunAt === contentionNextRunAt,
      afterContention
    )
    check(
      "non-SQLite scheduling errors are not classified as contention",
      !isTransientSqliteContentionError(new Error("invalid cron expression"))
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

    // Reconcile the fixed cadence, then reproduce the production incident:
    // enabled + error + no nextRunAt must self-heal without losing task_state.
    const { ensureSmartMonitorHeartbeat } = await import(
      "@/lib/monitoring/smart-monitor-adapter"
    )
    await ensureSmartMonitorHeartbeat({ enabled: true })
    const cadenceRepaired = getScheduledTask(smart.id)
    check(
      "smart monitor reconciliation restores the fixed cheap-poll cadence",
      cadenceRepaired?.schedule.kind === "every" &&
        cadenceRepaired.schedule.everyMs === 5 * 60_000 &&
        cadenceRepaired.status === "scheduled" &&
        cadenceRepaired.nextRunAt != null,
      cadenceRepaired
    )
    const preservedState = { digestQueue: [{ id: "buffered-digest-item" }] }
    setTaskState(smart.id, preservedState)
    markTaskError(smart.id, "database is locked", base + 2 * 60_000)
    const stranded = getScheduledTask(smart.id)
    check(
      "incident fixture parks the enabled heartbeat without a next run",
      stranded?.enabled === true &&
        stranded.status === "error" &&
        stranded.nextRunAt === null,
      stranded
    )
    await ensureSmartMonitorHeartbeat({ enabled: true })
    const selfHealed = getScheduledTask(smart.id)
    check(
      "smart monitor reconciliation re-arms a stranded heartbeat",
      selfHealed?.status === "scheduled" && selfHealed.nextRunAt != null,
      selfHealed
    )
    check(
      "smart monitor self-heal preserves buffered task state",
      JSON.stringify(getTaskState(smart.id)) === JSON.stringify(preservedState),
      getTaskState(smart.id)
    )

    // ---- Product price task_state -> Watchlist backstop ----------------------
    {
      const { listWatchlistItems, listWatchlistObservations } =
        await import("@/lib/watchlist/store")
      const { executeWatchlistRecordProductPrice } =
        await import("@/lib/ai/tools/watchlist")
      const productUrl =
        "https://www.roastmarket.de/sage-the-oracletm-dual-boiler.html"
      const firstObservedAt = Date.UTC(2026, 4, 26, 8, 15, 0)
      const nextObservedAt = firstObservedAt + day
      const productTask = createScheduledTask({
        title: "Roastmarket price monitor",
        action: {
          kind: "agent",
          prompt: "Check the product price and update task state.",
        },
        schedule: { kind: "every", everyMs: day },
        enabled: true,
        createdBy: "user",
      })

      setTaskState(productTask.id, {
        product_url: productUrl,
        product_name: "Sage the Oracle Dual Boiler",
        last_observed_price_eur: "899,00 €",
        currency: "EUR",
        checked_at: new Date(firstObservedAt).toISOString(),
      })

      const productItem = listWatchlistItems().find(
        (item) => item.kind === "product" && item.url === productUrl
      )
      check(
        "product task_state creates Watchlist item",
        productItem !== undefined
      )
      let observations = productItem
        ? listWatchlistObservations(productItem.id)
        : []
      check(
        "product task_state records observed price",
        observations.length === 1 &&
          observations[0].price === 899 &&
          observations[0].ts === firstObservedAt,
        observations
      )

      const explicitRecord = executeWatchlistRecordProductPrice({
        url: productUrl,
        name: "Sage the Oracle Dual Boiler",
        price: 899,
        currency: "EUR",
        observed_at: firstObservedAt,
      })
      observations = productItem
        ? listWatchlistObservations(productItem.id)
        : []
      check(
        "explicit product price tool dedupes same check",
        explicitRecord.success && observations.length === 1,
        { explicitRecord, observations }
      )

      setTaskState(productTask.id, {
        productUrl,
        productName: "Sage the Oracle Dual Boiler",
        currentPriceEur: 899,
        observedAt: firstObservedAt,
      })
      observations = productItem
        ? listWatchlistObservations(productItem.id)
        : []
      check(
        "repeated product task_state dedupes same check",
        observations.length === 1,
        observations
      )

      setTaskState(productTask.id, {
        url: productUrl,
        productName: "Sage the Oracle Dual Boiler",
        lowestInStockPriceEur: 899,
        observedAt: nextObservedAt,
      })
      observations = productItem
        ? listWatchlistObservations(productItem.id)
        : []
      check(
        "next-day same product price records a new observation",
        observations.length === 2 &&
          observations[0].ts === firstObservedAt &&
          observations[1].ts === nextObservedAt,
        observations
      )
    }

    // --- terminal one-shot pruning -------------------------------------------
    const { finishRun, pruneTerminalOneShots, listTaskRuns, recordTaskRun } =
      await import("@/lib/scheduling/store")

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

    // ---- Inbox → watch user_signal plumbing (behavioral learning feed) ----
    {
      const {
        createInboxConversation,
        markInboxRead,
        deleteInboxConversation,
        forkInboxToConversation,
        logInboxDirectAction,
      } = await import("@/lib/scheduling/store")
      const { createMonitorWatch, listWatchEvents } = await import(
        "@/lib/monitor/store"
      )

      const watch = createMonitorWatch({
        title: "Gmail triage",
        source: "gmail",
        target: "inbox",
        rule: { kind: "gmail_query", q: "in:inbox is:unread" },
      })
      const signalsFor = (kind: string) =>
        listWatchEvents(watch.id, { kinds: ["user_signal"] }).filter(
          (e) => e.payload?.signal === kind
        )

      const sigTask = createScheduledTask({
        title: "Smart monitor smoke task",
        action: { kind: "tool", toolId: "noop", args: {}, summary: "noop" },
        schedule: { kind: "every", everyMs: hourMs },
        enabled: true,
        createdBy: "system",
      })
      const mkItem = (suffix: string, watchIds?: string[]) =>
        createInboxConversation({
          taskId: sigTask.id,
          title: `Notification ${suffix}`,
          watchIds,
          messages: [
            {
              id: `msg_sig_${suffix}`,
              role: "assistant",
              content: "Something happened.",
              timestamp: Date.now(),
            },
          ],
        })

      // Linked item: open → opened; delete after read → dismissed_read.
      const linked = mkItem("a", [watch.id])
      markInboxRead(linked)
      check("open records user_signal opened", signalsFor("opened").length === 1)
      markInboxRead(linked)
      check(
        "second open of already-read item records nothing",
        signalsFor("opened").length === 1
      )
      deleteInboxConversation(linked)
      check(
        "delete-after-read records dismissed_read",
        signalsFor("dismissed_read").length === 1 &&
          signalsFor("dismissed_unread").length === 0
      )

      // Delete WITHOUT opening → dismissed_unread (strongest noise signal).
      const unreadItem = mkItem("b", [watch.id])
      deleteInboxConversation(unreadItem)
      check(
        "delete-unread records dismissed_unread",
        signalsFor("dismissed_unread").length === 1
      )

      // Reply (fork) → replied; quick action → quick_action with the tool.
      const replyItem = mkItem("c", [watch.id])
      forkInboxToConversation(replyItem)
      check("reply records replied", signalsFor("replied").length === 1)
      logInboxDirectAction({
        conversationId: replyItem,
        messageId: "msg_sig_c",
        actionId: "archive",
        tool: "gmail.archive",
        params: { messageId: "g1" },
        result: "ok",
        sourceKind: "gmail",
        sourceTarget: "g1",
      })
      const quick = signalsFor("quick_action")
      check(
        "quick action records quick_action with tool",
        quick.length === 1 && quick[0].payload?.tool === "gmail.archive"
      )
      logInboxDirectAction({
        conversationId: replyItem,
        messageId: "msg_sig_c",
        actionId: "archive",
        tool: "gmail.archive",
        params: { messageId: "g1" },
        result: "error",
        errorMessage: "boom",
        sourceKind: "gmail",
        sourceTarget: "g1",
      })
      check(
        "failed quick action records no signal",
        signalsFor("quick_action").length === 1
      )

      // Unlinked item (no watchIds) → interactions record nothing.
      const before = listWatchEvents(watch.id, { kinds: ["user_signal"] }).length
      const unlinked = mkItem("d")
      markInboxRead(unlinked)
      deleteInboxConversation(unlinked)
      check(
        "unlinked inbox item records no signals",
        listWatchEvents(watch.id, { kinds: ["user_signal"] }).length === before
      )

      // Engagement aggregate reaches the wake briefing.
      const sigPrompt = buildSmartMonitorAgentPrompt({
        now: Date.now(),
        taskId: sigTask.id,
        taskState: {},
      })
      check(
        "wake briefing aggregates engagement signals",
        sigPrompt.includes("User engagement with this watch's notifications") &&
          sigPrompt.includes("dismissed unread"),
        sigPrompt.split("\n").find((l) => l.includes("User engagement"))
      )
    }
  } finally {
    Date.now = realDateNow
    if (originalStateDir === undefined) delete process.env.ORCHESTRATOR_STATE_DIR
    else process.env.ORCHESTRATOR_STATE_DIR = originalStateDir
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
