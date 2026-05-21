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
import {
  ChatFetchError,
  INITIAL_MESSAGE_PAGE_SIZE,
  OLDER_MESSAGE_PAGE_SIZE,
  STREAM_RECOVERY_ATTEMPTS,
  STREAM_RECOVERY_DELAY_MS,
  appendAgentContent,
  appendAgentThought,
  deriveUnreadConversationIds,
  errorMessageFromUnknown,
  isConversationUnread,
  isLikelyStreamInterruption,
  isTerminalAssistantMessage,
  markReasoningStopped,
  mergeMessagesById,
  readUnreadConversationIds,
  showChatCompletionNotification,
  sleep,
  stoppedStreamState,
  unreadSetsEqual,
  updateAgentEntry,
  writeUnreadConversationIds,
  type ActiveChatStream,
  type ConversationLoadState,
  type ConversationMessagePageState,
  type MessagePageResponse,
  type StreamingReasoning,
} from "./chat-store-utils"

interface ChatState {
  conversations: Conversation[]
  isLoading: boolean
  activeChatStreams: Record<string, ActiveChatStream>
  conversationLoadState: Record<string, ConversationLoadState>
  conversationLoadErrors: Record<string, string | undefined>
  conversationMessagePages: Record<string, ConversationMessagePageState>
  activeConversationId: string | null
  isStreaming: boolean
  streamingConversationId: string | null
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
  | { type: "SET_ACTIVE_CHAT_STREAMS"; streams: ActiveChatStream[] }
  | { type: "CHAT_STREAM_STARTED"; stream: ActiveChatStream }
  | { type: "CHAT_STREAM_ENDED"; conversationId: string; messageId?: string }
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
  | {
      type: "SET_STREAMING"
      isStreaming: boolean
      conversationId?: string
      messageId?: string
    }
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
  | {
      type: "SET_CONVERSATION_READ_STATE"
      conversationId: string
      readAt: number | null
    }
  | { type: "SET_THINKING_DONE"; seconds: number }
  | { type: "SET_THINKING_SECONDS"; seconds: number }
  | {
      type: "ADD_ASSISTANT_MESSAGE"
      conversationId: string
      message: Message
      stopStreaming?: boolean
    }
  | {
      type: "STOP_STREAMING_WITH_PARTIAL"
      conversationId: string
      timestamp: number
    }
  | { type: "ADD_SYNCED_CONVERSATION"; conversation: Conversation }

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "SET_ACTIVE_CHAT_STREAMS":
      return {
        ...state,
        activeChatStreams: Object.fromEntries(
          action.streams.map((stream) => [stream.conversationId, stream])
        ),
      }
    case "CHAT_STREAM_STARTED":
      return {
        ...state,
        activeChatStreams: {
          ...state.activeChatStreams,
          [action.stream.conversationId]: action.stream,
        },
      }
    case "CHAT_STREAM_ENDED": {
      const current = state.activeChatStreams[action.conversationId]
      if (action.messageId && current && current.messageId !== action.messageId)
        return state
      const activeChatStreams = { ...state.activeChatStreams }
      delete activeChatStreams[action.conversationId]
      return {
        ...state,
        activeChatStreams,
      }
    }
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
        activeChatStreams: Object.fromEntries(
          Object.entries(state.activeChatStreams).filter(
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
            streamingConversationId:
              action.conversationId ?? state.streamingConversationId,
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
    case "SET_CONVERSATION_READ_STATE":
      return {
        ...state,
        conversations: state.conversations.map((conv) =>
          conv.id === action.conversationId
            ? { ...conv, readAt: action.readAt }
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
      const activeChatStreams = { ...nextState.activeChatStreams }
      delete activeChatStreams[action.conversationId]
      const shouldClearStreaming =
        state.streamingConversationId == null ||
        state.streamingConversationId === action.conversationId
      return {
        ...nextState,
        activeChatStreams,
        ...(shouldClearStreaming ? stoppedStreamState : {}),
      }
    }
    case "STOP_STREAMING_WITH_PARTIAL": {
      const stream = state.activeChatStreams[action.conversationId]
      const streamingMessageId = state.streamingMessageId ?? stream?.messageId
      const activeChatStreams = { ...state.activeChatStreams }
      delete activeChatStreams[action.conversationId]

      const hasStreamingPayload =
        state.streamingContent.length > 0 ||
        state.streamingContentSegments.some(
          (segment) => segment.content.length > 0
        ) ||
        state.streamingReasoning.length > 0

      const existingConversation = state.conversations.find(
        (conversation) => conversation.id === action.conversationId
      )
      const existingMessage = existingConversation?.messages.find(
        (message) => message.id === streamingMessageId
      )
      const existingAssistantMessage =
        existingMessage?.role === "assistant" ? existingMessage : undefined
      const stoppedStreamingReasoning =
        markReasoningStopped(state.streamingReasoning, action.timestamp) ?? []
      const stoppedExistingReasoning = markReasoningStopped(
        existingAssistantMessage?.reasoning,
        action.timestamp
      )

      if (
        !streamingMessageId ||
        (!hasStreamingPayload && !existingAssistantMessage)
      ) {
        return {
          ...state,
          activeChatStreams,
          ...stoppedStreamState,
        }
      }

      const partialMessage: Message = hasStreamingPayload
        ? {
            ...existingAssistantMessage,
            id: streamingMessageId,
            role: "assistant",
            content: state.streamingContent,
            status: "aborted",
            contentSegments: state.streamingContentSegments,
            reasoning: stoppedStreamingReasoning,
            thinkingDuration: state.thinkingDone
              ? state.thinkingSeconds
              : (existingAssistantMessage?.thinkingDuration ?? 0),
            timestamp:
              existingAssistantMessage?.timestamp ??
              stream?.startedAt ??
              action.timestamp,
          }
        : {
            ...existingAssistantMessage!,
            status: "aborted",
            reasoning: stoppedExistingReasoning,
            thinkingDuration: existingAssistantMessage!.thinkingDuration ?? 0,
          }
      const isNewMessage = !existingConversation?.messages.some(
        (message) => message.id === partialMessage.id
      )
      const page = state.conversationMessagePages[action.conversationId]

      return {
        ...state,
        activeChatStreams,
        conversations: state.conversations.map((conv) =>
          conv.id === action.conversationId
            ? {
                ...conv,
                updatedAt: partialMessage.timestamp,
                messageCount:
                  (conv.messageCount ?? conv.messages.length) +
                  (conv.messages.some((m) => m.id === partialMessage.id)
                    ? 0
                    : 1),
                lastMessagePreview:
                  partialMessage.content || conv.lastMessagePreview,
                lastMessageAt: partialMessage.timestamp,
                messages: conv.messages.some((m) => m.id === partialMessage.id)
                  ? conv.messages.map((m) =>
                      m.id === partialMessage.id ? partialMessage : m
                    )
                  : [...conv.messages, partialMessage],
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
  // True while the SELECT_CONVERSATION dispatch is queued at transition
  // priority — i.e. React is still preparing the new chat's render in the
  // background and the committed UI is still showing the previous chat.
  // page.tsx uses this to overlay a skeleton so a slow switch doesn't read
  // as "stuck on the wrong chat" for several seconds.
  isSwitchingConversation: boolean
  newChat: () => void
  selectConversation: (id: string) => void
  prefetchConversationMessages: (id: string) => Promise<void>
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
    activeChatStreams: {},
    conversationLoadState: {},
    conversationLoadErrors: {},
    conversationMessagePages: {},
    activeConversationId: null,
    ...stoppedStreamState,
  })
  const [unreadConversationIds, setUnreadConversationIds] = React.useState<
    Set<string>
  >(() => readUnreadConversationIds())
  const unreadConversationIdsRef =
    React.useRef<Set<string>>(unreadConversationIds)
  // Wrap the SELECT_CONVERSATION dispatch in a transition so React can
  // prepare the (potentially expensive) new chat render in the background
  // without blocking. The boolean flips true the instant the user clicks,
  // and clears once the new render commits.
  const [isSwitchingConversation, startSwitchTransition] = React.useTransition()

  const abortControllerRef = React.useRef<AbortController | null>(null)
  const thinkingTimerRef = React.useRef<number | null>(null)
  const streamingRef = React.useRef(false)
  const streamDoneRef = React.useRef(false)
  const clientStreamMessageIdRef = React.useRef<string | null>(null)
  const streamPageWasHiddenRef = React.useRef(false)
  const activeConversationIdRef = React.useRef<string | null>(null)
  const conversationsRef = React.useRef<Conversation[]>([])
  const activeChatStreamsRef = React.useRef<Record<string, ActiveChatStream>>(
    {}
  )
  const isStreamingStateRef = React.useRef(false)
  const conversationLoadStateRef = React.useRef<
    Record<string, ConversationLoadState>
  >({})
  const initialMessageLoadsRef = React.useRef<Map<string, Promise<void>>>(
    new Map()
  )

  React.useEffect(() => {
    activeConversationIdRef.current = state.activeConversationId
  }, [state.activeConversationId])

  React.useEffect(() => {
    conversationsRef.current = state.conversations
  }, [state.conversations])

  React.useEffect(() => {
    unreadConversationIdsRef.current = unreadConversationIds
  }, [unreadConversationIds])

  React.useEffect(() => {
    if (state.isLoading) return
    const visibleActiveConversationId =
      typeof document !== "undefined" && document.visibilityState === "visible"
        ? state.activeConversationId
        : null
    const next = deriveUnreadConversationIds(
      state.conversations,
      visibleActiveConversationId
    )
    if (unreadSetsEqual(unreadConversationIdsRef.current, next)) return
    writeUnreadConversationIds(next)
    unreadConversationIdsRef.current = next
    setUnreadConversationIds(next)
  }, [state.activeConversationId, state.conversations, state.isLoading])

  React.useEffect(() => {
    activeChatStreamsRef.current = state.activeChatStreams
  }, [state.activeChatStreams])

  React.useEffect(() => {
    isStreamingStateRef.current = state.isStreaming
  }, [state.isStreaming])

  React.useEffect(() => {
    conversationLoadStateRef.current = state.conversationLoadState
  }, [state.conversationLoadState])

  React.useEffect(() => {
    const markHiddenDuringStream = () => {
      if (
        document.visibilityState === "hidden" &&
        (streamingRef.current ||
          isStreamingStateRef.current ||
          Object.keys(activeChatStreamsRef.current).length > 0)
      ) {
        streamPageWasHiddenRef.current = true
      }
    }

    document.addEventListener("visibilitychange", markHiddenDuringStream)
    window.addEventListener("pagehide", markHiddenDuringStream)
    return () => {
      document.removeEventListener("visibilitychange", markHiddenDuringStream)
      window.removeEventListener("pagehide", markHiddenDuringStream)
    }
  }, [])

  const updateUnreadConversationIds = React.useCallback(
    (updater: (current: Set<string>) => Set<string>) => {
      setUnreadConversationIds((current) => {
        const next = updater(new Set(current))
        if (unreadSetsEqual(current, next)) return current
        writeUnreadConversationIds(next)
        unreadConversationIdsRef.current = next
        return next
      })
    },
    []
  )

  const applyConversationReadState = React.useCallback(
    (id: string, readAt: number | null) => {
      dispatch({
        type: "SET_CONVERSATION_READ_STATE",
        conversationId: id,
        readAt,
      })
      updateUnreadConversationIds((current) => {
        const conversation = conversationsRef.current.find((c) => c.id === id)
        if (!conversation) {
          current.delete(id)
          return current
        }
        const visibleActiveConversationId =
          typeof document !== "undefined" &&
          document.visibilityState === "visible"
            ? activeConversationIdRef.current
            : null
        if (
          isConversationUnread(
            { ...conversation, readAt },
            visibleActiveConversationId
          )
        ) {
          current.add(id)
        } else {
          current.delete(id)
        }
        return current
      })
    },
    [updateUnreadConversationIds]
  )

  const persistConversationReadState = React.useCallback(
    (id: string, read: boolean) => {
      fetch(`/api/conversations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ read }),
      }).catch((err) => {
        console.error(err)
      })
    },
    []
  )

  const markConversationRead = React.useCallback(
    (id: string) => {
      const readAt = Date.now()
      applyConversationReadState(id, readAt)
      persistConversationReadState(id, true)
    },
    [applyConversationReadState, persistConversationReadState]
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

  const clearConversationUnread = React.useCallback(
    (id: string) => {
      updateUnreadConversationIds((current) => {
        current.delete(id)
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

  const detachStreaming = React.useCallback(() => {
    // Navigation should detach this tab's live reader, not stop the server run.
    streamDoneRef.current = true
    clientStreamMessageIdRef.current = null
    cleanupStream()
    dispatch({ type: "SET_STREAMING", isStreaming: false })
  }, [cleanupStream])

  const stopStreaming = React.useCallback(() => {
    const conversationId = activeConversationIdRef.current
    clientStreamMessageIdRef.current = null
    if (conversationId) {
      streamDoneRef.current = true
      dispatch({
        type: "STOP_STREAMING_WITH_PARTIAL",
        conversationId,
        timestamp: Date.now(),
      })
    } else {
      dispatch({ type: "SET_STREAMING", isStreaming: false })
    }
    cleanupStream()
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

  const refreshConversationSummaries = React.useCallback(async () => {
    const res = await fetch("/api/conversations?summary=1", {
      cache: "no-store",
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (Array.isArray(data)) {
      dispatch({
        type: "INIT_CONVERSATIONS",
        conversations: data,
        full: false,
      })
    }
  }, [])

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
          await refreshConversationSummaries()
          if (cancelled) return
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
  }, [refreshConversationSummaries])

  React.useEffect(() => {
    let sequence = 0
    const reconcileSummaries = () => {
      if (document.visibilityState !== "visible") return
      const currentSequence = ++sequence
      void refreshConversationSummaries().catch((err) => {
        if (currentSequence === sequence) {
          console.warn("Failed to refresh conversations", err)
        }
      })
    }

    document.addEventListener("visibilitychange", reconcileSummaries)
    window.addEventListener("pageshow", reconcileSummaries)
    window.addEventListener("focus", reconcileSummaries)
    return () => {
      sequence += 1
      document.removeEventListener("visibilitychange", reconcileSummaries)
      window.removeEventListener("pageshow", reconcileSummaries)
      window.removeEventListener("focus", reconcileSummaries)
    }
  }, [refreshConversationSummaries])

  const loadInitialMessages = React.useCallback(
    async (conversationId: string) => {
      const status = conversationLoadStateRef.current[conversationId]
      if (
        status === "partial" ||
        status === "full" ||
        status === "loading" ||
        status === "error"
      )
        return

      const existingLoad = initialMessageLoadsRef.current.get(conversationId)
      if (existingLoad) return existingLoad

      const load = (async () => {
        dispatch({ type: "LOAD_CONVERSATION_START", id: conversationId })
        try {
          const res = await fetch(
            `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${INITIAL_MESSAGE_PAGE_SIZE}`,
            { cache: "no-store" }
          )
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const page = (await res.json()) as MessagePageResponse
          dispatch({
            type: "LOAD_MESSAGE_PAGE_SUCCESS",
            id: conversationId,
            messages: page.messages,
            total: page.total,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
            mode: "replace",
          })
        } catch (err) {
          dispatch({
            type: "LOAD_CONVERSATION_ERROR",
            id: conversationId,
            error: err instanceof Error ? err.message : "Failed to load chat",
          })
        } finally {
          initialMessageLoadsRef.current.delete(conversationId)
        }
      })()

      initialMessageLoadsRef.current.set(conversationId, load)
      return load
    },
    []
  )

  const refreshConversationMessages = React.useCallback(
    async (conversationId: string): Promise<Message[]> => {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${INITIAL_MESSAGE_PAGE_SIZE}`,
        { cache: "no-store" }
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const page = (await res.json()) as MessagePageResponse
      dispatch({
        type: "LOAD_MESSAGE_PAGE_SUCCESS",
        id: conversationId,
        messages: page.messages,
        total: page.total,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        mode: "replace",
      })
      return page.messages
    },
    []
  )

  React.useEffect(() => {
    const conversationId = state.activeConversationId
    if (!conversationId) return
    void loadInitialMessages(conversationId)
  }, [loadInitialMessages, state.activeConversationId])

  const checkServerStreaming = React.useCallback(
    async (conversationId: string): Promise<ActiveChatStream | null> => {
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
    },
    []
  )

  const recoverInterruptedStream = React.useCallback(
    async (
      conversationId: string,
      messageId?: string | null
    ): Promise<"final" | "running" | null> => {
      for (let attempt = 0; attempt < STREAM_RECOVERY_ATTEMPTS; attempt += 1) {
        const [messagesResult, stream] = await Promise.allSettled([
          refreshConversationMessages(conversationId),
          checkServerStreaming(conversationId),
        ])
        const messages =
          messagesResult.status === "fulfilled" ? messagesResult.value : []
        const recoveredMessage =
          (messageId
            ? messages.find((message) => message.id === messageId)
            : null) ??
          [...messages]
            .reverse()
            .find((message) => message.role === "assistant") ??
          null
        const activeStream = stream.status === "fulfilled" ? stream.value : null

        if (recoveredMessage) {
          if (activeStream) {
            dispatch({
              type: "ADD_ASSISTANT_MESSAGE",
              conversationId,
              message: recoveredMessage,
              stopStreaming: false,
            })
            dispatch({
              type: "SET_STREAMING",
              isStreaming: true,
              conversationId,
              messageId: activeStream.messageId,
            })
            dispatch({ type: "CHAT_STREAM_STARTED", stream: activeStream })
            return "running"
          }

          if (isTerminalAssistantMessage(recoveredMessage)) {
            dispatch({
              type: "ADD_ASSISTANT_MESSAGE",
              conversationId,
              message: recoveredMessage,
            })
            handleAssistantFinished(conversationId, recoveredMessage)
            return "final"
          }
        }

        if (activeStream) {
          dispatch({
            type: "SET_STREAMING",
            isStreaming: true,
            conversationId,
            messageId: activeStream.messageId,
          })
          dispatch({ type: "CHAT_STREAM_STARTED", stream: activeStream })
          return "running"
        }

        if (attempt < STREAM_RECOVERY_ATTEMPTS - 1) {
          await sleep(STREAM_RECOVERY_DELAY_MS)
        }
      }

      return null
    },
    [checkServerStreaming, handleAssistantFinished, refreshConversationMessages]
  )

  const refreshActiveChatStreams = React.useCallback(async (): Promise<
    ActiveChatStream[]
  > => {
    try {
      const res = await fetch("/api/chat/active", { cache: "no-store" })
      if (!res.ok) return []
      const data = await res.json()
      const streams = Array.isArray(data.streams)
        ? data.streams.filter(
            (stream: unknown): stream is ActiveChatStream =>
              Boolean(stream) &&
              typeof stream === "object" &&
              typeof (stream as ActiveChatStream).conversationId === "string" &&
              typeof (stream as ActiveChatStream).messageId === "string" &&
              typeof (stream as ActiveChatStream).startedAt === "number"
          )
        : []
      dispatch({ type: "SET_ACTIVE_CHAT_STREAMS", streams })
      return streams
    } catch {
      // Best-effort reconciliation; local actions and SSE keep the slot responsive.
      return []
    }
  }, [])

  React.useEffect(() => {
    void refreshActiveChatStreams()
    const interval = window.setInterval(refreshActiveChatStreams, 5000)
    return () => window.clearInterval(interval)
  }, [refreshActiveChatStreams])

  React.useEffect(() => {
    let sequence = 0

    const reconcileAfterResume = () => {
      if (document.visibilityState !== "visible") return
      const conversationId = activeConversationIdRef.current
      if (!conversationId) return

      const knownStream = activeChatStreamsRef.current[conversationId]
      if (!knownStream && !isStreamingStateRef.current) return

      const currentSequence = ++sequence
      void (async () => {
        const streams = await refreshActiveChatStreams()
        if (currentSequence !== sequence) return
        const stream =
          streams.find((item) => item.conversationId === conversationId) ??
          activeChatStreamsRef.current[conversationId]
        await recoverInterruptedStream(conversationId, stream?.messageId)
      })()
    }

    document.addEventListener("visibilitychange", reconcileAfterResume)
    window.addEventListener("pageshow", reconcileAfterResume)
    window.addEventListener("focus", reconcileAfterResume)
    return () => {
      sequence += 1
      document.removeEventListener("visibilitychange", reconcileAfterResume)
      window.removeEventListener("pageshow", reconcileAfterResume)
      window.removeEventListener("focus", reconcileAfterResume)
    }
  }, [recoverInterruptedStream, refreshActiveChatStreams])

  React.useEffect(() => {
    const conversationId = state.activeConversationId
    if (!conversationId || streamingRef.current) return

    let cancelled = false

    checkServerStreaming(conversationId).then((stream) => {
      if (
        cancelled ||
        activeConversationIdRef.current !== conversationId ||
        streamingRef.current
      )
        return
      dispatch({
        type: "SET_STREAMING",
        isStreaming: Boolean(stream),
        conversationId,
        messageId: stream?.messageId,
      })
      if (stream) dispatch({ type: "CHAT_STREAM_STARTED", stream })
    })

    return () => {
      cancelled = true
    }
  }, [checkServerStreaming, state.activeConversationId])

  React.useEffect(() => {
    const conversationId = state.activeConversationId
    if (
      !conversationId ||
      !state.isStreaming ||
      state.streamingConversationId !== conversationId ||
      streamingRef.current
    )
      return

    let cancelled = false
    let recovering = false
    const streamMessageId =
      state.streamingMessageId ??
      activeChatStreamsRef.current[conversationId]?.messageId
    const tick = () => {
      checkServerStreaming(conversationId).then((stream) => {
        if (
          cancelled ||
          activeConversationIdRef.current !== conversationId ||
          streamingRef.current
        )
          return
        if (stream) {
          dispatch({
            type: "SET_STREAMING",
            isStreaming: true,
            conversationId,
            messageId: stream.messageId,
          })
          dispatch({ type: "CHAT_STREAM_STARTED", stream })
        } else {
          if (recovering) return
          recovering = true
          void recoverInterruptedStream(conversationId, streamMessageId)
            .then((recovered) => {
              if (cancelled || recovered) return
              dispatch({ type: "SET_STREAMING", isStreaming: false })
              dispatch({ type: "CHAT_STREAM_ENDED", conversationId })
            })
            .finally(() => {
              recovering = false
            })
        }
      })
    }

    const interval = window.setInterval(tick, 1000)
    tick()
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [
    checkServerStreaming,
    recoverInterruptedStream,
    state.activeConversationId,
    state.isStreaming,
    state.streamingConversationId,
    state.streamingMessageId,
  ])

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
              updatedAt: data.payload.updatedAt,
              messages: data.payload.messages || [],
              messageCount: data.payload.messageCount,
              lastMessagePreview: data.payload.lastMessagePreview,
              lastMessageAt: data.payload.lastMessageAt,
              readAt: data.payload.readAt ?? null,
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
                dispatch({
                  type: "SET_STREAMING",
                  isStreaming: true,
                  conversationId: data.payload.conversationId,
                })
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
        } else if (data.type === "conversation_read_state") {
          if (typeof data.payload?.conversationId === "string") {
            applyConversationReadState(
              data.payload.conversationId,
              typeof data.payload.readAt === "number"
                ? data.payload.readAt
                : null
            )
          }
        } else if (data.type === "delete_conversation") {
          dispatch({ type: "DELETE_CONVERSATION", id: data.payload.id })
        } else if (data.type === "chat_stream_started") {
          dispatch({
            type: "CHAT_STREAM_STARTED",
            stream: {
              conversationId: data.payload.conversationId,
              messageId: data.payload.messageId,
              startedAt: data.payload.startedAt,
            },
          })
        } else if (data.type === "chat_stream_ended") {
          dispatch({
            type: "CHAT_STREAM_ENDED",
            conversationId: data.payload.conversationId,
            messageId: data.payload.messageId,
          })
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
  }, [applyConversationReadState, handleAssistantFinished])

  const newChat = React.useCallback(() => {
    detachStreaming()
    dispatch({ type: "NEW_CHAT" })
    if (typeof window !== "undefined") {
      setTimeout(
        () => window.dispatchEvent(new CustomEvent("chat-input-focus")),
        0
      )
    }
  }, [detachStreaming])

  const selectConversation = React.useCallback(
    (id: string) => {
      // Re-clicking the active chat would otherwise schedule a no-op
      // transition and flash the skeleton overlay for one frame.
      if (activeConversationIdRef.current === id) return
      detachStreaming()
      markConversationRead(id)
      void loadInitialMessages(id)
      startSwitchTransition(() => {
        dispatch({ type: "SELECT_CONVERSATION", id })
      })
    },
    [detachStreaming, loadInitialMessages, markConversationRead]
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
      clearConversationUnread(id)
      dispatch({ type: "DELETE_CONVERSATION", id })
    },
    [clearConversationUnread, stopStreaming]
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
        const createdAt = Date.now()
        const newConv: Conversation = {
          id: conversationId,
          title: generateTitle(content, finalAttachments),
          messages: [userMessage],
          createdAt,
          updatedAt: userMessage.timestamp,
          messageCount: 1,
          lastMessagePreview: userMessage.content,
          lastMessageAt: userMessage.timestamp,
          readAt: userMessage.timestamp,
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
        markConversationRead(conversationId)

        // Build messages array from current state + new user message
        const conv = state.conversations.find((c) => c.id === conversationId)
        allMessages = [...(conv?.messages ?? []), userMessage]
      }

      // Start streaming
      const assistantMsgId = generateId()
      const abortController = new AbortController()
      abortControllerRef.current = abortController
      clientStreamMessageIdRef.current = assistantMsgId
      streamingRef.current = true
      streamDoneRef.current = false
      streamPageWasHiddenRef.current = document.visibilityState !== "visible"

      dispatch({
        type: "SET_STREAMING",
        isStreaming: true,
        conversationId,
        messageId: assistantMsgId,
      })

      // Start thinking timer (live seconds counter)
      const thinkingStart = Date.now()
      thinkingTimerRef.current = window.setInterval(() => {
        const elapsed = Math.round((Date.now() - thinkingStart) / 1000)
        dispatch({ type: "SET_THINKING_SECONDS", seconds: elapsed })
      }, 1000)

      const finalConvId = conversationId
      dispatch({
        type: "CHAT_STREAM_STARTED",
        stream: {
          conversationId: finalConvId,
          messageId: assistantMsgId,
          startedAt: Date.now(),
        },
      })

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
        .catch(async (err) => {
          if (err.name === "AbortError") return
          console.error("Chat fetch error:", err)

          if (
            isLikelyStreamInterruption(err) &&
            (streamPageWasHiddenRef.current ||
              document.visibilityState !== "visible" ||
              !navigator.onLine ||
              errorMessageFromUnknown(err)
                .toLowerCase()
                .includes("load failed"))
          ) {
            const recovered = await recoverInterruptedStream(
              finalConvId,
              assistantMsgId
            )
            if (recovered) {
              streamDoneRef.current = true
              return
            }

            dispatch({ type: "SET_STREAMING", isStreaming: false })
            dispatch({
              type: "CHAT_STREAM_ENDED",
              conversationId: finalConvId,
              messageId: assistantMsgId,
            })
            return
          }

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
          if (clientStreamMessageIdRef.current === assistantMsgId) {
            streamingRef.current = false
            abortControllerRef.current = null
            clientStreamMessageIdRef.current = null
            if (thinkingTimerRef.current !== null) {
              window.clearInterval(thinkingTimerRef.current)
              thinkingTimerRef.current = null
            }
            // Only dispatch SET_STREAMING if 'done' didn't already handle it
            // (ADD_ASSISTANT_MESSAGE includes stoppedStreamState)
            if (!streamDoneRef.current) {
              dispatch({ type: "SET_STREAMING", isStreaming: false })
              dispatch({
                type: "CHAT_STREAM_ENDED",
                conversationId: finalConvId,
              })
            }
          }
        })
    },
    [
      handleAssistantFinished,
      markConversationRead,
      recoverInterruptedStream,
      state.activeConversationId,
      state.conversations,
    ]
  )

  const value = React.useMemo(
    () => ({
      state,
      unreadConversationIds,
      isSwitchingConversation,
      newChat,
      selectConversation,
      prefetchConversationMessages: loadInitialMessages,
      loadOlderMessages,
      deleteConversation,
      sendMessage,
      stopStreaming,
    }),
    [
      state,
      unreadConversationIds,
      isSwitchingConversation,
      newChat,
      selectConversation,
      loadInitialMessages,
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
