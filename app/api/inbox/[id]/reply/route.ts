import { NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { getAgent } from "@/lib/ai/agents/registry"
import { runTextSubAgent } from "@/lib/ai/agents/runner"
import type { AgentRunEvent, ToolExecutionContext } from "@/lib/ai/agents/types"
import { normalizeInboxReplyActions } from "@/lib/ai/tools/notify"
import type { InboxReplyAction, Message, ReasoningEntry } from "@/lib/types"
import { persistArtifactsFromMessage } from "@/lib/artifacts/persist-message"
import { appendMissingArtifactBlocks } from "@/lib/artifacts/text"
import {
  appendInboxMessage,
  forkInboxToConversation,
  getInboxConversation,
} from "@/lib/scheduling/store"

function clip(text: string, max = 5000): string {
  return text.length > max ? `${text.slice(0, max)}\n...(truncated)` : text
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
      return `### ${role}\n${clip(m.content)}`
    })
    .join("\n\n")

  return [
    "<inbox_reply_context>",
    "You are continuing a scheduled-run Inbox item inline. Do not fork or open a normal chat; answer in this same Inbox thread.",
    "The user may have clicked a quick-reply button. Treat the latest user reply as their instruction, but all normal confirmation boundaries still apply.",
    "If the answer needs another simple choice, call notify_inbox with `body` and short `actions`; the actions become quick-reply buttons in this same Inbox thread. If no choice is needed, just answer normally.",
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
): Promise<{ content?: string } | null> {
  const raw = await request.text()
  if (!raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as { content?: unknown }
    const content =
      typeof parsed.content === "string" ? parsed.content.trim() : ""
    return content ? { content } : null
  } catch {
    return null
  }
}

async function continueInboxReply(args: {
  id: string
  inboxTitle: string
  messages: Message[]
  userReply: string
}): Promise<void> {
  try {
    const agent = getAgent("orchestrator")
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
    const result = await runTextSubAgent({ target: agent, prompt, parentCtx })
    const done = topRunId ? doneByRun.get(topRunId) : undefined
    let assistantContent = result.success
      ? notifications.length > 0
        ? notifications
            .map((n) => (n.title ? `**${n.title}**\n\n${n.body}` : n.body))
            .join("\n\n---\n\n")
        : String(
            (result.data as { output?: unknown } | undefined)?.output ??
              done?.content ??
              ""
          ).trim() || "(no output)"
      : `Scheduled Inbox reply failed.\n\n${result.error ?? "Unknown error"}`

    if (result.success && notifications.length > 0) {
      assistantContent = appendMissingArtifactBlocks(
        assistantContent,
        String((result.data as { output?: unknown } | undefined)?.output ?? done?.content ?? "")
      )
    }

    const assistantMsg: Message = {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      content: assistantContent,
      status: result.success ? "ok" : "error",
      contentSegments: done?.contentSegments,
      reasoning: done?.reasoning as ReasoningEntry[] | undefined,
      attachments: done?.attachments,
      replyActions:
        notifications.length > 0
          ? notifications.flatMap((n) => n.actions ?? [])
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
  }
}

// Empty POST keeps the legacy escape hatch: fork the Inbox transcript
// into a normal chat. POST with { content } replies inline in the same item.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  try {
    const { id } = await params
    const body = await parseBody(request)
    if (body?.content) {
      const inbox = getInboxConversation(id)
      if (!inbox)
        return NextResponse.json(
          { error: "Inbox item not found" },
          { status: 404 }
        )

      const userMsg: Message = {
        id: `msg_${randomUUID()}`,
        role: "user",
        content: body.content,
        timestamp: Date.now(),
      }
      if (!appendInboxMessage(id, userMsg)) {
        return NextResponse.json(
          { error: "Inbox item not found" },
          { status: 404 }
        )
      }

      void continueInboxReply({
        id,
        inboxTitle: inbox.title,
        messages: [...inbox.messages, userMsg],
        userReply: body.content,
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
}
