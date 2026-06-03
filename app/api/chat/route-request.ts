import type { Message } from "@/lib/types"

export type ChatRequestBody = {
  conversationId?: unknown
  messageId?: unknown
  newMessage?: unknown
  messages?: unknown
  promptContext?: unknown
  activateIntegrations?: unknown
}

function isRequestMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<Message>
  return (
    typeof candidate.id === "string" &&
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    typeof candidate.timestamp === "number" &&
    Number.isFinite(candidate.timestamp)
  )
}

function slimRequestMessage(message: Message): Message {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    attachments: Array.isArray(message.attachments)
      ? message.attachments
      : undefined,
    timestamp: message.timestamp,
  }
}

export function requestMessagesFromBody(body: ChatRequestBody): Message[] {
  if (isRequestMessage(body.newMessage)) {
    return [slimRequestMessage(body.newMessage)]
  }
  if (!Array.isArray(body.messages)) return []
  return body.messages.filter(isRequestMessage).map(slimRequestMessage)
}

export function shouldTryModelFallback(
  error: string | null | undefined
): boolean {
  const message = (error ?? "").toLowerCase()
  if (!message || message.includes("aborted")) return false
  return (
    message.includes("api key") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("rate_limit") ||
    message.includes("out of usage") ||
    message.includes("usage limit") ||
    message.includes("resource_exhausted") ||
    message.includes("exhausted") ||
    message.includes("overloaded") ||
    message.includes("capacity") ||
    message.includes("unavailable") ||
    message.includes("expired") ||
    message.includes("429") ||
    message.includes("503") ||
    message.includes("401") ||
    message.includes("model") ||
    message.includes("streaming")
  )
}
