import type {
  AgentCallReasoningEntry,
  ContextCompactionReasoningEntry,
  ContextUsageSnapshot,
  Conversation,
  MemoryRecallReasoningEntry,
  Message,
  SteeredMessageReasoningEntry,
  ToolStreamDelta,
} from "@/lib/types"
import type { ChatFollowUpSnapshot } from "@/lib/chat-followup-types"
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
  type StreamingStatus,
  type StreamingReasoning,
} from "./chat-store-utils"

export interface ChatState {
  conversations: Conversation[]
  isLoading: boolean
  activeChatStreams: Record<string, ActiveChatStream>
  pendingFollowUps: Record<string, PendingChatFollowUp[]>
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
  streamingStatus: StreamingStatus
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

export type PendingFollowUpStatus = "submitting" | "queued" | "claimed"

export interface PendingChatFollowUp extends ChatFollowUpSnapshot {
  status: PendingFollowUpStatus
}

export function createInitialChatState(isLoading = true): ChatState {
  return {
    conversations: [],
    isLoading,
    activeChatStreams: {},
    pendingFollowUps: {},
    conversationLoadState: {},
    conversationLoadErrors: {},
    conversationMessagePages: {},
    activeConversationId: null,
    ...stoppedStreamState,
  }
}

export type ChatAction =
  | { type: "RESET_CHAT_STATE"; isLoading?: boolean }
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
  | {
      type: "MERGE_MESSAGE_DETAILS"
      conversationId: string
      message: Message
    }
  | { type: "LOAD_OLDER_MESSAGES_START"; id: string }
  | { type: "LOAD_OLDER_MESSAGES_ERROR"; id: string; error: string }
  | { type: "NEW_CHAT" }
  | { type: "SELECT_CONVERSATION"; id: string }
  | { type: "DELETE_CONVERSATION"; id: string }
  | {
      type: "ADD_USER_MESSAGE"
      conversationId: string
      message: Message
      /** Steering drain: re-position an already-rendered queued follow-up at
       *  the end of the list (mirrors the server-side claim re-stamp). */
      moveToEnd?: boolean
    }
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
      snapshot?: Message
      status?: StreamingStatus
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
      type: "ADD_STREAMING_MEMORY_RECALL"
      entry: MemoryRecallReasoningEntry
    }
  | {
      /** Live steering injection landed in the in-flight turn: surface the
       *  inline marker entry on the streaming reasoning. (The standalone user
       *  row is upserted separately via ADD_USER_MESSAGE with the tagged
       *  server copy, which hides its bubble.) */
      type: "ADD_STREAMING_STEERED_MESSAGE"
      entry: SteeredMessageReasoningEntry
    }
  | {
      type: "UPSERT_PENDING_FOLLOWUP"
      conversationId: string
      followUp: PendingChatFollowUp
    }
  | {
      type: "SYNC_PENDING_FOLLOWUPS"
      conversationId: string
      followUps: ChatFollowUpSnapshot[]
    }
  | {
      type: "SET_PENDING_FOLLOWUP_STATUS"
      conversationId: string
      userMessageId: string
      status: PendingFollowUpStatus
    }
  | {
      type: "REMOVE_PENDING_FOLLOWUP"
      conversationId: string
      userMessageId: string
    }
  | {
      type: "SETTLE_FIRST_CLAIMED_FOLLOWUP"
      conversationId: string
    }
  | {
      /** Stop pressed: queued steering messages become plain history — drop
       *  their pending-steering render state. */
      type: "CLEAR_STEER_PENDING"
      conversationId: string
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
      type: "SET_CONVERSATION_TITLE"
      conversationId: string
      title: string
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

function inferStreamingMode(
  reasoning: StreamingReasoning,
  contentSegments: NonNullable<Message["contentSegments"]>
): "reasoning" | "content" | null {
  const lastReasoningPhase = reasoning.at(-1)?.phase
  const lastContentPhase = contentSegments.at(-1)?.phase

  if (typeof lastReasoningPhase !== "number") {
    return typeof lastContentPhase === "number" ? "content" : null
  }
  if (typeof lastContentPhase !== "number") return "reasoning"

  return lastContentPhase >= lastReasoningPhase ? "content" : "reasoning"
}

function upsertPendingFollowUp(
  pendingFollowUps: ChatState["pendingFollowUps"],
  conversationId: string,
  followUp: PendingChatFollowUp
): ChatState["pendingFollowUps"] {
  const queue = pendingFollowUps[conversationId] ?? []
  const existingIndex = queue.findIndex(
    (entry) => entry.userMessageId === followUp.userMessageId
  )
  const nextQueue = [...queue]
  if (existingIndex >= 0) nextQueue[existingIndex] = followUp
  else nextQueue.push(followUp)
  nextQueue.sort((a, b) => a.queuedAt - b.queuedAt)
  return { ...pendingFollowUps, [conversationId]: nextQueue }
}

function removePendingFollowUp(
  pendingFollowUps: ChatState["pendingFollowUps"],
  conversationId: string,
  userMessageId: string
): ChatState["pendingFollowUps"] {
  const queue = pendingFollowUps[conversationId]
  if (!queue?.some((entry) => entry.userMessageId === userMessageId)) {
    return pendingFollowUps
  }
  const nextQueue = queue.filter(
    (entry) => entry.userMessageId !== userMessageId
  )
  const next = { ...pendingFollowUps }
  if (nextQueue.length > 0) next[conversationId] = nextQueue
  else delete next[conversationId]
  return next
}

function settleFirstClaimedFollowUp(
  pendingFollowUps: ChatState["pendingFollowUps"],
  conversationId: string
): ChatState["pendingFollowUps"] {
  const claimed = pendingFollowUps[conversationId]?.find(
    (entry) => entry.status === "claimed"
  )
  return claimed
    ? removePendingFollowUp(
        pendingFollowUps,
        conversationId,
        claimed.userMessageId
      )
    : pendingFollowUps
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "RESET_CHAT_STATE":
      return createInitialChatState(action.isLoading ?? true)
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
        if (!action.full && previous) {
          // A summary refresh is not the authority on titles. Auto-naming and
          // renames arrive via SET_CONVERSATION_TITLE and the conversation_title
          // SSE event; keep the locally-tracked title so an in-flight summary
          // snapshot (read before auto-naming persisted) can't revert a freshly
          // generated title mid-turn and make the sidebar flicker.
          const keepMessages =
            conversation.messages.length === 0 && previous.messages.length > 0
          return {
            ...conversation,
            title: previous.title,
            messages: keepMessages ? previous.messages : conversation.messages,
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
      // Restore the last-open conversation from localStorage only when this
      // tab has no active selection (first load, or returning from a route
      // that cleared the list). Summary refreshes fire on every focus/SSE
      // reconnect; re-reading localStorage there would let another tab's
      // selection hijack this tab's open conversation. A currently-active id
      // is still validated against the fresh list so a remotely deleted
      // conversation falls back to Home.
      const candidateId =
        state.activeConversationId ??
        (typeof window !== "undefined"
          ? localStorage.getItem("chat:active-id")
          : null)
      const validActiveId = merged.some((c) => c.id === candidateId)
        ? candidateId
        : null
      return {
        ...state,
        conversations: merged,
        conversationLoadState,
        conversationLoadErrors,
        conversationMessagePages,
        activeConversationId: validActiveId,
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
      const existingPage = state.conversationMessagePages[action.id]
      const mergedMessages = mergeMessagesById(
        existingConversation?.messages ?? [],
        action.messages
      )
      // A tail reconciliation must not throw away the cursor for older pages
      // the user already loaded. "replace" refreshes the newest window while
      // merging by id; "prepend" is the only operation that advances the
      // oldest-page cursor.
      const preserveLoadedHistoryWindow = Boolean(
        action.mode === "replace" &&
          existingPage &&
          (existingPage.nextCursor !== null ||
            existingPage.loadedCount > action.messages.length)
      )
      const hasMore = preserveLoadedHistoryWindow
        ? existingPage!.hasMore
        : action.hasMore
      const nextCursor = preserveLoadedHistoryWindow
        ? existingPage!.nextCursor
        : action.nextCursor
      const nextLoadState: ConversationLoadState = hasMore
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
            hasMore,
            nextCursor,
            isLoadingOlder: false,
          },
        },
      }
    }
    case "MERGE_MESSAGE_DETAILS":
      return {
        ...state,
        conversations: state.conversations.map((conversation) =>
          conversation.id === action.conversationId
            ? {
                ...conversation,
                messages: conversation.messages.map((message) =>
                  message.id === action.message.id
                    ? {
                        ...message,
                        ...action.message,
                        deferred: undefined,
                      }
                    : message
                ),
              }
            : conversation
        ),
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
        pendingFollowUps: Object.fromEntries(
          Object.entries(state.pendingFollowUps).filter(([id]) => id !== action.id)
        ),
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
                    ? action.moveToEnd
                      ? [
                          ...conv.messages.filter(
                            (m) => m.id !== action.message.id
                          ),
                          action.message,
                        ]
                      : conv.messages.map((m) =>
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
    case "SET_STREAMING": {
      if (!action.isStreaming) return { ...state, ...stoppedStreamState }

      const nextConversationId =
        action.conversationId ?? state.streamingConversationId ?? null
      const nextMessageId = action.messageId ?? state.streamingMessageId ?? null
      const sameStream =
        state.isStreaming &&
        state.streamingConversationId === nextConversationId &&
        state.streamingMessageId === nextMessageId
      const sameConversation =
        state.isStreaming &&
        state.streamingConversationId === nextConversationId
      const snapshot = action.snapshot
      const snapshotSegments =
        snapshot?.contentSegments && snapshot.contentSegments.length > 0
          ? snapshot.contentSegments
          : snapshot?.content
            ? [{ phase: 0, content: snapshot.content }]
            : undefined
      const snapshotReasoning = snapshot?.reasoning ?? undefined
      const hasSnapshotPayload = Boolean(
        snapshot &&
          ((snapshotReasoning?.length ?? 0) > 0 ||
            (snapshotSegments?.some((segment) => segment.content.length > 0) ??
              false) ||
            snapshot.content.length > 0)
      )

      // A reconnect ("recovering"/"offline") fires when returning to a
      // backgrounded tab or switching away and back mid-stream. Those dispatches
      // carry no snapshot yet, so blanking to a fresh cursor flashes the live
      // text away for a beat before recovery re-hydrates it. Hold the existing
      // streaming UI in place while we reconnect within the same conversation;
      // the snapshot branch below still swaps in fresh content smoothly once it
      // arrives. A brand-new send uses "connecting" (not a reconnect status), so
      // it still starts clean.
      const isReconnectStatus =
        action.status === "recovering" ||
        action.status === "offline" ||
        action.status === "updating"
      const hasExistingStreamPayload =
        state.streamingContent.length > 0 ||
        state.streamingContentSegments.some(
          (segment) => segment.content.length > 0
        ) ||
        state.streamingReasoning.length > 0
      const preserveStreamPayload =
        sameStream ||
        (sameConversation &&
          isReconnectStatus &&
          !hasSnapshotPayload &&
          hasExistingStreamPayload)

      return {
        ...state,
        ...(preserveStreamPayload ? {} : stoppedStreamState),
        isStreaming: true,
        streamingConversationId: nextConversationId,
        streamingMessageId: nextMessageId,
        streamingStatus: hasSnapshotPayload
          ? null
          : action.status !== undefined
            ? action.status
            : sameStream
              ? state.streamingStatus
              : "connecting",
        ...(hasSnapshotPayload
          ? {
              streamingContent: snapshot?.content ?? "",
              streamingContentSegments: snapshotSegments ?? [],
              streamingReasoning: snapshotReasoning ?? [],
              streamingMode: inferStreamingMode(
                snapshotReasoning ?? [],
                snapshotSegments ?? []
              ),
              streamingStatus: null,
              thinkingDone:
                typeof snapshot?.thinkingDuration === "number"
                  ? true
                  : state.thinkingDone,
              thinkingSeconds:
                typeof snapshot?.thinkingDuration === "number"
                  ? Math.round(snapshot.thinkingDuration)
                  : state.thinkingSeconds,
            }
          : {}),
      }
    }
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
        streamingStatus: null,
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
        streamingStatus: null,
      }
    }
    case "ADD_STREAMING_TOOL_CALL":
      if (
        state.streamingReasoning.some(
          (entry) =>
            entry.type === "tool_call" && entry.toolCallId === action.toolCallId
        )
      ) {
        return { ...state, streamingMode: "reasoning", streamingStatus: null }
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
        streamingStatus: null,
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
        streamingStatus: null,
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
        streamingStatus: null,
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
        streamingStatus: null,
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
        streamingStatus: null,
      }
    case "APPEND_STREAMING_AGENT_CONTENT":
      return {
        ...state,
        streamingReasoning: updateAgentEntry(
          state.streamingReasoning,
          action.runId,
          (entry) => appendAgentContent(entry, action.chunk, action.phase)
        ),
        streamingStatus: null,
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
        streamingStatus: null,
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
        streamingStatus: null,
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
        streamingStatus: null,
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
            queued: false,
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
        streamingStatus: null,
      }
    case "ADD_STREAMING_CONTEXT_COMPACTION":
      if (
        state.streamingReasoning.some(
          (entry) =>
            entry.type === "context_compaction" && entry.id === action.entry.id
        )
      ) {
        return { ...state, streamingMode: "reasoning", streamingStatus: null }
      }
      return {
        ...state,
        streamingReasoning: [...state.streamingReasoning, action.entry],
        streamingMode: "reasoning",
        streamingStatus: null,
      }
    case "ADD_STREAMING_MEMORY_RECALL":
      if (
        state.streamingReasoning.some(
          (entry) =>
            entry.type === "memory_recall" && entry.id === action.entry.id
        )
      ) {
        return { ...state, streamingMode: "reasoning", streamingStatus: null }
      }
      return {
        ...state,
        streamingReasoning: [...state.streamingReasoning, action.entry],
        streamingMode: "reasoning",
        streamingStatus: null,
      }
    case "ADD_STREAMING_STEERED_MESSAGE":
      if (
        state.streamingReasoning.some(
          (entry) =>
            entry.type === "steered_message" && entry.id === action.entry.id
        )
      ) {
        return { ...state, streamingMode: "reasoning", streamingStatus: null }
      }
      return {
        ...state,
        streamingReasoning: [...state.streamingReasoning, action.entry],
        streamingMode: "reasoning",
        streamingStatus: null,
      }
    case "UPSERT_PENDING_FOLLOWUP":
      return {
        ...state,
        pendingFollowUps: upsertPendingFollowUp(
          state.pendingFollowUps,
          action.conversationId,
          action.followUp
        ),
      }
    case "SYNC_PENDING_FOLLOWUPS": {
      const transient = (state.pendingFollowUps[action.conversationId] ?? []).filter(
        (entry) => entry.status === "submitting" || entry.status === "claimed"
      )
      const byUserMessageId = new Map<string, PendingChatFollowUp>()
      for (const entry of transient) byUserMessageId.set(entry.userMessageId, entry)
      for (const entry of action.followUps) {
        if (entry.source !== "user") continue
        if (byUserMessageId.get(entry.userMessageId)?.status === "claimed") {
          continue
        }
        byUserMessageId.set(entry.userMessageId, {
          ...entry,
          status: "queued",
        })
      }
      const nextQueue = [...byUserMessageId.values()].sort(
        (a, b) => a.queuedAt - b.queuedAt
      )
      const pendingFollowUps = { ...state.pendingFollowUps }
      if (nextQueue.length > 0) pendingFollowUps[action.conversationId] = nextQueue
      else delete pendingFollowUps[action.conversationId]
      return { ...state, pendingFollowUps }
    }
    case "SET_PENDING_FOLLOWUP_STATUS": {
      const queue = state.pendingFollowUps[action.conversationId]
      if (!queue) return state
      let changed = false
      const nextQueue = queue.map((entry) => {
        if (
          entry.userMessageId !== action.userMessageId ||
          entry.status === action.status
        ) {
          return entry
        }
        changed = true
        return { ...entry, status: action.status }
      })
      if (!changed) return state
      return {
        ...state,
        pendingFollowUps: {
          ...state.pendingFollowUps,
          [action.conversationId]: nextQueue,
        },
      }
    }
    case "REMOVE_PENDING_FOLLOWUP":
      return {
        ...state,
        pendingFollowUps: removePendingFollowUp(
          state.pendingFollowUps,
          action.conversationId,
          action.userMessageId
        ),
      }
    case "SETTLE_FIRST_CLAIMED_FOLLOWUP":
      return {
        ...state,
        pendingFollowUps: settleFirstClaimedFollowUp(
          state.pendingFollowUps,
          action.conversationId
        ),
      }
    case "CLEAR_STEER_PENDING": {
      const pendingFollowUps = { ...state.pendingFollowUps }
      delete pendingFollowUps[action.conversationId]
      return {
        ...state,
        pendingFollowUps,
        conversations: state.conversations.map((conv) =>
          conv.id === action.conversationId &&
          conv.messages.some((m) => m.steerPending)
            ? {
                ...conv,
                messages: conv.messages.map((m) =>
                  m.steerPending ? { ...m, steerPending: undefined } : m
                ),
              }
            : conv
        ),
      }
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
    case "SET_CONVERSATION_TITLE":
      return {
        ...state,
        conversations: state.conversations.map((conv) =>
          conv.id === action.conversationId
            ? { ...conv, title: action.title }
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
        pendingFollowUps:
          action.message.status === "ok" ||
          action.message.status === "error" ||
          action.message.status === "aborted" ||
          typeof action.message.thinkingDuration === "number"
            ? settleFirstClaimedFollowUp(
                state.pendingFollowUps,
                action.conversationId
              )
            : state.pendingFollowUps,
        conversations: sortConversationsByActivity(
          state.conversations.map((conv) => {
            if (conv.id !== action.conversationId) return conv

            const messages = mergeMessagesById(conv.messages, [action.message])
            const resolvedMessage =
              messages.find((message) => message.id === action.message.id) ??
              action.message

            return {
              ...conv,
              updatedAt: Math.max(conv.updatedAt ?? 0, resolvedMessage.timestamp),
              messageCount:
                (conv.messageCount ?? conv.messages.length) +
                (conv.messages.some((m) => m.id === action.message.id) ? 0 : 1),
              lastMessagePreview: resolvedMessage.content,
              lastMessageAt: Math.max(
                conv.lastMessageAt ?? 0,
                resolvedMessage.timestamp
              ),
              messages,
            }
          })
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

      // Stamp the stop moment as the message timestamp — the server's terminal
      // persist does the same, so the row a refresh loads matches this one.
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
            durationMs:
              existingAssistantMessage?.durationMs ??
              (stream?.startedAt != null
                ? Math.max(0, action.timestamp - stream.startedAt)
                : undefined),
            timestamp: action.timestamp,
          }
        : {
            ...existingAssistantMessage!,
            status: "aborted",
            reasoning: stoppedExistingReasoning,
            thinkingDuration: existingAssistantMessage!.thinkingDuration ?? 0,
            timestamp: action.timestamp,
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
