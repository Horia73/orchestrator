"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import type {
  AgentCallReasoningEntry,
  Attachment,
  ContextCompactionReasoningEntry,
  ContextUsageSnapshot,
  Conversation,
  MemoryRecallReasoningEntry,
  Message,
  ToolStreamDelta,
} from "@/lib/types"
import {
  appendBoundedToolDelta,
  sanitizeReasoningForPersistence,
} from "@/lib/ai/reasoning-limits"
import { generateId, generateTitle } from "@/lib/utils-chat"
import { VIEW_FADE_MS } from "@/lib/view-fade"
import {
  addConversationMessageRequest,
  createConversationRequest,
  deleteConversationRequest,
  fetchActiveChatStream,
  fetchActiveChatStreams,
  fetchConversationMessageDetails,
  fetchConversationMessagePage,
  fetchConversationSummaries,
  requestConversationTitle,
  startChatStreamRequest,
  stopChatStream,
  updateConversationArchiveState,
  updateConversationReadState,
  uploadChatAttachments,
} from "./chat-store-api"
import { chatReducer, type ChatState } from "./chat-store-reducer"
import { publishLocalSubmitAnchor } from "@/lib/chat-local-submit-anchor"
import {
  ChatFetchError,
  CLIENT_MAX_MESSAGE_PAGE_SIZE,
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
  readUnreadConversationIds,
  showChatCompletionNotification,
  sleep,
  stoppedStreamState,
  unreadSetsEqual,
  writeUnreadConversationIds,
  type ActiveChatStream,
  type ConversationLoadState,
  type StreamingStatus,
  type StreamingReasoning,
} from "./chat-store-utils"

export interface SendMessageOptions {
  promptContext?: string
  activateIntegrations?: string[]
  activateConversation?: boolean
}

// 12 × 200 ≈ 2400 messages of reach for a deep-link jump target — covers
// virtually every real conversation; deeper targets degrade to "not found".
const MAX_LOAD_UNTIL_PRESENT_FETCHES = 12

// Terminal stream events (done/stopped/error) carry the server-persisted
// message so local state ends up exactly what a refresh would load from the
// DB — same timestamp, durationMs, sanitized reasoning, and error text.
// Returns null when the payload is missing or malformed; callers fall back
// to the locally-accumulated message.
function assistantMessageFromStreamEvent(
  value: unknown,
  expectedId: string
): Message | null {
  if (!value || typeof value !== "object") return null
  const message = value as Message
  if (
    message.id !== expectedId ||
    message.role !== "assistant" ||
    typeof message.content !== "string" ||
    typeof message.timestamp !== "number"
  )
    return null
  return message
}

interface ChatContextType {
  state: ChatState
  unreadConversationIds: Set<string>
  // True while the SELECT_CONVERSATION dispatch is queued at transition
  // priority — i.e. React is still preparing the new chat's render in the
  // background and the committed UI is still showing the previous chat.
  // page.tsx uses this to fade the committed view while the next one prepares.
  isSwitchingConversation: boolean
  // True from the moment a chat↔chat / chat↔home switch is requested on the
  // chat route until the new view is committed. The store holds the actual
  // SELECT_CONVERSATION / NEW_CHAT dispatch for one fade length so the
  // departing conversation fades out over its own content — page.tsx keeps the
  // shell hidden while this is set, then fades the arriving view in.
  pendingViewSwitch: boolean
  newChat: () => void
  selectConversation: (id: string, conversation?: Conversation) => void
  prefetchConversationMessages: (id: string) => Promise<void>
  loadMessageDetails: (conversationId: string, messageId: string) => Promise<void>
  loadOlderMessages: (id: string) => Promise<void>
  /** Page older messages until `messageId` is loaded (or a cap is hit), so a
   *  deep-link can scroll to a message beyond the initial page. Resolves true
   *  if the message is now loaded. */
  loadMessagesUntilPresent: (
    conversationId: string,
    messageId: string,
    opts?: { maxFetches?: number }
  ) => Promise<boolean>
  archiveConversation: (id: string) => void
  unarchiveConversation: (id: string, conversation?: Conversation) => void
  deleteConversation: (id: string) => void
  sendMessage: (
    content: string,
    files?: File[],
    uploadedAttachments?: import("@/lib/types").Attachment[],
    options?: SendMessageOptions
  ) => void
  sendMessageToConversation: (
    conversationId: string | null,
    content: string,
    files?: File[],
    uploadedAttachments?: import("@/lib/types").Attachment[],
    options?: SendMessageOptions
  ) => Promise<string | null>
  stopStreaming: () => void
}

const ChatContext = React.createContext<ChatContextType | null>(null)

// pendingSwitchTarget sentinel for a switch to the home (new chat) view.
const HOME_SWITCH_TARGET = "__home__"

export function ChatStoreProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
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
  const unreadConversationIdsRef = React.useRef<Set<string>>(
    unreadConversationIds
  )
  // Wrap the SELECT_CONVERSATION dispatch in a transition so React can
  // prepare the (potentially expensive) new chat render in the background
  // without blocking. The boolean flips true the instant the user clicks,
  // and clears once the new render commits.
  const [isSwitchingConversation, startSwitchTransition] = React.useTransition()
  // Target of an in-flight view switch on the chat route (conversation id, or
  // HOME_SWITCH_TARGET for "new chat"). Set urgently on click so the page
  // starts fading out immediately, while the store dispatch that actually
  // swaps the rendered conversation is held for VIEW_FADE_MS — otherwise a
  // fast-loading chat commits mid-fade-out and visibly replaces the old one
  // before the fade has finished. Cleared once the swap commits.
  const [pendingSwitchTarget, setPendingSwitchTarget] = React.useState<
    string | null
  >(null)
  const pendingSwitchTimeoutRef = React.useRef<number | null>(null)

  const abortControllerRef = React.useRef<AbortController | null>(null)
  // Start timestamp for the live "Thinking (Ns)" counter. Elapsed seconds are
  // derived from this on every tick AND on tab refocus, so backgrounding the
  // tab (which throttles/suspends interval timers) or a stream interruption
  // can't leave the counter frozen — it snaps to real elapsed time on return.
  const thinkingStartRef = React.useRef<number | null>(null)
  const streamingRef = React.useRef(false)
  const streamDoneRef = React.useRef(false)
  const clientStreamMessageIdRef = React.useRef<string | null>(null)
  const streamPageWasHiddenRef = React.useRef(false)
  const streamSnapshotRefreshAtRef = React.useRef(0)
  const activeConversationIdRef = React.useRef<string | null>(null)
  const pathnameRef = React.useRef(pathname)
  const conversationsRef = React.useRef<Conversation[]>([])
  const conversationMessagePagesRef = React.useRef(
    state.conversationMessagePages
  )
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
  const messageDetailLoadsRef = React.useRef<Map<string, Promise<void>>>(
    new Map()
  )
  const summaryRefreshPromiseRef = React.useRef<Promise<void> | null>(null)

  React.useEffect(() => {
    activeConversationIdRef.current = state.activeConversationId
  }, [state.activeConversationId])

  React.useEffect(() => {
    pathnameRef.current = pathname
  }, [pathname])

  // Release the view-switch hold once the swap has committed (the new view is
  // in the tree, invisible behind the page's fade gate).
  React.useEffect(() => {
    if (pendingSwitchTarget === null) return
    const arrived =
      pendingSwitchTarget === HOME_SWITCH_TARGET
        ? state.activeConversationId === null
        : state.activeConversationId === pendingSwitchTarget
    if (arrived) setPendingSwitchTarget(null)
  }, [pendingSwitchTarget, state.activeConversationId])

  React.useEffect(() => {
    return () => {
      if (pendingSwitchTimeoutRef.current !== null) {
        window.clearTimeout(pendingSwitchTimeoutRef.current)
        pendingSwitchTimeoutRef.current = null
      }
    }
  }, [])

  React.useEffect(() => {
    conversationsRef.current = state.conversations
  }, [state.conversations])

  // Assigned during render (not in an effect) so layout-effect consumers — the
  // chat view's deep-link jump reads this to seed its older-message paging —
  // see the current page cursors instead of the previous commit's.
  conversationMessagePagesRef.current = state.conversationMessagePages

  React.useEffect(() => {
    unreadConversationIdsRef.current = unreadConversationIds
  }, [unreadConversationIds])

  const getVisibleActiveConversationId = React.useCallback(() => {
    if (typeof document === "undefined") return null
    if (document.visibilityState !== "visible") return null
    if (pathnameRef.current !== "/") return null
    return activeConversationIdRef.current
  }, [])

  React.useEffect(() => {
    if (state.isLoading) return
    const visibleActiveConversationId =
      typeof document !== "undefined" &&
      document.visibilityState === "visible" &&
      pathname === "/"
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
  }, [
    pathname,
    state.activeConversationId,
    state.conversations,
    state.isLoading,
  ])

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

  // Own the live "Thinking (Ns)" seconds counter here rather than via an
  // interval created inside sendMessage. Browsers throttle or fully suspend
  // setInterval in backgrounded tabs, and a stream interruption tears the
  // original ticker down without restarting it on recovery — both leave the
  // counter stuck on return. Deriving elapsed from thinkingStartRef on a 1s
  // tick AND recomputing immediately on visibility/focus keeps it honest: the
  // value snaps to the real elapsed time the instant the tab is refocused.
  React.useEffect(() => {
    if (!state.isStreaming || state.thinkingDone) return
    if (thinkingStartRef.current === null) return

    const sync = () => {
      if (thinkingStartRef.current === null) return
      const elapsed = Math.round(
        (Date.now() - thinkingStartRef.current) / 1000
      )
      dispatch({ type: "SET_THINKING_SECONDS", seconds: elapsed })
    }

    sync()
    const interval = window.setInterval(sync, 1000)
    const onVisible = () => {
      if (document.visibilityState === "visible") sync()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onVisible)
    window.addEventListener("pageshow", onVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onVisible)
      window.removeEventListener("pageshow", onVisible)
    }
  }, [state.isStreaming, state.thinkingDone, state.streamingMessageId])

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
        const visibleActiveConversationId = getVisibleActiveConversationId()
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
    [getVisibleActiveConversationId, updateUnreadConversationIds]
  )

  const applyConversationArchiveState = React.useCallback(
    (id: string, archivedAt: number | null) => {
      dispatch({
        type: "SET_CONVERSATION_ARCHIVE_STATE",
        conversationId: id,
        archivedAt,
      })
      if (archivedAt != null) {
        updateUnreadConversationIds((current) => {
          current.delete(id)
          return current
        })
      }
    },
    [updateUnreadConversationIds]
  )

  const applyConversationTitle = React.useCallback(
    (id: string, title: string) => {
      const clean = title.trim()
      if (!clean) return
      dispatch({ type: "SET_CONVERSATION_TITLE", conversationId: id, title: clean })
    },
    []
  )

  // Ask the Conversation Namer to generate a sidebar title for a freshly
  // created conversation, then animate it in. Best-effort: any failure leaves
  // the instant first-words/filename seed in place. `seed.currentTitle` lets
  // the server refuse to overwrite a title that has since changed.
  const autoNameConversation = React.useCallback(
    (seed: {
      conversationId: string
      currentTitle: string
      userText: string
      attachmentNames: string[]
      assistantText?: string
    }) => {
      void requestConversationTitle(seed.conversationId, {
        userText: seed.userText,
        assistantText: seed.assistantText,
        attachmentNames: seed.attachmentNames,
        currentTitle: seed.currentTitle,
      })
        .then((res) => {
          if (res?.title && res.title !== seed.currentTitle) {
            applyConversationTitle(seed.conversationId, res.title)
          }
        })
        .catch((err) => {
          console.error("Auto-name failed", err)
        })
    },
    [applyConversationTitle]
  )

  const persistConversationReadState = React.useCallback(
    (id: string, read: boolean) => {
      updateConversationReadState(id, read).catch((err) => {
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

  const recoveryStreamingStatus = React.useCallback((): StreamingStatus => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return "offline"
    }
    return "recovering"
  }, [])

  const handleAssistantFinished = React.useCallback(
    (conversationId: string, message: Message) => {
      if (message.status === "aborted") return
      const isVisibleActive =
        getVisibleActiveConversationId() === conversationId

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
    [
      getVisibleActiveConversationId,
      markConversationRead,
      markConversationUnread,
    ]
  )

  React.useEffect(() => {
    const visibleActiveConversationId = getVisibleActiveConversationId()
    if (
      !visibleActiveConversationId ||
      visibleActiveConversationId !== state.activeConversationId
    )
      return
    markConversationRead(visibleActiveConversationId)
  }, [
    getVisibleActiveConversationId,
    markConversationRead,
    pathname,
    state.activeConversationId,
  ])

  React.useEffect(() => {
    const onVisibilityChange = () => {
      const visibleActiveConversationId = getVisibleActiveConversationId()
      if (visibleActiveConversationId)
        markConversationRead(visibleActiveConversationId)
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange)
  }, [getVisibleActiveConversationId, markConversationRead])

  const cleanupStream = React.useCallback(() => {
    streamingRef.current = false
    thinkingStartRef.current = null
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

  // Leaving the chat route (Settings, Watchlist, Monitor, …) hands completion
  // tracking back to the global /api/sync stream. Otherwise this tab keeps
  // streamingRef=true, which gates the sync-driven unread + notification path
  // (the `!streamingRef.current` guard in the SSE handler), so a run that
  // finishes while you're on another page never marks its conversation unread.
  React.useEffect(() => {
    if (pathname === "/") return
    if (!streamingRef.current) return
    detachStreaming()
  }, [pathname, detachStreaming])

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
      stopChatStream(conversationId).catch((err) => {
        console.error(err)
      })
    }
  }, [cleanupStream])

  React.useEffect(() => cleanupStream, [cleanupStream])

  const refreshConversationSummaries = React.useCallback(async () => {
    const data = await fetchConversationSummaries()
    if (Array.isArray(data)) {
      dispatch({
        type: "INIT_CONVERSATIONS",
        conversations: data,
        full: false,
      })
    }
  }, [])

  const reconcileConversationSummaries = React.useCallback(
    (reason: string) => {
      if (summaryRefreshPromiseRef.current) return

      const refresh = refreshConversationSummaries()
        .catch((err) => {
          console.warn(`Failed to refresh conversations ${reason}`, err)
        })
        .finally(() => {
          if (summaryRefreshPromiseRef.current === refresh) {
            summaryRefreshPromiseRef.current = null
          }
        })

      summaryRefreshPromiseRef.current = refresh
    },
    [refreshConversationSummaries]
  )

  const reconcileUnknownConversation = React.useCallback(
    (conversationId: unknown, reason: string) => {
      if (typeof conversationId !== "string" || !conversationId) return
      const known = conversationsRef.current.some(
        (conversation) => conversation.id === conversationId
      )
      if (!known) reconcileConversationSummaries(reason)
    },
    [reconcileConversationSummaries]
  )

  // --- Fetch conversations on mount ---
  // Retries on transient network failures — the most common one is the Next
  // dev server briefly unavailable during HMR. Without the retry, every
  // file save would surface a "Failed to fetch" error in the dev console
  // even though the conversations would load fine on the next attempt.
  React.useEffect(() => {
    if (pathname?.startsWith("/profiles")) {
      dispatch({ type: "INIT_CONVERSATIONS", conversations: [] })
      return
    }
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
  }, [pathname, refreshConversationSummaries])

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
          const page = await fetchConversationMessagePage(
            conversationId,
            INITIAL_MESSAGE_PAGE_SIZE,
            undefined,
            "full"
          )
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

  const loadMessageDetails = React.useCallback(
    async (conversationId: string, messageId: string) => {
      const conversation = conversationsRef.current.find(
        (item) => item.id === conversationId
      )
      const message = conversation?.messages.find(
        (item) => item.id === messageId
      )
      if (message && !message.deferred) return

      const key = `${conversationId}:${messageId}`
      const existingLoad = messageDetailLoadsRef.current.get(key)
      if (existingLoad) return existingLoad

      const load = (async () => {
        const fullMessage = await fetchConversationMessageDetails(
          conversationId,
          messageId
        )
        dispatch({
          type: "MERGE_MESSAGE_DETAILS",
          conversationId,
          message: fullMessage,
        })
      })().finally(() => {
        messageDetailLoadsRef.current.delete(key)
      })

      messageDetailLoadsRef.current.set(key, load)
      return load
    },
    []
  )

  const refreshConversationMessages = React.useCallback(
    async (conversationId: string): Promise<Message[]> => {
      const page = await fetchConversationMessagePage(
        conversationId,
        INITIAL_MESSAGE_PAGE_SIZE
      )
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
    if (pathname?.startsWith("/profiles")) return
    const conversationId = state.activeConversationId
    if (!conversationId) return
    void loadInitialMessages(conversationId)
  }, [loadInitialMessages, pathname, state.activeConversationId])

  const checkServerStreaming = React.useCallback(
    async (conversationId: string): Promise<ActiveChatStream | null> => {
      if (pathname?.startsWith("/profiles")) return null
      return fetchActiveChatStream(conversationId)
    },
    [pathname]
  )

  const hydrateStreamMessage = React.useCallback(
    async (
      conversationId: string,
      message: Message | null,
      messageId?: string | null
    ): Promise<Message | null> => {
      const targetId = message?.id ?? messageId
      if (!targetId || targetId === "unknown") return message

      const needsDetails = Boolean(
        !message ||
          message.deferred?.reasoning ||
          message.deferred?.contentSegments ||
          message.deferred?.toolCalls
      )
      if (!needsDetails) return message

      try {
        return await fetchConversationMessageDetails(conversationId, targetId)
      } catch {
        return message
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
        dispatch({
          type: "SET_STREAMING",
          isStreaming: true,
          conversationId,
          messageId: messageId ?? undefined,
          status: recoveryStreamingStatus(),
        })
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

        if (activeStream) {
          // Keep the live thinking counter alive through recovery. A refocus
          // after a long absence often interrupts the original stream and its
          // ticker, so re-anchor elapsed time to the server's stream start;
          // the counter effect resumes ticking the moment streaming is set.
          thinkingStartRef.current = activeStream.startedAt
          const activeMessage =
            (activeStream.messageId
              ? messages.find((message) => message.id === activeStream.messageId)
              : null) ??
            recoveredMessage ??
            null
          const snapshot = await hydrateStreamMessage(
            conversationId,
            activeMessage,
            activeStream.messageId
          )
          if (snapshot) {
            dispatch({
              type: "ADD_ASSISTANT_MESSAGE",
              conversationId,
              message: snapshot,
              stopStreaming: false,
            })
            dispatch({
              type: "SET_STREAMING",
              isStreaming: true,
              conversationId,
              messageId: activeStream.messageId,
              snapshot,
              status: "recovering",
            })
            dispatch({ type: "CHAT_STREAM_STARTED", stream: activeStream })
            return "running"
          }

          dispatch({
            type: "SET_STREAMING",
            isStreaming: true,
            conversationId,
            messageId: activeStream.messageId,
            status: recoveryStreamingStatus(),
          })
          dispatch({ type: "CHAT_STREAM_STARTED", stream: activeStream })
          return "running"
        }

        if (recoveredMessage) {
          const hydratedMessage =
            (await hydrateStreamMessage(
              conversationId,
              recoveredMessage,
              messageId
            )) ?? recoveredMessage

          if (isTerminalAssistantMessage(hydratedMessage)) {
            dispatch({
              type: "ADD_ASSISTANT_MESSAGE",
              conversationId,
              message: hydratedMessage,
            })
            handleAssistantFinished(conversationId, hydratedMessage)
            return "final"
          }

          const hasProgress =
            hydratedMessage.content.trim().length > 0 ||
            (hydratedMessage.reasoning?.length ?? 0) > 0 ||
            hydratedMessage.contentSegments?.some(
              (segment) => segment.content.length > 0
            )
          if (attempt === STREAM_RECOVERY_ATTEMPTS - 1 && hasProgress) {
            const abortedMessage: Message = {
              ...hydratedMessage,
              status: "aborted",
              reasoning: markReasoningStopped(
                hydratedMessage.reasoning,
                Date.now()
              ),
              thinkingDuration: hydratedMessage.thinkingDuration ?? 0,
            }
            dispatch({
              type: "ADD_ASSISTANT_MESSAGE",
              conversationId,
              message: abortedMessage,
            })
            addConversationMessageRequest(conversationId, abortedMessage).catch(
              console.error
            )
            return "final"
          }
        }

        if (attempt < STREAM_RECOVERY_ATTEMPTS - 1) {
          await sleep(STREAM_RECOVERY_DELAY_MS)
        }
      }

      return null
    },
    [
      checkServerStreaming,
      handleAssistantFinished,
      hydrateStreamMessage,
      recoveryStreamingStatus,
      refreshConversationMessages,
    ]
  )

  const refreshActiveChatStreams = React.useCallback(async (): Promise<
    ActiveChatStream[]
  > => {
    if (pathname?.startsWith("/profiles")) {
      dispatch({ type: "SET_ACTIVE_CHAT_STREAMS", streams: [] })
      return []
    }
    const streams = await fetchActiveChatStreams()
    dispatch({ type: "SET_ACTIVE_CHAT_STREAMS", streams })
    return streams
  }, [pathname])

  React.useEffect(() => {
    if (pathname?.startsWith("/profiles")) {
      dispatch({ type: "SET_ACTIVE_CHAT_STREAMS", streams: [] })
      return
    }
    void refreshActiveChatStreams()
    const interval = window.setInterval(refreshActiveChatStreams, 5000)
    return () => window.clearInterval(interval)
  }, [pathname, refreshActiveChatStreams])

  React.useEffect(() => {
    if (pathname?.startsWith("/profiles")) return
    let sequence = 0

    const reconcileAfterResume = () => {
      if (document.visibilityState !== "visible") return
      const conversationId = activeConversationIdRef.current
      if (!conversationId) return
      if (streamingRef.current) return

      const knownStream = activeChatStreamsRef.current[conversationId]
      const wasHiddenDuringStream = streamPageWasHiddenRef.current
      if (!knownStream && !isStreamingStateRef.current && !wasHiddenDuringStream)
        return

      const currentSequence = ++sequence
      void (async () => {
        const streams = await refreshActiveChatStreams()
        if (currentSequence !== sequence) return
        const stream =
          streams.find((item) => item.conversationId === conversationId) ??
          activeChatStreamsRef.current[conversationId]
        await recoverInterruptedStream(conversationId, stream?.messageId)
        if (currentSequence === sequence) {
          streamPageWasHiddenRef.current = false
        }
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
  }, [pathname, recoverInterruptedStream, refreshActiveChatStreams])

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
      if (stream) {
        void recoverInterruptedStream(conversationId, stream.messageId)
      } else {
        dispatch({
          type: "SET_STREAMING",
          isStreaming: false,
          conversationId,
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, [checkServerStreaming, recoverInterruptedStream, state.activeConversationId])

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
    const hasStreamingPayload =
      state.streamingContent.length > 0 ||
      state.streamingContentSegments.some(
        (segment) => segment.content.length > 0
      ) ||
      state.streamingReasoning.length > 0
    const tick = () => {
      checkServerStreaming(conversationId).then((stream) => {
        if (
          cancelled ||
          activeConversationIdRef.current !== conversationId ||
          streamingRef.current
        )
          return
        if (stream) {
          const now = Date.now()
          const shouldRefreshSnapshot =
            !hasStreamingPayload ||
            stream.messageId !== streamMessageId ||
            now - streamSnapshotRefreshAtRef.current > 2500
          if (shouldRefreshSnapshot && !recovering) {
            recovering = true
            streamSnapshotRefreshAtRef.current = now
            void recoverInterruptedStream(conversationId, stream.messageId)
              .finally(() => {
                recovering = false
              })
          } else {
            dispatch({
              type: "SET_STREAMING",
              isStreaming: true,
              conversationId,
              messageId: stream.messageId,
              status: hasStreamingPayload ? undefined : recoveryStreamingStatus(),
            })
            dispatch({ type: "CHAT_STREAM_STARTED", stream })
          }
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
    recoveryStreamingStatus,
    state.activeConversationId,
    state.isStreaming,
    state.streamingContent,
    state.streamingContentSegments,
    state.streamingConversationId,
    state.streamingMessageId,
    state.streamingReasoning,
  ])

  // --- SSE LIVE SYNC ---
  React.useEffect(() => {
    if (pathname?.startsWith("/profiles")) return
    const eventSource = new EventSource("/api/sync")

    eventSource.onopen = () => {
      reconcileConversationSummaries("after chat sync reconnect")
    }

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
              archivedAt: data.payload.archivedAt ?? null,
            },
          })
        } else if (data.type === "add_message") {
          const msg = data.payload.message
          reconcileUnknownConversation(
            data.payload.conversationId,
            "after message for unknown conversation"
          )
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
                  status: recoveryStreamingStatus(),
                })
              }
            }
          }
        } else if (data.type === "context_usage") {
          reconcileUnknownConversation(
            data.payload?.conversationId,
            "after context update for unknown conversation"
          )
          if (data.payload?.conversationId && data.payload?.contextUsage) {
            dispatch({
              type: "UPDATE_CONTEXT_USAGE",
              conversationId: data.payload.conversationId,
              contextUsage: data.payload.contextUsage,
            })
          }
        } else if (data.type === "conversation_read_state") {
          reconcileUnknownConversation(
            data.payload?.conversationId,
            "after read-state update for unknown conversation"
          )
          if (typeof data.payload?.conversationId === "string") {
            applyConversationReadState(
              data.payload.conversationId,
              typeof data.payload.readAt === "number"
                ? data.payload.readAt
                : null
            )
          }
        } else if (data.type === "conversation_archive_state") {
          reconcileUnknownConversation(
            data.payload?.conversationId,
            "after archive-state update for unknown conversation"
          )
          if (typeof data.payload?.conversationId === "string") {
            applyConversationArchiveState(
              data.payload.conversationId,
              typeof data.payload.archivedAt === "number"
                ? data.payload.archivedAt
                : null
            )
            reconcileConversationSummaries("after archive-state update")
          }
        } else if (data.type === "conversation_title") {
          reconcileUnknownConversation(
            data.payload?.conversationId,
            "after title update for unknown conversation"
          )
          if (
            typeof data.payload?.conversationId === "string" &&
            typeof data.payload?.title === "string"
          ) {
            applyConversationTitle(
              data.payload.conversationId,
              data.payload.title
            )
          }
        } else if (data.type === "delete_conversation") {
          dispatch({ type: "DELETE_CONVERSATION", id: data.payload.id })
        } else if (data.type === "chat_stream_started") {
          reconcileUnknownConversation(
            data.payload.conversationId,
            "after stream start for unknown conversation"
          )
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
          reconcileConversationSummaries("after stream end")
          if (
            document.visibilityState === "visible" &&
            data.payload.conversationId === activeConversationIdRef.current &&
            !streamingRef.current
          ) {
            void recoverInterruptedStream(
              data.payload.conversationId,
              typeof data.payload.messageId === "string"
                ? data.payload.messageId
                : undefined
            )
          }
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
  }, [
    pathname,
    applyConversationReadState,
    applyConversationArchiveState,
    applyConversationTitle,
    handleAssistantFinished,
    recoveryStreamingStatus,
    reconcileConversationSummaries,
    reconcileUnknownConversation,
    recoverInterruptedStream,
  ])

  const newChat = React.useCallback(() => {
    detachStreaming()
    const focusInput = () => {
      if (typeof window === "undefined") return
      setTimeout(
        () => window.dispatchEvent(new CustomEvent("chat-input-focus")),
        0
      )
    }
    if (pendingSwitchTimeoutRef.current !== null) {
      window.clearTimeout(pendingSwitchTimeoutRef.current)
      pendingSwitchTimeoutRef.current = null
    }
    // On the chat route with a conversation open, hold the swap for one fade
    // so the departing chat fades out over its own content (see
    // selectConversation). Elsewhere (maps/workout panels preparing a blank
    // chat) there is no fading shell — swap immediately.
    if (
      pathnameRef.current === "/" &&
      activeConversationIdRef.current !== null
    ) {
      activeConversationIdRef.current = null
      setPendingSwitchTarget(HOME_SWITCH_TARGET)
      pendingSwitchTimeoutRef.current = window.setTimeout(() => {
        pendingSwitchTimeoutRef.current = null
        dispatch({ type: "NEW_CHAT" })
        focusInput()
      }, VIEW_FADE_MS)
      return
    }
    dispatch({ type: "NEW_CHAT" })
    focusInput()
  }, [detachStreaming])

  const selectConversation = React.useCallback(
    (id: string, conversation?: Conversation) => {
      // Re-clicking the active chat would otherwise schedule a no-op
      // transition and fade the current view for one frame.
      if (activeConversationIdRef.current === id) return
      if (
        conversation &&
        !conversationsRef.current.some((item) => item.id === id)
      ) {
        dispatch({
          type: "ADD_SYNCED_CONVERSATION",
          conversation,
          full: false,
        })
      }
      // Claim the target conversation synchronously. SELECT_CONVERSATION below
      // is dispatched inside a transition, so state.activeConversationId (and
      // the effect that syncs this ref to it) only settles on a later commit.
      // detachStreaming() fires an urgent SET_STREAMING dispatch that re-renders
      // before then; without this, a deep-link caller like the `?chat=` effect
      // in page.tsx re-runs and calls selectConversation again with a still-stale
      // ref, defeating the guard above and spinning into "Maximum update depth
      // exceeded". Setting the ref now makes that re-entry return early.
      activeConversationIdRef.current = id
      detachStreaming()
      markConversationRead(id)
      void loadInitialMessages(id)
      if (pendingSwitchTimeoutRef.current !== null) {
        window.clearTimeout(pendingSwitchTimeoutRef.current)
        pendingSwitchTimeoutRef.current = null
      }
      const dispatchSelect = () => {
        startSwitchTransition(() => {
          dispatch({ type: "SELECT_CONVERSATION", id })
        })
      }
      // On the chat route, the page fades the current view out the moment
      // pendingSwitchTarget is set. Hold the swap dispatch for that fade
      // length: committing earlier replaces the departing chat's content
      // mid-fade-out (a fast load visibly flashes the new chat before the
      // animation), while messages keep loading in parallel above. Off the
      // chat route (maps/workout panels, inbox → chat) there is no fading
      // shell over this store — swap immediately.
      if (pathnameRef.current === "/") {
        setPendingSwitchTarget(id)
        pendingSwitchTimeoutRef.current = window.setTimeout(() => {
          pendingSwitchTimeoutRef.current = null
          dispatchSelect()
        }, VIEW_FADE_MS)
        return
      }
      dispatchSelect()
    },
    [detachStreaming, loadInitialMessages, markConversationRead]
  )

  const loadOlderMessages = React.useCallback(
    async (id: string) => {
      const page = state.conversationMessagePages[id]
      if (!page?.hasMore || page.isLoadingOlder || !page.nextCursor) return

      dispatch({ type: "LOAD_OLDER_MESSAGES_START", id })
      try {
        const nextPage = await fetchConversationMessagePage(
          id,
          OLDER_MESSAGE_PAGE_SIZE,
          page.nextCursor
        )
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

  // Page older messages (largest page size, fewest round-trips) until the
  // target message is loaded. Loops on a LOCAL cursor seeded once from the
  // current page state — React state is stale within the synchronous loop, so
  // we advance the cursor from each fetch response instead. Reuses the same
  // LOAD_OLDER_MESSAGES_* / LOAD_MESSAGE_PAGE_SUCCESS actions as
  // loadOlderMessages so isLoadingOlder stays coherent (the merge-by-id reducer
  // makes "prepend" pages safe). Bounded so a very deep target degrades to a
  // graceful "not found" rather than an unbounded fetch storm.
  const loadMessagesUntilPresent = React.useCallback(
    async (
      conversationId: string,
      messageId: string,
      opts?: { maxFetches?: number }
    ): Promise<boolean> => {
      const maxFetches = opts?.maxFetches ?? MAX_LOAD_UNTIL_PRESENT_FETCHES
      const alreadyLoaded = conversationsRef.current
        .find((c) => c.id === conversationId)
        ?.messages.some((m) => m.id === messageId)
      if (alreadyLoaded) return true

      const page = conversationMessagePagesRef.current[conversationId]
      let cursor = page?.nextCursor ?? null
      let hasMore = page?.hasMore ?? false
      if (!hasMore || !cursor) return false

      for (let i = 0; i < maxFetches && hasMore && cursor; i++) {
        if (activeConversationIdRef.current !== conversationId) return false
        dispatch({ type: "LOAD_OLDER_MESSAGES_START", id: conversationId })
        let nextPage
        try {
          nextPage = await fetchConversationMessagePage(
            conversationId,
            CLIENT_MAX_MESSAGE_PAGE_SIZE,
            cursor
          )
        } catch (err) {
          dispatch({
            type: "LOAD_OLDER_MESSAGES_ERROR",
            id: conversationId,
            error:
              err instanceof Error ? err.message : "Failed to load history",
          })
          return false
        }
        dispatch({
          type: "LOAD_MESSAGE_PAGE_SUCCESS",
          id: conversationId,
          messages: nextPage.messages,
          total: nextPage.total,
          hasMore: nextPage.hasMore,
          nextCursor: nextPage.nextCursor,
          mode: "prepend",
        })
        cursor = nextPage.nextCursor
        hasMore = nextPage.hasMore
        if (nextPage.messages.some((m) => m.id === messageId)) return true
      }
      return false
    },
    []
  )

  const deleteConversation = React.useCallback(
    (id: string) => {
      if (activeConversationIdRef.current === id) {
        stopStreaming()
      } else if (activeChatStreamsRef.current[id]) {
        stopChatStream(id).catch((err) => {
          console.error(err)
        })
      }
      deleteConversationRequest(id).catch(console.error)
      clearConversationUnread(id)
      dispatch({ type: "DELETE_CONVERSATION", id })
    },
    [clearConversationUnread, stopStreaming]
  )

  const archiveConversation = React.useCallback(
    (id: string) => {
      const archivedAt = Date.now()
      if (activeConversationIdRef.current === id) {
        detachStreaming()
      }
      updateConversationArchiveState(id, true).catch((err) => {
        console.error(err)
      })
      clearConversationUnread(id)
      applyConversationArchiveState(id, archivedAt)
    },
    [applyConversationArchiveState, clearConversationUnread, detachStreaming]
  )

  const unarchiveConversation = React.useCallback(
    (id: string, conversation?: Conversation) => {
      if (
        conversation &&
        !conversationsRef.current.some((item) => item.id === id)
      ) {
        dispatch({
          type: "ADD_SYNCED_CONVERSATION",
          conversation: { ...conversation, archivedAt: null },
          full: false,
        })
      }
      updateConversationArchiveState(id, false).catch((err) => {
        console.error(err)
      })
      applyConversationArchiveState(id, null)
    },
    [applyConversationArchiveState]
  )

  const sendMessageToConversation = React.useCallback(
    async (
      targetConversationId: string | null,
      content: string,
      files?: File[],
      uploadedAttachments?: import("@/lib/types").Attachment[],
      options?: SendMessageOptions
    ): Promise<string | null> => {
      if (streamingRef.current) return null

      // Use pre-uploaded attachments or upload new files
      let attachments: import("@/lib/types").Attachment[] | undefined =
        uploadedAttachments
      if (!attachments && files?.length) {
        try {
          attachments = await uploadChatAttachments(files)
        } catch (e) {
          console.error("File upload failed:", e)
        }
      }

      const finalAttachments = attachments?.length ? attachments : undefined
      if (!content.trim() && !finalAttachments?.length) return null

      const userMessage: Message = {
        id: generateId(),
        role: "user",
        content,
        attachments: finalAttachments,
        timestamp: Date.now(),
      }

      let conversationId = targetConversationId
      let allMessages: Message[]

      if (!conversationId) {
        conversationId = generateId()
        const createdAt = Date.now()
        const seedTitle = generateTitle(content, finalAttachments)
        const newConv: Conversation = {
          id: conversationId,
          title: seedTitle,
          messages: [userMessage],
          createdAt,
          updatedAt: userMessage.timestamp,
          messageCount: 1,
          lastMessagePreview: userMessage.content,
          lastMessageAt: userMessage.timestamp,
          readAt: userMessage.timestamp,
        }
        const createPromise = createConversationRequest(newConv).catch(
          console.error
        )

        dispatch({
          type: "CREATE_CONVERSATION",
          conversation: newConv,
          activate: options?.activateConversation !== false,
        })
        allMessages = [userMessage]

        // Auto-name text-started conversations immediately and in parallel with
        // the model turn. Attachment-only starts are named server-side after
        // the first assistant reply, so stream recovery cannot lose the title.
        const attachmentNames = (finalAttachments ?? [])
          .map((att) => att.filename)
          .filter((name): name is string => Boolean(name && name.trim()))
        const nameSeed = {
          conversationId,
          currentTitle: seedTitle,
          userText: content,
          attachmentNames,
        }
        if (content.trim()) {
          // Wait for the create round-trip so the row exists when the title
          // endpoint reads it and applies its overwrite guard.
          void createPromise.then(() => autoNameConversation(nameSeed))
        }
      } else {
        addConversationMessageRequest(conversationId, userMessage).catch(
          console.error
        )

        dispatch({
          type: "ADD_USER_MESSAGE",
          conversationId,
          message: userMessage,
        })
        markConversationRead(conversationId)

        // Build messages array from current state + new user message.
        // startChatStreamRequest keeps this full payload unless it nears the
        // platform request-size limit, where it strips only UI-only metadata.
        const conv = state.conversations.find((c) => c.id === conversationId)
        allMessages = [...(conv?.messages ?? []), userMessage]
      }

      if (options?.activateConversation !== false) {
        publishLocalSubmitAnchor({
          conversationId,
          messageId: userMessage.id,
          submittedAt: userMessage.timestamp,
        })
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
        status: "connecting",
      })

      // Seed the live thinking counter; the dedicated effect drives the ticks
      // and keeps it correct across tab backgrounding and stream recovery.
      thinkingStartRef.current = Date.now()

      const finalConvId = conversationId
      dispatch({
        type: "CHAT_STREAM_STARTED",
        stream: {
          conversationId: finalConvId,
          messageId: assistantMsgId,
          startedAt: Date.now(),
        },
      })

      // Pass the full local conversation for normal turns; the request helper
      // falls back to a provider-relevant slim shape only near size limits.
      startChatStreamRequest({
        conversationId: finalConvId,
        messageId: assistantMsgId,
        messages: allMessages,
        promptContext: options?.promptContext,
        activateIntegrations: options?.activateIntegrations,
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

          // Server accepted the stream — we're connected. Clear the
          // "connecting" status now (rather than waiting for the first token)
          // so the bottom pill reflects connection, not the model's latency.
          dispatch({
            type: "SET_STREAMING",
            isStreaming: true,
            conversationId: finalConvId,
            messageId: assistantMsgId,
            status: null,
          })

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
          const appendLocalAgentThinking = (
            runId: string,
            chunk: string,
            phase?: number
          ) => {
            const entry = findAgent(runId)
            if (!entry || entry.type !== "agent_call") return
            entry.reasoning = appendAgentThought(entry, chunk, phase).reasoning
          }
          const appendLocalAgentContent = (
            runId: string,
            chunk: string,
            phase?: number
          ) => {
            const entry = findAgent(runId)
            if (!entry || entry.type !== "agent_call") return
            const updated = appendAgentContent(entry, chunk, phase)
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
                  thinkingStartRef.current = null
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
                      entry.deltas = appendBoundedToolDelta(
                        entry.deltas,
                        delta
                      )
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
                  const phase =
                    typeof data.phase === "number" ? data.phase : undefined
                  if (runId && chunk) {
                    appendLocalAgentThinking(runId, chunk, phase)
                    dispatch({
                      type: "APPEND_STREAMING_AGENT_THINKING",
                      runId,
                      chunk,
                      phase,
                    })
                  }
                } else if (data.type === "agent_content") {
                  const runId = typeof data.runId === "string" ? data.runId : ""
                  const chunk = String(data.content ?? "")
                  const phase =
                    typeof data.phase === "number" ? data.phase : undefined
                  if (runId && chunk) {
                    appendLocalAgentContent(runId, chunk, phase)
                    dispatch({
                      type: "APPEND_STREAMING_AGENT_CONTENT",
                      runId,
                      chunk,
                      phase,
                    })
                  }
                } else if (data.type === "agent_tool_call") {
                  const runId = typeof data.runId === "string" ? data.runId : ""
                  const phase =
                    typeof data.phase === "number" ? data.phase : undefined
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
                            phase:
                              phase ??
                              agent.contentSegments?.at(-1)?.phase ??
                              0,
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
                      phase,
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
                      toolEntry.deltas = appendBoundedToolDelta(
                        toolEntry.deltas,
                        delta
                      )
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
                        agent.reasoning = sanitizeReasoningForPersistence(
                          data.reasoning
                        )
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
                        ? sanitizeReasoningForPersistence(data.reasoning)
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
                } else if (data.type === "memory_recall") {
                  const entry =
                    data.entry && typeof data.entry === "object"
                      ? (data.entry as MemoryRecallReasoningEntry)
                      : null
                  if (
                    entry?.type === "memory_recall" &&
                    typeof entry.id === "string"
                  ) {
                    if (streamMode === "content") {
                      reasoningPhase += 1
                      streamMode = "reasoning"
                    }
                    if (
                      !accReasoning.some(
                        (item) =>
                          item.type === "memory_recall" && item.id === entry.id
                      )
                    ) {
                      accReasoning.push({ ...entry, phase: reasoningPhase })
                    }
                    dispatch({
                      type: "ADD_STREAMING_MEMORY_RECALL",
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
                  if (
                    typeof window !== "undefined" &&
                    typeof data.clientToken === "string"
                  ) {
                    window.dispatchEvent(
                      new CustomEvent("orch:artifact-error", {
                        detail: {
                          clientToken: data.clientToken,
                          message:
                            typeof data.message === "string"
                              ? data.message
                              : undefined,
                        },
                      })
                    )
                  }
                } else if (data.type === "done") {
                  // Stream complete — adopt the server-persisted message so a
                  // refresh shows the exact same state; fall back to the
                  // locally-accumulated payload if the event lacks it.
                  streamDoneRef.current = true
                  if (Array.isArray(data.attachments)) {
                    accAttachments = data.attachments as Attachment[]
                  }
                  const finalMsg: Message = assistantMessageFromStreamEvent(
                    data.message,
                    assistantMsgId
                  ) ?? {
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
                    durationMs:
                      typeof data.durationMs === "number"
                        ? data.durationMs
                        : undefined,
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
                  const finalMsg: Message = assistantMessageFromStreamEvent(
                    data.message,
                    assistantMsgId
                  ) ?? {
                    id: assistantMsgId,
                    role: "assistant",
                    content: accContent,
                    status: "aborted",
                    contentSegments: accContentSegments,
                    reasoning: accReasoning,
                    thinking: accThinking || undefined,
                    thinkingDuration: finalThinkingDuration || 0,
                    durationMs:
                      typeof data.durationMs === "number"
                        ? data.durationMs
                        : undefined,
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
                  // Provider/runtime error mid-stream. The server persists the
                  // message (with the [Error: …] text) and ships it on this
                  // event, so the post-refresh DB load shows the same content.
                  // Mirror it into local state so the user sees the error
                  // immediately — symmetrically with the "stopped" branch.
                  streamDoneRef.current = true
                  const rawError =
                    typeof data.error === "string" && data.error.trim()
                      ? data.error
                      : "The model runtime returned an error."
                  const errorBody =
                    accContent && accContent.trim().length > 0
                      ? `${accContent}\n\n[Error: ${rawError}]`
                      : `[Error: ${rawError}]`
                  const finalMsg: Message = assistantMessageFromStreamEvent(
                    data.message,
                    assistantMsgId
                  ) ?? {
                    id: assistantMsgId,
                    role: "assistant",
                    content: errorBody,
                    status: "error",
                    contentSegments:
                      accContentSegments.length > 0
                        ? accContentSegments
                        : [{ phase: 0, content: errorBody }],
                    reasoning: accReasoning,
                    thinking: accThinking || undefined,
                    thinkingDuration: finalThinkingDuration || 0,
                    durationMs:
                      typeof data.durationMs === "number"
                        ? data.durationMs
                        : undefined,
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
                  console.error("Stream error:", rawError)
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
            dispatch({
              type: "SET_STREAMING",
              isStreaming: true,
              conversationId: finalConvId,
              messageId: assistantMsgId,
              status: recoveryStreamingStatus(),
            })
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
            // The thinking counter is owned by a dedicated effect keyed on
            // state.isStreaming, so it tears its own interval down when
            // streaming ends — and it must NOT be killed here, or a stream
            // that was interrupted and recovered would freeze the counter.
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
      return finalConvId
    },
    [
      autoNameConversation,
      handleAssistantFinished,
      markConversationRead,
      recoverInterruptedStream,
      recoveryStreamingStatus,
      state.conversations,
    ]
  )

  const sendMessage = React.useCallback(
    (
      content: string,
      files?: File[],
      uploadedAttachments?: import("@/lib/types").Attachment[],
      options?: SendMessageOptions
    ) => {
      void sendMessageToConversation(
        state.activeConversationId,
        content,
        files,
        uploadedAttachments,
        {
          ...options,
          activateConversation: true,
        }
      )
    },
    [sendMessageToConversation, state.activeConversationId]
  )

  const value = React.useMemo(
    () => ({
      state,
      unreadConversationIds,
      isSwitchingConversation,
      pendingViewSwitch: pendingSwitchTarget !== null,
      newChat,
      selectConversation,
      prefetchConversationMessages: loadInitialMessages,
      loadMessageDetails,
      loadOlderMessages,
      loadMessagesUntilPresent,
      archiveConversation,
      unarchiveConversation,
      deleteConversation,
      sendMessage,
      sendMessageToConversation,
      stopStreaming,
    }),
    [
      state,
      unreadConversationIds,
      isSwitchingConversation,
      pendingSwitchTarget,
      newChat,
      selectConversation,
      loadInitialMessages,
      loadMessageDetails,
      loadOlderMessages,
      loadMessagesUntilPresent,
      archiveConversation,
      unarchiveConversation,
      deleteConversation,
      sendMessage,
      sendMessageToConversation,
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
