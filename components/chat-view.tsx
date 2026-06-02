"use client"

import * as React from "react"
import { ArrowDown, ChevronDown, Loader2 } from "lucide-react"
import { ArtifactPanel, artifactKey } from "@/components/artifact-panel"
import { AgentWorkspacePanel } from "@/components/chat/agent-workspace-panel"
import {
  ARTIFACT_PANEL_DEFAULT_WIDTH,
  ARTIFACT_PANEL_MAX_WIDTH,
  ARTIFACT_PANEL_MIN_WIDTH,
  ARTIFACT_PANEL_RESIZE_STEP,
  ARTIFACT_PANEL_RESIZER_WIDTH,
  LAYOUT_TRANSITION,
  MAX_MOBILE_RESTORE_OLDER_PAGES,
  MAX_RESTORE_OLDER_PAGES,
  MESSAGE_ANCHOR_SCROLL_DURATION_MS,
  MESSAGE_ANCHOR_TOP_OFFSET,
  MESSAGE_VERTICAL_GAP,
  SCROLL_ANCHOR_STORAGE_PREFIX,
  SCROLL_BOTTOM_SENTINEL,
  SCROLL_BUTTON_FADE_DISTANCE_PX,
  SCROLL_RESTORE_STORAGE_PREFIX,
  SCROLL_RESTORE_TOP_OFFSET,
  STICKY_BOTTOM_THRESHOLD,
  STREAM_ANCHOR_TAKEN_PREFIX,
  TAIL_SPACER_UPDATE_THRESHOLD_PX,
  artifactPanelArtifactWidthKey,
  artifactPanelConversationWidthKey,
  clampArtifactPanelWidth,
  collectAgentRuns,
  getElementContentHeight,
  hasAssistantProgress,
  isAssistantMessageInProgress,
  readSavedArtifactState,
  readSavedMinHeightState,
  readStoredArtifactPanelWidth,
  type ArtifactState,
  type SavedScrollRestore,
} from "@/components/chat/chat-view-helpers"
import { ChatInput } from "@/components/chat-input"
import { TodoBar } from "@/components/todo-bar"
import { MessageBubble, StreamingBubble } from "@/components/message-bubble"
import { FilePreviewModal } from "@/components/file-preview-modal"
import { ArtifactPanel as AntArtifactPanel } from "@/components/artifacts/artifact-panel"
import { ConversationArtifactsProvider } from "@/components/artifacts/use-conversation-artifacts"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { useChatStore } from "@/hooks/use-chat-store"
import { useMobileKeyboardInset } from "@/hooks/use-keyboard-inset"
import { cn } from "@/lib/utils"
import type { AgentCallReasoningEntry, Attachment } from "@/lib/types"

export function ChatView() {
  const { state, loadOlderMessages, loadMessageDetails } = useChatStore()
  const layoutContainerRef = React.useRef<HTMLDivElement>(null)
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)
  const inputContainerRef = React.useRef<HTMLDivElement>(null)
  const streamingBubbleContainerRef = React.useRef<HTMLDivElement>(null)
  const wasStreamingRef = React.useRef(false)
  const autoScrollEnabledRef = React.useRef(false)
  const suppressBtnRef = React.useRef(false) // Brief suppression after streaming starts (prevents flash from minHeight)
  const ignoreSyncRef = React.useRef(true) // Start locked to prevent 0 writes on mount
  const sidebarWasOpenRef = React.useRef(true)
  const conversationIdRef = React.useRef<string | null>(null)
  const artifactResizeKeyRef = React.useRef<string | null>(null)
  const olderLoadRequestedRef = React.useRef(false)
  const restoredScrollConversationRef = React.useRef<string | null>(null)
  const [restoredScrollConversationId, setRestoredScrollConversationId] =
    React.useState<string | null>(null)
  const bottomSettleFrameIdRef = React.useRef<number | null>(null)
  const messageTopAnchorFrameIdRef = React.useRef<number | null>(null)
  const messageTopAnchorReleaseTimeoutRef = React.useRef<number | null>(null)
  const messageTopAnchorMessageIdRef = React.useRef<string | null>(null)
  const messageTopAnchorStartedAtRef = React.useRef(0)
  const wasStreamingLayoutRef = React.useRef(false)
  const streamingScrollAnchorRef = React.useRef<{
    conversationId: string
    streamMessageId: string | null
    anchor: SavedScrollRestore
  } | null>(null)
  const restoreOlderAttemptRef = React.useRef<{
    conversationId: string
    attempts: number
  } | null>(null)
  const olderLoadAnchorRef = React.useRef<{
    conversationId: string
    messageCount: number
    scrollHeight: number
    scrollTop: number
  } | null>(null)

  // minHeight approach: streaming bubble / last AI message gets minHeight to push
  // user message to the top and give AI room to respond.
  const [minHeight, setMinHeight] = React.useState(
    () => readSavedMinHeightState(state.activeConversationId).minHeight
  )
  const [minHeightMsgId, setMinHeightMsgId] = React.useState<string | null>(
    () => readSavedMinHeightState(state.activeConversationId).minHeightMsgId
  )
  // null  → streaming bubble holds the minHeight
  // string → committed AI message with that id holds it
  const minHeightActiveRef = React.useRef(minHeight > 0) // mirrors minHeight > 0 for use in effects
  const followStreamingRef = React.useRef(false) // user clicked scroll-btn during streaming

  const [previewAttachment, setPreviewAttachment] =
    React.useState<Attachment | null>(null)

  React.useEffect(() => {
    minHeightActiveRef.current = minHeight > 0
  }, [minHeight])

  const [artifact, setArtifact] = React.useState<ArtifactState | null>(
    () => readSavedArtifactState(state.activeConversationId).artifact
  )
  const [artifactOpen, setArtifactOpen] = React.useState(
    () => readSavedArtifactState(state.activeConversationId).artifactOpen
  )
  const [genArtifact, setGenArtifact] = React.useState<ArtifactRow | null>(null)
  const [showScrollBtn, setShowScrollBtn] = React.useState(false)
  const [isRestoringScroll, setIsRestoringScroll] = React.useState(false)
  const [isScrollJumpFading, setIsScrollJumpFading] = React.useState(false)
  const [isScrollbarVisible, setIsScrollbarVisible] = React.useState(false)
  const [isScrollbarSuppressed, setIsScrollbarSuppressed] =
    React.useState(false)
  const showScrollBtnRef = React.useRef(false)
  const scrollbarVisibleRef = React.useRef(false)
  const scrollbarSuppressedRef = React.useRef(false)
  const scrollbarFadeTimeoutRef = React.useRef<number | null>(null)
  const scrollJumpFadeTimeoutRef = React.useRef<number | null>(null)
  const scrollJumpFadeReleaseTimeoutRef = React.useRef<number | null>(null)
  const scrollButtonLockedUntilStreamingEndRef = React.useRef(false)
  const [inputOffset, setInputOffset] = React.useState(88)
  const keyboardInset = useMobileKeyboardInset()
  const lastDistanceFromBottomRef = React.useRef(Number.POSITIVE_INFINITY)
  const [artifactPanelWidth, setArtifactPanelWidth] = React.useState(
    ARTIFACT_PANEL_DEFAULT_WIDTH
  )
  const [isResizingArtifactPanel, setIsResizingArtifactPanel] =
    React.useState(false)
  const { open: sidebarOpen, setOpen: setSidebarOpen, isMobile } = useSidebar()
  const activeConversation = state.conversations.find(
    (conversation) => conversation.id === state.activeConversationId
  )
  const conversationId = activeConversation?.id ?? null
  const isStreamingThisConversation = Boolean(
    conversationId &&
    state.isStreaming &&
    state.streamingConversationId === conversationId
  )
  const isStreamingThisConversationRef = React.useRef(false)
  const messageCount = activeConversation?.messages.length ?? 0
  const messagePage = conversationId
    ? state.conversationMessagePages[conversationId]
    : undefined
  const isInitialMessagesLoading = Boolean(
    conversationId &&
    state.conversationLoadState[conversationId] === "loading" &&
    messageCount === 0
  )
  const hasOlderMessages = Boolean(messagePage?.hasMore)
  const isLoadingOlderMessages = Boolean(messagePage?.isLoadingOlder)
  const olderMessagesError = messagePage?.error
  const totalMessageCount =
    messagePage?.total ?? activeConversation?.messageCount ?? messageCount
  const loadedMessageCount = messagePage?.loadedCount ?? messageCount
  const latestAssistantMessageId = React.useMemo(() => {
    const messages = activeConversation?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id
    }
    return null
  }, [activeConversation?.messages])
  const activeStreamingMessageId =
    isStreamingThisConversation && conversationId
      ? (state.streamingMessageId ??
        state.activeChatStreams[conversationId]?.messageId ??
        latestAssistantMessageId)
      : null
  const activeStreamingMessageIdRef = React.useRef<string | null>(null)

  React.useLayoutEffect(() => {
    isStreamingThisConversationRef.current = isStreamingThisConversation
    activeStreamingMessageIdRef.current = activeStreamingMessageId
  }, [activeStreamingMessageId, isStreamingThisConversation])

  const hasStreamingPayload = React.useMemo(
    () =>
      isStreamingThisConversation &&
      (state.streamingReasoning.length > 0 ||
        state.streamingContent.length > 0 ||
        state.streamingContentSegments.some(
          (segment) => segment.content.length > 0
        )),
    [
      isStreamingThisConversation,
      state.streamingContent,
      state.streamingContentSegments,
      state.streamingReasoning,
    ]
  )
  const activeInProgressAssistantMessage = React.useMemo(() => {
    const messages = activeConversation?.messages ?? []
    const lastMessage = messages[messages.length - 1]
    if (!isAssistantMessageInProgress(lastMessage)) {
      return null
    }
    return hasAssistantProgress(lastMessage) ? lastMessage : null
  }, [activeConversation?.messages])
  const hasInProgressAssistantProgress = Boolean(
    activeInProgressAssistantMessage
  )
  const shouldUseStreamingBubbleForActiveAssistant = Boolean(
    isStreamingThisConversation &&
    hasStreamingPayload &&
    activeInProgressAssistantMessage &&
    activeStreamingMessageId &&
    activeInProgressAssistantMessage.id === activeStreamingMessageId
  )
  const showInitialStreamingCursor =
    isStreamingThisConversation &&
    !hasStreamingPayload &&
    !hasInProgressAssistantProgress
  const showLiveStreamingBubble = Boolean(
    isStreamingThisConversation &&
    (!hasInProgressAssistantProgress || hasStreamingPayload)
  )
  // Keep streaming bubble alive until the committed message is ready to take
  // over the tail spacer (prevents layout flash on streaming end).
  const showStreamingBubble = Boolean(
    activeConversation &&
    (showLiveStreamingBubble ||
      (minHeight > 0 &&
        minHeightMsgId === null &&
        !hasInProgressAssistantProgress)) &&
    state.activeConversationId === activeConversation.id
  )

  const agentRuns = React.useMemo(() => {
    const runs: AgentCallReasoningEntry[] = []
    for (const message of activeConversation?.messages ?? []) {
      runs.push(...collectAgentRuns(message.reasoning))
    }
    if (isStreamingThisConversation) {
      runs.push(...collectAgentRuns(state.streamingReasoning))
    }
    const byId = new Map<string, AgentCallReasoningEntry>()
    for (const run of runs) byId.set(run.runId, run)
    return Array.from(byId.values())
  }, [
    activeConversation?.messages,
    isStreamingThisConversation,
    state.streamingReasoning,
  ])
  const [activeAgentRunId, setActiveAgentRunId] = React.useState<string | null>(
    null
  )
  const activeAgentRun = React.useMemo(
    () => agentRuns.find((run) => run.runId === activeAgentRunId) ?? null,
    [agentRuns, activeAgentRunId]
  )
  const [cachedActiveAgentRun, setCachedActiveAgentRun] = React.useState<{
    conversationId: string | null
    run: AgentCallReasoningEntry
  } | null>(null)
  const activePanelAgentRun =
    activeAgentRun ??
    (activeAgentRunId &&
    cachedActiveAgentRun?.conversationId === conversationId &&
    cachedActiveAgentRun.run.runId === activeAgentRunId
      ? cachedActiveAgentRun.run
      : null)
  const activeChildAgentRun = React.useMemo(
    () =>
      activePanelAgentRun
        ? agentRuns.find((run) => run.parentRunId === activePanelAgentRun.runId)
        : undefined,
    [agentRuns, activePanelAgentRun]
  )

  React.useEffect(() => {
    if (activeAgentRun) {
      setCachedActiveAgentRun((current) =>
        current?.conversationId === conversationId &&
        current.run === activeAgentRun
          ? current
          : { conversationId, run: activeAgentRun }
      )
    } else if (!activeAgentRunId) {
      setCachedActiveAgentRun(null)
    }
  }, [activeAgentRun, activeAgentRunId, conversationId])

  // ChatView is intentionally NOT remounted on conversation switch (no `key`
  // in page.tsx) — remounting re-parses every message's markdown and re-imports
  // Shiki, which costs ~5s on mobile. Most per-conversation state already
  // resets via effects/refs keyed on conversationId (scroll restore, artifact
  // panel width, the gen-artifact fetch). This effect closes the remaining gap:
  // state that the mount initializers seed and nothing else re-derives on a
  // switch. It runs before paint (layout effect) and before the scroll-restore
  // layout effect below, so geometry is correct when restore reads it. Skips
  // the first mount — the useState initializers already handled that.
  const resetPrevConversationIdRef = React.useRef(conversationId)
  React.useLayoutEffect(() => {
    if (resetPrevConversationIdRef.current === conversationId) return
    resetPrevConversationIdRef.current = conversationId
    if (!conversationId) return

    const savedMinHeight = readSavedMinHeightState(conversationId)
    setMinHeight(savedMinHeight.minHeight)
    setMinHeightMsgId(savedMinHeight.minHeightMsgId)

    const savedArtifact = readSavedArtifactState(conversationId)
    setArtifact(savedArtifact.artifact)
    setArtifactOpen(savedArtifact.artifactOpen)
    // The conversation-keyed fetch effect re-populates this if the new chat
    // has a saved gen-artifact; clearing first prevents the previous chat's
    // panel from lingering when the new one has none.
    setGenArtifact(null)
    setActiveAgentRunId(null)
    setPreviewAttachment(null)

    // Mirror a fresh mount for the transient scroll bookkeeping the
    // scroll-restore effect expects clean for a new conversation.
    restoreOlderAttemptRef.current = null
    olderLoadAnchorRef.current = null
    olderLoadRequestedRef.current = false
    streamingScrollAnchorRef.current = null
    wasStreamingRef.current = false
    wasStreamingLayoutRef.current = false
  }, [conversationId])

  const scrollToBottom = React.useCallback(
    (behavior: ScrollBehavior = "smooth", options?: { settle?: boolean }) => {
      const element = scrollContainerRef.current
      if (!element) return
      const setToBottom = () => {
        element.scrollTop = Math.max(
          0,
          element.scrollHeight - element.clientHeight
        )
      }
      if (behavior !== "smooth") {
        setToBottom()
        window.requestAnimationFrame(setToBottom)
        return
      }
      const target = element.scrollHeight - element.clientHeight
      const distance = Math.abs(target - element.scrollTop)
      try {
        element.scrollTo({ top: target, behavior: "smooth" })
      } catch {
        element.scrollTop = target
      }
      const shouldSettle =
        options?.settle ?? distance > SCROLL_BUTTON_FADE_DISTANCE_PX
      if (shouldSettle) {
        window.setTimeout(() => {
          const remaining =
            element.scrollHeight - element.scrollTop - element.clientHeight
          if (remaining > 2) setToBottom()
        }, MESSAGE_ANCHOR_SCROLL_DURATION_MS)
      }
    },
    []
  )

  const getTailResponseMinHeight = React.useCallback(
    (userMessageId: string, responseElement?: HTMLElement | null) => {
      const scrollElement = scrollContainerRef.current
      const userElement = document.getElementById(`message-${userMessageId}`)
      if (!scrollElement || !userElement) return 0

      const userRect = userElement.getBoundingClientRect()
      const responseRect = responseElement?.getBoundingClientRect()
      const gapAfterUser = responseRect
        ? Math.max(0, Math.round(responseRect.top - userRect.bottom))
        : MESSAGE_VERTICAL_GAP
      const bottomPadding = inputOffset + 24
      const neededAfterUser =
        scrollElement.clientHeight -
        MESSAGE_ANCHOR_TOP_OFFSET -
        Math.ceil(userRect.height) -
        gapAfterUser -
        bottomPadding

      return Math.max(0, Math.ceil(neededAfterUser))
    },
    [inputOffset]
  )

  const getCommittedTailSpacer = React.useCallback(
    (userMessageId: string, responseElement: HTMLElement) => {
      const minResponseHeight = getTailResponseMinHeight(
        userMessageId,
        responseElement
      )
      return Math.max(
        0,
        minResponseHeight - getElementContentHeight(responseElement)
      )
    },
    [getTailResponseMinHeight]
  )

  const activeIdRef = React.useRef(state.activeConversationId)
  const pendingScrollSaveRef = React.useRef<{
    conversationId: string
    value: string
  } | null>(null)
  const scrollSaveTimeoutRef = React.useRef<number | null>(null)
  React.useEffect(() => {
    activeIdRef.current = state.activeConversationId
  }, [state.activeConversationId])

  const setScrollButtonVisible = React.useCallback((visible: boolean) => {
    if (showScrollBtnRef.current === visible) return
    showScrollBtnRef.current = visible
    setShowScrollBtn(visible)
  }, [])

  const setProgrammaticScrollbarSuppressed = React.useCallback(
    (suppressed: boolean) => {
      if (scrollbarSuppressedRef.current === suppressed) return
      scrollbarSuppressedRef.current = suppressed
      setIsScrollbarSuppressed(suppressed)

      if (suppressed) {
        if (scrollbarFadeTimeoutRef.current !== null) {
          window.clearTimeout(scrollbarFadeTimeoutRef.current)
          scrollbarFadeTimeoutRef.current = null
        }
        scrollbarVisibleRef.current = false
        setIsScrollbarVisible(false)
      }
    },
    []
  )

  const revealScrollbar = React.useCallback(() => {
    if (scrollbarSuppressedRef.current) return

    if (!scrollbarVisibleRef.current) {
      scrollbarVisibleRef.current = true
      setIsScrollbarVisible(true)
    }

    if (scrollbarFadeTimeoutRef.current !== null) {
      window.clearTimeout(scrollbarFadeTimeoutRef.current)
    }

    scrollbarFadeTimeoutRef.current = window.setTimeout(() => {
      scrollbarVisibleRef.current = false
      scrollbarFadeTimeoutRef.current = null
      setIsScrollbarVisible(false)
    }, 900)
  }, [])

  const requestOlderMessages = React.useCallback(() => {
    if (
      !conversationId ||
      !hasOlderMessages ||
      isLoadingOlderMessages ||
      olderLoadRequestedRef.current
    ) {
      return
    }

    const element = scrollContainerRef.current
    if (element) {
      olderLoadAnchorRef.current = {
        conversationId,
        messageCount,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
      }
    }

    olderLoadRequestedRef.current = true
    void loadOlderMessages(conversationId).finally(() => {
      olderLoadRequestedRef.current = false
    })
  }, [
    conversationId,
    hasOlderMessages,
    isLoadingOlderMessages,
    loadOlderMessages,
    messageCount,
  ])

  const requestOlderMessagesForRestore = React.useCallback(() => {
    if (
      !conversationId ||
      !hasOlderMessages ||
      isLoadingOlderMessages ||
      olderLoadRequestedRef.current
    ) {
      return false
    }

    olderLoadRequestedRef.current = true
    void loadOlderMessages(conversationId).finally(() => {
      olderLoadRequestedRef.current = false
    })
    return true
  }, [
    conversationId,
    hasOlderMessages,
    isLoadingOlderMessages,
    loadOlderMessages,
  ])

  const flushPendingScrollSave = React.useCallback(() => {
    const pending = pendingScrollSaveRef.current
    if (!pending) return
    pendingScrollSaveRef.current = null
    localStorage.setItem(`scroll:chat:${pending.conversationId}`, pending.value)
  }, [])

  const scheduleScrollSave = React.useCallback(
    (value: string) => {
      const conversationId = activeIdRef.current
      if (!conversationId) return
      localStorage.setItem(`scroll:chat:${conversationId}`, value)
      pendingScrollSaveRef.current = {
        conversationId,
        value,
      }
      if (scrollSaveTimeoutRef.current !== null) return
      scrollSaveTimeoutRef.current = window.setTimeout(() => {
        scrollSaveTimeoutRef.current = null
        flushPendingScrollSave()
      }, 160)
    },
    [flushPendingScrollSave]
  )

  const getCurrentScrollAnchor = React.useCallback(() => {
    const element = scrollContainerRef.current
    if (!element) return null
    if (element.scrollHeight <= element.clientHeight) return null

    const elementRect = element.getBoundingClientRect()
    const messageElements = Array.from(
      element.querySelectorAll<HTMLElement>('[id^="message-"]')
    )
    if (messageElements.length === 0) return null

    const anchorElement =
      messageElements.find((messageElement) => {
        const rect = messageElement.getBoundingClientRect()
        return rect.bottom >= elementRect.top + SCROLL_RESTORE_TOP_OFFSET
      }) ?? messageElements.at(-1)

    if (!anchorElement?.id.startsWith("message-")) return null
    const anchorRect = anchorElement.getBoundingClientRect()
    const distanceFromBottom = Math.max(
      0,
      element.scrollHeight - element.scrollTop - element.clientHeight
    )
    return {
      messageId: anchorElement.id.slice("message-".length),
      offset: Math.round(anchorRect.top - elementRect.top),
      scrollTop: Math.round(element.scrollTop),
      distanceFromBottom: Math.round(distanceFromBottom),
      savedAt: Date.now(),
    }
  }, [])

  const saveScrollAnchor = React.useCallback(() => {
    const conversationId = activeIdRef.current
    const payload = getCurrentScrollAnchor()
    if (!conversationId || !payload) return false
    localStorage.setItem(
      `${SCROLL_ANCHOR_STORAGE_PREFIX}:${conversationId}`,
      JSON.stringify(payload)
    )
    localStorage.setItem(
      `${SCROLL_RESTORE_STORAGE_PREFIX}:${conversationId}`,
      JSON.stringify(payload)
    )
    return true
  }, [getCurrentScrollAnchor])

  const restoreScrollAnchor = React.useCallback(
    (anchor: SavedScrollRestore) => {
      const element = scrollContainerRef.current
      if (!element) return false

      const anchorElement = document.getElementById(
        `message-${anchor.messageId}`
      )
      const maxScrollTop = Math.max(
        0,
        element.scrollHeight - element.clientHeight
      )
      const anchorScrollTop = anchorElement
        ? Math.max(
            0,
            anchorElement.getBoundingClientRect().top -
              element.getBoundingClientRect().top +
              element.scrollTop -
              anchor.offset
          )
        : null
      const targetScrollTop =
        anchorScrollTop != null
          ? Math.min(anchorScrollTop, maxScrollTop)
          : Math.min(Math.max(0, anchor.scrollTop), maxScrollTop)

      element.scrollTop = targetScrollTop
      return true
    },
    []
  )

  React.useEffect(() => {
    const flushCurrentScroll = () => {
      const conversationId = activeIdRef.current
      const element = scrollContainerRef.current
      if (!conversationId || !element) return
      if (
        element.scrollHeight <= element.clientHeight ||
        !element.querySelector('[id^="message-"]')
      ) {
        return
      }
      const didSaveAnchor = saveScrollAnchor()
      if (!didSaveAnchor) return
      const distanceFromBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight
      localStorage.setItem(
        `scroll:chat:${conversationId}`,
        distanceFromBottom <= STICKY_BOTTOM_THRESHOLD
          ? SCROLL_BOTTOM_SENTINEL
          : Math.round(element.scrollTop).toString()
      )
    }

    window.addEventListener("pagehide", flushCurrentScroll)
    window.addEventListener("beforeunload", flushCurrentScroll)

    return () => {
      window.removeEventListener("pagehide", flushCurrentScroll)
      window.removeEventListener("beforeunload", flushCurrentScroll)

      if (scrollSaveTimeoutRef.current !== null) {
        window.clearTimeout(scrollSaveTimeoutRef.current)
        scrollSaveTimeoutRef.current = null
      }
      if (messageTopAnchorFrameIdRef.current !== null) {
        window.cancelAnimationFrame(messageTopAnchorFrameIdRef.current)
        messageTopAnchorFrameIdRef.current = null
      }
      if (messageTopAnchorReleaseTimeoutRef.current !== null) {
        window.clearTimeout(messageTopAnchorReleaseTimeoutRef.current)
        messageTopAnchorReleaseTimeoutRef.current = null
      }
      messageTopAnchorMessageIdRef.current = null
      messageTopAnchorStartedAtRef.current = 0
      if (scrollJumpFadeTimeoutRef.current !== null) {
        window.clearTimeout(scrollJumpFadeTimeoutRef.current)
        scrollJumpFadeTimeoutRef.current = null
      }
      if (scrollJumpFadeReleaseTimeoutRef.current !== null) {
        window.clearTimeout(scrollJumpFadeReleaseTimeoutRef.current)
        scrollJumpFadeReleaseTimeoutRef.current = null
      }
      if (scrollbarFadeTimeoutRef.current !== null) {
        window.clearTimeout(scrollbarFadeTimeoutRef.current)
        scrollbarFadeTimeoutRef.current = null
      }
      scrollbarVisibleRef.current = false
      scrollbarSuppressedRef.current = false
      scrollButtonLockedUntilStreamingEndRef.current = false
      flushPendingScrollSave()
    }
  }, [flushPendingScrollSave, saveScrollAnchor])

  const syncScrollState = React.useCallback(() => {
    const element = scrollContainerRef.current
    if (!element) return

    revealScrollbar()

    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight
    lastDistanceFromBottomRef.current = distanceFromBottom
    const isPinnedToBottom = distanceFromBottom <= STICKY_BOTTOM_THRESHOLD

    if (activeIdRef.current && !ignoreSyncRef.current) {
      // Guard against the browser triggering passive layout-shift scroll events
      // when the container height is tiny or still rendering, which was poisoning the cache with `0`.
      if (element.scrollHeight > element.clientHeight) {
        saveScrollAnchor()
        scheduleScrollSave(
          isPinnedToBottom
            ? SCROLL_BOTTOM_SENTINEL
            : Math.round(element.scrollTop).toString()
        )
      }
    }

    const activeConversationId = activeIdRef.current
    if (
      activeConversationId &&
      isStreamingThisConversationRef.current &&
      !ignoreSyncRef.current &&
      element.scrollHeight > element.clientHeight
    ) {
      if (isPinnedToBottom) {
        streamingScrollAnchorRef.current = null
      } else {
        const anchor = getCurrentScrollAnchor()
        if (anchor) {
          streamingScrollAnchorRef.current = {
            conversationId: activeConversationId,
            streamMessageId: activeStreamingMessageIdRef.current,
            anchor,
          }
        }
      }
    }

    if (
      !isPinnedToBottom &&
      autoScrollEnabledRef.current &&
      !ignoreSyncRef.current
    ) {
      autoScrollEnabledRef.current = false
      followStreamingRef.current = false
    }

    if (!ignoreSyncRef.current && !suppressBtnRef.current) {
      setScrollButtonVisible(!autoScrollEnabledRef.current && !isPinnedToBottom)
    }
  }, [
    getCurrentScrollAnchor,
    revealScrollbar,
    saveScrollAnchor,
    scheduleScrollSave,
    setScrollButtonVisible,
  ])

  const scrollMessageToTop = React.useCallback(
    (messageId: string, behavior: ScrollBehavior = "auto") => {
      const element = scrollContainerRef.current
      const messageElement = document.getElementById(`message-${messageId}`)
      if (!element || !messageElement) return false

      const elementRect = element.getBoundingClientRect()
      const messageRect = messageElement.getBoundingClientRect()
      const messageTop = messageRect.top - elementRect.top + element.scrollTop
      const targetScrollTop = Math.max(
        0,
        messageTop - MESSAGE_ANCHOR_TOP_OFFSET
      )
      const maxScrollTop = Math.max(
        0,
        element.scrollHeight - element.clientHeight
      )
      if (maxScrollTop + 4 < targetScrollTop) return false

      const nextTop = Math.min(targetScrollTop, maxScrollTop)
      if (behavior === "smooth") {
        if (Math.abs(nextTop - element.scrollTop) <= 2) {
          element.scrollTop = nextTop
          return true
        }
        try {
          element.scrollTo({ top: nextTop, behavior: "smooth" })
        } catch {
          element.scrollTop = nextTop
        }
        return true
      }

      element.scrollTop = nextTop
      return true
    },
    []
  )

  const isMessageNearTopAnchor = React.useCallback(
    (messageId: string, tolerance = 96) => {
      const element = scrollContainerRef.current
      const messageElement = document.getElementById(`message-${messageId}`)
      if (!element || !messageElement) return false

      const currentTop =
        messageElement.getBoundingClientRect().top -
        element.getBoundingClientRect().top
      return Math.abs(currentTop - MESSAGE_ANCHOR_TOP_OFFSET) <= tolerance
    },
    []
  )

  const scheduleMessageTopAnchor = React.useCallback(
    (messageId: string) => {
      const releaseAnchor = (delay: number) => {
        if (messageTopAnchorReleaseTimeoutRef.current !== null) {
          window.clearTimeout(messageTopAnchorReleaseTimeoutRef.current)
        }
        messageTopAnchorReleaseTimeoutRef.current = window.setTimeout(() => {
          messageTopAnchorReleaseTimeoutRef.current = null
          if (isMessageNearTopAnchor(messageId, 140)) {
            scrollMessageToTop(messageId, "auto")
          }
          if (messageTopAnchorMessageIdRef.current === messageId) {
            messageTopAnchorMessageIdRef.current = null
            messageTopAnchorStartedAtRef.current = 0
          }
          ignoreSyncRef.current = false
          syncScrollState()
        }, delay)
      }

      const isSameAnchorPending =
        messageTopAnchorMessageIdRef.current === messageId &&
        (messageTopAnchorFrameIdRef.current !== null ||
          messageTopAnchorReleaseTimeoutRef.current !== null)

      if (isSameAnchorPending) {
        ignoreSyncRef.current = true
        if (messageTopAnchorReleaseTimeoutRef.current !== null) {
          const elapsed =
            messageTopAnchorStartedAtRef.current > 0
              ? performance.now() - messageTopAnchorStartedAtRef.current
              : 0
          releaseAnchor(
            Math.max(80, MESSAGE_ANCHOR_SCROLL_DURATION_MS - elapsed)
          )
        }
        return
      }

      if (messageTopAnchorFrameIdRef.current !== null) {
        window.cancelAnimationFrame(messageTopAnchorFrameIdRef.current)
        messageTopAnchorFrameIdRef.current = null
      }
      if (messageTopAnchorReleaseTimeoutRef.current !== null) {
        window.clearTimeout(messageTopAnchorReleaseTimeoutRef.current)
        messageTopAnchorReleaseTimeoutRef.current = null
      }

      ignoreSyncRef.current = true
      messageTopAnchorMessageIdRef.current = messageId
      messageTopAnchorStartedAtRef.current = 0
      let attempts = 0
      let animationStarted = false
      const run = () => {
        const didStart = scrollMessageToTop(
          messageId,
          animationStarted ? "auto" : "smooth"
        )

        if (!didStart && attempts < 120) {
          attempts += 1
          messageTopAnchorFrameIdRef.current = window.requestAnimationFrame(run)
          return
        }

        animationStarted = true
        if (messageTopAnchorStartedAtRef.current === 0) {
          messageTopAnchorStartedAtRef.current = performance.now()
        }
        messageTopAnchorFrameIdRef.current = null
        releaseAnchor(MESSAGE_ANCHOR_SCROLL_DURATION_MS)
      }

      messageTopAnchorFrameIdRef.current = window.requestAnimationFrame(run)
    },
    [isMessageNearTopAnchor, scrollMessageToTop, syncScrollState]
  )

  const cancelMessageTopAnchor = React.useCallback(() => {
    if (
      messageTopAnchorFrameIdRef.current === null &&
      messageTopAnchorReleaseTimeoutRef.current === null
    ) {
      return
    }
    if (messageTopAnchorFrameIdRef.current !== null) {
      window.cancelAnimationFrame(messageTopAnchorFrameIdRef.current)
      messageTopAnchorFrameIdRef.current = null
    }
    if (messageTopAnchorReleaseTimeoutRef.current !== null) {
      window.clearTimeout(messageTopAnchorReleaseTimeoutRef.current)
      messageTopAnchorReleaseTimeoutRef.current = null
    }
    messageTopAnchorMessageIdRef.current = null
    messageTopAnchorStartedAtRef.current = 0
    ignoreSyncRef.current = false
    syncScrollState()
  }, [syncScrollState])

  React.useEffect(() => {
    const element = scrollContainerRef.current
    if (!element) return

    syncScrollState()
    element.addEventListener("scroll", syncScrollState, { passive: true })
    element.addEventListener("wheel", cancelMessageTopAnchor, { passive: true })
    element.addEventListener("touchmove", cancelMessageTopAnchor, {
      passive: true,
    })

    const stopAutoscroll = () => {
      autoScrollEnabledRef.current = false
      followStreamingRef.current = false
      cancelMessageTopAnchor()
    }
    window.addEventListener("stop-chat-autoscroll", stopAutoscroll)

    return () => {
      element.removeEventListener("scroll", syncScrollState)
      element.removeEventListener("wheel", cancelMessageTopAnchor)
      element.removeEventListener("touchmove", cancelMessageTopAnchor)
      window.removeEventListener("stop-chat-autoscroll", stopAutoscroll)
    }
  }, [cancelMessageTopAnchor, syncScrollState, conversationId])

  React.useEffect(() => {
    const element = scrollContainerRef.current
    if (!element) return

    let previousClientHeight = element.clientHeight
    let frame: number | null = null
    const observer = new ResizeObserver(() => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        const nextClientHeight = element.clientHeight
        if (Math.abs(nextClientHeight - previousClientHeight) <= 1) return
        previousClientHeight = nextClientHeight

        if (
          lastDistanceFromBottomRef.current <= STICKY_BOTTOM_THRESHOLD ||
          autoScrollEnabledRef.current
        ) {
          scrollToBottom("auto")
        }
        syncScrollState()
      })
    })

    observer.observe(element)

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [conversationId, scrollToBottom, syncScrollState])

  React.useLayoutEffect(() => {
    const anchor = olderLoadAnchorRef.current
    if (!anchor) return
    if (!conversationId || anchor.conversationId !== conversationId) {
      olderLoadAnchorRef.current = null
      return
    }
    if (isLoadingOlderMessages && messageCount <= anchor.messageCount) return

    const element = scrollContainerRef.current
    olderLoadAnchorRef.current = null
    if (!element || messageCount <= anchor.messageCount) return

    const frame = window.requestAnimationFrame(() => {
      const delta = element.scrollHeight - anchor.scrollHeight
      element.scrollTop = Math.max(0, anchor.scrollTop + delta)
      syncScrollState()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [conversationId, isLoadingOlderMessages, messageCount, syncScrollState])

  React.useLayoutEffect(() => {
    const element = scrollContainerRef.current
    if (!element) return

    if (
      lastDistanceFromBottomRef.current <= STICKY_BOTTOM_THRESHOLD ||
      autoScrollEnabledRef.current
    ) {
      scrollToBottom("auto")
      syncScrollState()
      return
    }

    syncScrollState()
  }, [keyboardInset, scrollToBottom, syncScrollState])

  React.useEffect(() => {
    const element = inputContainerRef.current
    if (!element) return

    const updateOffset = () =>
      setInputOffset(element.getBoundingClientRect().height + 16)
    updateOffset()

    const observer = new ResizeObserver(updateOffset)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  React.useLayoutEffect(() => {
    if (
      !conversationId ||
      !isStreamingThisConversation ||
      minHeightMsgId !== null
    )
      return
    if (shouldUseStreamingBubbleForActiveAssistant) return
    const messages = activeConversation?.messages ?? []
    const lastMsg = messages[messages.length - 1]
    const previousMsg = messages[messages.length - 2]
    if (
      !isAssistantMessageInProgress(lastMsg) ||
      !hasAssistantProgress(lastMsg) ||
      previousMsg?.role !== "user"
    )
      return

    const assistantElement = document.getElementById(`message-${lastMsg.id}`)
    const nextSpacer =
      assistantElement instanceof HTMLElement
        ? getCommittedTailSpacer(previousMsg.id, assistantElement)
        : minHeight

    minHeightActiveRef.current = nextSpacer > 0
    setMinHeightMsgId(lastMsg.id)
    setMinHeight(nextSpacer)
    localStorage.setItem(
      `chat:minHeight:${conversationId}`,
      JSON.stringify({
        minHeight: nextSpacer,
        minHeightMsgId: lastMsg.id,
        viewportHeight: window.innerHeight,
      })
    )
    if (
      restoredScrollConversationRef.current === conversationId &&
      isMessageNearTopAnchor(previousMsg.id)
    ) {
      scheduleMessageTopAnchor(previousMsg.id)
    }
  }, [
    activeConversation?.messages,
    conversationId,
    getCommittedTailSpacer,
    isMessageNearTopAnchor,
    isStreamingThisConversation,
    minHeight,
    minHeightMsgId,
    scheduleMessageTopAnchor,
    shouldUseStreamingBubbleForActiveAssistant,
  ])

  React.useLayoutEffect(() => {
    if (!conversationId || !isStreamingThisConversation) return
    if (minHeightMsgId !== null && !shouldUseStreamingBubbleForActiveAssistant)
      return
    const messages = activeConversation?.messages ?? []
    const lastMsg = messages[messages.length - 1]
    const previousMsg = messages[messages.length - 2]
    const tailUserMessage = shouldUseStreamingBubbleForActiveAssistant
      ? previousMsg
      : lastMsg
    if (tailUserMessage?.role !== "user") return

    const nextMinHeight = getTailResponseMinHeight(
      tailUserMessage.id,
      streamingBubbleContainerRef.current
    )
    minHeightActiveRef.current = nextMinHeight > 0
    if (
      minHeightMsgId === null &&
      Math.abs(nextMinHeight - minHeight) <= TAIL_SPACER_UPDATE_THRESHOLD_PX
    ) {
      return
    }

    if (minHeightMsgId !== null) setMinHeightMsgId(null)
    setMinHeight(nextMinHeight)
    localStorage.setItem(
      `chat:minHeight:${conversationId}`,
      JSON.stringify({
        minHeight: nextMinHeight,
        minHeightMsgId: null,
        viewportHeight: window.innerHeight,
      })
    )
    if (
      shouldUseStreamingBubbleForActiveAssistant &&
      restoredScrollConversationRef.current === conversationId &&
      isMessageNearTopAnchor(tailUserMessage.id)
    ) {
      scheduleMessageTopAnchor(tailUserMessage.id)
    }
  }, [
    activeConversation?.messages,
    conversationId,
    getTailResponseMinHeight,
    isMessageNearTopAnchor,
    isStreamingThisConversation,
    minHeight,
    minHeightMsgId,
    scheduleMessageTopAnchor,
    shouldUseStreamingBubbleForActiveAssistant,
    state.streamingContent,
    state.streamingContentSegments,
    state.streamingReasoning,
  ])

  // Transfer the streaming spacer to the committed assistant message before
  // paint, so the scrollbar does not briefly resize at stream end.
  React.useLayoutEffect(() => {
    if (
      isStreamingThisConversation ||
      minHeight === 0 ||
      minHeightMsgId !== null
    )
      return
    const messages = activeConversation?.messages ?? []
    const lastMsg = messages[messages.length - 1]
    const previousMsg = messages[messages.length - 2]
    if (lastMsg?.role === "assistant" && previousMsg?.role === "user") {
      const assistantElement = document.getElementById(`message-${lastMsg.id}`)
      const nextSpacer =
        assistantElement instanceof HTMLElement
          ? getCommittedTailSpacer(previousMsg.id, assistantElement)
          : 0

      setMinHeightMsgId(lastMsg.id)
      setMinHeight(nextSpacer)
      if (conversationId) {
        localStorage.setItem(
          `chat:minHeight:${conversationId}`,
          JSON.stringify({
            minHeight: nextSpacer,
            minHeightMsgId: lastMsg.id,
            viewportHeight: window.innerHeight,
          })
        )
      }
      if (
        restoredScrollConversationRef.current === conversationId &&
        isMessageNearTopAnchor(previousMsg.id)
      ) {
        scheduleMessageTopAnchor(previousMsg.id)
      }
    }
  }, [
    activeConversation?.messages,
    conversationId,
    getCommittedTailSpacer,
    isMessageNearTopAnchor,
    isStreamingThisConversation,
    minHeight,
    minHeightMsgId,
    scheduleMessageTopAnchor,
  ])

  React.useLayoutEffect(() => {
    if (!conversationId || isStreamingThisConversation || showStreamingBubble)
      return
    const messages = activeConversation?.messages ?? []
    const lastMsg = messages[messages.length - 1]
    const previousMsg = messages[messages.length - 2]

    const clearTailSpacer = () => {
      if (minHeight !== 0) setMinHeight(0)
      if (minHeightMsgId !== null) setMinHeightMsgId(null)
      localStorage.removeItem(`chat:minHeight:${conversationId}`)
    }

    if (
      !lastMsg ||
      lastMsg.role !== "assistant" ||
      !previousMsg ||
      previousMsg.role !== "user"
    ) {
      clearTailSpacer()
      return
    }

    const assistantElement = document.getElementById(`message-${lastMsg.id}`)
    if (!(assistantElement instanceof HTMLElement)) return

    const nextSpacer = getCommittedTailSpacer(previousMsg.id, assistantElement)

    if (lastMsg.id !== minHeightMsgId || Math.abs(nextSpacer - minHeight) > 8) {
      setMinHeightMsgId(lastMsg.id)
      setMinHeight(nextSpacer)
      localStorage.setItem(
        `chat:minHeight:${conversationId}`,
        JSON.stringify({
          minHeight: nextSpacer,
          minHeightMsgId: lastMsg.id,
          viewportHeight: window.innerHeight,
        })
      )
      if (
        restoredScrollConversationRef.current === conversationId &&
        isMessageNearTopAnchor(previousMsg.id)
      ) {
        scheduleMessageTopAnchor(previousMsg.id)
      }
    }
  }, [
    activeConversation?.messages,
    conversationId,
    getCommittedTailSpacer,
    isMessageNearTopAnchor,
    minHeight,
    minHeightMsgId,
    scheduleMessageTopAnchor,
    showStreamingBubble,
    isStreamingThisConversation,
  ])

  // Finishing a resumed stream can resize the tail spacer before the browser's
  // own scroll anchoring settles. If the user was reading above bottom, keep
  // that message anchored instead of letting the final row pull the view down.
  React.useLayoutEffect(() => {
    const streamingFinished =
      wasStreamingLayoutRef.current && !isStreamingThisConversation
    wasStreamingLayoutRef.current = isStreamingThisConversation

    if (!streamingFinished || !conversationId) return
    const saved = streamingScrollAnchorRef.current
    streamingScrollAnchorRef.current = null
    if (
      !saved ||
      saved.conversationId !== conversationId ||
      saved.anchor.distanceFromBottom <= STICKY_BOTTOM_THRESHOLD ||
      followStreamingRef.current
    ) {
      return
    }

    ignoreSyncRef.current = true
    const didRestore = restoreScrollAnchor(saved.anchor)
    if (!didRestore) {
      ignoreSyncRef.current = false
      return
    }

    const frame = window.requestAnimationFrame(() => {
      ignoreSyncRef.current = false
      saveScrollAnchor()
      syncScrollState()
    })

    return () => {
      window.cancelAnimationFrame(frame)
      ignoreSyncRef.current = false
    }
  }, [
    conversationId,
    isStreamingThisConversation,
    restoreScrollAnchor,
    saveScrollAnchor,
    syncScrollState,
  ])

  // Restore exactly once per conversation without visible animated scrolling.
  React.useLayoutEffect(() => {
    if (!conversationId) return
    if (restoredScrollConversationRef.current === conversationId) return
    if (messageCount === 0) return

    ignoreSyncRef.current = true
    setIsRestoringScroll(true)
    setScrollButtonVisible(false)
    const savedScroll = localStorage.getItem(`scroll:chat:${conversationId}`)
    const parsedSavedScroll = savedScroll
      ? Number.parseInt(savedScroll, 10)
      : NaN
    const savedAnchorRaw =
      localStorage.getItem(
        `${SCROLL_RESTORE_STORAGE_PREFIX}:${conversationId}`
      ) ??
      localStorage.getItem(`${SCROLL_ANCHOR_STORAGE_PREFIX}:${conversationId}`)
    let savedAnchor: SavedScrollRestore | null = null
    if (savedAnchorRaw) {
      try {
        const parsed = JSON.parse(savedAnchorRaw)
        if (
          parsed &&
          typeof parsed.messageId === "string" &&
          typeof parsed.offset === "number" &&
          typeof parsed.scrollTop === "number"
        ) {
          savedAnchor = {
            messageId: parsed.messageId,
            offset: parsed.offset,
            scrollTop: parsed.scrollTop,
            distanceFromBottom:
              typeof parsed.distanceFromBottom === "number"
                ? parsed.distanceFromBottom
                : Number.POSITIVE_INFINITY,
            savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
          }
        }
      } catch {}
    }

    const hasLegacyNumericScroll =
      !savedAnchor &&
      savedScroll !== null &&
      Number.isFinite(parsedSavedScroll) &&
      parsedSavedScroll > 0
    const shouldPinBottom =
      savedScroll === SCROLL_BOTTOM_SENTINEL ||
      (!savedAnchor && !hasLegacyNumericScroll)
    const shouldRestoreBottom =
      savedScroll === SCROLL_BOTTOM_SENTINEL ||
      (!savedAnchor && !hasLegacyNumericScroll) ||
      Boolean(
        savedAnchor &&
        !hasLegacyNumericScroll &&
        !Number.isFinite(parsedSavedScroll) &&
        savedAnchor.distanceFromBottom <= STICKY_BOTTOM_THRESHOLD
      )

    if (
      savedAnchor &&
      !document.getElementById(`message-${savedAnchor.messageId}`)
    ) {
      const previousAttempt = restoreOlderAttemptRef.current
      const attempts =
        previousAttempt?.conversationId === conversationId
          ? previousAttempt.attempts
          : 0

      if (isLoadingOlderMessages || olderLoadRequestedRef.current) return
      const maxRestoreOlderPages = isMobile
        ? MAX_MOBILE_RESTORE_OLDER_PAGES
        : MAX_RESTORE_OLDER_PAGES
      if (hasOlderMessages && attempts < maxRestoreOlderPages) {
        restoreOlderAttemptRef.current = {
          conversationId,
          attempts: attempts + 1,
        }
        requestOlderMessagesForRestore()
        return
      }
    }

    if (bottomSettleFrameIdRef.current !== null) {
      window.cancelAnimationFrame(bottomSettleFrameIdRef.current)
      bottomSettleFrameIdRef.current = null
    }

    let cancelled = false
    const settleBottom = (remainingFrames: number) => {
      if (cancelled) return
      const element = scrollContainerRef.current
      if (element) {
        element.scrollTop = Math.max(
          0,
          element.scrollHeight - element.clientHeight
        )
      }
      if (remainingFrames <= 0) {
        bottomSettleFrameIdRef.current = null
        setIsRestoringScroll(false)
        saveScrollAnchor()
        syncScrollState()
        return
      }
      bottomSettleFrameIdRef.current = window.requestAnimationFrame(() =>
        settleBottom(remainingFrames - 1)
      )
    }

    const frameId = window.requestAnimationFrame(() => {
      const element = scrollContainerRef.current
      if (!element) {
        ignoreSyncRef.current = false
        setIsRestoringScroll(false)
        return
      }

      const maxScrollTop = Math.max(
        0,
        element.scrollHeight - element.clientHeight
      )
      const anchorElement = savedAnchor
        ? document.getElementById(`message-${savedAnchor.messageId}`)
        : null
      const anchorScrollTop = anchorElement
        ? Math.max(
            0,
            anchorElement.getBoundingClientRect().top -
              element.getBoundingClientRect().top +
              element.scrollTop -
              (savedAnchor?.offset ?? 0)
          )
        : null
      const targetScrollTop = shouldRestoreBottom
        ? maxScrollTop
        : anchorScrollTop != null
          ? Math.min(anchorScrollTop, maxScrollTop)
          : savedAnchor
            ? Math.min(Math.max(0, savedAnchor.scrollTop), maxScrollTop)
            : hasLegacyNumericScroll
              ? Math.min(Math.max(0, parsedSavedScroll), maxScrollTop)
              : maxScrollTop

      element.scrollTop = targetScrollTop
      if (shouldRestoreBottom) {
        bottomSettleFrameIdRef.current = window.requestAnimationFrame(() =>
          settleBottom(3)
        )
      }
      restoredScrollConversationRef.current = conversationId
      setRestoredScrollConversationId(conversationId)
      restoreOlderAttemptRef.current = null
      ignoreSyncRef.current = false
      if (!shouldPinBottom) setIsRestoringScroll(false)
      saveScrollAnchor()
      syncScrollState()
    })

    return () => {
      cancelled = true
      window.cancelAnimationFrame(frameId)
      if (bottomSettleFrameIdRef.current !== null) {
        window.cancelAnimationFrame(bottomSettleFrameIdRef.current)
        bottomSettleFrameIdRef.current = null
      }
      ignoreSyncRef.current = false
      setIsRestoringScroll(false)
    }
  }, [
    conversationId,
    hasOlderMessages,
    isLoadingOlderMessages,
    isMobile,
    messageCount,
    requestOlderMessagesForRestore,
    saveScrollAnchor,
    setScrollButtonVisible,
    syncScrollState,
  ])

  React.useEffect(() => {
    const streamingStarted =
      !wasStreamingRef.current && isStreamingThisConversation
    const streamingFinished =
      wasStreamingRef.current && !isStreamingThisConversation

    wasStreamingRef.current = isStreamingThisConversation

    if (streamingStarted) {
      const currentStreamMessageId = activeStreamingMessageIdRef.current
      if (
        streamingScrollAnchorRef.current?.conversationId !== conversationId ||
        streamingScrollAnchorRef.current.streamMessageId !==
          currentStreamMessageId
      ) {
        streamingScrollAnchorRef.current = null
      }
      setScrollButtonVisible(false)
      suppressBtnRef.current = true
      setTimeout(() => {
        suppressBtnRef.current = false
      }, 300)

      // If we're remounting into a stream we already anchored once, the
      // layout-effect above has restored the user's saved scroll — don't
      // overwrite it with a forced top-anchor on the user message.
      const anchorTakenKey = conversationId
        ? `${STREAM_ANCHOR_TAKEN_PREFIX}:${conversationId}`
        : null
      const alreadyAnchoredStreamId = anchorTakenKey
        ? localStorage.getItem(anchorTakenKey)
        : null
      const isRemountIntoOngoingStream = Boolean(
        currentStreamMessageId &&
          alreadyAnchoredStreamId === currentStreamMessageId
      )

      if (isRemountIntoOngoingStream) {
        autoScrollEnabledRef.current = false
        followStreamingRef.current = false
      } else {
        if (anchorTakenKey && currentStreamMessageId) {
          localStorage.setItem(anchorTakenKey, currentStreamMessageId)
        }

        const messages = activeConversation?.messages || []
        const lastMsg = messages[messages.length - 1]
        const previousMsg = messages[messages.length - 2]

        if (lastMsg?.role === "user") {
          const neededSpace = getTailResponseMinHeight(
            lastMsg.id,
            streamingBubbleContainerRef.current
          )

          minHeightActiveRef.current = neededSpace > 0
          setMinHeightMsgId(null) // streaming bubble takes over
          setMinHeight(neededSpace)

          if (conversationId) {
            localStorage.setItem(
              `chat:minHeight:${conversationId}`,
              JSON.stringify({
                minHeight: neededSpace,
                minHeightMsgId: null,
                viewportHeight: window.innerHeight,
              })
            )
          }

          autoScrollEnabledRef.current = false
          followStreamingRef.current = false
          scheduleMessageTopAnchor(lastMsg.id)
        } else if (
          isAssistantMessageInProgress(lastMsg) &&
          hasAssistantProgress(lastMsg) &&
          previousMsg?.role === "user"
        ) {
          const assistantElement = document.getElementById(
            `message-${lastMsg.id}`
          )
          const neededSpace =
            assistantElement instanceof HTMLElement
              ? getCommittedTailSpacer(previousMsg.id, assistantElement)
              : minHeight

          minHeightActiveRef.current = neededSpace > 0
          setMinHeightMsgId(lastMsg.id)
          setMinHeight(neededSpace)

          if (conversationId) {
            localStorage.setItem(
              `chat:minHeight:${conversationId}`,
              JSON.stringify({
                minHeight: neededSpace,
                minHeightMsgId: lastMsg.id,
                viewportHeight: window.innerHeight,
              })
            )
          }

          autoScrollEnabledRef.current = false
          followStreamingRef.current = false
          scheduleMessageTopAnchor(previousMsg.id)
        } else {
          // Keep manual-follow behavior: do not auto-follow streaming unless
          // the user explicitly taps the scroll button.
          autoScrollEnabledRef.current = false
          followStreamingRef.current = false
          setMinHeight(0)
          setMinHeightMsgId(null)
          if (conversationId)
            localStorage.removeItem(`chat:minHeight:${conversationId}`)
        }
      }
    }

    const frame = window.requestAnimationFrame(() => {
      if (
        followStreamingRef.current &&
        isStreamingThisConversation &&
        !ignoreSyncRef.current
      ) {
        scrollToBottom("smooth")
      } else if (autoScrollEnabledRef.current && !minHeightActiveRef.current) {
        scrollToBottom(isStreamingThisConversation ? "auto" : "smooth")
      }

      if (streamingFinished) {
        if (conversationId) {
          localStorage.removeItem(
            `${STREAM_ANCHOR_TAKEN_PREFIX}:${conversationId}`
          )
        }
        if (followStreamingRef.current) {
          scrollToBottom("smooth")
        }
        if (scrollButtonLockedUntilStreamingEndRef.current) {
          scrollButtonLockedUntilStreamingEndRef.current = false
          suppressBtnRef.current = false
          setProgrammaticScrollbarSuppressed(false)
          setScrollButtonVisible(false)
        }
        autoScrollEnabledRef.current = false
        followStreamingRef.current = false
      }

      syncScrollState()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [
    artifactOpen,
    conversationId,
    getCommittedTailSpacer,
    getTailResponseMinHeight,
    isStreamingThisConversation,
    messageCount,
    minHeight,
    scheduleMessageTopAnchor,
    scrollToBottom,
    state.streamingContent,
    state.streamingContentSegments,
    state.streamingReasoning,
    syncScrollState,
    setProgrammaticScrollbarSuppressed,
    setScrollButtonVisible,
    activeConversation?.messages,
  ])

  // ── Generated artifact side-panel state ────────────────────────────────
  // Distinct from the legacy code-block / tool-result panel above. When the
  // user clicks "↗ Expand" on an inline ArtifactInline card OR the model
  // chooses `display="panel"`, we surface the new ArtifactPanel here.
  // Sidebar collapses just like the legacy flow.
  const restoreSidebar = React.useCallback(() => {
    if (sidebarWasOpenRef.current) {
      setSidebarOpen(true)
    }
  }, [setSidebarOpen])

  const handleArtifactClick = React.useCallback(
    (nextArtifact: ArtifactState) => {
      const isSameArtifact =
        artifact != null && artifactKey(artifact) === artifactKey(nextArtifact)

      if (artifactOpen && isSameArtifact) {
        setArtifactOpen(false)
        if (conversationId)
          localStorage.setItem(
            `chat:artifact:${conversationId}`,
            JSON.stringify({ artifact, artifactOpen: false })
          )
        restoreSidebar()
        return
      }

      const panelAlreadyOpen =
        artifactOpen || Boolean(genArtifact) || Boolean(activePanelAgentRun)
      if (!panelAlreadyOpen) {
        sidebarWasOpenRef.current = sidebarOpen
      }

      setArtifact(nextArtifact)
      setArtifactOpen(true)
      setActiveAgentRunId(null)
      setGenArtifact(null)
      if (conversationId)
        localStorage.setItem(
          `chat:artifact:${conversationId}`,
          JSON.stringify({ artifact: nextArtifact, artifactOpen: true })
        )
      setSidebarOpen(false)
    },
    [
      activePanelAgentRun,
      artifact,
      artifactOpen,
      genArtifact,
      restoreSidebar,
      setSidebarOpen,
      sidebarOpen,
      conversationId,
    ]
  )

  const handleArtifactClose = React.useCallback(() => {
    setArtifactOpen(false)
    if (conversationId)
      localStorage.setItem(
        `chat:artifact:${conversationId}`,
        JSON.stringify({ artifact, artifactOpen: false })
      )
    restoreSidebar()
  }, [restoreSidebar, conversationId, artifact])

  const handleGenArtifactClose = React.useCallback(() => {
    setGenArtifact(null)
    restoreSidebar()
    if (conversationId)
      localStorage.removeItem(`chat:gen-artifact:${conversationId}`)
  }, [restoreSidebar, conversationId])
  const handleArtifactExpand = React.useCallback(
    (a: ArtifactRow) => {
      // Re-click on the same artifact's panel button toggles it shut, so
      // the inline button is a press-press affordance instead of a dead end
      // once the panel is already showing that artifact.
      if (
        genArtifact &&
        (genArtifact.id === a.id || genArtifact.identifier === a.identifier)
      ) {
        handleGenArtifactClose()
        return
      }
      const panelAlreadyOpen =
        artifactOpen || Boolean(genArtifact) || Boolean(activePanelAgentRun)
      if (!panelAlreadyOpen) {
        sidebarWasOpenRef.current = sidebarOpen
      }
      setGenArtifact(a)
      setArtifactOpen(false)
      setActiveAgentRunId(null)
      setSidebarOpen(false)
    },
    [
      activePanelAgentRun,
      artifactOpen,
      setSidebarOpen,
      sidebarOpen,
      genArtifact,
      handleGenArtifactClose,
    ]
  )

  const handleAgentOpen = React.useCallback(
    (run: AgentCallReasoningEntry) => {
      const panelAlreadyOpen =
        artifactOpen || Boolean(genArtifact) || Boolean(activePanelAgentRun)
      if (!panelAlreadyOpen) {
        sidebarWasOpenRef.current = sidebarOpen
      }
      setActiveAgentRunId(run.runId)
      setArtifactOpen(false)
      setGenArtifact(null)
      setSidebarOpen(false)
    },
    [
      activePanelAgentRun,
      artifactOpen,
      genArtifact,
      setSidebarOpen,
      sidebarOpen,
    ]
  )

  const handleAgentClose = React.useCallback(() => {
    setActiveAgentRunId(null)
    restoreSidebar()
  }, [restoreSidebar])

  const handleLoadMessageDetails = React.useCallback(
    (messageId: string) => {
      if (!conversationId) return Promise.resolve()
      return loadMessageDetails(conversationId, messageId)
    },
    [conversationId, loadMessageDetails]
  )

  const hasArtifact =
    (artifactOpen && !!artifact) || !!genArtifact || !!activePanelAgentRun
  const activeArtifactResizeKey = React.useMemo(() => {
    if (activePanelAgentRun) return `agent:${activePanelAgentRun.runId}`
    if (genArtifact) return `generated:${genArtifact.identifier}`
    if (artifactOpen && artifact) return `legacy:${artifactKey(artifact)}`
    return null
  }, [activePanelAgentRun, artifact, artifactOpen, genArtifact])
  // Hide the message list until scroll is restored. Without this we'd show
  // an empty list while messages load, then fade it out + fade it back in
  // once `messageCount` flips past 0 — perceived as a second flash after the
  // outer wrapper's initial fade-in.
  const conversationLoadStatus = conversationId
    ? state.conversationLoadState[conversationId]
    : null
  const isAwaitingInitialMessages =
    conversationLoadStatus === "summary" || conversationLoadStatus === "loading"
  const isAwaitingInitialScrollRestore = Boolean(
    conversationId &&
    restoredScrollConversationId !== conversationId &&
    (messageCount > 0 || isAwaitingInitialMessages)
  )
  const isRestoringInitialFrame =
    isAwaitingInitialScrollRestore || isRestoringScroll
  const isMessageListHidden = isScrollJumpFading || isRestoringInitialFrame

  React.useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  React.useEffect(() => {
    artifactResizeKeyRef.current = activeArtifactResizeKey
  }, [activeArtifactResizeKey])

  React.useEffect(() => {
    if (!hasArtifact || !conversationId) return

    const artifactStoredWidth = readStoredArtifactPanelWidth(
      artifactPanelArtifactWidthKey(conversationId, activeArtifactResizeKey)
    )
    const conversationStoredWidth = readStoredArtifactPanelWidth(
      artifactPanelConversationWidthKey(conversationId)
    )
    const containerWidth =
      layoutContainerRef.current?.getBoundingClientRect().width
    const nextWidth =
      artifactStoredWidth ??
      conversationStoredWidth ??
      ARTIFACT_PANEL_DEFAULT_WIDTH

    setArtifactPanelWidth(clampArtifactPanelWidth(nextWidth, containerWidth))
  }, [activeArtifactResizeKey, conversationId, hasArtifact])

  React.useEffect(() => {
    const element = layoutContainerRef.current
    if (!element) return

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      setArtifactPanelWidth((current) =>
        clampArtifactPanelWidth(current, width)
      )
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const persistArtifactPanelWidth = React.useCallback((width: number) => {
    if (typeof window === "undefined") return
    const id = conversationIdRef.current
    if (!id) return

    window.localStorage.setItem(
      artifactPanelConversationWidthKey(id),
      String(width)
    )

    const artifactWidthKey = artifactPanelArtifactWidthKey(
      id,
      artifactResizeKeyRef.current
    )
    if (artifactWidthKey) {
      window.localStorage.setItem(artifactWidthKey, String(width))
    }
  }, [])

  const setAndPersistArtifactPanelWidth = React.useCallback(
    (width: number, containerWidth?: number | null) => {
      const nextWidth = clampArtifactPanelWidth(width, containerWidth)
      setArtifactPanelWidth(nextWidth)
      persistArtifactPanelWidth(nextWidth)
      return nextWidth
    },
    [persistArtifactPanelWidth]
  )

  const resizeArtifactPanelFromClientX = React.useCallback(
    (clientX: number) => {
      const container = layoutContainerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      setAndPersistArtifactPanelWidth(rect.right - clientX, rect.width)
    },
    [setAndPersistArtifactPanelWidth]
  )

  const handleArtifactPanelResizePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!hasArtifact) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      setIsResizingArtifactPanel(true)
      resizeArtifactPanelFromClientX(event.clientX)
    },
    [hasArtifact, resizeArtifactPanelFromClientX]
  )

  const handleArtifactPanelResizeKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        !hasArtifact ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      )
        return
      event.preventDefault()

      const containerWidth =
        layoutContainerRef.current?.getBoundingClientRect().width
      const direction = event.key === "ArrowLeft" ? 1 : -1
      const step = event.shiftKey
        ? ARTIFACT_PANEL_RESIZE_STEP * 2
        : ARTIFACT_PANEL_RESIZE_STEP
      setArtifactPanelWidth((current) => {
        const nextWidth = clampArtifactPanelWidth(
          current + direction * step,
          containerWidth
        )
        persistArtifactPanelWidth(nextWidth)
        return nextWidth
      })
    },
    [hasArtifact, persistArtifactPanelWidth]
  )

  React.useEffect(() => {
    if (!isResizingArtifactPanel) return

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"

    const onPointerMove = (event: PointerEvent) => {
      event.preventDefault()
      resizeArtifactPanelFromClientX(event.clientX)
    }
    const stopResizing = () => setIsResizingArtifactPanel(false)

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", stopResizing)
    window.addEventListener("pointercancel", stopResizing)

    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", stopResizing)
      window.removeEventListener("pointercancel", stopResizing)
    }
  }, [isResizingArtifactPanel, resizeArtifactPanelFromClientX])

  // Persist the open panel artifact id per conversation so refreshes/tab
  // switches reopen the user's last view. We store only the id; the panel
  // resolves the full row through the ConversationArtifactsProvider once
  // bootstrap finishes.
  React.useEffect(() => {
    if (!conversationId) return
    if (genArtifact) {
      localStorage.setItem(
        `chat:gen-artifact:${conversationId}`,
        genArtifact.id
      )
    }
  }, [genArtifact, conversationId])

  // Restore the panel artifact on mount / conversation switch. If a previous
  // session had the panel open and refresh hit, the artifact id is still in
  // localStorage — fetch the row and reopen. We deliberately bypass
  // handleArtifactExpand here so we don't clobber the sidebar's own
  // persisted open/closed state.
  //
  // `sidebarOpen` is read through a ref to keep it out of the effect deps —
  // otherwise hydrating the sidebar would re-fire this effect.
  // No cleanup-driven cancellation: StrictMode's double-invoke would cancel
  // the in-flight fetch and the second run is gated by the per-conversation
  // ref below, so the response never arrives. setState is no-op after
  // unmount in modern React, so the unsafe set is fine.
  const sidebarOpenRef = React.useRef(sidebarOpen)
  React.useEffect(() => {
    sidebarOpenRef.current = sidebarOpen
  }, [sidebarOpen])
  const restoredArtifactConversationRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!conversationId) return
    if (restoredArtifactConversationRef.current === conversationId) return
    restoredArtifactConversationRef.current = conversationId
    const savedId = localStorage.getItem(`chat:gen-artifact:${conversationId}`)
    if (!savedId) return
    void fetch(`/api/artifacts/${encodeURIComponent(savedId)}`)
      .then((r) => (r.ok ? (r.json() as Promise<ArtifactRow>) : null))
      .then((row) => {
        if (!row) return
        sidebarWasOpenRef.current = sidebarOpenRef.current
        setGenArtifact(row)
      })
      .catch(() => {})
  }, [conversationId])

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  //   Cmd/Ctrl + \  — toggle the side panel (close if open, reopen last if not)
  //   Cmd/Ctrl + Shift + E — open panel for the most recent artifact in conv
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === "\\" && !e.shiftKey) {
        e.preventDefault()
        if (genArtifact) {
          handleGenArtifactClose()
        } else if (conversationId) {
          const lastId = localStorage.getItem(
            `chat:gen-artifact:${conversationId}`
          )
          if (!lastId) return
          // Defer to next tick so the open state has a chance to settle.
          void fetch(`/api/artifacts/${encodeURIComponent(lastId)}`)
            .then((r) => (r.ok ? (r.json() as Promise<ArtifactRow>) : null))
            .then((row) => {
              if (row) handleArtifactExpand(row)
            })
            .catch(() => {})
        }
      } else if (e.key === "E" && e.shiftKey) {
        // Open the most recent artifact in the conversation.
        e.preventDefault()
        if (!conversationId) return
        void fetch(
          `/api/artifacts/conversation/${encodeURIComponent(conversationId)}?latest=1`
        )
          .then((r) =>
            r.ok
              ? (r.json() as Promise<{ artifacts: ArtifactRow[] }>)
              : { artifacts: [] }
          )
          .then(({ artifacts }) => {
            const last = artifacts[artifacts.length - 1]
            if (last) handleArtifactExpand(last)
          })
          .catch(() => {})
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [
    genArtifact,
    conversationId,
    handleGenArtifactClose,
    handleArtifactExpand,
  ])

  const handleScrollButtonClick = React.useCallback(() => {
    const element = scrollContainerRef.current
    const distanceFromBottom = element
      ? element.scrollHeight - element.scrollTop - element.clientHeight
      : Number.POSITIVE_INFINITY
    const shouldFadeJump = distanceFromBottom > SCROLL_BUTTON_FADE_DISTANCE_PX

    setScrollButtonVisible(false)
    setProgrammaticScrollbarSuppressed(true)
    suppressBtnRef.current = true
    ignoreSyncRef.current = true
    scrollButtonLockedUntilStreamingEndRef.current = isStreamingThisConversation

    if (scrollJumpFadeTimeoutRef.current !== null) {
      window.clearTimeout(scrollJumpFadeTimeoutRef.current)
    }
    if (scrollJumpFadeReleaseTimeoutRef.current !== null) {
      window.clearTimeout(scrollJumpFadeReleaseTimeoutRef.current)
    }

    const startScroll = () => {
      if (isStreamingThisConversation) {
        followStreamingRef.current = true
        autoScrollEnabledRef.current = true
      }

      scrollToBottom("smooth", { settle: shouldFadeJump })

      scrollJumpFadeReleaseTimeoutRef.current = window.setTimeout(() => {
        ignoreSyncRef.current = false
        if (!scrollButtonLockedUntilStreamingEndRef.current) {
          suppressBtnRef.current = false
          setProgrammaticScrollbarSuppressed(false)
        }
        setIsScrollJumpFading(false)
        syncScrollState()
      }, MESSAGE_ANCHOR_SCROLL_DURATION_MS)
    }

    if (shouldFadeJump) {
      setIsScrollJumpFading(true)
      scrollJumpFadeTimeoutRef.current = window.setTimeout(startScroll, 120)
    } else {
      setIsScrollJumpFading(false)
      startScroll()
    }
  }, [
    scrollToBottom,
    setScrollButtonVisible,
    setProgrammaticScrollbarSuppressed,
    isStreamingThisConversation,
    syncScrollState,
  ])

  if (!activeConversation) return null

  return (
    <ConversationArtifactsProvider conversationId={conversationId ?? ""}>
      <div
        ref={layoutContainerRef}
        className={cn(
          "grid min-h-0 flex-1 overflow-hidden",
          !isResizingArtifactPanel && "transition-[grid-template-columns]",
          !isResizingArtifactPanel && LAYOUT_TRANSITION
        )}
        style={{
          gridTemplateColumns:
            hasArtifact && !isMobile
              ? `minmax(0, 1fr) ${ARTIFACT_PANEL_RESIZER_WIDTH}px ${artifactPanelWidth}px`
              : "minmax(0, 1fr) 0px 0px",
        }}
      >
        <div className="relative flex min-h-0 min-w-0 flex-col">
          <div className="relative z-10 shrink-0 bg-background px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 md:py-3">
            <div className="flex min-w-0 items-center gap-2">
              <SidebarTrigger className="-ml-1 size-10 shrink-0 text-foreground/60 hover:text-foreground md:hidden" />
              <button className="flex min-w-0 items-center gap-1 text-[15px] font-medium transition-opacity hover:opacity-70">
                <span className="truncate">{activeConversation.title}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-[-20px] h-5 bg-gradient-to-b from-background via-background/70 to-transparent" />
          </div>

          <div
            ref={scrollContainerRef}
            data-chat-scroll-container="true"
            data-scrollbar-visible={
              isScrollbarVisible && !isScrollbarSuppressed ? "true" : "false"
            }
            data-scrollbar-suppressed={isScrollbarSuppressed ? "true" : "false"}
            className="chat-scroll-container min-h-0 flex-1 overflow-y-scroll transition-[margin-bottom] duration-150 ease-out"
            style={{
              WebkitOverflowScrolling: "touch",
              marginBottom: keyboardInset > 0 ? keyboardInset : undefined,
              overscrollBehaviorY: "contain",
              scrollbarGutter: isMobile ? "auto" : "stable both-edges",
              touchAction: "pan-y",
            }}
          >
            <div className="mx-auto flex min-h-full w-full max-w-[780px] flex-col px-4">
              <div
                data-chat-message-list="true"
                className={cn(
                  "flex-1 pt-8 transition-opacity duration-150",
                  isMessageListHidden && "pointer-events-none opacity-0"
                )}
                style={{ paddingBottom: inputOffset + 24 }}
                aria-busy={isRestoringInitialFrame}
              >
                <div className="mx-auto max-w-[700px] space-y-6 px-2 select-none">
                  {isInitialMessagesLoading ? null : (
                    <>
                      {(hasOlderMessages ||
                        isLoadingOlderMessages ||
                        olderMessagesError) && (
                        <div className="flex justify-center py-1">
                          <button
                            type="button"
                            onClick={requestOlderMessages}
                            disabled={isLoadingOlderMessages}
                            className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-3 text-[13px] text-muted-foreground shadow-sm transition-colors hover:bg-muted/40 hover:text-foreground disabled:cursor-default disabled:opacity-70"
                          >
                            {isLoadingOlderMessages && (
                              <Loader2 className="size-3.5 animate-spin" />
                            )}
                            <span>
                              {isLoadingOlderMessages
                                ? "Loading older messages"
                                : olderMessagesError
                                  ? "Retry older messages"
                                  : `Load older messages (${loadedMessageCount}/${totalMessageCount})`}
                            </span>
                          </button>
                        </div>
                      )}

                      {activeConversation.messages.map((message, index) => {
                        if (
                          shouldUseStreamingBubbleForActiveAssistant &&
                          message.id === activeInProgressAssistantMessage?.id
                        ) {
                          return null
                        }

                        return (
                          <div
                            key={message.id}
                            id={`message-${message.id}`}
                            className="scroll-mt-6 md:-ml-16 md:w-[calc(100%+4rem)] md:pl-16"
                            style={
                              message.id === minHeightMsgId &&
                              index === activeConversation.messages.length - 1
                                ? { paddingBottom: minHeight }
                                : undefined
                            }
                          >
                            <MessageBubble
                              message={message}
                              isLatestAssistantMessage={
                                message.id === latestAssistantMessageId
                              }
                              isStreamingMessage={
                                message.id === activeStreamingMessageId
                              }
                              onArtifactClick={handleArtifactClick}
                              onArtifactExpand={handleArtifactExpand}
                              onAttachmentClick={setPreviewAttachment}
                              onAgentOpen={handleAgentOpen}
                              onLoadMessageDetails={handleLoadMessageDetails}
                            />
                          </div>
                        )
                      })}

                      {showStreamingBubble && (
                        <div
                          ref={streamingBubbleContainerRef}
                          className="md:-ml-16 md:w-[calc(100%+4rem)] md:pl-16"
                          aria-hidden={!showLiveStreamingBubble}
                          style={
                            minHeight > 0 && minHeightMsgId === null
                              ? { minHeight }
                              : undefined
                          }
                        >
                          {showLiveStreamingBubble && (
                            <StreamingBubble
                              reasoning={state.streamingReasoning}
                              content={state.streamingContent}
                              contentSegments={state.streamingContentSegments}
                              streamingMode={state.streamingMode}
                              showCursor={showInitialStreamingCursor}
                              onArtifactClick={handleArtifactClick}
                              onArtifactExpand={handleArtifactExpand}
                              onAgentOpen={handleAgentOpen}
                              onAttachmentClick={setPreviewAttachment}
                              messageId={state.streamingMessageId ?? undefined}
                              thinkingSeconds={state.thinkingSeconds}
                              thinkingDone={state.thinkingDone}
                            />
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div
            ref={inputContainerRef}
            data-chat-input-container="true"
            className={cn(
              "pointer-events-none absolute bottom-0 left-0 z-10 bg-background px-4 transition-[padding-bottom,transform] duration-150 ease-out",
              keyboardInset > 0
                ? "pb-0.5"
                : "pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:pb-3"
            )}
            style={{
              right: isMobile ? 0 : 14,
              transform:
                keyboardInset > 0
                  ? `translate3d(0, -${keyboardInset}px, 0)`
                  : undefined,
            }}
          >
            <div className="pointer-events-auto mx-auto w-full max-w-[780px]">
              <TodoBar
                messages={activeConversation.messages}
                streamingReasoning={
                  isStreamingThisConversation ? state.streamingReasoning : []
                }
                hideCompleted={!isStreamingThisConversation}
              />
              <ChatInput variant="chat" />
            </div>
          </div>

          {showScrollBtn && (
            <div
              className="absolute inset-x-0 z-20 flex justify-center"
              style={{ bottom: inputOffset + keyboardInset }}
            >
              <button
                type="button"
                aria-label="Scroll to bottom"
                onClick={handleScrollButtonClick}
                className="flex size-9 items-center justify-center rounded-full border border-[#e6e1db] bg-white text-foreground shadow-[0_10px_24px_rgba(32,23,16,0.12)] transition-all hover:scale-105 hover:bg-[#faf8f5]"
              >
                <ArrowDown className="size-4 stroke-[1.8]" />
              </button>
            </div>
          )}
        </div>

        <div
          role="separator"
          aria-label="Resize artifact panel"
          aria-orientation="vertical"
          aria-valuemin={ARTIFACT_PANEL_MIN_WIDTH}
          aria-valuemax={ARTIFACT_PANEL_MAX_WIDTH}
          aria-valuenow={artifactPanelWidth}
          tabIndex={hasArtifact ? 0 : -1}
          title="Drag to resize artifact panel"
          onPointerDown={handleArtifactPanelResizePointerDown}
          onKeyDown={handleArtifactPanelResizeKeyDown}
          className={cn(
            "group relative z-20 hidden h-full cursor-col-resize touch-none transition-colors outline-none md:block",
            "hover:bg-muted/35 focus-visible:bg-muted/45",
            hasArtifact ? "opacity-100" : "pointer-events-none opacity-0",
            isResizingArtifactPanel && "bg-muted/50"
          )}
        >
          <span
            className={cn(
              "absolute top-1/2 left-1/2 h-12 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border opacity-0 transition-opacity",
              "group-hover:opacity-100 group-focus-visible:opacity-100",
              isResizingArtifactPanel && "opacity-100"
            )}
          />
        </div>

        <div className="hidden min-w-0 overflow-hidden md:block">
          <div
            className={cn(
              "h-full w-full overflow-hidden transition-[opacity,transform]",
              LAYOUT_TRANSITION,
              hasArtifact
                ? "translate-x-0 opacity-100"
                : "pointer-events-none translate-x-4 opacity-0"
            )}
          >
            {activePanelAgentRun ? (
              <AgentWorkspacePanel
                run={activePanelAgentRun}
                childRun={activeChildAgentRun}
                onClose={handleAgentClose}
                onAttachmentClick={setPreviewAttachment}
              />
            ) : genArtifact ? (
              // Generated artifact panel takes priority — same right column,
              // distinct chrome (version dropdown, sandbox iframes).
              <AntArtifactPanel
                artifact={genArtifact}
                onClose={handleGenArtifactClose}
                onSelect={(a) => setGenArtifact(a)}
              />
            ) : artifact ? (
              <ArtifactPanel
                artifact={artifact}
                onClose={handleArtifactClose}
              />
            ) : null}
          </div>
        </div>

        {hasArtifact && isMobile && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Artifact panel"
            className="fixed inset-0 z-50 bg-background md:hidden"
          >
            {activePanelAgentRun ? (
              <AgentWorkspacePanel
                run={activePanelAgentRun}
                childRun={activeChildAgentRun}
                onClose={handleAgentClose}
                onAttachmentClick={setPreviewAttachment}
              />
            ) : genArtifact ? (
              <AntArtifactPanel
                artifact={genArtifact}
                onClose={handleGenArtifactClose}
                onSelect={(a) => setGenArtifact(a)}
              />
            ) : artifact ? (
              <ArtifactPanel
                artifact={artifact}
                onClose={handleArtifactClose}
              />
            ) : null}
          </div>
        )}

        <FilePreviewModal
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      </div>
    </ConversationArtifactsProvider>
  )
}
