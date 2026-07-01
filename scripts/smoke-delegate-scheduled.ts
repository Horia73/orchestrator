/**
 * Smoke test: a scheduled/monitor run can delegate to a sub-agent.
 *
 * Regression guard for the "FOREIGN KEY constraint failed" that blocked
 * `delegate_to` from inside scheduled-task agent runs. A scheduled run mints its
 * conversation id up front but only persists a real inbox row if it surfaces;
 * meanwhile a sub-agent's agent_threads row FK-references conversations(id). The
 * fix writes a hidden placeholder conversation for the run's lifetime, promotes
 * it on surface, and discards it when the run stays silent.
 *
 * Run: npx tsx scripts/smoke-delegate-scheduled.ts
 */
import fs from "fs"
import os from "os"
import path from "path"

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-sched-smoke-"))
const originalStateDir = process.env.ORCHESTRATOR_STATE_DIR
process.env.ORCHESTRATOR_STATE_DIR = tmpRoot
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

  try {
    const {
      createAgentThread,
      getAgentThread,
    } = await import("@/lib/db")
    const {
      ensureScheduledRunConversation,
      discardScheduledRunConversation,
      createInboxConversation,
      listInboxConversations,
    } = await import("@/lib/scheduling/store")

    // ---- The bug: no parent row → sub-agent thread FK fails ----------------
    let threwWithoutParent = false
    try {
      createAgentThread({
        conversationId: `inbox_${"missing-parent"}`,
        agentId: "browser_agent",
        createdByAgentId: "orchestrator",
      })
    } catch {
      threwWithoutParent = true
    }
    check(
      "delegate without a parent conversation still fails (FK enforced)",
      threwWithoutParent
    )

    // ---- The fix: placeholder makes delegation succeed ---------------------
    const convId = `inbox_${"sched-run-1"}`
    ensureScheduledRunConversation({
      id: convId,
      taskId: "task_1",
      title: "Nightly Resend check",
    })

    let thread: { id: string } | null = null
    let delegateError: unknown = null
    try {
      thread = createAgentThread({
        conversationId: convId,
        agentId: "browser_agent",
        createdByAgentId: "orchestrator",
      })
    } catch (err) {
      delegateError = err
    }
    check(
      "delegate_to from a scheduled run succeeds after placeholder",
      thread && !delegateError,
      delegateError instanceof Error ? delegateError.message : delegateError
    )

    // ---- Placeholder is invisible until the run surfaces -------------------
    check(
      "placeholder does not appear in the Inbox",
      !listInboxConversations().some((c) => c.id === convId)
    )

    // ---- Surface: placeholder is promoted, child thread preserved ----------
    createInboxConversation({
      id: convId,
      taskId: "task_1",
      title: "Nightly Resend check — 2 broadcasts sent",
      messages: [
        {
          id: `msg_${"a"}`,
          role: "assistant",
          content: "Both broadcasts delivered.",
          timestamp: Date.now(),
        },
      ],
    })
    const surfaced = listInboxConversations().find((c) => c.id === convId)
    check("surfaced run promotes the placeholder into the Inbox", Boolean(surfaced))
    check(
      "promoted inbox item shows its real title + message",
      surfaced?.title === "Nightly Resend check — 2 broadcasts sent" &&
        surfaced?.messageCount === 1,
      surfaced
    )
    check(
      "promotion preserves the child sub-agent thread",
      thread ? Boolean(getAgentThread(thread.id)) : false
    )

    // ---- Silent run: placeholder + child thread are cleaned up -------------
    const silentId = `inbox_${"sched-run-2"}`
    ensureScheduledRunConversation({
      id: silentId,
      taskId: "task_2",
      title: "Quiet monitor pass",
    })
    const silentThread = createAgentThread({
      conversationId: silentId,
      agentId: "browser_agent",
      createdByAgentId: "orchestrator",
    })
    discardScheduledRunConversation(silentId)
    check(
      "silent run discards its placeholder",
      !listInboxConversations().some((c) => c.id === silentId)
    )
    check(
      "discarding the placeholder cascades away its sub-agent thread",
      getAgentThread(silentThread.id) === null
    )

    // ---- Safety: discard never touches a promoted inbox item ---------------
    discardScheduledRunConversation(convId)
    check(
      "discard is scoped to placeholders — a promoted inbox item survives",
      listInboxConversations().some((c) => c.id === convId)
    )
  } finally {
    if (originalStateDir === undefined) delete process.env.ORCHESTRATOR_STATE_DIR
    else process.env.ORCHESTRATOR_STATE_DIR = originalStateDir
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }

  if (failures > 0) {
    console.error(`delegate-scheduled smoke failed: ${failures}`)
    process.exit(1)
  }
  console.log("delegate-scheduled smoke passed")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
