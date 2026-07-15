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
  SteeredMessageReasoningEntry,
  ToolStreamDelta,
} from "@/lib/types"
import { wrapSteeredMessage } from "@/lib/steered-message"
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
  fetchChatRuntimeState,
  fetchActiveChatStreams,
  fetchConversationMessageDetails,
  fetchConversationMessagePage,
  fetchConversationSummaries,
  requestConversationTitle,
  startChatStreamRequest,
  steerChatMessage,
  stopChatStream,
  updateConversationArchiveState,
  updateConversationReadState,
  uploadChatAttachments,
} from "./chat-store-api"
import {
  chatReducer,
  createInitialChatState,
  type ChatState,
} from "./chat-store-reducer"
import { publishLocalSubmitAnchor } from "@/lib/chat-local-submit-anchor"
import {
  ChatFetchError,
  CHAT_SEND_RETRY_ATTEMPTS,
  INITIAL_MESSAGE_FULL_TAIL_SIZE,
  CLIENT_MAX_MESSAGE_PAGE_SIZE,
  INITIAL_MESSAGE_PAGE_SIZE,
  OFFLINE_WAIT_SLICE_MS,
  OLDER_MESSAGE_PAGE_SIZE,
  STREAM_RECOVERY_ATTEMPTS,
  STREAM_RECOVERY_DELAY_MS,
  STREAM_RECOVERY_MAX_DELAY_MS,
  STREAM_RECOVERY_UNREACHABLE_DEADLINE_MS,
  STREAM_RESUME_STALL_MS,
  STREAM_STALL_CHECK_INTERVAL_MS,
  STREAM_STALL_TIMEOUT_MS,
  agentCallEntryFromStartEvent,
  appendAgentContent,
  appendAgentThought,
  chatUpdateRetryDelayMs,
  deriveUnreadConversationIds,
  errorMessageFromUnknown,
  isChatUpdateInProgressResponse,
  isConversationUnread,
  isOwnedAssistantStreamMessage,
  isLikelyStreamInterruption,
  isTerminalAssistantMessage,
  markReasoningStopped,
  postWithRetry,
  readUnreadConversationIds,
  showChatCompletionNotification,
  sleep,
  sleepWithAbortSignal,
  sleepUntilOnline,
  shouldSendAsSteering,
  unreadSetsEqual,
  writeUnreadConversationIds,
  type ActiveChatStream,
  type ConversationLoadState,
  type StreamingStatus,
  type StreamingReasoning,
} from "./chat-store-utils"
import { CHAT_VIEW_SAVE_STATE_EVENT } from "@/lib/chat-view-state"
import { PROFILE_SESSION_CHANGED_EVENT } from "@/lib/profile-session-client"
import { readJsonSseStream } from "./chat-stream-sse"
import {
  completedAssistantMessage,
  erroredAssistantMessage,
  stoppedAssistantMessage,
} from "./chat-stream-messages"
import { handleArtifactStreamEvent } from "./chat-stream-artifacts"

export interface SendMessageOptions {
  promptContext?: string
  promptContextSource?: string
  activateIntegrations?: string[]
  activateConversation?: boolean
  preferredFallbackIndex?: number
  /** Internal: this send drains a queued steering follow-up. The user message
   *  is already persisted (steer endpoint) and already in local state — the
   *  turn reuses it verbatim and claims the queue entry server-side. */
  internalFollowUp?: { followUpId: string; userMessage: Message }
}

// 12 × 200 ≈ 2400 messages of reach for a deep-link jump target — covers
// virtually every real conversation; deeper targets degrade to "not found".
const MAX_LOAD_UNTIL_PRESENT_FETCHES = 12

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
  loadMessageDetails: (
    conversationId: string,
    messageId: string
  ) => Promise<void>
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
  const [state, dispatch] = React.useReducer(chatReducer, undefined, () =>
    createInitialChatState(true)
  )
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
  // Dead-radio detection for the owned chat stream: on a silently dropped
  // mobile connection the fetch reader hangs forever without erroring, and
  // while streamingRef is true every other recovery path is gated off — the
  // "have to restart the app" trap. These track reader liveness so the stall
  // watchdog (and the foreground/online reconciler) can abort a hung reader
  // and hand the turn to recoverInterruptedStream.
  const streamLastActivityRef = React.useRef(0)
  const streamReaderActiveRef = React.useRef(false)
  // True from the start POST until response headers arrive. A dead radio can
  // hang the fetch in this window too (no reader yet, so reader liveness alone
  // would never flag it) — the watchdog treats a long-silent in-flight POST
  // as the same stall.
  const streamPostInFlightRef = React.useRef(false)
  const streamStallRequestedRef = React.useRef(false)
  const steeringGenerationRef = React.useRef(0)
  // Single-flight per conversation: focus/online/poll triggers can all ask
  // for recovery at once; they join the in-flight run instead of stacking
  // loops that re-dispatch streaming state over each other.
  const recoveryInFlightRef = React.useRef<
    Map<string, Promise<"final" | "running" | null>>
  >(new Map())
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
  const streamingConversationIdRef = React.useRef<string | null>(null)
  // Steering follow-ups queued locally while a turn streams; drained one at a
  // time when the in-flight turn settles. Server holds the durable copy — if
  // this client dies mid-run, the server-side sweep runs them headlessly.
  const followUpQueuesRef = React.useRef<
    Map<string, Array<{ followUpId: string; userMessage: Message }>>
  >(new Map())
  const sendMessageToConversationRef = React.useRef<
    | ((
        conversationId: string | null,
        content: string,
        files?: File[],
        uploadedAttachments?: import("@/lib/types").Attachment[],
        options?: SendMessageOptions
      ) => Promise<string | null>)
    | null
  >(null)
  const drainNextFollowUp = React.useCallback((conversationId: string) => {
    if (streamingRef.current || activeChatStreamsRef.current[conversationId]) {
      return
    }
    const queue = followUpQueuesRef.current.get(conversationId)
    if (!queue?.length) return
    const next = queue.shift()!
    if (queue.length === 0) followUpQueuesRef.current.delete(conversationId)
    window.setTimeout(() => {
      void sendMessageToConversationRef.current?.(
        conversationId,
        next.userMessage.content,
        undefined,
        next.userMessage.attachments,
        { internalFollowUp: next, activateConversation: false }
      )
    }, 0)
  }, [])
  const conversationLoadStateRef = React.useRef<
    Record<string, ConversationLoadState>
  >({})
  const profileSessionGenerationRef = React.useRef(0)
  const initialMessageLoadsRef = React.useRef<Map<string, Promise<void>>>(
    new Map()
  )
  // Opening a conversation is stronger than hover-prefetch: it always
  // reconciles the visible tail against the DB, even when the local page is
  // marked "full". Keep those loads separate so an older prefetch cannot make
  // the click join a snapshot captured before the agent finalized.
  const openMessageLoadsRef = React.useRef<Map<string, Promise<void>>>(
    new Map()
  )
  // `selectConversation` starts the authoritative load during the outgoing
  // fade. The active-id effect that runs when the delayed selection commits
  // consumes this marker instead of immediately launching a second refresh.
  const selectionReconcileConversationRef = React.useRef<string | null>(null)
  // Tail requests may overlap (prefetch, click, stream-ended, reconnect). Only
  // the newest response for a conversation may commit, otherwise a slow
  // mid-stream response can overwrite a faster terminal one.
  const messageTailRefreshGenerationRef = React.useRef<Map<string, number>>(
    new Map()
  )
  // Detect a stream ending while recovery is hydrating a progress snapshot.
  // Without this epoch, the stale recovery continuation can re-introduce
  // isStreaming=true after chat_stream_ended already cleared it.
  const chatStreamLifecycleGenerationRef = React.useRef<Map<string, number>>(
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
    if (state.streamingConversationId) {
      streamingConversationIdRef.current = state.streamingConversationId
    }
  }, [state.streamingConversationId])

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
      const elapsed = Math.round((Date.now() - thinkingStartRef.current) / 1000)
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
      dispatch({
        type: "SET_CONVERSATION_TITLE",
        conversationId: id,
        title: clean,
      })
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
    steeringGenerationRef.current += 1
    const conversationId = activeConversationIdRef.current
    const stream = conversationId
      ? activeChatStreamsRef.current[conversationId]
      : undefined
    const messageId = clientStreamMessageIdRef.current ?? stream?.messageId
    clientStreamMessageIdRef.current = null
    // Stop means stop: drop locally queued steering follow-ups too (the stop
    // endpoint clears the server-side queue). Their user messages stay in the
    // conversation and ride along as history on the next send.
    if (conversationId) followUpQueuesRef.current.delete(conversationId)
    if (conversationId) {
      streamDoneRef.current = true
      // Their pending-steering look clears too — they are plain history now.
      dispatch({ type: "CLEAR_STEER_PENDING", conversationId })
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
      stopChatStream(conversationId, messageId).catch((err) => {
        console.error(err)
      })
    }
  }, [cleanupStream])

  React.useEffect(() => cleanupStream, [cleanupStream])

  const resetChatSessionState = React.useCallback(
    (isLoading = false) => {
      profileSessionGenerationRef.current += 1
      cleanupStream()
      streamDoneRef.current = false
      clientStreamMessageIdRef.current = null
      streamPageWasHiddenRef.current = false
      streamSnapshotRefreshAtRef.current = 0
      activeConversationIdRef.current = null
      conversationsRef.current = []
      conversationMessagePagesRef.current = {}
      activeChatStreamsRef.current = {}
      conversationLoadStateRef.current = {}
      initialMessageLoadsRef.current.clear()
      openMessageLoadsRef.current.clear()
      selectionReconcileConversationRef.current = null
      messageTailRefreshGenerationRef.current.clear()
      chatStreamLifecycleGenerationRef.current.clear()
      messageDetailLoadsRef.current.clear()
      summaryRefreshPromiseRef.current = null
      try {
        window.localStorage.removeItem("chat:active-id")
      } catch {
        // Storage can be unavailable in private modes.
      }
      const emptyUnread = new Set<string>()
      unreadConversationIdsRef.current = emptyUnread
      setUnreadConversationIds(emptyUnread)
      writeUnreadConversationIds(emptyUnread)
      dispatch({ type: "RESET_CHAT_STATE", isLoading })
    },
    [cleanupStream]
  )

  React.useEffect(() => {
    const handleProfileChanged = () => resetChatSessionState(false)
    window.addEventListener(PROFILE_SESSION_CHANGED_EVENT, handleProfileChanged)
    return () => {
      window.removeEventListener(
        PROFILE_SESSION_CHANGED_EVENT,
        handleProfileChanged
      )
    }
  }, [resetChatSessionState])

  const refreshConversationSummaries = React.useCallback(async () => {
    const generation = profileSessionGenerationRef.current
    const data = await fetchConversationSummaries()
    if (profileSessionGenerationRef.current !== generation) return
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
      resetChatSessionState(false)
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
  }, [pathname, refreshConversationSummaries, resetChatSessionState])

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

  const reconcileConversationTail = React.useCallback(
    async (conversationId: string): Promise<Message[] | null> => {
      const generation =
        (messageTailRefreshGenerationRef.current.get(conversationId) ?? 0) + 1
      messageTailRefreshGenerationRef.current.set(conversationId, generation)

      try {
        const page = await fetchConversationMessagePage(
          conversationId,
          INITIAL_MESSAGE_PAGE_SIZE,
          undefined,
          "mixed",
          INITIAL_MESSAGE_FULL_TAIL_SIZE
        )
        if (
          messageTailRefreshGenerationRef.current.get(conversationId) !==
          generation
        ) {
          return null
        }
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
      } catch (error) {
        // A newer reconciliation superseded this request; its result/error is
        // the only one allowed to affect the visible conversation.
        if (
          messageTailRefreshGenerationRef.current.get(conversationId) !==
          generation
        ) {
          return null
        }
        throw error
      }
    },
    []
  )

  const loadInitialMessages = React.useCallback(
    async (
      conversationId: string,
      options?: { reconcileOnOpen?: boolean }
    ): Promise<void> => {
      const reconcileOnOpen = options?.reconcileOnOpen === true
      const status = conversationLoadStateRef.current[conversationId]
      if (
        !reconcileOnOpen &&
        (status === "partial" ||
          status === "full" ||
          status === "loading" ||
          status === "error")
      )
        return

      const loads = reconcileOnOpen
        ? openMessageLoadsRef.current
        : initialMessageLoadsRef.current
      const existingLoad = loads.get(conversationId)
      if (existingLoad) return existingLoad

      const load = (async () => {
        dispatch({ type: "LOAD_CONVERSATION_START", id: conversationId })
        conversationLoadStateRef.current = {
          ...conversationLoadStateRef.current,
          [conversationId]: "loading",
        }
        try {
          await reconcileConversationTail(conversationId)
        } catch (err) {
          dispatch({
            type: "LOAD_CONVERSATION_ERROR",
            id: conversationId,
            error: err instanceof Error ? err.message : "Failed to load chat",
          })
        } finally {
          loads.delete(conversationId)
        }
      })()

      loads.set(conversationId, load)
      return load
    },
    [reconcileConversationTail]
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
    (conversationId: string): Promise<Message[] | null> =>
      reconcileConversationTail(conversationId),
    [reconcileConversationTail]
  )

  React.useEffect(() => {
    if (pathname?.startsWith("/profiles")) return
    const conversationId = state.activeConversationId
    if (!conversationId) return
    if (selectionReconcileConversationRef.current === conversationId) {
      selectionReconcileConversationRef.current = null
      if (pathname === "/") return
    }
    // Selecting from an embedded chat surface already started its load above.
    // The strong open reconciliation belongs to the main chat route; running
    // it while navigating away would add a needless request and briefly mark
    // the hidden conversation as loading.
    if (pathname !== "/") return
    void loadInitialMessages(conversationId, { reconcileOnOpen: true })
  }, [loadInitialMessages, pathname, state.activeConversationId])

  const checkServerStreaming = React.useCallback(
    async (conversationId: string): Promise<ActiveChatStream | null> => {
      if (pathname?.startsWith("/profiles")) return null
      const runtime = await fetchChatRuntimeState(conversationId)
      if (!runtime) return null
      dispatch({
        type: "SYNC_PENDING_FOLLOWUPS",
        conversationId,
        followUps: runtime.followUps,
      })
      return runtime.stream
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
      // Single-flight: concurrent triggers (focus + online + poll tick) join
      // the run already in progress instead of racing dispatches.
      const inFlight = recoveryInFlightRef.current.get(conversationId)
      if (inFlight) return inFlight

      const run = (async (): Promise<"final" | "running" | null> => {
        const recoveryStartedAt = Date.now()
        // Attempts where the server actually answered are budgeted by
        // STREAM_RECOVERY_ATTEMPTS; stretches where it was unreachable (flaky
        // mobile signal) retry with backoff against a much longer deadline —
        // giving up after ~6s of airplane mode was what left the UI stuck.
        let reachableAttempts = 0
        let unreachableStreak = 0
        // With a known target messageId, consecutive server answers confirming
        // "no run, no row for that id" mean the start POST never arrived — exit
        // early so the send path can re-send instead of polling out the budget.
        let confirmedMissingTurn = 0
        while (true) {
          const lifecycleGeneration =
            chatStreamLifecycleGenerationRef.current.get(conversationId) ?? 0
          // Fetch BEFORE touching streaming state. Flipping isStreaming on up
          // front would re-light the "..." cursor and auto-open every reasoning/
          // tool card on a conversation that already finished — exactly the
          // flicker seen when returning to a backgrounded tab. We only enter the
          // "recovering" UI below, once we know there is genuinely a live or
          // interrupted stream to recover.
          const [messagesResult, stream] = await Promise.allSettled([
            refreshConversationMessages(conversationId),
            checkServerStreaming(conversationId),
          ])
          // fetchChatRuntimeState swallows network errors into null, so the
          // messages fetch (which rejects on failure) is the reachability
          // canary. Without it, a dead radio read as "server says nothing is
          // running" and recovery marked live runs as aborted.
          const serverReachable = messagesResult.status === "fulfilled"
          const messages =
            messagesResult.status === "fulfilled" &&
            Array.isArray(messagesResult.value)
              ? messagesResult.value
              : []
          // When the caller knows which assistant message this turn owns, only
          // that row counts. Falling back to "the last assistant message" here
          // used to resurface the PREVIOUS turn's reply as this turn's result
          // when the start POST was lost on flaky signal — recovery reported
          // "final", the resend never fired, and the user's message sat
          // unanswered. The fallback remains for callers without an id (e.g.
          // another tab's stream observed as "unknown").
          const recoveredMessage = messageId
            ? (messages.find((message) => message.id === messageId) ?? null)
            : ([...messages]
                .reverse()
                .find((message) => message.role === "assistant") ?? null)
          const activeStream =
            stream.status === "fulfilled" ? stream.value : null

          if (activeStream) {
            // Keep the live thinking counter alive through recovery. A refocus
            // after a long absence often interrupts the original stream and its
            // ticker, so re-anchor elapsed time to the server's stream start;
            // the counter effect resumes ticking the moment streaming is set.
            thinkingStartRef.current = activeStream.startedAt
            const activeMessage =
              (activeStream.messageId
                ? messages.find(
                    (message) => message.id === activeStream.messageId
                  )
                : null) ??
              recoveredMessage ??
              null
            const snapshot = await hydrateStreamMessage(
              conversationId,
              activeMessage,
              activeStream.messageId
            )
            if (
              (chatStreamLifecycleGenerationRef.current.get(conversationId) ??
                0) !== lifecycleGeneration
            ) {
              // A start/end event landed while the snapshot request was in
              // flight. Loop against current server state instead of reviving
              // the now-stale stream frame after its terminal event.
              continue
            }
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

          if (serverReachable) {
            reachableAttempts += 1
            unreachableStreak = 0
          } else {
            unreachableStreak += 1
          }

          if (
            messageId &&
            serverReachable &&
            !activeStream &&
            !recoveredMessage
          ) {
            // The server answered and has neither a live run nor any row for
            // this turn's id — the start POST almost certainly never arrived.
            // Two consecutive confirmations (a backoff apart) rule out the race
            // where the POST landed but its run hasn't registered yet; then let
            // the caller re-send instead of polling out the whole budget.
            confirmedMissingTurn += 1
            if (confirmedMissingTurn >= 2) return null
          } else {
            confirmedMissingTurn = 0
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
            // Only declare the run dead after the server itself has repeatedly
            // answered "nothing is running" — never off failed fetches, which
            // just mean WE were offline while the run may have kept going.
            if (
              serverReachable &&
              reachableAttempts >= STREAM_RECOVERY_ATTEMPTS &&
              hasProgress
            ) {
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
              addConversationMessageRequest(
                conversationId,
                abortedMessage
              ).catch(console.error)
              return "final"
            }
          }

          if (
            serverReachable &&
            reachableAttempts >= STREAM_RECOVERY_ATTEMPTS
          ) {
            return null
          }
          if (
            !serverReachable &&
            Date.now() - recoveryStartedAt >=
              STREAM_RECOVERY_UNREACHABLE_DEADLINE_MS
          ) {
            return null
          }
          // The user moved to another conversation: stop churning its streaming
          // state from here. Re-opening the conversation re-checks the server
          // (mount effect) and the sync stream delivers the final message.
          if (activeConversationIdRef.current !== conversationId) return null

          // No terminal message and no active server stream yet: this is a
          // genuine mid-flight interruption (e.g. a mobile PWA that dropped the
          // EventSource). Only now show the recovering indicator, then retry.
          dispatch({
            type: "SET_STREAMING",
            isStreaming: true,
            conversationId,
            messageId: messageId ?? undefined,
            status: recoveryStreamingStatus(),
          })
          if (typeof navigator !== "undefined" && !navigator.onLine) {
            // Known-offline: park until the radio returns (or the slice ends)
            // instead of burning backoff sleeps nobody can answer.
            await sleepUntilOnline(OFFLINE_WAIT_SLICE_MS)
          } else {
            const backoffStep = serverReachable
              ? reachableAttempts
              : unreachableStreak
            await sleep(
              Math.min(
                STREAM_RECOVERY_MAX_DELAY_MS,
                STREAM_RECOVERY_DELAY_MS * 2 ** Math.min(backoffStep - 1, 3)
              )
            )
          }
        }
      })()

      const tracked = run.finally(() => {
        recoveryInFlightRef.current.delete(conversationId)
      })
      recoveryInFlightRef.current.set(conversationId, tracked)
      return tracked
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
    // Skip poll ticks while the tab is hidden (12 req/min per backgrounded
    // tab adds up — battery on mobile, load on the server) and refresh
    // immediately on return so stream badges are fresh the moment the user
    // looks at them.
    const tick = () => {
      if (document.visibilityState === "hidden") return
      void refreshActiveChatStreams()
    }
    tick()
    const interval = window.setInterval(tick, 5000)
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible")
        void refreshActiveChatStreams()
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [pathname, refreshActiveChatStreams])

  React.useEffect(() => {
    if (pathname?.startsWith("/profiles")) return
    let sequence = 0
    let inFlight = false
    let lastStartedAt = 0

    const reconcileAfterResume = () => {
      if (document.visibilityState !== "visible") return
      const conversationId = activeConversationIdRef.current
      if (!conversationId) return
      if (streamingRef.current) {
        // This tab owns a live fetch reader. A silently dropped mobile
        // connection leaves that reader hanging forever without an error —
        // and with streamingRef up, every other recovery path is gated off.
        // If nothing has arrived for longer than the keepalive cadence
        // tolerates, abort the fetch; the send path's catch sees the stall
        // flag and runs stream recovery instead of surfacing "stopped".
        // Reader attached: keepalives mean any silence past the short resume
        // window is a dead connection. POST still awaiting headers: no
        // keepalive exists yet, so give it the full stall timeout before
        // cutting it loose (re-sending is idempotent — stable message ids).
        const quietForMs = Date.now() - streamLastActivityRef.current
        const stalled = streamReaderActiveRef.current
          ? quietForMs > STREAM_RESUME_STALL_MS
          : streamPostInFlightRef.current &&
            quietForMs > STREAM_STALL_TIMEOUT_MS
        if (stalled) {
          streamStallRequestedRef.current = true
          abortControllerRef.current?.abort()
        }
        return
      }
      // A tab return fires visibilitychange + pageshow + focus back-to-back;
      // without a single-flight + cooldown each one kicked off its own
      // refresh/recover pass, and the overlapping recoveries re-dispatched
      // streaming state over each other (visible flicker until a refresh).
      if (inFlight) return
      if (Date.now() - lastStartedAt < 1000) return

      const knownStream = activeChatStreamsRef.current[conversationId]
      const wasHiddenDuringStream = streamPageWasHiddenRef.current
      if (
        !knownStream &&
        !isStreamingStateRef.current &&
        !wasHiddenDuringStream
      )
        return

      const currentSequence = ++sequence
      inFlight = true
      lastStartedAt = Date.now()
      void (async () => {
        try {
          const streams = await refreshActiveChatStreams()
          if (currentSequence !== sequence) return
          const stream =
            streams.find((item) => item.conversationId === conversationId) ??
            activeChatStreamsRef.current[conversationId]
          await recoverInterruptedStream(conversationId, stream?.messageId)
          if (currentSequence === sequence) {
            streamPageWasHiddenRef.current = false
          }
        } finally {
          inFlight = false
        }
      })()
    }

    document.addEventListener("visibilitychange", reconcileAfterResume)
    window.addEventListener("pageshow", reconcileAfterResume)
    window.addEventListener("focus", reconcileAfterResume)
    // The radio coming back is the same resume signal on flaky mobile —
    // reconcile immediately instead of waiting for the next focus change.
    window.addEventListener("online", reconcileAfterResume)
    return () => {
      sequence += 1
      document.removeEventListener("visibilitychange", reconcileAfterResume)
      window.removeEventListener("pageshow", reconcileAfterResume)
      window.removeEventListener("focus", reconcileAfterResume)
      window.removeEventListener("online", reconcileAfterResume)
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
  }, [
    checkServerStreaming,
    recoverInterruptedStream,
    state.activeConversationId,
  ])

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
            void recoverInterruptedStream(
              conversationId,
              stream.messageId
            ).finally(() => {
              recovering = false
            })
          } else {
            dispatch({
              type: "SET_STREAMING",
              isStreaming: true,
              conversationId,
              messageId: stream.messageId,
              status: hasStreamingPayload
                ? undefined
                : recoveryStreamingStatus(),
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
    let eventSource: EventSource | null = null
    let disposed = false

    let hadError = false

    const handleOpen = () => {
      reconcileConversationSummaries("after chat sync reconnect")
      // /api/sync has no event replay: anything emitted while the stream was
      // down is gone. After a real gap (not the initial connect), refetch the
      // open conversation so messages that landed during the outage appear
      // without leaving and re-entering the chat.
      if (hadError) {
        hadError = false
        const conversationId = activeConversationIdRef.current
        if (conversationId && !streamingRef.current) {
          refreshConversationMessages(conversationId).catch(() => {})
        }
      }
    }

    const handleMessage = (event: MessageEvent) => {
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
          const eventConversationId = data.payload.conversationId
          reconcileUnknownConversation(
            eventConversationId,
            "after message for unknown conversation"
          )
          if (msg.role === "user") {
            dispatch({
              type: "ADD_USER_MESSAGE",
              conversationId: eventConversationId,
              message: msg,
            })
          } else if (msg.role === "assistant") {
            // The direct reader owns only its exact row. Keep applying sync
            // updates for other conversations while a local turn streams;
            // globally suppressing them is how background completions were
            // lost until refresh.
            const isOwnedStreamMessage = isOwnedAssistantStreamMessage({
              ownsStream: streamingRef.current,
              ownedConversationId: streamingConversationIdRef.current,
              ownedMessageId: clientStreamMessageIdRef.current,
              eventConversationId,
              eventMessageId: msg.id,
            })
            if (!isOwnedStreamMessage) {
              const isFinalChunk = isTerminalAssistantMessage(msg)
              const existingMessage = conversationsRef.current
                .find((conversation) => conversation.id === eventConversationId)
                ?.messages.find((message) => message.id === msg.id)
              const alreadyHasTerminalMessage =
                isTerminalAssistantMessage(existingMessage)
              dispatch({
                type: "ADD_ASSISTANT_MESSAGE",
                conversationId: eventConversationId,
                message: msg,
                stopStreaming: isFinalChunk,
              })
              if (isFinalChunk) {
                handleAssistantFinished(eventConversationId, msg)
              }
              if (
                !isFinalChunk &&
                !alreadyHasTerminalMessage &&
                eventConversationId === activeConversationIdRef.current
              ) {
                dispatch({
                  type: "SET_STREAMING",
                  isStreaming: true,
                  conversationId: eventConversationId,
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
          const stream: ActiveChatStream = {
            conversationId: data.payload.conversationId,
            messageId: data.payload.messageId,
            startedAt: data.payload.startedAt,
          }
          chatStreamLifecycleGenerationRef.current.set(
            stream.conversationId,
            (chatStreamLifecycleGenerationRef.current.get(
              stream.conversationId
            ) ?? 0) + 1
          )
          activeChatStreamsRef.current = {
            ...activeChatStreamsRef.current,
            [stream.conversationId]: stream,
          }
          dispatch({ type: "CHAT_STREAM_STARTED", stream })
          dispatch({
            type: "SETTLE_FIRST_CLAIMED_FOLLOWUP",
            conversationId: stream.conversationId,
          })
        } else if (data.type === "chat_stream_ended") {
          chatStreamLifecycleGenerationRef.current.set(
            data.payload.conversationId,
            (chatStreamLifecycleGenerationRef.current.get(
              data.payload.conversationId
            ) ?? 0) + 1
          )
          const current =
            activeChatStreamsRef.current[data.payload.conversationId]
          if (
            !data.payload.messageId ||
            !current ||
            current.messageId === data.payload.messageId
          ) {
            const activeChatStreams = { ...activeChatStreamsRef.current }
            delete activeChatStreams[data.payload.conversationId]
            activeChatStreamsRef.current = activeChatStreams
          }
          dispatch({
            type: "CHAT_STREAM_ENDED",
            conversationId: data.payload.conversationId,
            messageId: data.payload.messageId,
          })
          reconcileConversationSummaries("after stream end")
          const ownsEndedStream = isOwnedAssistantStreamMessage({
            ownsStream: streamingRef.current,
            ownedConversationId: streamingConversationIdRef.current,
            ownedMessageId: clientStreamMessageIdRef.current,
            eventConversationId: data.payload.conversationId,
            eventMessageId:
              typeof data.payload.messageId === "string"
                ? data.payload.messageId
                : "",
          })
          if (
            document.visibilityState === "visible" &&
            data.payload.conversationId === activeConversationIdRef.current &&
            !ownsEndedStream
          ) {
            void recoverInterruptedStream(
              data.payload.conversationId,
              typeof data.payload.messageId === "string"
                ? data.payload.messageId
                : undefined
            )
          } else if (!ownsEndedStream) {
            // Stream-end is an invalidation boundary. Reconcile inactive
            // conversations too, so the final DB row replaces whatever
            // progress snapshot happened to arrive last before the user opens
            // the chat.
            void refreshConversationMessages(data.payload.conversationId).catch(
              () => {}
            )
          }
          window.setTimeout(
            () => drainNextFollowUp(data.payload.conversationId),
            0
          )
        } else if (data.type === "chat_followup_queued") {
          if (data.payload.source === "user") {
            dispatch({
              type: "UPSERT_PENDING_FOLLOWUP",
              conversationId: data.payload.conversationId,
              followUp: {
                followUpId: data.payload.followUpId,
                userMessageId: data.payload.userMessageId,
                source: "user",
                queuedAt:
                  typeof data.payload.queuedAt === "number"
                    ? data.payload.queuedAt
                    : Date.now(),
                status: "queued",
              },
            })
          }
        } else if (data.type === "chat_followup_claimed") {
          dispatch({
            type: "SET_PENDING_FOLLOWUP_STATUS",
            conversationId: data.payload.conversationId,
            userMessageId: data.payload.userMessageId,
            status: "claimed",
          })
        } else if (data.type === "chat_followups_cleared") {
          dispatch({
            type: "CLEAR_STEER_PENDING",
            conversationId: data.payload.conversationId,
          })
        }
      } catch (err) {
        console.error("Failed to parse SSE event", err)
      }
    }

    const handleError = () => {
      // EventSource emits "error" for transient disconnects and auto-retries.
      // Logging it as console.error trips the Next.js dev overlay with no useful detail.
      hadError = true
    }

    const connect = () => {
      if (disposed) return
      eventSource?.close()
      eventSource = new EventSource("/api/sync")
      eventSource.onopen = handleOpen
      eventSource.onmessage = handleMessage
      eventSource.onerror = handleError
    }

    connect()

    // EventSource auto-retries transient drops, but a backgrounded tab (mobile
    // PWA especially) can have the connection torn down for good — readyState
    // lands on CLOSED and nothing reconnects, so the UI silently stops syncing
    // until a manual refresh. Reconnect on foreground; onopen's reconcile
    // backfills whatever was missed while the stream was dead.
    const reconnectIfDead = () => {
      if (document.visibilityState !== "visible") return
      if (eventSource && eventSource.readyState !== EventSource.CLOSED) return
      connect()
    }
    document.addEventListener("visibilitychange", reconnectIfDead)
    window.addEventListener("focus", reconnectIfDead)
    window.addEventListener("pageshow", reconnectIfDead)
    // The radio coming back on a visible tab won't fire any of the above.
    window.addEventListener("online", reconnectIfDead)

    return () => {
      disposed = true
      document.removeEventListener("visibilitychange", reconnectIfDead)
      window.removeEventListener("focus", reconnectIfDead)
      window.removeEventListener("pageshow", reconnectIfDead)
      window.removeEventListener("online", reconnectIfDead)
      eventSource?.close()
    }
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
    refreshConversationMessages,
    drainNextFollowUp,
  ])

  const newChat = React.useCallback(() => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(CHAT_VIEW_SAVE_STATE_EVENT))
    }
    selectionReconcileConversationRef.current = null
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
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(CHAT_VIEW_SAVE_STATE_EVENT))
      }
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
      selectionReconcileConversationRef.current = id
      void loadInitialMessages(id, { reconcileOnOpen: true })
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
      const followUpClaim = options?.internalFollowUp ?? null
      // Steering: a send while this conversation's turn is still streaming is
      // routed through /api/chat/steer even when this tab only OBSERVES the
      // server run (recovery, refresh, another tab). Reader ownership is not
      // the source of truth for whether a turn exists.
      const isSteering = shouldSendAsSteering({
        targetConversationId,
        hasInternalFollowUp: Boolean(followUpClaim),
        ownsStream: streamingRef.current,
        ownedConversationId: streamingConversationIdRef.current,
        isStreaming: isStreamingStateRef.current,
        streamingConversationId: streamingConversationIdRef.current,
        activeChatStreams: activeChatStreamsRef.current,
      })

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

      let userMessage: Message = followUpClaim
        ? { ...followUpClaim.userMessage, steerPending: undefined }
        : {
            id: generateId(),
            role: "user",
            content,
            attachments: finalAttachments,
            timestamp: Date.now(),
          }

      let conversationId = targetConversationId
      let allMessages: Message[]

      if (isSteering && conversationId) {
        const steeringGeneration = steeringGenerationRef.current
        dispatch({
          type: "ADD_USER_MESSAGE",
          conversationId,
          message: userMessage,
        })
        dispatch({
          type: "UPSERT_PENDING_FOLLOWUP",
          conversationId,
          followUp: {
            followUpId: userMessage.id,
            userMessageId: userMessage.id,
            source: "user",
            queuedAt: userMessage.timestamp,
            status: "submitting",
          },
        })
        markConversationRead(conversationId)
        // Short retry loop — a flaky first POST must not drop the follow-up,
        // but this can't fall back to a plain /api/chat send (that would
        // abort the in-flight run).
        let steer: Awaited<ReturnType<typeof steerChatMessage>> = null
        for (let attempt = 0; attempt < 4 && !steer; attempt++) {
          if (steeringGenerationRef.current !== steeringGeneration) break
          if (attempt > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(4_000, 500 * 2 ** attempt))
            )
          }
          steer = await steerChatMessage(conversationId, userMessage)
        }
        if (steeringGenerationRef.current !== steeringGeneration) {
          dispatch({
            type: "REMOVE_PENDING_FOLLOWUP",
            conversationId,
            userMessageId: userMessage.id,
          })
          return conversationId
        }
        if (steer?.steered) {
          // Delivered INTO the running turn (provider steering). Swap the
          // optimistic row for the tagged server copy — the tag hides the
          // standalone bubble; the message renders inline at its injection
          // point via the steered_message entry on the streaming turn (SSE).
          dispatch({
            type: "ADD_USER_MESSAGE",
            conversationId,
            message: {
              ...userMessage,
              content: wrapSteeredMessage(content),
              steerPending: undefined,
              timestamp: Date.now(),
            },
          })
          dispatch({
            type: "REMOVE_PENDING_FOLLOWUP",
            conversationId,
            userMessageId: userMessage.id,
          })
          return conversationId
        }
        if (steer?.queued && steer.followUpId) {
          const queue = followUpQueuesRef.current.get(conversationId) ?? []
          if (!queue.some((entry) => entry.followUpId === steer.followUpId)) {
            queue.push({ followUpId: steer.followUpId, userMessage })
          }
          followUpQueuesRef.current.set(conversationId, queue)
          dispatch({
            type: "UPSERT_PENDING_FOLLOWUP",
            conversationId,
            followUp: {
              followUpId: steer.followUpId,
              userMessageId: userMessage.id,
              source: "user",
              queuedAt: userMessage.timestamp,
              status: "queued",
            },
          })
          return conversationId
        }
        if (!steer) {
          // Steer never reached the server. Persist the message so it isn't
          // lost (upsert by id — safe), but don't start a turn: a blind POST
          // /api/chat would abort a still-running stream.
          const orphan: Message = { ...userMessage, steerPending: undefined }
          dispatch({
            type: "ADD_USER_MESSAGE",
            conversationId,
            message: orphan,
          })
          dispatch({
            type: "REMOVE_PENDING_FOLLOWUP",
            conversationId,
            userMessageId: userMessage.id,
          })
          void postWithRetry(() =>
            addConversationMessageRequest(conversationId!, orphan)
          ).catch(console.error)
          return conversationId
        }
        // Server reports no active run (it finished while the user typed) —
        // fall through to a normal send with this message.
        userMessage = { ...userMessage, steerPending: undefined }
        dispatch({
          type: "ADD_USER_MESSAGE",
          conversationId,
          message: userMessage,
        })
        dispatch({
          type: "REMOVE_PENDING_FOLLOWUP",
          conversationId,
          userMessageId: userMessage.id,
        })
      }

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
        // Retried on transient network failure (waiting for `online` when the
        // device knows it's offline) — a flaky send must not lose the
        // conversation row while the optimistic UI shows it as created.
        const createPromise = postWithRetry(() =>
          createConversationRequest(newConv)
        ).catch(console.error)

        dispatch({
          type: "CREATE_CONVERSATION",
          conversation: newConv,
          activate: options?.activateConversation !== false,
        })
        if (options?.activateConversation !== false) {
          activeConversationIdRef.current = conversationId
        }
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
      } else if (followUpClaim) {
        // Steering follow-up drain: the message was persisted by the steer
        // endpoint and dispatched into local state when the user sent it.
        // Re-stamp it to drain time and move it to the end — the previous
        // turn's terminal persist stamped the assistant row with completion
        // time, so without this the follow-up would sit ABOVE the answer it
        // followed. The server does the same on claim (authoritative copy).
        const restamped: Message = { ...userMessage, timestamp: Date.now() }
        dispatch({
          type: "SET_PENDING_FOLLOWUP_STATUS",
          conversationId,
          userMessageId: userMessage.id,
          status: "claimed",
        })
        dispatch({
          type: "ADD_USER_MESSAGE",
          conversationId,
          message: restamped,
          moveToEnd: true,
        })
        const conv = state.conversations.find((c) => c.id === conversationId)
        const base = (conv?.messages ?? []).filter(
          (m) => m.id !== userMessage.id
        )
        allMessages = [...base, restamped]
      } else {
        // Fire-and-forget with retries: the turn itself rides in the /api/chat
        // body, but this row is what a refresh loads — losing it to one failed
        // POST on weak signal silently dropped the user's message from
        // history. addMessage upserts by id, so repeats are safe.
        void postWithRetry(() =>
          addConversationMessageRequest(conversationId!, userMessage)
        ).then((response) => {
          if (!response?.ok) {
            console.error(
              "Failed to persist user message",
              response?.status ?? "network"
            )
          }
        })

        if (!isSteering) {
          // (The steering fall-through already dispatched this message.)
          dispatch({
            type: "ADD_USER_MESSAGE",
            conversationId,
            message: userMessage,
          })
        }
        markConversationRead(conversationId)

        // Build messages array from current state + new user message.
        // startChatStreamRequest keeps this full payload unless it nears the
        // platform request-size limit, where it strips only UI-only metadata.
        const conv = state.conversations.find((c) => c.id === conversationId)
        const base = conv?.messages ?? []
        allMessages = base.some((m) => m.id === userMessage.id)
          ? [...base]
          : [...base, userMessage]
      }

      if (options?.activateConversation !== false && !followUpClaim) {
        publishLocalSubmitAnchor({
          conversationId,
          messageId: userMessage.id,
          submittedAt: userMessage.timestamp,
        })
      }

      // Start streaming
      const assistantMsgId = generateId()
      clientStreamMessageIdRef.current = assistantMsgId
      streamingRef.current = true
      streamingConversationIdRef.current = conversationId
      streamDoneRef.current = false
      streamPageWasHiddenRef.current = document.visibilityState !== "visible"
      streamStallRequestedRef.current = false
      streamReaderActiveRef.current = false
      streamPostInFlightRef.current = false
      streamLastActivityRef.current = Date.now()

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

      // Dead-radio watchdog: a reader on a silently dropped connection hangs
      // forever with no error. The server sends `: ping` keepalives, so a
      // visible stream that has been byte-silent past the stall timeout is
      // dead — abort it and let the catch below run recovery/resend.
      const stallWatchdog = window.setInterval(() => {
        // Two stallable phases: reader attached (keepalives make silence a
        // dead connection) and POST still awaiting headers (a silently dropped
        // radio hangs the fetch with no reader to observe). Between attempts
        // (recovery running inside the catch) both flags are down — no-op.
        if (!streamReaderActiveRef.current && !streamPostInFlightRef.current)
          return
        if (document.visibilityState === "hidden") return
        if (
          Date.now() - streamLastActivityRef.current <=
          STREAM_STALL_TIMEOUT_MS
        )
          return
        streamStallRequestedRef.current = true
        abortControllerRef.current?.abort()
      }, STREAM_STALL_CHECK_INTERVAL_MS)

      let sendRetriesLeft = CHAT_SEND_RETRY_ATTEMPTS

      // Pass the full local conversation for normal turns; the request helper
      // falls back to a provider-relevant slim shape only near size limits.
      // Wrapped so a network-interrupted start can re-send the same turn with
      // a fresh AbortController (a stall abort burns the previous one).
      const runStreamTurn = (): Promise<void> => {
        const attemptController = new AbortController()
        abortControllerRef.current = attemptController
        streamPostInFlightRef.current = true
        return startChatStreamRequest({
          conversationId: finalConvId,
          messageId: assistantMsgId,
          messages: allMessages,
          promptContext: options?.promptContext,
          promptContextSource: options?.promptContextSource,
          activateIntegrations: options?.activateIntegrations,
          preferredFallbackIndex: options?.preferredFallbackIndex,
          followUpId: followUpClaim?.followUpId,
          signal: attemptController.signal,
        })
          .then(async (response) => {
            streamPostInFlightRef.current = false
            if (!response.ok) {
              const err = await response
                .json()
                .catch(() => ({ error: "Unknown error" }))
              if (isChatUpdateInProgressResponse(response.status, err)) {
                // The user's row is already persisted. Keep this exact turn
                // alive across the managed restart and retry with the same
                // conversation/message ids, so reconnect cannot duplicate it.
                dispatch({
                  type: "SET_STREAMING",
                  isStreaming: true,
                  conversationId: finalConvId,
                  messageId: assistantMsgId,
                  status: "updating",
                })
                streamLastActivityRef.current = Date.now()
                await sleepWithAbortSignal(
                  chatUpdateRetryDelayMs(response.headers.get("Retry-After")),
                  attemptController.signal
                )
                if (
                  !streamingRef.current ||
                  clientStreamMessageIdRef.current !== assistantMsgId ||
                  activeConversationIdRef.current !== finalConvId
                ) {
                  return
                }
                streamLastActivityRef.current = Date.now()
                return runStreamTurn()
              }
              if (
                response.status === 409 &&
                err?.code === "stream_already_active" &&
                typeof err.activeMessageId === "string"
              ) {
                streamDoneRef.current = true
                const activeStream: ActiveChatStream = {
                  conversationId: finalConvId,
                  messageId: err.activeMessageId,
                  startedAt:
                    typeof err.activeStartedAt === "number"
                      ? err.activeStartedAt
                      : Date.now(),
                }
                activeChatStreamsRef.current = {
                  ...activeChatStreamsRef.current,
                  [finalConvId]: activeStream,
                }
                thinkingStartRef.current = activeStream.startedAt
                dispatch({
                  type: "SET_STREAMING",
                  isStreaming: true,
                  conversationId: finalConvId,
                  messageId: activeStream.messageId,
                  status: recoveryStreamingStatus(),
                })
                dispatch({ type: "CHAT_STREAM_STARTED", stream: activeStream })
                void recoverInterruptedStream(
                  finalConvId,
                  activeStream.messageId
                )
                return
              }
              if (
                response.status === 409 &&
                (err?.code === "stream_active_queued" ||
                  err?.code === "followup_deferred") &&
                typeof err.followUpId === "string" &&
                typeof err.activeMessageId === "string"
              ) {
                const queuedMessage = followUpClaim?.userMessage ?? userMessage
                const queue = followUpQueuesRef.current.get(finalConvId) ?? []
                if (
                  !queue.some((entry) => entry.followUpId === err.followUpId)
                ) {
                  const queuedEntry = {
                    followUpId: err.followUpId,
                    userMessage: queuedMessage,
                  }
                  if (followUpClaim) queue.unshift(queuedEntry)
                  else queue.push(queuedEntry)
                }
                followUpQueuesRef.current.set(finalConvId, queue)
                dispatch({
                  type: "UPSERT_PENDING_FOLLOWUP",
                  conversationId: finalConvId,
                  followUp: {
                    followUpId: err.followUpId,
                    userMessageId: queuedMessage.id,
                    source: "user",
                    queuedAt:
                      typeof err.queuedAt === "number"
                        ? err.queuedAt
                        : queuedMessage.timestamp,
                    status: "queued",
                  },
                })

                streamDoneRef.current = true
                streamingRef.current = false
                clientStreamMessageIdRef.current = null
                abortControllerRef.current = null
                const activeStream: ActiveChatStream = {
                  conversationId: finalConvId,
                  messageId: err.activeMessageId,
                  startedAt:
                    typeof err.activeStartedAt === "number"
                      ? err.activeStartedAt
                      : Date.now(),
                }
                activeChatStreamsRef.current = {
                  ...activeChatStreamsRef.current,
                  [finalConvId]: activeStream,
                }
                thinkingStartRef.current = activeStream.startedAt
                dispatch({
                  type: "CHAT_STREAM_ENDED",
                  conversationId: finalConvId,
                  messageId: assistantMsgId,
                })
                dispatch({
                  type: "SET_STREAMING",
                  isStreaming: true,
                  conversationId: finalConvId,
                  messageId: activeStream.messageId,
                  status: recoveryStreamingStatus(),
                })
                dispatch({ type: "CHAT_STREAM_STARTED", stream: activeStream })
                void recoverInterruptedStream(
                  finalConvId,
                  activeStream.messageId
                )
                return
              }
              if (
                response.status === 409 &&
                err?.code === "followup_already_claimed"
              ) {
                // The server-side sweep beat us to this follow-up — its wake
                // turn is (or will be) streaming. Quietly stand down; sync
                // events surface that run.
                streamDoneRef.current = true
                dispatch({ type: "SET_STREAMING", isStreaming: false })
                dispatch({
                  type: "CHAT_STREAM_ENDED",
                  conversationId: finalConvId,
                  messageId: assistantMsgId,
                })
                if (followUpClaim) {
                  dispatch({
                    type: "REMOVE_PENDING_FOLLOWUP",
                    conversationId: finalConvId,
                    userMessageId: followUpClaim.userMessage.id,
                  })
                }
                return
              }
              throw new ChatFetchError(
                err.error || `HTTP ${response.status}`,
                typeof err.chatMessage === "string"
                  ? err.chatMessage
                  : undefined
              )
            }

            if (followUpClaim) {
              dispatch({
                type: "REMOVE_PENDING_FOLLOWUP",
                conversationId: finalConvId,
                userMessageId: followUpClaim.userMessage.id,
              })
            }

            if (!response.body) throw new Error("No response body")

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

            streamReaderActiveRef.current = true
            streamLastActivityRef.current = Date.now()

            let accThinking = ""
            let accContent = ""
            const accContentSegments: NonNullable<Message["contentSegments"]> =
              []
            let finalThinkingDuration = 0
            const accReasoning: StreamingReasoning = []
            const accAttachments: Attachment[] = []
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
              entry.reasoning = appendAgentThought(
                entry,
                chunk,
                phase
              ).reasoning
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
            const terminalSnapshot = () => ({
              messageId: assistantMsgId,
              content: accContent,
              contentSegments: accContentSegments,
              reasoning: accReasoning,
              thinking: accThinking,
              thinkingDuration: finalThinkingDuration,
              attachments: accAttachments,
            })

            await readJsonSseStream(response.body, {
              // Any bytes — including `: ping` keepalive comments the parser
              // skips — count as liveness for the stall watchdog.
              onActivity: () => {
                streamLastActivityRef.current = Date.now()
              },
              onEvent: (data) => {
                if (handleArtifactStreamEvent(data, assistantMsgId)) return

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
                      entry.deltas = appendBoundedToolDelta(entry.deltas, delta)
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
                } else if (data.type === "agent_queued") {
                  // Transient "waiting for a slot" card. The matching agent_start
                  // (same runId) replaces it in place once the run is admitted.
                  const entry = agentCallEntryFromStartEvent(
                    data,
                    reasoningPhase
                  )
                  if (entry) {
                    entry.queued = true
                    if (streamMode === "content") {
                      reasoningPhase += 1
                      streamMode = "reasoning"
                      entry.phase = reasoningPhase
                    }
                    const existing = accReasoning.findIndex(
                      (item) =>
                        item.type === "agent_call" && item.runId === entry.runId
                    )
                    if (existing >= 0) accReasoning[existing] = entry
                    else accReasoning.push(entry)
                    dispatch({ type: "UPSERT_STREAMING_AGENT_CALL", entry })
                  }
                } else if (data.type === "agent_start") {
                  const entry = agentCallEntryFromStartEvent(
                    data,
                    reasoningPhase
                  )
                  if (entry) {
                    if (streamMode === "content") {
                      reasoningPhase += 1
                      streamMode = "reasoning"
                      entry.phase = reasoningPhase
                    }
                    const existing = accReasoning.findIndex(
                      (item) =>
                        item.type === "agent_call" && item.runId === entry.runId
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
                } else if (data.type === "steered_message") {
                  const entry =
                    data.entry && typeof data.entry === "object"
                      ? (data.entry as SteeredMessageReasoningEntry)
                      : null
                  if (
                    entry?.type === "steered_message" &&
                    typeof entry.id === "string" &&
                    typeof entry.content === "string"
                  ) {
                    // A steered injection ALWAYS opens a fresh phase (the
                    // server did the same) so the transcript splits exactly
                    // at the injection point.
                    reasoningPhase += 1
                    streamMode = "reasoning"
                    if (
                      !accReasoning.some(
                        (item) =>
                          item.type === "steered_message" &&
                          item.id === entry.id
                      )
                    ) {
                      accReasoning.push({ ...entry, phase: reasoningPhase })
                    }
                    dispatch({
                      type: "ADD_STREAMING_STEERED_MESSAGE",
                      entry: { ...entry, phase: reasoningPhase },
                    })
                    // Hide the standalone bubble: swap the optimistic row for
                    // the tagged copy (idempotent with the steer POST path;
                    // also covers steers sent from another device).
                    dispatch({
                      type: "ADD_USER_MESSAGE",
                      conversationId: finalConvId,
                      message: {
                        id: entry.userMessageId,
                        role: "user",
                        content: wrapSteeredMessage(entry.content),
                        timestamp: entry.at ?? Date.now(),
                      },
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
                } else if (data.type === "done") {
                  // Stream complete — adopt the server-persisted message so a
                  // refresh shows the exact same state; fall back to the
                  // locally-accumulated payload if the event lacks it.
                  streamDoneRef.current = true
                  const finalMsg = completedAssistantMessage(
                    data,
                    terminalSnapshot()
                  )
                  dispatch({
                    type: "ADD_ASSISTANT_MESSAGE",
                    conversationId: finalConvId,
                    message: finalMsg,
                  })
                  handleAssistantFinished(finalConvId, finalMsg)
                } else if (data.type === "stopped") {
                  streamDoneRef.current = true
                  const finalMsg = stoppedAssistantMessage(
                    data,
                    terminalSnapshot()
                  )
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
                  const { message: finalMsg, error: rawError } =
                    erroredAssistantMessage(data, terminalSnapshot())
                  dispatch({
                    type: "ADD_ASSISTANT_MESSAGE",
                    conversationId: finalConvId,
                    message: finalMsg,
                  })
                  handleAssistantFinished(finalConvId, finalMsg)
                  console.error("Stream error:", rawError)
                }
              },
            })

            streamReaderActiveRef.current = false
          })
          .catch(async (err) => {
            streamPostInFlightRef.current = false
            streamReaderActiveRef.current = false
            const stallAborted = streamStallRequestedRef.current
            streamStallRequestedRef.current = false
            // A plain abort is the user's Stop (or unmount); a stall-requested
            // abort is the watchdog cutting a dead connection loose — that one
            // must fall through to recovery.
            if (err.name === "AbortError" && !stallAborted) return
            console.error("Chat fetch error:", err)

            // Treat every network-shaped failure as recoverable, regardless of
            // visibility. The old visibility/offline gate missed the common
            // flaky-mobile case: visible tab, navigator.onLine still true, and
            // a fetch that died with a bare "Failed to fetch".
            if (stallAborted || isLikelyStreamInterruption(err)) {
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

              // Nothing recoverable server-side — the start POST most likely
              // never arrived. While this turn is still the live one (no Stop,
              // no navigation, same conversation), re-send it: message ids are
              // stable and persistence upserts by id, so a duplicate start is
              // the same turn, not a second one.
              if (
                sendRetriesLeft > 0 &&
                streamingRef.current &&
                clientStreamMessageIdRef.current === assistantMsgId &&
                activeConversationIdRef.current === finalConvId
              ) {
                sendRetriesLeft -= 1
                dispatch({
                  type: "SET_STREAMING",
                  isStreaming: true,
                  conversationId: finalConvId,
                  messageId: assistantMsgId,
                  status: "connecting",
                })
                streamLastActivityRef.current = Date.now()
                return runStreamTurn()
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
      }

      void runStreamTurn().finally(() => {
        window.clearInterval(stallWatchdog)
        streamPostInFlightRef.current = false
        streamReaderActiveRef.current = false
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
        // Steering drain: the turn settled — run the next queued follow-up.
        // The helper also checks server-observed streams, so an ownership handoff
        // cannot accidentally start over (and abort) the turn still in progress.
        drainNextFollowUp(finalConvId)
      })
      return finalConvId
    },
    [
      autoNameConversation,
      handleAssistantFinished,
      drainNextFollowUp,
      markConversationRead,
      recoverInterruptedStream,
      recoveryStreamingStatus,
      state.conversations,
    ]
  )

  React.useEffect(() => {
    sendMessageToConversationRef.current = sendMessageToConversation
  }, [sendMessageToConversation])

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

/**
 * Non-throwing variant for components that can render both inside a
 * conversation (sidebar, panel) AND in provider-less contexts (message
 * previews, the standalone /artifact route). Returns null when there is no
 * ChatStoreProvider so callers can degrade to a read-only view instead of
 * crashing.
 */
export function useChatStoreOptional() {
  return React.useContext(ChatContext)
}
