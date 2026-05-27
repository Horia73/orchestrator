import { randomUUID } from "crypto"

import type { AgentRunEvent, ToolExecutionContext } from "@/lib/ai/agents/types"
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
  getTaskState,
  recordTaskRun,
  setTaskState,
} from "./store"
import { sendInboxPushNotification } from "@/lib/push-notifications"
import { normalizeInboxReplyActions } from "@/lib/ai/tools/notify"
import { persistArtifactsFromMessage } from "@/lib/artifacts/persist-message"
import {
  appendMissingArtifactBlocks,
  stripArtifactBlocksForPreview,
} from "@/lib/artifacts/text"

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
  opts: { trigger: "schedule" | "manual" } = { trigger: "schedule" }
): Promise<ScheduledRunResult> {
  const conversationId = `inbox_${randomUUID()}`
  const isOnce = task.schedule.kind === "once"
  const userMsg: Message = {
    id: `msg_${randomUUID()}`,
    role: "user",
    content: triggerNote(task, firedAt),
    timestamp: firedAt,
  }

  let ok = false
  let assistantContent: string
  let reasoning: ReasoningEntry[] | undefined
  let contentSegments: ContentSegment[] | undefined
  let attachments: Message["attachments"]
  let error: string | undefined
  const notifications: NotifyRequest[] = []

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
      if (task.action.monitorKind === "smart") {
        const { buildSmartMonitorAgentPrompt } =
          await import("@/lib/monitoring/smart-monitor")
        summary = "Smart monitor agent wake completed."
        briefPrompt = buildSmartMonitorAgentPrompt({
          now: firedAt,
          taskId: task.id,
          taskState: getTaskState(task.id),
        })
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
                }
                const body = typeof a?.body === "string" ? a.body.trim() : ""
                if (body)
                  notifications.push({
                    title: normalizeInboxSubject(a?.title),
                    body,
                    actions: normalizeInboxReplyActions(a.actions),
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
          if (capturedState !== undefined) {
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
              }
              const body = typeof a?.body === "string" ? a.body.trim() : ""
              if (body)
                notifications.push({
                  title: normalizeInboxSubject(a?.title),
                  body,
                  actions: normalizeInboxReplyActions(a.actions),
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
  let surface = false
  let inboxBody = assistantContent
  if (!ok) {
    surface = true // errors always surface
  } else if (opts.trigger === "manual") {
    surface = true // the user pressed Run now and is watching
  } else if (task.action.kind === "agent" || task.action.kind === "monitor") {
    if (notifications.length > 0) {
      surface = true
      inboxBody = appendMissingArtifactBlocks(
        bodyFromNotifications(notifications),
        assistantContent
      )
    }
  } else if (task.action.kind === "tool") {
    surface = isOnce // one-shot tool → confirm; recurring tool success → silent
  }

  let inboxConversationId: string | null = null
  if (surface) {
    inboxConversationId = conversationId
    const notificationSurface = notifications.length > 0
    const inboxTitle = notificationSurface
      ? subjectFromNotifications(notifications, task.title)
      : task.title
    const assistantMsg: Message = {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      content: inboxBody,
      reasoning: notificationSurface ? undefined : reasoning,
      contentSegments: notificationSurface ? undefined : contentSegments,
      attachments: notificationSurface ? undefined : attachments,
      replyActions: notificationSurface
        ? notifications.flatMap((n) => n.actions ?? [])
        : undefined,
      timestamp: Date.now(),
    }
    createInboxConversation({
      id: conversationId,
      taskId: task.id,
      title: inboxTitle,
      messages: notificationSurface ? [assistantMsg] : [userMsg, assistantMsg],
    })
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
