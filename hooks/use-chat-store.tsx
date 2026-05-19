"use client"

import * as React from "react"
import type {
  AgentCallReasoningEntry,
  Attachment,
  ContextCompactionReasoningEntry,
  ContextUsageSnapshot,
  Conversation,
  Message,
  ToolStreamDelta,
} from "@/lib/types"
import { generateId, generateTitle } from "@/lib/utils-chat"

type StreamingReasoning = NonNullable<Message["reasoning"]>

function updateAgentEntry(
  reasoning: StreamingReasoning,
  runId: string,
  updater: (entry: AgentCallReasoningEntry) => AgentCallReasoningEntry
): StreamingReasoning {
  return reasoning.map((entry) => {
    if (entry.type !== "agent_call" || entry.runId !== runId) return entry
    return updater(entry)
  })
}

function appendAgentThought(
  entry: AgentCallReasoningEntry,
  chunk: string
): AgentCallReasoningEntry {
  const reasoning = [...(entry.reasoning ?? [])]
  const phase = entry.contentSegments?.at(-1)?.phase ?? 0
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

function appendAgentContent(
  entry: AgentCallReasoningEntry,
  chunk: string
): AgentCallReasoningEntry {
  const contentSegments = [...(entry.contentSegments ?? [])]
  const last = contentSegments[contentSegments.length - 1]
  if (last) {
    contentSegments[contentSegments.length - 1] = {
      ...last,
      content: last.content + chunk,
    }
  } else {
    contentSegments.push({ phase: 0, content: chunk })
  }
  return { ...entry, content: entry.content + chunk, contentSegments }
}

const stoppedStreamState = {
  isStreaming: false,
  streamingContent: "",
  streamingContentSegments: [] as NonNullable<Message["contentSegments"]>,
  streamingReasoning: [] as StreamingReasoning,
  streamingMode: null as "reasoning" | "content" | null,
  thinkingSeconds: 0,
  thinkingDone: false,
  streamingMessageId: null as string | null,
}

const INITIAL_MESSAGE_PAGE_SIZE = 80
const OLDER_MESSAGE_PAGE_SIZE = 80
const CHAT_UNREAD_IDS_KEY = "chat:unread-ids"

type ConversationLoadState =
  | "summary"
  | "loading"
  | "partial"
  | "full"
  | "error"

interface ConversationMessagePageState {
  total: number
  loadedCount: number
  hasMore: boolean
  nextCursor: string | null
  isLoadingOlder: boolean
  error?: string
}

interface MessagePageResponse {
  messages: Message[]
  total: number
  hasMore: boolean
  nextCursor: string | null
}

function sortMessagesByTimeline(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const timeDelta = a.timestamp - b.timestamp
    return timeDelta !== 0 ? timeDelta : a.id.localeCompare(b.id)
  })
}

function mergeMessagesById(
  existingMessages: Message[],
  incomingMessages: Message[]
): Message[] {
  const byId = new Map<string, Message>()
  for (const message of existingMessages) byId.set(message.id, message)
  for (const message of incomingMessages) byId.set(message.id, message)
  return sortMessagesByTimeline(Array.from(byId.values()))
}

function readUnreadConversationIds(): Set<string> {
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

function writeUnreadConversationIds(ids: Set<string>) {
  if (typeof window === "undefined") return
  localStorage.setItem(CHAT_UNREAD_IDS_KEY, JSON.stringify(Array.from(ids)))
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

class ChatFetchError extends Error {
  chatMessage?: string

  constructor(message: string, chatMessage?: string) {
    super(message)
    this.name = "ChatFetchError"
    this.chatMessage = chatMessage
  }
}

function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function showChatCompletionNotification(
  conversationId: string,
  conversation: Conversation | undefined,
  message: Message
) {
  if (typeof window === "undefined" || !("Notification" in window)) return
  if (Notification.permission !== "granted") return

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

interface ChatState {
  conversations: Conversation[]
  isLoading: boolean
  conversationLoadState: Record<string, ConversationLoadState>
  conversationLoadErrors: Record<string, string | undefined>
  conversationMessagePages: Record<string, ConversationMessagePageState>
  activeConversationId: string | null
  isStreaming: boolean
  streamingContent: string
  streamingContentSegments: NonNullable<Message["contentSegments"]>
  streamingReasoning: StreamingReasoning
  streamingMode: "reasoning" | "content" | null
  thinkingSeconds: number
  thinkingDone: boolean
  /**
   * The id of the assistant message currently being streamed (or null when
   * not streaming). Surfaces so the streaming bubble can hand it to the
   * artifact renderer — drafts and persisted rows in
   * `ConversationArtifactsProvider` are keyed by messageId.
   */
  streamingMessageId: string | null
}

type ChatAction =
  | {
      type: "INIT_CONVERSATIONS"
      conversations: Conversation[]
      full?: boolean
    }
  | { type: "LOAD_CONVERSATION_START"; id: string }
  | { type: "LOAD_CONVERSATION_SUCCESS"; conversation: Conversation }
  | { type: "LOAD_CONVERSATION_ERROR"; id: string; error: string }
  | {
      type: "LOAD_MESSAGE_PAGE_SUCCESS"
      id: string
      messages: Message[]
      total: number
      hasMore: boolean
      nextCursor: string | null
      mode: "replace" | "prepend"
    }
  | { type: "LOAD_OLDER_MESSAGES_START"; id: string }
  | { type: "LOAD_OLDER_MESSAGES_ERROR"; id: string; error: string }
  | { type: "NEW_CHAT" }
  | { type: "SELECT_CONVERSATION"; id: string }
  | { type: "DELETE_CONVERSATION"; id: string }
  | { type: "ADD_USER_MESSAGE"; conversationId: string; message: Message }
  | { type: "CREATE_CONVERSATION"; conversation: Conversation }
  | { type: "SET_STREAMING"; isStreaming: boolean; messageId?: string }
  | { type: "APPEND_STREAMING_THINKING_CHUNK"; chunk: string; phase: number }
  | { type: "APPEND_STREAMING_CONTENT"; chunk: string; phase: number }
  | {
      type: "ADD_STREAMING_TOOL_CALL"
      toolCallId: string
      title: string
      phase: number
      toolName?: string
      args?: Record<string, unknown>
    }
  | {
      type: "APPEND_STREAMING_TOOL_DELTA"
      toolCallId: string
      toolName?: string
      delta: ToolStreamDelta
    }
  | {
      type: "SET_STREAMING_TOOL_RESULT"
      toolCallId: string
      content: string
      success?: boolean
      title?: string
    }
  | { type: "UPSERT_STREAMING_AGENT_CALL"; entry: AgentCallReasoningEntry }
  | { type: "APPEND_STREAMING_AGENT_THINKING"; runId: string; chunk: string }
  | { type: "APPEND_STREAMING_AGENT_CONTENT"; runId: string; chunk: string }
  | {
      type: "ADD_STREAMING_AGENT_TOOL_CALL"
      runId: string
      toolCallId: string
      title: string
      toolName?: string
      args?: Record<string, unknown>
    }
  | {
      type: "APPEND_STREAMING_AGENT_TOOL_DELTA"
      runId: string
      toolCallId: string
      toolName?: string
      delta: ToolStreamDelta
    }
  | {
      type: "SET_STREAMING_AGENT_TOOL_RESULT"
      runId: string
      toolCallId: string
      content: string
      success?: boolean
      title?: string
    }
  | {
      type: "SET_STREAMING_AGENT_DONE"
      runId: string
      status: AgentCallReasoningEntry["status"]
      endedAt: number
      content?: string
      contentSegments?: AgentCallReasoningEntry["contentSegments"]
      reasoning?: AgentCallReasoningEntry["reasoning"]
      attachments?: AgentCallReasoningEntry["attachments"]
      error?: string
      thinkingDuration?: number
    }
  | {
      type: "ADD_STREAMING_CONTEXT_COMPACTION"
      entry: ContextCompactionReasoningEntry
    }
  | {
      type: "UPDATE_CONTEXT_USAGE"
      conversationId: string
      contextUsage: ContextUsageSnapshot
    }
  | { type: "SET_THINKING_DONE"; seconds: number }
  | { type: "SET_THINKING_SECONDS"; seconds: number }
  | {
      type: "ADD_ASSISTANT_MESSAGE"
      conversationId: string
      message: Message
      stopStreaming?: boolean
    }
  | { type: "ADD_SYNCED_CONVERSATION"; conversation: Conversation }

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "INIT_CONVERSATIONS": {
      const dbIds = new Set(action.conversations.map((c) => c.id))
      const locallyCreated = state.conversations.filter((c) => !dbIds.has(c.id))
      const previousById = new Map(
        state.conversations.map((conversation) => [
          conversation.id,
          conversation,
        ])
      )
      const mergedIncoming = action.conversations.map((conversation) => {
        const previous = previousById.get(conversation.id)
        const previousIsFull =
          state.conversationLoadState[conversation.id] === "full"
        if (!action.full && previous && previousIsFull) {
          return {
            ...conversation,
            messages: previous.messages,
            contextUsage: conversation.contextUsage ?? previous.contextUsage,
          }
        }
        return conversation
      })
      const merged = [...locallyCreated, ...mergedIncoming].sort(
        (a, b) => b.createdAt - a.createdAt
      )
      const conversationLoadState = { ...state.conversationLoadState }
      const conversationLoadErrors = { ...state.conversationLoadErrors }
      const conversationMessagePages = { ...state.conversationMessagePages }
      for (const conversation of action.conversations) {
        const previousStatus = conversationLoadState[conversation.id]
        conversationLoadState[conversation.id] =
          action.full || previousStatus === "full"
            ? "full"
            : previousStatus === "partial"
              ? "partial"
              : previousStatus === "loading"
                ? "loading"
                : "summary"
        conversationLoadErrors[conversation.id] = undefined
        conversationMessagePages[conversation.id] ??= {
          total: conversation.messageCount ?? conversation.messages.length,
          loadedCount: conversation.messages.length,
          hasMore:
            (conversation.messageCount ?? conversation.messages.length) >
            conversation.messages.length,
          nextCursor: null,
          isLoadingOlder: false,
        }
      }
      const savedId =
        typeof window !== "undefined"
          ? localStorage.getItem("chat:active-id")
          : null
      const validSavedId = merged.some((c) => c.id === savedId) ? savedId : null
      return {
        ...state,
        conversations: merged,
        conversationLoadState,
        conversationLoadErrors,
        conversationMessagePages,
        activeConversationId: validSavedId,
        isLoading: false,
      }
    }
    case "LOAD_CONVERSATION_START":
      return {
        ...state,
        conversationLoadState: {
          ...state.conversationLoadState,
          [action.id]: "loading",
        },
        conversationLoadErrors: {
          ...state.conversationLoadErrors,
          [action.id]: undefined,
        },
      }
    case "LOAD_CONVERSATION_SUCCESS": {
      const exists = state.conversations.some(
        (conversation) => conversation.id === action.conversation.id
      )
      return {
        ...state,
        conversations: (exists
          ? state.conversations.map((conversation) =>
              conversation.id === action.conversation.id
                ? {
                    ...conversation,
                    ...action.conversation,
                    messageCount: action.conversation.messages.length,
                    lastMessagePreview:
                      action.conversation.messages.at(-1)?.content ??
                      conversation.lastMessagePreview,
                    lastMessageAt:
                      action.conversation.messages.at(-1)?.timestamp ??
                      conversation.lastMessageAt,
                  }
                : conversation
            )
          : [action.conversation, ...state.conversations]
        ).sort(
          (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)
        ),
        conversationLoadState: {
          ...state.conversationLoadState,
          [action.conversation.id]: "full",
        },
        conversationLoadErrors: {
          ...state.conversationLoadErrors,
          [action.conversation.id]: undefined,
        },
        conversationMessagePages: {
          ...state.conversationMessagePages,
          [action.conversation.id]: {
            total: action.conversation.messages.length,
            loadedCount: action.conversation.messages.length,
            hasMore: false,
            nextCursor: null,
            isLoadingOlder: false,
          },
        },
      }
    }
    case "LOAD_MESSAGE_PAGE_SUCCESS": {
      const existingConversation = state.conversations.find(
        (conversation) => conversation.id === action.id
      )
      const mergedMessages = mergeMessagesById(
        existingConversation?.messages ?? [],
        action.messages
      )
      const nextLoadState: ConversationLoadState = action.hasMore
        ? "partial"
        : "full"

      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.id === action.id
            ? {
                ...conversation,
                messages: mergedMessages,
                messageCount: action.total,
                lastMessagePreview:
                  mergedMessages.at(-1)?.content ??
                  conversation.lastMessagePreview,
                lastMessageAt:
                  mergedMessages.at(-1)?.timestamp ??
                  conversation.lastMessageAt,
              }
            : conversation
        ),
        conversationLoadState: {
          ...state.conversationLoadState,
          [action.id]: nextLoadState,
        },
        conversationLoadErrors: {
          ...state.conversationLoadErrors,
          [action.id]: undefined,
        },
        conversationMessagePages: {
          ...state.conversationMessagePages,
          [action.id]: {
            total: action.total,
            loadedCount: mergedMessages.length,
            hasMore: action.hasMore,
            nextCursor: action.nextCursor,
            isLoadingOlder: false,
          },
        },
      }
    }
    case "LOAD_OLDER_MESSAGES_START": {
      const page = state.conversationMessagePages[action.id]
      return {
        ...state,
        conversationMessagePages: {
          ...state.conversationMessagePages,
          [action.id]: {
            total: page?.total ?? 0,
            loadedCount: page?.loadedCount ?? 0,
            hasMore: page?.hasMore ?? true,
            nextCursor: page?.nextCursor ?? null,
            isLoadingOlder: true,
            error: undefined,
          },
        },
      }
    }
    case "LOAD_OLDER_MESSAGES_ERROR": {
      const page = state.conversationMessagePages[action.id]
      return {
        ...state,
        conversationMessagePages: {
          ...state.conversationMessagePages,
          [action.id]: {
            total: page?.total ?? 0,
            loadedCount: page?.loadedCount ?? 0,
            hasMore: page?.hasMore ?? true,
            nextCursor: page?.nextCursor ?? null,
            isLoadingOlder: false,
            error: action.error,
          },
        },
      }
    }
    case "LOAD_CONVERSATION_ERROR":
      return {
        ...state,
        conversationLoadState: {
          ...state.conversationLoadState,
          [action.id]: "error",
        },
        conversationLoadErrors: {
          ...state.conversationLoadErrors,
          [action.id]: action.error,
        },
      }
    case "NEW_CHAT":
      if (typeof window !== "undefined")
        localStorage.removeItem("chat:active-id")
      return { ...state, activeConversationId: null, ...stoppedStreamState }
    case "SELECT_CONVERSATION":
      if (typeof window !== "undefined")
        localStorage.setItem("chat:active-id", action.id)
      return {
        ...state,
        activeConversationId: action.id,
        ...stoppedStreamState,
      }
    case "DELETE_CONVERSATION": {
      const conversations = state.conversations.filter(
        (c) => c.id !== action.id
      )
      const nextActiveId =
        state.activeConversationId === action.id
          ? null
          : state.activeConversationId
      if (typeof window !== "undefined") {
        if (nextActiveId) localStorage.setItem("chat:active-id", nextActiveId)
        else localStorage.removeItem("chat:active-id")
      }
      return {
        ...state,
        conversations,
        conversationLoadState: Object.fromEntries(
          Object.entries(state.conversationLoadState).filter(
            ([id]) => id !== action.id
          )
        ),
        conversationLoadErrors: Object.fromEntries(
          Object.entries(state.conversationLoadErrors).filter(
            ([id]) => id !== action.id
          )
        ),
        conversationMessagePages: Object.fromEntries(
          Object.entries(state.conversationMessagePages).filter(
            ([id]) => id !== action.id
          )
        ),
        activeConversationId: nextActiveId,
        ...(state.activeConversationId === action.id ? stoppedStreamState : {}),
      }
    }
    case "CREATE_CONVERSATION": {
      if (state.conversations.some((c) => c.id === action.conversation.id))
        return state
      if (typeof window !== "undefined")
        localStorage.setItem("chat:active-id", action.conversation.id)
      return {
        ...state,
        conversations: [action.conversation, ...state.conversations],
        conversationLoadState: {
          ...state.conversationLoadState,
          [action.conversation.id]: "full",
        },
        conversationLoadErrors: {
          ...state.conversationLoadErrors,
          [action.conversation.id]: undefined,
        },
        conversationMessagePages: {
          ...state.conversationMessagePages,
          [action.conversation.id]: {
            total: action.conversation.messages.length,
            loadedCount: action.conversation.messages.length,
            hasMore: false,
            nextCursor: null,
            isLoadingOlder: false,
          },
        },
        activeConversationId: action.conversation.id,
      }
    }
    case "ADD_SYNCED_CONVERSATION": {
      if (state.conversations.some((c) => c.id === action.conversation.id))
        return state
      return {
        ...state,
        conversations: [action.conversation, ...state.conversations],
        conversationLoadState: {
          ...state.conversationLoadState,
          [action.conversation.id]: "full",
        },
        conversationLoadErrors: {
          ...state.conversationLoadErrors,
          [action.conversation.id]: undefined,
        },
        conversationMessagePages: {
          ...state.conversationMessagePages,
          [action.conversation.id]: {
            total: action.conversation.messages.length,
            loadedCount: action.conversation.messages.length,
            hasMore: false,
            nextCursor: null,
            isLoadingOlder: false,
          },
        },
      }
    }
    case "ADD_USER_MESSAGE": {
      const existingConversation = state.conversations.find(
        (conversation) => conversation.id === action.conversationId
      )
      const isNewMessage = !existingConversation?.messages.some(
        (message) => message.id === action.message.id
      )
      const page = state.conversationMessagePages[action.conversationId]
      return {
        ...state,
        conversations: state.conversations.map((conv) =>
          conv.id === action.conversationId
            ? {
                ...conv,
                updatedAt: action.message.timestamp,
                messageCount:
                  (conv.messageCount ?? conv.messages.length) +
                  (conv.messages.some((m) => m.id === action.message.id)
                    ? 0
                    : 1),
                lastMessagePreview: action.message.content,
                lastMessageAt: action.message.timestamp,
                messages: conv.messages.some((m) => m.id === action.message.id)
                  ? conv.messages.map((m) =>
                      m.id === action.message.id ? action.message : m
                    )
                  : [...conv.messages, action.message],
              }
            : conv
        ),
        conversationMessagePages:
          page && isNewMessage
            ? {
                ...state.conversationMessagePages,
                [action.conversationId]: {
                  ...page,
                  total: page.total + 1,
                  loadedCount: page.loadedCount + 1,
                },
              }
            : state.conversationMessagePages,
      }
    }
    case "SET_STREAMING":
      return action.isStreaming
        ? {
            ...state,
            ...stoppedStreamState,
            isStreaming: true,
            streamingMessageId:
              action.messageId ?? state.streamingMessageId ?? null,
          }
        : { ...state, ...stoppedStreamState }
    case "APPEND_STREAMING_THINKING_CHUNK": {
      const reasoning = [...state.streamingReasoning]
      const last = reasoning[reasoning.length - 1]
      if (last?.type === "thought" && last.phase === action.phase) {
        reasoning[reasoning.length - 1] = {
          ...last,
          content: last.content + action.chunk,
        }
      } else {
        reasoning.push({
          type: "thought",
          id: `thought_${reasoning.length + 1}`,
          phase: action.phase,
          content: action.chunk,
        })
      }
      return {
        ...state,
        streamingReasoning: reasoning,
        streamingMode: "reasoning",
      }
    }
    case "APPEND_STREAMING_CONTENT": {
      const segments = [...state.streamingContentSegments]
      const last = segments[segments.length - 1]
      if (last && last.phase === action.phase) {
        segments[segments.length - 1] = {
          ...last,
          content: last.content + action.chunk,
        }
      } else {
        segments.push({
          phase: action.phase,
          content: action.chunk,
        })
      }
      return {
        ...state,
        streamingContent: state.streamingContent + action.chunk,
        streamingContentSegments: segments,
        streamingMode: "content",
      }
    }
    case "ADD_STREAMING_TOOL_CALL":
      if (
        state.streamingReasoning.some(
          (entry) =>
            entry.type === "tool_call" && entry.toolCallId === action.toolCallId
        )
      ) {
        return { ...state, streamingMode: "reasoning" }
      }
      return {
        ...state,
        streamingReasoning: [
          ...state.streamingReasoning,
          {
            type: "tool_call",
            id: `tool_${action.toolCallId}`,
            phase: action.phase,
            toolCallId: action.toolCallId,
            title: action.title,
            content: "",
            toolName: action.toolName,
            args: action.args,
            status: "running",
            startedAt: Date.now(),
          },
        ],
        streamingMode: "reasoning",
      }
    case "APPEND_STREAMING_TOOL_DELTA":
      return {
        ...state,
        streamingReasoning: state.streamingReasoning.map((entry) =>
          entry.type === "tool_call" && entry.toolCallId === action.toolCallId
            ? {
                ...entry,
                toolName: entry.toolName ?? action.toolName,
                status: "running",
                deltas: [...(entry.deltas ?? []), action.delta],
              }
            : entry
        ),
        streamingMode: "reasoning",
      }
    case "SET_STREAMING_TOOL_RESULT":
      return {
        ...state,
        streamingReasoning: state.streamingReasoning.map((entry) =>
          entry.type === "tool_call" && entry.toolCallId === action.toolCallId
            ? {
                ...entry,
                content: action.content,
                success: action.success ?? entry.success,
                title: action.title ?? entry.title,
                status:
                  (action.success ?? entry.success) === false ? "error" : "ok",
                endedAt: Date.now(),
              }
            : entry
        ),
        streamingMode: "reasoning",
      }
    case "UPSERT_STREAMING_AGENT_CALL": {
      const exists = state.streamingReasoning.some(
        (entry) =>
          entry.type === "agent_call" && entry.runId === action.entry.runId
      )
      return {
        ...state,
        streamingReasoning: exists
          ? state.streamingReasoning.map((entry) =>
              entry.type === "agent_call" && entry.runId === action.entry.runId
                ? action.entry
                : entry
            )
          : [...state.streamingReasoning, action.entry],
        streamingMode: "reasoning",
      }
    }
    case "APPEND_STREAMING_AGENT_THINKING":
      return {
        ...state,
        streamingReasoning: updateAgentEntry(
          state.streamingReasoning,
          action.runId,
          (entry) => appendAgentThought(entry, action.chunk)
        ),
        streamingMode: "reasoning",
      }
    case "APPEND_STREAMING_AGENT_CONTENT":
      return {
        ...state,
        streamingReasoning: updateAgentEntry(
          state.streamingReasoning,
          action.runId,
          (entry) => appendAgentContent(entry, action.chunk)
        ),
      }
    case "ADD_STREAMING_AGENT_TOOL_CALL":
      return {
        ...state,
        streamingReasoning: updateAgentEntry(
          state.streamingReasoning,
          action.runId,
          (entry) => {
            const existing = entry.reasoning?.some(
              (item) =>
                item.type === "tool_call" &&
                item.toolCallId === action.toolCallId
            )
            if (existing) return entry
            return {
              ...entry,
              reasoning: [
                ...(entry.reasoning ?? []),
                {
                  type: "tool_call",
                  id: `tool_${action.toolCallId}`,
                  phase: entry.contentSegments?.at(-1)?.phase ?? 0,
                  toolCallId: action.toolCallId,
                  title: action.title,
                  content: "",
                  toolName: action.toolName,
                  args: action.args,
                  status: "running",
                  startedAt: Date.now(),
                },
              ],
            }
          }
        ),
      }
    case "APPEND_STREAMING_AGENT_TOOL_DELTA":
      return {
        ...state,
        streamingReasoning: updateAgentEntry(
          state.streamingReasoning,
          action.runId,
          (entry) => ({
            ...entry,
            reasoning: (entry.reasoning ?? []).map((item) =>
              item.type === "tool_call" && item.toolCallId === action.toolCallId
                ? {
                    ...item,
                    toolName: item.toolName ?? action.toolName,
                    status: "running",
                    deltas: [...(item.deltas ?? []), action.delta],
                  }
                : item
            ),
          })
        ),
      }
    case "SET_STREAMING_AGENT_TOOL_RESULT":
      return {
        ...state,
        streamingReasoning: updateAgentEntry(
          state.streamingReasoning,
          action.runId,
          (entry) => ({
            ...entry,
            reasoning: (entry.reasoning ?? []).map((item) =>
              item.type === "tool_call" && item.toolCallId === action.toolCallId
                ? {
                    ...item,
                    content: action.content,
                    success: action.success ?? item.success,
                    title: action.title ?? item.title,
                    status:
                      (action.success ?? item.success) === false
                        ? "error"
                        : "ok",
                    endedAt: Date.now(),
                  }
                : item
            ),
          })
        ),
      }
    case "SET_STREAMING_AGENT_DONE":
      return {
        ...state,
        streamingReasoning: updateAgentEntry(
          state.streamingReasoning,
          action.runId,
          (entry) => ({
            ...entry,
            status: action.status,
            endedAt: action.endedAt,
            content: action.content ?? entry.content,
            contentSegments: action.contentSegments ?? entry.contentSegments,
            reasoning: action.reasoning ?? entry.reasoning,
            attachments: action.attachments ?? entry.attachments,
            error: action.error ?? entry.error,
            thinkingDuration: action.thinkingDuration ?? entry.thinkingDuration,
          })
        ),
      }
    case "ADD_STREAMING_CONTEXT_COMPACTION":
      if (
        state.streamingReasoning.some(
          (entry) =>
            entry.type === "context_compaction" && entry.id === action.entry.id
        )
      ) {
        return { ...state, streamingMode: "reasoning" }
      }
      return {
        ...state,
        streamingReasoning: [...state.streamingReasoning, action.entry],
        streamingMode: "reasoning",
      }
    case "UPDATE_CONTEXT_USAGE":
      return {
        ...state,
        conversations: state.conversations.map((conv) =>
          conv.id === action.conversationId
            ? { ...conv, contextUsage: action.contextUsage }
            : conv
        ),
      }
    case "SET_THINKING_DONE":
      return {
        ...state,
        thinkingDone: true,
        thinkingSeconds: action.seconds,
      }
    case "SET_THINKING_SECONDS":
      return {
        ...state,
        thinkingSeconds: action.seconds,
      }
    case "ADD_ASSISTANT_MESSAGE": {
      const existingConversation = state.conversations.find(
        (conversation) => conversation.id === action.conversationId
      )
      const isNewMessage = !existingConversation?.messages.some(
        (message) => message.id === action.message.id
      )
      const page = state.conversationMessagePages[action.conversationId]
      const nextState = {
        ...state,
        conversations: state.conversations.map((conv) =>
          conv.id === action.conversationId
            ? {
                ...conv,
                updatedAt: action.message.timestamp,
                messageCount:
                  (conv.messageCount ?? conv.messages.length) +
                  (conv.messages.some((m) => m.id === action.message.id)
                    ? 0
                    : 1),
                lastMessagePreview: action.message.content,
                lastMessageAt: action.message.timestamp,
                messages: conv.messages.some((m) => m.id === action.message.id)
                  ? conv.messages.map((m) =>
                      m.id === action.message.id ? action.message : m
                    )
                  : [...conv.messages, action.message],
              }
            : conv
        ),
        conversationMessagePages:
          page && isNewMessage
            ? {
                ...state.conversationMessagePages,
                [action.conversationId]: {
                  ...page,
                  total: page.total + 1,
                  loadedCount: page.loadedCount + 1,
                },
              }
            : state.conversationMessagePages,
      }
      if (action.stopStreaming === false) return nextState
      return {
        ...nextState,
        ...stoppedStreamState,
      }
    }
    default:
      return state
  }
}

interface ChatContextType {
  state: ChatState
  unreadConversationIds: Set<string>
  newChat: () => void
  selectConversation: (id: string) => void
  loadOlderMessages: (id: string) => Promise<void>
  deleteConversation: (id: string) => void
  sendMessage: (
    content: string,
    files?: File[],
    uploadedAttachments?: import("@/lib/types").Attachment[]
  ) => void
  stopStreaming: () => void
}

const ChatContext = React.createContext<ChatContextType | null>(null)

export function ChatStoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = React.useReducer(chatReducer, {
    conversations: [],
    isLoading: true,
    conversationLoadState: {},
    conversationLoadErrors: {},
    conversationMessagePages: {},
    activeConversationId: null,
    ...stoppedStreamState,
  })
  const [unreadConversationIds, setUnreadConversationIds] = React.useState<
    Set<string>
  >(() => readUnreadConversationIds())

  const abortControllerRef = React.useRef<AbortController | null>(null)
  const thinkingTimerRef = React.useRef<number | null>(null)
  const streamingRef = React.useRef(false)
  const streamDoneRef = React.useRef(false)
  const activeConversationIdRef = React.useRef<string | null>(null)
  const conversationsRef = React.useRef<Conversation[]>([])

  React.useEffect(() => {
    activeConversationIdRef.current = state.activeConversationId
  }, [state.activeConversationId])

  React.useEffect(() => {
    conversationsRef.current = state.conversations
  }, [state.conversations])

  const updateUnreadConversationIds = React.useCallback(
    (updater: (current: Set<string>) => Set<string>) => {
      setUnreadConversationIds((current) => {
        const next = updater(new Set(current))
        writeUnreadConversationIds(next)
        return next
      })
    },
    []
  )

  const markConversationRead = React.useCallback(
    (id: string) => {
      updateUnreadConversationIds((current) => {
        current.delete(id)
        return current
      })
    },
    [updateUnreadConversationIds]
  )

  const markConversationUnread = React.useCallback(
    (id: string) => {
      updateUnreadConversationIds((current) => {
        current.add(id)
        return current
      })
    },
    [updateUnreadConversationIds]
  )

  const handleAssistantFinished = React.useCallback(
    (conversationId: string, message: Message) => {
      if (message.status === "aborted") return
      const isVisibleActive =
        document.visibilityState === "visible" &&
        activeConversationIdRef.current === conversationId

      if (isVisibleActive) {
        markConversationRead(conversationId)
        return
      }

      markConversationUnread(conversationId)
      const conversation = conversationsRef.current.find(
        (c) => c.id === conversationId
      )
      void showChatCompletionNotification(conversationId, conversation, message)
    },
    [markConversationRead, markConversationUnread]
  )

  React.useEffect(() => {
    if (!state.activeConversationId || document.visibilityState !== "visible")
      return
    markConversationRead(state.activeConversationId)
  }, [markConversationRead, state.activeConversationId])

  React.useEffect(() => {
    const onVisibilityChange = () => {
      if (
        document.visibilityState === "visible" &&
        activeConversationIdRef.current
      ) {
        markConversationRead(activeConversationIdRef.current)
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange)
  }, [markConversationRead])

  const cleanupStream = React.useCallback(() => {
    streamingRef.current = false
    if (thinkingTimerRef.current !== null) {
      window.clearInterval(thinkingTimerRef.current)
      thinkingTimerRef.current = null
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  const stopStreaming = React.useCallback(() => {
    const conversationId = activeConversationIdRef.current
    cleanupStream()
    dispatch({ type: "SET_STREAMING", isStreaming: false })
    if (conversationId) {
      fetch("/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      }).catch((err) => {
        console.error(err)
      })
    }
  }, [cleanupStream])

  React.useEffect(() => cleanupStream, [cleanupStream])

  // --- Fetch conversations on mount ---
  // Retries on transient network failures — the most common one is the Next
  // dev server briefly unavailable during HMR. Without the retry, every
  // file save would surface a "Failed to fetch" error in the dev console
  // even though the conversations would load fine on the next attempt.
  React.useEffect(() => {
    let cancelled = false
    let attempt = 0
    const MAX_ATTEMPTS = 5

    async function load() {
      while (!cancelled && attempt < MAX_ATTEMPTS) {
        attempt += 1
        try {
          const res = await fetch("/api/conversations?summary=1")
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json()
          if (cancelled) return
          if (Array.isArray(data)) {
            dispatch({
              type: "INIT_CONVERSATIONS",
              conversations: data,
              full: false,
            })
          }
          return
        } catch (err) {
          if (cancelled) return
          if (attempt >= MAX_ATTEMPTS) {
            // Last attempt — log quietly so the dev overlay isn't
            // shouting about a recoverable HMR-induced flap.
            console.warn("Failed to load conversations after retries", err)
            dispatch({ type: "INIT_CONVERSATIONS", conversations: [] })
            return
          }
          // Exponential-ish backoff: 150ms, 300ms, 600ms, 1200ms.
          const delay = 150 * 2 ** (attempt - 1)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    const conversationId = state.activeConversationId
    if (!conversationId) return
    const stableConversationId = conversationId
    const status = state.conversationLoadState[conversationId]
    if (
      status === "partial" ||
      status === "full" ||
      status === "loading" ||
      status === "error"
    )
      return

    const controller = new AbortController()
    dispatch({ type: "LOAD_CONVERSATION_START", id: stableConversationId })

    async function loadConversation() {
      try {
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(stableConversationId)}/messages?limit=${INITIAL_MESSAGE_PAGE_SIZE}`,
          { cache: "no-store", signal: controller.signal }
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const page = (await res.json()) as MessagePageResponse
        if (controller.signal.aborted) return
        dispatch({
          type: "LOAD_MESSAGE_PAGE_SUCCESS",
          id: stableConversationId,
          messages: page.messages,
          total: page.total,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          mode: "replace",
        })
      } catch (err) {
        if (
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === "AbortError")
        ) {
          return
        }
        dispatch({
          type: "LOAD_CONVERSATION_ERROR",
          id: stableConversationId,
          error: err instanceof Error ? err.message : "Failed to load chat",
        })
      }
    }

    void loadConversation()
    return () => controller.abort()
    // Run only when the selected conversation changes. Including the load-state
    // object here makes this effect abort its own request after dispatching
    // LOAD_CONVERSATION_START in React StrictMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeConversationId])

  const checkServerStreaming = React.useCallback(
    async (conversationId: string): Promise<boolean> => {
      try {
        const res = await fetch(
          `/api/chat/active?conversationId=${encodeURIComponent(conversationId)}`,
          {
            cache: "no-store",
          }
        )
        if (!res.ok) return false
        const data = await res.json()
        return !!data.active
      } catch {
        return false
      }
    },
    []
  )

  React.useEffect(() => {
    const conversationId = state.activeConversationId
    if (!conversationId || streamingRef.current) return

    let cancelled = false

    checkServerStreaming(conversationId).then((active) => {
      if (
        cancelled ||
        activeConversationIdRef.current !== conversationId ||
        streamingRef.current
      )
        return
      dispatch({ type: "SET_STREAMING", isStreaming: active })
    })

    return () => {
      cancelled = true
    }
  }, [checkServerStreaming, state.activeConversationId])

  React.useEffect(() => {
    const conversationId = state.activeConversationId
    if (!conversationId || !state.isStreaming || streamingRef.current) return

    let cancelled = false
    const tick = () => {
      checkServerStreaming(conversationId).then((active) => {
        if (
          cancelled ||
          activeConversationIdRef.current !== conversationId ||
          streamingRef.current
        )
          return
        if (!active) dispatch({ type: "SET_STREAMING", isStreaming: false })
      })
    }

    const interval = window.setInterval(tick, 1000)
    tick()
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [checkServerStreaming, state.activeConversationId, state.isStreaming])

  // --- SSE LIVE SYNC ---
  React.useEffect(() => {
    const eventSource = new EventSource("/api/sync")

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === "create_conversation") {
          dispatch({
            type: "ADD_SYNCED_CONVERSATION",
            conversation: {
              id: data.payload.id,
              title: data.payload.title,
              createdAt: data.payload.createdAt,
              messages: data.payload.messages || [],
            },
          })
        } else if (data.type === "add_message") {
          const msg = data.payload.message
          if (msg.role === "user") {
            dispatch({
              type: "ADD_USER_MESSAGE",
              conversationId: data.payload.conversationId,
              message: msg,
            })
          } else if (msg.role === "assistant") {
            // Only add if we're NOT the tab that's streaming it
            if (!streamingRef.current) {
              const isFinalChunk =
                typeof msg.thinkingDuration === "number" ||
                msg.status === "ok" ||
                msg.status === "error" ||
                msg.status === "aborted"
              dispatch({
                type: "ADD_ASSISTANT_MESSAGE",
                conversationId: data.payload.conversationId,
                message: msg,
                stopStreaming: isFinalChunk,
              })
              if (isFinalChunk) {
                handleAssistantFinished(data.payload.conversationId, msg)
              }
              if (
                !isFinalChunk &&
                data.payload.conversationId === activeConversationIdRef.current
              ) {
                dispatch({ type: "SET_STREAMING", isStreaming: true })
              }
            }
          }
        } else if (data.type === "context_usage") {
          if (data.payload?.conversationId && data.payload?.contextUsage) {
            dispatch({
              type: "UPDATE_CONTEXT_USAGE",
              conversationId: data.payload.conversationId,
              contextUsage: data.payload.contextUsage,
            })
          }
        } else if (data.type === "delete_conversation") {
          dispatch({ type: "DELETE_CONVERSATION", id: data.payload.id })
        }
      } catch (err) {
        console.error("Failed to parse SSE event", err)
      }
    }

    eventSource.onerror = () => {
      // EventSource emits "error" for transient disconnects and auto-retries.
      // Logging it as console.error trips the Next.js dev overlay with no useful detail.
    }

    return () => eventSource.close()
  }, [handleAssistantFinished])

  const newChat = React.useCallback(() => {
    stopStreaming()
    dispatch({ type: "NEW_CHAT" })
    if (typeof window !== "undefined") {
      setTimeout(
        () => window.dispatchEvent(new CustomEvent("chat-input-focus")),
        0
      )
    }
  }, [stopStreaming])

  const selectConversation = React.useCallback(
    (id: string) => {
      stopStreaming()
      markConversationRead(id)
      dispatch({ type: "SELECT_CONVERSATION", id })
    },
    [markConversationRead, stopStreaming]
  )

  const loadOlderMessages = React.useCallback(
    async (id: string) => {
      const page = state.conversationMessagePages[id]
      if (!page?.hasMore || page.isLoadingOlder || !page.nextCursor) return

      dispatch({ type: "LOAD_OLDER_MESSAGES_START", id })
      try {
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(id)}/messages?limit=${OLDER_MESSAGE_PAGE_SIZE}&before=${encodeURIComponent(page.nextCursor)}`,
          { cache: "no-store" }
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const nextPage = (await res.json()) as MessagePageResponse
        dispatch({
          type: "LOAD_MESSAGE_PAGE_SUCCESS",
          id,
          messages: nextPage.messages,
          total: nextPage.total,
          hasMore: nextPage.hasMore,
          nextCursor: nextPage.nextCursor,
          mode: "prepend",
        })
      } catch (err) {
        dispatch({
          type: "LOAD_OLDER_MESSAGES_ERROR",
          id,
          error: err instanceof Error ? err.message : "Failed to load history",
        })
      }
    },
    [state.conversationMessagePages]
  )

  const deleteConversation = React.useCallback(
    (id: string) => {
      stopStreaming()
      fetch(`/api/conversations/${id}`, { method: "DELETE" }).catch(
        console.error
      )
      markConversationRead(id)
      dispatch({ type: "DELETE_CONVERSATION", id })
    },
    [markConversationRead, stopStreaming]
  )

  const sendMessage = React.useCallback(
    async (
      content: string,
      files?: File[],
      uploadedAttachments?: import("@/lib/types").Attachment[]
    ) => {
      if (streamingRef.current) return

      // Use pre-uploaded attachments or upload new files
      let attachments: import("@/lib/types").Attachment[] | undefined =
        uploadedAttachments
      if (!attachments && files?.length) {
        try {
          const formData = new FormData()
          for (const f of files) formData.append("files", f)
          const uploadRes = await fetch("/api/upload", {
            method: "POST",
            body: formData,
          })
          if (uploadRes.ok) {
            const data = await uploadRes.json()
            attachments = data.attachments
          }
        } catch (e) {
          console.error("File upload failed:", e)
        }
      }

      const finalAttachments = attachments?.length ? attachments : undefined
      if (!content.trim() && !finalAttachments?.length) return

      const userMessage: Message = {
        id: generateId(),
        role: "user",
        content,
        attachments: finalAttachments,
        timestamp: Date.now(),
      }

      let conversationId = state.activeConversationId
      let allMessages: Message[]

      if (!conversationId) {
        conversationId = generateId()
        const newConv: Conversation = {
          id: conversationId,
          title: generateTitle(content, finalAttachments),
          messages: [userMessage],
          createdAt: Date.now(),
        }
        fetch("/api/conversations", {
          method: "POST",
          body: JSON.stringify(newConv),
        }).catch(console.error)

        dispatch({ type: "CREATE_CONVERSATION", conversation: newConv })
        allMessages = [userMessage]
      } else {
        fetch(`/api/conversations/${conversationId}/messages`, {
          method: "POST",
          body: JSON.stringify(userMessage),
        }).catch(console.error)

        dispatch({
          type: "ADD_USER_MESSAGE",
          conversationId,
          message: userMessage,
        })

        // Build messages array from current state + new user message
        const conv = state.conversations.find((c) => c.id === conversationId)
        allMessages = [...(conv?.messages ?? []), userMessage]
      }

      // Start streaming
      const assistantMsgId = generateId()
      const abortController = new AbortController()
      abortControllerRef.current = abortController
      streamingRef.current = true
      streamDoneRef.current = false

      dispatch({
        type: "SET_STREAMING",
        isStreaming: true,
        messageId: assistantMsgId,
      })

      // Start thinking timer (live seconds counter)
      const thinkingStart = Date.now()
      thinkingTimerRef.current = window.setInterval(() => {
        const elapsed = Math.round((Date.now() - thinkingStart) / 1000)
        dispatch({ type: "SET_THINKING_SECONDS", seconds: elapsed })
      }, 1000)

      const finalConvId = conversationId

      // Call the streaming API — pass messages directly to avoid DB race condition
      fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: finalConvId,
          messageId: assistantMsgId,
          messages: allMessages,
        }),
        signal: abortController.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            const err = await response
              .json()
              .catch(() => ({ error: "Unknown error" }))
            throw new ChatFetchError(
              err.error || `HTTP ${response.status}`,
              typeof err.chatMessage === "string" ? err.chatMessage : undefined
            )
          }

          const reader = response.body?.getReader()
          if (!reader) throw new Error("No response body")

          const decoder = new TextDecoder()
          let buffer = ""
          let accThinking = ""
          let accContent = ""
          const accContentSegments: NonNullable<Message["contentSegments"]> = []
          let finalThinkingDuration = 0
          const accReasoning: StreamingReasoning = []
          let accAttachments: Attachment[] = []
          let reasoningPhase = 0
          let streamMode: "reasoning" | "content" = "reasoning"

          const appendReasoningThoughtChunk = (chunk: string) => {
            const last = accReasoning[accReasoning.length - 1]
            if (last?.type === "thought" && last.phase === reasoningPhase) {
              last.content += chunk
              return
            }
            accReasoning.push({
              type: "thought",
              id: `thought_${accReasoning.length + 1}`,
              phase: reasoningPhase,
              content: chunk,
            })
          }

          const appendContentChunk = (chunk: string) => {
            const last = accContentSegments[accContentSegments.length - 1]
            if (last && last.phase === reasoningPhase) {
              last.content += chunk
              return
            }
            accContentSegments.push({
              phase: reasoningPhase,
              content: chunk,
            })
          }

          const findAgent = (runId: string) =>
            accReasoning.find(
              (entry) => entry.type === "agent_call" && entry.runId === runId
            )
          const appendLocalAgentThinking = (runId: string, chunk: string) => {
            const entry = findAgent(runId)
            if (!entry || entry.type !== "agent_call") return
            entry.reasoning = appendAgentThought(entry, chunk).reasoning
          }
          const appendLocalAgentContent = (runId: string, chunk: string) => {
            const entry = findAgent(runId)
            if (!entry || entry.type !== "agent_call") return
            const updated = appendAgentContent(entry, chunk)
            entry.content = updated.content
            entry.contentSegments = updated.contentSegments
          }

          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })

            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue
              const jsonStr = line.slice(6)
              if (!jsonStr) continue

              try {
                const data = JSON.parse(jsonStr)

                if (data.type === "thinking") {
                  if (streamMode === "content") {
                    reasoningPhase += 1
                    streamMode = "reasoning"
                  }
                  const thinkingChunk = String(data.content ?? "")
                  accThinking += thinkingChunk
                  appendReasoningThoughtChunk(thinkingChunk)
                  dispatch({
                    type: "APPEND_STREAMING_THINKING_CHUNK",
                    chunk: data.content,
                    phase: reasoningPhase,
                  })
                } else if (data.type === "thinking_done") {
                  if (thinkingTimerRef.current !== null) {
                    window.clearInterval(thinkingTimerRef.current)
                    thinkingTimerRef.current = null
                  }
                  finalThinkingDuration = data.seconds
                  dispatch({ type: "SET_THINKING_DONE", seconds: data.seconds })
                } else if (data.type === "content") {
                  accContent += data.content
                  appendContentChunk(String(data.content ?? ""))
                  if (String(data.content ?? "").length > 0)
                    streamMode = "content"
                  dispatch({
                    type: "APPEND_STREAMING_CONTENT",
                    chunk: data.content,
                    phase: reasoningPhase,
                  })
                } else if (data.type === "tool_call") {
                  const toolCallId = data.toolCall?.id
                  const toolName =
                    typeof data.toolCall?.name === "string"
                      ? data.toolCall.name
                      : undefined
                  const args =
                    data.toolCall?.arguments &&
                    typeof data.toolCall.arguments === "object"
                      ? (data.toolCall.arguments as Record<string, unknown>)
                      : undefined
                  const title =
                    typeof data.toolCall?.title === "string"
                      ? data.toolCall.title
                      : (toolName ?? "")
                  if (typeof toolCallId === "string" && title) {
                    if (streamMode === "content") {
                      reasoningPhase += 1
                      streamMode = "reasoning"
                    }
                    if (
                      !accReasoning.some(
                        (entry) =>
                          entry.type === "tool_call" &&
                          entry.toolCallId === toolCallId
                      )
                    ) {
                      accReasoning.push({
                        type: "tool_call",
                        id: `tool_${toolCallId}`,
                        phase: reasoningPhase,
                        toolCallId,
                        title,
                        content: "",
                        toolName,
                        args,
                        status: "running",
                        startedAt: Date.now(),
                      })
                    }
                    dispatch({
                      type: "ADD_STREAMING_TOOL_CALL",
                      toolCallId,
                      title,
                      phase: reasoningPhase,
                      toolName,
                      args,
                    })
                  }
                } else if (data.type === "tool_delta") {
                  const toolCallId =
                    typeof data.toolCallId === "string" ? data.toolCallId : ""
                  const toolName =
                    typeof data.toolName === "string"
                      ? data.toolName
                      : undefined
                  const delta =
                    data.delta && typeof data.delta === "object"
                      ? (data.delta as ToolStreamDelta)
                      : null
                  if (toolCallId && delta && typeof delta.text === "string") {
                    const entry = accReasoning.find(
                      (item) =>
                        item.type === "tool_call" &&
                        item.toolCallId === toolCallId
                    )
                    if (entry?.type === "tool_call") {
                      entry.deltas = [...(entry.deltas ?? []), delta]
                      entry.status = "running"
                    }
                    dispatch({
                      type: "APPEND_STREAMING_TOOL_DELTA",
                      toolCallId,
                      toolName,
                      delta,
                    })
                  }
                } else if (data.type === "tool_result") {
                  const toolCallId =
                    typeof data.toolCallId === "string" ? data.toolCallId : null
                  const toolContent = String(data.result?.content ?? "")
                  const success =
                    typeof data.result?.success === "boolean"
                      ? data.result.success
                      : undefined
                  const resultTitle =
                    typeof data.result?.text === "string"
                      ? data.result.text
                      : undefined
                  if (toolCallId) {
                    const existing = accReasoning.find(
                      (entry) =>
                        entry.type === "tool_call" &&
                        entry.toolCallId === toolCallId
                    )
                    if (existing && existing.type === "tool_call") {
                      existing.content = toolContent
                      if (success !== undefined) existing.success = success
                      if (resultTitle) existing.title = resultTitle
                      existing.status = success === false ? "error" : "ok"
                      existing.endedAt = Date.now()
                    } else {
                      const toolName =
                        typeof data.toolName === "string"
                          ? data.toolName
                          : undefined
                      const fallbackTitle = resultTitle ?? toolName ?? "tool"
                      accReasoning.push({
                        type: "tool_call",
                        id: `tool_${toolCallId}`,
                        phase: reasoningPhase,
                        toolCallId,
                        title: fallbackTitle,
                        content: toolContent,
                        toolName,
                        success,
                        status: success === false ? "error" : "ok",
                        endedAt: Date.now(),
                      })
                      dispatch({
                        type: "ADD_STREAMING_TOOL_CALL",
                        toolCallId,
                        title: fallbackTitle,
                        phase: reasoningPhase,
                        toolName,
                      })
                    }
                    dispatch({
                      type: "SET_STREAMING_TOOL_RESULT",
                      toolCallId,
                      content: toolContent,
                      success,
                      title: resultTitle,
                    })
                  }
                } else if (data.type === "agent_start") {
                  const runId = typeof data.runId === "string" ? data.runId : ""
                  const agentId =
                    typeof data.agentId === "string" ? data.agentId : ""
                  const agentName =
                    typeof data.agentName === "string"
                      ? data.agentName
                      : agentId || "Agent"
                  const kind =
                    typeof data.kind === "string" ? data.kind : "text"
                  const promptText =
                    typeof data.prompt === "string" ? data.prompt : ""
                  if (runId && agentId) {
                    if (streamMode === "content") {
                      reasoningPhase += 1
                      streamMode = "reasoning"
                    }
                    const entry: AgentCallReasoningEntry = {
                      type: "agent_call",
                      id: `agent_${runId}`,
                      phase: reasoningPhase,
                      toolCallId:
                        typeof data.toolCallId === "string"
                          ? data.toolCallId
                          : undefined,
                      runId,
                      agentThreadId:
                        typeof data.agentThreadId === "string"
                          ? data.agentThreadId
                          : undefined,
                      parentRunId:
                        typeof data.parentRunId === "string"
                          ? data.parentRunId
                          : undefined,
                      agentId,
                      agentName,
                      kind: kind as AgentCallReasoningEntry["kind"],
                      title: agentName,
                      prompt: promptText,
                      status: "running",
                      startedAt:
                        typeof data.startedAt === "number"
                          ? data.startedAt
                          : Date.now(),
                      content: "",
                      contentSegments: [],
                      reasoning: [],
                    }
                    const existing = accReasoning.findIndex(
                      (item) =>
                        item.type === "agent_call" && item.runId === runId
                    )
                    if (existing >= 0) accReasoning[existing] = entry
                    else accReasoning.push(entry)
                    dispatch({ type: "UPSERT_STREAMING_AGENT_CALL", entry })
                  }
                } else if (data.type === "agent_thinking") {
                  const runId = typeof data.runId === "string" ? data.runId : ""
                  const chunk = String(data.content ?? "")
                  if (runId && chunk) {
                    appendLocalAgentThinking(runId, chunk)
                    dispatch({
                      type: "APPEND_STREAMING_AGENT_THINKING",
                      runId,
                      chunk,
                    })
                  }
                } else if (data.type === "agent_content") {
                  const runId = typeof data.runId === "string" ? data.runId : ""
                  const chunk = String(data.content ?? "")
                  if (runId && chunk) {
                    appendLocalAgentContent(runId, chunk)
                    dispatch({
                      type: "APPEND_STREAMING_AGENT_CONTENT",
                      runId,
                      chunk,
                    })
                  }
                } else if (data.type === "agent_tool_call") {
                  const runId = typeof data.runId === "string" ? data.runId : ""
                  const toolCallId =
                    typeof data.toolCall?.id === "string"
                      ? data.toolCall.id
                      : ""
                  const toolName =
                    typeof data.toolCall?.name === "string"
                      ? data.toolCall.name
                      : undefined
                  const args =
                    data.toolCall?.arguments &&
                    typeof data.toolCall.arguments === "object"
                      ? (data.toolCall.arguments as Record<string, unknown>)
                      : undefined
                  const title =
                    typeof data.toolCall?.title === "string"
                      ? data.toolCall.title
                      : (toolName ?? "tool")
                  if (runId && toolCallId) {
                    const agent = findAgent(runId)
                    if (agent?.type === "agent_call") {
                      const exists = agent.reasoning?.some(
                        (item) =>
                          item.type === "tool_call" &&
                          item.toolCallId === toolCallId
                      )
                      if (!exists) {
                        agent.reasoning = [
                          ...(agent.reasoning ?? []),
                          {
                            type: "tool_call",
                            id: `tool_${toolCallId}`,
                            phase: agent.contentSegments?.at(-1)?.phase ?? 0,
                            toolCallId,
                            title,
                            content: "",
                            toolName,
                            args,
                            status: "running",
                            startedAt: Date.now(),
                          },
                        ]
                      }
                    }
                    dispatch({
                      type: "ADD_STREAMING_AGENT_TOOL_CALL",
                      runId,
                      toolCallId,
                      title,
                      toolName,
                      args,
                    })
                  }
                } else if (data.type === "agent_tool_delta") {
                  const runId = typeof data.runId === "string" ? data.runId : ""
                  const toolCallId =
                    typeof data.toolCallId === "string" ? data.toolCallId : ""
                  const toolName =
                    typeof data.toolName === "string"
                      ? data.toolName
                      : undefined
                  const delta =
                    data.delta && typeof data.delta === "object"
                      ? (data.delta as ToolStreamDelta)
                      : null
                  if (
                    runId &&
                    toolCallId &&
                    delta &&
                    typeof delta.text === "string"
                  ) {
                    const agent = findAgent(runId)
                    const toolEntry =
                      agent?.type === "agent_call"
                        ? agent.reasoning?.find(
                            (item) =>
                              item.type === "tool_call" &&
                              item.toolCallId === toolCallId
                          )
                        : undefined
                    if (toolEntry?.type === "tool_call") {
                      toolEntry.deltas = [...(toolEntry.deltas ?? []), delta]
                      toolEntry.status = "running"
                    }
                    dispatch({
                      type: "APPEND_STREAMING_AGENT_TOOL_DELTA",
                      runId,
                      toolCallId,
                      toolName,
                      delta,
                    })
                  }
                } else if (data.type === "agent_tool_result") {
                  const runId = typeof data.runId === "string" ? data.runId : ""
                  const toolCallId =
                    typeof data.toolCallId === "string" ? data.toolCallId : ""
                  const success =
                    typeof data.result?.success === "boolean"
                      ? data.result.success
                      : undefined
                  const contentText = data.result?.success
                    ? typeof data.result?.data === "object"
                      ? JSON.stringify(data.result.data, null, 2)
                      : String(data.result?.data ?? "")
                    : `Error: ${data.result?.error}`
                  if (runId && toolCallId) {
                    const agent = findAgent(runId)
                    const toolEntry =
                      agent?.type === "agent_call"
                        ? agent.reasoning?.find(
                            (item) =>
                              item.type === "tool_call" &&
                              item.toolCallId === toolCallId
                          )
                        : undefined
                    if (toolEntry?.type === "tool_call") {
                      toolEntry.content = contentText
                      if (success !== undefined) toolEntry.success = success
                      toolEntry.status = success === false ? "error" : "ok"
                      toolEntry.endedAt = Date.now()
                    }
                    dispatch({
                      type: "SET_STREAMING_AGENT_TOOL_RESULT",
                      runId,
                      toolCallId,
                      content: contentText,
                      success,
                    })
                  }
                } else if (data.type === "agent_done") {
                  const runId = typeof data.runId === "string" ? data.runId : ""
                  if (runId) {
                    const agent = findAgent(runId)
                    if (agent?.type === "agent_call") {
                      agent.status = data.status ?? agent.status
                      agent.endedAt =
                        typeof data.endedAt === "number"
                          ? data.endedAt
                          : Date.now()
                      if (typeof data.content === "string")
                        agent.content = data.content
                      if (Array.isArray(data.contentSegments))
                        agent.contentSegments = data.contentSegments
                      if (Array.isArray(data.reasoning))
                        agent.reasoning = data.reasoning
                      if (Array.isArray(data.attachments))
                        agent.attachments = data.attachments
                      if (typeof data.error === "string")
                        agent.error = data.error
                      if (typeof data.thinkingDuration === "number")
                        agent.thinkingDuration = data.thinkingDuration
                    }
                    dispatch({
                      type: "SET_STREAMING_AGENT_DONE",
                      runId,
                      status: (data.status ??
                        "ok") as AgentCallReasoningEntry["status"],
                      endedAt:
                        typeof data.endedAt === "number"
                          ? data.endedAt
                          : Date.now(),
                      content:
                        typeof data.content === "string"
                          ? data.content
                          : undefined,
                      contentSegments: Array.isArray(data.contentSegments)
                        ? data.contentSegments
                        : undefined,
                      reasoning: Array.isArray(data.reasoning)
                        ? data.reasoning
                        : undefined,
                      attachments: Array.isArray(data.attachments)
                        ? data.attachments
                        : undefined,
                      error:
                        typeof data.error === "string" ? data.error : undefined,
                      thinkingDuration:
                        typeof data.thinkingDuration === "number"
                          ? data.thinkingDuration
                          : undefined,
                    })
                  }
                } else if (data.type === "context_compaction") {
                  const entry =
                    data.entry && typeof data.entry === "object"
                      ? (data.entry as ContextCompactionReasoningEntry)
                      : null
                  if (
                    entry?.type === "context_compaction" &&
                    typeof entry.id === "string"
                  ) {
                    if (streamMode === "content") {
                      reasoningPhase += 1
                      streamMode = "reasoning"
                    }
                    if (
                      !accReasoning.some(
                        (item) =>
                          item.type === "context_compaction" &&
                          item.id === entry.id
                      )
                    ) {
                      accReasoning.push({ ...entry, phase: reasoningPhase })
                    }
                    dispatch({
                      type: "ADD_STREAMING_CONTEXT_COMPACTION",
                      entry: { ...entry, phase: reasoningPhase },
                    })
                  }
                } else if (data.type === "context_usage") {
                  if (
                    data.contextUsage &&
                    typeof data.contextUsage === "object"
                  ) {
                    dispatch({
                      type: "UPDATE_CONTEXT_USAGE",
                      conversationId: finalConvId,
                      contextUsage: data.contextUsage as ContextUsageSnapshot,
                    })
                  }
                } else if (data.type === "artifact_end") {
                  // Server finalised an artifact and persisted it; bridge the
                  // row to the ConversationArtifactsProvider via a window
                  // event so the message renderer can swap in the rendered
                  // card without round-tripping back to the API.
                  if (data.artifact && typeof window !== "undefined") {
                    window.dispatchEvent(
                      new CustomEvent("orch:artifact", {
                        detail: data.artifact,
                      })
                    )
                  }
                } else if (data.type === "artifact_start") {
                  // Bridge to the provider so a "Generating…" placeholder
                  // appears immediately. Carries messageId so the draft
                  // lands in the right bubble.
                  if (
                    typeof window !== "undefined" &&
                    data.clientToken &&
                    data.attrs
                  ) {
                    window.dispatchEvent(
                      new CustomEvent("orch:artifact-start", {
                        detail: {
                          clientToken: data.clientToken,
                          messageId: assistantMsgId,
                          attrs: data.attrs,
                        },
                      })
                    )
                  }
                } else if (data.type === "artifact_chunk") {
                  // Append content into the draft so the placeholder can
                  // live-render (mermaid/svg/markdown partials).
                  if (
                    typeof window !== "undefined" &&
                    data.clientToken &&
                    typeof data.content === "string"
                  ) {
                    window.dispatchEvent(
                      new CustomEvent("orch:artifact-chunk", {
                        detail: {
                          clientToken: data.clientToken,
                          content: data.content,
                        },
                      })
                    )
                  }
                } else if (data.type === "artifact_error") {
                  console.warn("Artifact parse error:", data.message)
                } else if (data.type === "done") {
                  // Stream complete — build the final message from accumulated data
                  // (server already saved to DB, so this is just for local state)
                  streamDoneRef.current = true
                  if (Array.isArray(data.attachments)) {
                    accAttachments = data.attachments as Attachment[]
                  }
                  const finalMsg: Message = {
                    id: assistantMsgId,
                    role: "assistant",
                    content: accContent,
                    status: "ok",
                    contentSegments: accContentSegments,
                    reasoning: accReasoning,
                    thinking: accThinking || undefined,
                    thinkingDuration:
                      data.thinkingDuration ||
                      finalThinkingDuration ||
                      undefined,
                    attachments:
                      accAttachments.length > 0 ? accAttachments : undefined,
                    timestamp: Date.now(),
                  }
                  dispatch({
                    type: "ADD_ASSISTANT_MESSAGE",
                    conversationId: finalConvId,
                    message: finalMsg,
                  })
                  handleAssistantFinished(finalConvId, finalMsg)
                } else if (data.type === "stopped") {
                  streamDoneRef.current = true
                  const finalMsg: Message = {
                    id: assistantMsgId,
                    role: "assistant",
                    content: accContent,
                    status: "aborted",
                    contentSegments: accContentSegments,
                    reasoning: accReasoning,
                    thinking: accThinking || undefined,
                    thinkingDuration: finalThinkingDuration || 0,
                    attachments:
                      accAttachments.length > 0 ? accAttachments : undefined,
                    timestamp: Date.now(),
                  }
                  dispatch({
                    type: "ADD_ASSISTANT_MESSAGE",
                    conversationId: finalConvId,
                    message: finalMsg,
                  })
                } else if (data.type === "error") {
                  console.error("Stream error:", data.error)
                }
              } catch {
                // Skip malformed JSON
              }
            }
          }
        })
        .catch((err) => {
          if (err.name === "AbortError") return
          console.error("Chat fetch error:", err)
          streamDoneRef.current = true
          const messageText =
            err instanceof ChatFetchError && err.chatMessage
              ? err.chatMessage
              : `I couldn't start the model runtime: ${errorMessageFromUnknown(err)}`
          const finalMsg: Message = {
            id: assistantMsgId,
            role: "assistant",
            content: messageText,
            status: "error",
            contentSegments: [{ phase: 0, content: messageText }],
            timestamp: Date.now(),
          }
          dispatch({
            type: "ADD_ASSISTANT_MESSAGE",
            conversationId: finalConvId,
            message: finalMsg,
          })
          handleAssistantFinished(finalConvId, finalMsg)
        })
        .finally(() => {
          streamingRef.current = false
          abortControllerRef.current = null
          if (thinkingTimerRef.current !== null) {
            window.clearInterval(thinkingTimerRef.current)
            thinkingTimerRef.current = null
          }
          // Only dispatch SET_STREAMING if 'done' didn't already handle it
          // (ADD_ASSISTANT_MESSAGE includes stoppedStreamState)
          if (!streamDoneRef.current) {
            dispatch({ type: "SET_STREAMING", isStreaming: false })
          }
        })
    },
    [handleAssistantFinished, state.activeConversationId, state.conversations]
  )

  const value = React.useMemo(
    () => ({
      state,
      unreadConversationIds,
      newChat,
      selectConversation,
      loadOlderMessages,
      deleteConversation,
      sendMessage,
      stopStreaming,
    }),
    [
      state,
      unreadConversationIds,
      newChat,
      selectConversation,
      loadOlderMessages,
      deleteConversation,
      sendMessage,
      stopStreaming,
    ]
  )

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

export function useChatStore() {
  const context = React.useContext(ChatContext)
  if (!context) {
    throw new Error("useChatStore must be used within a ChatStoreProvider")
  }
  return context
}
