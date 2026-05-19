"use client"

import * as React from "react"
import { Check, ChevronDown, Copy, CheckCircle2, CircleAlert, CircleStop, Clock, Download, ExternalLink, FileText, RefreshCw } from "lucide-react"
import type { AgentCallReasoningEntry, Attachment, ContentSegment, ContextCompactionReasoningEntry, Message, ReasoningEntry, ToolCallReasoningEntry } from "@/lib/types"
import { cn } from "@/lib/utils"
import { copyTextToClipboard } from "@/lib/clipboard"
import { ArtifactCard, type ArtifactPayload } from "@/components/artifact-panel"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { AttachmentCard } from "@/components/attachment-card"
import { RenderMessageContent } from "@/components/artifacts/render-message-content"
import { useConversationArtifacts } from "@/components/artifacts/use-conversation-artifacts"
import { downloadArtifact } from "@/components/artifacts/artifact-inline"
import { InlineToolCallView, InlineWebSearchGroup, getToolCallDisplayTitle, isWebSearchToolCall, shouldExpandToolCallByDefault } from "@/components/tool-call-view"
import { BrowserAgentLiveView } from "@/components/browser-agent-live-view"
import type { ArtifactRow } from "@/lib/artifacts/schema"

type SearchToolDisplay = "expanded" | "compact"

function extractCodeBlocks(content: string): { title: string; language: string; code: string }[] {
    const blocks: { title: string; language: string; code: string }[] = []
    const regex = /```(\w*)\n([\s\S]*?)```/g
    let match
    while ((match = regex.exec(content)) !== null) {
        blocks.push({
            title: match[1] ? `Code snippet` : "Code",
            language: match[1] || "text",
            code: match[2].trim(),
        })
    }
    return blocks
}

function formatMessageTimestamp(timestamp: number) {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp)
}

function formatMessageTimestampFull(timestamp: number) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp)
}

// ---------------------------------------------------------------------------
// ThoughtBlock helpers
// ---------------------------------------------------------------------------

const COLLAPSED_HEIGHT = 460
const COLLAPSED_BOTTOM_GAP = 52 // gap from bottom of block to input container

function getThoughtTitle(content: string): string {
    const boldTitleRegex = /\*\*(.+?)\*\*/g
    let latest: string | null = null
    let match: RegExpExecArray | null
    while ((match = boldTitleRegex.exec(content)) !== null) latest = match[1]
    if (latest) return latest
    const first = content.split("\n")[0] || "Thinking"
    return first.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/_(.+?)_/g, '$1')
}

function getEntryTitle(entry: ReasoningEntry | undefined): string {
    if (!entry) return "Thinking"
    if (entry.type === "tool_call") return getToolCallDisplayTitle(entry)
    if (entry.type === "agent_call") return entry.title || entry.agentName
    if (entry.type === "context_compaction") return entry.title
    return getThoughtTitle(entry.content)
}

function buildSummary(reasoning: ReasoningEntry[], seconds: number, fallback: string): string {
    const hasThought = reasoning.some(e => e.type === "thought")
    let readFiles = 0, listedDirs = 0, agents = 0, compactions = 0
    for (const e of reasoning) {
        if (e.type === "agent_call") {
            agents++
            continue
        }
        if (e.type === "context_compaction") {
            compactions++
            continue
        }
        if (e.type !== "tool_call") continue
        const t = e.title.trim().toLowerCase()
        if (t === "read_file" || t.startsWith("read ")) readFiles++
        else if (t === "list_dir" || t.startsWith("list ")) listedDirs++
    }
    const parts: string[] = []
    const wholeSecs = Math.round(seconds)
    if (hasThought && wholeSecs > 0) parts.push(`Thought for ${wholeSecs}s`)
    if (compactions > 0) parts.push(compactions === 1 ? "compacted context" : `compacted context ${compactions}x`)
    if (agents > 0) parts.push(`called ${agents} agent${agents === 1 ? "" : "s"}`)
    if (readFiles > 0) parts.push(`read ${readFiles} file${readFiles === 1 ? "" : "s"}`)
    if (listedDirs > 0) parts.push(listedDirs === 1 ? "listed dir" : `listed ${listedDirs} dirs`)
    return parts.length > 0 ? parts.join(", ") : fallback
}

function groupReasoningByPhase(reasoning: ReasoningEntry[]): Array<{ phase: number; entries: ReasoningEntry[] }> {
    const groups: Array<{ phase: number; entries: ReasoningEntry[] }> = []
    for (const entry of reasoning) {
        const phase = Number.isFinite(entry.phase) ? entry.phase : 0
        const last = groups[groups.length - 1]
        if (!last || last.phase !== phase) groups.push({ phase, entries: [entry] })
        else last.entries.push(entry)
    }
    return groups
}

function buildInterleavedTimeline(
    reasoningGroups: Array<{ phase: number; entries: ReasoningEntry[] }>,
    contentSegments: ContentSegment[]
): Array<
    | { type: "reasoning"; phase: number; entries: ReasoningEntry[] }
    | { type: "content"; phase: number; content: string }
> {
    const reasoningByPhase = new Map<number, ReasoningEntry[]>()
    for (const g of reasoningGroups) reasoningByPhase.set(g.phase, g.entries)

    const contentByPhase = new Map<number, string>()
    for (const s of contentSegments) contentByPhase.set(s.phase, (contentByPhase.get(s.phase) ?? "") + s.content)

    const phases = Array.from(new Set([...reasoningByPhase.keys(), ...contentByPhase.keys()])).sort((a, b) => a - b)
    const timeline: Array<
        | { type: "reasoning"; phase: number; entries: ReasoningEntry[] }
        | { type: "content"; phase: number; content: string }
    > = []

    for (const phase of phases) {
        const r = reasoningByPhase.get(phase)
        if (r?.length) timeline.push({ type: "reasoning", phase, entries: r })
        const c = contentByPhase.get(phase)
        if (c?.length) timeline.push({ type: "content", phase, content: c })
    }
    return timeline
}

function hasLiveBrowserAgent(reasoning: ReasoningEntry[]): boolean {
    return reasoning.some((entry) => {
        if (entry.type !== "agent_call" || entry.agentId !== "browser_agent") {
            return false
        }
        if (entry.status === "running") return true
        return /\bSession status:\s*awaiting_user\b/i.test(entry.content)
    })
}

const MESSAGE_SELECTION_GUTTER_PX = 64
const INTERACTIVE_SELECTION_TARGET =
    'a,button,input,textarea,select,summary,[role="button"],[contenteditable="true"]'

type CaretBoundary = {
    node: Node
    offset: number
}

type CaretPointDocument = Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node | null; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
}

function rootContainsNode(root: HTMLElement, node: Node): boolean {
    if (node === root) return true
    const owner = node.nodeType === Node.ELEMENT_NODE
        ? node
        : (node as ChildNode).parentElement
    return owner ? root.contains(owner) : false
}

function getCaretBoundaryAtPoint(root: HTMLElement, x: number, y: number): CaretBoundary | null {
    const doc = root.ownerDocument as CaretPointDocument
    const position = doc.caretPositionFromPoint?.(x, y)
    if (position?.offsetNode && rootContainsNode(root, position.offsetNode)) {
        return { node: position.offsetNode, offset: position.offset }
    }

    const range = doc.caretRangeFromPoint?.(x, y)
    if (range && rootContainsNode(root, range.startContainer)) {
        return { node: range.startContainer, offset: range.startOffset }
    }

    return null
}

function getLineStartBoundary(root: HTMLElement, contentLeft: number, y: number): CaretBoundary | null {
    const direct = getCaretBoundaryAtPoint(root, contentLeft + 1, y)
    if (direct) return direct

    const doc = root.ownerDocument
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let best: { x: number; y: number; distance: number } | null = null

    while (walker.nextNode()) {
        const node = walker.currentNode
        if (!node.textContent?.trim()) continue

        const range = doc.createRange()
        range.selectNodeContents(node)
        for (const rect of Array.from(range.getClientRects())) {
            if (rect.width <= 0 || rect.height <= 0) continue
            const distance = y < rect.top
                ? rect.top - y
                : y > rect.bottom
                    ? y - rect.bottom
                    : 0
            if (distance > Math.max(10, rect.height / 2)) continue
            if (best && distance >= best.distance) continue
            best = {
                x: Math.max(rect.left + 1, contentLeft + 1),
                y: Math.min(Math.max(y, rect.top + 1), rect.bottom - 1),
                distance,
            }
        }
    }

    return best ? getCaretBoundaryAtPoint(root, best.x, best.y) : null
}

function boundaryIsBefore(a: CaretBoundary, b: CaretBoundary): boolean {
    if (a.node === b.node) return a.offset < b.offset
    return Boolean(a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING)
}

function applySelection(root: HTMLElement, anchor: CaretBoundary, focus: CaretBoundary): void {
    const selection = root.ownerDocument.getSelection()
    if (!selection) return

    selection.removeAllRanges()
    const collapsed = root.ownerDocument.createRange()
    collapsed.setStart(anchor.node, anchor.offset)
    collapsed.collapse(true)
    selection.addRange(collapsed)

    if (typeof selection.extend === "function") {
        try {
            selection.extend(focus.node, focus.offset)
            return
        } catch {
            selection.removeAllRanges()
        }
    }

    const range = root.ownerDocument.createRange()
    if (boundaryIsBefore(focus, anchor)) {
        range.setStart(focus.node, focus.offset)
        range.setEnd(anchor.node, anchor.offset)
    } else {
        range.setStart(anchor.node, anchor.offset)
        range.setEnd(focus.node, focus.offset)
    }
    selection.addRange(range)
}

function useMessageSelectionGutter() {
    const rootRef = React.useRef<HTMLDivElement>(null)

    const handlePointerDownCapture = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || event.pointerType === "touch") return
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return

        const root = rootRef.current
        if (!root) return

        const target = event.target instanceof Element ? event.target : null
        if (target?.closest(INTERACTIVE_SELECTION_TARGET)) return

        const rect = root.getBoundingClientRect()
        const contentLeft = rect.left + MESSAGE_SELECTION_GUTTER_PX
        const inVerticalBounds = event.clientY >= rect.top && event.clientY <= rect.bottom
        const inSelectionGutter = event.clientX >= rect.left && event.clientX < contentLeft
        if (!inVerticalBounds || !inSelectionGutter) return

        const anchor = getLineStartBoundary(root, contentLeft, event.clientY)
        if (!anchor) return

        event.preventDefault()
        event.stopPropagation()

        const doc = root.ownerDocument
        const view = doc.defaultView

        const updateFocus = (clientX: number, clientY: number) => {
            const x = Math.max(clientX, contentLeft + 1)
            const focus =
                getCaretBoundaryAtPoint(root, x, clientY) ??
                getLineStartBoundary(root, contentLeft, clientY)
            if (!focus) return
            applySelection(root, anchor, focus)
        }

        updateFocus(contentLeft + 1, event.clientY)

        const handlePointerMove = (moveEvent: PointerEvent) => {
            moveEvent.preventDefault()
            updateFocus(moveEvent.clientX, moveEvent.clientY)
        }
        const cleanup = () => {
            view?.removeEventListener("pointermove", handlePointerMove)
            view?.removeEventListener("pointerup", cleanup)
            view?.removeEventListener("pointercancel", cleanup)
            try {
                root.releasePointerCapture(event.pointerId)
            } catch {
                // Pointer capture may already be released by the browser.
            }
        }

        try {
            root.setPointerCapture(event.pointerId)
        } catch {
            // Pointer capture is an enhancement; document listeners still handle the drag.
        }
        view?.addEventListener("pointermove", handlePointerMove, { passive: false })
        view?.addEventListener("pointerup", cleanup)
        view?.addEventListener("pointercancel", cleanup)
    }, [])

    return { rootRef, handlePointerDownCapture }
}

// ---------------------------------------------------------------------------
// Shared hook: computes available collapsed height dynamically
// ---------------------------------------------------------------------------

function useAvailableHeight(
    blockRef: React.RefObject<HTMLDivElement | null>,
    isActive: boolean,
): number {
    const [height, setHeight] = React.useState(COLLAPSED_HEIGHT)

    React.useEffect(() => {
        if (!isActive) return

        const compute = () => {
            const block = blockRef.current
            if (!block) return
            const input = document.querySelector<HTMLElement>('[data-chat-input-container="true"]')
            if (!input) return

            const blockRect = block.getBoundingClientRect()
            const inputRect = input.getBoundingClientRect()
            const available = Math.floor(inputRect.top - blockRect.top - COLLAPSED_BOTTOM_GAP)
            setHeight(Math.max(COLLAPSED_HEIGHT, available))
        }

        compute()
        // Recompute once after layout settles
        const frame = requestAnimationFrame(compute)
        return () => cancelAnimationFrame(frame)
    }, [blockRef, isActive])

    return height
}

// ---------------------------------------------------------------------------
// ThoughtBlock
// ---------------------------------------------------------------------------

function ThoughtBlock({
    reasoning,
    isStreaming,
    onArtifactClick,
    onAgentOpen,
    onAttachmentClick,
    messageId,
    thinkingSeconds,
    thinkingDone,
    thinkingDuration,
    messageStatus,
    searchToolDisplay = "expanded",
    thoughtAutoOpen = true,
    thoughtAutoExpandTools = false,
    liveCollapsedTitle = false,
}: {
    reasoning: ReasoningEntry[]
    isStreaming?: boolean
    onArtifactClick?: (artifact: ArtifactPayload) => void
    onAgentOpen?: (entry: AgentCallReasoningEntry) => void
    onAttachmentClick?: (attachment: Attachment) => void
    messageId?: string
    thinkingSeconds?: number
    thinkingDone?: boolean
    thinkingDuration?: number
    messageStatus?: Message["status"]
    searchToolDisplay?: SearchToolDisplay
    thoughtAutoOpen?: boolean
    thoughtAutoExpandTools?: boolean
    liveCollapsedTitle?: boolean
}) {
    const latestEntry = reasoning[reasoning.length - 1]
    const latestTitle = getEntryTitle(latestEntry)
    const shouldDefaultExpand = thoughtAutoExpandTools && reasoning.some(entry =>
        entry.type === "tool_call" && shouldExpandToolCallByDefault(entry)
    )
    const secs = Math.round(thinkingSeconds ?? 0)
    const persistedSecs = Math.round(thinkingDuration ?? 0)
    const summarySeconds = persistedSecs > 0 ? persistedSecs : secs
    const latestAgentStatus = latestEntry?.type === "agent_call" ? latestEntry.status : undefined
    const keepOpenForBrowser = hasLiveBrowserAgent(reasoning)
    const derivedStatus = latestAgentStatus === "aborted" || latestAgentStatus === "error"
        ? latestAgentStatus
        : undefined
    const effectiveStatus = messageStatus ?? derivedStatus
    const isLiveStreaming = Boolean(isStreaming && effectiveStatus == null)
    const terminalTitle = effectiveStatus === "aborted"
        ? "Stopped"
        : effectiveStatus === "error"
            ? "Failed"
            : null

    // Build display title
    const liveTitle = terminalTitle ?? (latestEntry?.type === "tool_call"
        ? latestTitle
        : isLiveStreaming
            ? secs > 0 ? `${latestTitle} (${secs}s)` : latestTitle
            : thinkingDone
                ? `Thought for ${secs}s`
                : persistedSecs > 0
                    ? `Thought for ${persistedSecs}s`
                    : latestTitle)

    // State: open/expanded, persisted via localStorage keyed by messageId
    const storageKey = messageId ? `thought:${messageId}` : null
    const openStorageKey = storageKey ? `${storageKey}:open:v2` : null
    const expandedStorageKey = storageKey ? `${storageKey}:expanded:v3` : null

    const [isOpen, setIsOpen] = React.useState(() => {
        if (openStorageKey) {
            const saved = localStorage.getItem(openStorageKey)
            if (saved !== null) return saved === 'true'
        }
        return keepOpenForBrowser || (thoughtAutoOpen ? isLiveStreaming : false)
    })

    const userToggledExpandedRef = React.useRef(false)
    const [hasStoredExpanded] = React.useState(() => {
        if (!expandedStorageKey) return false
        return localStorage.getItem(expandedStorageKey) !== null
    })
    const [isExpanded, setIsExpanded] = React.useState(() => {
        if (expandedStorageKey) {
            const saved = localStorage.getItem(expandedStorageKey)
            if (saved !== null) return saved === 'true'
        }
        return shouldDefaultExpand
    })

    const updateOpen = React.useCallback((v: boolean) => {
        setIsOpen(v)
        if (openStorageKey) localStorage.setItem(openStorageKey, String(v))
    }, [openStorageKey])

    const updateExpanded = React.useCallback((v: boolean) => {
        userToggledExpandedRef.current = true
        setIsExpanded(v)
        if (expandedStorageKey) localStorage.setItem(expandedStorageKey, String(v))
    }, [expandedStorageKey])

    const autoExpand = React.useCallback(() => {
        setIsExpanded(true)
        if (expandedStorageKey) localStorage.setItem(expandedStorageKey, "true")
    }, [expandedStorageKey])

    React.useEffect(() => {
        if (!shouldDefaultExpand || hasStoredExpanded || userToggledExpandedRef.current) return
        autoExpand()
    }, [autoExpand, hasStoredExpanded, shouldDefaultExpand])

    React.useEffect(() => {
        if (!keepOpenForBrowser) return
        window.dispatchEvent(new Event("stop-chat-autoscroll"))
    }, [keepOpenForBrowser])

    // Content measurement
    const blockRef = React.useRef<HTMLDivElement>(null)
    const contentRef = React.useRef<HTMLDivElement>(null)
    const scrollRef = React.useRef<HTMLDivElement>(null)
    const [contentHeight, setContentHeight] = React.useState(0)

    // Dynamic collapsed height — adapts to available viewport space
    const dynamicHeight = useAvailableHeight(blockRef, isOpen && isLiveStreaming && !isExpanded)
    const collapsedHeight = isLiveStreaming ? dynamicHeight : COLLAPSED_HEIGHT
    const isCollapsible = contentHeight > collapsedHeight + 40
    const visibleContentHeight = isExpanded || !isCollapsible
        ? (contentHeight > 0 ? `${contentHeight}px` : "none")
        : `${collapsedHeight}px`

    // Measure content
    React.useEffect(() => {
        if (!isOpen || !contentRef.current) return
        const update = () => {
            if (contentRef.current) {
                setContentHeight(Math.ceil(contentRef.current.getBoundingClientRect().height) + 6)
            }
        }
        update()
        const observer = new ResizeObserver(update)
        observer.observe(contentRef.current)
        return () => observer.disconnect()
    }, [isOpen])

    // Auto-open/close on streaming transitions
    const wasStreamingRef = React.useRef(isLiveStreaming)
    const userOpenedRef = React.useRef(false)
    React.useEffect(() => {
        if (keepOpenForBrowser) {
            updateOpen(true)
            wasStreamingRef.current = isLiveStreaming
            return
        }
        if (!thoughtAutoOpen) {
            wasStreamingRef.current = isLiveStreaming
            return
        }
        if (wasStreamingRef.current && !isLiveStreaming && !userOpenedRef.current) {
            updateOpen(false)
        } else if (!wasStreamingRef.current && isLiveStreaming) {
            updateOpen(true)
            if (shouldDefaultExpand) autoExpand()
            userOpenedRef.current = false
        }
        wasStreamingRef.current = isLiveStreaming
    }, [autoExpand, isLiveStreaming, keepOpenForBrowser, shouldDefaultExpand, thoughtAutoOpen, updateOpen])

    // Auto-scroll content during streaming
    React.useEffect(() => {
        if (!isOpen || !scrollRef.current || isExpanded) return
        if (isLiveStreaming) {
            requestAnimationFrame(() => {
                if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
            })
        } else {
            requestAnimationFrame(() => {
                if (scrollRef.current) scrollRef.current.scrollTop = 0
            })
        }
    }, [reasoning, isOpen, isExpanded, isLiveStreaming])

    const [isMounted, setIsMounted] = React.useState(false)
    React.useEffect(() => { setIsMounted(true) }, [])

    const summaryTitle = buildSummary(reasoning, summarySeconds, latestTitle)
    const displayTitle = terminalTitle ?? (isOpen
        ? (isLiveStreaming ? liveTitle : summaryTitle)
        : liveCollapsedTitle && isLiveStreaming
            ? liveTitle
            : summaryTitle)
    const isShowingContent = isOpen && (reasoning.length > 0 || isLiveStreaming)

    // Animation key: stable per-entry identity + structural signals.
    // Avoids replays from streaming content drift (first-line fallback grows
    // with each chunk) and from second-by-second ticks.
    let latestBold: string | null = null
    if (latestEntry?.type === "thought") {
        const re = /\*\*(.+?)\*\*/g
        let m: RegExpExecArray | null
        while ((m = re.exec(latestEntry.content)) !== null) latestBold = m[1]
    }
    const stableLatestKey = !latestEntry
        ? "none"
        : latestEntry.type === "tool_call"
            ? `t:${latestEntry.toolCallId ?? latestEntry.id ?? latestEntry.title}`
            : latestEntry.type === "agent_call"
                ? `a:${latestEntry.runId}`
                : latestEntry.type === "context_compaction"
                    ? `c:${latestEntry.id}:${latestEntry.at}`
            : `b:${latestEntry.id}:${latestBold ?? ""}`
    const titleAnimKey = `${isOpen ? 1 : 0}|${isLiveStreaming ? 1 : 0}|${thinkingDone ? 1 : 0}|n${reasoning.length}|${stableLatestKey}`

    // Apply right-edge fade only when the title actually overflows.
    const titleRef = React.useRef<HTMLSpanElement>(null)
    const [titleOverflows, setTitleOverflows] = React.useState(false)
    React.useEffect(() => {
        const el = titleRef.current
        if (!el) return
        const check = () => setTitleOverflows(el.scrollWidth - el.clientWidth > 1)
        check()
        const ro = new ResizeObserver(check)
        ro.observe(el)
        if (el.parentElement) ro.observe(el.parentElement)
        return () => ro.disconnect()
    }, [displayTitle])

    return (
        <div className="flex w-full min-w-0 flex-col">
            <button
                type="button"
                onClick={() => {
                    const next = !isOpen
                    if (next) userOpenedRef.current = true
                    updateOpen(next)
                    if (next && shouldDefaultExpand) autoExpand()
                    if (next) window.dispatchEvent(new Event("stop-chat-autoscroll"))
                }}
                className="flex items-center gap-1.5 text-[15px] text-muted-foreground transition-colors hover:text-foreground group w-fit max-w-full min-w-0"
            >
                <span
                    ref={titleRef}
                    key={titleAnimKey}
                    className={cn(
                        "thought-title-text min-w-0",
                        titleOverflows && "thought-title-faded",
                        liveCollapsedTitle && !isOpen && isLiveStreaming && "thought-title-live"
                    )}
                >{displayTitle}</span>
                <ChevronDown
                    className={cn(
                        "size-4 shrink-0 text-muted-foreground/70 group-hover:text-foreground transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                        isOpen ? "rotate-0" : "-rotate-90"
                    )}
                />
            </button>

            <div
                className={cn(
                    "grid",
                    isMounted && "transition-[grid-template-rows,opacity] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                    isShowingContent ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                )}
            >
                <div
                    className={cn(
                        "overflow-hidden min-h-0",
                        isMounted && "transition-[transform,opacity] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                        isShowingContent ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0"
                    )}
                >
                    <div ref={blockRef} className="mt-2 flex flex-col relative pb-2">
                        <div className="relative flex flex-col">
                            <div className="absolute left-[7.5px] top-[11px] bottom-[13px] w-[1.5px] bg-border/60" />
                            <div className="relative pb-[10px]">
                                <div
                                    ref={scrollRef}
                                    className={cn(
                                        "text-[14px] leading-relaxed text-muted-foreground overflow-hidden relative",
                                        isMounted && "transition-[max-height] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[max-height]"
                                    )}
                                    style={{
                                        maxHeight: visibleContentHeight
                                    }}
                                >
                                    <div ref={contentRef}>
                                        {reasoning.length > 0 ? (
                                            <div className="mb-2 flex flex-col gap-2">
                                                <ReasoningEntryList
                                                    reasoning={reasoning}
                                                    onArtifactClick={onArtifactClick}
                                                    onAgentOpen={onAgentOpen}
                                                    onAttachmentClick={onAttachmentClick}
                                                    searchToolDisplay={searchToolDisplay}
                                                />
                                            </div>
                                        ) : (
                                            <div className="h-4" />
                                        )}
                                    </div>
                                    {!isExpanded && isCollapsible && (
                                        <div className={isLiveStreaming ? "h-10" : "h-20"} />
                                    )}
                                </div>

                                {isCollapsible && !isExpanded && (
                                    <>
                                        {isLiveStreaming && (
                                            <div className="absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-background to-transparent z-10 pointer-events-none" />
                                        )}
                                        <div className="absolute left-0 right-0 bottom-0 z-10 flex flex-col pointer-events-none">
                                            <div className={cn(
                                                "w-full bg-gradient-to-t from-background to-transparent",
                                                isLiveStreaming ? "h-10" : "h-16"
                                            )} />
                                            {!isLiveStreaming && <div className="w-full h-8 bg-background" />}
                                        </div>
                                        <div className="absolute bottom-1 left-0 right-0 z-20">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    updateExpanded(true)
                                                    userOpenedRef.current = true
                                                    if (scrollRef.current) scrollRef.current.scrollTop = 0
                                                    window.dispatchEvent(new Event("stop-chat-autoscroll"))
                                                }}
                                                className="text-[13px] text-muted-foreground hover:text-foreground"
                                            >
                                                Show more
                                            </button>
                                        </div>
                                    </>
                                )}

                                {isCollapsible && isExpanded && (
                                    <div className="mt-2 relative z-20">
                                        <button
                                            type="button"
                                            onClick={() => updateExpanded(false)}
                                            className="text-[13px] text-muted-foreground hover:text-foreground"
                                        >
                                            Show less
                                        </button>
                                    </div>
                                )}
                            </div>
                            <div className="relative flex items-center gap-3 mt-1 mb-0.5 bg-background w-max py-0.5 z-10">
                                {isLiveStreaming ? (
                                    <div className="size-4 rounded-full border-[2px] border-muted-foreground border-t-transparent animate-spin" />
                                ) : effectiveStatus === "aborted" ? (
                                    <CircleStop className="size-4 shrink-0 rounded-full bg-background text-muted-foreground" />
                                ) : effectiveStatus === "error" ? (
                                    <CircleAlert className="size-4 shrink-0 rounded-full bg-background text-destructive" />
                                ) : (
                                    <CheckCircle2 className="size-4 text-muted-foreground shrink-0 bg-background rounded-full" />
                                )}
                                <span className={cn(
                                    "text-[14px] font-medium tracking-tight mt-[1px]",
                                    isLiveStreaming ? "text-muted-foreground" : "text-foreground"
                                )}>
                                    {isLiveStreaming
                                        ? `Thinking${secs > 0 ? ` (${secs}s)` : "..."}`
                                        : effectiveStatus === "aborted"
                                            ? "Stopped"
                                            : effectiveStatus === "error"
                                                ? "Failed"
                                        : "Done"
                                    }
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// ToolCallBlock
// ---------------------------------------------------------------------------

function ReasoningEntryList({
    reasoning,
    onArtifactClick,
    onAgentOpen,
    onAttachmentClick,
    searchToolDisplay,
}: {
    reasoning: ReasoningEntry[]
    onArtifactClick?: (artifact: ArtifactPayload) => void
    onAgentOpen?: (entry: AgentCallReasoningEntry) => void
    onAttachmentClick?: (attachment: Attachment) => void
    searchToolDisplay: SearchToolDisplay
}) {
    const nodes: React.ReactNode[] = []

    for (let index = 0; index < reasoning.length; index++) {
        const entry = reasoning[index]

        if (entry.type === "tool_call" && searchToolDisplay !== "compact" && isWebSearchToolCall(entry)) {
            const entries = [entry]
            let nextIndex = index + 1
            while (nextIndex < reasoning.length) {
                const nextEntry = reasoning[nextIndex]
                if (nextEntry.type !== "tool_call" || !isWebSearchToolCall(nextEntry)) break
                entries.push(nextEntry)
                nextIndex++
            }
            nodes.push(
                <InlineWebSearchGroup
                    key={`web-search-${entry.id}-${index}-${entries.length}`}
                    entries={entries}
                />
            )
            index = nextIndex - 1
            continue
        }

        if (entry.type === "thought") {
            nodes.push(
                <div key={`${entry.id}-${index}`} className="flex items-start gap-3">
                    <Clock className="mt-[3px] size-4 shrink-0 rounded-full bg-background text-muted-foreground" />
                    <div className="min-w-0 flex-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                        <MarkdownRenderer content={entry.content} />
                    </div>
                </div>
            )
        } else if (entry.type === "tool_call") {
            nodes.push(
                <ToolCallBlock
                    key={`${entry.id}-${index}`}
                    entry={entry}
                    onArtifactClick={onArtifactClick}
                    searchToolDisplay={searchToolDisplay}
                />
            )
        } else if (entry.type === "context_compaction") {
            nodes.push(
                <ContextCompactionBlock
                    key={`${entry.id}-${index}`}
                    entry={entry}
                />
            )
        } else {
            nodes.push(
                <AgentCallBlock
                    key={`${entry.id}-${index}`}
                    entry={entry}
                    onOpen={onAgentOpen}
                    onAttachmentClick={onAttachmentClick}
                />
            )
        }
    }

    return <>{nodes}</>
}

function ContextCompactionBlock({ entry }: { entry: ContextCompactionReasoningEntry }) {
    return (
        <div className="relative z-10 flex max-w-full items-start gap-3 bg-background py-1 text-left">
            <RefreshCw className="mt-[3px] size-4 shrink-0 text-muted-foreground bg-background rounded-full" />
            <span className="min-w-0">
                <span className="block truncate text-[14px] font-medium tracking-tight text-muted-foreground">
                    {entry.title}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground/75" title={formatMessageTimestampFull(entry.at)}>
                    Conversation history summarized to free context
                </span>
            </span>
        </div>
    )
}

function ToolCallBlock({
    entry,
    onArtifactClick,
    searchToolDisplay,
}: {
    entry: ToolCallReasoningEntry
    onArtifactClick?: (artifact: ArtifactPayload) => void
    searchToolDisplay?: SearchToolDisplay
    thoughtAutoOpen?: boolean
    thoughtAutoExpandTools?: boolean
    liveCollapsedTitle?: boolean
}) {
    return <InlineToolCallView entry={entry} onOpen={onArtifactClick} searchDisplay={searchToolDisplay} />
}

function formatAgentStatus(status: AgentCallReasoningEntry["status"]): string {
    if (status === "running") return "running"
    if (status === "error") return "failed"
    if (status === "aborted") return "stopped"
    return "done"
}

function AgentCallBlock({
    entry,
    onOpen,
    onAttachmentClick,
}: {
    entry: AgentCallReasoningEntry
    onOpen?: (entry: AgentCallReasoningEntry) => void
    onAttachmentClick?: (attachment: Attachment) => void
}) {
    if (entry.agentId === "browser_agent") {
        return <BrowserAgentCallBlock entry={entry} onOpen={onOpen} onAttachmentClick={onAttachmentClick} />
    }

    return <GenericAgentCallBlock entry={entry} onOpen={onOpen} />
}

function GenericAgentCallBlock({
    entry,
    onOpen,
}: {
    entry: AgentCallReasoningEntry
    onOpen?: (entry: AgentCallReasoningEntry) => void
}) {
    const toolCount = countAgentTools(entry)
    const statusText = formatAgentStatus(entry.status)
    return (
        <div className="relative z-10 flex max-w-full bg-background py-1 text-left">
            <button
                type="button"
                onClick={() => onOpen?.(entry)}
                className="group flex w-max max-w-full items-start gap-3 text-left"
            >
                <FileText className="mt-[3px] size-4 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
                <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium tracking-tight text-muted-foreground group-hover:text-foreground transition-colors">
                        {entry.title || entry.agentName}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground/75">
                        {statusText}{toolCount > 0 ? ` · ${toolCount} tool${toolCount === 1 ? "" : "s"}` : ""}
                    </span>
                </span>
            </button>
        </div>
    )
}

function BrowserAgentCallBlock({
    entry,
    onOpen,
    onAttachmentClick,
}: {
    entry: AgentCallReasoningEntry
    onOpen?: (entry: AgentCallReasoningEntry) => void
    onAttachmentClick?: (attachment: Attachment) => void
}) {
    return (
        <div className="relative z-10 flex max-w-full flex-col gap-2 bg-background py-1 text-left">
            <div className="ml-7 grid w-[calc(100%_-_1.75rem)] max-w-[760px] gap-2">
                <BrowserAgentLiveView active={entry.status === "running"} onOpenDetails={onOpen ? () => onOpen(entry) : undefined} />
                {entry.content.trim().length > 0 && (
                    <div className="min-w-0 max-w-full overflow-x-auto rounded-[8px] border bg-muted/30 px-3 py-2 text-[13px] leading-relaxed">
                        <MarkdownRenderer content={entry.content} />
                    </div>
                )}
                {!!entry.attachments?.length && (
                    <div className="flex max-w-full flex-wrap gap-2">
                        {entry.attachments.map(att => (
                            <AttachmentCard
                                key={att.id}
                                attachment={att}
                                onClick={() => onAttachmentClick?.(att)}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

function countAgentTools(entry: AgentCallReasoningEntry): number {
    let count = 0
    for (const item of entry.reasoning ?? []) {
        if (item.type === "tool_call") count += 1
        if (item.type === "agent_call") count += countAgentTools(item)
    }
    return count
}

// ---------------------------------------------------------------------------
// UserMessageContent (collapsible long messages)
// ---------------------------------------------------------------------------

const USER_MESSAGE_COLLAPSED_HEIGHT = 160

function UserMessageContent({ messageId, content }: { messageId: string; content: string }) {
    const [isExpanded, setIsExpanded] = React.useState(() => {
        const saved = localStorage.getItem(`user:expanded:${messageId}`)
        return saved === "true"
    })
    const [contentHeight, setContentHeight] = React.useState(0)
    const contentRef = React.useRef<HTMLDivElement>(null)
    const isCollapsible = contentHeight > USER_MESSAGE_COLLAPSED_HEIGHT + 5

    const toggleExpanded = React.useCallback(() => {
        const next = !isExpanded
        setIsExpanded(next)
        localStorage.setItem(`user:expanded:${messageId}`, String(next))
    }, [isExpanded, messageId])

    React.useEffect(() => {
        if (!contentRef.current) return
        const update = () => {
            if (contentRef.current) setContentHeight(Math.ceil(contentRef.current.getBoundingClientRect().height) + 2)
        }
        update()
        const observer = new ResizeObserver(update)
        observer.observe(contentRef.current)
        return () => observer.disconnect()
    }, [content])

    return (
        <div className="max-w-[85%] select-text rounded-[10px] bg-[#f0ede6] px-4 py-2.5 text-[16px] dark:bg-muted">
            <div className="relative">
                <div
                    className="overflow-hidden transition-[max-height] duration-300 ease-out"
                    style={{
                        maxHeight: isExpanded
                            ? (contentHeight > 0 ? `${contentHeight}px` : "none")
                            : `${USER_MESSAGE_COLLAPSED_HEIGHT}px`,
                    }}
                >
                    <div ref={contentRef} className="whitespace-pre-wrap break-words">{content}</div>
                </div>
                {isCollapsible && !isExpanded && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[#f0ede6] to-transparent dark:from-muted" />
                )}
            </div>
            {isCollapsible && (
                <div className="mt-1 flex justify-center">
                    <button type="button" onClick={toggleExpanded} className="text-[13px] text-muted-foreground hover:text-foreground">
                        {isExpanded ? "Show less" : "Show more"}
                    </button>
                </div>
            )}
        </div>
    )
}

function TerminalMessageStatusLine({ status }: { status?: Message["status"] }) {
    if (status === "aborted") {
        return (
            <div className="flex items-center gap-2 text-[15px] text-muted-foreground">
                <CircleStop className="size-4" />
                <span>Stopped</span>
            </div>
        )
    }
    if (status === "error") {
        return (
            <div className="flex items-center gap-2 text-[15px] text-destructive">
                <CircleAlert className="size-4" />
                <span>Failed</span>
            </div>
        )
    }
    return null
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

interface MessageBubbleProps {
    message: Message
    isLatestAssistantMessage?: boolean
    onArtifactClick?: (artifact: ArtifactPayload) => void
    /**
     * Fired when the user clicks "↗ Expand" on an inline `<artifact>` card.
     * Chat-view wires this to its side-panel state. Distinct from
     * `onArtifactClick` (which is the legacy code-block / tool-result router).
     */
    onArtifactExpand?: (artifact: ArtifactRow) => void
    onAttachmentClick?: (attachment: Attachment) => void
    onAgentOpen?: (entry: AgentCallReasoningEntry) => void
}

function MessageBubbleComponent({ message, isLatestAssistantMessage, onArtifactClick, onArtifactExpand, onAttachmentClick, onAgentOpen }: MessageBubbleProps) {
    const [copied, setCopied] = React.useState(false)
    const [hovered, setHovered] = React.useState(false)
    const {
        rootRef: selectionGutterRef,
        handlePointerDownCapture: handleSelectionGutterPointerDownCapture,
    } = useMessageSelectionGutter()
    const { byMessage } = useConversationArtifacts()

    const handleCopy = React.useCallback(async () => {
        if (!await copyTextToClipboard(message.content)) return
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
    }, [message.content])

    // Latest version per identifier produced by this message — those are the
    // artifacts the hover-meta row exposes copy/download/expand for.
    const messageArtifacts = React.useMemo<ArtifactRow[]>(() => {
        if (message.role !== "assistant") return []
        const rows = byMessage.get(message.id) ?? []
        const latestByIdentifier = new Map<string, ArtifactRow>()
        for (const r of rows) {
            const existing = latestByIdentifier.get(r.identifier)
            if (!existing || r.version > existing.version) latestByIdentifier.set(r.identifier, r)
        }
        return [...latestByIdentifier.values()]
    }, [byMessage, message.id, message.role])

    const meta = (
        <div
            className={cn(
                "flex items-center gap-2 text-[13px] text-muted-foreground transition-opacity duration-150",
                hovered ? "opacity-100" : "opacity-0",
                message.role === "user" ? "justify-end self-end pr-1" : "justify-start pl-1"
            )}
        >
            <span
                className="transition-colors hover:text-foreground cursor-default"
                title={formatMessageTimestampFull(message.timestamp)}
            >
                {formatMessageTimestamp(message.timestamp)}
            </span>
            <button
                type="button"
                onClick={handleCopy}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                aria-label="Copy message"
                title="Copy message"
            >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </button>
            {messageArtifacts.map((artifact) => (
                <ArtifactMetaActions
                    key={`meta-${artifact.id}`}
                    artifact={artifact}
                    onExpand={onArtifactExpand}
                    showLabel={messageArtifacts.length > 1}
                />
            ))}
        </div>
    )

    if (message.role === "user") {
        return (
            <div
                className="flex flex-col items-end gap-2 select-text"
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
            >
                {!!message.attachments?.length && (
                    <div className="flex gap-2 flex-wrap justify-end max-w-[85%]">
                        {message.attachments!.map((att) => (
                            <AttachmentCard key={att.id} attachment={att} onClick={() => onAttachmentClick?.(att)} />
                        ))}
                    </div>
                )}
                {message.content && <UserMessageContent messageId={message.id} content={message.content} />}
                {meta}
            </div>
        )
    }

    const codeBlocks = extractCodeBlocks(message.content)
    const hasReasoning = Array.isArray(message.reasoning) && message.reasoning.length > 0
    const reasoningGroups = hasReasoning ? groupReasoningByPhase(message.reasoning!) : []
    const contentSegments = message.contentSegments ?? (
        message.content.length > 0 ? [{ phase: 0, content: message.content }] : []
    )
    const timeline = buildInterleavedTimeline(reasoningGroups, contentSegments)
    const lastReasoningPhase = reasoningGroups.length > 0 ? reasoningGroups[reasoningGroups.length - 1].phase : null
    const lastContentPhase = contentSegments.length > 0 ? contentSegments[contentSegments.length - 1].phase : null
    const isInProgressReasoning = Boolean(
        isLatestAssistantMessage &&
        hasReasoning &&
        lastReasoningPhase !== null &&
        (lastContentPhase == null || lastReasoningPhase > lastContentPhase) &&
        message.thinkingDuration == null &&
        message.status == null
    )

    return (
        <div
            ref={selectionGutterRef}
            onPointerDownCapture={handleSelectionGutterPointerDownCapture}
            className="-ml-16 flex w-[calc(100%+4rem)] min-w-0 flex-col gap-1.5 pl-16 select-text"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            {timeline.map((item) => (
                item.type === "reasoning" ? (
                    <ThoughtBlock
                        key={`reasoning-${message.id}-${item.phase}`}
                        reasoning={item.entries}
                        onArtifactClick={onArtifactClick}
                        onAgentOpen={onAgentOpen}
                        onAttachmentClick={onAttachmentClick}
                        messageId={`${message.id}:phase:${item.phase}`}
                        isStreaming={isInProgressReasoning && lastReasoningPhase === item.phase}
                        thinkingDuration={message.thinkingDuration}
                        messageStatus={message.status}
                    />
                ) : (
                    <div key={`content-${message.id}-${item.phase}`} className="min-w-0 break-words text-[16px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-1">
                        <RenderMessageContent
                            content={item.content}
                            messageId={message.id}
                            onExpand={onArtifactExpand}
                        />
                    </div>
                )
            ))}
            {timeline.length === 0 && <TerminalMessageStatusLine status={message.status} />}
            {codeBlocks.length > 0 && onArtifactClick && (
                <div className="space-y-2 mt-1">
                    {codeBlocks.map((block, i) => (
                        <ArtifactCard
                            key={i}
                            title={block.title}
                            language={block.language}
                            onClick={() => onArtifactClick({ kind: "code-block", ...block })}
                        />
                    ))}
                </div>
            )}
            {!!message.attachments?.length && (
                <div className="mt-1 flex max-w-[85%] flex-wrap gap-2">
                    {message.attachments.map((att) => (
                        <AttachmentCard key={att.id} attachment={att} onClick={() => onAttachmentClick?.(att)} />
                    ))}
                </div>
            )}
            {meta}
        </div>
    )
}

export const MessageBubble = React.memo(MessageBubbleComponent)
MessageBubble.displayName = "MessageBubble"

// ---------------------------------------------------------------------------
// ArtifactMetaActions — copy / download / expand for an artifact, rendered
// inline with the message's hover-meta row instead of as inset card chrome.
// ---------------------------------------------------------------------------

function ArtifactMetaActions({
    artifact,
    onExpand,
    showLabel,
}: {
    artifact: ArtifactRow
    onExpand?: (a: ArtifactRow) => void
    /**
     * When the message produced multiple artifacts, prefix each button group
     * with the artifact title so users can tell which buttons act on which.
     * Single-artifact messages skip the label to keep the row compact.
     */
    showLabel: boolean
}) {
    // No artifact-only copy button — the message-level copy already grabs the
    // full content (artifact body included), and the side panel still exposes
    // an artifact-only copy for users who specifically want the body.
    return (
        <div className="flex items-center gap-1">
            {showLabel && (
                <span className="ml-1 max-w-[140px] truncate text-[12px] text-muted-foreground/80" title={artifact.title}>
                    {artifact.title}
                </span>
            )}
            <button
                type="button"
                onClick={() => downloadArtifact(artifact)}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                aria-label="Download artifact"
                title="Download artifact"
            >
                <Download className="size-4" />
            </button>
            {onExpand && (
                <button
                    type="button"
                    onClick={() => onExpand(artifact)}
                    className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                    aria-label="Open in side panel"
                    title="Open in side panel"
                >
                    <ExternalLink className="size-4" />
                </button>
            )}
        </div>
    )
}

// ---------------------------------------------------------------------------
// StreamingBubble
// ---------------------------------------------------------------------------

interface StreamingBubbleProps {
    reasoning: ReasoningEntry[]
    content: string
    contentSegments: ContentSegment[]
    streamingMode: "reasoning" | "content" | null
    showCursor?: boolean
    onArtifactClick?: (artifact: ArtifactPayload) => void
    onArtifactExpand?: (artifact: ArtifactRow) => void
    onAgentOpen?: (entry: AgentCallReasoningEntry) => void
    onAttachmentClick?: (attachment: Attachment) => void
    thinkingSeconds?: number
    thinkingDone?: boolean
    searchToolDisplay?: SearchToolDisplay
    thoughtAutoOpen?: boolean
    thoughtAutoExpandTools?: boolean
    liveCollapsedTitle?: boolean
    /**
     * Id of the assistant message currently being streamed. Routed to
     * RenderMessageContent so it can find drafts/rows keyed by messageId in
     * the ConversationArtifactsProvider — without this the artifact card
     * never renders inline during streaming.
     */
    messageId?: string
}

export function StreamingBubble({ reasoning, content, contentSegments, streamingMode, showCursor = true, onArtifactClick, onArtifactExpand, onAgentOpen, onAttachmentClick, thinkingSeconds, thinkingDone, messageId, searchToolDisplay = "expanded", thoughtAutoOpen = true, thoughtAutoExpandTools = false, liveCollapsedTitle = false }: StreamingBubbleProps) {
    const reasoningGroups = React.useMemo(() => groupReasoningByPhase(reasoning), [reasoning])
    const timeline = React.useMemo(() => buildInterleavedTimeline(reasoningGroups, contentSegments), [reasoningGroups, contentSegments])
    const activeReasoningPhase = reasoningGroups.length > 0 ? reasoningGroups[reasoningGroups.length - 1].phase : null
    const {
        rootRef: selectionGutterRef,
        handlePointerDownCapture: handleSelectionGutterPointerDownCapture,
    } = useMessageSelectionGutter()

    return (
        <div
            ref={selectionGutterRef}
            onPointerDownCapture={handleSelectionGutterPointerDownCapture}
            className="-ml-16 flex w-[calc(100%+4rem)] min-w-0 flex-col gap-1.5 pl-16 select-text"
        >
            {timeline.map((item) => (
                item.type === "reasoning" ? (
                    <ThoughtBlock
                        key={`stream-reasoning-${item.phase}`}
                        reasoning={item.entries}
                        isStreaming={activeReasoningPhase === item.phase && streamingMode === "reasoning"}
                        onArtifactClick={onArtifactClick}
                        onAgentOpen={onAgentOpen}
                        onAttachmentClick={onAttachmentClick}
                        thinkingSeconds={thinkingSeconds}
                        thinkingDone={thinkingDone}
                        searchToolDisplay={searchToolDisplay}
                        thoughtAutoOpen={thoughtAutoOpen}
                        thoughtAutoExpandTools={thoughtAutoExpandTools}
                        liveCollapsedTitle={liveCollapsedTitle}
                    />
                ) : (
                    <div key={`stream-content-${item.phase}`} className="min-w-0 break-words text-[16px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-1">
                        {messageId ? (
                            <RenderMessageContent
                                content={item.content}
                                messageId={messageId}
                                onExpand={onArtifactExpand}
                            />
                        ) : (
                            <MarkdownRenderer content={item.content} />
                        )}
                    </div>
                )
            ))}
            {showCursor && reasoning.length === 0 && !content && (
                <div className="flex items-center gap-1 pl-1 pt-1">
                    <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-pulse" />
                    <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-pulse [animation-delay:0.2s]" />
                    <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-pulse [animation-delay:0.4s]" />
                </div>
            )}
        </div>
    )
}
