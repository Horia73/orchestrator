import { NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { getAgent } from "@/lib/ai/agents/registry"
import { runTextSubAgent } from "@/lib/ai/agents/runner"
import type { AgentRunEvent, ToolExecutionContext } from "@/lib/ai/agents/types"
import { normalizeInboxReplyActions } from "@/lib/ai/tools/notify"
import type {
  Attachment,
  InboxReplyAction,
  Message,
  ReasoningEntry,
} from "@/lib/types"
import { persistArtifactsFromMessage } from "@/lib/artifacts/persist-message"
import { repairMessageArtifactsWithAgent } from "@/lib/ai/agents/repair-generate"
import {
  appendMissingArtifactBlocks,
  dedupeArtifactNotifications,
} from "@/lib/artifacts/text"
import { resolveExistingUploadPath } from "@/lib/uploads"
import {
  appendInboxMessage,
  forkInboxToConversation,
  getInboxConversation,
} from "@/lib/scheduling/store"
import { clearAgentRun, registerAgentRun } from "@/lib/agent-runs"
import { resolveRequestOrigin } from "@/lib/app-origin"
import { proxyToDurableAiWorker, shouldProxyToDurableAiWorker } from "@/lib/ai/durable-worker"
import { runWithRequestProfile } from "@/lib/profiles/server"

const ATTACHMENT_TYPES = new Set<Attachment["type"]>([
  "image",
  "pdf",
  "document",
  "spreadsheet",
  "presentation",
  "audio",
  "video",
  "other",
])

function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === "string" &&
    typeof candidate.filename === "string" &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.size === "number" &&
    typeof candidate.type === "string" &&
    ATTACHMENT_TYPES.has(candidate.type as Attachment["type"])
  )
}

function parseAttachmentsField(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return []
  const valid: Attachment[] = []
  for (const entry of value) {
    if (!isAttachment(entry)) continue
    if (!resolveExistingUploadPath(entry.id)) continue
    valid.push(entry)
  }
  return valid
}

function clip(text: string, max = 5000): string {
  return text.length > max ? `${text.slice(0, max)}\n...(truncated)` : text
}

function formatTranscriptAttachments(attachments: Attachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return ""
  const lines = attachments
    .filter((a) => a && typeof a.id === "string")
    .map((a) => {
      const mime = typeof a.mimeType === "string" ? a.mimeType.split(";")[0].trim() : ""
      const name = typeof a.filename === "string" && a.filename.trim() ? a.filename.trim() : a.id
      return mime ? `- ${name} (${mime})` : `- ${name}`
    })
  if (lines.length === 0) return ""
  return `\n\nAttached files:\n${lines.join("\n")}`
}

function buildInlineReplyPrompt(args: {
  title: string
  messages: Message[]
  userReply: string
}): string {
  const recent = args.messages.slice(-16)
  const transcript = recent
    .map((m) => {
      const role = m.role === "user" ? "User/trigger" : "Assistant/result"
      return `### ${role}\n${clip(m.content)}${formatTranscriptAttachments(m.attachments)}`
    })
    .join("\n\n")

  return [
    "<inbox_reply_context>",
    "You are continuing a scheduled-run Inbox item inline. Do not fork or open a normal chat; answer in this same Inbox thread.",
    "The user may have clicked a quick-reply button. Treat the latest user reply as their instruction, but all normal confirmation boundaries still apply.",
    "If the answer needs another simple choice, call notify_inbox with `body` and short `actions`; the actions become quick-reply buttons in this same Inbox thread. If no choice is needed, just answer normally.",
    "When you call notify_inbox, that body is the user-visible reply. After the tool call, return only a short internal status, not a second user-facing answer.",
    "Quick actions are only user replies, not permission to perform irreversible, external, costly, destructive, message-sending, account-changing, or sensitive-data actions without the exact confirmation required by policy.",
    "</inbox_reply_context>",
    "",
    `Inbox item: ${args.title}`,
    "",
    "<prior_inbox_thread>",
    transcript || "(empty)",
    "</prior_inbox_thread>",
    "",
    "<latest_user_reply>",
    args.userReply,
    "</latest_user_reply>",
  ].join("\n")
}

async function parseBody(
  request: Request
): Promise<{ content: string; attachments: Attachment[] } | null> {
  const raw = await request.text()
  if (!raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as {
      content?: unknown
      attachments?: unknown
    }
    const content =
      typeof parsed.content === "string" ? parsed.content.trim() : ""
    const attachments = parseAttachmentsField(parsed.attachments)
    if (!content && attachments.length === 0) return null
    return { content, attachments }
  } catch {
    return null
  }
}

async function continueInboxReply(args: {
  runId: string
  id: string
  inboxTitle: string
  messages: Message[]
  userReply: string
  attachments?: Attachment[]
  appOrigin: string
}): Promise<void> {
  try {
    const agent = getAgent("inbox-agent") ?? getAgent("orchestrator")
    if (!agent) {
      appendInboxMessage(args.id, {
        id: `msg_${randomUUID()}`,
        role: "assistant",
        content: "Orchestrator agent is not available.",
        status: "error",
        timestamp: Date.now(),
      })
      return
    }

    const notifications: Array<{
      title?: string
      body: string
      actions?: InboxReplyAction[]
    }> = []
    let topRunId: string | null = null
    const doneByRun = new Map<
      string,
      Extract<AgentRunEvent, { type: "agent_done" }>
    >()
    const parentCtx: ToolExecutionContext = {
      callerAgentId: "__inbox__",
      depth: 0,
      conversationId: args.id,
      parentRequestId: `inbox_${randomUUID()}`,
      appOrigin: args.appOrigin,
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
          const notifyBody = typeof a.body === "string" ? a.body.trim() : ""
          if (notifyBody) {
            notifications.push({
              title: typeof a.title === "string" ? a.title : undefined,
              body: notifyBody,
              actions: normalizeInboxReplyActions(a.actions),
            })
          }
        }
      },
    }

    const prompt = buildInlineReplyPrompt({
      title: args.inboxTitle,
      messages: args.messages,
      userReply: args.userReply,
    })
    const result = await runTextSubAgent({
      target: agent,
      prompt,
      parentCtx,
      attachments: args.attachments,
    })
    const done = topRunId ? doneByRun.get(topRunId) : undefined
    const visibleNotifications = dedupeArtifactNotifications(notifications)
    if (visibleNotifications.length < notifications.length) {
      console.warn(
        `Deduplicated ${notifications.length - visibleNotifications.length} duplicate inbox notification(s)`
      )
    }
    let assistantContent = result.success
      ? visibleNotifications.length > 0
        ? visibleNotifications
            .map((n) => (n.title ? `**${n.title}**\n\n${n.body}` : n.body))
            .join("\n\n---\n\n")
        : String(
            (result.data as { output?: unknown } | undefined)?.output ??
              done?.content ??
              ""
          ).trim() || "(no output)"
      : `Scheduled Inbox reply failed.\n\n${result.error ?? "Unknown error"}`

    if (result.success && visibleNotifications.length > 0) {
      assistantContent = appendMissingArtifactBlocks(
        assistantContent,
        String((result.data as { output?: unknown } | undefined)?.output ?? done?.content ?? "")
      )
    }

    if (result.success) {
      // Validate + model-repair any strict-schema artifact BEFORE the message
      // is stored, so the reply never lands with a card persist would reject.
      const repair = await repairMessageArtifactsWithAgent({
        content: assistantContent,
        sourceAgent: agent,
        conversationId: args.id,
        surface: "inbox-reply",
        appOrigin: args.appOrigin,
      })
      assistantContent = repair.content
    }

    const notificationSurface = result.success && visibleNotifications.length > 0
    const assistantMsg: Message = {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      content: assistantContent,
      status: result.success ? "ok" : "error",
      contentSegments: notificationSurface ? undefined : done?.contentSegments,
      reasoning: notificationSurface
        ? undefined
        : (done?.reasoning as ReasoningEntry[] | undefined),
      attachments: notificationSurface ? undefined : done?.attachments,
      replyActions:
        notificationSurface
          ? visibleNotifications.flatMap((n) => n.actions ?? [])
          : undefined,
      timestamp: Date.now(),
    }

    appendInboxMessage(args.id, assistantMsg)
    const persisted = persistArtifactsFromMessage({
      conversationId: args.id,
      messageId: assistantMsg.id,
      content: assistantMsg.content,
    })
    if (persisted.errors.length > 0) {
      console.warn(
        `Failed to persist ${persisted.errors.length} inbox-reply artifact(s):`,
        persisted.errors
      )
    }
  } catch (error) {
    console.error("Failed to continue inbox reply", error)
    appendInboxMessage(args.id, {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      content: "Scheduled Inbox reply failed.",
      status: "error",
      timestamp: Date.now(),
    })
  } finally {
    clearAgentRun(args.runId)
  }
}

// Empty POST keeps the legacy escape hatch: fork the Inbox transcript
// into a normal chat. POST with { content } replies inline in the same item.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return runWithRequestProfile(request, async () => {
      const guard = guardSensitiveRequest(request)
      if (guard) return guard
      if (shouldProxyToDurableAiWorker()) return proxyToDurableAiWorker(request)

      try {
        const { id } = await params
        const body = await parseBody(request)
        if (body) {
          const inbox = getInboxConversation(id)
          if (!inbox)
            return NextResponse.json(
              { error: "Inbox item not found" },
              { status: 404 }
            )

          const runId = `inbox_run_${randomUUID()}`
          const registered = registerAgentRun({
            id: runId,
            kind: "inbox",
            conversationId: id,
            startedAt: Date.now(),
          })
          if (!registered) {
            return NextResponse.json(
              { error: "Update in progress. Please retry after reconnect.", code: "update_in_progress" },
              { status: 503, headers: { "Retry-After": "30" } }
            )
          }

          const userMsg: Message = {
            id: `msg_${randomUUID()}`,
            role: "user",
            content: body.content,
            timestamp: Date.now(),
            attachments: body.attachments.length > 0 ? body.attachments : undefined,
          }
          if (!appendInboxMessage(id, userMsg)) {
            clearAgentRun(runId)
            return NextResponse.json(
              { error: "Inbox item not found" },
              { status: 404 }
            )
          }

          void continueInboxReply({
            runId,
            id,
            inboxTitle: inbox.title,
            messages: [...inbox.messages, userMsg],
            userReply: body.content,
            attachments: body.attachments.length > 0 ? body.attachments : undefined,
            appOrigin: resolveRequestOrigin(request),
          })

          return NextResponse.json({
            item: getInboxConversation(id),
            pending: true,
          })
        }

        const conversationId = forkInboxToConversation(id)
        if (!conversationId)
          return NextResponse.json(
            { error: "Inbox item not found" },
            { status: 404 }
          )
        return NextResponse.json({ conversationId })
      } catch (error) {
        console.error("Failed to reply to inbox item", error)
        return NextResponse.json(
          { error: "Failed to reply to inbox item" },
          { status: 500 }
        )
      }
  })
}
