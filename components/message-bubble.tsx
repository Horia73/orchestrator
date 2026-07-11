"use client"

import * as React from "react"
import { Brain, Check, ChevronDown, Copy, CheckCircle2, CircleAlert, CircleStop, Clock, Download, ExternalLink, FileText, Loader2, Monitor, RefreshCw, Terminal } from "lucide-react"
import type { AgentCallReasoningEntry, Attachment, ContentSegment, ContextCompactionReasoningEntry, MemoryRecallReasoningEntry, Message, ReasoningEntry, SteeredMessageReasoningEntry, ToolCallReasoningEntry } from "@/lib/types"
import { parseSteeredMessage } from "@/lib/steered-message"
import { cn } from "@/lib/utils"
import { copyTextToClipboard } from "@/lib/clipboard"
import type { ArtifactPayload } from "@/components/artifact-panel"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { AttachmentCard } from "@/components/attachment-card"
import { RenderMessageContent } from "@/components/artifacts/render-message-content"
import { useConversationArtifacts } from "@/components/artifacts/use-conversation-artifacts"
import { downloadArtifact } from "@/components/artifacts/artifact-inline"
import { InlineToolCallView, InlineWebSearchGroup, TOOL_CALL_CARD_HEIGHT, getToolCallDisplayTitle, isWebSearchToolCall, shouldExpandToolCallByDefault } from "@/components/tool-call-view"
import { BrowserAgentLiveView } from "@/components/browser-agent-live-view"
import { useBrowserPanelState } from "@/components/chat/browser-panel-context"
import { AUDIO_CONTEXT_AGENT_ID, AUDIO_TRANSCRIPT_AGENT_ID, AudioContextAgentCard } from "@/components/chat/audio-context-agent-card"
import { useMessageSelectionGutter } from "@/components/message-bubble/use-message-selection-gutter"
import { useTrapWheel } from "@/components/use-trap-wheel"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import { appPath } from "@/lib/app-path"
import { agentFullLabel } from "@/lib/agent-label"
import { isDesktopViewport } from "@/lib/desktop-viewport"
import { hideInlineImageAttachments } from "@/lib/chat-attachment-display"

// Layout effect on the client, plain effect during SSR (matches collapse.tsx /
// app-sidebar.tsx). Lets us measure collapsible content before the first paint
// so it never flashes full-height and then snaps shorter on the next frame.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect

type SearchToolDisplay = "expanded" | "compact"

function formatMessageTimestamp(timestamp: number) {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp)
}

function formatMessageTimestampFull(timestamp: number) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp)
}

// Server-authored background-job completion notices arrive as user-role
// messages wrapped in this tag (lib/ai/background-jobs.ts). Chat renders them
// as a muted system card. The trailing "This is an automated…" instruction
// paragraph is for the model, not the reader — it is dropped from display.
const BACKGROUND_JOB_NOTICE_RE = /^<background-job-notice>\n?([\s\S]*?)\n?<\/background-job-notice>\s*$/

function parseBackgroundJobNotice(content: string): { headline: string; body: string } | null {
    const match = BACKGROUND_JOB_NOTICE_RE.exec(content.trim())
    if (!match) return null
    const lines = match[1].split("\n")
    const headlineIndex = lines.findIndex((line) => line.trim().length > 0)
    if (headlineIndex < 0) return null
    const headline = lines[headlineIndex].trim()
    const rest = lines
        .slice(headlineIndex + 1)
        .join("\n")
        .replace(/\n*This is an automated completion notice[\s\S]*$/, "")
        .trim()
    return { headline, body: rest }
}

// ---------------------------------------------------------------------------
// ThoughtBlock helpers
// ---------------------------------------------------------------------------

// Collapsed thought windows are sized in whole tool cards. Every boxed
// tool-call panel renders at the same fixed height (TOOL_CALL_CARD_HEIGHT,
// shared with tool-call-view), so the clipped preview always ends on a card
// boundary and "Show more" only appears after 2 complete cards — the same on
// desktop and mobile; there is no step-down to 1 card or per-device floor.
const CARD_UNIT = TOOL_CALL_CARD_HEIGHT
const CARD_GAP = 8 // the entry list's gap-2
const WINDOW_CARDS = 2

// Live-streaming window (pinned to the bottom of the content). Non-card
// chrome inside it: the list's pt-1 (4) + mb-2 (8), the h-10 live bottom-fade
// spacer (40), and headroom so the h-6 top gradient fades the previous entry
// instead of shaving the first visible card (24).
const LIVE_WINDOW_CHROME = 76
const LIVE_COLLAPSED_HEIGHT = WINDOW_CARDS * CARD_UNIT + (WINDOW_CARDS - 1) * CARD_GAP + LIVE_WINDOW_CHROME

// Finalized collapsed preview (reads from the top): the list's pt-1 (4) plus
// the bottom overlay hosting "Show more" (h-16 fade + h-8 solid = 96), so the
// second card clears the fade entirely.
const COLLAPSED_HEIGHT = WINDOW_CARDS * CARD_UNIT + (WINDOW_CARDS - 1) * CARD_GAP + 4 + 96
const WORKED_DETAILS_INITIAL_BUDGET = 10
const WORKED_DETAILS_RENDER_CHUNK = 18
const WORKED_DETAILS_CHUNK_DELAY_MS = 24

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
    if (entry.type === "agent_call") return agentFullLabel(entry)
    if (entry.type === "context_compaction") return entry.title
    if (entry.type === "memory_recall") {
        const n = entry.hits.length
        return `Recalled ${n} memor${n === 1 ? "y" : "ies"}`
    }
    return getThoughtTitle(entry.content)
}

function buildSummary(reasoning: ReasoningEntry[], seconds: number, fallback: string): string {
    const hasThought = reasoning.some(e => e.type === "thought")
    let readFiles = 0, listedDirs = 0, agents = 0, compactions = 0, recalls = 0
    for (const e of reasoning) {
        if (e.type === "agent_call") {
            agents++
            continue
        }
        if (e.type === "context_compaction") {
            compactions++
            continue
        }
        if (e.type === "memory_recall") {
            recalls += e.hits.length
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
    if (recalls > 0) parts.push(`recalled ${recalls} memor${recalls === 1 ? "y" : "ies"}`)
    if (compactions > 0) parts.push(compactions === 1 ? "compacted context" : `compacted context ${compactions}x`)
    if (agents > 0) parts.push(`called ${agents} agent${agents === 1 ? "" : "s"}`)
    if (readFiles > 0) parts.push(`read ${readFiles} file${readFiles === 1 ? "" : "s"}`)
    if (listedDirs > 0) parts.push(listedDirs === 1 ? "listed dir" : `listed ${listedDirs} dirs`)
    return parts.length > 0 ? parts.join(", ") : fallback
}

// Wall-clock for the collapsed "Worked for …" header. Mirrors the terse format
// the live thought header uses (seconds under a minute), escalating to m/s then
// h/m so a long agentic run reads as "15m 3s" or "1h 2m" rather than "903s".
function formatWorkDuration(ms: number): string {
    const totalSec = Math.max(0, Math.round(ms / 1000))
    if (totalSec < 60) return `${totalSec}s`
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    if (h > 0) return `${h}h ${m}m`
    return `${m}m ${s}s`
}

type MessageTimelineItem =
    | { type: "reasoning"; phase: number; entries: ReasoningEntry[] }
    | { type: "content"; phase: number; content: string }
    | { type: "steered"; phase: number; entry: SteeredMessageReasoningEntry }

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
): MessageTimelineItem[] {
    const reasoningByPhase = new Map<number, ReasoningEntry[]>()
    for (const g of reasoningGroups) reasoningByPhase.set(g.phase, g.entries)

    const contentByPhase = new Map<number, string>()
    for (const s of contentSegments) contentByPhase.set(s.phase, (contentByPhase.get(s.phase) ?? "") + s.content)

    const phases = Array.from(new Set([...reasoningByPhase.keys(), ...contentByPhase.keys()])).sort((a, b) => a - b)
    const timeline: MessageTimelineItem[] = []

    for (const phase of phases) {
        const r = reasoningByPhase.get(phase)
        if (r?.length) {
            // Steered messages surface as their own timeline items — they are
            // user speech, not working trace, so they must never disappear
            // into a ThoughtBlock / "Worked for" disclosure.
            let run: ReasoningEntry[] = []
            const flushRun = () => {
                if (run.length) {
                    timeline.push({ type: "reasoning", phase, entries: run })
                    run = []
                }
            }
            for (const entry of r) {
                if (entry.type === "steered_message") {
                    flushRun()
                    timeline.push({ type: "steered", phase, entry })
                } else {
                    run.push(entry)
                }
            }
            flushRun()
        }
        const c = contentByPhase.get(phase)
        if (c?.length) timeline.push({ type: "content", phase, content: c })
    }
    return timeline
}

function countTimelineRenderUnits(items: MessageTimelineItem[]): number {
    let count = 0
    for (const item of items) {
        count += item.type === "reasoning" ? item.entries.length : 1
    }
    return count
}

function sliceTimelineByRenderBudget(
    items: MessageTimelineItem[],
    budget: number
): MessageTimelineItem[] {
    const sliced: MessageTimelineItem[] = []
    let remaining = budget

    for (const item of items) {
        if (remaining <= 0) break
        if (item.type !== "reasoning") {
            sliced.push(item)
            remaining -= 1
            continue
        }

        const entries = item.entries.slice(0, remaining)
        if (entries.length > 0) {
            sliced.push({ ...item, entries })
            remaining -= entries.length
        }
    }

    return sliced
}

function hasLiveBrowserAgent(reasoning: ReasoningEntry[]): boolean {
    return reasoning.some((entry) => {
        if (entry.type !== "agent_call" || entry.agentId !== "browser_agent") {
            return false
        }
        if (entry.status === "running") return true
        return isBrowserAgentAwaitingUser(entry)
    })
}

function isBrowserAgentAwaitingUser(entry: AgentCallReasoningEntry): boolean {
    return /\bSession status:\s*awaiting_user\b/i.test(entry.content)
}

function browserSessionIdFromContent(content: string): string | null {
    const match = content.match(/\bBrowser session:\s*([A-Za-z0-9_.:-]+)/i)
    return match?.[1] ?? null
}

// ---------------------------------------------------------------------------
// ThoughtBlock
// ---------------------------------------------------------------------------

function ThoughtBlock({
    reasoning,
    isStreaming,
    isStreamingTurn = false,
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
    openOnMount = false,
}: {
    reasoning: ReasoningEntry[]
    isStreaming?: boolean
    isStreamingTurn?: boolean
    onArtifactClick?: (artifact: ArtifactPayload) => void
    onAgentOpen?: (entry: AgentCallReasoningEntry) => void
    onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
    messageId?: string
    thinkingSeconds?: number
    thinkingDone?: boolean
    thinkingDuration?: number
    messageStatus?: Message["status"]
    searchToolDisplay?: SearchToolDisplay
    thoughtAutoOpen?: boolean
    thoughtAutoExpandTools?: boolean
    liveCollapsedTitle?: boolean
    openOnMount?: boolean
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
    const isLiveTurn = Boolean((isStreaming || isStreamingTurn) && effectiveStatus == null)
    const terminalTitle = effectiveStatus === "aborted"
        ? "Stopped"
        : effectiveStatus === "error"
            ? "Failed"
            : null

    // Build display title
    const liveStatusTitle = secs > 0 ? `Thinking (${secs}s)` : "Thinking..."
    const latestLiveTitle = latestEntry?.type === "tool_call"
        ? latestTitle
        : isLiveTurn
            ? secs > 0 ? `${latestTitle} (${secs}s)` : latestTitle
            : thinkingDone
                ? `Thought for ${secs}s`
                : persistedSecs > 0
                    ? `Thought for ${persistedSecs}s`
                    : latestTitle

    // State: open/expanded, persisted via localStorage keyed by messageId
    const storageKey = messageId ? `thought:${messageId}` : null
    // v3: discard the polluted v2 open-state — a prior auto-load bug persisted
    // `open:true` for every assistant block, re-expanding them all on refresh.
    const openStorageKey = storageKey ? `${storageKey}:open:v3` : null
    const expandedStorageKey = storageKey ? `${storageKey}:expanded:v3` : null

    // A saved open-state is an explicit user choice and is authoritative — no
    // auto-open effect (browser-session, streaming) may override it on refresh.
    const [hasStoredOpen] = React.useState(() => {
        if (!openStorageKey) return false
        return localStorage.getItem(openStorageKey) !== null
    })
    const [isOpen, setIsOpen] = React.useState(() => {
        if (openOnMount) return true
        if (openStorageKey) {
            const saved = localStorage.getItem(openStorageKey)
            if (saved !== null) return saved === 'true'
        }
        return keepOpenForBrowser || (thoughtAutoOpen ? isLiveTurn : false)
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
        if (openOnMount) updateOpen(true)
    }, [openOnMount, updateOpen])

    React.useEffect(() => {
        if (!shouldDefaultExpand || hasStoredExpanded || userToggledExpandedRef.current) return
        autoExpand()
    }, [autoExpand, hasStoredExpanded, shouldDefaultExpand])

    React.useEffect(() => {
        if (!keepOpenForBrowser) return
        window.dispatchEvent(new Event("stop-chat-autoscroll"))
    }, [keepOpenForBrowser])

    // Content measurement
    const headerRef = React.useRef<HTMLButtonElement>(null)
    const contentRef = React.useRef<HTMLDivElement>(null)
    const scrollRef = React.useRef<HTMLDivElement>(null)
    const [contentHeight, setContentHeight] = React.useState(0)

    // Fixed collapsed height — always exactly 2 whole tool cards, so the
    // preview never cuts a card in half before "Show more".
    const collapsedHeight = isLiveTurn ? LIVE_COLLAPSED_HEIGHT : COLLAPSED_HEIGHT
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
    const wasStreamingRef = React.useRef(isLiveTurn)
    const userOpenedRef = React.useRef(false)
    React.useEffect(() => {
        if (keepOpenForBrowser) {
            // Keep a live browser session visible by default, but never clobber
            // an explicit user choice — that's what makes the state stick on refresh.
            if (!hasStoredOpen) updateOpen(true)
            wasStreamingRef.current = isLiveTurn
            return
        }
        if (!thoughtAutoOpen) {
            wasStreamingRef.current = isLiveTurn
            return
        }
        if (wasStreamingRef.current && !isLiveTurn && !userOpenedRef.current) {
            updateOpen(false)
        } else if (!wasStreamingRef.current && isLiveTurn) {
            updateOpen(true)
            if (shouldDefaultExpand) autoExpand()
            userOpenedRef.current = false
        }
        wasStreamingRef.current = isLiveTurn
    }, [autoExpand, hasStoredOpen, isLiveTurn, keepOpenForBrowser, shouldDefaultExpand, thoughtAutoOpen, updateOpen])

    // Auto-scroll content during streaming. Keep the live viewport hard-pinned:
    // smooth scroll animations fight character-level reasoning deltas and make
    // the panel drift up, then snap back, while text is still arriving.
    React.useEffect(() => {
        if (!isOpen || !scrollRef.current || isExpanded) {
            return
        }
        if (!isLiveStreaming) {
            requestAnimationFrame(() => {
                if (scrollRef.current) scrollRef.current.scrollTop = 0
            })
            return
        }
        requestAnimationFrame(() => {
            const node = scrollRef.current
            if (!node) return
            node.scrollTop = node.scrollHeight
        })
    }, [reasoning, isOpen, isExpanded, isLiveStreaming])

    const [isMounted, setIsMounted] = React.useState(false)
    React.useEffect(() => { setIsMounted(true) }, [])

    const summaryTitle = buildSummary(reasoning, summarySeconds, latestTitle)
    const displayTitle = terminalTitle ?? (isOpen
        ? (isLiveTurn ? liveStatusTitle : summaryTitle)
        : liveCollapsedTitle && isLiveTurn
            ? latestLiveTitle
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
    const titleAnimKey = isOpen && isLiveTurn
        ? "open-live"
        : `${isOpen ? 1 : 0}|${isLiveTurn ? 1 : 0}|${thinkingDone ? 1 : 0}|n${reasoning.length}|${stableLatestKey}`

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
                ref={headerRef}
                type="button"
                onClick={() => {
                    const next = !isOpen
                    if (next) userOpenedRef.current = true
                    updateOpen(next)
                    // Opening the dropdown by hand goes straight to the full,
                    // expanded view — no intermediate collapsed "Show more" preview.
                    if (next) autoExpand()
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
                        liveCollapsedTitle && !isOpen && isLiveTurn && "thought-title-live"
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
                    <div className="mt-2 flex flex-col relative pb-2">
                        <div className="relative flex flex-col">
                            <div className="absolute left-[7.5px] top-[11px] bottom-[13px] w-[1.5px] bg-border/60" />
                            <div className="relative pb-[10px]">
                                <div
                                    ref={scrollRef}
                                    className={cn(
                                        "text-[14px] leading-relaxed text-muted-foreground overflow-hidden relative",
                                        isMounted && !isLiveTurn && "transition-[max-height] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[max-height]"
                                    )}
                                    style={{
                                        maxHeight: visibleContentHeight
                                    }}
                                >
                                    <div ref={contentRef}>
                                        {isShowingContent && reasoning.length > 0 ? (
                                            <div className="mb-2 flex flex-col gap-2 pt-1">
                                                <ReasoningEntryList
                                                    reasoning={reasoning}
                                                    onArtifactClick={onArtifactClick}
                                                    onAgentOpen={onAgentOpen}
                                                    onAttachmentClick={onAttachmentClick}
                                                    searchToolDisplay={searchToolDisplay}
                                                />
                                            </div>
                                        ) : isShowingContent ? (
                                            <div className="h-4" />
                                        ) : null}
                                    </div>
                                    {!isExpanded && isCollapsible && (
                                        <div className={isLiveStreaming ? "h-10" : "h-20"} />
                                    )}
                                </div>

                                {isCollapsible && !isExpanded && (
                                    <>
                                        {/* Alpha-only masks over solid fills, not color gradients
                                            to transparent — those interpolate through transparent
                                            black and render as gray bars on engines without
                                            premultiplied alpha (iOS 27 beta WebKit). */}
                                        {isLiveStreaming && (
                                            <div className="absolute top-0 left-0 right-0 h-6 bg-background [mask-image:linear-gradient(to_bottom,black,transparent)] z-10 pointer-events-none" />
                                        )}
                                        <div className="absolute left-0 right-0 bottom-0 z-10 flex flex-col pointer-events-none">
                                            <div className={cn(
                                                "w-full bg-background [mask-image:linear-gradient(to_top,black,transparent)]",
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
                                            onClick={() => {
                                                updateExpanded(false)
                                                // After a long expansion the header is scrolled far
                                                // above the viewport; bring it back so the dropdown
                                                // is one easy click away from closing.
                                                requestAnimationFrame(() => {
                                                    headerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
                                                })
                                                window.dispatchEvent(new Event("stop-chat-autoscroll"))
                                            }}
                                            className="text-[13px] text-muted-foreground hover:text-foreground"
                                        >
                                            Show less
                                        </button>
                                    </div>
                                )}
                            </div>
                            <div className="relative flex items-center gap-3 mt-1 mb-0.5 bg-background w-max py-0.5 z-10">
                                {isLiveTurn ? (
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
                                    isLiveTurn ? "text-muted-foreground" : "text-foreground"
                                )}>
                                    {isLiveTurn
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
// WorkedForBlock
//
// Finalized-turn collapse: the entire working trace (every reasoning phase plus
// any intermediate prose) is tucked behind one "Worked for …" disclosure so the
// conversation reads clean — only the trailing final answer stays outside. This
// is the committed-message counterpart to the live, per-phase ThoughtBlocks;
// streaming keeps those expanded and this never renders mid-stream. Simpler than
// ThoughtBlock by design (no live height/auto-scroll machinery): default closed,
// open-state persisted, expanded body capped with internal scroll. A finished
// turn renders straight into the collapsed state — it never pops open just to
// animate shut, which used to flash on every remount and desync the tail spacer.
// ---------------------------------------------------------------------------

function WorkedForBlock({
    items,
    durationMs,
    status,
    messageId,
    openOnMount = false,
    onArtifactClick,
    onArtifactExpand,
    onAgentOpen,
    onAttachmentClick,
    suppressArtifactTypes,
}: {
    items: MessageTimelineItem[]
    durationMs?: number
    status?: Message["status"]
    messageId: string
    /** Open on first render — used when the user explicitly loads deferred details. */
    openOnMount?: boolean
    onArtifactClick?: (artifact: ArtifactPayload) => void
    onArtifactExpand?: (artifact: ArtifactRow) => void
    onAgentOpen?: (entry: AgentCallReasoningEntry) => void
    onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
    suppressArtifactTypes?: string[]
}) {
    const openStorageKey = `worked:${messageId}:open`
    const [savedOpenState] = React.useState<boolean | null>(() => {
        const saved = localStorage.getItem(openStorageKey)
        return saved === null ? null : saved === "true"
    })
    const [isOpen, setIsOpen] = React.useState(() => {
        if (openOnMount) return true
        if (savedOpenState !== null) return savedOpenState
        return false
    })
    const toggleOpen = React.useCallback(() => {
        setIsOpen((prev) => {
            const next = !prev
            localStorage.setItem(openStorageKey, String(next))
            if (next) window.dispatchEvent(new Event("stop-chat-autoscroll"))
            return next
        })
    }, [openStorageKey])

    React.useEffect(() => {
        if (!openOnMount) return
        setIsOpen(true)
    }, [openOnMount])

    // Mount the (expensive) reasoning body lazily — only once the disclosure
    // has been opened at least once. While collapsed the grid track is `0fr`,
    // so an empty body and a fully-rendered one occupy the same (zero) height;
    // skipping it avoids parsing every committed message's hidden reasoning
    // markdown + tool views at conversation-open. The first open also renders
    // in chunks so a long tool trace does not monopolize WebView's main thread.
    // Stays mounted after the first open so re-toggling is cheap.
    const totalRenderUnits = React.useMemo(
        () => countTimelineRenderUnits(items),
        [items]
    )
    const [bodyMounted, setBodyMounted] = React.useState(isOpen)
    const [renderBudget, setRenderBudget] = React.useState(() =>
        isOpen ? Math.min(WORKED_DETAILS_INITIAL_BUDGET, totalRenderUnits) : 0
    )

    React.useEffect(() => {
        if (!isOpen || bodyMounted) return
        const frame = window.requestAnimationFrame(() => {
            setBodyMounted(true)
            React.startTransition(() => {
                setRenderBudget((current) =>
                    Math.max(
                        current,
                        Math.min(WORKED_DETAILS_INITIAL_BUDGET, totalRenderUnits)
                    )
                )
            })
        })
        return () => window.cancelAnimationFrame(frame)
    }, [bodyMounted, isOpen, totalRenderUnits])

    React.useEffect(() => {
        if (!isOpen || !bodyMounted || renderBudget >= totalRenderUnits) return
        const timer = window.setTimeout(() => {
            React.startTransition(() => {
                setRenderBudget((current) =>
                    Math.min(totalRenderUnits, current + WORKED_DETAILS_RENDER_CHUNK)
                )
            })
        }, WORKED_DETAILS_CHUNK_DELAY_MS)
        return () => window.clearTimeout(timer)
    }, [bodyMounted, isOpen, renderBudget, totalRenderUnits])

    const visibleItems = React.useMemo(
        () => sliceTimelineByRenderBudget(items, renderBudget),
        [items, renderBudget]
    )
    const hasMoreDetails = renderBudget < totalRenderUnits

    const [isMounted, setIsMounted] = React.useState(false)
    React.useEffect(() => { setIsMounted(true) }, [])

    // Chain the wheel to the page once this box hits its scroll boundary.
    const scrollRef = useTrapWheel<HTMLDivElement>()

    // Duration is the source of truth; older rows (and providers that never
    // stamped it) fall back to the activity summary, then a bare "Worked".
    const statusLabel = status === "aborted"
        ? "Stopped"
        : status === "error"
            ? "Failed"
            : "Done"
    const durationLabel = durationMs != null ? formatWorkDuration(durationMs) : null
    const isTerminalProblem = status === "aborted" || status === "error"
    const fallbackLabel = React.useMemo(() => {
        if (durationLabel || isTerminalProblem) return ""
        const workEntries: ReasoningEntry[] = []
        for (const item of items) {
            if (item.type === "reasoning") workEntries.push(...item.entries)
        }
        return buildSummary(workEntries, 0, "")
    }, [durationLabel, isTerminalProblem, items])
    const label = isTerminalProblem
        ? durationLabel ? `${statusLabel} after ${durationLabel}` : statusLabel
        : durationLabel
            ? `Worked for ${durationLabel}`
            : fallbackLabel || "Worked"

    return (
        <div className="flex w-full min-w-0 flex-col">
            <button
                type="button"
                onClick={toggleOpen}
                aria-expanded={isOpen}
                className={cn(
                    "flex items-center gap-1.5 text-[15px] transition-colors group w-fit max-w-full min-w-0",
                    status === "error"
                        ? "text-destructive hover:text-destructive"
                        : "text-muted-foreground hover:text-foreground"
                )}
            >
                {status === "aborted" ? (
                    <CircleStop className="size-4 shrink-0" />
                ) : status === "error" ? (
                    <CircleAlert className="size-4 shrink-0" />
                ) : null}
                <span className="min-w-0 truncate">{label}</span>
                <ChevronDown
                    className={cn(
                        "size-4 shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                        status === "error"
                            ? "text-destructive/80 group-hover:text-destructive"
                            : "text-muted-foreground/70 group-hover:text-foreground",
                        isOpen ? "rotate-0" : "-rotate-90"
                    )}
                />
            </button>

            <div
                className={cn(
                    "grid will-change-[grid-template-rows,opacity]",
                    isMounted && "transition-[grid-template-rows,opacity] duration-[440ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                    isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                )}
            >
                <div
                    className={cn(
                        "overflow-hidden min-h-0",
                        isMounted && "transition-[transform,opacity] duration-[440ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                        isOpen ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0"
                    )}
                >
                    <div ref={scrollRef} className="tool-call-scroll mt-2 max-h-[70vh] overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable] [touch-action:pan-y]">
                        {!bodyMounted ? (
                            <div className="flex items-center gap-2 py-2 pl-7 text-[13px] text-muted-foreground">
                                <Loader2 className="size-3.5 animate-spin" />
                            </div>
                        ) : (
                        <div className="relative flex flex-col pb-2">
                            <div className="absolute left-[7.5px] top-[11px] bottom-[13px] w-[1.5px] bg-border/60" />
                            <div className="relative flex flex-col gap-2 pt-1 pb-[10px]">
                                {visibleItems.map((item, index) =>
                                    item.type === "reasoning" ? (
                                        <ReasoningEntryList
                                            key={`work-${item.phase}-${index}`}
                                            reasoning={item.entries}
                                            onArtifactClick={onArtifactClick}
                                            onAgentOpen={onAgentOpen}
                                            onAttachmentClick={onAttachmentClick}
                                            searchToolDisplay="expanded"
                                        />
                                    ) : item.type === "steered" ? (
                                        // Steered messages are section barriers —
                                        // they never fold into "Worked for".
                                        null
                                    ) : (
                                        <div
                                            key={`work-${item.phase}-${index}`}
                                            className="pl-7 text-[14px] leading-relaxed text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                                        >
                                            <RenderMessageContent
                                                content={item.content}
                                                messageId={messageId}
                                                onExpand={onArtifactExpand}
                                                suppressArtifactTypes={suppressArtifactTypes}
                                            />
                                        </div>
                                    )
                                )}
                            </div>
                            {hasMoreDetails ? (
                                <div className="relative z-10 flex items-center gap-2 py-1 pl-7 text-[13px] text-muted-foreground">
                                    <Loader2 className="size-3.5 animate-spin" />
                                </div>
                            ) : (
                                <div className="relative flex items-center gap-3 mb-0.5 bg-background w-max py-0.5 z-10">
                                    {status === "aborted" ? (
                                        <CircleStop className="size-4 shrink-0 rounded-full bg-background text-muted-foreground" />
                                    ) : status === "error" ? (
                                        <CircleAlert className="size-4 shrink-0 rounded-full bg-background text-destructive" />
                                    ) : (
                                        <CheckCircle2 className="size-4 shrink-0 rounded-full bg-background text-muted-foreground" />
                                    )}
                                    <span className="text-[14px] font-medium tracking-tight text-foreground">
                                        {statusLabel}
                                    </span>
                                </div>
                            )}
                        </div>
                        )}
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
    onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
    searchToolDisplay: SearchToolDisplay
}) {
    const nodes: React.ReactNode[] = []

    // Agents spawned by another agent in this same reasoning list (their
    // parentRunId is a sibling agent_call's runId) are nested sub-agents. They
    // belong inside that parent agent's workspace panel, not inline at the top
    // level — so skip them here. Direct sub-agents of the turn carry a
    // parentRunId that is the message id, never another agent's runId.
    const agentRunIds = new Set<string>()
    for (const entry of reasoning) {
        if (entry.type === "agent_call") agentRunIds.add(entry.runId)
    }

    for (let index = 0; index < reasoning.length; index++) {
        const entry = reasoning[index]

        if (
            entry.type === "agent_call" &&
            entry.parentRunId &&
            agentRunIds.has(entry.parentRunId)
        ) {
            continue
        }

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
        } else if (entry.type === "memory_recall") {
            nodes.push(
                <MemoryRecallBlock
                    key={`${entry.id}-${index}`}
                    entry={entry}
                />
            )
        } else if (entry.type === "steered_message") {
            // Steered messages surface as timeline barriers, never inside a
            // reasoning list — but render defensively (nested agent traces or
            // legacy data) rather than crashing on the fallthrough.
            nodes.push(
                <SteeredMessageBlock key={`${entry.id}-${index}`} entry={entry} />
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
        <div className="relative z-10 flex max-w-full items-start gap-3 py-1 text-left">
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

function MemoryRecallBlock({ entry }: { entry: MemoryRecallReasoningEntry }) {
    const [expanded, setExpanded] = React.useState<Set<number>>(() => new Set())
    const [fullSnippets, setFullSnippets] = React.useState<Record<number, string>>({})
    const loadingFullSnippetsRef = React.useRef<Set<number>>(new Set())
    const listRef = useTrapWheel<HTMLUListElement>()

    const loadFullSnippet = React.useCallback(async (i: number, hit: MemoryRecallReasoningEntry["hits"][number]) => {
        if (hit.kind === "file") return
        if (fullSnippets[i] || loadingFullSnippetsRef.current.has(i)) return
        loadingFullSnippetsRef.current.add(i)
        try {
            const res = await fetch("/api/memory/chunk", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                cache: "no-store",
                body: JSON.stringify({
                    id: hit.id,
                    source: hit.source,
                    title: hit.title,
                    snippet: hit.snippet,
                }),
            })
            if (!res.ok) return
            const data = (await res.json().catch(() => null)) as { text?: unknown } | null
            const text = data?.text
            if (typeof text === "string" && text.trim()) {
                setFullSnippets((prev) => ({ ...prev, [i]: text.trim() }))
            }
        } finally {
            loadingFullSnippetsRef.current.delete(i)
        }
    }, [fullSnippets])

    const toggle = (i: number, hit: MemoryRecallReasoningEntry["hits"][number]) => {
        const willOpen = !expanded.has(i)
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(i)) next.delete(i)
            else next.add(i)
            return next
        })
        if (willOpen) void loadFullSnippet(i, hit)
    }

    const n = entry.hits.length
    return (
        <div className="relative z-10 flex max-w-full items-start gap-3 py-1 text-left">
            <Brain className="mt-[3px] size-4 shrink-0 rounded-full bg-background text-muted-foreground" />
            <div className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium tracking-tight text-muted-foreground">
                    Recalled {n} {n === 1 ? "note" : "notes"} from memory
                </span>
                <span className="mb-1 block text-[11px] text-muted-foreground/75">
                    Surfaced by similarity to your message · click to inspect what was injected
                </span>
                <ul ref={listRef} className="flex max-h-[360px] flex-col gap-0.5 overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]">
                    {entry.hits.map((hit, i) => {
                        const isOpen = expanded.has(i)
                        const displayTitle = displayMemoryHitTitle(hit.source, hit.title)
                        const displaySnippet = fullSnippets[i] ?? hit.snippet
                        const previewUrl = hit.kind === "file" && hit.url ? appPath(hit.url) : ""
                        const isImagePreview = Boolean(previewUrl && hit.mimeType?.startsWith("image/"))
                        return (
                            <li key={`${hit.source}-${i}`} className="min-w-0">
                                <button
                                    type="button"
                                    onClick={() => toggle(i, hit)}
                                    aria-expanded={isOpen}
                                    className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/60"
                                >
                                    <ChevronDown
                                        className={cn(
                                            "mt-0.5 size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
                                            isOpen ? "rotate-0" : "-rotate-90"
                                        )}
                                    />
                                    <span className="min-w-0 flex-1 whitespace-normal break-words text-[12.5px] leading-snug text-muted-foreground" title={displayTitle}>
                                        {displayTitle}
                                    </span>
                                    <span className="mt-0.5 shrink-0 rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/75" title={`relevance ${hit.score.toFixed(2)}`}>
                                        {hit.score.toFixed(2)}
                                    </span>
                                </button>
                                {isOpen && (
                                    isImagePreview ? (
                                        <div className="mb-1 ml-7 mr-2 mt-0.5 overflow-hidden rounded-md border border-border bg-background">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                                src={previewUrl}
                                                alt={displayTitle}
                                                className="max-h-[320px] w-full object-contain"
                                            />
                                        </div>
                                    ) : hit.kind === "file" && previewUrl ? (
                                        <a
                                            href={previewUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="mb-1 ml-7 mr-2 mt-0.5 flex items-center gap-1.5 rounded-md border-l-2 border-border bg-muted/40 px-2.5 py-1.5 text-[12px] leading-relaxed text-muted-foreground/90 hover:bg-muted"
                                        >
                                            <ExternalLink className="size-3.5 shrink-0" />
                                            <span className="min-w-0 truncate">Open similar file</span>
                                        </a>
                                    ) : (
                                        <p className="mb-1 ml-7 mr-2 mt-0.5 whitespace-pre-wrap break-words rounded-md border-l-2 border-border bg-muted/40 px-2.5 py-1.5 text-[12px] leading-relaxed text-muted-foreground/90">
                                            {displaySnippet}
                                        </p>
                                    )
                                )}
                            </li>
                        )
                    })}
                </ul>
            </div>
        </div>
    )
}

function displayMemoryHitTitle(source: string, rawTitle: string): string {
    const cleanSource = source.trim()
    const cleanTitle = rawTitle.trim() || cleanSource
    const prefix = `${cleanSource} › `
    if (!cleanTitle.startsWith(prefix)) return cleanTitle

    const heading = cleanTitle.slice(prefix.length).trim()
    const sourceLabel = cleanSource.replace(/\.md$/i, "").replace(/[\\/]+/g, " ")
    return normalizeMemoryTitlePart(sourceLabel) === normalizeMemoryTitlePart(heading)
        ? cleanSource
        : cleanTitle
}

function normalizeMemoryTitlePart(value: string): string {
    return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
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

function formatAgentStatus(status: AgentCallReasoningEntry["status"], queued?: boolean): string {
    if (queued) return "queued"
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
    onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
}) {
    if (entry.agentId === "browser_agent") {
        return <BrowserAgentCallBlock entry={entry} onOpen={onOpen} onAttachmentClick={onAttachmentClick} />
    }
    if (entry.agentId === AUDIO_CONTEXT_AGENT_ID || entry.agentId === AUDIO_TRANSCRIPT_AGENT_ID) {
        return <AudioContextAgentCard entry={entry} onOpen={onOpen} />
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
    const statusText = formatAgentStatus(entry.status, entry.queued)
    const outputChars = entry.content.length
    const details = [
        statusText,
        toolCount > 0 ? `${toolCount} tool${toolCount === 1 ? "" : "s"}` : "",
        outputChars > 0 ? `${formatCompactCount(outputChars)} output` : "",
        outputChars > 0 && entry.agentThreadId ? "full transcript saved" : "",
    ].filter(Boolean)
    return (
        <div className="relative z-10 flex max-w-full py-1 text-left">
            <button
                type="button"
                onClick={() => onOpen?.(entry)}
                title={entry.agentThreadId ? `Agent thread ${entry.agentThreadId}` : undefined}
                className="group flex w-max max-w-full items-start gap-3 text-left"
            >
                <FileText className="mt-[3px] size-4 shrink-0 rounded-full bg-background text-muted-foreground transition-colors group-hover:text-foreground" />
                <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium tracking-tight text-muted-foreground group-hover:text-foreground transition-colors">
                        {agentFullLabel(entry)}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground/75">
                        {details.join(" · ")}
                    </span>
                </span>
            </button>
        </div>
    )
}

function formatCompactCount(value: number): string {
    if (value >= 1_000_000) return `${trimCompact(value / 1_000_000)}m chars`
    if (value >= 1_000) return `${trimCompact(value / 1_000)}k chars`
    return `${value} chars`
}

function trimCompact(value: number): string {
    return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "")
}

function BrowserAgentCallBlock({
    entry,
    onOpen,
    onAttachmentClick,
}: {
    entry: AgentCallReasoningEntry
    onOpen?: (entry: AgentCallReasoningEntry) => void
    onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
}) {
    const awaitingUser = isBrowserAgentAwaitingUser(entry)
    const browserSessionId = browserSessionIdFromContent(entry.content)
    const { panelRunId } = useBrowserPanelState()
    // While the desktop side panel hosts this run, collapse the inline block
    // to a chip so only one live-view (noVNC) connection is mounted at a time.
    const shownInPanel = panelRunId === entry.runId
    return (
        <div className="relative z-10 flex max-w-full flex-col gap-2 py-1 text-left">
            <div className="ml-7 grid w-[calc(100%_-_1.75rem)] max-w-[760px] gap-2">
                {shownInPanel ? (
                    <button
                        type="button"
                        onClick={onOpen ? () => onOpen(entry) : undefined}
                        className="group flex w-full cursor-pointer items-center gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-left text-[12px] text-muted-foreground transition-colors hover:border-border hover:bg-muted/35 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        aria-label="Browser agent is shown in the side panel"
                        title="Browser agent is shown in the side panel"
                    >
                        <Monitor className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                            Browser agent · {formatAgentStatus(entry.status, entry.queued)}
                        </span>
                        <span className="shrink-0 rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-700 dark:text-sky-300">
                            live in side panel
                        </span>
                    </button>
                ) : (
                    <BrowserAgentLiveView active={entry.status === "running" || awaitingUser} sessionId={browserSessionId} onOpenDetails={onOpen ? () => onOpen(entry) : undefined} />
                )}
                {awaitingUser && (
                    <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-200">
                        Browser is waiting for user input or confirmation.
                    </div>
                )}
                {entry.status === "error" && entry.error && (
                    <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
                        {entry.error}
                    </div>
                )}
                {!!entry.attachments?.length && (
                    <div className="flex max-w-full flex-wrap gap-2">
                        {entry.attachments.map(att => (
                            <AttachmentCard
                                key={att.id}
                                attachment={att}
                                onClick={() => onAttachmentClick?.(att, entry.attachments)}
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

    const measure = React.useCallback(() => {
        if (contentRef.current) setContentHeight(Math.ceil(contentRef.current.getBoundingClientRect().height) + 2)
    }, [])

    // Desktop: settle the collapse height before the first paint so a long
    // message renders already clamped (with its "Show more" affordance) instead
    // of flashing full-height and snapping shorter — and shifting everything
    // below it — when the post-paint effect measures it on conversation open.
    // Gated to desktop so mobile keeps its deferred, paint-light measurement.
    useIsomorphicLayoutEffect(() => {
        if (!isDesktopViewport()) return
        measure()
    }, [content, measure])

    React.useEffect(() => {
        if (!contentRef.current) return
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(contentRef.current)
        return () => observer.disconnect()
    }, [content, measure])

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
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-[#f0ede6] dark:bg-muted [mask-image:linear-gradient(to_top,black,transparent)]" />
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

// ---------------------------------------------------------------------------
// SteeredMessageBlock — a user message injected INTO a running turn (provider
// steering, e.g. codex `turn/steer`). Rendered inline inside the assistant
// turn at the exact injection point: a "Steered message" label on the left,
// the user bubble on the right, before whatever the model says next. The
// standalone user row for the same text is tag-hidden (see MessageBubble's
// user branch), so this block is its only visible rendering.
// ---------------------------------------------------------------------------

function SteeredMessageBlock({ entry }: { entry: SteeredMessageReasoningEntry }) {
    return (
        <div className="my-1.5 flex items-center justify-end gap-3">
            <span className="shrink-0 select-none text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Steered message
            </span>
            <div className="max-w-[75%] select-text whitespace-pre-wrap break-words rounded-[10px] bg-[#f0ede6] px-4 py-2.5 text-[15px] dark:bg-muted">
                {entry.content}
            </div>
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

function DeferredThoughtBlock({
    loading,
    thinkingDuration,
    durationMs,
    status,
    hasToolCalls,
    onOpen,
}: {
    loading: boolean
    thinkingDuration?: number
    durationMs?: number
    status?: Message["status"]
    hasToolCalls: boolean
    onOpen: () => void
}) {
    const seconds = Math.round(thinkingDuration ?? 0)
    const durationLabel = durationMs != null ? formatWorkDuration(durationMs) : null
    const statusLabel = status === "aborted"
        ? "Stopped"
        : status === "error"
            ? "Failed"
            : "Done"
    const isTerminalProblem = status === "aborted" || status === "error"
    const title = isTerminalProblem
        ? (durationLabel ? `${statusLabel} after ${durationLabel}` : statusLabel)
        : durationLabel
            ? `Worked for ${durationLabel}`
            : seconds > 0
                ? `Thought for ${seconds}s`
                : hasToolCalls
                    ? "Tools and thinking"
                    : "Thinking"

    // Mirror WorkedForBlock's collapsed header exactly — a borderless inline
    // "Worked for …" with a trailing chevron, no box, no "Open" label — so a
    // conversation never shows two different treatments. Clicking still lazily
    // loads the deferred reasoning/tool payload; once hydrated this unmounts and
    // the real WorkedForBlock renders (openOnMount), keeping the perf win of not
    // eagerly parsing every committed message's hidden reasoning at open.
    return (
        <div className="flex w-full min-w-0 flex-col">
            <button
                type="button"
                onClick={onOpen}
                disabled={loading}
                aria-expanded={false}
                aria-label="Open thinking and tool details"
                className={cn(
                    "flex items-center gap-1.5 text-[15px] transition-colors group w-fit max-w-full min-w-0 disabled:cursor-default",
                    status === "error"
                        ? "text-destructive hover:text-destructive"
                        : "text-muted-foreground hover:text-foreground"
                )}
            >
                {status === "aborted" ? (
                    <CircleStop className="size-4 shrink-0" />
                ) : status === "error" ? (
                    <CircleAlert className="size-4 shrink-0" />
                ) : null}
                <span className="min-w-0 truncate">{title}</span>
                {loading ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground/70" />
                ) : (
                    <ChevronDown
                        className={cn(
                            "size-4 shrink-0 -rotate-90 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
                            status === "error"
                                ? "text-destructive/80 group-hover:text-destructive"
                                : "text-muted-foreground/70 group-hover:text-foreground"
                        )}
                    />
                )}
            </button>
        </div>
    )
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

interface MessageBubbleProps {
    message: Message
    isLatestAssistantMessage?: boolean
    isStreamingMessage?: boolean
    compact?: boolean
    suppressArtifactTypes?: string[]
    onArtifactClick?: (artifact: ArtifactPayload) => void
    /**
     * Fired when the user clicks "↗ Expand" on an inline `<artifact>` card.
     * Chat-view wires this to its side-panel state. Distinct from
     * `onArtifactClick` (which is the legacy code-block / tool-result router).
     */
    onArtifactExpand?: (artifact: ArtifactRow) => void
    onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
    onAgentOpen?: (entry: AgentCallReasoningEntry) => void
    onLoadMessageDetails?: (messageId: string) => Promise<void>
    autoLoadDeferredDetails?: boolean
}

function MessageBubbleComponent({
    message,
    isLatestAssistantMessage,
    isStreamingMessage,
    compact = false,
    suppressArtifactTypes,
    onArtifactClick,
    onArtifactExpand,
    onAttachmentClick,
    onAgentOpen,
    onLoadMessageDetails,
    autoLoadDeferredDetails = false,
}: MessageBubbleProps) {
    const [copied, setCopied] = React.useState(false)
    const [hovered, setHovered] = React.useState(false)
    const [detailLoading, setDetailLoading] = React.useState(false)
    const [detailLoadFailed, setDetailLoadFailed] = React.useState(false)
    const [openLoadedDetails, setOpenLoadedDetails] = React.useState(false)
    const autoLoadAttemptedRef = React.useRef<string | null>(null)
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

    const loadDeferredDetails = React.useCallback(async (openAfterLoad: boolean) => {
        if (!message.deferred || !onLoadMessageDetails || detailLoading) return
        setDetailLoading(true)
        setDetailLoadFailed(false)
        try {
            await onLoadMessageDetails(message.id)
            if (openAfterLoad) setOpenLoadedDetails(true)
        } catch {
            setDetailLoadFailed(true)
        } finally {
            setDetailLoading(false)
        }
    }, [detailLoading, message.deferred, message.id, onLoadMessageDetails])

    const handleOpenDeferredDetails = React.useCallback(() => {
        void loadDeferredDetails(true)
    }, [loadDeferredDetails])

    const hasReasoning = Array.isArray(message.reasoning) && message.reasoning.length > 0
    const hasDeferredDetails = Boolean(
        message.role === "assistant" &&
        (message.deferred?.reasoning || message.deferred?.toolCalls) &&
        !hasReasoning
    )
    const canLoadDeferredDetails = hasDeferredDetails && Boolean(onLoadMessageDetails)

    React.useEffect(() => {
        if (!autoLoadDeferredDetails || !canLoadDeferredDetails || detailLoading) return
        if (autoLoadAttemptedRef.current === message.id) return
        autoLoadAttemptedRef.current = message.id
        // Background load only — never force the block open. Forcing open here
        // re-expanded (and persisted as open) every assistant thought/tool block
        // on each refresh. Explicit clicks still open via handleOpenDeferredDetails.
        void loadDeferredDetails(false)
    }, [
        autoLoadDeferredDetails,
        canLoadDeferredDetails,
        detailLoading,
        loadDeferredDetails,
        message.id,
    ])

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
                "max-md:select-none",
                // Touch has no hover — keep the meta row (copy/artifact actions)
                // reachable on coarse pointers instead of permanently invisible.
                hovered ? "opacity-100" : "opacity-0 pointer-coarse:opacity-100",
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
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground pointer-coarse:size-9"
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

    const reasoningGroups = React.useMemo(
        () => hasReasoning ? groupReasoningByPhase(message.reasoning!) : [],
        [hasReasoning, message.reasoning]
    )
    const contentSegments = React.useMemo(
        () => message.contentSegments ?? (
            message.content.length > 0 ? [{ phase: 0, content: message.content }] : []
        ),
        [message.content, message.contentSegments]
    )
    const timeline = React.useMemo(
        () => buildInterleavedTimeline(reasoningGroups, contentSegments),
        [contentSegments, reasoningGroups]
    )
    const visibleAssistantAttachments = React.useMemo(
        () => hideInlineImageAttachments(
            message.attachments,
            contentSegments.map((segment) => segment.content).join("")
        ),
        [contentSegments, message.attachments]
    )

    if (message.role === "user") {
        // Steered rows (delivered INTO a running turn) render inline inside
        // that turn's assistant bubble at their injection point — the
        // standalone bubble would duplicate them, so it stays hidden.
        if (parseSteeredMessage(message.content) !== null) return null
        // Background-job completion notices are server-authored user-role
        // messages (the wake prompt); render them as a muted system card,
        // not as something the user typed.
        const jobNotice = parseBackgroundJobNotice(message.content)
        if (jobNotice) {
            return (
                <div
                    className="flex flex-col items-stretch gap-2 select-text"
                    onMouseEnter={() => setHovered(true)}
                    onMouseLeave={() => setHovered(false)}
                >
                    <div className="rounded-xl border border-border/60 bg-muted/40 px-4 py-3">
                        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground/80">
                            <Terminal className="size-4 shrink-0 text-muted-foreground" />
                            {jobNotice.headline}
                        </div>
                        {jobNotice.body && (
                            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-muted-foreground">
                                {jobNotice.body}
                            </pre>
                        )}
                    </div>
                </div>
            )
        }
        return (
            <div
                className="flex flex-col items-end gap-2 select-text"
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
            >
                {!!message.attachments?.length && (
                    <div className="flex gap-2 flex-wrap justify-end max-w-[85%]">
                        {message.attachments!.map((att) => (
                            <AttachmentCard key={att.id} attachment={att} onClick={() => onAttachmentClick?.(att, message.attachments)} />
                        ))}
                    </div>
                )}
                {message.content && <UserMessageContent messageId={message.id} content={message.content} />}
                {meta}
            </div>
        )
    }

    const lastReasoningPhase = reasoningGroups.length > 0 ? reasoningGroups[reasoningGroups.length - 1].phase : null
    const lastContentPhase = contentSegments.length > 0 ? contentSegments[contentSegments.length - 1].phase : null
    const isInProgressReasoning = Boolean(
        isStreamingMessage &&
        isLatestAssistantMessage &&
        hasReasoning &&
        lastReasoningPhase !== null &&
        (lastContentPhase == null || lastReasoningPhase > lastContentPhase) &&
        message.thinkingDuration == null &&
        message.status == null
    )

    // Once the turn is finalized, fold the working trace into one "Worked for …"
    // disclosure and surface only the final answer. The answer is the trailing
    // run of content items (text after the last reasoning/tool activity); the
    // interleaved case (text → tool → text → tool → final text) keeps the
    // intermediate prose inside the disclosure, and a turn that ends on reasoning
    // (no trailing text) folds entirely — nothing dangles outside. During
    // streaming we leave the live per-phase blocks untouched.
    const collapseWork =
        !isStreamingMessage && !isInProgressReasoning && timeline.length > 0

    // Steered messages are hard barriers: user speech never folds into
    // "Worked for". Partition the timeline at steered items; each section
    // folds independently (everything except its trailing content run), so a
    // steered turn reads: work ▸ / what the AI said / steered message /
    // work ▸ / the continuation. A turn with no steers is one section —
    // byte-identical to the old layout.
    const sections: Array<{
        steered: SteeredMessageReasoningEntry | null
        items: MessageTimelineItem[]
    }> = [{ steered: null, items: [] }]
    for (const item of timeline) {
        if (item.type === "steered") sections.push({ steered: item.entry, items: [] })
        else sections[sections.length - 1].items.push(item)
    }

    const renderTimelineItem = (item: MessageTimelineItem) =>
        item.type === "reasoning" ? (
            <ThoughtBlock
                key={`reasoning-${message.id}-${item.phase}`}
                reasoning={item.entries}
                onArtifactClick={onArtifactClick}
                onAgentOpen={onAgentOpen}
                onAttachmentClick={onAttachmentClick}
                messageId={`${message.id}:phase:${item.phase}`}
                isStreaming={isInProgressReasoning && lastReasoningPhase === item.phase}
                isStreamingTurn={Boolean(isStreamingMessage && isLatestAssistantMessage && message.status == null && lastReasoningPhase === item.phase)}
                thinkingDuration={message.thinkingDuration}
                messageStatus={message.status}
                openOnMount={openLoadedDetails}
            />
        ) : item.type === "steered" ? (
            <SteeredMessageBlock
                key={`steered-${message.id}-${item.entry.id}`}
                entry={item.entry}
            />
        ) : (
            <div key={`content-${message.id}-${item.phase}`} className="min-w-0 break-words text-[16px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-1">
                <RenderMessageContent
                    content={item.content}
                    messageId={message.id}
                    isStreaming={isStreamingMessage}
                    onExpand={onArtifactExpand}
                    suppressArtifactTypes={suppressArtifactTypes}
                />
            </div>
        )

    return (
        <div
            ref={selectionGutterRef}
            onPointerDownCapture={handleSelectionGutterPointerDownCapture}
            className={cn(
                "flex w-full min-w-0 flex-col gap-1.5 select-text",
                !compact && "md:-ml-16 md:w-[calc(100%+4rem)] md:pl-16"
            )}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            {canLoadDeferredDetails &&
                (!autoLoadDeferredDetails || detailLoadFailed) && (
                <DeferredThoughtBlock
                    loading={detailLoading}
                    thinkingDuration={message.thinkingDuration}
                    durationMs={message.durationMs}
                    status={message.status}
                    hasToolCalls={Boolean(message.deferred?.toolCalls)}
                    onOpen={handleOpenDeferredDetails}
                />
            )}
            {collapseWork ? (
                sections.map((section, index) => {
                    let splitAt = section.items.length
                    while (splitAt > 0 && section.items[splitAt - 1].type === "content") splitAt--
                    const workItems = section.items.slice(0, splitAt)
                    const finalItems = section.items.slice(splitAt)
                    const isLastSection = index === sections.length - 1
                    // Per-section wall-clock from the steered markers' elapsed
                    // offsets; a steer-free turn is one section = full duration.
                    const sectionStartMs = section.steered?.elapsedMs ?? 0
                    const sectionEndMs = isLastSection
                        ? message.durationMs
                        : sections[index + 1].steered?.elapsedMs
                    const sectionDurationMs =
                        typeof sectionEndMs === "number" && sectionEndMs >= sectionStartMs
                            ? sectionEndMs - sectionStartMs
                            : undefined
                    return (
                        <React.Fragment key={`section-${message.id}-${index}`}>
                            {section.steered && (
                                <SteeredMessageBlock entry={section.steered} />
                            )}
                            {workItems.length > 0 && (
                                <WorkedForBlock
                                    items={workItems}
                                    durationMs={sectionDurationMs}
                                    status={isLastSection ? message.status : undefined}
                                    messageId={index === 0 ? message.id : `${message.id}#s${index}`}
                                    openOnMount={openLoadedDetails}
                                    onArtifactClick={onArtifactClick}
                                    onArtifactExpand={onArtifactExpand}
                                    onAgentOpen={onAgentOpen}
                                    onAttachmentClick={onAttachmentClick}
                                    suppressArtifactTypes={suppressArtifactTypes}
                                />
                            )}
                            {finalItems.map(renderTimelineItem)}
                        </React.Fragment>
                    )
                })
            ) : (
                timeline.map(renderTimelineItem)
            )}
            {timeline.length === 0 && <TerminalMessageStatusLine status={message.status} />}
            {visibleAssistantAttachments.length > 0 && (
                <div className="mt-1 flex max-w-[85%] flex-wrap gap-2">
                    {visibleAssistantAttachments.map((att) => (
                        <AttachmentCard key={att.id} attachment={att} onClick={() => onAttachmentClick?.(att, visibleAssistantAttachments)} />
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
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground pointer-coarse:size-9"
                aria-label="Download artifact"
                title="Download artifact"
            >
                <Download className="size-4" />
            </button>
            {onExpand && (
                <button
                    type="button"
                    onClick={() => onExpand(artifact)}
                    className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground pointer-coarse:size-9"
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
    streamingStatus?: "connecting" | "recovering" | "offline" | null
    compact?: boolean
    suppressArtifactTypes?: string[]
    showCursor?: boolean
    showStreamingStatusLabel?: boolean
    onArtifactClick?: (artifact: ArtifactPayload) => void
    onArtifactExpand?: (artifact: ArtifactRow) => void
    onAgentOpen?: (entry: AgentCallReasoningEntry) => void
    onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
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

function streamingStatusLabel(
    status: StreamingBubbleProps["streamingStatus"],
    seconds?: number
): string {
    const roundedSeconds = Math.max(0, Math.round(seconds ?? 0))
    const suffix = roundedSeconds > 0 ? ` (${roundedSeconds}s)` : ""
    if (status === "offline") return `Waiting for connection${suffix}`
    if (status === "recovering") return `Reconnecting${suffix}`
    return `Connecting${suffix}`
}

export function StreamingBubble({ reasoning, content, contentSegments, streamingMode, streamingStatus, compact = false, suppressArtifactTypes, showCursor = true, showStreamingStatusLabel = false, onArtifactClick, onArtifactExpand, onAgentOpen, onAttachmentClick, thinkingSeconds, thinkingDone, messageId, searchToolDisplay = "expanded", thoughtAutoOpen = true, thoughtAutoExpandTools = false, liveCollapsedTitle = false }: StreamingBubbleProps) {
    const reasoningGroups = React.useMemo(() => groupReasoningByPhase(reasoning), [reasoning])
    const timeline = React.useMemo(() => buildInterleavedTimeline(reasoningGroups, contentSegments), [reasoningGroups, contentSegments])
    const activeReasoningPhase = reasoningGroups.length > 0 ? reasoningGroups[reasoningGroups.length - 1].phase : null
    const hasVisiblePayload = reasoning.length > 0 || content.trim().length > 0 || contentSegments.some(segment => segment.content.trim().length > 0)
    const liveReasoningPhase =
        streamingMode === "reasoning" ? activeReasoningPhase : null
    const {
        rootRef: selectionGutterRef,
        handlePointerDownCapture: handleSelectionGutterPointerDownCapture,
    } = useMessageSelectionGutter()

    return (
        <div
            ref={selectionGutterRef}
            onPointerDownCapture={handleSelectionGutterPointerDownCapture}
            className={cn(
                "flex w-full min-w-0 flex-col gap-1.5 select-text",
                !compact && "md:-ml-16 md:w-[calc(100%+4rem)] md:pl-16"
            )}
        >
            {timeline.map((item) => (
                item.type === "reasoning" ? (
                    <ThoughtBlock
                        key={`stream-reasoning-${messageId ?? "pending"}-${item.phase}`}
                        reasoning={item.entries}
                        isStreaming={liveReasoningPhase === item.phase}
                        isStreamingTurn={liveReasoningPhase === item.phase}
                        onArtifactClick={onArtifactClick}
                        onAgentOpen={onAgentOpen}
                        onAttachmentClick={onAttachmentClick}
                        messageId={messageId ? `${messageId}:phase:${item.phase}` : undefined}
                        thinkingSeconds={thinkingSeconds}
                        thinkingDone={thinkingDone}
                        searchToolDisplay={searchToolDisplay}
                        thoughtAutoOpen={thoughtAutoOpen}
                        thoughtAutoExpandTools={thoughtAutoExpandTools}
                        liveCollapsedTitle={liveCollapsedTitle}
                    />
                ) : item.type === "steered" ? (
                    <SteeredMessageBlock
                        key={`stream-steered-${messageId ?? "pending"}-${item.entry.id}`}
                        entry={item.entry}
                    />
                ) : (
                    <div key={`stream-content-${item.phase}`} className="min-w-0 break-words text-[16px] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-1">
                        {messageId ? (
                            <RenderMessageContent
                                content={item.content}
                                messageId={messageId}
                                isStreaming
                                onExpand={onArtifactExpand}
                                suppressArtifactTypes={suppressArtifactTypes}
                            />
                        ) : (
                            <MarkdownRenderer content={item.content} />
                        )}
                    </div>
                )
            ))}
            {showCursor && !hasVisiblePayload && (
                <div className="flex min-h-7 items-center gap-2 pl-1 pt-1 text-[15px] leading-6 text-muted-foreground">
                    <span className="flex items-center gap-1" aria-hidden="true">
                        <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-pulse" />
                        <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-pulse [animation-delay:0.2s]" />
                        <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-pulse [animation-delay:0.4s]" />
                    </span>
                    {showStreamingStatusLabel && (
                        <span>{streamingStatusLabel(streamingStatus, thinkingSeconds)}</span>
                    )}
                </div>
            )}
        </div>
    )
}
