"use client"

import type {
  AgentCallReasoningEntry,
  Conversation,
  Message,
  ReasoningEntry,
} from "@/lib/types"

export type StreamingReasoning = NonNullable<Message["reasoning"]>

export interface ActiveChatStream {
  conversationId: string
  messageId: string
  startedAt: number
}

export type StreamingStatus = "connecting" | "recovering" | "offline" | null

export function updateAgentEntry(
  reasoning: StreamingReasoning,
  runId: string,
  updater: (entry: AgentCallReasoningEntry) => AgentCallReasoningEntry
): StreamingReasoning {
  return reasoning.map((entry) => {
    if (entry.type !== "agent_call" || entry.runId !== runId) return entry
    return updater(entry)
  })
}

export function appendAgentThought(
  entry: AgentCallReasoningEntry,
  chunk: string,
  phase = entry.contentSegments?.at(-1)?.phase ?? 0
): AgentCallReasoningEntry {
  const reasoning = [...(entry.reasoning ?? [])]
  const last = reasoning[reasoning.length - 1]
  if (last?.type === "thought" && last.phase === phase) {
    reasoning[reasoning.length - 1] = { ...last, content: last.content + chunk }
  } else {
    reasoning.push({
      type: "thought",
      id: `thought_${reasoning.length + 1}`,
      phase,
      content: chunk,
    })
  }
  return { ...entry, reasoning }
}

export function appendAgentContent(
  entry: AgentCallReasoningEntry,
  chunk: string,
  phase = entry.contentSegments?.at(-1)?.phase ?? 0
): AgentCallReasoningEntry {
  const contentSegments = [...(entry.contentSegments ?? [])]
  const last = contentSegments[contentSegments.length - 1]
  if (last && last.phase === phase) {
    contentSegments[contentSegments.length - 1] = {
      ...last,
      content: last.content + chunk,
    }
  } else {
    contentSegments.push({ phase, content: chunk })
  }
  return { ...entry, content: entry.content + chunk, contentSegments }
}

export function markReasoningStopped(
  reasoning: ReasoningEntry[] | undefined,
  timestamp: number
): ReasoningEntry[] | undefined {
  if (!reasoning?.length) return reasoning
  return reasoning.map((entry) => {
    if (entry.type === "agent_call") {
      return {
        ...entry,
        status: entry.status === "running" ? "aborted" : entry.status,
        endedAt:
          entry.status === "running"
            ? (entry.endedAt ?? timestamp)
            : entry.endedAt,
        reasoning: markReasoningStopped(entry.reasoning, timestamp),
      }
    }
    if (entry.type === "tool_call" && entry.status === "running") {
      return {
        ...entry,
        status: "error",
        success: false,
        endedAt: entry.endedAt ?? timestamp,
        content: entry.content || "Stopped",
      }
    }
    return entry
  })
}

export const stoppedStreamState = {
  isStreaming: false,
  streamingConversationId: null as string | null,
  streamingContent: "",
  streamingContentSegments: [] as NonNullable<Message["contentSegments"]>,
  streamingReasoning: [] as StreamingReasoning,
  streamingMode: null as "reasoning" | "content" | null,
  streamingStatus: null as StreamingStatus,
  thinkingSeconds: 0,
  thinkingDone: false,
  streamingMessageId: null as string | null,
}

export function agentCallEntryFromStartEvent(
  data: Record<string, unknown>,
  phase: number,
  now = Date.now()
): AgentCallReasoningEntry | null {
  const runId = typeof data.runId === "string" ? data.runId : ""
  const agentId = typeof data.agentId === "string" ? data.agentId : ""
  if (!runId || !agentId) return null

  const agentName =
    typeof data.agentName === "string" ? data.agentName : agentId || "Agent"
  const kind = typeof data.kind === "string" ? data.kind : "text"

  return {
    type: "agent_call",
    id: `agent_${runId}`,
    phase,
    toolCallId:
      typeof data.toolCallId === "string" ? data.toolCallId : undefined,
    runId,
    agentThreadId:
      typeof data.agentThreadId === "string" ? data.agentThreadId : undefined,
    parentRunId:
      typeof data.parentRunId === "string" ? data.parentRunId : undefined,
    agentId,
    agentName,
    assignedName:
      typeof data.assignedName === "string" ? data.assignedName : undefined,
    taskLabel: typeof data.taskLabel === "string" ? data.taskLabel : undefined,
    kind: kind as AgentCallReasoningEntry["kind"],
    title: agentName,
    prompt: typeof data.prompt === "string" ? data.prompt : "",
    status: "running",
    startedAt: typeof data.startedAt === "number" ? data.startedAt : now,
    content: "",
    contentSegments: [],
    reasoning: [],
  }
}

export const INITIAL_MESSAGE_PAGE_SIZE = 32
export const INITIAL_MESSAGE_FULL_TAIL_SIZE = 8
export const OLDER_MESSAGE_PAGE_SIZE = 64
/** Server caps a message page at 200; use the max when paging toward a
 *  deep-link target so we reach it in as few round-trips as possible. */
export const CLIENT_MAX_MESSAGE_PAGE_SIZE = 200
export const STREAM_RECOVERY_ATTEMPTS = 8
export const STREAM_RECOVERY_DELAY_MS = 750

const CHAT_UNREAD_IDS_KEY = "chat:unread-ids"

export type ConversationLoadState =
  | "summary"
  | "loading"
  | "partial"
  | "full"
  | "error"

export interface ConversationMessagePageState {
  total: number
  loadedCount: number
  hasMore: boolean
  nextCursor: string | null
  isLoadingOlder: boolean
  error?: string
}

export interface MessagePageResponse {
  messages: Message[]
  total: number
  hasMore: boolean
  nextCursor: string | null
}

export function sortMessagesByTimeline(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const timeDelta = a.timestamp - b.timestamp
    return timeDelta !== 0 ? timeDelta : a.id.localeCompare(b.id)
  })
}

export function mergeMessagesById(
  existingMessages: Message[],
  incomingMessages: Message[]
): Message[] {
  const byId = new Map<string, Message>()
  for (const message of existingMessages) byId.set(message.id, message)
  for (const message of incomingMessages) {
    const existing = byId.get(message.id)
    byId.set(
      message.id,
      existing ? mergeMessagePreservingDetails(existing, message) : message
    )
  }
  return sortMessagesByTimeline(Array.from(byId.values()))
}

function mergeMessagePreservingDetails(
  existing: Message,
  incoming: Message
): Message {
  if (!incoming.deferred) return incoming

  const reasoning = existing.reasoning ?? incoming.reasoning
  const contentSegments = existing.contentSegments ?? incoming.contentSegments
  const toolCalls = existing.toolCalls ?? incoming.toolCalls
  const deferred = {
    reasoning: incoming.deferred.reasoning && !reasoning,
    contentSegments: incoming.deferred.contentSegments && !contentSegments,
    toolCalls: incoming.deferred.toolCalls && !toolCalls,
  }
  const hasDeferred =
    deferred.reasoning || deferred.contentSegments || deferred.toolCalls

  return {
    ...incoming,
    reasoning,
    contentSegments,
    toolCalls,
    ...(hasDeferred ? { deferred } : { deferred: undefined }),
  }
}

export function readUnreadConversationIds(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_UNREAD_IDS_KEY) ?? "[]")
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : []
    )
  } catch {
    return new Set()
  }
}

export function writeUnreadConversationIds(ids: Set<string>) {
  if (typeof window === "undefined") return
  localStorage.setItem(CHAT_UNREAD_IDS_KEY, JSON.stringify(Array.from(ids)))
}

function validTimestamp(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null
}

function getConversationUnreadActivityAt(
  conversation: Conversation
): number | null {
  const lastMessageAt =
    validTimestamp(conversation.lastMessageAt) ??
    validTimestamp(conversation.messages.at(-1)?.timestamp)
  const hasMessages =
    typeof lastMessageAt === "number" ||
    (conversation.messageCount ?? conversation.messages.length) > 0

  if (!hasMessages) return null

  return lastMessageAt
}

export function isConversationUnread(
  conversation: Conversation,
  visibleActiveConversationId?: string | null
): boolean {
  if (conversation.id === visibleActiveConversationId) return false

  const unreadActivityAt = getConversationUnreadActivityAt(conversation)
  if (typeof unreadActivityAt !== "number") return false

  return (
    typeof conversation.readAt !== "number" ||
    conversation.readAt < unreadActivityAt
  )
}

export function unreadSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

export function deriveUnreadConversationIds(
  conversations: Conversation[],
  visibleActiveConversationId?: string | null
): Set<string> {
  const ids = new Set<string>()
  for (const conversation of conversations) {
    if (isConversationUnread(conversation, visibleActiveConversationId)) {
      ids.add(conversation.id)
    }
  }
  return ids
}

function compactNotificationBody(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, "code block")
    .replace(/[*_`>#~-]/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180)
}

export class ChatFetchError extends Error {
  chatMessage?: string

  constructor(message: string, chatMessage?: string) {
    super(message)
    this.name = "ChatFetchError"
    this.chatMessage = chatMessage
  }
}

export function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isLikelyStreamInterruption(error: unknown): boolean {
  if (error instanceof ChatFetchError) return false
  if (error instanceof DOMException && error.name === "AbortError") return false

  const message = errorMessageFromUnknown(error).toLowerCase()
  return (
    error instanceof TypeError ||
    message.includes("load failed") ||
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("network error") ||
    message.includes("internet connection")
  )
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function isTerminalAssistantMessage(message: Message | null | undefined) {
  return Boolean(
    message?.role === "assistant" &&
    (message.status || typeof message.thinkingDuration === "number")
  )
}

async function hasPushNotificationSubscription(): Promise<boolean> {
  if (
    typeof window === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window)
  ) {
    return false
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration("/")
    const subscription = await registration?.pushManager.getSubscription()
    return Boolean(subscription)
  } catch {
    return false
  }
}

export async function showChatCompletionNotification(
  conversationId: string,
  conversation: Conversation | undefined,
  message: Message
) {
  if (typeof window === "undefined" || !("Notification" in window)) return
  if (Notification.permission !== "granted") return
  if (await hasPushNotificationSubscription()) return

  const title = conversation?.title || "Chat finished"
  const body =
    compactNotificationBody(message.content) ||
    "The assistant finished responding."
  const url = `/?chat=${encodeURIComponent(conversationId)}`

  try {
    if ("serviceWorker" in navigator) {
      let registration = await navigator.serviceWorker.getRegistration("/")
      registration ??= await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
      })
      await registration.showNotification(title, {
        body,
        tag: `chat-${conversationId}`,
        icon: "/icon.svg",
        badge: "/icon.svg",
        data: { url },
      })
      return
    }
  } catch {
    // Fall back to the page Notification constructor below.
  }

  const notification = new Notification(title, {
    body,
    tag: `chat-${conversationId}`,
    icon: "/icon.svg",
    data: { url },
  })
  notification.onclick = () => {
    window.focus()
    window.location.href = url
  }
}
