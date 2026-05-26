import type {
  AgentCallReasoningEntry,
  ContextCompactionReasoningEntry,
  ContextUsageSnapshot,
  Conversation,
  Message,
  ToolStreamDelta,
} from "@/lib/types"
import {
  appendBoundedToolDelta,
  sanitizeReasoningForPersistence,
} from "@/lib/ai/reasoning-limits"
import {
  appendAgentContent,
  appendAgentThought,
  markReasoningStopped,
  mergeMessagesById,
  stoppedStreamState,
  updateAgentEntry,
  type ActiveChatStream,
  type ConversationLoadState,
  type ConversationMessagePageState,
  type StreamingReasoning,
} from "./chat-store-utils"

export interface ChatState {
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

export type ChatAction =
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
  | {
      type: "CREATE_CONVERSATION"
      conversation: Conversation
      activate?: boolean
    }
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
  | {
      type: "APPEND_STREAMING_AGENT_THINKING"
      runId: string
      chunk: string
      phase?: number
    }
  | {
      type: "APPEND_STREAMING_AGENT_CONTENT"
      runId: string
      chunk: string
      phase?: number
    }
  | {
      type: "ADD_STREAMING_AGENT_TOOL_CALL"
      runId: string
      toolCallId: string
      title: string
      phase?: number
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
  | {
      type: "SET_CONVERSATION_ARCHIVE_STATE"
      conversationId: string
      archivedAt: number | null
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
  | {
      type: "ADD_SYNCED_CONVERSATION"
      conversation: Conversation
      full?: boolean
    }

function getConversationActivityAt(conversation: Conversation): number {
  const lastLoadedMessageAt = conversation.messages.at(-1)?.timestamp

  return Math.max(
    conversation.lastMessageAt ?? 0,
    lastLoadedMessageAt ?? 0,
    conversation.createdAt ?? 0
  )
}

function sortConversationsByActivity(
  conversations: Conversation[]
): Conversation[] {
  return [...conversations].sort((a, b) => {
    const activityDelta =
      getConversationActivityAt(b) - getConversationActivityAt(a)
    if (activityDelta !== 0) return activityDelta

    return b.createdAt - a.createdAt
  })
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
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
      const shouldClearStreaming =
        state.isStreaming &&
        state.streamingConversationId === action.conversationId &&
        (!action.messageId ||
          !state.streamingMessageId ||
          state.streamingMessageId === action.messageId)
      return {
        ...state,
        activeChatStreams,
        ...(shouldClearStreaming ? stoppedStreamState : {}),
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
        if (
          !action.full &&
          previous &&
          conversation.messages.length === 0 &&
          previous.messages.length > 0
        ) {
          return {
            ...conversation,
            messages: previous.messages,
            contextUsage: conversation.contextUsage ?? previous.contextUsage,
          }
        }
        return conversation
      })
      const merged = sortConversationsByActivity([
        ...locallyCreated,
        ...mergedIncoming,
      ])
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
        conversations: sortConversationsByActivity(
          exists
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
      const activate = action.activate !== false
      if (activate && typeof window !== "undefined")
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
        activeConversationId: activate
          ? action.conversation.id
          : state.activeConversationId,
      }
    }
    case "ADD_SYNCED_CONVERSATION": {
      if (state.conversations.some((c) => c.id === action.conversation.id))
        return state
      const loadedCount = action.conversation.messages.length
      const total = action.conversation.messageCount ?? loadedCount
      const isFull = action.full ?? (loadedCount > 0 && loadedCount >= total)
      return {
        ...state,
        conversations: [action.conversation, ...state.conversations],
        conversationLoadState: {
          ...state.conversationLoadState,
          [action.conversation.id]: isFull ? "full" : "summary",
        },
        conversationLoadErrors: {
          ...state.conversationLoadErrors,
          [action.conversation.id]: undefined,
        },
        conversationMessagePages: {
          ...state.conversationMessagePages,
          [action.conversation.id]: {
            total,
            loadedCount,
            hasMore: total > loadedCount,
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
        conversations: sortConversationsByActivity(
          state.conversations.map((conv) =>
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
                  messages: conv.messages.some(
                    (m) => m.id === action.message.id
                  )
                    ? conv.messages.map((m) =>
                        m.id === action.message.id ? action.message : m
                      )
                    : [...conv.messages, action.message],
                }
              : conv
          )
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
                deltas: appendBoundedToolDelta(entry.deltas, action.delta),
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
          (entry) => appendAgentThought(entry, action.chunk, action.phase)
        ),
        streamingMode: "reasoning",
      }
    case "APPEND_STREAMING_AGENT_CONTENT":
      return {
        ...state,
        streamingReasoning: updateAgentEntry(
          state.streamingReasoning,
          action.runId,
          (entry) => appendAgentContent(entry, action.chunk, action.phase)
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
                  phase:
                    action.phase ?? entry.contentSegments?.at(-1)?.phase ?? 0,
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
                    deltas: appendBoundedToolDelta(item.deltas, action.delta),
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
            reasoning: action.reasoning
              ? sanitizeReasoningForPersistence(action.reasoning)
              : entry.reasoning,
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
    case "SET_CONVERSATION_ARCHIVE_STATE": {
      const nextActiveId =
        action.archivedAt != null &&
        state.activeConversationId === action.conversationId
          ? null
          : state.activeConversationId

      if (typeof window !== "undefined") {
        if (nextActiveId) localStorage.setItem("chat:active-id", nextActiveId)
        else localStorage.removeItem("chat:active-id")
      }

      return {
        ...state,
        conversations: sortConversationsByActivity(
          state.conversations.map((conv) =>
            conv.id === action.conversationId
              ? { ...conv, archivedAt: action.archivedAt }
              : conv
          )
        ),
        activeConversationId: nextActiveId,
        ...(state.activeConversationId === action.conversationId &&
        action.archivedAt != null
          ? stoppedStreamState
          : {}),
      }
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
        conversations: sortConversationsByActivity(
          state.conversations.map((conv) =>
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
                  messages: conv.messages.some(
                    (m) => m.id === action.message.id
                  )
                    ? conv.messages.map((m) =>
                        m.id === action.message.id ? action.message : m
                      )
                    : [...conv.messages, action.message],
                }
              : conv
          )
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
        conversations: sortConversationsByActivity(
          state.conversations.map((conv) =>
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
                  messages: conv.messages.some(
                    (m) => m.id === partialMessage.id
                  )
                    ? conv.messages.map((m) =>
                        m.id === partialMessage.id ? partialMessage : m
                      )
                    : [...conv.messages, partialMessage],
                }
              : conv
          )
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
