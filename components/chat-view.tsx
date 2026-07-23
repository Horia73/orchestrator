"use client"

import * as React from "react"
import { ArrowDown, ChevronDown, Loader2, Monitor } from "lucide-react"
import { ArtifactPanel, artifactKey } from "@/components/artifact-panel"
import { AgentWorkspacePanel } from "@/components/chat/agent-workspace-panel"
import { BrowserPanelProvider } from "@/components/chat/browser-panel-context"
import {
  isBrowserAgentRunAwaitingUser,
  isBrowserAgentRunLive,
  latestBrowserAgentRuns,
  shouldAutoCloseBrowserAgentPanel,
} from "@/lib/browser-agent-run-state"
import {
  ARTIFACT_PANEL_DEFAULT_WIDTH,
  ARTIFACT_PANEL_MAX_WIDTH,
  ARTIFACT_PANEL_MIN_WIDTH,
  ARTIFACT_PANEL_RESIZE_STEP,
  ARTIFACT_PANEL_RESIZER_WIDTH,
  LAYOUT_TRANSITION,
  MESSAGE_ANCHOR_SCROLL_DURATION_MS,
  MESSAGE_ANCHOR_TOP_OFFSET,
  MESSAGE_VERTICAL_GAP,
  OLDER_MESSAGES_AUTOLOAD_THRESHOLD_PX,
  POST_RESTORE_HOLD_MS,
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
  browserAgentPanelDefaultWidth,
  clampArtifactPanelWidth,
  collectAgentRuns,
  findActiveInProgressAssistantMessage,
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
import { ChatConnectionPill } from "@/components/chat-connection-pill"
import { BackgroundJobsChip } from "@/components/chat/background-jobs-chip"
import { PendingFollowUps } from "@/components/chat/pending-follow-ups"
import { TodoBar } from "@/components/todo-bar"
import { MessageBubble, StreamingBubble } from "@/components/message-bubble"
import { FilePreviewModal } from "@/components/file-preview-modal"
import { MarkdownImagePreviewProvider } from "@/components/markdown-renderer"
import { ArtifactPanel as AntArtifactPanel } from "@/components/artifacts/artifact-panel"
import { ConversationArtifactsProvider } from "@/components/artifacts/use-conversation-artifacts"
import { decideRowRenderTarget } from "@/lib/artifacts/render-decision"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import {
  consumeLocalSubmitAnchor,
  isLocalSubmitAnchorDetail,
  isLocalSubmitAnchorFresh,
  LOCAL_SUBMIT_ANCHOR_EVENT,
  readLocalSubmitAnchor,
  type LocalSubmitAnchor,
} from "@/lib/chat-local-submit-anchor"
import {
  CHAT_SCROLL_TARGET_EVENT,
  consumeChatScrollTarget,
  isChatScrollTargetDetail,
  isChatScrollTargetFresh,
  readChatScrollTarget,
  type ChatScrollTarget,
} from "@/lib/chat-scroll-target"
import { publishChatViewSettled } from "@/lib/chat-view-settled"
import { CHAT_VIEW_SAVE_STATE_EVENT } from "@/lib/chat-view-state"
import { LOADED_WHILE_HIDDEN } from "@/lib/loaded-while-hidden"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { useChatStore } from "@/hooks/use-chat-store"
import { uploadChatAttachments } from "@/hooks/chat-store-api"
import { useMobileKeyboardInset } from "@/hooks/use-keyboard-inset"
import { useServerConnection } from "@/hooks/use-server-connection"
import { cn } from "@/lib/utils"
import type { AgentCallReasoningEntry, Attachment } from "@/lib/types"

export function ChatView() {
  const { state, loadOlderMessages, loadMessageDetails, loadToolCallDetails, loadMessagesUntilPresent, sendMessageToConversation } =
    useChatStore()
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
  // Last-known on-screen position of the streaming answer's bottom, captured each
  // streaming frame. At finalize the working trace ("Worked for …") folds shut; if
  // it was scrolled above the fold the collapse silently yanks the answer up. This
  // lets the finalize effect measure that shift and undo it — a message-level anchor
  // can't, because the collapse is *internal* (the message top never moves).
  const finalizeAnchorRef = React.useRef<{
    conversationId: string
    contentBottomOffset: number
    distanceFromBottom: number
  } | null>(null)
  const latestAssistantIdRef = React.useRef<string | null>(null)
  const pendingLocalSubmitAnchorRef =
    React.useRef<LocalSubmitAnchor | null>(null)
  // Deep-link "scroll to this message" target (Library → "View in chat").
  const pendingScrollTargetRef = React.useRef<ChatScrollTarget | null>(null)
  const consumedScrollTargetRef = React.useRef<string | null>(null)
  const highlightTimeoutRef = React.useRef<number | null>(null)
  const restoreOlderAttemptRef = React.useRef<{
    conversationId: string
    status: "chasing" | "exhausted"
  } | null>(null)
  // Bumped when a restore anchor chase settles, so the restore effect re-runs
  // even if no store flag flips afterwards (found → restore over the loaded
  // range; exhausted → fall back instead of holding the view hidden forever).
  const [restoreChaseTick, setRestoreChaseTick] = React.useState(0)
  // Ref-owned anchor settle loop (see the restore effect). Not cancelled by
  // effect re-runs — only by a conversation switch or its own completion.
  const anchorSettleRef = React.useRef<{
    conversationId: string
    frameId: number
  } | null>(null)
  // Post-restore hold: after the settle loop reveals the view, lazy content
  // (idle-scheduled Shiki, images, chunk-rendered "Worked for" bodies) keeps
  // reflowing for a while and silently drifts the restored position. The hold
  // keeps re-pinning the anchor (or the bottom) until the first real user
  // input or its deadline, so the reading position survives the late reflows.
  const postRestoreHoldRef = React.useRef<{
    conversationId: string
    mode: "anchor" | "bottom"
    anchor: SavedScrollRestore | null
    frameId: number
    until: number
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
  const minHeightRef = React.useRef(minHeight) // current spacer, read inside observers without re-subscribing
  const followStreamingRef = React.useRef(false) // user clicked scroll-btn during streaming

  const [previewAttachment, setPreviewAttachment] =
    React.useState<Attachment | null>(null)
  const [previewGallery, setPreviewGallery] =
    React.useState<Attachment[] | undefined>(undefined)
  const [highlightedMessageId, setHighlightedMessageId] = React.useState<
    string | null
  >(null)
  // Open the lightbox on a clicked attachment, carrying its sibling group so
  // the modal can offer left/right gallery navigation across images/videos.
  const openPreview = React.useCallback(
    (attachment: Attachment, gallery?: Attachment[]) => {
      setPreviewAttachment(attachment)
      setPreviewGallery(gallery)
    },
    []
  )
  const closePreview = React.useCallback(() => {
    setPreviewAttachment(null)
    setPreviewGallery(undefined)
  }, [])
  const handleSendAnnotatedImage = React.useCallback(
    async (_attachment: Attachment, file: File, message: string) => {
      const attachments = await uploadChatAttachments([file])
      if (!attachments?.length) throw new Error("Could not upload the annotated image.")
      const sentConversationId = await sendMessageToConversation(
        state.activeConversationId,
        message,
        undefined,
        attachments
      )
      if (!sentConversationId) throw new Error("Wait for the current response to finish.")
      closePreview()
    },
    [closePreview, sendMessageToConversation, state.activeConversationId]
  )

  React.useEffect(() => {
    minHeightActiveRef.current = minHeight > 0
    minHeightRef.current = minHeight
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
  // First message-list reveal after a background reload (tab discarded while
  // hidden) snaps in instead of fading — so on return the conversation is just
  // there, not animating into place. Set via layout effect to keep the first
  // render server-identical (no hydration mismatch); released after the first
  // reveal so later conversation switches fade normally again.
  const [instantFirstReveal, setInstantFirstReveal] = React.useState(false)
  const [isScrollbarVisible, setIsScrollbarVisible] = React.useState(false)
  const [isScrollbarSuppressed, setIsScrollbarSuppressed] =
    React.useState(false)
  const showScrollBtnRef = React.useRef(false)
  // Last trustworthy scrollTop: maintained by the scroll listener and the
  // restore paths. A scrollTop clamp caused by an in-frame layout shrink only
  // fires its scroll event on the NEXT frame, so inside a ResizeObserver
  // callback this still holds the pre-clamp position — the tail-spacer
  // recompute uses it to undo the clamp before paint. Null until this
  // conversation has an established position (reset on switch).
  const lastObservedScrollTopRef = React.useRef<number | null>(null)
  // Pre-burst scrollTop frozen at the start of a tail-spacer recompute burst
  // (an animated expand/collapse fires one recompute per frame for ~360ms).
  // Mid-burst clamps are legitimate scroll events, so the listener ref above
  // decays during the burst; restoring against this frozen value instead
  // brings the view back to exactly where it was once the spacer can absorb
  // the change again.
  const spacerBurstScrollTopRef = React.useRef<number | null>(null)
  const spacerBurstLastRecomputeAtRef = React.useRef(0)
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
  const pendingFollowUps = React.useMemo(
    () => (conversationId ? state.pendingFollowUps[conversationId] ?? [] : []),
    [conversationId, state.pendingFollowUps]
  )
  const pendingFollowUpUserIds = React.useMemo(
    () => new Set(pendingFollowUps.map((entry) => entry.userMessageId)),
    [pendingFollowUps]
  )
  const transcriptMessages = React.useMemo(
    () =>
      (activeConversation?.messages ?? []).filter(
        (message) => !pendingFollowUpUserIds.has(message.id)
      ),
    [activeConversation?.messages, pendingFollowUpUserIds]
  )
  const pendingFollowUpItems = React.useMemo(
    () =>
      pendingFollowUps.flatMap((entry) => {
        const message = activeConversation?.messages.find(
          (candidate) => candidate.id === entry.userMessageId
        )
        return message
          ? [
              {
                id: entry.followUpId,
                content: message.content,
                attachmentCount: message.attachments?.length ?? 0,
              },
            ]
          : []
      }),
    [activeConversation?.messages, pendingFollowUps]
  )
  const isStreamingThisConversation = Boolean(
    conversationId &&
    state.isStreaming &&
    state.streamingConversationId === conversationId
  )
  const isStreamingThisConversationRef = React.useRef(false)
  // Track the browser's own offline signal so the hint can also appear when
  // the radio drops while nothing is streaming — otherwise a user typing into
  // a dead connection gets no warning until after they hit send.
  const [deviceOffline, setDeviceOffline] = React.useState(false)
  React.useEffect(() => {
    const update = () => setDeviceOffline(!navigator.onLine)
    update()
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
    }
  }, [])
  // Real device→server reachability while a response is streaming (or the
  // device reports itself offline) — drives the "Reconnecting…" hint
  // independently of the stream-recovery state machine. While offline-idle
  // the probe short-circuits on navigator.onLine, so no requests are made.
  const isReconnecting = useServerConnection(
    isStreamingThisConversation || deviceOffline
  )
  const messageCount = transcriptMessages.length
  const messagePage = conversationId
    ? state.conversationMessagePages[conversationId]
    : undefined
  const isInitialMessagesLoading = Boolean(
    conversationId &&
    state.conversationLoadState[conversationId] === "loading"
  )
  const hasOlderMessages = Boolean(messagePage?.hasMore)
  const isLoadingOlderMessages = Boolean(messagePage?.isLoadingOlder)
  const latestAssistantMessageId = React.useMemo(() => {
    for (let i = transcriptMessages.length - 1; i >= 0; i--) {
      if (transcriptMessages[i].role === "assistant") {
        return transcriptMessages[i].id
      }
    }
    return null
  }, [transcriptMessages])
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
    latestAssistantIdRef.current = latestAssistantMessageId
  }, [activeStreamingMessageId, isStreamingThisConversation, latestAssistantMessageId])

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
    return findActiveInProgressAssistantMessage(
      transcriptMessages,
      activeStreamingMessageId
    )
  }, [activeStreamingMessageId, transcriptMessages])
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
    for (const message of transcriptMessages) {
      runs.push(...collectAgentRuns(message.reasoning))
    }
    if (isStreamingThisConversation) {
      runs.push(...collectAgentRuns(state.streamingReasoning))
    }
    const byId = new Map<string, AgentCallReasoningEntry>()
    for (const run of runs) byId.set(run.runId, run)
    return Array.from(byId.values())
  }, [
    transcriptMessages,
    isStreamingThisConversation,
    state.streamingReasoning,
  ])
  const agentRunMessageIds = React.useMemo(() => {
    const byRunId = new Map<string, string>()
    for (const message of transcriptMessages) {
      for (const run of collectAgentRuns(message.reasoning)) {
        byRunId.set(run.runId, message.id)
      }
    }
    if (state.streamingMessageId) {
      for (const run of collectAgentRuns(state.streamingReasoning)) {
        byRunId.set(run.runId, state.streamingMessageId)
      }
    }
    return byRunId
  }, [transcriptMessages, state.streamingMessageId, state.streamingReasoning])
  const activeTurnAgentRuns = React.useMemo(() => {
    const runs: AgentCallReasoningEntry[] = []
    if (activeInProgressAssistantMessage?.reasoning) {
      runs.push(...collectAgentRuns(activeInProgressAssistantMessage.reasoning))
    }
    if (isStreamingThisConversation) {
      runs.push(...collectAgentRuns(state.streamingReasoning))
    }
    const byId = new Map<string, AgentCallReasoningEntry>()
    for (const run of runs) byId.set(run.runId, run)
    return Array.from(byId.values())
  }, [
    activeInProgressAssistantMessage,
    isStreamingThisConversation,
    state.streamingReasoning,
  ])
  const visibleBrowserTakeoverRunIds = React.useMemo(
    () =>
      new Set(
        latestBrowserAgentRuns(agentRuns)
          .filter((run) => isBrowserAgentRunAwaitingUser(run))
          .map((run) => run.runId)
      ),
    [agentRuns]
  )

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
  const activePanelAgentMessageId = activePanelAgentRun
    ? agentRunMessageIds.get(activePanelAgentRun.runId) ?? null
    : null

  // A completed or paused browser leaves the side panel immediately. For a
  // real `ask`, the inline live view remains visible in the chat (outside the
  // finalized "Worked for" disclosure); checkpoints likewise stop occupying
  // half the desktop while the parent decides whether to continue. Track each
  // live panel and automatic close once so opening historical details by hand
  // still works and a deliberate later click can reopen the finished run.
  const liveBrowserPanelRunIdsRef = React.useRef<Set<string>>(new Set())
  const autoClosedBrowserRunIdsRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    const run = activePanelAgentRun
    if (!run || run.agentId !== "browser_agent") return
    if (!shouldAutoCloseBrowserAgentPanel(run)) {
      liveBrowserPanelRunIdsRef.current.add(run.runId)
      return
    }
    if (
      !liveBrowserPanelRunIdsRef.current.has(run.runId) ||
      autoClosedBrowserRunIdsRef.current.has(run.runId)
    )
      return

    autoClosedBrowserRunIdsRef.current.add(run.runId)
    setActiveAgentRunId(null)
    if (sidebarWasOpenRef.current) setSidebarOpen(true)
  }, [activePanelAgentRun, setSidebarOpen])
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
  const [resetConversationId, setResetConversationId] =
    React.useState(conversationId)
  React.useLayoutEffect(() => {
    if (resetConversationId === conversationId) return
    setResetConversationId(conversationId)
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
    if (anchorSettleRef.current) {
      window.cancelAnimationFrame(anchorSettleRef.current.frameId)
      anchorSettleRef.current = null
    }
    if (postRestoreHoldRef.current) {
      window.cancelAnimationFrame(postRestoreHoldRef.current.frameId)
      postRestoreHoldRef.current = null
    }
    // Entering a conversation must ALWAYS restore — the latch from a previous
    // stay is stale. Without this, returning to a chat whose successor's
    // restore never fired (rAF parked in a hidden/backgrounded tab) skipped
    // the restore entirely and revealed the view at a clamped position.
    restoredScrollConversationRef.current = null
    setRestoredScrollConversationId(null)
    olderLoadAnchorRef.current = null
    olderLoadRequestedRef.current = false
    streamingScrollAnchorRef.current = null
    finalizeAnchorRef.current = null
    wasStreamingRef.current = false
    wasStreamingLayoutRef.current = false
    // The previous conversation's scroll position must never be re-applied by
    // the tail-spacer clamp-undo; stays null until this conversation's restore
    // (or a real scroll event) records a trustworthy position.
    lastObservedScrollTopRef.current = null
    spacerBurstScrollTopRef.current = null
    spacerBurstLastRecomputeAtRef.current = 0
  }, [conversationId, resetConversationId])

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

  React.useEffect(() => {
    const handleLocalSubmitAnchor = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail
      if (!isLocalSubmitAnchorDetail(detail)) return
      pendingLocalSubmitAnchorRef.current = detail
    }

    window.addEventListener(
      LOCAL_SUBMIT_ANCHOR_EVENT,
      handleLocalSubmitAnchor
    )
    return () =>
      window.removeEventListener(
        LOCAL_SUBMIT_ANCHOR_EVENT,
        handleLocalSubmitAnchor
      )
  }, [])

  React.useEffect(() => {
    const handleScrollTarget = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail
      if (!isChatScrollTargetDetail(detail)) return
      pendingScrollTargetRef.current = detail
    }
    window.addEventListener(CHAT_SCROLL_TARGET_EVENT, handleScrollTarget)
    return () =>
      window.removeEventListener(CHAT_SCROLL_TARGET_EVENT, handleScrollTarget)
  }, [])

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

  const persistCurrentScrollPosition = React.useCallback(() => {
    const conversationId = activeIdRef.current
    const element = scrollContainerRef.current
    if (!conversationId || !element) return false
    // Mid-restore (chase/settle) the layout is transient — flushing it here
    // (pagehide while the view is still settling) would overwrite the real
    // saved position that restore is still trying to reach.
    if (restoredScrollConversationRef.current !== conversationId) return false
    if (
      element.scrollHeight <= element.clientHeight ||
      !element.querySelector('[id^="message-"]')
    ) {
      return false
    }

    const didSaveAnchor = saveScrollAnchor()
    if (!didSaveAnchor) return false

    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight
    const value =
      distanceFromBottom <= STICKY_BOTTOM_THRESHOLD
        ? SCROLL_BOTTOM_SENTINEL
        : Math.round(element.scrollTop).toString()
    localStorage.setItem(
      `scroll:chat:${conversationId}`,
      value
    )
    pendingScrollSaveRef.current = { conversationId, value }
    return true
  }, [saveScrollAnchor])

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

  const cancelPostRestoreHold = React.useCallback(() => {
    const hold = postRestoreHoldRef.current
    if (!hold) return
    postRestoreHoldRef.current = null
    window.cancelAnimationFrame(hold.frameId)
  }, [])

  // Keep the just-restored position pinned while lazy content is still
  // landing. The settle loop can only wait so long before revealing; anything
  // that reflows after the reveal (idle-scheduled Shiki, images, chunked
  // "Worked for" bodies, prepended history pages) would otherwise drift the
  // view away from the position we just restored. Runs until the deadline or
  // the first real user input — whichever comes first.
  const startPostRestoreHold = React.useCallback(
    (conversationId: string, mode: "anchor" | "bottom", anchor?: SavedScrollRestore | null) => {
      cancelPostRestoreHold()
      const heldAnchor = mode === "anchor" ? anchor ?? getCurrentScrollAnchor() : null
      if (mode === "anchor" && !heldAnchor) return
      const tick = () => {
        const hold = postRestoreHoldRef.current
        if (!hold) return
        const element = scrollContainerRef.current
        if (
          !element ||
          activeIdRef.current !== hold.conversationId ||
          Date.now() > hold.until
        ) {
          postRestoreHoldRef.current = null
          return
        }
        if (hold.mode === "bottom") {
          const maxScrollTop = Math.max(
            0,
            element.scrollHeight - element.clientHeight
          )
          if (Math.abs(element.scrollTop - maxScrollTop) > 1) {
            element.scrollTop = maxScrollTop
            lastObservedScrollTopRef.current = element.scrollTop
          }
        } else if (hold.anchor) {
          const anchorElement = document.getElementById(
            `message-${hold.anchor.messageId}`
          )
          if (anchorElement) {
            const offsetNow =
              anchorElement.getBoundingClientRect().top -
              element.getBoundingClientRect().top
            if (Math.abs(offsetNow - hold.anchor.offset) > 1) {
              restoreScrollAnchor(hold.anchor)
              lastObservedScrollTopRef.current = element.scrollTop
            }
          }
        }
        hold.frameId = window.requestAnimationFrame(tick)
      }
      postRestoreHoldRef.current = {
        conversationId,
        mode,
        anchor: heldAnchor,
        frameId: window.requestAnimationFrame(tick),
        until: Date.now() + POST_RESTORE_HOLD_MS,
      }
    },
    [cancelPostRestoreHold, getCurrentScrollAnchor, restoreScrollAnchor]
  )

  // Any real user input releases the hold instantly — these fire before the
  // scroll events they cause, so the hold never fights the user for control.
  React.useEffect(() => {
    const release = () => cancelPostRestoreHold()
    window.addEventListener("wheel", release, { capture: true, passive: true })
    window.addEventListener("touchstart", release, { capture: true, passive: true })
    window.addEventListener("mousedown", release, true)
    window.addEventListener("keydown", release, true)
    return () => {
      window.removeEventListener("wheel", release, true)
      window.removeEventListener("touchstart", release, true)
      window.removeEventListener("mousedown", release, true)
      window.removeEventListener("keydown", release, true)
    }
  }, [cancelPostRestoreHold])

  React.useEffect(() => {
    const flushCurrentScroll = () => {
      persistCurrentScrollPosition()
    }

    window.addEventListener("pagehide", flushCurrentScroll)
    window.addEventListener("beforeunload", flushCurrentScroll)
    window.addEventListener(CHAT_VIEW_SAVE_STATE_EVENT, flushCurrentScroll)

    return () => {
      window.removeEventListener("pagehide", flushCurrentScroll)
      window.removeEventListener("beforeunload", flushCurrentScroll)
      window.removeEventListener(CHAT_VIEW_SAVE_STATE_EVENT, flushCurrentScroll)

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
  }, [flushPendingScrollSave, persistCurrentScrollPosition])

  const syncScrollState = React.useCallback(() => {
    const element = scrollContainerRef.current
    if (!element) return

    lastObservedScrollTopRef.current = element.scrollTop
    revealScrollbar()

    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight
    lastDistanceFromBottomRef.current = distanceFromBottom
    const isPinnedToBottom = distanceFromBottom <= STICKY_BOTTOM_THRESHOLD

    // Auto-load older messages as the user nears the top (replaces the manual
    // "Load older messages" button). Gated on a settled restore and a genuine
    // (non-programmatic) scroll so a transient scrollTop≈0 while the view opens
    // or settles doesn't prematurely page. requestOlderMessages self-guards
    // against concurrent/exhausted loads and captures the prepend anchor, so
    // firing it every near-top scroll tick is safe — after a prepend the anchor
    // restore pushes scrollTop back down, away from the trigger zone.
    if (
      !ignoreSyncRef.current &&
      restoredScrollConversationRef.current === activeIdRef.current &&
      element.scrollTop <= OLDER_MESSAGES_AUTOLOAD_THRESHOLD_PX
    ) {
      requestOlderMessages()
    }

    if (
      activeIdRef.current &&
      !ignoreSyncRef.current &&
      // Until this conversation's initial restore has completed, passive
      // scroll events are clamp/layout noise from pages prepending and the
      // view settling — persisting them would overwrite the REAL saved
      // position with a mid-restore snapshot (which is how long
      // conversations used to lose their spot).
      restoredScrollConversationRef.current === activeIdRef.current
    ) {
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
    requestOlderMessages,
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
          if (messageTopAnchorMessageIdRef.current === messageId) {
            scrollMessageToTop(messageId, "auto")
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
      // rAF callbacks queued while the tab is hidden fire on the first frame
      // after the user returns — a smooth scroll scheduled in the background
      // would play as a visible animation right at that moment. Snap instead.
      const scheduledWhileHidden = document.visibilityState === "hidden"
      const run = () => {
        const didStart = scrollMessageToTop(
          messageId,
          animationStarted || scheduledWhileHidden ? "auto" : "smooth"
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
    [scrollMessageToTop, syncScrollState]
  )

  const persistTailSpacerState = React.useCallback(
    (nextMinHeight: number, nextMinHeightMsgId: string | null) => {
      minHeightActiveRef.current = nextMinHeight > 0
      setMinHeightMsgId(nextMinHeightMsgId)
      setMinHeight(nextMinHeight)

      if (conversationId) {
        if (nextMinHeight > 0) {
          localStorage.setItem(
            `chat:minHeight:${conversationId}`,
            JSON.stringify({
              minHeight: nextMinHeight,
              minHeightMsgId: nextMinHeightMsgId,
              viewportHeight: window.innerHeight,
            })
          )
        } else {
          localStorage.removeItem(`chat:minHeight:${conversationId}`)
        }
      }
    },
    [conversationId]
  )

  const prepareTailSpacerForSubmittedMessage = React.useCallback(
    (userMessageId: string) => {
      const messages = transcriptMessages
      const userIndex = messages.findIndex(
        (message) => message.id === userMessageId && message.role === "user"
      )
      if (userIndex < 0) return false

      const lastMessage = messages[messages.length - 1]
      const nextMessage = messages[userIndex + 1]
      let nextMinHeight = 0
      let nextMinHeightMsgId: string | null = null

      if (lastMessage?.id === userMessageId) {
        nextMinHeight = getTailResponseMinHeight(
          userMessageId,
          streamingBubbleContainerRef.current
        )
      } else if (isAssistantMessageInProgress(nextMessage)) {
        if (showStreamingBubble) {
          nextMinHeight = getTailResponseMinHeight(
            userMessageId,
            streamingBubbleContainerRef.current
          )
        } else {
          const assistantElement = document.getElementById(
            `message-${nextMessage.id}`
          )
          nextMinHeight =
            assistantElement instanceof HTMLElement
              ? getCommittedTailSpacer(userMessageId, assistantElement)
              : getTailResponseMinHeight(userMessageId, null)
          nextMinHeightMsgId =
            assistantElement instanceof HTMLElement ? nextMessage.id : null
        }
      } else {
        return false
      }

      persistTailSpacerState(nextMinHeight, nextMinHeightMsgId)
      return true
    },
    [
      transcriptMessages,
      getCommittedTailSpacer,
      getTailResponseMinHeight,
      persistTailSpacerState,
      showStreamingBubble,
    ]
  )

  const consumeSubmittedMessageAnchor = React.useCallback(() => {
    if (!conversationId) return false

    const pending = pendingLocalSubmitAnchorRef.current
    const anchor =
      pending?.conversationId === conversationId &&
      isLocalSubmitAnchorFresh(pending)
        ? pending
        : readLocalSubmitAnchor(conversationId)
    if (!anchor) return false

    const messageElement = document.getElementById(`message-${anchor.messageId}`)
    if (!messageElement) return false
    if (!prepareTailSpacerForSubmittedMessage(anchor.messageId)) return false

    pendingLocalSubmitAnchorRef.current = null
    consumeLocalSubmitAnchor(conversationId, anchor.messageId)
    autoScrollEnabledRef.current = false
    followStreamingRef.current = false
    setScrollButtonVisible(false)
    suppressBtnRef.current = true
    window.setTimeout(() => {
      suppressBtnRef.current = false
    }, 300)
    scheduleMessageTopAnchor(anchor.messageId)
    return true
  }, [
    conversationId,
    prepareTailSpacerForSubmittedMessage,
    scheduleMessageTopAnchor,
    setScrollButtonVisible,
  ])

  const refreshPendingMessageTopAnchor = React.useCallback(() => {
    const messageId = messageTopAnchorMessageIdRef.current
    if (!messageId) return false
    // The smooth scroll-to-top is already in flight (startedAt is stamped the
    // moment the animation fires and cleared on release). Re-preparing the tail
    // spacer or re-scheduling now mutates layout mid-animation, which iOS Safari
    // resolves by abandoning the smooth scroll and snapping to the end — the
    // "sometimes it glides, sometimes it jumps" race on send, since whether a
    // ResizeObserver / keyboard-inset tick lands inside the ~420ms window is
    // timing-dependent. Keep the anchor guard truthy so those callers still skip
    // their instant scrollToBottom fallback, but leave the running animation
    // alone; the release pass snaps to the exact target once it settles.
    if (messageTopAnchorStartedAtRef.current > 0) return true
    if (!prepareTailSpacerForSubmittedMessage(messageId)) return false
    scheduleMessageTopAnchor(messageId)
    return true
  }, [prepareTailSpacerForSubmittedMessage, scheduleMessageTopAnchor])

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

  React.useLayoutEffect(() => {
    consumeSubmittedMessageAnchor()
  }, [
    consumeSubmittedMessageAnchor,
    isStreamingThisConversation,
    messageCount,
    state.streamingContent,
    state.streamingContentSegments,
    state.streamingReasoning,
  ])

  React.useEffect(() => {
    const element = scrollContainerRef.current
    if (!element) return

    // A genuine user scroll gesture (wheel/touch) means the user has taken
    // control of the scroll position. Always clear the programmatic-scroll lock
    // so the scroll handler can re-evaluate the scroll-to-bottom button. Without
    // this, if `ignoreSyncRef` was left set by a prior programmatic scroll /
    // restore (the `cancelMessageTopAnchor` path only clears it when a send
    // anchor is pending), the button could stay hidden no matter how far the
    // user scrolls up.
    const markUserScrollIntent = () => {
      if (!ignoreSyncRef.current) return
      ignoreSyncRef.current = false
      syncScrollState()
    }

    syncScrollState()
    element.addEventListener("scroll", syncScrollState, { passive: true })
    element.addEventListener("wheel", cancelMessageTopAnchor, { passive: true })
    element.addEventListener("wheel", markUserScrollIntent, { passive: true })
    element.addEventListener("touchmove", cancelMessageTopAnchor, {
      passive: true,
    })
    element.addEventListener("touchmove", markUserScrollIntent, {
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
      element.removeEventListener("wheel", markUserScrollIntent)
      element.removeEventListener("touchmove", cancelMessageTopAnchor)
      element.removeEventListener("touchmove", markUserScrollIntent)
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

        if (refreshPendingMessageTopAnchor()) return

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
  }, [
    conversationId,
    refreshPendingMessageTopAnchor,
    scrollToBottom,
    syncScrollState,
  ])

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

    if (refreshPendingMessageTopAnchor()) return

    if (
      lastDistanceFromBottomRef.current <= STICKY_BOTTOM_THRESHOLD ||
      autoScrollEnabledRef.current
    ) {
      scrollToBottom("auto")
      syncScrollState()
      return
    }

    syncScrollState()
  }, [
    keyboardInset,
    refreshPendingMessageTopAnchor,
    scrollToBottom,
    syncScrollState,
  ])

  // Measure synchronously before paint so the scroll-to-bottom button is placed
  // against the real input height from the first frame — otherwise it briefly
  // uses the stale default offset and can overlap the input until the observer
  // catches up.
  React.useLayoutEffect(() => {
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
    const messages = transcriptMessages
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
    transcriptMessages,
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
    const messages = transcriptMessages
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
    transcriptMessages,
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
    const messages = transcriptMessages
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
    transcriptMessages,
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
    const messages = transcriptMessages
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
    transcriptMessages,
    conversationId,
    getCommittedTailSpacer,
    isMessageNearTopAnchor,
    minHeight,
    minHeightMsgId,
    scheduleMessageTopAnchor,
    showStreamingBubble,
    isStreamingThisConversation,
  ])

  // The committed tail message can keep changing height after stream end without
  // flipping any React dependency above: deferred reasoning bodies mount lazily,
  // Shiki highlights on idle, fonts/images settle. Any of those shrinks the
  // answer below the viewport while the spacer — measured once at stream end —
  // stays too small, so the top-anchor is lost ("the virtual space disappears").
  // Observe the committed message's content box and re-derive the spacer whenever
  // it settles. Also recompute when the tab regains visibility: a stream that
  // finishes in a backgrounded tab measures under throttled rAF/layout, so the
  // spacer is stale until the user returns.
  React.useLayoutEffect(() => {
    if (
      !conversationId ||
      isStreamingThisConversation ||
      !minHeightMsgId ||
      minHeightMsgId !== latestAssistantMessageId
    )
      return
    const messages = transcriptMessages
    const lastMsg = messages[messages.length - 1]
    const previousMsg = messages[messages.length - 2]
    if (
      !lastMsg ||
      lastMsg.id !== minHeightMsgId ||
      lastMsg.role !== "assistant" ||
      previousMsg?.role !== "user"
    )
      return
    const assistantElement = document.getElementById(`message-${lastMsg.id}`)
    // Observe the content child, not the wrapper: the spacer is applied as the
    // wrapper's paddingBottom, so observing the wrapper would feed our own update
    // back in. getCommittedTailSpacer also measures the content child's height.
    const content = assistantElement?.firstElementChild
    if (
      !(assistantElement instanceof HTMLElement) ||
      !(content instanceof HTMLElement)
    )
      return

    // Commit the DOM-applied spacer to React + storage once the burst settles.
    // Committing per frame would re-render the whole chat on every frame of
    // the 360ms collapse animation (jank); the commit only exists so the next
    // React render keeps the padding the DOM already has.
    let commitTimeout: number | null = null
    const commitSpacerState = () => {
      commitTimeout = null
      const spacer = minHeightRef.current
      setMinHeight(spacer)
      localStorage.setItem(
        `chat:minHeight:${conversationId}`,
        JSON.stringify({
          minHeight: spacer,
          minHeightMsgId: lastMsg.id,
          viewportHeight: window.innerHeight,
        })
      )
    }

    const recompute = () => {
      // Burst bookkeeping: the observer fires once per frame while a collapse/
      // expand animation runs. A gap means a fresh burst — freeze the current
      // stable position as the restore target for the whole burst (mid-burst
      // clamps are reported to the scroll listener as real scrolls, so the
      // listener ref decays during the burst and restoring against it drifts).
      const now = performance.now()
      if (now - spacerBurstLastRecomputeAtRef.current > 250) {
        spacerBurstScrollTopRef.current = lastObservedScrollTopRef.current
      }
      spacerBurstLastRecomputeAtRef.current = now

      // Fractional spacer: the content animates through fractional heights
      // while the integer-ceil spacer (getCommittedTailSpacer) can only step
      // whole pixels, so the total height wobbled up to ±1px around the
      // target each frame — with the view pinned to it, that painted as 1px
      // up/down "nano jitter". Deriving the spacer from the raw rect keeps
      // the total constant to sub-pixel precision, so no clamp ever fires.
      const nextSpacer = Math.max(
        0,
        getTailResponseMinHeight(previousMsg.id, assistantElement) -
          content.getBoundingClientRect().height
      )
      if (Math.abs(nextSpacer - minHeightRef.current) > 0.1) {
        // Apply the spacer to the DOM right here: ResizeObserver callbacks run
        // after layout but before paint, so the content resize and this
        // compensation land in the same painted frame. Deferring (rAF or React
        // alone) paints a frame with the wrong total height, which the browser
        // answers by clamping scrollTop — the "collapse a dropdown and the
        // chat scrolls up" jump. Tracking every change matters: skipping
        // small deltas (the old 4px threshold) leaves the slow tail of the
        // eased animation uncompensated for a few frames at a time, which
        // reads as up/down micro-jitter on the anchored message.
        assistantElement.style.paddingBottom = `${nextSpacer.toFixed(2)}px`
        minHeightActiveRef.current = nextSpacer > 0
        minHeightRef.current = nextSpacer
        if (commitTimeout !== null) window.clearTimeout(commitTimeout)
        commitTimeout = window.setTimeout(commitSpacerState, 180)
      }

      // Undo any clamp the resize caused, restoring toward the position the
      // view held before this burst started. Pre-paint, so the view appears
      // perfectly still (a no-op when nothing was clamped). Runs on every
      // observer fire — not only on spacer writes — so no clamped frame slips
      // through unconverted. While the content momentarily exceeds what the
      // spacer can absorb, the restore tracks the reachable maximum and lands
      // back on the frozen position once the spacer regrows.
      const scrollElement = scrollContainerRef.current
      const stableScrollTop = spacerBurstScrollTopRef.current
      if (scrollElement && stableScrollTop !== null) {
        const maxScrollTop = Math.max(
          0,
          scrollElement.scrollHeight - scrollElement.clientHeight
        )
        const target = Math.min(stableScrollTop, maxScrollTop)
        if (Math.abs(scrollElement.scrollTop - target) > 0.1) {
          scrollElement.scrollTop = target
        }
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") recompute()
    }
    // Real user scrolling mid-burst must win over the frozen restore target:
    // drop the freeze so the remaining burst frames leave the wheel/touch
    // position alone (the next burst re-freezes from the listener ref).
    const onUserScrollIntent = () => {
      spacerBurstScrollTopRef.current = null
    }

    const scrollElement = scrollContainerRef.current
    const observer = new ResizeObserver(recompute)
    observer.observe(content)
    document.addEventListener("visibilitychange", onVisibilityChange)
    window.addEventListener("focus", recompute)
    scrollElement?.addEventListener("wheel", onUserScrollIntent, {
      passive: true,
    })
    scrollElement?.addEventListener("touchmove", onUserScrollIntent, {
      passive: true,
    })
    return () => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.removeEventListener("focus", recompute)
      scrollElement?.removeEventListener("wheel", onUserScrollIntent)
      scrollElement?.removeEventListener("touchmove", onUserScrollIntent)
      if (commitTimeout !== null) {
        // Flush instead of drop: a re-arm (deps changed mid-burst) would
        // otherwise let the next React render repaint the wrapper with the
        // stale pre-burst padding.
        window.clearTimeout(commitTimeout)
        commitSpacerState()
      }
    }
  }, [
    transcriptMessages,
    conversationId,
    getTailResponseMinHeight,
    isStreamingThisConversation,
    latestAssistantMessageId,
    minHeightMsgId,
  ])

  // Track where the streaming answer's bottom sits on screen, refreshed every
  // streaming frame. The committed bubble that replaces the streaming one at
  // finalize folds its working trace shut in the same commit it mounts (no
  // animation a ResizeObserver could follow), so this captured "before" is the
  // only way the finalize effect can tell how far the answer moved.
  React.useLayoutEffect(() => {
    if (!isStreamingThisConversation || !conversationId) return
    const container = scrollContainerRef.current
    const streamChild = streamingBubbleContainerRef.current?.firstElementChild
    if (!container || !(streamChild instanceof HTMLElement)) return
    const containerTop = container.getBoundingClientRect().top
    finalizeAnchorRef.current = {
      conversationId,
      contentBottomOffset:
        streamChild.getBoundingClientRect().bottom - containerTop,
      distanceFromBottom:
        container.scrollHeight - container.scrollTop - container.clientHeight,
    }
  }, [
    conversationId,
    isStreamingThisConversation,
    state.streamingContent,
    state.streamingContentSegments,
    state.streamingReasoning,
  ])

  // Finishing a resumed stream can resize the tail spacer before the browser's
  // own scroll anchoring settles. If the user was reading above bottom, keep
  // that message anchored instead of letting the final row pull the view down.
  React.useLayoutEffect(() => {
    const streamingFinished =
      wasStreamingLayoutRef.current && !isStreamingThisConversation
    wasStreamingLayoutRef.current = isStreamingThisConversation

    if (!streamingFinished || !conversationId) return
    const fin = finalizeAnchorRef.current
    finalizeAnchorRef.current = null
    const saved = streamingScrollAnchorRef.current
    streamingScrollAnchorRef.current = null

    if (followStreamingRef.current) return

    const container = scrollContainerRef.current
    if (!container) return

    // Preferred path: keep the just-finalized answer pinned exactly where it sat
    // on screen. Folding the working trace into the one-line "Worked for …"
    // disclosure removes height *above* the answer in the same commit the
    // committed bubble mounts (no animation to follow), so the answer jumps up by
    // the folded height. We captured the answer's on-screen bottom every
    // streaming frame (fin); undo the jump by shifting scrollTop the same amount,
    // absorbing the freed space at the top so the reader's text never moves.
    // Applies near the bottom too (a non-follow reader watching it finish) — only
    // an active bottom-follow is excluded, by the early return above. A
    // message-level anchor can't fix this: the message top never moves, only the
    // content between it and the answer.
    if (fin && fin.conversationId === conversationId) {
      const lastMsg = transcriptMessages.at(-1)
      const wrapper =
        lastMsg?.role === "assistant" &&
        lastMsg.id === latestAssistantIdRef.current
          ? document.getElementById(`message-${lastMsg.id}`)
          : null
      const content = wrapper?.firstElementChild
      if (wrapper instanceof HTMLElement && content instanceof HTMLElement) {
        const containerTop = container.getBoundingClientRect().top
        const wrapperTop = wrapper.getBoundingClientRect().top - containerTop
        // Compensate whenever the folding trace sits above the viewport bottom —
        // the turn is at least partially on screen or scrolled above it, so the
        // collapse moves what the reader is looking at. When the whole turn is
        // still below the fold (the reader is up in earlier messages) the
        // collapse happens off-screen below them and must NOT shift their view,
        // so skip it and let the message-anchor fallback handle that case.
        if (wrapperTop < container.clientHeight) {
          // Discount the committed bubble's trailing meta row (timestamp/actions)
          // — the streaming bubble has no equivalent, so the answer bottoms line
          // up exactly instead of ~a row apart.
          const meta = content.lastElementChild
          const metaH =
            meta instanceof HTMLElement
              ? meta.getBoundingClientRect().height + 6 /* column gap */
              : 0
          const answerBottom =
            content.getBoundingClientRect().bottom - containerTop - metaH
          const delta = answerBottom - fin.contentBottomOffset
          if (delta < -1) {
            ignoreSyncRef.current = true
            const maxScrollTop = Math.max(
              0,
              container.scrollHeight - container.clientHeight
            )
            container.scrollTop = Math.min(
              Math.max(0, container.scrollTop + delta),
              maxScrollTop
            )
            const frame = window.requestAnimationFrame(() => {
              ignoreSyncRef.current = false
              saveScrollAnchor()
              syncScrollState()
            })
            return () => {
              window.cancelAnimationFrame(frame)
              ignoreSyncRef.current = false
            }
          }
        }
      }
    }

    // Fallback: pin the topmost message the user was reading (covers the case
    // where they had scrolled up past the finalized turn entirely).
    if (
      !saved ||
      saved.conversationId !== conversationId ||
      saved.anchor.distanceFromBottom <= STICKY_BOTTOM_THRESHOLD
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
    transcriptMessages,
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

    // A deep-link jump (Library → "View in chat") owns the initial scroll for
    // this conversation; don't let the default restore / settleBottom fight it.
    // Marking restore done is sticky, so a later normal open of this same
    // conversation (after the target is consumed) is unaffected.
    if (
      pendingScrollTargetRef.current?.conversationId === conversationId ||
      readChatScrollTarget(conversationId)
    ) {
      restoredScrollConversationRef.current = conversationId
      setRestoredScrollConversationId(conversationId)
      return
    }

    // An anchor-settle loop from this conversation's restore is still running;
    // it owns the restore and sets the latch once the layout reads stable.
    if (anchorSettleRef.current?.conversationId === conversationId) return

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
      // The anchor message is older than the loaded page. Chase it with the
      // shared largest-page loader (bounded internally), then re-run this
      // effect and restore over the fully loaded range. The view stays hidden
      // the whole time (isAwaitingInitialScrollRestore), so the user sees a
      // single fade-in at the final position instead of paging jumps. Same
      // budget on mobile and desktop — giving up early is what used to lose
      // the reading position on long conversations.
      const chase = restoreOlderAttemptRef.current
      const exhausted =
        chase?.conversationId === conversationId &&
        chase.status === "exhausted"
      if (!exhausted) {
        if (
          chase?.conversationId === conversationId ||
          isLoadingOlderMessages ||
          olderLoadRequestedRef.current
        ) {
          return
        }
        if (hasOlderMessages) {
          const anchorMessageId = savedAnchor.messageId
          restoreOlderAttemptRef.current = { conversationId, status: "chasing" }
          void loadMessagesUntilPresent(conversationId, anchorMessageId).then(
            (found) => {
              if (
                restoreOlderAttemptRef.current?.conversationId !==
                conversationId
              ) {
                return
              }
              restoreOlderAttemptRef.current = found
                ? null
                : { conversationId, status: "exhausted" }
              setRestoreChaseTick((tick) => tick + 1)
            }
          )
          return
        }
      }
      // Exhausted or no more history: fall through to the fallback restore.
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
        lastObservedScrollTopRef.current = element.scrollTop
      }
      if (remainingFrames <= 0) {
        bottomSettleFrameIdRef.current = null
        setIsRestoringScroll(false)
        saveScrollAnchor()
        syncScrollState()
        // Late-mounting content keeps growing the list after the reveal; keep
        // the view pinned to the bottom until it quiets down or the user acts.
        startPostRestoreHold(conversationId, "bottom")
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
      lastObservedScrollTopRef.current = element.scrollTop
      const settleAnchorTarget =
        !shouldRestoreBottom && anchorScrollTop != null ? savedAnchor : null
      if (shouldRestoreBottom) {
        bottomSettleFrameIdRef.current = window.requestAnimationFrame(() =>
          settleBottom(5)
        )
        restoredScrollConversationRef.current = conversationId
        setRestoredScrollConversationId(conversationId)
      } else if (settleAnchorTarget) {
        // Late reflows (fonts settling, "Show more" clamps, deferred blocks,
        // width changes) keep shifting the content above the anchor after
        // this first placement, drifting the restored position by hundreds of
        // pixels. Hold the reveal (latch stays unset, so the list stays
        // hidden) and re-derive the anchor position every frame until it
        // reads stable for a few consecutive frames — one fade-in, at the
        // settled spot. The loop is ref-owned so effect re-runs (e.g.
        // hasOlderMessages flipping right after a chase) can't cancel it
        // mid-flight; it self-terminates on conversation switch or unmount.
        const anchor = settleAnchorTarget
        // ~1.5s budget: heavy conversations (lots of markdown, collapsed
        // blocks measuring in) reflow well past the old 30-frame window, and
        // giving up early revealed the view mid-drift. Stability requires 5
        // consecutive quiet frames so a lull between reflows doesn't pass.
        let framesLeft = 90
        let stableFrames = 0
        const tick = () => {
          const settleElement = scrollContainerRef.current
          if (!settleElement || activeIdRef.current !== conversationId) {
            anchorSettleRef.current = null
            ignoreSyncRef.current = false
            return
          }
          // Re-assert the sync hold every tick: an effect re-run's cleanup
          // may have dropped it, and a save fired off a mid-settle layout
          // would overwrite the real saved anchor with garbage.
          ignoreSyncRef.current = true
          const anchorElementNow = document.getElementById(
            `message-${anchor.messageId}`
          )
          const offsetNow = anchorElementNow
            ? anchorElementNow.getBoundingClientRect().top -
              settleElement.getBoundingClientRect().top
            : null
          if (offsetNow != null && Math.abs(offsetNow - anchor.offset) <= 1) {
            stableFrames += 1
          } else {
            stableFrames = 0
            restoreScrollAnchor(anchor)
            lastObservedScrollTopRef.current = settleElement.scrollTop
          }
          framesLeft -= 1
          if (stableFrames >= 5 || framesLeft <= 0) {
            anchorSettleRef.current = null
            restoredScrollConversationRef.current = conversationId
            setRestoredScrollConversationId(conversationId)
            ignoreSyncRef.current = false
            setIsRestoringScroll(false)
            saveScrollAnchor()
            syncScrollState()
            // The reveal happens here, but lazy content keeps reflowing for a
            // while — hold the anchor so the position survives it.
            startPostRestoreHold(conversationId, "anchor", anchor)
            return
          }
          anchorSettleRef.current = {
            conversationId,
            frameId: window.requestAnimationFrame(tick),
          }
        }
        anchorSettleRef.current = {
          conversationId,
          frameId: window.requestAnimationFrame(tick),
        }
      } else {
        restoredScrollConversationRef.current = conversationId
        setRestoredScrollConversationId(conversationId)
      }
      restoreOlderAttemptRef.current = null
      if (settleAnchorTarget) {
        // The settle loop owns the rest: it keeps the sync hold, and only
        // once the anchor position reads stable does it reveal + persist.
        // Saving here would snapshot a mid-reflow layout over the user's
        // real position.
        return
      }
      ignoreSyncRef.current = false
      if (!shouldPinBottom) setIsRestoringScroll(false)
      saveScrollAnchor()
      syncScrollState()
      // Legacy numeric restore (no anchor payload): pin whatever position we
      // landed on so late reflows don't drift it. Bottom restores start their
      // hold when settleBottom completes instead.
      if (!shouldRestoreBottom) startPostRestoreHold(conversationId, "anchor")
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
    loadMessagesUntilPresent,
    messageCount,
    restoreChaseTick,
    restoreScrollAnchor,
    saveScrollAnchor,
    setScrollButtonVisible,
    startPostRestoreHold,
    syncScrollState,
  ])

  // ---- Deep-link "scroll to message" (Library → "View in chat") -----------
  // Once the target conversation's messages are in the DOM, scroll to the
  // requested message and highlight it. Pages older messages first if the
  // target is beyond the loaded page. Suppressed default scroll-restore (above)
  // hands the initial scroll to scheduleMessageTopAnchor.
  const consumeScrollTarget = React.useCallback(() => {
    if (!conversationId) return
    const loadState = state.conversationLoadState[conversationId]
    if (loadState !== "partial" && loadState !== "full") return

    const pending = pendingScrollTargetRef.current
    const target =
      pending?.conversationId === conversationId &&
      isChatScrollTargetFresh(pending)
        ? pending
        : readChatScrollTarget(conversationId)
    if (!target) return

    const key = `${conversationId}:${target.messageId}`
    if (consumedScrollTargetRef.current === key) return
    consumedScrollTargetRef.current = key
    pendingScrollTargetRef.current = null
    consumeChatScrollTarget(conversationId, target.messageId)

    const runJump = () => {
      if (activeIdRef.current !== conversationId) return
      autoScrollEnabledRef.current = false
      followStreamingRef.current = false
      setScrollButtonVisible(false)
      scheduleMessageTopAnchor(target.messageId)
      setHighlightedMessageId(target.messageId)
    }

    const present =
      activeConversation?.messages.some((m) => m.id === target.messageId) ??
      false
    if (present) {
      runJump()
      return
    }

    // Older than the loaded page — page back until it's in the DOM, then jump.
    // On failure reset the dedupe guard so a deliberate re-click can retry.
    void loadMessagesUntilPresent(conversationId, target.messageId).then(
      (found) => {
        if (activeIdRef.current !== conversationId) return
        if (found) runJump()
        else consumedScrollTargetRef.current = null
      }
    )
  }, [
    conversationId,
    activeConversation?.messages,
    state.conversationLoadState,
    loadMessagesUntilPresent,
    scheduleMessageTopAnchor,
    setScrollButtonVisible,
  ])

  React.useLayoutEffect(() => {
    consumeScrollTarget()
  }, [consumeScrollTarget])

  React.useEffect(() => {
    if (!highlightedMessageId) return
    if (highlightTimeoutRef.current !== null) {
      window.clearTimeout(highlightTimeoutRef.current)
    }
    highlightTimeoutRef.current = window.setTimeout(() => {
      highlightTimeoutRef.current = null
      setHighlightedMessageId(null)
    }, 1500)
    return () => {
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current)
        highlightTimeoutRef.current = null
      }
    }
  }, [highlightedMessageId])

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

        if (!consumeSubmittedMessageAnchor()) {
          const messages = transcriptMessages
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
            // This fallback only runs for out-of-band stream starts (another
            // device/surface, a scheduled run, or a stream that began while
            // this tab was away) — a local send consumed its submit anchor
            // above. Only pin the user message to the top when the user was
            // already reading at the bottom; otherwise honor the restored
            // position instead of yanking the view with an animated scroll
            // the moment they return.
            const container = scrollContainerRef.current
            const nearBottom =
              !container ||
              container.scrollHeight -
                container.scrollTop -
                container.clientHeight <=
                STICKY_BOTTOM_THRESHOLD
            if (nearBottom) scheduleMessageTopAnchor(lastMsg.id)
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
            // This branch is only reachable when an assistant turn is already
            // mid-stream as we (re)enter the conversation — switching back into a
            // live chat, or reloading/recovering an interrupted stream. A genuine
            // send has a `user` tail (handled above), so here the scroll-restore
            // layout effect has already placed the view where the user left it.
            // Only re-pin the user message if they were actually reading at the
            // top anchor; otherwise honor the restored position instead of
            // yanking them back up to their message.
            if (
              restoredScrollConversationRef.current === conversationId &&
              isMessageNearTopAnchor(previousMsg.id)
            ) {
              scheduleMessageTopAnchor(previousMsg.id)
            }
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
    consumeSubmittedMessageAnchor,
    getCommittedTailSpacer,
    getTailResponseMinHeight,
    isMessageNearTopAnchor,
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
    transcriptMessages,
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

  const openGeneratedArtifactPanel = React.useCallback(
    (a: ArtifactRow) => {
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
      genArtifact,
      setSidebarOpen,
      sidebarOpen,
    ]
  )

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
      openGeneratedArtifactPanel(a)
    },
    [
      genArtifact,
      handleGenArtifactClose,
      openGeneratedArtifactPanel,
    ]
  )

  const handleAgentClose = React.useCallback(() => {
    setActiveAgentRunId(null)
    restoreSidebar()
  }, [restoreSidebar])

  const handleAgentOpen = React.useCallback(
    (run: AgentCallReasoningEntry) => {
      // Re-click on the same agent's chip toggles the panel shut, so the
      // inline button is a press-press affordance instead of a dead end once
      // the panel is already showing that agent (mirrors handleArtifactExpand).
      if (activeAgentRunId === run.runId) {
        handleAgentClose()
        return
      }
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
      activeAgentRunId,
      handleAgentClose,
      activePanelAgentRun,
      artifactOpen,
      genArtifact,
      setSidebarOpen,
      sidebarOpen,
    ]
  )

  // ── Browser run auto-open ─────────────────────────────────────────────
  // When a browser_agent run starts, pop the desktop side panel open on its
  // workspace (live view + console) so the user watches it without hunting
  // for the inline block. Auto-open fires once per run — closing the panel
  // mid-run is respected. Mobile keeps the inline live view untouched.
  const autoOpenedBrowserRunIdsRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    if (isMobile) return
    const startedRun = latestBrowserAgentRuns(activeTurnAgentRuns).find(
      (run) =>
        run.status === "running" &&
        !autoOpenedBrowserRunIdsRef.current.has(run.runId)
    )
    if (!startedRun) return
    autoOpenedBrowserRunIdsRef.current.add(startedRun.runId)
    const panelAlreadyOpen =
      artifactOpen || Boolean(genArtifact) || Boolean(activePanelAgentRun)
    if (!panelAlreadyOpen) {
      sidebarWasOpenRef.current = sidebarOpen
    }
    setActiveAgentRunId(startedRun.runId)
    setArtifactOpen(false)
    setGenArtifact(null)
    setSidebarOpen(false)
  }, [
    activeTurnAgentRuns,
    isMobile,
    artifactOpen,
    genArtifact,
    activePanelAgentRun,
    sidebarOpen,
    setSidebarOpen,
  ])

  // Inline browser blocks collapse to a chip while their run is in the panel.
  const browserPanelRunId =
    activePanelAgentRun?.agentId === "browser_agent"
      ? activePanelAgentRun.runId
      : null

  // While a browser run is live but its workspace is not in the side panel
  // (user closed it, or another artifact took the panel), surface a reopen
  // button in the chat header so the live view is always one click away.
  const reopenBrowserRun = React.useMemo(() => {
    if (isMobile) return null
    const liveRuns = latestBrowserAgentRuns(activeTurnAgentRuns).filter((run) =>
      isBrowserAgentRunLive(run)
    )
    const run = liveRuns[liveRuns.length - 1] ?? null
    return run && run.runId !== browserPanelRunId ? run : null
  }, [activeTurnAgentRuns, isMobile, browserPanelRunId])

  const handleLoadMessageDetails = React.useCallback(
    (messageId: string) => {
      if (!conversationId) return Promise.resolve()
      return loadMessageDetails(conversationId, messageId)
    },
    [conversationId, loadMessageDetails]
  )

  const handleLoadToolCallDetails = React.useCallback(
    (messageId: string, toolCallId: string) => {
      if (!conversationId) return Promise.reject(new Error("No conversation"))
      return loadToolCallDetails(conversationId, messageId, toolCallId)
    },
    [conversationId, loadToolCallDetails]
  )

  const handleLoadAgentToolCallDetails = React.useCallback(
    (toolCallId: string) => {
      if (!conversationId || !activePanelAgentMessageId) {
        return Promise.reject(new Error("No source message for agent tool"))
      }
      return loadToolCallDetails(
        conversationId,
        activePanelAgentMessageId,
        toolCallId
      )
    },
    [
      activePanelAgentMessageId,
      conversationId,
      loadToolCallDetails,
    ]
  )

  const handleLoadStreamingToolCallDetails = React.useCallback(
    (toolCallId: string) => {
      if (!conversationId || !activeStreamingMessageId) {
        return Promise.reject(new Error("No source message for streaming tool"))
      }
      return loadToolCallDetails(
        conversationId,
        activeStreamingMessageId,
        toolCallId
      )
    },
    [activeStreamingMessageId, conversationId, loadToolCallDetails]
  )

  const hasArtifact =
    (artifactOpen && !!artifact) ||
    !!genArtifact ||
    !!activePanelAgentRun
  const isBrowserAgentPanel =
    activePanelAgentRun?.agentId === "browser_agent"
  const activeArtifactResizeKey = React.useMemo(() => {
    // Keep browser width separate from generic artifacts and reuse it across
    // browser runs in this conversation. A fresh browser should not inherit a
    // narrow code/text artifact width.
    if (activePanelAgentRun?.agentId === "browser_agent")
      return "agent:browser_agent"
    if (activePanelAgentRun) return `agent:${activePanelAgentRun.runId}`
    if (genArtifact) return `generated:${genArtifact.identifier}`
    if (artifactOpen && artifact) return `legacy:${artifactKey(artifact)}`
    return null
  }, [
    activePanelAgentRun,
    artifact,
    artifactOpen,
    genArtifact,
  ])
  // Hide the message list until scroll is restored. Without this we'd show
  // an empty list while messages load, then fade it out + fade it back in
  // once `messageCount` flips past 0 — perceived as a second flash after the
  // outer wrapper's initial fade-in.
  const conversationLoadStatus = conversationId
    ? state.conversationLoadState[conversationId]
    : null
  const isAwaitingInitialMessages =
    conversationLoadStatus === "summary" || conversationLoadStatus === "loading"
  // On the first render for a different conversation, the state below can
  // still contain the id restored by the previous visit. In particular, a
  // quick A -> B -> A switch can return to A before B finishes restoring, so
  // `restoredScrollConversationId === conversationId` is stale for this one
  // commit. Treat the id change itself as unsettled; the reset layout effect
  // above then clears the stale state before paint and the normal restore path
  // releases the view once its geometry is final.
  const conversationChangedThisCommit =
    resetConversationId !== conversationId
  const isAwaitingInitialScrollRestore = Boolean(
    conversationId &&
    (conversationChangedThisCommit ||
      (restoredScrollConversationId !== conversationId &&
        (messageCount > 0 || isAwaitingInitialMessages)))
  )
  const isRestoringInitialFrame =
    isAwaitingInitialScrollRestore || isRestoringScroll
  const isMessageListHidden = isScrollJumpFading || isRestoringInitialFrame

  // Arm the instant first reveal on a background reload (see instantFirstReveal
  // above). Layout effect so it lands before the first paint — which, on a
  // backgrounded reload, only happens once the tab is foregrounded — and never
  // diverges from the server's first render.
  React.useLayoutEffect(() => {
    if (LOADED_WHILE_HIDDEN) setInstantFirstReveal(true)
  }, [])
  // Release it the moment the list first becomes visible, so the snap applies
  // only to that first reveal and subsequent conversation switches fade.
  React.useEffect(() => {
    if (instantFirstReveal && !isMessageListHidden) setInstantFirstReveal(false)
  }, [instantFirstReveal, isMessageListHidden])

  // Tell the page (lib/chat-view-settled) which conversation has its initial
  // layout settled (messages rendered + scroll restored), so the route-level
  // fade-in starts only once nothing will shift. Layout effect: it publishes
  // before paint on the commit that swaps conversations, so the page never
  // briefly treats the previous chat's settled state as the new one's.
  React.useLayoutEffect(() => {
    publishChatViewSettled(isRestoringInitialFrame ? null : conversationId)
  }, [conversationId, isRestoringInitialFrame])

  React.useEffect(() => {
    conversationIdRef.current = conversationId
  }, [conversationId])

  React.useEffect(() => {
    artifactResizeKeyRef.current = activeArtifactResizeKey
  }, [activeArtifactResizeKey])

  React.useLayoutEffect(() => {
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
      (isBrowserAgentPanel
        ? browserAgentPanelDefaultWidth(containerWidth)
        : conversationStoredWidth ?? ARTIFACT_PANEL_DEFAULT_WIDTH)

    setArtifactPanelWidth(clampArtifactPanelWidth(nextWidth, containerWidth))
  }, [activeArtifactResizeKey, conversationId, hasArtifact, isBrowserAgentPanel])

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

  // ── Generated artifact auto-open ──────────────────────────────────────
  // When the agent emits a panel artifact, pop the side panel open so the
  // user sees the rendered result without hunting for a launch card. Managed
  // dev previews keep this behavior even if an older agent omitted display.
  // If the panel is already showing an artifact and a newer version of the
  // same identifier lands, advance the panel to that version instead of
  // leaving stale content. Auto-open is tracked per artifact id so a duplicate
  // event never replays the open action.
  const autoOpenedPanelArtifactIdsRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => {
    function onArtifact(e: Event) {
      const row = (e as CustomEvent).detail as ArtifactRow | undefined
      if (!row) return
      if (row.conversationId !== conversationId) return
      const replacesOpenArtifact =
        genArtifact != null &&
        genArtifact.identifier === row.identifier &&
        genArtifact.id !== row.id
      const shouldAutoOpenPanel =
        (decideRowRenderTarget(row) === "panel" ||
          row.type === "application/vnd.ant.dev-preview") &&
        !autoOpenedPanelArtifactIdsRef.current.has(row.id)

      if (shouldAutoOpenPanel) {
        autoOpenedPanelArtifactIdsRef.current.add(row.id)
      }
      if (!replacesOpenArtifact && !shouldAutoOpenPanel) return
      openGeneratedArtifactPanel(row)
    }
    window.addEventListener("orch:artifact", onArtifact)
    return () => window.removeEventListener("orch:artifact", onArtifact)
  }, [conversationId, genArtifact, openGeneratedArtifactPanel])

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
      <MarkdownImagePreviewProvider
        onPreview={openPreview}
      >
      <BrowserPanelProvider panelRunId={browserPanelRunId}>
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
              {reopenBrowserRun && (
                <button
                  type="button"
                  onClick={() => handleAgentOpen(reopenBrowserRun)}
                  className="relative ml-auto flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Open browser live view"
                  title="Open browser live view"
                >
                  <Monitor className="size-4" />
                  <span className="absolute top-1 right-1 size-1.5 animate-pulse rounded-full bg-sky-500" aria-hidden="true" />
                </button>
              )}
            </div>
            {/* Solid fill faded by an alpha-only mask instead of a color
                gradient to transparent: gradient stops interpolate through
                transparent *black* on engines without premultiplied alpha
                (iOS 27 beta WebKit), which rendered this fade as a gray bar. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-[-20px] h-5 bg-background [mask-image:linear-gradient(to_bottom,black,rgba(0,0,0,0.7)_50%,transparent)]" />
          </div>

          <div
            ref={scrollContainerRef}
            data-chat-scroll-container="true"
            data-scrollbar-visible={
              isScrollbarVisible && !isScrollbarSuppressed ? "true" : "false"
            }
            data-scrollbar-suppressed={isScrollbarSuppressed ? "true" : "false"}
            className="chat-scroll-container min-h-0 flex-1 overflow-y-scroll"
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
                  "flex-1 pt-8",
                  !instantFirstReveal && "transition-opacity duration-150",
                  isMessageListHidden && "pointer-events-none opacity-0"
                )}
                style={{ paddingBottom: inputOffset + 24 }}
                aria-busy={isRestoringInitialFrame}
              >
                <div className="mx-auto max-w-[700px] space-y-6 px-2 select-none">
                  {isInitialMessagesLoading ? null : (
                    <>
                      {/* Older messages auto-load on scroll near the top
                          (see syncScrollState). This is just a passive loading
                          hint — no manual button. */}
                      {isLoadingOlderMessages && (
                        <div
                          className="flex justify-center py-2"
                          aria-hidden="true"
                        >
                          <Loader2 className="size-4 animate-spin text-muted-foreground/70" />
                        </div>
                      )}

                      {transcriptMessages.map((message, index) => {
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
                            className={cn(
                              "scroll-mt-6 md:-ml-16 md:w-[calc(100%+4rem)] md:pl-16",
                              message.id === highlightedMessageId &&
                                "message-jump-highlight"
                            )}
                            style={
                              message.id === minHeightMsgId &&
                              index === transcriptMessages.length - 1
                                ? { paddingBottom: minHeight }
                                : undefined
                            }
                          >
                            <MessageBubble
                              message={message}
                              conversationId={conversationId ?? undefined}
                              isLatestAssistantMessage={
                                message.id === latestAssistantMessageId
                              }
                              isStreamingMessage={
                                message.id === activeStreamingMessageId
                              }
                              onArtifactClick={handleArtifactClick}
                              onArtifactExpand={handleArtifactExpand}
                              onAttachmentClick={openPreview}
                              onAgentOpen={handleAgentOpen}
                              onLoadMessageDetails={handleLoadMessageDetails}
                              onLoadToolCallDetails={handleLoadToolCallDetails}
                              visibleBrowserTakeoverRunIds={
                                visibleBrowserTakeoverRunIds
                              }
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
                              streamingStatus={state.streamingStatus}
                              showCursor={showInitialStreamingCursor}
                              onArtifactClick={handleArtifactClick}
                              onArtifactExpand={handleArtifactExpand}
                              onAgentOpen={handleAgentOpen}
                              onAttachmentClick={openPreview}
                              onLoadToolCallDetails={
                                activeStreamingMessageId
                                  ? handleLoadStreamingToolCallDetails
                                  : undefined
                              }
                              messageId={activeStreamingMessageId ?? undefined}
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
              "pointer-events-none absolute bottom-0 left-0 z-10 bg-background px-4",
              keyboardInset > 0
                ? "pb-0.5"
                : "pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:pb-3"
            )}
            style={{
              // Inset the bottom input overlay from the right edge on every
              // viewport so its opaque bg never paints over the chat scrollbar.
              // Previously mobile used 0 (full-bleed), which buried the overlay
              // scrollbar behind the input block once scrolled to the bottom.
              // The cleared strip is empty scroll-padding over a background-
              // colored fill, so the gap reads as bg-on-bg (invisible) while the
              // scrollbar shows through it.
              right: 14,
              transform:
                keyboardInset > 0
                  ? `translate3d(0, -${keyboardInset}px, 0)`
                  : undefined,
            }}
          >
            <div className="pointer-events-auto mx-auto w-full max-w-[780px]">
              <TodoBar
                messages={transcriptMessages}
                streamingReasoning={
                  isStreamingThisConversation ? state.streamingReasoning : []
                }
                hideCompleted={!isStreamingThisConversation}
              />
              <BackgroundJobsChip conversationId={conversationId ?? null} />
              <PendingFollowUps items={pendingFollowUpItems} />
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
                className="flex size-9 items-center justify-center rounded-full border border-[#e6e1db] bg-white text-foreground shadow-[0_10px_24px_rgba(32,23,16,0.12)] transition-all hover:scale-105 hover:bg-[#faf8f5] pointer-coarse:size-11"
              >
                <ArrowDown className="size-4 stroke-[1.8]" />
              </button>
            </div>
          )}

          <ChatConnectionPill
            reconnecting={isReconnecting}
            style={{
              bottom:
                keyboardInset > 0
                  ? keyboardInset + 12
                  : "calc(env(safe-area-inset-bottom) + 16px)",
            }}
          />
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
                allRuns={agentRuns}
                onClose={handleAgentClose}
                onAttachmentClick={openPreview}
                onLoadToolCallDetails={
                  activePanelAgentMessageId
                    ? handleLoadAgentToolCallDetails
                    : undefined
                }
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
                allRuns={agentRuns}
                onClose={handleAgentClose}
                onAttachmentClick={openPreview}
                onLoadToolCallDetails={
                  activePanelAgentMessageId
                    ? handleLoadAgentToolCallDetails
                    : undefined
                }
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
          gallery={previewGallery}
          onSendImage={handleSendAnnotatedImage}
          sendImageDisabled={state.isStreaming}
          sendImageDisabledMessage={state.isStreaming ? "Wait for the current response to finish." : undefined}
          onClose={closePreview}
        />
      </div>
      </BrowserPanelProvider>
      </MarkdownImagePreviewProvider>
    </ConversationArtifactsProvider>
  )
}
