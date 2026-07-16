"use client"

import type {
  Attachment,
  Conversation,
  Message,
  ToolCallReasoningEntry,
} from "@/lib/types"
import type { ChatFollowUpSnapshot } from "@/lib/chat-followup-types"
import type {
  ActiveChatStream,
  MessagePageResponse,
} from "./chat-store-utils"

const CHAT_REQUEST_BODY_SOFT_LIMIT_BYTES = 7_500_000

function requestBodySize(body: string): number {
  return new TextEncoder().encode(body).byteLength
}

function slimMessageForChatRequest(message: Message): Message {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    attachments: message.attachments,
    timestamp: message.timestamp,
  }
}

function buildChatStreamRequestBody(input: {
  conversationId: string
  messageId: string
  messages: Message[]
  promptContext?: string
  promptContextSource?: string
  activateIntegrations?: string[]
  preferredFallbackIndex?: number
  followUpId?: string
}) {
  const fullBody = JSON.stringify(input)
  if (requestBodySize(fullBody) <= CHAT_REQUEST_BODY_SOFT_LIMIT_BYTES) {
    return fullBody
  }

  return JSON.stringify({
    ...input,
    messages: input.messages.map(slimMessageForChatRequest),
  })
}

export function updateConversationReadState(
  conversationId: string,
  read: boolean
) {
  return fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ read }),
  })
}

export function updateConversationArchiveState(
  conversationId: string,
  archived: boolean
) {
  return fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  })
}

export async function requestConversationTitle(
  conversationId: string,
  body: {
    userText?: string
    assistantText?: string
    attachmentNames?: string[]
    currentTitle?: string
  }
): Promise<{ title: string; changed: boolean } | null> {
  try {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/title`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    )
    if (!res.ok) return null
    const data = await res.json()
    return typeof data?.title === "string"
      ? { title: data.title, changed: Boolean(data.changed) }
      : null
  } catch {
    return null
  }
}

export function stopChatStream(conversationId: string, messageId?: string | null) {
  return fetch("/api/chat/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, messageId: messageId ?? undefined }),
  })
}

export async function fetchConversationSummaries(): Promise<unknown> {
  const res = await fetch("/api/conversations?summary=1", {
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchConversationMessagePage(
  conversationId: string,
  limit: number,
  before?: string,
  // The initial visible page can use "mixed": only the newest tail hydrates
  // heavy reasoning/tool payloads, while older rows stay slim and hydrate on
  // explicit open. Older history pages stay "slim".
  detail: "slim" | "full" | "mixed" = "slim",
  fullTail = 0
): Promise<MessagePageResponse> {
  const beforeParam =
    before === undefined ? "" : `&before=${encodeURIComponent(before)}`
  const fullTailParam =
    detail === "mixed" ? `&fullTail=${encodeURIComponent(String(fullTail))}` : ""
  const res = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}&detail=${detail}${fullTailParam}${beforeParam}`,
    { cache: "no-store" }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<MessagePageResponse>
}

export async function fetchConversationMessageDetails(
  conversationId: string,
  messageId: string,
  detail: "full" | "tool-summary" = "full"
): Promise<Message> {
  const detailParam = detail === "tool-summary" ? "?detail=tool-summary" : ""
  const res = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}${detailParam}`,
    { cache: "no-store" }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { message?: Message }
  if (!data.message) throw new Error("Missing message")
  return data.message
}

export async function fetchConversationToolCallDetails(
  conversationId: string,
  messageId: string,
  toolCallId: string
): Promise<ToolCallReasoningEntry> {
  const res = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}?toolCallId=${encodeURIComponent(toolCallId)}`,
    { cache: "no-store" }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { toolCall?: ToolCallReasoningEntry }
  if (!data.toolCall) throw new Error("Missing tool call")
  return data.toolCall
}

export interface ChatRuntimeState {
  stream: ActiveChatStream | null
  followUps: ChatFollowUpSnapshot[]
}

export async function fetchChatRuntimeState(
  conversationId: string
): Promise<ChatRuntimeState | null> {
  try {
    const res = await fetch(
      `/api/chat/active?conversationId=${encodeURIComponent(conversationId)}`,
      {
        cache: "no-store",
      }
    )
    if (!res.ok) return null
    const data = await res.json()
    return {
      stream: data.active
        ? {
            conversationId,
            messageId:
              typeof data.messageId === "string" ? data.messageId : "unknown",
            startedAt:
              typeof data.startedAt === "number" ? data.startedAt : Date.now(),
          }
        : null,
      followUps: Array.isArray(data.followUps)
        ? data.followUps.filter(
            (entry: unknown): entry is ChatFollowUpSnapshot =>
              Boolean(entry) &&
              typeof entry === "object" &&
              typeof (entry as ChatFollowUpSnapshot).followUpId === "string" &&
              typeof (entry as ChatFollowUpSnapshot).userMessageId === "string" &&
              (entry as ChatFollowUpSnapshot).source === "user" &&
              typeof (entry as ChatFollowUpSnapshot).queuedAt === "number"
          )
        : [],
    }
  } catch {
    return null
  }
}

export async function fetchActiveChatStreams(): Promise<ActiveChatStream[]> {
  try {
    const res = await fetch("/api/chat/active", { cache: "no-store" })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data.streams)
      ? data.streams.filter(
          (stream: unknown): stream is ActiveChatStream =>
            Boolean(stream) &&
            typeof stream === "object" &&
            typeof (stream as ActiveChatStream).conversationId === "string" &&
            typeof (stream as ActiveChatStream).messageId === "string" &&
            typeof (stream as ActiveChatStream).startedAt === "number"
        )
      : []
  } catch {
    return []
  }
}

export function deleteConversationRequest(conversationId: string) {
  return fetch(`/api/conversations/${conversationId}`, { method: "DELETE" })
}

export async function uploadChatAttachments(
  files: File[]
): Promise<Attachment[] | undefined> {
  const formData = new FormData()
  for (const file of files) formData.append("files", file)
  const uploadRes = await fetch("/api/upload", {
    method: "POST",
    body: formData,
  })
  if (!uploadRes.ok) return undefined
  const data = await uploadRes.json()
  return data.attachments
}

export function createConversationRequest(conversation: Conversation) {
  return fetch("/api/conversations", {
    method: "POST",
    body: JSON.stringify(conversation),
  })
}

export function addConversationMessageRequest(
  conversationId: string,
  message: Message
) {
  return fetch(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify(message),
  })
}

export function startChatStreamRequest({
  conversationId,
  messageId,
  messages,
  promptContext,
  promptContextSource,
  activateIntegrations,
  preferredFallbackIndex,
  followUpId,
  signal,
}: {
  conversationId: string
  messageId: string
  messages: Message[]
  promptContext?: string
  promptContextSource?: string
  activateIntegrations?: string[]
  preferredFallbackIndex?: number
  followUpId?: string
  signal: AbortSignal
}) {
  return fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: buildChatStreamRequestBody({
      conversationId,
      messageId,
      messages,
      promptContext,
      promptContextSource,
      activateIntegrations,
      preferredFallbackIndex,
      followUpId,
    }),
    signal,
  })
}

/**
 * Steering: send a user message while a turn is still streaming. The server
 * either injects it into the running turn right now (`steered: true` —
 * provider supports mid-turn steering, e.g. codex) or persists + queues it to
 * run as the next turn (`queued: true`). Returns null on network failure
 * (caller falls back to a normal send when the server reports no active
 * stream).
 */
export async function steerChatMessage(
  conversationId: string,
  message: Message
): Promise<{
  queued: boolean
  active: boolean
  steered: boolean
  followUpId?: string
} | null> {
  // steerPending is client-side render state — never ship it to the server.
  const wireMessage: Message = { ...message }
  delete wireMessage.steerPending
  try {
    const res = await fetch("/api/chat/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, message: wireMessage }),
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null)
    if (!data || typeof data.queued !== "boolean") return null
    return {
      queued: data.queued,
      active: Boolean(data.active),
      steered: Boolean(data.steered),
      followUpId: typeof data.followUpId === "string" ? data.followUpId : undefined,
    }
  } catch {
    return null
  }
}
