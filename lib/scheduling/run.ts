import { randomUUID } from "crypto"

import type {
  AgentConfig,
  AgentRunEvent,
  ToolExecutionContext,
} from "@/lib/ai/agents/types"
import type { SmartCheapPassResult } from "@/lib/monitoring/smart-monitor-cheap-pass"
import type {
  ContentSegment,
  InboxReplyAction,
  Message,
  ReasoningEntry,
} from "@/lib/types"

import type { ScheduledTask } from "./schema"
import { describeSchedule } from "./compute"
import {
  createInboxConversation,
  discardScheduledRunConversation,
  ensureScheduledRunConversation,
  getTaskState,
  recordTaskRun,
  setTaskState,
} from "./store"
import { sendInboxPushNotification } from "@/lib/push-notifications"
import {
  normalizeInboxReplyActions,
  normalizeNotifyWatchIds,
} from "@/lib/ai/tools/notify"
import { persistArtifactsFromMessage } from "@/lib/artifacts/persist-message"
import {
  appendMissingArtifactBlocks,
  dedupeArtifactNotifications,
  stripArtifactBlocksForPreview,
} from "@/lib/artifacts/text"
import { clearAgentRun, registerAgentRun } from "@/lib/agent-runs"
import { resolveAppOrigin } from "@/lib/app-origin"

// Heavy AI modules (runner pulls in the whole tool/provider graph) are
// imported lazily so the scheduler boot path and this module stay cheap and
// cycle-free — they load only when a task actually fires.

export interface ScheduledRunResult {
  ok: boolean
  /** Inbox conversation id when the run surfaced, else null. */
  conversationId: string | null
  /** Whether this run produced an Inbox item. */
  surfaced: boolean
  /** Full run output — always kept in Past runs, even when silent. */
  summary: string
  error?: string
}

function triggerNote(task: ScheduledTask, firedAt: number): string {
  const what =
    task.action.kind === "agent"
      ? task.action.prompt
      : task.action.kind === "tool"
        ? `${task.action.summary}\n\nTool: \`${task.action.toolId}\``
        : `Consolidated ${task.action.monitorKind} monitor.`
  return [
    `⏰ Scheduled task **${task.title}** fired at ${new Date(firedAt).toISOString()}.`,
    `Schedule: ${describeSchedule(task.schedule)}.`,
    "",
    what,
  ].join("\n")
}

function clip(text: string, max = 6000): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text
}

function formatToolResult(
  success: boolean,
  data: unknown,
  error: string | undefined,
  summary: string
): string {
  if (!success) {
    return `❌ **${summary}** failed.\n\n${error ?? "Unknown error"}`
  }
  let body: string
  if (data == null) body = "(no output)"
  else if (typeof data === "string") body = data
  else body = "```json\n" + JSON.stringify(data, null, 2) + "\n```"
  return `✅ **${summary}**\n\n${clip(body)}`
}

interface NotifyRequest {
  title?: string
  body: string
  actions?: InboxReplyAction[]
  /** Smart Monitor watch ids this notification is about (engagement learning). */
  watchIds?: string[]
}

function normalizeInboxSubject(value: unknown): string | undefined {
  const subject =
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
  if (!subject) return undefined
  return subject.length > 120
    ? `${subject.slice(0, 117).trimEnd()}...`
    : subject
}

function subjectFromNotifications(
  notifications: NotifyRequest[],
  fallback: string
): string {
  const subjects = notifications
    .map((notification) => normalizeInboxSubject(notification.title))
    .filter((subject): subject is string => Boolean(subject))
  if (subjects.length === 0) return fallback

  const uniqueSubjects = Array.from(new Set(subjects))
  if (uniqueSubjects.length === 1) return uniqueSubjects[0]

  const suffix = ` + ${uniqueSubjects.length - 1} more`
  const first = uniqueSubjects[0]
  const base =
    first.length + suffix.length > 120
      ? `${first.slice(0, Math.max(1, 120 - suffix.length - 3)).trimEnd()}...`
      : first
  return `${base}${suffix}`
}

function bodyFromNotifications(notifications: NotifyRequest[]): string {
  if (notifications.length === 1) return notifications[0].body
  return notifications
    .map((notification) => {
      const subject = normalizeInboxSubject(notification.title)
      return subject
        ? `**${subject}**\n\n${notification.body}`
        : notification.body
    })
    .join("\n\n---\n\n")
}

/**
 * Execute a fired task. The run is ALWAYS recorded in Past runs (audit). It
 * only reaches the user's Inbox when it explicitly surfaces:
 *   - an `agent` action that called `notify_inbox`;
 *   - any error/crash (always surfaced);
 *   - a one-shot `tool` action (the user wants a confirmation it ran);
 *   - a manual "Run now" (the user is actively watching).
 * Recurring tool successes and "nothing noteworthy" agent runs stay silent.
 * Never throws.
 */
export async function runScheduledTask(
  task: ScheduledTask,
  firedAt: number,
  opts: {
    trigger: "schedule" | "manual"
    /** When the scheduler will hand a failed one-shot to the escalation/recovery
     *  wake, suppress the raw-error Inbox surface here so the user sees one
     *  coherent recovery message instead of a stack trace followed by a fix. */
    suppressAutoErrorSurface?: boolean
  } = { trigger: "schedule" }
): Promise<ScheduledRunResult> {
  const conversationId = `inbox_${randomUUID()}`
  const isOnce = task.schedule.kind === "once"
  const userMsg: Message = {
    id: `msg_${randomUUID()}`,
    role: "user",
    content: triggerNote(task, firedAt),
    timestamp: firedAt,
  }

  const runId = `sched_run_${randomUUID()}`
  registerAgentRun({
    id: runId,
    kind: "scheduled",
    conversationId,
    startedAt: firedAt,
  })

  // Scheduled runs have no incoming HTTP request, so derive the app origin
  // from configuration. Without this, prompt-side integration status checks
  // and ActivateIntegrationTools both short-circuit to `state=unknown`, since
  // the snapshot module cannot refresh without an origin.
  const appOrigin = resolveAppOrigin()

  // Set true once (and only if) the run surfaces and its placeholder row is
  // promoted to a real inbox conversation; the finally uses it to decide whether
  // to discard the hidden placeholder created below.
  let surfacedToInbox = false

  try {
  // Persist a hidden parent conversation row before the agent runs so any
  // `delegate_to` sub-agent thread (agent_threads → conversations FK) can be
  // created from within this scheduled/monitor run. It stays invisible until the
  // run surfaces (then promoted to origin='inbox') or is discarded in `finally`.
  ensureScheduledRunConversation({
    id: conversationId,
    taskId: task.id,
    title: task.title,
  })
  let ok = false
  let assistantContent: string
  let reasoning: ReasoningEntry[] | undefined
  let contentSegments: ContentSegment[] | undefined
  let attachments: Message["attachments"]
  let error: string | undefined
  const notifications: NotifyRequest[] = []
  // Watches that contributed buffered items to a Smart Monitor wake — the
  // unambiguous-attribution fallback when the agent omitted notify_inbox
  // watch_ids (engagement learning still works for single-watch wakes).
  let monitorContributingWatchIds: string[] = []
  let repairSourceAgent: AgentConfig | null = null

  try {
    if (task.action.kind === "tool") {
      const { getTool } = await import("@/lib/ai/tools/registry")
      const { executeTool } = await import("@/lib/ai/tools/executor")
      const tool = getTool(task.action.toolId)
      if (!tool) {
        ok = false
        error = `Unknown tool: ${task.action.toolId}`
        assistantContent = formatToolResult(
          false,
          null,
          error,
          task.action.summary
        )
      } else {
        const ctx: ToolExecutionContext = {
          callerAgentId: "__scheduler__",
          depth: 0,
          conversationId,
          parentRequestId: `sched_${randomUUID()}`,
          appOrigin,
        }
        const result = await executeTool(tool, task.action.args, ctx)
        ok = result.success
        error = result.success ? undefined : result.error
        assistantContent = formatToolResult(
          result.success,
          result.data,
          result.error,
          task.action.summary
        )
      }
    } else if (task.action.kind === "monitor") {
      // Consolidated monitor heartbeats: Watchlist markets, Smart Monitor,
      // and Microscripts. Only markets/smart may wake a model from here;
      // Microscripts execute their own due scripts and surface directly.
      let briefPrompt: string | undefined
      let summary: string
      // Set on the Smart Monitor branch so the post-wake block can finalize the
      // cheap-pass gate (advance lastWakeAt, clear the pending buffer on success).
      let smartPass: SmartCheapPassResult | null = null
      if (task.action.monitorKind === "smart") {
        // The CHEAP, no-model pass. It watermarks every connector source and
        // only returns a wake prompt when a genuinely-new item is buffered AND
        // the agent-chosen minimum sleep elapsed (or the safety ceiling hit).
        // Otherwise the tick is silent — the model is NOT woken.
        const { runSmartMonitorCheapPass } =
          await import("@/lib/monitoring/smart-monitor-cheap-pass")
        smartPass = await runSmartMonitorCheapPass({
          priorState: getTaskState(task.id),
          now: firedAt,
          taskId: task.id,
        })
        // Persist gate bookkeeping BEFORE any wake (full buffer + prior
        // lastWakeAt) so a crashed wake never loses buffered items.
        try {
          setTaskState(task.id, smartPass.nextState)
        } catch {
          /* best-effort */
        }
        summary = smartPass.summary
        briefPrompt = smartPass.noteworthy ? smartPass.briefPrompt : undefined
        monitorContributingWatchIds = Array.from(
          new Set(smartPass.gate.pending.map((p) => p.watchId))
        )
      } else if (task.action.monitorKind === "microscripts") {
        const { runMicroscriptsHeartbeat } =
          await import("@/lib/microscripts/heartbeat")
        const pass = await runMicroscriptsHeartbeat({ now: firedAt })
        summary = pass.summary
        briefPrompt = undefined
      } else {
        const { runMarketsCheapPass } =
          await import("@/lib/monitoring/markets-heartbeat")
        const pass = await runMarketsCheapPass({
          priorState: getTaskState(task.id),
          now: firedAt,
        })
        try {
          setTaskState(task.id, pass.nextState)
        } catch {
          /* best-effort */
        }
        summary = pass.summary
        briefPrompt = pass.noteworthy ? pass.briefPrompt : undefined
      }

      if (!briefPrompt) {
        ok = true
        assistantContent = summary // recorded in Past runs; stays silent
      } else {
        const { runTextSubAgent } = await import("@/lib/ai/agents/runner")
        const { getAgent } = await import("@/lib/ai/agents/registry")
        const monitorAgentId =
          task.action.monitorKind === "smart" ? "smart-monitor-agent" : "orchestrator"
        const agent = getAgent(monitorAgentId) ?? getAgent("orchestrator")
        if (!agent) {
          ok = false
          error = "orchestrator agent missing"
          assistantContent = `❌ ${error}`
        } else {
          repairSourceAgent = agent
          let topRunId: string | null = null
          let capturedState: unknown = undefined
          const doneByRun = new Map<
            string,
            Extract<AgentRunEvent, { type: "agent_done" }>
          >()
          const parentCtx: ToolExecutionContext = {
            callerAgentId: "__scheduler__",
            depth: 0,
            conversationId,
            parentRequestId: `sched_${randomUUID()}`,
            scheduledTaskId: task.id,
            scheduledFiredAt: firedAt,
            appOrigin,
            // Every monitor wake notifies / records state, so the inbox
            // primitives (notify_inbox, set_task_state, monitor_wake_feedback)
            // must be warmed up regardless of monitor kind; smart wakes also get
            // their monitoring + source capabilities.
            preactivatedCapabilities: [
              "inbox",
              ...(task.action.monitorKind === "smart"
                ? (
                    await import("@/lib/monitoring/smart-monitor")
                  ).getSmartMonitorWakePreactivatedCapabilities()
                : []),
            ],
            onAgentEvent: (event) => {
              if (event.type === "agent_start" && topRunId === null)
                topRunId = event.runId
              if (event.type === "agent_done") doneByRun.set(event.runId, event)
              if (
                event.type === "agent_tool_call" &&
                event.toolCall?.name === "notify_inbox"
              ) {
                const a = event.toolCall.arguments as {
                  title?: unknown
                  body?: unknown
                  actions?: unknown
                  watch_ids?: unknown
                }
                const body = typeof a?.body === "string" ? a.body.trim() : ""
                if (body)
                  notifications.push({
                    title: normalizeInboxSubject(a?.title),
                    body,
                    actions: normalizeInboxReplyActions(a.actions),
                    watchIds: normalizeNotifyWatchIds(a.watch_ids),
                  })
              }
              if (
                event.type === "agent_tool_call" &&
                event.toolCall?.name === "set_task_state"
              ) {
                const a = event.toolCall.arguments as { state?: unknown }
                if (
                  a?.state &&
                  typeof a.state === "object" &&
                  !Array.isArray(a.state)
                )
                  capturedState = a.state
              }
            },
          }
          const result = await runTextSubAgent({
            target: agent,
            prompt: briefPrompt,
            parentCtx,
          })
          const done = topRunId ? doneByRun.get(topRunId) : undefined
          if (result.success) {
            ok = true
            const data = result.data as { output?: string } | undefined
            assistantContent =
              (data?.output ?? done?.content ?? summary).trim() || summary
            reasoning = done?.reasoning
            contentSegments = done?.contentSegments
          } else {
            ok = false
            error = result.error
            assistantContent = `❌ ${task.action.monitorKind === "smart" ? "Smart" : "Markets"} monitor wake failed.\n\n${result.error ?? "Unknown error"}`
            reasoning = done?.reasoning
          }
          if (smartPass) {
            // Smart Monitor: merge the agent's post-wake state with the gate
            // bookkeeping. Advances lastWakeAt (natural backoff) and clears the
            // pending buffer only on a successful wake, while honouring any
            // minWakeGapMs/maxWakeGapMs the agent tuned.
            try {
              const { finalizeSmartMonitorWake } = await import(
                "@/lib/monitoring/smart-monitor-cheap-pass"
              )
              setTaskState(
                task.id,
                finalizeSmartMonitorWake({
                  aiState: capturedState as
                    | Record<string, unknown>
                    | undefined,
                  preWakeState: smartPass.nextState,
                  gate: smartPass.gate,
                  firedAt,
                  ok,
                })
              )
            } catch {
              /* best-effort */
            }
            // Closed-loop follow-ups the wake just handled (resolved or
            // deadline-fired, engine-disabled) are one-shot — sweep them now
            // so they never accumulate in /monitor. Only after a SUCCESSFUL
            // wake: on failure the pending buffer survives and the next wake
            // still needs the watch record. A follow-up the wake re-armed via
            // monitor_wake_feedback was re-enabled, so the sweep skips it.
            if (ok) {
              try {
                const { removeCompletedFollowUpWatches } = await import(
                  "@/lib/monitor/store"
                )
                removeCompletedFollowUpWatches()
              } catch {
                /* best-effort */
              }
            }
          } else if (capturedState !== undefined) {
            try {
              setTaskState(task.id, capturedState)
            } catch {
              /* best-effort */
            }
          }
        }
      }
    } else {
      const { runTextSubAgent } = await import("@/lib/ai/agents/runner")
      const { getAgent } = await import("@/lib/ai/agents/registry")
      const agent = getAgent(task.action.agentId) ?? getAgent("orchestrator")
      if (!agent) {
        ok = false
        error = `Unknown agent: ${task.action.agentId}`
        assistantContent = `❌ ${error}`
      } else {
        repairSourceAgent = agent
        let topRunId: string | null = null
        let capturedState: unknown = undefined
        const doneByRun = new Map<
          string,
          Extract<AgentRunEvent, { type: "agent_done" }>
        >()
        const parentCtx: ToolExecutionContext = {
          callerAgentId: "__scheduler__",
          depth: 0,
          conversationId,
          parentRequestId: `sched_${randomUUID()}`,
          scheduledTaskId: task.id,
          scheduledFiredAt: firedAt,
          appOrigin,
          // Scheduled agent tasks routinely notify the inbox / persist task
          // state, so warm up the inbox primitives even though the run is the
          // plain orchestrator (which gates them out of the main-chat surface).
          preactivatedCapabilities: ["inbox"],
          onAgentEvent: (event) => {
            if (event.type === "agent_start" && topRunId === null)
              topRunId = event.runId
            if (event.type === "agent_done") doneByRun.set(event.runId, event)
            if (
              event.type === "agent_tool_call" &&
              event.toolCall?.name === "notify_inbox"
            ) {
              const a = event.toolCall.arguments as {
                title?: unknown
                body?: unknown
                actions?: unknown
                watch_ids?: unknown
              }
              const body = typeof a?.body === "string" ? a.body.trim() : ""
              if (body)
                notifications.push({
                  title: normalizeInboxSubject(a?.title),
                  body,
                  actions: normalizeInboxReplyActions(a.actions),
                  watchIds: normalizeNotifyWatchIds(a.watch_ids),
                })
            }
            // The agent's private per-task memory write (last wins).
            if (
              event.type === "agent_tool_call" &&
              event.toolCall?.name === "set_task_state"
            ) {
              const a = event.toolCall.arguments as { state?: unknown }
              if (
                a?.state &&
                typeof a.state === "object" &&
                !Array.isArray(a.state)
              )
                capturedState = a.state
            }
          },
        }
        const priorState = getTaskState(task.id)
        const recurring = task.schedule.kind !== "once"
        // Adaptive pacing is opt-in (set at scheduling time by the orchestrator
        // ONLY when the user accepted flexible cadence). A fixed-cadence task the
        // user explicitly chose ("daily at 8am", "every 30 minutes") must NOT be
        // told it can self-pace — that previously caused tasks like "check price
        // once a day" to be retuned to 15m by the model. Default is stay-on-cadence.
        const adaptive =
          task.action.kind === "agent" && task.action.adaptive === true
        const cadenceLine = !recurring
          ? "This is a one-shot task; do not reschedule it."
          : adaptive
            ? "This is a recurring task with ADAPTIVE pacing enabled (the user accepted flexible cadence). Default monitor tiering: start at 15m; after 4 quiet runs widen to 30m; after 8 more quiet runs widen to 1h; during known quiet hours use 2h-4h or the next active window depending on urgency. When activity returns, a deadline gets close, an error occurs, or the user engages, tighten back toward 15m. Store quietRuns, cadenceTier, watermarks/lastSeen, lastValue, and lastNotifiedAt in <task_state>. Use reschedule_task on this taskId for clear trends only; do not thrash, never go more frequent than the user allowed without asking. Learn durable active/quiet-hour patterns over time and persist them to USER.md/MEMORY.md/MONITORS.md."
            : "This is a recurring task on a FIXED cadence the user requested. Stay on it: do NOT call reschedule_task to widen or tighten timing. Use <task_state> for watermarks/last-seen so you do not re-report; surface via notify_inbox only when noteworthy."
        const stateBlock = [
          "<task_run_context>",
          `taskId: ${task.id}`,
          `currentSchedule: ${describeSchedule(task.schedule)}`,
          cadenceLine,
          "</task_run_context>",
          "<task_state>",
          "Your private memory for this recurring task (not shared, not the user chat).",
          priorState
            ? JSON.stringify(priorState, null, 2)
            : "(empty — first run)",
          "</task_state>",
          "Use it to avoid re-reporting and to detect changes. To remember anything for next time, call set_task_state with the full new state.",
          "",
        ].join("\n")
        const result = await runTextSubAgent({
          target: agent,
          prompt: stateBlock + task.action.prompt,
          parentCtx,
        })
        const done = topRunId ? doneByRun.get(topRunId) : undefined
        if (result.success) {
          ok = true
          const data = result.data as
            | { output?: string; attachments?: Message["attachments"] }
            | undefined
          assistantContent =
            (data?.output ?? done?.content ?? "").trim() || "(no output)"
          reasoning = done?.reasoning
          contentSegments = done?.contentSegments
          attachments = done?.attachments ?? data?.attachments
        } else {
          ok = false
          error = result.error
          assistantContent = `❌ Scheduled run failed.\n\n${result.error ?? "Unknown error"}`
          reasoning = done?.reasoning
        }
        if (capturedState !== undefined) {
          try {
            setTaskState(task.id, capturedState)
          } catch {
            /* best-effort */
          }
        }
      }
    }
  } catch (err) {
    ok = false
    error = err instanceof Error ? err.message : "Unknown scheduled-run error"
    assistantContent = `❌ Scheduled run crashed.\n\n${error}`
  }

  // ---- Surfacing decision (default: silent) -----------------------------
  const visibleNotifications = dedupeArtifactNotifications(notifications)
  if (visibleNotifications.length < notifications.length) {
    console.warn(
      `Deduplicated ${notifications.length - visibleNotifications.length} duplicate scheduled notification(s)`
    )
  }
  let surface = false
  let inboxBody = assistantContent
  if (!ok) {
    // Errors normally surface immediately. When a failed one-shot will be handed
    // to the escalation/recovery wake, stay silent here — that wake owns the
    // user-facing message (transient blips self-heal without bothering the user).
    surface = !opts.suppressAutoErrorSurface
  } else if (opts.trigger === "manual") {
    surface = true // the user pressed Run now and is watching
  } else if (task.action.kind === "agent" || task.action.kind === "monitor") {
    if (visibleNotifications.length > 0) {
      surface = true
      inboxBody = appendMissingArtifactBlocks(
        bodyFromNotifications(visibleNotifications),
        assistantContent
      )
    }
  } else if (task.action.kind === "tool") {
    surface = isOnce // one-shot tool → confirm; recurring tool success → silent
  }

  let inboxConversationId: string | null = null
  if (surface) {
    inboxConversationId = conversationId
    const notificationSurface = visibleNotifications.length > 0
    const inboxTitle = notificationSurface
      ? subjectFromNotifications(visibleNotifications, task.title)
      : task.title
    // Validate + model-repair any strict-schema artifact BEFORE the message is
    // stored, so a scheduled run never delivers a card persist would reject.
    // Dynamic import for the same agent-runner cycle reasons as above.
    const { repairMessageArtifactsWithAgent } = await import(
      "@/lib/ai/agents/repair-generate"
    )
    const sourceAgent =
      repairSourceAgent ??
      (await import("@/lib/ai/agents/registry")).getAgent("orchestrator")
    if (sourceAgent) {
      const repair = await repairMessageArtifactsWithAgent({
        content: inboxBody,
        sourceAgent,
        conversationId,
        surface: "scheduled-run",
        scheduledTaskId: task.id,
      })
      inboxBody = repair.content
    }
    const assistantMsg: Message = {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      content: inboxBody,
      reasoning: notificationSurface ? undefined : reasoning,
      contentSegments: notificationSurface ? undefined : contentSegments,
      attachments: notificationSurface ? undefined : attachments,
      replyActions: notificationSurface
        ? visibleNotifications.flatMap((n) => n.actions ?? [])
        : undefined,
      timestamp: Date.now(),
    }
    // Link the Inbox item back to its monitor watches so user behavior on it
    // (open / reply / dismiss / quick action) records user_signal events for
    // engagement learning. Explicit notify_inbox watch_ids win; a single-watch
    // smart wake is unambiguous enough to attribute without them.
    const explicitWatchIds = Array.from(
      new Set(visibleNotifications.flatMap((n) => n.watchIds ?? []))
    )
    const watchIds =
      explicitWatchIds.length > 0
        ? explicitWatchIds
        : monitorContributingWatchIds.length === 1
          ? monitorContributingWatchIds
          : []
    createInboxConversation({
      id: conversationId,
      taskId: task.id,
      title: inboxTitle,
      messages: notificationSurface ? [assistantMsg] : [userMsg, assistantMsg],
      watchIds: watchIds.length > 0 ? watchIds : undefined,
    })
    // The placeholder row is now a real inbox conversation — keep it in finally.
    surfacedToInbox = true
    const persisted = persistArtifactsFromMessage({
      conversationId,
      messageId: assistantMsg.id,
      content: assistantMsg.content,
    })
    if (persisted.errors.length > 0) {
      console.warn(
        `Failed to persist ${persisted.errors.length} scheduled-run artifact(s):`,
        persisted.errors
      )
    }
    void sendInboxPushNotification({
      conversationId,
      title: inboxTitle,
      body: stripArtifactBlocksForPreview(inboxBody),
    })
  }

  recordTaskRun({
    taskId: task.id,
    startedAt: firedAt,
    status: ok ? "ok" : "error",
    trigger: opts.trigger,
    surfaced: surface,
    conversationId: inboxConversationId,
    summary: assistantContent,
    reasoning,
    contentSegments,
    attachments,
    error: error ?? null,
  })

  return {
    ok,
    conversationId: inboxConversationId,
    surfaced: surface,
    summary: assistantContent,
    error,
  }
  } finally {
    clearAgentRun(runId)
    // A silent run (or one that threw) never promoted its placeholder to an
    // inbox item — drop the hidden row so scheduled runs don't accumulate empty
    // conversations. No-op once promoted (scoped to origin='scheduled-run').
    if (!surfacedToInbox) {
      try {
        discardScheduledRunConversation(conversationId)
      } catch (err) {
        console.warn("Failed to discard scheduled-run placeholder conversation:", err)
      }
    }
  }
}

/**
 * Post a system notice into the Inbox (used for missed / interrupted one-shots)
 * and record it in Past runs. Returns the created inbox conversation id.
 */
export function postInboxNotice(task: ScheduledTask, text: string): string {
  const now = Date.now()
  const id = createInboxConversation({
    taskId: task.id,
    title: task.title,
    messages: [
      {
        id: `msg_${randomUUID()}`,
        role: "assistant",
        content: text,
        timestamp: now,
      },
    ],
  })
  void sendInboxPushNotification({
    conversationId: id,
    title: task.title,
    body: text,
  })
  recordTaskRun({
    taskId: task.id,
    startedAt: now,
    status: "error",
    trigger: "schedule",
    surfaced: true,
    conversationId: id,
    summary: text,
    error: "missed",
  })
  return id
}

// ---------------------------------------------------------------------------
// Scheduler escalation — when a one-shot does NOT complete cleanly (it failed
// when it fired, or it was missed while the app was offline), the scheduler
// wakes the orchestrator with full context and lets it DECIDE: recover a
// transient failure, judge whether a missed action is still worth doing, or
// surface a clear explanation with next steps. This preserves the
// "deterministic deferred work" guarantees while making exceptional outcomes
// agentic instead of a dead row plus a raw error in the Inbox.
// ---------------------------------------------------------------------------

export type EscalationSituation =
  | { kind: "errored"; error: string | undefined }
  | { kind: "missed"; dueAt: number }

function describePlannedAction(task: ScheduledTask): string {
  if (task.action.kind === "tool") {
    let args = "{}"
    try {
      args = JSON.stringify(task.action.args ?? {})
    } catch {
      args = "(unserializable arguments)"
    }
    return [
      "Planned action — a deterministic tool call:",
      `• what it does: ${task.action.summary}`,
      `• tool id: ${task.action.toolId}`,
      `• arguments: ${clip(args, 1500)}`,
    ].join("\n")
  }
  if (task.action.kind === "agent") {
    return [
      "Planned action — wake a model with this instruction:",
      clip(task.action.prompt, 3000),
    ].join("\n")
  }
  return `Planned action: ${task.action.kind} (system-managed).`
}

function humanizeDuration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000))
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? "" : "s"}`
}

function buildEscalationPrompt(
  task: ScheduledTask,
  situation: EscalationSituation,
  now: number
): string {
  const head = [
    "This is a SCHEDULER ESCALATION run — automatic background handling triggered because a one-shot scheduled task did not complete normally. It is NOT a fresh user request, and no one is necessarily watching the screen right now.",
    "",
    `Task: "${task.title}"`,
    `Original schedule: ${describeSchedule(task.schedule)}.`,
    "",
    describePlannedAction(task),
    "",
  ]
  if (situation.kind === "errored") {
    return [
      ...head,
      `It FAILED when it fired. Error reported: ${situation.error ?? "Unknown error"}`,
      "",
      "Decide what to do, using your judgement and whatever context or tools you need:",
      "- If the failure looks TRANSIENT (network, rate limit, a provider/integration hiccup, a momentary auth blip) and the action is still worth doing, just DO IT NOW: for a tool action, perform the equivalent tool call yourself with the same arguments; for an agent action, carry out the original instruction now.",
      "- If retrying as-is would just fail again (expired/invalid credentials, a misconfigured or disconnected integration, a missing permission, changed external state), FIX the root cause if you safely can and then complete it. If you cannot, call notify_inbox with a specific, plain-language explanation and concrete next steps for the user.",
      "- If the action is no longer useful, or is unsafe to perform now, skip it and finish.",
      "- Follow <safety_core>: for irreversible, external, costly, or message-sending actions, only act autonomously if the original task setup already authorized it; otherwise ask via notify_inbox first.",
      "",
      "Surface to the user via notify_inbox ONLY when there is something they need to know or decide. If you quietly recovered it, a short notify_inbox confirmation is good; if nothing useful came of it, finish silently (this run is logged to Past runs regardless). Do not reschedule this same task id — if you want a later retry, create a fresh scheduled task.",
    ].join("\n")
  }
  const lateness = humanizeDuration(Math.max(0, now - situation.dueAt))
  return [
    ...head,
    `It was MISSED: it was due at ${new Date(situation.dueAt).toISOString()} but this app was offline then, so it never ran. It is now about ${lateness} late (current time ${new Date(now).toISOString()}).`,
    "",
    "Decide, based on context, whether running it now still makes sense:",
    "- If it is still useful AND clearly safe/idempotent to do late (an internal toggle or state change, fetching or summarizing information, a reminder that is still relevant), DO IT NOW and notify the user if appropriate.",
    "- If it was time-sensitive and the window has passed (a deadline, a meeting, a limited drop / booking / redemption that is over), do NOT perform it; briefly tell the user via notify_inbox that it was missed and is now stale, plus any genuinely useful context or alternative.",
    "- If it is irreversible, external, costly, or message-sending and there is ANY doubt about doing it late, do NOT execute it autonomously — call notify_inbox with the context and offer it as an explicit choice / action for the user.",
    "- If it is pointless now, finish silently.",
    "",
    "Default to CAUTION on real-world side effects; default to HELPFULNESS on benign or idempotent actions. Follow <safety_core>. Do not reschedule this same task id.",
  ].join("\n")
}

/**
 * Wake the orchestrator to handle a one-shot that errored or was missed. Wraps
 * the escalation prompt in a synthetic agent action and runs it through the
 * normal scheduled-run path, so it records a Past-runs entry under the same task
 * and surfaces to the Inbox only if the agent calls notify_inbox (or the
 * recovery run itself errors). Called directly by the scheduler — never via the
 * escalate-on-error path — so it cannot recurse. Never throws.
 */
export async function runSchedulerEscalation(
  task: ScheduledTask,
  situation: EscalationSituation,
  now: number
): Promise<ScheduledRunResult> {
  const prompt = buildEscalationPrompt(task, situation, now)
  const syntheticTask: ScheduledTask = {
    ...task,
    action: { kind: "agent", agentId: "orchestrator", prompt, adaptive: false },
  }
  return runScheduledTask(syntheticTask, now, { trigger: "schedule" })
}
