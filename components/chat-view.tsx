"use client"

import * as React from "react"
import { flushSync } from "react-dom"
import { ArrowDown, ChevronDown } from "lucide-react"
import {
  ArtifactPanel,
  artifactKey,
  type ArtifactPayload,
} from "@/components/artifact-panel"
import { ChatInput } from "@/components/chat-input"
import { AttachmentCard } from "@/components/attachment-card"
import { TodoBar } from "@/components/todo-bar"
import { MessageBubble, StreamingBubble } from "@/components/message-bubble"
import { FilePreviewModal } from "@/components/file-preview-modal"
import { ArtifactPanel as AntArtifactPanel } from "@/components/artifacts/artifact-panel"
import { ConversationArtifactsProvider } from "@/components/artifacts/use-conversation-artifacts"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { useChatStore } from "@/hooks/use-chat-store"
import { cn } from "@/lib/utils"
import type {
  AgentCallReasoningEntry,
  Attachment,
  ReasoningEntry,
} from "@/lib/types"

const LAYOUT_TRANSITION = "duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
const STICKY_BOTTOM_THRESHOLD = 80
const ARTIFACT_PANEL_DEFAULT_WIDTH = 560
const ARTIFACT_PANEL_MIN_WIDTH = 340
const ARTIFACT_PANEL_MAX_WIDTH = 2400
const ARTIFACT_PANEL_MIN_CHAT_WIDTH = 360
const ARTIFACT_PANEL_RESIZE_STEP = 40
const ARTIFACT_PANEL_RESIZER_WIDTH = 10
const ARTIFACT_PANEL_WIDTH_STORAGE_PREFIX = "chat:artifact-panel-width"

type ArtifactState = ArtifactPayload

/** Old persisted artifact shape (no `kind`). Migrate to current union. */
function migrateLegacyArtifact(stored: unknown): ArtifactState | null {
  if (!stored || typeof stored !== "object") return null
  const obj = stored as Record<string, unknown>
  if (obj.kind === "code-block" || obj.kind === "tool-result")
    return obj as unknown as ArtifactState
  if (
    typeof obj.title === "string" &&
    typeof obj.language === "string" &&
    typeof obj.code === "string"
  ) {
    return {
      kind: "code-block",
      title: obj.title,
      language: obj.language,
      code: obj.code,
    }
  }
  return null
}

function hashStorageKey(value: string): string {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

function artifactPanelConversationWidthKey(conversationId: string): string {
  return `${ARTIFACT_PANEL_WIDTH_STORAGE_PREFIX}:${conversationId}`
}

function artifactPanelArtifactWidthKey(
  conversationId: string,
  artifactResizeKey: string | null
): string | null {
  if (!artifactResizeKey) return null
  return `${ARTIFACT_PANEL_WIDTH_STORAGE_PREFIX}:${conversationId}:artifact:${hashStorageKey(artifactResizeKey)}`
}

function readStoredArtifactPanelWidth(key: string | null): number | null {
  if (typeof window === "undefined" || !key) return null
  const raw = window.localStorage.getItem(key)
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function clampArtifactPanelWidth(
  width: number,
  containerWidth?: number | null
): number {
  const rounded = Math.round(width)
  if (!Number.isFinite(rounded)) return ARTIFACT_PANEL_DEFAULT_WIDTH

  const maxFromContainer =
    typeof containerWidth === "number" &&
    Number.isFinite(containerWidth) &&
    containerWidth > 0
      ? Math.max(
          ARTIFACT_PANEL_MIN_WIDTH,
          Math.min(
            ARTIFACT_PANEL_MAX_WIDTH,
            Math.floor(
              containerWidth -
                ARTIFACT_PANEL_MIN_CHAT_WIDTH -
                ARTIFACT_PANEL_RESIZER_WIDTH
            )
          )
        )
      : ARTIFACT_PANEL_MAX_WIDTH

  return Math.min(Math.max(rounded, ARTIFACT_PANEL_MIN_WIDTH), maxFromContainer)
}

function collectAgentRuns(
  reasoning?: ReasoningEntry[]
): AgentCallReasoningEntry[] {
  if (!reasoning?.length) return []
  const out: AgentCallReasoningEntry[] = []
  for (const entry of reasoning) {
    if (entry.type === "agent_call") {
      out.push(entry)
      out.push(...collectAgentRuns(entry.reasoning))
    }
  }
  return out
}

type SelectedAgentTool = {
  runId: string
  artifact: ArtifactPayload
}

function AgentToolResultPreview({
  artifact,
  variant,
  onClose,
}: {
  artifact: ArtifactPayload
  variant: "pane" | "inline"
  onClose?: () => void
}) {
  const isToolResult = artifact.kind === "tool-result"
  const body = isToolResult ? artifact.resultJson : artifact.code
  const args = isToolResult
    ? JSON.stringify(artifact.args ?? {}, null, 2)
    : null
  const subtitle = isToolResult
    ? `${artifact.toolName}${artifact.success ? "" : " · error"}`
    : artifact.language

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col border border-border bg-background",
        variant === "pane"
          ? "h-full border-x-0 border-b-0"
          : "mt-4 max-h-[340px] rounded-md"
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">
            {artifact.title}
          </div>
          <div
            className={cn(
              "text-[11px] text-muted-foreground",
              isToolResult && !artifact.success && "text-destructive"
            )}
          >
            {subtitle}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Close
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {args && (
          <details className="mb-3 rounded-md border border-border/70 bg-muted/25">
            <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-muted-foreground">
              Arguments
            </summary>
            <pre className="overflow-auto px-3 pb-3 text-[12px] leading-relaxed text-muted-foreground">
              {args}
            </pre>
          </details>
        )}
        <pre className="text-[12px] leading-relaxed break-words whitespace-pre-wrap text-foreground/85">
          {body || "No output yet."}
        </pre>
      </div>
    </div>
  )
}

function AgentWorkspacePanel({
  run,
  childRun,
  onClose,
  onAttachmentClick,
}: {
  run: AgentCallReasoningEntry
  childRun?: AgentCallReasoningEntry
  onClose: () => void
  onAttachmentClick?: (attachment: Attachment) => void
}) {
  const [selectedTool, setSelectedTool] =
    React.useState<SelectedAgentTool | null>(null)

  React.useEffect(() => {
    setSelectedTool(null)
  }, [run.runId, childRun?.runId])

  const splitTool = selectedTool && !childRun ? selectedTool.artifact : null
  const parentInlineTool =
    !splitTool && selectedTool?.runId === run.runId
      ? selectedTool.artifact
      : null
  const childInlineTool =
    !splitTool && childRun && selectedTool?.runId === childRun.runId
      ? selectedTool.artifact
      : null

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-background">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium">
            {run.agentName}
          </div>
          <div className="text-[12px] text-muted-foreground">
            {run.status === "aborted" ? "stopped" : run.status}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Close
        </button>
      </div>
      <div
        className={cn(
          "grid min-h-0 flex-1",
          splitTool
            ? "grid-rows-[minmax(0,1fr)_1px_minmax(220px,0.72fr)]"
            : childRun
              ? "grid-rows-[minmax(0,1fr)_1px_minmax(0,1fr)]"
              : "grid-rows-1"
        )}
      >
        <AgentRunPane
          run={run}
          selectedArtifact={parentInlineTool}
          onArtifactClick={(artifact) =>
            setSelectedTool({ runId: run.runId, artifact })
          }
          onSelectedArtifactClose={() => setSelectedTool(null)}
          onAttachmentClick={onAttachmentClick}
        />
        {(childRun || splitTool) && (
          <div className="h-px bg-border" aria-hidden="true" />
        )}
        {splitTool ? (
          <AgentToolResultPreview
            artifact={splitTool}
            variant="pane"
            onClose={() => setSelectedTool(null)}
          />
        ) : childRun ? (
          <AgentRunPane
            run={childRun}
            compact
            selectedArtifact={childInlineTool ?? null}
            onArtifactClick={(artifact) =>
              setSelectedTool({ runId: childRun.runId, artifact })
            }
            onSelectedArtifactClose={() => setSelectedTool(null)}
            onAttachmentClick={onAttachmentClick}
          />
        ) : null}
      </div>
    </div>
  )
}

function AgentRunPane({
  run,
  compact,
  selectedArtifact,
  onArtifactClick,
  onSelectedArtifactClose,
  onAttachmentClick,
}: {
  run: AgentCallReasoningEntry
  compact?: boolean
  selectedArtifact?: ArtifactPayload | null
  onArtifactClick?: (artifact: ArtifactPayload) => void
  onSelectedArtifactClose?: () => void
  onAttachmentClick?: (attachment: Attachment) => void
}) {
  return (
    <div className="min-h-0 overflow-auto px-4 py-4">
      {compact && (
        <div className="mb-3 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
          Nested agent: {run.agentName}
        </div>
      )}
      <div className="mb-4 rounded-md border border-border bg-muted/30 p-3">
        <div className="mb-1 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
          Prompt
        </div>
        <div className="max-h-44 overflow-auto text-[13px] break-words whitespace-pre-wrap text-muted-foreground">
          {run.prompt}
        </div>
      </div>
      {!!run.attachments?.length && (
        <div className="mb-4 flex flex-wrap gap-2">
          {run.attachments.map((att) => (
            <AttachmentCard
              key={att.id}
              attachment={att}
              onClick={() => onAttachmentClick?.(att)}
            />
          ))}
        </div>
      )}
      {run.error && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-[13px] text-destructive">
          {run.error}
        </div>
      )}
      <StreamingBubble
        reasoning={run.reasoning ?? []}
        content={run.content}
        contentSegments={
          run.contentSegments ??
          (run.content ? [{ phase: 0, content: run.content }] : [])
        }
        streamingMode={run.status === "running" ? "reasoning" : null}
        showCursor={
          run.status === "running" && !run.content && !run.reasoning?.length
        }
        onArtifactClick={onArtifactClick}
        onAttachmentClick={onAttachmentClick}
      />
      {selectedArtifact && (
        <AgentToolResultPreview
          artifact={selectedArtifact}
          variant="inline"
          onClose={onSelectedArtifactClose}
        />
      )}
    </div>
  )
}

export function ChatView() {
  const { state } = useChatStore()
  const layoutContainerRef = React.useRef<HTMLDivElement>(null)
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)
  const inputContainerRef = React.useRef<HTMLDivElement>(null)
  const wasStreamingRef = React.useRef(false)
  const autoScrollEnabledRef = React.useRef(false)
  const suppressBtnRef = React.useRef(false) // Brief suppression after streaming starts (prevents flash from minHeight)
  const ignoreSyncRef = React.useRef(true) // Start locked to prevent 0 writes on mount
  const sidebarWasOpenRef = React.useRef(true)
  const conversationIdRef = React.useRef<string | null>(null)
  const artifactResizeKeyRef = React.useRef<string | null>(null)

  // minHeight approach: streaming bubble / last AI message gets minHeight to push
  // user message to the top and give AI room to respond.
  const [minHeight, setMinHeight] = React.useState(() => {
    if (typeof window === "undefined") return 0
    const saved = localStorage.getItem(
      `chat:minHeight:${state.activeConversationId}`
    )
    if (saved) {
      try {
        return JSON.parse(saved).minHeight || 0
      } catch {}
    }
    return 0
  })
  const [minHeightMsgId, setMinHeightMsgId] = React.useState<string | null>(
    () => {
      if (typeof window === "undefined") return null
      const saved = localStorage.getItem(
        `chat:minHeight:${state.activeConversationId}`
      )
      if (saved) {
        try {
          return JSON.parse(saved).minHeightMsgId || null
        } catch {}
      }
      return null
    }
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

  const [artifact, setArtifact] = React.useState<ArtifactState | null>(() => {
    if (typeof window === "undefined") return null
    const saved = localStorage.getItem(
      `chat:artifact:${state.activeConversationId}`
    )
    if (saved) {
      try {
        return migrateLegacyArtifact(JSON.parse(saved).artifact)
      } catch {}
    }
    return null
  })
  const [artifactOpen, setArtifactOpen] = React.useState(() => {
    if (typeof window === "undefined") return false
    const saved = localStorage.getItem(
      `chat:artifact:${state.activeConversationId}`
    )
    if (saved) {
      try {
        return JSON.parse(saved).artifactOpen
      } catch {}
    }
    return false
  })
  const [showScrollBtn, setShowScrollBtn] = React.useState(false)
  const showScrollBtnRef = React.useRef(false)
  const [inputOffset, setInputOffset] = React.useState(88)
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
  const messageCount = activeConversation?.messages.length ?? 0
  const latestAssistantMessageId = React.useMemo(() => {
    const messages = activeConversation?.messages ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id
    }
    return null
  }, [activeConversation?.messages])
  const hasStreamingPayload = React.useMemo(
    () =>
      state.streamingReasoning.length > 0 ||
      state.streamingContent.length > 0 ||
      state.streamingContentSegments.some(
        (segment) => segment.content.length > 0
      ),
    [
      state.streamingContent,
      state.streamingContentSegments,
      state.streamingReasoning,
    ]
  )
  const hasInProgressAssistantProgress = React.useMemo(() => {
    const messages = activeConversation?.messages ?? []
    const lastMessage = messages[messages.length - 1]
    if (
      !lastMessage ||
      lastMessage.role !== "assistant" ||
      lastMessage.thinkingDuration != null ||
      lastMessage.status
    )
      return false
    const hasReasoning =
      Array.isArray(lastMessage.reasoning) && lastMessage.reasoning.length > 0
    const hasContent = lastMessage.content.trim().length > 0
    const hasSegments =
      Array.isArray(lastMessage.contentSegments) &&
      lastMessage.contentSegments.some((segment) => segment.content.length > 0)
    return hasReasoning || hasContent || hasSegments
  }, [activeConversation?.messages])
  const showInitialStreamingCursor =
    state.isStreaming && !hasStreamingPayload && !hasInProgressAssistantProgress

  const agentRuns = React.useMemo(() => {
    const runs: AgentCallReasoningEntry[] = []
    for (const message of activeConversation?.messages ?? []) {
      runs.push(...collectAgentRuns(message.reasoning))
    }
    runs.push(...collectAgentRuns(state.streamingReasoning))
    const byId = new Map<string, AgentCallReasoningEntry>()
    for (const run of runs) byId.set(run.runId, run)
    return Array.from(byId.values())
  }, [activeConversation?.messages, state.streamingReasoning])
  const [activeAgentRunId, setActiveAgentRunId] = React.useState<string | null>(
    null
  )
  const activeAgentRun = React.useMemo(
    () => agentRuns.find((run) => run.runId === activeAgentRunId) ?? null,
    [agentRuns, activeAgentRunId]
  )
  const activeChildAgentRun = React.useMemo(
    () =>
      activeAgentRun
        ? agentRuns.find((run) => run.parentRunId === activeAgentRun.runId)
        : undefined,
    [agentRuns, activeAgentRun]
  )

  const scrollToBottom = React.useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const element = scrollContainerRef.current
      if (!element) return
      const target = element.scrollHeight - element.clientHeight
      if (behavior !== "smooth") {
        element.scrollTop = target
        return
      }
      try {
        element.scrollTo({ top: target, behavior: "smooth" })
      } catch {
        element.scrollTop = target
      }
    },
    []
  )

  const activeIdRef = React.useRef(state.activeConversationId)
  const pendingScrollSaveRef = React.useRef<{
    conversationId: string
    scrollTop: number
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

  const flushPendingScrollSave = React.useCallback(() => {
    const pending = pendingScrollSaveRef.current
    if (!pending) return
    pendingScrollSaveRef.current = null
    localStorage.setItem(
      `scroll:chat:${pending.conversationId}`,
      pending.scrollTop.toString()
    )
  }, [])

  const scheduleScrollSave = React.useCallback(
    (scrollTop: number) => {
      const conversationId = activeIdRef.current
      if (!conversationId) return
      pendingScrollSaveRef.current = {
        conversationId,
        scrollTop: Math.round(scrollTop),
      }
      if (scrollSaveTimeoutRef.current !== null) return
      scrollSaveTimeoutRef.current = window.setTimeout(() => {
        scrollSaveTimeoutRef.current = null
        flushPendingScrollSave()
      }, 160)
    },
    [flushPendingScrollSave]
  )

  React.useEffect(
    () => () => {
      if (scrollSaveTimeoutRef.current !== null) {
        window.clearTimeout(scrollSaveTimeoutRef.current)
        scrollSaveTimeoutRef.current = null
      }
      flushPendingScrollSave()
    },
    [flushPendingScrollSave]
  )

  const syncScrollState = React.useCallback(() => {
    const element = scrollContainerRef.current
    if (!element) return

    if (activeIdRef.current && !ignoreSyncRef.current) {
      // Guard against the browser triggering passive layout-shift scroll events
      // when the container height is tiny or still rendering, which was poisoning the cache with `0`.
      if (element.scrollHeight > element.clientHeight) {
        scheduleScrollSave(element.scrollTop)
      }
    }

    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight
    const isPinnedToBottom = distanceFromBottom <= STICKY_BOTTOM_THRESHOLD

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
  }, [scheduleScrollSave, setScrollButtonVisible])

  React.useEffect(() => {
    const element = scrollContainerRef.current
    if (!element) return

    syncScrollState()
    element.addEventListener("scroll", syncScrollState, { passive: true })

    const stopAutoscroll = () => {
      autoScrollEnabledRef.current = false
      followStreamingRef.current = false
    }
    window.addEventListener("stop-chat-autoscroll", stopAutoscroll)

    return () => {
      element.removeEventListener("scroll", syncScrollState)
      window.removeEventListener("stop-chat-autoscroll", stopAutoscroll)
    }
  }, [syncScrollState, conversationId])

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

  // Transfer minHeight from streaming bubble to committed AI message without a
  // visual flash: keep the streaming bubble alive until the committed message is
  // ready to take over, then swap atomically before the browser paints.
  // 1. Streaming bubble to AI message transition
  React.useLayoutEffect(() => {
    if (state.isStreaming || minHeight === 0 || minHeightMsgId !== null) return
    const messages = activeConversation?.messages ?? []
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.role === "assistant") {
      setMinHeightMsgId(lastMsg.id)
      if (conversationId) {
        localStorage.setItem(
          `chat:minHeight:${conversationId}`,
          JSON.stringify({ minHeight, minHeightMsgId: lastMsg.id })
        )
      }
    }
  }, [
    state.isStreaming,
    activeConversation?.messages,
    minHeight,
    minHeightMsgId,
    conversationId,
  ])

  // Handle scroll restoration ONCE on mount
  React.useLayoutEffect(() => {
    if (!conversationId) return
    ignoreSyncRef.current = true
    const savedScroll = localStorage.getItem(`scroll:chat:${conversationId}`)
    let showButtonFrameId: number | null = null
    let intervalId: number | null = null
    let timeoutId: number | null = null
    let resizeObserver: ResizeObserver | null = null
    let scrollElement: HTMLDivElement | null = null
    let released = false
    let userScrolled = false

    const cancelSnap = () => {
      userScrolled = true
      ignoreSyncRef.current = false
    }

    const releaseRestoreResources = () => {
      if (released) return
      released = true
      if (showButtonFrameId !== null)
        window.cancelAnimationFrame(showButtonFrameId)
      if (intervalId !== null) window.clearInterval(intervalId)
      if (timeoutId !== null) window.clearTimeout(timeoutId)
      resizeObserver?.disconnect()
      if (scrollElement) {
        scrollElement.removeEventListener("wheel", cancelSnap)
        scrollElement.removeEventListener("touchmove", cancelSnap)
        scrollElement.removeEventListener("pointerdown", cancelSnap)
      }
    }

    const finishRestore = () => {
      if (released) return
      releaseRestoreResources()
      ignoreSyncRef.current = false
      syncScrollState()
    }

    if (savedScroll) {
      const parsed = parseInt(savedScroll, 10)
      const applyScroll = () => {
        if (!released && scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop = parsed
        }
      }
      applyScroll()
      const el = scrollContainerRef.current
      if (el) {
        scrollElement = el

        el.addEventListener("wheel", cancelSnap, { passive: true })
        el.addEventListener("touchmove", cancelSnap, { passive: true })
        el.addEventListener("pointerdown", cancelSnap, { passive: true })

        // After first scroll restore settles, show button if not at bottom.
        // This bypasses syncScrollState (which is gated by ignoreSyncRef for 1500ms).
        showButtonFrameId = window.requestAnimationFrame(() => {
          showButtonFrameId = null
          if (released) return
          const dist = el.scrollHeight - el.scrollTop - el.clientHeight
          if (dist > STICKY_BOTTOM_THRESHOLD) setScrollButtonVisible(true)
        })

        let lastHeight = el.scrollHeight
        intervalId = window.setInterval(() => {
          if (!userScrolled) applyScroll()
        }, 15)

        resizeObserver = new ResizeObserver(() => {
          if (userScrolled) return
          if (el.scrollHeight !== lastHeight) {
            lastHeight = el.scrollHeight
            applyScroll()
          }
        })
        if (el.firstElementChild) {
          resizeObserver.observe(el.firstElementChild)
        }
        timeoutId = window.setTimeout(finishRestore, 1500)
      } else {
        timeoutId = window.setTimeout(finishRestore, 500)
      }
    } else {
      timeoutId = window.setTimeout(finishRestore, 500)
    }
    return releaseRestoreResources
  }, [conversationId, setScrollButtonVisible, syncScrollState])

  React.useEffect(() => {
    const streamingStarted = !wasStreamingRef.current && state.isStreaming
    const streamingFinished = wasStreamingRef.current && !state.isStreaming

    wasStreamingRef.current = state.isStreaming

    if (streamingStarted) {
      setScrollButtonVisible(false)
      suppressBtnRef.current = true
      setTimeout(() => {
        suppressBtnRef.current = false
      }, 300)
      if (messageCount > 1) {
        const containerHeight = scrollContainerRef.current?.clientHeight || 600
        const inputHeight =
          inputContainerRef.current?.getBoundingClientRect().height || 0
        const messages = activeConversation?.messages || []
        const lastMsg = messages[messages.length - 1]
        const lastMsgEl = lastMsg
          ? document.getElementById(`message-${lastMsg.id}`)
          : null
        const lastMsgHeight = lastMsgEl?.getBoundingClientRect().height || 0

        const neededSpace = Math.max(
          0,
          containerHeight - lastMsgHeight - inputHeight - 100
        )

        minHeightActiveRef.current = true
        setMinHeightMsgId(null) // streaming bubble takes over
        setMinHeight(neededSpace)

        if (conversationId) {
          localStorage.setItem(
            `chat:minHeight:${conversationId}`,
            JSON.stringify({ minHeight: neededSpace, minHeightMsgId: null })
          )
        }

        autoScrollEnabledRef.current = false

        window.requestAnimationFrame(() => {
          if (lastMsg) {
            const el = document.getElementById(`message-${lastMsg.id}`)
            if (el) {
              ignoreSyncRef.current = true
              el.scrollIntoView({ behavior: "smooth", block: "start" })
              setTimeout(() => {
                ignoreSyncRef.current = false
              }, 600)
            }
          }
        })
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

    const frame = window.requestAnimationFrame(() => {
      if (
        followStreamingRef.current &&
        state.isStreaming &&
        !ignoreSyncRef.current
      ) {
        scrollToBottom("auto")
      } else if (autoScrollEnabledRef.current && !minHeightActiveRef.current) {
        scrollToBottom(state.isStreaming ? "auto" : "smooth")
      }

      if (streamingFinished) {
        if (followStreamingRef.current) {
          scrollToBottom("auto")
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
    messageCount,
    scrollToBottom,
    state.isStreaming,
    state.streamingContent,
    state.streamingReasoning,
    syncScrollState,
    setScrollButtonVisible,
    activeConversation?.messages,
  ])

  // ── Generated artifact side-panel state ────────────────────────────────
  // Distinct from the legacy code-block / tool-result panel above. When the
  // user clicks "↗ Expand" on an inline ArtifactInline card OR the model
  // chooses `display="panel"`, we surface the new ArtifactPanel here.
  // Sidebar collapses just like the legacy flow.
  const [genArtifact, setGenArtifact] = React.useState<ArtifactRow | null>(null)

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
        artifactOpen || Boolean(genArtifact) || Boolean(activeAgentRun)
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
      activeAgentRun,
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
        artifactOpen || Boolean(genArtifact) || Boolean(activeAgentRun)
      if (!panelAlreadyOpen) {
        sidebarWasOpenRef.current = sidebarOpen
      }
      setGenArtifact(a)
      setArtifactOpen(false)
      setActiveAgentRunId(null)
      setSidebarOpen(false)
    },
    [
      activeAgentRun,
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
        artifactOpen || Boolean(genArtifact) || Boolean(activeAgentRun)
      if (!panelAlreadyOpen) {
        sidebarWasOpenRef.current = sidebarOpen
      }
      setActiveAgentRunId(run.runId)
      setArtifactOpen(false)
      setGenArtifact(null)
      setSidebarOpen(false)
    },
    [activeAgentRun, artifactOpen, genArtifact, setSidebarOpen, sidebarOpen]
  )

  const handleAgentClose = React.useCallback(() => {
    setActiveAgentRunId(null)
    restoreSidebar()
  }, [restoreSidebar])

  const hasArtifact =
    (artifactOpen && !!artifact) || !!genArtifact || !!activeAgentRun
  const activeArtifactResizeKey = React.useMemo(() => {
    if (activeAgentRun) return `agent:${activeAgentRun.runId}`
    if (genArtifact) return `generated:${genArtifact.identifier}`
    if (artifactOpen && artifact) return `legacy:${artifactKey(artifact)}`
    return null
  }, [activeAgentRun, artifact, artifactOpen, genArtifact])

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
    setScrollButtonVisible(false)
    if (state.isStreaming) {
      followStreamingRef.current = true
      autoScrollEnabledRef.current = true
      ignoreSyncRef.current = true
      scrollToBottom("smooth")
      // Re-enable syncScrollState cancellation after smooth scroll animation completes.
      setTimeout(() => {
        ignoreSyncRef.current = false
      }, 500)
    } else {
      // Clearing the fake space instantly ensures smooth scroll can dive all the way to the text!
      if (minHeightActiveRef.current) {
        flushSync(() => {
          minHeightActiveRef.current = false
          setMinHeight(0)
          setMinHeightMsgId(null)
        })
        if (conversationId)
          localStorage.removeItem(`chat:minHeight:${conversationId}`)
      }
      scrollToBottom("smooth")
    }
  }, [
    scrollToBottom,
    setScrollButtonVisible,
    state.isStreaming,
    conversationId,
  ])

  // Keep streaming bubble alive until the committed message is ready to take
  // over minHeight (prevents layout flash on streaming end).
  const showStreamingBubble = Boolean(
    activeConversation &&
    (state.isStreaming || (minHeight > 0 && minHeightMsgId === null)) &&
    state.activeConversationId === activeConversation.id
  )

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
            className="flex-1 overflow-y-scroll"
            style={{
              WebkitOverflowScrolling: "touch",
              overscrollBehaviorY: "contain",
              scrollbarGutter: isMobile ? "auto" : "stable both-edges",
              touchAction: "pan-y",
            }}
          >
            <div className="mx-auto flex min-h-full w-full max-w-[780px] flex-col px-4">
              <div className="flex-1 pt-4 pb-10">
                <div className="mx-auto max-w-[700px] space-y-6 px-2">
                  {activeConversation.messages.map((message, index) => (
                    <div
                      key={message.id}
                      id={`message-${message.id}`}
                      className="scroll-mt-6"
                      style={
                        message.id === minHeightMsgId &&
                        index === activeConversation.messages.length - 1
                          ? { minHeight }
                          : undefined
                      }
                    >
                      <MessageBubble
                        message={message}
                        isLatestAssistantMessage={
                          message.id === latestAssistantMessageId
                        }
                        onArtifactClick={handleArtifactClick}
                        onArtifactExpand={handleArtifactExpand}
                        onAttachmentClick={setPreviewAttachment}
                        onAgentOpen={handleAgentOpen}
                      />
                    </div>
                  ))}

                  {showStreamingBubble && (
                    <div
                      style={
                        minHeight > 0 && minHeightMsgId === null
                          ? { minHeight }
                          : undefined
                      }
                    >
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
                    </div>
                  )}
                </div>
              </div>

              <div
                ref={inputContainerRef}
                data-chat-input-container="true"
                className="relative sticky bottom-0 shrink-0 bg-background pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:pb-3"
              >
                <TodoBar
                  messages={activeConversation.messages}
                  streamingReasoning={
                    showStreamingBubble ? state.streamingReasoning : []
                  }
                />
                <ChatInput variant="chat" />
              </div>
            </div>
          </div>

          {showScrollBtn && (
            <div
              className="absolute inset-x-0 z-20 flex justify-center"
              style={{ bottom: inputOffset }}
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
            {activeAgentRun ? (
              <AgentWorkspacePanel
                run={activeAgentRun}
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
            {activeAgentRun ? (
              <AgentWorkspacePanel
                run={activeAgentRun}
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
