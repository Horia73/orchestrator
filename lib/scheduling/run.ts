import { randomUUID } from "crypto"

import type { AgentRunEvent, ToolExecutionContext } from "@/lib/ai/agents/types"
import type { ContentSegment, Message, ReasoningEntry } from "@/lib/types"

import type { ScheduledTask } from "./schema"
import { describeSchedule } from "./compute"
import {
  createInboxConversation,
  getTaskState,
  recordTaskRun,
  setTaskState,
} from "./store"
import { sendInboxPushNotification } from "@/lib/push-notifications"

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

      if (!pass.noteworthy || !pass.briefPrompt) {
        ok = true
        assistantContent = pass.summary // recorded in Past runs; stays silent
      } else {
        const { runTextSubAgent } = await import("@/lib/ai/agents/runner")
        const { getAgent } = await import("@/lib/ai/agents/registry")
        const agent = getAgent("orchestrator")
        if (!agent) {
          ok = false
          error = "orchestrator agent missing"
          assistantContent = `❌ ${error}`
        } else {
          let topRunId: string | null = null
          const doneByRun = new Map<
            string,
            Extract<AgentRunEvent, { type: "agent_done" }>
          >()
          const parentCtx: ToolExecutionContext = {
            callerAgentId: "__scheduler__",
            depth: 0,
            conversationId,
            parentRequestId: `sched_${randomUUID()}`,
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
                }
                const body = typeof a?.body === "string" ? a.body.trim() : ""
                if (body)
                  notifications.push({
                    title: typeof a?.title === "string" ? a.title : undefined,
                    body,
                  })
              }
            },
          }
          const result = await runTextSubAgent({
            target: agent,
            prompt: pass.briefPrompt,
            parentCtx,
          })
          const done = topRunId ? doneByRun.get(topRunId) : undefined
          if (result.success) {
            ok = true
            const data = result.data as { output?: string } | undefined
            assistantContent =
              (data?.output ?? done?.content ?? pass.summary).trim() ||
              pass.summary
            reasoning = done?.reasoning
            contentSegments = done?.contentSegments
          } else {
            ok = false
            error = result.error
            assistantContent = `❌ Markets monitor wake failed.\n\n${result.error ?? "Unknown error"}`
            reasoning = done?.reasoning
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
              }
              const body = typeof a?.body === "string" ? a.body.trim() : ""
              if (body)
                notifications.push({
                  title: typeof a?.title === "string" ? a.title : undefined,
                  body,
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
        const stateBlock = [
          "<task_run_context>",
          `taskId: ${task.id}`,
          `currentSchedule: ${describeSchedule(task.schedule)}`,
          recurring
            ? "This is a recurring task. You may self-pace: if <task_state>/history shows it has been quiet (nothing notable for many runs) or it is the user's known low-activity window (e.g. their sleep/quiet hours from USER.md), call reschedule_task on this taskId to widen the interval; tighten it again when activity returns. Learn the user's routine over time and persist durable patterns to USER.md."
            : "This is a one-shot task; do not reschedule it.",
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
      inboxBody = notifications
        .map((n) => (n.title ? `**${n.title}**\n\n${n.body}` : n.body))
        .join("\n\n---\n\n")
    }
  } else if (task.action.kind === "tool") {
    surface = isOnce // one-shot tool → confirm; recurring tool success → silent
  }

  let inboxConversationId: string | null = null
  if (surface) {
    inboxConversationId = conversationId
    const assistantMsg: Message = {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      content: inboxBody,
      reasoning,
      contentSegments,
      attachments,
      timestamp: Date.now(),
    }
    createInboxConversation({
      id: conversationId,
      taskId: task.id,
      title: task.title,
      messages: [userMsg, assistantMsg],
    })
    void sendInboxPushNotification({
      conversationId,
      title: task.title,
      body: inboxBody,
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
