import type { Attachment, Message } from "@/lib/types"
import type { StreamingReasoning } from "./chat-store-utils"

interface StreamMessageSnapshot {
  messageId: string
  content: string
  contentSegments: NonNullable<Message["contentSegments"]>
  reasoning: StreamingReasoning
  thinking: string
  thinkingDuration: number
  attachments: Attachment[]
}

type StreamTerminalEvent = Record<string, unknown>

function persistedAssistantMessage(
  value: unknown,
  expectedId: string
): Message | null {
  if (!value || typeof value !== "object") return null
  const message = value as Message
  if (
    message.id !== expectedId ||
    message.role !== "assistant" ||
    typeof message.content !== "string" ||
    typeof message.timestamp !== "number"
  ) {
    return null
  }
  return message
}

function durationFrom(event: StreamTerminalEvent): number | undefined {
  return typeof event.durationMs === "number" ? event.durationMs : undefined
}

function attachmentsFrom(
  event: StreamTerminalEvent,
  snapshot: StreamMessageSnapshot
): Attachment[] | undefined {
  const attachments = Array.isArray(event.attachments)
    ? (event.attachments as Attachment[])
    : snapshot.attachments
  return attachments.length > 0 ? attachments : undefined
}

export function completedAssistantMessage(
  event: StreamTerminalEvent,
  snapshot: StreamMessageSnapshot,
  now = Date.now()
): Message {
  return (
    persistedAssistantMessage(event.message, snapshot.messageId) ?? {
      id: snapshot.messageId,
      role: "assistant",
      content: snapshot.content,
      status: "ok",
      contentSegments: snapshot.contentSegments,
      reasoning: snapshot.reasoning,
      thinking: snapshot.thinking || undefined,
      thinkingDuration:
        (typeof event.thinkingDuration === "number"
          ? event.thinkingDuration
          : 0) ||
        snapshot.thinkingDuration ||
        undefined,
      durationMs: durationFrom(event),
      attachments: attachmentsFrom(event, snapshot),
      timestamp: now,
    }
  )
}

export function stoppedAssistantMessage(
  event: StreamTerminalEvent,
  snapshot: StreamMessageSnapshot,
  now = Date.now()
): Message {
  return (
    persistedAssistantMessage(event.message, snapshot.messageId) ?? {
      id: snapshot.messageId,
      role: "assistant",
      content: snapshot.content,
      status: "aborted",
      contentSegments: snapshot.contentSegments,
      reasoning: snapshot.reasoning,
      thinking: snapshot.thinking || undefined,
      thinkingDuration: snapshot.thinkingDuration || 0,
      durationMs: durationFrom(event),
      attachments: attachmentsFrom(event, snapshot),
      timestamp: now,
    }
  )
}

export function erroredAssistantMessage(
  event: StreamTerminalEvent,
  snapshot: StreamMessageSnapshot,
  now = Date.now()
): { message: Message; error: string } {
  const error =
    typeof event.error === "string" && event.error.trim()
      ? event.error
      : "The model runtime returned an error."
  const errorBody = snapshot.content.trim()
    ? `${snapshot.content}\n\n[Error: ${error}]`
    : `[Error: ${error}]`

  const message =
    persistedAssistantMessage(event.message, snapshot.messageId) ??
    ({
      id: snapshot.messageId,
      role: "assistant",
      content: errorBody,
      status: "error",
      contentSegments:
        snapshot.contentSegments.length > 0
          ? snapshot.contentSegments
          : [{ phase: 0, content: errorBody }],
      reasoning: snapshot.reasoning,
      thinking: snapshot.thinking || undefined,
      thinkingDuration: snapshot.thinkingDuration || 0,
      durationMs: durationFrom(event),
      attachments: attachmentsFrom(event, snapshot),
      timestamp: now,
    } satisfies Message)

  return { message, error }
}
