"use client"

import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
    AlertCircle,
    CheckCircle2,
    ChevronRight,
    Loader2,
    RefreshCcw,
    Trash2,
    Search,
    Radio,
    XCircle,
    Ban,
} from "lucide-react"

import { cn } from "@/lib/utils"
import type { RequestLogRow, RequestStatus, ToolLogRow } from "@/lib/observability/schema"
import type { Message, ToolCallReasoningEntry } from "@/lib/types"
import { withMissingToolLogReasoning } from "@/lib/observability/log-transcript"
import { MessageBubble } from "@/components/message-bubble"
import { Select as UiSelect } from "@/components/ui/select"
import { BackgroundJobsSection } from "@/components/settings/background-jobs-section"
import { ConversationArtifactsProvider } from "@/components/artifacts/use-conversation-artifacts"
import { useLogs, useRequestDetail, useRequestInput, type LiveTailStatus, type LogsFilters, type RequestLogTranscript } from "./use-logs"

const STATUS_LABELS: Record<RequestStatus, string> = {
    streaming: "Streaming",
    ok: "OK",
    error: "Error",
    aborted: "Aborted",
}

const RANGE_OPTIONS: Array<{ value: NonNullable<LogsFilters["range"]>; label: string }> = [
    { value: "1h", label: "Last hour" },
    { value: "24h", label: "Last 24h" },
    { value: "7d", label: "Last 7 days" },
    { value: "30d", label: "Last 30 days" },
    { value: "all", label: "All time" },
]

const STATUS_OPTIONS: Array<{ value: RequestStatus | ""; label: string }> = [
    { value: "", label: "Any status" },
    { value: "ok", label: "OK" },
    { value: "error", label: "Error" },
    { value: "aborted", label: "Aborted" },
    { value: "streaming", label: "Streaming" },
]

const ROW_HEIGHT = 56
const EXPANDED_ROW_HEIGHT = 560

export function LogsTab() {
    const {
        rows,
        total,
        filters,
        setFilters,
        filterOptions,
        loading,
        error,
        hasMore,
        loadMore,
        refresh,
        clearAll,
        liveTail,
        setLiveTail,
        liveTailStatus,
    } = useLogs()
    const [expanded, setExpanded] = React.useState<string | null>(null)
    const [confirmingClear, setConfirmingClear] = React.useState(false)

    return (
        <div className="flex flex-col gap-4">
            <BackgroundJobsSection />
            <FilterBar
                filters={filters}
                setFilters={setFilters}
                filterOptions={filterOptions}
                liveTail={liveTail}
                liveTailStatus={liveTailStatus}
                setLiveTail={setLiveTail}
                onRefresh={refresh}
                onClear={() => setConfirmingClear(true)}
            />

            <div className="flex items-baseline justify-between gap-3">
                <p className="text-[12.5px] text-foreground/55 tabular-nums">
                    {loading && rows.length === 0 ? "Loading…" : `${total.toLocaleString()} ${total === 1 ? "request" : "requests"}`}
                    {liveTail && <LiveTailLabel status={liveTailStatus} />}
                </p>
            </div>

            {error && <ErrorBanner message={error} />}

            <LogsTable
                rows={rows}
                expanded={expanded}
                setExpanded={setExpanded}
                loading={loading}
                hasMore={hasMore}
                onLoadMore={loadMore}
            />

            {confirmingClear && (
                <ConfirmDialog
                    title="Clear all logs?"
                    description={`This will permanently delete ${total.toLocaleString()} request log${total === 1 ? "" : "s"} and their tool calls. This action cannot be undone.`}
                    confirmLabel="Clear all"
                    onConfirm={async () => {
                        await clearAll()
                        setConfirmingClear(false)
                    }}
                    onCancel={() => setConfirmingClear(false)}
                />
            )}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
    filters,
    setFilters,
    filterOptions,
    liveTail,
    liveTailStatus,
    setLiveTail,
    onRefresh,
    onClear,
}: {
    filters: LogsFilters
    setFilters: (next: LogsFilters | ((prev: LogsFilters) => LogsFilters)) => void
    filterOptions: { agents: string[]; providers: string[]; models: Array<{ provider: string; model: string }> }
    liveTail: boolean
    liveTailStatus: LiveTailStatus
    setLiveTail: (next: boolean) => void
    onRefresh: () => void
    onClear: () => void
}) {
    const [searchValue, setSearchValue] = React.useState(filters.q ?? "")

    const toggleLiveTail = React.useCallback(() => {
        if (liveTail && liveTailStatus === "disconnected") {
            setLiveTail(false)
            window.setTimeout(() => setLiveTail(true), 0)
            return
        }
        setLiveTail(!liveTail)
    }, [liveTail, liveTailStatus, setLiveTail])

    // Debounce free-text search. Bail out when the normalized query is unchanged
    // (returning `prev` makes React skip the update) so an empty box on mount
    // doesn't churn the `filters` reference and reset the page / stream.
    React.useEffect(() => {
        const t = setTimeout(() => {
            const next = searchValue || undefined
            setFilters(prev => (prev.q === next ? prev : { ...prev, q: next }))
        }, 250)
        return () => clearTimeout(t)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchValue])

    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-auto">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground/40" />
                <input
                    value={searchValue}
                    onChange={e => setSearchValue(e.target.value)}
                    placeholder="Search error / id…"
                    className={cn(
                        "h-8 w-full rounded-lg border border-border bg-background pl-8 pr-2.5 text-[13px] text-foreground outline-none sm:w-56",
                        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                        "placeholder:text-foreground/40"
                    )}
                />
            </div>

            <Select
                value={filters.range}
                onChange={v => setFilters(prev => ({ ...prev, range: v as LogsFilters["range"] }))}
                options={RANGE_OPTIONS}
            />
            <Select
                value={filters.status ?? ""}
                onChange={v => setFilters(prev => ({ ...prev, status: (v || undefined) as LogsFilters["status"] }))}
                options={STATUS_OPTIONS}
            />
            {filterOptions.agents.length > 0 && (
                <Select
                    value={filters.agent ?? ""}
                    onChange={v => setFilters(prev => ({ ...prev, agent: v || undefined }))}
                    options={[{ value: "", label: "Any agent" }, ...filterOptions.agents.map(a => ({ value: a, label: a }))]}
                />
            )}
            {filterOptions.providers.length > 0 && (
                <Select
                    value={filters.provider ?? ""}
                    onChange={v => setFilters(prev => ({ ...prev, provider: v || undefined, model: undefined }))}
                    options={[{ value: "", label: "Any provider" }, ...filterOptions.providers.map(p => ({ value: p, label: p }))]}
                />
            )}

            <div className="ml-0 flex items-center gap-1.5 sm:ml-auto">
                <button
                    onClick={toggleLiveTail}
                    title={liveTail ? liveTailStatusTitle(liveTailStatus) : "Start live tail"}
                    className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors",
                        liveTail && liveTailStatus !== "disconnected"
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                            : "border-border bg-background text-foreground/70 hover:bg-muted/60"
                    )}
                >
                    <Radio className={cn("size-3.5", liveTail && liveTailStatus !== "disconnected" && "animate-pulse")} />
                    {liveTail ? liveTailButtonLabel(liveTailStatus) : "Live"}
                </button>
                <button
                    onClick={onRefresh}
                    title="Refresh"
                    className="inline-flex size-8 items-center justify-center rounded-lg border border-border bg-background text-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                    <RefreshCcw className="size-3.5" />
                </button>
                <button
                    onClick={onClear}
                    title="Clear all logs"
                    className="inline-flex size-8 items-center justify-center rounded-lg border border-border bg-background text-foreground/60 transition-colors hover:border-destructive/40 hover:bg-destructive/5 hover:text-destructive"
                >
                    <Trash2 className="size-3.5" />
                </button>
            </div>
        </div>
    )
}

function LiveTailLabel({ status }: { status: LiveTailStatus }) {
    const connected = status === "connected"
    return (
        <span
            className={cn(
                "ml-2 inline-flex items-center gap-1",
                connected ? "text-emerald-600 dark:text-emerald-500" : "text-amber-600 dark:text-amber-500"
            )}
        >
            <span className={cn("size-1.5 rounded-full", connected ? "animate-pulse bg-emerald-500" : "bg-amber-500")} />
            {connected ? "live" : status === "disconnected" ? "live disconnected" : "live connecting"}
        </span>
    )
}

function liveTailButtonLabel(status: LiveTailStatus) {
    if (status === "connected") return "Live"
    if (status === "disconnected") return "Reconnect"
    return "Connecting"
}

function liveTailStatusTitle(status: LiveTailStatus) {
    if (status === "connected") return "Stop live tail"
    if (status === "disconnected") return "Reconnect live tail"
    return "Live tail is connecting"
}

function Select({ value, onChange, options }: {
    value: string
    onChange: (next: string) => void
    options: Array<{ value: string; label: string }>
}) {
    return (
        <UiSelect
            value={value}
            onValueChange={onChange}
            options={options}
            className={cn(
                "min-w-[calc(50%-0.25rem)] flex-1 sm:min-w-[8.5rem] sm:flex-none",
                "[&>button]:h-8 [&>button]:rounded-lg [&>button]:px-2.5 [&>button]:text-[13px] [&>button]:font-medium"
            )}
        />
    )
}

// ---------------------------------------------------------------------------
// Virtualized table
// ---------------------------------------------------------------------------

function LogsTable({
    rows,
    expanded,
    setExpanded,
    loading,
    hasMore,
    onLoadMore,
}: {
    rows: RequestLogRow[]
    expanded: string | null
    setExpanded: (id: string | null) => void
    loading: boolean
    hasMore: boolean
    onLoadMore: () => void
}) {
    const parentRef = React.useRef<HTMLDivElement>(null)

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => parentRef.current,
        estimateSize: idx => (rows[idx]?.id === expanded ? EXPANDED_ROW_HEIGHT : ROW_HEIGHT),
        overscan: 6,
        getItemKey: idx => rows[idx]?.id ?? idx,
    })

    // Pin the scroll position when the user expands/collapses a row. By default
    // tanstack nudges `scrollTop` by a resized row's size delta whenever that row's
    // top sits above the scroll offset — so toggling a row near the top of the
    // viewport makes the whole list lurch by the ~500px expand delta. Suppress that
    // correction for the toggled row only: its `start` offset doesn't move when it
    // resizes, so the row stays put and its detail just opens below. Every other row
    // keeps tanstack's default correction (`start < scrollOffset`) so the one-time
    // estimate→actual remeasure of collapsed rows never makes scrolling jitter.
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = item =>
        item.key !== expanded && item.start < (virtualizer.scrollOffset ?? 0)

    // Push a row's live layout height into the virtualizer. We measure
    // imperatively — from the row's mount ref and from a layout effect inside the
    // expanded detail — rather than via `virtualizer.measureElement`/ResizeObserver:
    // each row sits in an absolutely-positioned, `translateY`-offset wrapper, and a
    // ResizeObserver does NOT fire when that wrapper grows as the expanded detail
    // loads. The cached size therefore stayed at the collapsed ~89px and every row
    // below overlapped the bottom of the expanded one ("se condensează între ele").
    // A direct `resizeItem` from guaranteed lifecycle callbacks keeps rows flush.
    const resizeRow = React.useCallback(
        (node: HTMLElement | null) => {
            if (!node) return
            const apply = () => {
                if (!node.isConnected) return
                const index = Number(node.dataset.index)
                if (Number.isInteger(index)) {
                    virtualizer.resizeItem(
                        index,
                        Math.round(node.getBoundingClientRect().height)
                    )
                }
            }
            apply()
            requestAnimationFrame(apply)
        },
        [virtualizer]
    )

    // Re-measure every rendered row across an expand/collapse toggle. The opening
    // row is handled by the detail's own layout effect once its async content
    // loads, but the *collapsing* row shrinks back to ~89px after its detail
    // unmounts and nothing else re-measures it — leaving a gap below. Sweeping all
    // rendered rows on the next frame after the toggle keeps them flush both ways.
    React.useLayoutEffect(() => {
        const container = parentRef.current
        if (!container) return
        const sweep = () => {
            container.querySelectorAll<HTMLElement>("[data-index]").forEach(node => {
                const index = Number(node.dataset.index)
                if (Number.isInteger(index)) {
                    virtualizer.resizeItem(
                        index,
                        Math.round(node.getBoundingClientRect().height)
                    )
                }
            })
        }
        // Sweep across several frames: a collapsing row shrinks back to ~89px
        // over a frame or two, and a single early measurement can still read the
        // expanded height (leaving a gap). Re-measuring on the next two frames
        // and once more shortly after reliably captures the settled height.
        let raf2 = 0
        const raf1 = requestAnimationFrame(() => {
            sweep()
            raf2 = requestAnimationFrame(sweep)
        })
        const timer = window.setTimeout(sweep, 90)
        return () => {
            cancelAnimationFrame(raf1)
            cancelAnimationFrame(raf2)
            window.clearTimeout(timer)
        }
    }, [expanded, virtualizer])

    // Trigger load-more when the last row enters the viewport.
    const items = virtualizer.getVirtualItems()
    React.useEffect(() => {
        if (!hasMore || loading || items.length === 0) return
        const last = items[items.length - 1]
        if (last && last.index >= rows.length - 5) onLoadMore()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items, hasMore, loading, rows.length])

    if (rows.length === 0 && !loading) {
        return (
            <div className="rounded-2xl border border-dashed border-border/70 bg-muted/30 px-5 py-12 text-center text-[14px] text-foreground/55">
                No requests logged yet.
            </div>
        )
    }

    return (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card">
            <div className="hidden grid-cols-[24px_140px_110px_110px_minmax(0,1fr)_90px_90px_120px_24px] gap-3 border-b border-border/70 bg-muted/40 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-foreground/55 md:grid">
                <span />
                <span>When</span>
                <span>Profile</span>
                <span>Agent</span>
                <span>Model</span>
                <span className="text-right">Tokens</span>
                <span className="text-right">Duration</span>
                <span>Status</span>
                <span />
            </div>

            <div ref={parentRef} className="h-[calc(100dvh-230px)] min-h-[480px] overflow-auto md:h-[calc(100dvh-220px)] md:min-h-[560px]">
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                    {items.map(v => {
                        const row = rows[v.index]
                        if (!row) return null
                        const isExpanded = row.id === expanded
                        return (
                            <div
                                key={v.key}
                                data-index={v.index}
                                ref={resizeRow}
                                style={{
                                    position: "absolute",
                                    top: 0,
                                    left: 0,
                                    right: 0,
                                    transform: `translateY(${v.start}px)`,
                                }}
                            >
                                <LogRow
                                    row={row}
                                    expanded={isExpanded}
                                    onToggle={() => setExpanded(isExpanded ? null : row.id)}
                                    onMeasure={resizeRow}
                                />
                            </div>
                        )
                    })}
                </div>

                {loading && rows.length === 0 && (
                    <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-foreground/55">
                        <Loader2 className="size-4 animate-spin" /> Loading…
                    </div>
                )}
                {hasMore && rows.length > 0 && (
                    <div className="flex items-center justify-center py-3 text-[12px] text-foreground/45">
                        {loading ? <Loader2 className="size-3.5 animate-spin" /> : "Loading more on scroll…"}
                    </div>
                )}
            </div>
        </div>
    )
}

function LogRow({ row, expanded, onToggle, onMeasure }: {
    row: RequestLogRow
    expanded: boolean
    onToggle: () => void
    onMeasure: (node: HTMLElement | null) => void
}) {
    return (
        <div className={cn("border-b border-border/50", expanded && "bg-muted/30")}>
            <button
                data-request-id={row.id}
                onClick={onToggle}
                className="flex w-full flex-col gap-2 px-3 py-3 text-left text-[13px] transition-colors hover:bg-muted/50 md:hidden"
            >
                <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                            <ChevronRight className={cn("size-3.5 shrink-0 text-foreground/40", expanded && "rotate-90")} />
                            <ProviderDot providerId={row.provider} />
                            <span className="truncate font-medium text-foreground">{row.model}</span>
                        </div>
                        <div className="mt-0.5 truncate text-[11.5px] text-foreground/45">
                            {(row.profileName ?? row.profileId ?? "Horia")} · {row.agentId}
                        </div>
                    </div>
                    <StatusPill status={row.status} />
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] tabular-nums text-foreground/55">
                    <span>{formatTime(row.startedAt)}</span>
                    <span>{relativeTime(row.startedAt)}</span>
                    <span>{formatTokens(row.totalTokens)} tokens</span>
                    <span>{formatDuration(row.durationMs)}</span>
                </div>
            </button>
            <button
                data-request-id={row.id}
                onClick={onToggle}
                className={cn(
                    "hidden h-[56px] w-full grid-cols-[24px_140px_110px_110px_minmax(0,1fr)_90px_90px_120px_24px] items-center gap-3 px-3 py-2 text-left text-[13px] transition-colors md:grid",
                    "hover:bg-muted/50"
                )}
            >
                <ChevronRight className={cn("size-3.5 text-foreground/40", expanded && "rotate-90")} />
                <div className="min-w-0">
                    <div className="truncate text-foreground tabular-nums">{formatTime(row.startedAt)}</div>
                    <div className="truncate text-[11.5px] text-foreground/45 tabular-nums">{relativeTime(row.startedAt)}</div>
                </div>
                <div className="truncate text-foreground/80">{row.profileName ?? row.profileId ?? "Horia"}</div>
                <div className="truncate text-foreground/80">{row.agentId}</div>
                <div className="flex min-w-0 items-center gap-1.5">
                    <ProviderDot providerId={row.provider} />
                    <span className="truncate text-foreground">{row.model}</span>
                </div>
                <div className="text-right tabular-nums text-foreground/70">{formatTokens(row.totalTokens)}</div>
                <div className="text-right tabular-nums text-foreground/70">{formatDuration(row.durationMs)}</div>
                <StatusPill status={row.status} />
                <div />
            </button>

            {expanded && <ExpandedDetail key={row.id} requestId={row.id} row={row} onMeasure={onMeasure} />}
        </div>
    )
}

function ExpandedDetail({ requestId, row, onMeasure }: {
    requestId: string
    row: RequestLogRow
    onMeasure: (node: HTMLElement | null) => void
}) {
    const { data, loading, error } = useRequestDetail(requestId, { live: row.status === "streaming" })
    const rootRef = React.useRef<HTMLDivElement>(null)
    const waitingForFirstDetail = loading || (data === null && error === null)

    // The detail lives in an absolutely-positioned virtualized row whose growth a
    // ResizeObserver doesn't report, so re-measure the row from here on every
    // height change that matters: opening, loading state, loaded details, and
    // unmount (collapse, via the cleanup). `onMeasure` walks up to the row
    // wrapper and writes its real height into the virtualizer.
    React.useLayoutEffect(() => {
        const wrapper = rootRef.current?.closest<HTMLElement>("[data-index]") ?? null
        if (wrapper) onMeasure(wrapper)
        return () => {
            if (wrapper) onMeasure(wrapper)
        }
    }, [waitingForFirstDetail, data, error, onMeasure])

    return (
        <div ref={rootRef} className="border-t border-border/50">
            <div className="max-h-[55vh] overflow-y-auto overscroll-contain animate-in fade-in-0 duration-200">
            <div className="flex flex-col gap-4 px-3 py-3 md:px-4 md:py-4">
            <LogChatTranscript
                row={data?.log ?? row}
                transcript={data?.transcript ?? null}
                toolLogs={data?.toolLogs ?? null}
                error={error}
            />

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <div className="flex flex-col gap-3">
                    <h4 className="text-[11px] font-medium uppercase tracking-wider text-foreground/50">Tokens</h4>
                    <div className="grid grid-cols-2 gap-2">
                        <Stat label="Input" value={row.inputTokens} />
                        <Stat label="Output" value={row.outputTokens} />
                        <Stat label="Thinking" value={row.thinkingTokens} />
                        <Stat label="Cached" value={row.cachedTokens} highlight={row.cachedTokens !== null && row.cachedTokens > 0} />
                        <Stat label="Tool use" value={row.toolUseTokens} />
                        <Stat label="Total" value={row.totalTokens} />
                    </div>

                    {row.modalityBreakdown && (
                        <div className="mt-1">
                            <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-foreground/50">Modality</h4>
                            <div className="space-y-1 text-[12px] tabular-nums text-foreground/70">
                                {row.modalityBreakdown.input?.map(m => (
                                    <div key={"in-" + m.modality}>input {m.modality}: {m.tokens.toLocaleString()}</div>
                                ))}
                                {row.modalityBreakdown.output?.map(m => (
                                    <div key={"out-" + m.modality}>output {m.modality}: {m.tokens.toLocaleString()}</div>
                                ))}
                            </div>
                        </div>
                    )}

                    {row.billingBreakdown && row.billingBreakdown.length > 0 && (
                        <div className="mt-1">
                            <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-foreground/50">Billing models</h4>
                            <div className="space-y-1 text-[12px] text-foreground/70">
                                {row.billingBreakdown.map((entry) => (
                                    <div key={`${entry.provider}:${entry.model}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                                        <span className="min-w-0 truncate">{entry.provider} · {entry.model}</span>
                                        <span className="tabular-nums">{entry.totalTokens.toLocaleString()} tok · {entry.requests.toLocaleString()} req</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex flex-col gap-3">
                    <h4 className="text-[11px] font-medium uppercase tracking-wider text-foreground/50">Request</h4>
                    <dl className="grid grid-cols-1 gap-x-3 gap-y-1.5 text-[12.5px] sm:grid-cols-[120px_minmax(0,1fr)]">
                        <Row label="ID" value={<code className="rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums">{row.id}</code>} />
                        <Row label="Profile" value={row.profileName ?? row.profileId ?? "Horia"} />
                        <Row label="Conversation" value={<code className="rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums">{row.conversationId}</code>} />
                        <Row label="Provider" value={`${row.provider}`} />
                        <Row label="Thinking" value={row.thinkingLevel} />
                        <Row label="Mode" value={row.statefulMode ? "Stateful" : "Stateless"} />
                        <Row label="Tool calls" value={data?.toolLogs.length ?? row.toolCallCount} />
                        {row.interactionId && <Row label="Interaction" value={<code className="rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums">{row.interactionId}</code>} />}
                        {row.errorMessage && <Row label="Error" value={<span className="text-destructive">{row.errorMessage}</span>} />}
                    </dl>
                </div>
            </div>

            <LogFullInput requestId={requestId} hasInput={data?.hasInput ?? false} />
            </div>
            </div>
        </div>
    )
}

function LogFullInput({ requestId, hasInput }: { requestId: string; hasInput: boolean }) {
    const [open, setOpen] = React.useState(false)
    const { input, loading, error } = useRequestInput(requestId, open && hasInput)
    if (!hasInput) return null

    const count = input ? (input.systemPrompt ? 1 : 0) + input.messages.length : 0
    return (
        <div className="flex flex-col gap-2">
            <button
                onClick={() => setOpen(o => !o)}
                className="flex w-fit items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-foreground/50 transition-colors hover:text-foreground/75"
            >
                <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
                Exact model input {count > 0 ? `(${count})` : ""}
            </button>
            {open && (
                <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-background/50 p-3 animate-in fade-in-0 duration-200">
                    <p className="text-[11.5px] leading-relaxed text-foreground/45">
                        The full payload sent to the provider — system prompt and every message with recalled
                        memories, runtime and attachment context already inlined.
                    </p>
                    {loading && (
                        <div className="flex items-center gap-2 text-[12px] text-foreground/50">
                            <Loader2 className="size-3.5 animate-spin" />
                            Loading exact input…
                        </div>
                    )}
                    {error && <p className="text-[12px] text-destructive">{error}</p>}
                    {!loading && !error && !input && (
                        <p className="text-[12px] text-foreground/50">Exact input is unavailable.</p>
                    )}
                    {input && input.tools.length > 0 && (
                        <div>
                            <div className="mb-1 text-[10.5px] uppercase tracking-wider text-foreground/45">
                                Tools exposed ({input.tools.length})
                            </div>
                            <div className="flex flex-wrap gap-1">
                                {input.tools.map(t => (
                                    <code key={t} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px]">{t}</code>
                                ))}
                            </div>
                        </div>
                    )}
                    {input?.systemPrompt && <InputBlock label="System prompt" content={input.systemPrompt} />}
                    {input?.messages.map((m, i) => (
                        <InputBlock key={i} label={m.role} content={m.content} attachments={m.attachments} />
                    ))}
                </div>
            )}
        </div>
    )
}

function InputBlock({ label, content, attachments }: {
    label: string
    content: string
    attachments?: Array<{ filePath?: string; mimeType?: string }>
}) {
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-wider text-foreground/45">
                <span>{label}</span>
                {attachments?.length ? (
                    <span className="normal-case text-foreground/35">· {attachments.length} attachment{attachments.length === 1 ? "" : "s"}</span>
                ) : null}
            </div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2.5 text-[11.5px] leading-relaxed text-foreground/80">{content || "—"}</pre>
            {attachments?.length ? (
                <div className="flex flex-col gap-0.5 text-[10.5px] text-foreground/40">
                    {attachments.map((a, i) => (
                        <span key={i} className="truncate">{a.mimeType ?? "file"}{a.filePath ? ` · ${a.filePath}` : ""}</span>
                    ))}
                </div>
            ) : null}
        </div>
    )
}

function LogChatTranscript({
    row,
    transcript,
    toolLogs,
    error,
}: {
    row: RequestLogRow
    transcript: RequestLogTranscript | null
    toolLogs: ToolLogRow[] | null
    error: string | null
}) {
    const userMessage = transcript?.userMessage ?? fallbackUserMessage(row)
    const assistantMessage = buildLogAssistantMessage(row, transcript?.assistantMessage ?? null, toolLogs)
    const loadToolCallDetails = React.useCallback(async (_messageId: string, toolCallId: string) => {
        const res = await fetch(
            `/api/logs/${encodeURIComponent(row.id)}?toolCallId=${encodeURIComponent(toolCallId)}`,
            { cache: "no-store" }
        )
        if (!res.ok) throw new Error(`Failed (${res.status})`)
        const payload = (await res.json()) as { toolCall?: ToolCallReasoningEntry }
        if (!payload.toolCall) throw new Error("Missing tool call")
        return payload.toolCall
    }, [row.id])

    return (
        <ConversationArtifactsProvider conversationId={row.conversationId}>
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-1 py-2">
                {error && !assistantMessage.content && !hasReasoning(assistantMessage) && (
                    <div className="text-[13px] text-destructive">{error}</div>
                )}
                {userMessage && (
                    <MessageBubble
                        message={userMessage}
                        conversationId={row.conversationId}
                        compact
                    />
                )}
                <MessageBubble
                    message={assistantMessage}
                    conversationId={row.conversationId}
                    compact
                    isLatestAssistantMessage
                    isStreamingMessage={row.status === "streaming"}
                    onLoadToolCallDetails={loadToolCallDetails}
                />
            </div>
        </ConversationArtifactsProvider>
    )
}

function buildLogAssistantMessage(
    row: RequestLogRow,
    source: Message | null,
    toolLogs: ToolLogRow[] | null
): Message {
    const base = ensureRenderableLogContent(source ?? {
        id: row.id,
        role: "assistant",
        content: row.outputText ?? "",
        status: row.status === "streaming" ? undefined : row.status,
        timestamp: row.endedAt ?? row.startedAt,
    })

    return withMissingToolLogReasoning(base, toolLogs)
}

function ensureRenderableLogContent(message: Message): Message {
    const hasRenderableSegment = message.contentSegments?.some(segment => segment.content.trim().length > 0)
    if (!message.content.trim() || hasRenderableSegment) return message

    return {
        ...message,
        contentSegments: [
            {
                phase: finalContentPhase(message.reasoning),
                content: message.content,
            },
        ],
    }
}

function finalContentPhase(reasoning: Message["reasoning"]): number {
    if (!reasoning?.length) return 0
    return Math.max(...reasoning.map(entry => Number.isFinite(entry.phase) ? entry.phase : 0)) + 1
}

function fallbackUserMessage(row: RequestLogRow): Message | null {
    if (!row.inputText) return null
    return {
        id: `${row.id}:input`,
        role: "user",
        content: row.inputText,
        timestamp: row.startedAt,
    }
}

function hasReasoning(message: Message): boolean {
    return Array.isArray(message.reasoning) && message.reasoning.length > 0
}

function Stat({ label, value, highlight }: { label: string; value: number | null; highlight?: boolean }) {
    return (
        <div className={cn("rounded-lg border border-border/60 bg-background px-2.5 py-1.5", highlight && "border-amber-500/40 bg-amber-500/5")}>
            <div className="text-[10.5px] uppercase tracking-wider text-foreground/50">{label}</div>
            <div className="text-[13px] font-semibold tabular-nums text-foreground">{value !== null ? value.toLocaleString() : "—"}</div>
        </div>
    )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <>
            <dt className="text-foreground/50">{label}</dt>
            <dd className="min-w-0 break-words text-foreground/85">{value}</dd>
        </>
    )
}

function StatusPill({ status }: { status: RequestStatus }) {
    const cls = status === "ok"
        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : status === "error"
            ? "bg-destructive/10 text-destructive"
            : status === "aborted"
                ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "bg-blue-500/10 text-blue-700 dark:text-blue-400"
    const Icon = status === "ok" ? CheckCircle2 : status === "error" ? XCircle : status === "aborted" ? Ban : Loader2
    return (
        <span className={cn("inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", cls)}>
            <Icon className={cn("size-3", status === "streaming" && "animate-spin")} />
            {STATUS_LABELS[status]}
        </span>
    )
}

function ProviderDot({ providerId }: { providerId: string }) {
    const color =
        providerId === "google" ? "bg-blue-500"
            : providerId === "anthropic" ? "bg-orange-500"
                : providerId === "openai" ? "bg-emerald-500"
                    : "bg-foreground/40"
    return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", color)} aria-hidden />
}

function ConfirmDialog({ title, description, confirmLabel, onConfirm, onCancel }: {
    title: string
    description: string
    confirmLabel: string
    onConfirm: () => void | Promise<void>
    onCancel: () => void
}) {
    const [busy, setBusy] = React.useState(false)
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 backdrop-blur-sm" onClick={onCancel}>
            <div
                className="w-[min(calc(100vw-2rem),400px)] rounded-2xl border border-border/70 bg-card p-5 shadow-xl"
                onClick={e => e.stopPropagation()}
            >
                <h3 className="text-[16px] font-semibold text-foreground">{title}</h3>
                <p className="mt-1.5 text-[13.5px] text-foreground/65">{description}</p>
                <div className="mt-4 flex justify-end gap-2">
                    <button
                        onClick={onCancel}
                        className="h-8 rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-foreground/70 transition-colors hover:bg-muted/60"
                    >
                        Cancel
                    </button>
                    <button
                        disabled={busy}
                        onClick={async () => {
                            setBusy(true)
                            try { await onConfirm() } finally { setBusy(false) }
                        }}
                        className="h-8 rounded-lg bg-destructive px-3 text-[13px] font-medium text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                        {busy ? "Working…" : confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    )
}

function ErrorBanner({ message }: { message: string }) {
    return (
        <div className="flex items-start gap-2.5 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p>{message}</p>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTokens(n: number | null): string {
    if (n === null || n === 0) return "—"
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return n.toLocaleString()
}

function formatDuration(ms: number | null): string {
    if (ms === null) return "—"
    if (ms < 1000) return `${ms} ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
    const m = Math.floor(ms / 60_000)
    const s = Math.floor((ms % 60_000) / 1000)
    return `${m}m ${s}s`
}

function formatTime(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function relativeTime(ms: number): string {
    const diff = Date.now() - ms
    if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return `${Math.floor(diff / 86_400_000)}d ago`
}
