"use client"

import type { Attachment, Conversation, Message } from "@/lib/types"
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
  activateIntegrations?: string[]
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

export function stopChatStream(conversationId: string) {
  return fetch("/api/chat/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId }),
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
  before?: string
): Promise<MessagePageResponse> {
  const beforeParam =
    before === undefined ? "" : `&before=${encodeURIComponent(before)}`
  const res = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}${beforeParam}`,
    { cache: "no-store" }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<MessagePageResponse>
}

export async function fetchActiveChatStream(
  conversationId: string
): Promise<ActiveChatStream | null> {
  try {
    const res = await fetch(
      `/api/chat/active?conversationId=${encodeURIComponent(conversationId)}`,
      {
        cache: "no-store",
      }
    )
    if (!res.ok) return null
    const data = await res.json()
    if (!data.active) return null
    return {
      conversationId,
      messageId:
        typeof data.messageId === "string" ? data.messageId : "unknown",
      startedAt:
        typeof data.startedAt === "number" ? data.startedAt : Date.now(),
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
  activateIntegrations,
  signal,
}: {
  conversationId: string
  messageId: string
  messages: Message[]
  promptContext?: string
  activateIntegrations?: string[]
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
      activateIntegrations,
    }),
    signal,
  })
}
