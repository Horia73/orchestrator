import type { Message } from "@/lib/types"
export {
  buildModelRetryRecoveryContext,
  MAX_MODEL_RETRIES_BEFORE_FALLBACK,
  shouldTryModelFallback,
  type ModelRetryRecoveryAttempt,
} from "@/lib/ai/model-fallback"

export type ChatRequestBody = {
  conversationId?: unknown
  messageId?: unknown
  newMessage?: unknown
  messages?: unknown
  promptContext?: unknown
  promptContextSource?: unknown
  activateIntegrations?: unknown
  preferredFallbackIndex?: unknown
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
