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

export function shouldSendAsSteering(args: {
  targetConversationId: string | null
  hasInternalFollowUp: boolean
  ownsStream: boolean
  ownedConversationId: string | null
  isStreaming: boolean
  streamingConversationId: string | null
  activeChatStreams: Record<string, ActiveChatStream>
}): boolean {
  if (args.hasInternalFollowUp || !args.targetConversationId) return false
  const target = args.targetConversationId
  return Boolean(
    (args.ownsStream && args.ownedConversationId === target) ||
      (args.isStreaming && args.streamingConversationId === target) ||
      args.activeChatStreams[target]
  )
}

export type StreamingStatus =
  | "connecting"
  | "recovering"
  | "offline"
  | "updating"
  | null

const CHAT_UPDATE_RETRY_DEFAULT_MS = 5_000
const CHAT_UPDATE_RETRY_MIN_MS = 1_000
const CHAT_UPDATE_RETRY_MAX_MS = 30_000

export function isChatUpdateInProgressResponse(
  status: number,
  payload: unknown,
  responseBodyWasJson = true
): boolean {
  // During the few seconds where the web container is being replaced, nginx
  // answers before the app can attach its structured update_in_progress JSON.
  // Treat only gateway-shaped, non-JSON responses as the same durable handoff;
  // a structured application error must still surface normally.
  if (
    !responseBodyWasJson &&
    (status === 502 || status === 503 || status === 504)
  ) {
    return true
  }
  if (status !== 503 || !payload || typeof payload !== "object") return false
  const candidate = payload as { code?: unknown; error?: unknown }
  if (candidate.code === "update_in_progress") return true
  return (
    typeof candidate.error === "string" &&
    candidate.error.toLowerCase().includes("update in progress")
  )
}

/** The web container can be healthy a few seconds before the freshly rotated
 * durable worker is ready. This structured 503 is distinct from provider/model
 * errors and is safe to retry briefly with the same stable message ids. */
export function isChatAiWorkerUnavailableResponse(
  status: number,
  payload: unknown,
  responseBodyWasJson = true
): boolean {
  if (!responseBodyWasJson || status !== 503 || !payload || typeof payload !== "object") {
    return false
  }
  return (payload as { code?: unknown }).code === "ai_worker_unavailable"
}

export function chatUpdateRetryDelayMs(
  retryAfter: string | null,
  now = Date.now()
): number {
  const value = retryAfter?.trim()
  if (!value) return CHAT_UPDATE_RETRY_DEFAULT_MS

  const seconds = Number(value)
  const parsedMs = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - now
  if (!Number.isFinite(parsedMs)) return CHAT_UPDATE_RETRY_DEFAULT_MS
  return Math.min(
    CHAT_UPDATE_RETRY_MAX_MS,
    Math.max(CHAT_UPDATE_RETRY_MIN_MS, parsedMs)
  )
}

export function sleepWithAbortSignal(
  ms: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"))
      return
    }
    const abort = () => {
      globalThis.clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(new DOMException("The operation was aborted.", "AbortError"))
    }
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal.addEventListener("abort", abort, { once: true })
  })
}

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
    async: data.async === true,
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
export const STREAM_RECOVERY_MAX_DELAY_MS = 5_000
/** Keep retrying recovery while the server is unreachable (flaky mobile
 *  signal) for up to this long before giving up. Attempts where the server
 *  actually responded are budgeted by STREAM_RECOVERY_ATTEMPTS instead. */
export const STREAM_RECOVERY_UNREACHABLE_DEADLINE_MS = 10 * 60_000
/** While offline, recovery waits for the `online` event in slices of this
 *  size instead of burning backoff attempts. */
export const OFFLINE_WAIT_SLICE_MS = 30_000
/** The chat stream sends `: ping` keepalives every ~10s. A visible reader
 *  that has received no bytes for this long is a dead connection (mobile
 *  radio dropped without RST) — abort it and run stream recovery. */
export const STREAM_STALL_TIMEOUT_MS = 30_000
export const STREAM_STALL_CHECK_INTERVAL_MS = 5_000
/** On tab foreground/online, a hung reader is aborted after a shorter quiet
 *  window — the OS likely killed the connection while backgrounded. */
export const STREAM_RESUME_STALL_MS = 15_000
/** How many times a network-interrupted turn is re-sent (after recovery
 *  confirmed the server never started it). Ids are stable, so re-sending is
 *  idempotent. */
export const CHAT_SEND_RETRY_ATTEMPTS = 2
/** A normal worker rotation is only a few seconds. Bound structured worker
 * unavailability retries so an unrelated long outage still becomes visible. */
export const CHAT_AI_WORKER_RESTART_RETRY_MS = 90_000

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
  // Assistant rows are updated in place throughout a turn. A tail refresh or
  // delayed sync event can therefore arrive out of order: once the terminal
  // row is in memory, an older progress snapshot must never replace it and
  // bring back a half-finished tool trace until reload.
  const existingIsTerminal = isTerminalAssistantMessage(existing)
  const incomingIsTerminal = isTerminalAssistantMessage(incoming)
  if (
    existingIsTerminal &&
    (!incomingIsTerminal || existing.timestamp > incoming.timestamp)
  ) {
    return existing
  }

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

export function isConversationUnread(conversation: Conversation): boolean {
  const unreadActivityAt = getConversationUnreadActivityAt(conversation)
  if (typeof unreadActivityAt !== "number") return false

  return (
    typeof conversation.readAt !== "number" ||
    conversation.readAt < unreadActivityAt
  )
}

/**
 * Decide whether a terminal assistant row should create an unread marker.
 *
 * Chat completion frames can arrive from the durable worker after a read-state
 * frame emitted by the web process. A readAt at or beyond the terminal row is
 * therefore authoritative: the conversation was already opened on this or
 * another device and the late completion frame must not make it unread again.
 */
export function isAssistantCompletionUnread(
  conversation: Conversation | undefined,
  message: Message
): boolean {
  const completionAt = validTimestamp(message.timestamp)
  const readAt = validTimestamp(conversation?.readAt)

  if (completionAt === null || readAt === null) return true
  return readAt < completionAt
}

export function unreadSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

export function deriveUnreadConversationIds(
  conversations: Conversation[]
): Set<string> {
  const ids = new Set<string>()
  for (const conversation of conversations) {
    if (isConversationUnread(conversation)) {
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

/** Sleep up to `maxMs`, resolving immediately when the browser reports the
 *  network came back — so offline waits end the moment the radio recovers. */
export function sleepUntilOnline(maxMs: number): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine) return sleep(maxMs)
  return new Promise((resolve) => {
    let timer = 0
    const done = () => {
      window.clearTimeout(timer)
      window.removeEventListener("online", done)
      resolve()
    }
    timer = window.setTimeout(done, maxMs)
    window.addEventListener("online", done)
  })
}

/**
 * Run a fetch-returning request with retries for transient failures: network
 * errors and 5xx retry with exponential backoff (waiting for `online` first
 * when the device knows it is offline); 2xx/4xx are real answers and return
 * as-is. Returns null when every attempt failed.
 */
export async function postWithRetry(
  request: () => Promise<Response>,
  {
    retries = 4,
    baseDelayMs = 1_000,
    maxDelayMs = 15_000,
  }: { retries?: number; baseDelayMs?: number; maxDelayMs?: number } = {}
): Promise<Response | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await request()
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response
      }
    } catch {
      /* network failure — retry below */
    }
    if (attempt >= retries) return null
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      await sleepUntilOnline(OFFLINE_WAIT_SLICE_MS)
    } else {
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt))
    }
  }
}

export function isTerminalAssistantMessage(message: Message | null | undefined) {
  return Boolean(
    message?.role === "assistant" &&
    (message.status || typeof message.thinkingDuration === "number")
  )
}

/**
 * The direct /api/chat reader owns only its exact assistant row. Global sync
 * must keep applying assistant updates from every other conversation while a
 * local turn streams; treating `ownsStream` as a global gate drops unrelated
 * background completions and leaves their last progress snapshot on screen.
 */
export function isOwnedAssistantStreamMessage(args: {
  ownsStream: boolean
  ownedConversationId: string | null
  ownedMessageId: string | null
  eventConversationId: string
  eventMessageId: string
}): boolean {
  return Boolean(
    args.ownsStream &&
      args.ownedConversationId === args.eventConversationId &&
      args.ownedMessageId === args.eventMessageId
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
