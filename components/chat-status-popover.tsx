"use client"

import * as React from "react"
import {
    AlertCircle,
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Loader2,
} from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import {
    quotaPaceLabel,
    formatCompactDuration,
    formatResetCountdown,
    FIVE_HOUR_SECONDS,
    WEEKLY_SECONDS,
} from "@/lib/cli/quota-pace"
import type {
    Attachment,
    ContextUsageBreakdown,
    ContextUsageBreakdownEntry,
    ContextUsageCategoryId,
    ContextUsageSnapshot,
    Message,
} from "@/lib/types"
import {
    estimateAttachmentTokens,
    estimateCharCountTokens,
    estimateTextTokens,
} from "@/lib/ai/context-token-estimate"

type ChatStatusSource = "globalDefault" | "agentDefault" | "agentOverride"

interface ChatStatusResponse {
    chat: {
        agent: {
            id: string
            name: string
        }
        provider: {
            id: string
            name: string
            requiresApiKey: boolean
        }
        model: {
            id: string
            name: string
            contextWindow?: number
            maxOutputTokens?: number
            pricingKind: "tokens" | "subscription" | "unknown"
            dataCompleteness?: string
        } | null
        thinkingLevel: string
        source: ChatStatusSource
        available: boolean
        unavailableReason: string | null
    }
    canViewCliQuotas?: boolean
    /** Estimated orchestrator system prompt size, in tokens. Null when unavailable. */
    systemPromptTokens?: number | null
    contextBreakdown?: ContextUsageBreakdown | null
}

interface CliQuotaWindow {
    usedPercent: number
    resetsAt: number
    windowSeconds?: number
}

interface CliResetCredits {
    availableCount: number
    /** Available credits, soonest expiry first; expiresAt in unix seconds (0 = unknown). */
    credits: Array<{ expiresAt: number; title?: string }>
}

interface CliQuotaSnapshot {
    cliId: "claude-code" | "codex"
    available: boolean
    error?: string
    fiveHour?: CliQuotaWindow
    weekly?: CliQuotaWindow
    weeklySonnet?: CliQuotaWindow
    resetCredits?: CliResetCredits
    source: "app-server" | "api" | "host-bridge" | "log" | "tui" | "none"
    fetchedAt: number
    dataTimestamp?: number
}

type CliQuotaMap = Record<string, CliQuotaSnapshot>
type CliProviderId = "claude-code" | "codex"

type DraftAttachment = {
    file?: File
    uploaded?: Attachment
    type: string
}

interface ChatStatusPopoverProps {
    messages: Message[]
    draftValue: string
    attachments: DraftAttachment[]
    contextUsage?: ContextUsageSnapshot
    conversationId?: string | null
    side?: React.ComponentProps<typeof PopoverContent>["side"]
}

// Fallback base context when the status endpoint can't measure the real
// system prompt (provider has no capabilities entry, build error, etc.).
const BASE_CHAT_OVERHEAD_TOKENS = 1200

const CLI_LABELS: Record<CliProviderId, string> = {
    "claude-code": "Claude Code",
    codex: "Codex CLI",
}

function isCliProvider(providerId: string | undefined): providerId is CliProviderId {
    return providerId === "claude-code" || providerId === "codex"
}

export function ChatStatusPopover({ messages, draftValue, attachments, contextUsage, conversationId, side = "top" }: ChatStatusPopoverProps) {
    const [open, setOpen] = React.useState(false)
    const isMobile = useIsMobile()
    const status = useChatStatus(conversationId)
    const activeCliId = isCliProvider(status.data?.chat.provider.id)
        ? status.data.chat.provider.id
        : null
    const canViewCliQuotas = Boolean(status.data?.canViewCliQuotas)
    const quotas = useLazyCliUsage(
        open && canViewCliQuotas && activeCliId !== null && Boolean(status.data?.chat.available),
        activeCliId
    )
    const systemPromptTokens = status.data?.systemPromptTokens ?? null
    const contextEstimate = React.useMemo(
        () => estimateContextTokens(
            messages,
            draftValue,
            attachments,
            systemPromptTokens,
            status.data?.contextBreakdown ?? null
        ),
        [attachments, draftValue, messages, status.data?.contextBreakdown, systemPromptTokens]
    )

    const contextDisplay = buildContextDisplay({
        chat: status.data,
        contextEstimate,
        contextUsage,
        draftValue,
        attachments,
    })
    const contextPct = contextDisplay.pct
    const chat = status.data?.chat
    const model = chat?.model
    const modelReady = Boolean(model && chat?.available)
    const unavailableReason = chat?.unavailableReason ?? "Configure a provider in Settings before sending messages."

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                    aria-label="Chat status"
                    title={modelReady ? "Status" : "No model loaded"}
                >
                    <ContextRing pct={contextPct} />
                </button>
            </PopoverTrigger>

            <PopoverContent
                side={side}
                align={isMobile ? "center" : "end"}
                sideOffset={isMobile ? 8 : 10}
                collisionPadding={isMobile ? 12 : undefined}
                className={cn(
                    "z-[120] max-h-[calc(var(--radix-popover-content-available-height)-8px)] overflow-y-auto rounded-lg p-0",
                    // Mobile: span the collision-safe width so the symmetric 12px
                    // gutters Radix reserves on both sides are actually even —
                    // anchoring a near-edge trigger with align="end" otherwise
                    // leaves a lopsided 9px/33px gap. Desktop keeps its compact
                    // 360px panel near the trigger (unchanged).
                    isMobile
                        ? "w-[var(--radix-popover-content-available-width)]"
                        : "w-[min(360px,calc(100vw-24px))]"
                )}
            >
                <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
                    <div className="min-w-0">
                        <div className="truncate text-[15px] font-semibold text-foreground" title={modelReady ? model?.name : undefined}>
                            {modelReady ? model?.name : "No model loaded"}
                        </div>
                        <div className="mt-0.5 truncate text-[12.5px] text-foreground/50">
                            {modelReady && chat
                                ? `${chat.provider.name} / ${model?.id ?? "unknown"} · ${formatSource(chat.source)}`
                                : status.loading ? "Loading model" : unavailableReason}
                        </div>
                    </div>
                    {status.loading ? (
                        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : status.error ? (
                        <AlertCircle className="size-4 shrink-0 text-destructive" />
                    ) : !modelReady ? (
                        <AlertCircle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    ) : (
                        <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    )}
                </div>

                <div className="px-4 py-3">
                    {status.error ? (
                        <InlineNotice tone="danger">{status.error}</InlineNotice>
                    ) : !modelReady ? (
                        <InlineNotice tone="danger">{unavailableReason}</InlineNotice>
                    ) : (
                        <>
                            <ContextWindowSection display={contextDisplay} />
                            {activeCliId && canViewCliQuotas && <PlanUsageSection cliId={activeCliId} quotas={quotas} />}
                        </>
                    )}
                </div>
            </PopoverContent>
        </Popover>
    )
}

function ContextRing({ pct }: { pct: number | null }) {
    const value = pct == null ? 0 : Math.max(0, Math.min(100, pct))
    const r = 15
    const circumference = 2 * Math.PI * r
    const dash = (value / 100) * circumference
    const arcColor =
        value >= 90
            ? "stroke-red-500"
            : value >= 70
                ? "stroke-amber-500"
                : "stroke-blue-500"

    return (
        <svg
            viewBox="0 0 36 36"
            className="size-[18px] -rotate-90"
            fill="none"
            aria-hidden="true"
        >
            <circle
                cx="18"
                cy="18"
                r={r}
                strokeWidth="4.5"
                className="stroke-foreground/15"
            />
            {value > 0 && (
                <circle
                    cx="18"
                    cy="18"
                    r={r}
                    strokeWidth="4.5"
                    strokeLinecap="round"
                    strokeDasharray={`${dash} ${circumference - dash}`}
                    className={cn("transition-all duration-500", arcColor)}
                />
            )}
        </svg>
    )
}

function PlanUsageSection({
    cliId,
    quotas,
}: {
    cliId: CliProviderId
    quotas: ReturnType<typeof useLazyCliUsage>
}) {
    const snapshot = quotas.data?.[cliId]

    return (
        <section className="mt-3 border-t border-border/60 pt-3">
            <div className="mb-2.5 flex items-center justify-between gap-3">
                <div className="text-[13px] font-medium text-foreground/60">Plan usage</div>
                {quotas.loading ? (
                    <Loader2 className="size-4 animate-spin text-foreground/40" />
                ) : (
                    <ChevronRight className="size-4 text-foreground/45" />
                )}
            </div>

            {quotas.error ? (
                <InlineNotice tone="danger">{quotas.error}</InlineNotice>
            ) : !quotas.data && quotas.loading ? (
                <div className="space-y-3">
                    <SkeletonMetric />
                    <SkeletonMetric />
                </div>
            ) : !snapshot ? (
                <div className="text-[12.5px] text-foreground/50">No usage data for {CLI_LABELS[cliId]} yet.</div>
            ) : !snapshot.available ? (
                <InlineNotice tone="danger">{snapshot.error ?? `No usage data for ${CLI_LABELS[cliId]}.`}</InlineNotice>
            ) : (
                <div className="space-y-3">
                    <MetricRow
                        label="5-hour limit"
                        value={formatQuotaValue(snapshot.fiveHour)}
                        progress={snapshot.fiveHour?.usedPercent ?? 0}
                        tone="context"
                        caption={<PaceCaption window={snapshot.fiveHour} fallbackWindowSeconds={FIVE_HOUR_SECONDS} />}
                    />
                    <MetricRow
                        label="Weekly · all models"
                        value={formatQuotaValue(snapshot.weekly)}
                        progress={snapshot.weekly?.usedPercent ?? 0}
                        tone="weekly"
                        caption={<PaceCaption window={snapshot.weekly} fallbackWindowSeconds={WEEKLY_SECONDS} />}
                    />
                    {snapshot.weeklySonnet && (
                        <MetricRow
                            label="Weekly · Sonnet"
                            value={formatQuotaValue(snapshot.weeklySonnet)}
                            progress={snapshot.weeklySonnet.usedPercent}
                            tone="sonnet"
                            caption={<PaceCaption window={snapshot.weeklySonnet} fallbackWindowSeconds={WEEKLY_SECONDS} />}
                        />
                    )}
                    {snapshot.resetCredits && <ResetCreditsRow resetCredits={snapshot.resetCredits} />}
                </div>
            )}
        </section>
    )
}

/** Codex "Resets": available count + soonest expiry, one compact row. */
function ResetCreditsRow({ resetCredits }: { resetCredits: CliResetCredits }) {
    return (
        <div className="flex items-center justify-between gap-3 text-[13px]">
            <div className="min-w-0 truncate font-medium text-foreground/70">Resets</div>
            <div className="shrink-0 tabular-nums text-foreground/55">{formatResetCreditsSummary(resetCredits)}</div>
        </div>
    )
}

/** Reads the clock internally so render paths stay pure (same pattern as quotaPaceLabel). */
function formatResetCreditsSummary(
    resetCredits: CliResetCredits,
    nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
    const soonest = resetCredits.credits.find(c => c.expiresAt > nowSeconds)
    const expiry = soonest ? ` · first expires in ${formatCompactDuration(soonest.expiresAt - nowSeconds)}` : ""
    return `${resetCredits.availableCount} available${expiry}`
}

function MetricRow({
    label,
    value,
    progress,
    tone,
    trailing,
    caption,
}: {
    label: string
    value: string
    progress: number
    tone: "context" | "weekly" | "sonnet"
    trailing?: React.ReactNode
    caption?: React.ReactNode
}) {
    const pct = Math.max(0, Math.min(100, progress))
    const barColor =
        tone === "weekly"
            ? "bg-[#8a7a16]"
            : tone === "sonnet"
                ? "bg-emerald-500"
                : "bg-blue-500"

    return (
        <div>
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 truncate text-[13px] font-medium text-foreground/70">{label}</div>
                <div className="flex shrink-0 items-center gap-1.5 text-[13px] tabular-nums text-foreground/55">
                    <span>{value}</span>
                    {trailing}
                </div>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted/80 ring-1 ring-inset ring-border/30">
                <div
                    className={cn("h-full rounded-full transition-all", barColor)}
                    style={{ width: `${pct}%` }}
                />
            </div>
            {caption}
        </div>
    )
}

function PaceCaption({ window: w, fallbackWindowSeconds }: {
    window: CliQuotaWindow | undefined
    fallbackWindowSeconds: number
}) {
    if (!w) return null
    const label = quotaPaceLabel(w, fallbackWindowSeconds)
    if (!label) return null
    const cls =
        label.tone === "danger" ? "text-destructive"
            : label.tone === "warn" ? "text-amber-600 dark:text-amber-400"
                : "text-foreground/50"
    const showIcon = label.tone === "danger" || label.tone === "warn"
    return (
        <div className={cn("mt-1.5 flex items-center gap-1 text-[11.5px] tabular-nums", cls)}>
            {showIcon && <AlertTriangle className="size-3 shrink-0" />}
            <span>{label.text}</span>
        </div>
    )
}

function SkeletonMetric() {
    return (
        <div>
            <div className="flex items-center justify-between gap-3">
                <div className="h-4 w-28 animate-pulse rounded bg-muted/70" />
                <div className="h-4 w-20 animate-pulse rounded bg-muted/70" />
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted/70">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-muted-foreground/20" />
            </div>
        </div>
    )
}

function formatQuotaValue(window: CliQuotaWindow | undefined): string {
    if (!window) return "-"
    return `${formatPercent(window.usedPercent)} · ${formatResetCountdown(window.resetsAt)}`
}

function formatPercent(value: number): string {
    if (!Number.isFinite(value)) return "-"
    const pct = Math.max(0, Math.min(100, value))
    if (pct > 0 && pct < 1) return "<1%"
    return `${Math.round(pct)}%`
}

function InlineNotice({ tone, children }: { tone: "danger"; children: React.ReactNode }) {
    return (
        <div
            className={cn(
                "flex items-start gap-2 rounded-md border px-2.5 py-2 text-[12px] leading-snug",
                tone === "danger" && "border-destructive/30 bg-destructive/5 text-destructive"
            )}
        >
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <div>{children}</div>
        </div>
    )
}

function useChatStatus(conversationId?: string | null) {
    const [data, setData] = React.useState<ChatStatusResponse | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)

    React.useEffect(() => {
        const controller = new AbortController()
        setLoading(true)

        const query = conversationId
            ? `?conversationId=${encodeURIComponent(conversationId)}`
            : ""
        fetch(`/api/chat/status${query}`, { cache: "no-store", signal: controller.signal })
            .then(async res => {
                if (!res.ok) throw new Error(`Failed to load status (${res.status})`)
                return (await res.json()) as ChatStatusResponse
            })
            .then(json => {
                setData(json)
                setError(null)
            })
            .catch(err => {
                if (controller.signal.aborted) return
                setError(err instanceof Error ? err.message : "Unknown status error")
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false)
            })

        return () => controller.abort()
    }, [conversationId])

    return { data, loading, error }
}

function useLazyCliUsage(enabled: boolean, cliId: CliProviderId | null) {
    const [data, setData] = React.useState<CliQuotaMap | null>(null)
    const [loading, setLoading] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const reqId = React.useRef(0)

    const refresh = React.useCallback(async () => {
        if (!cliId) return
        const myReq = ++reqId.current
        const controller = new AbortController()
        const timer = window.setTimeout(() => controller.abort(), 15_000)
        setLoading(true)
        try {
            const res = await fetch(`/api/cli/usage?cli=${encodeURIComponent(cliId)}`, {
                cache: "no-store",
                signal: controller.signal,
            })
            if (!res.ok) throw new Error(`Failed to load CLI quotas (${res.status})`)
            const json = (await res.json()) as CliQuotaMap
            if (myReq !== reqId.current) return
            setData(json)
            setError(null)
        } catch (err) {
            if (myReq !== reqId.current) return
            const message = err instanceof DOMException && err.name === "AbortError"
                ? `Timed out loading ${CLI_LABELS[cliId]} usage.`
                : err instanceof Error ? err.message : "Unknown quota error"
            setError(message)
        } finally {
            window.clearTimeout(timer)
            if (myReq === reqId.current) setLoading(false)
        }
    }, [cliId])

    React.useEffect(() => {
        if (!enabled) return
        setData(null)
        setError(null)
    }, [cliId, enabled])

    React.useEffect(() => {
        if (!enabled || data || loading) return
        void refresh()
    }, [data, enabled, loading, refresh])

    return { data, loading, error, refresh }
}

interface ContextDisplay {
    tokens: number
    contextWindow: number | null
    pct: number | null
    source: string
    usage: ContextUsageSnapshot | null
    draftTokens: number
    breakdown: ContextUsageBreakdown | null
}

function buildContextDisplay(args: {
    chat: ChatStatusResponse | null
    contextEstimate: ReturnType<typeof estimateContextTokens>
    contextUsage?: ContextUsageSnapshot
    draftValue: string
    attachments: DraftAttachment[]
}): ContextDisplay {
    const chat = args.chat?.chat
    const modelId = chat?.model?.id
    const usage = args.contextUsage
    const usageMatches = Boolean(
        usage &&
        usage.provider === chat?.provider.id &&
        (!usage.model || !modelId || usage.model === modelId)
    )
    const realTokens = usageMatches
        ? finiteNumber(usage?.contextTokens) ?? finiteNumber(usage?.inputTokens)
        : null
    const cachedTokens = usageMatches ? finiteNumber(usage?.cachedTokens) : null
    const draftBreakdown = realTokens !== null
        ? estimateDraftBreakdown(args.draftValue, args.attachments)
        : { messageTokens: 0, attachmentTokens: 0, totalTokens: 0 }
    const draftTokens = draftBreakdown.totalTokens
    const tokens = realTokens !== null
        ? realTokens + draftTokens
        : args.contextEstimate.tokens
    const contextWindow = finiteNumber(usageMatches ? usage?.contextWindow : null)
        ?? finiteNumber(chat?.model?.contextWindow)
    const pct = contextWindow
        ? Math.max(0, Math.min(100, (tokens / contextWindow) * 100))
        : null
    const source = realTokens !== null
        ? `${usage?.accuracy === "live" ? "Live provider input" : "Actual provider input"}${cachedTokens && cachedTokens > 0 ? " (cache included)" : ""}${draftTokens > 0 ? " + draft estimate" : ""}`
        : "Local estimate"
    const baseBreakdown = usageMatches && usage?.contextBreakdown
        ? cloneBreakdown(usage.contextBreakdown)
        : cloneBreakdown(args.contextEstimate.breakdown)
    if (baseBreakdown && draftTokens > 0) {
        addBreakdownTokens(baseBreakdown.categories, "messages", draftBreakdown.messageTokens)
        addBreakdownTokens(baseBreakdown.categories, "attachments", draftBreakdown.attachmentTokens)
    }
    const breakdown = baseBreakdown
        ? reconcileDisplayBreakdown(baseBreakdown, tokens)
        : null

    return {
        tokens,
        contextWindow,
        pct,
        source,
        usage: realTokens !== null ? usage ?? null : null,
        draftTokens,
        breakdown,
    }
}

const CONTEXT_COLORS: Record<ContextUsageCategoryId, string> = {
    messages: "bg-blue-600",
    skills: "bg-blue-500",
    tools: "bg-blue-400",
    system: "bg-sky-400",
    memory: "bg-sky-300",
    agents: "bg-indigo-300",
    attachments: "bg-cyan-300",
    provider: "bg-violet-400",
}

function ContextWindowSection({ display }: { display: ContextDisplay }) {
    const categories = display.breakdown?.categories ?? []
    const deferred = display.breakdown?.deferred ?? []
    const freeTokens = display.contextWindow
        ? Math.max(0, display.contextWindow - display.tokens)
        : null
    const value = display.contextWindow
        ? `${formatTokens(display.tokens)} / ${formatTokens(display.contextWindow)} (${formatPercent(display.pct ?? 0)})`
        : `${formatTokens(display.tokens)} / unknown`

    return (
        <details className="group/context">
            <summary className="cursor-pointer list-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 truncate text-[13px] font-medium text-foreground/70">Context window</div>
                    <div className="flex shrink-0 items-center gap-1.5 text-[13px] tabular-nums text-foreground/55">
                        <span>{value}</span>
                        <ChevronDown className="size-4 -rotate-90 text-foreground/45 transition-transform group-open/context:rotate-0" />
                    </div>
                </div>
                <ContextSegmentBar
                    categories={categories}
                    tokens={display.tokens}
                    contextWindow={display.contextWindow}
                />
            </summary>

            <div className="mt-3 border-t border-border/60 pt-2.5">
                <div className="space-y-1.5">
                    {categories.map((item) => (
                        <ContextBreakdownRow
                            key={item.id}
                            item={item}
                            contextWindow={display.contextWindow}
                        />
                    ))}
                    {freeTokens !== null && (
                        <ContextBreakdownRow
                            item={{ id: "system", label: "Free space", tokens: freeTokens }}
                            contextWindow={display.contextWindow}
                            colorClass="bg-foreground/10"
                        />
                    )}
                </div>

                {deferred.length > 0 && (
                    <div className="mt-2.5 space-y-1.5 border-t border-border/50 pt-2.5">
                        {deferred.map((item) => (
                            <ContextBreakdownRow
                                key={`deferred-${item.id}`}
                                item={{ ...item, label: `${item.label} (deferred)` }}
                                contextWindow={null}
                                colorClass="bg-foreground/15"
                                deferred
                            />
                        ))}
                    </div>
                )}

                <ContextUsageDetails display={display} />
            </div>
        </details>
    )
}

function ContextSegmentBar({
    categories,
    tokens,
    contextWindow,
}: {
    categories: ContextUsageBreakdownEntry[]
    tokens: number
    contextWindow: number | null
}) {
    const denominator = contextWindow && contextWindow > 0
        ? contextWindow
        : Math.max(tokens, 1)
    const used = categories.reduce((total, item) => total + item.tokens, 0)
    const free = contextWindow ? Math.max(0, contextWindow - used) : 0

    return (
        <div
            className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted/80 ring-1 ring-inset ring-border/30"
            aria-hidden="true"
        >
            {categories.map((item) => (
                <div
                    key={item.id}
                    className={cn("h-full min-w-px transition-[width]", CONTEXT_COLORS[item.id])}
                    style={{ width: `${Math.max(0, (item.tokens / denominator) * 100)}%` }}
                    title={`${item.label}: ${formatTokens(item.tokens)}`}
                />
            ))}
            {free > 0 && (
                <div
                    className="h-full bg-foreground/8"
                    style={{ width: `${(free / denominator) * 100}%` }}
                    title={`Free space: ${formatTokens(free)}`}
                />
            )}
        </div>
    )
}

function ContextBreakdownRow({
    item,
    contextWindow,
    colorClass,
    deferred = false,
}: {
    item: ContextUsageBreakdownEntry
    contextWindow: number | null
    colorClass?: string
    deferred?: boolean
}) {
    const pct = contextWindow && contextWindow > 0
        ? (item.tokens / contextWindow) * 100
        : null
    return (
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 text-[12.5px] leading-5">
            <div className="flex min-w-0 items-center gap-2">
                <span className={cn("size-2.5 shrink-0 rounded-[3px]", colorClass ?? CONTEXT_COLORS[item.id])} />
                <span className="truncate text-foreground/70">{item.label}</span>
                {item.count != null && (
                    <span className="shrink-0 text-[11px] tabular-nums text-foreground/35">{item.count}</span>
                )}
            </div>
            <span className="min-w-14 text-right tabular-nums text-foreground/50">{formatTokens(item.tokens)}</span>
            <span className="min-w-9 text-right tabular-nums text-foreground/70">
                {deferred || pct === null ? "—" : formatPercent(pct)}
            </span>
        </div>
    )
}

function ContextUsageDetails({ display }: { display: ContextDisplay }) {
    const usage = display.usage
    const freshInput = usage ? freshInputTokens(usage) : null
    const providerInput = usage ? finiteNumber(usage.inputTokens) : null
    const cachedInput = usage ? finiteNumber(usage.cachedTokens) : null
    const showFreshInput = freshInput !== null && providerInput !== null && cachedInput !== null && cachedInput > 0
    const requestParts = usage ? [
        usage.inputTokens != null ? `${formatTokens(usage.inputTokens)} in` : null,
        usage.outputTokens != null ? `${formatTokens(usage.outputTokens)} out` : null,
        usage.thinkingTokens != null && usage.thinkingTokens > 0 ? `${formatTokens(usage.thinkingTokens)} reasoning` : null,
        usage.cachedTokens != null && usage.cachedTokens > 0 ? `${formatTokens(usage.cachedTokens)} cached` : null,
    ].filter(Boolean).join(" · ") : ""
    const compacted = usage?.lastCompactedAt ? formatTimeAgo(usage.lastCompactedAt) : null

    return (
        <div className="mt-2.5 space-y-1.5 border-t border-border/50 pt-2.5 text-[12px] leading-snug text-foreground/50">
            <div className="flex justify-between gap-3">
                <span>Source</span>
                <span className="text-right text-foreground/60">{display.source}</span>
            </div>
            {requestParts && (
                <div className="flex justify-between gap-3">
                    <span>Last request</span>
                    <span className="text-right tabular-nums text-foreground/60">{requestParts}</span>
                </div>
            )}
            {showFreshInput && (
                <div className="flex justify-between gap-3">
                    <span>Fresh input</span>
                    <span className="text-right tabular-nums text-foreground/60">
                        {formatTokens(freshInput)} ({formatTokens(providerInput)} minus cached)
                    </span>
                </div>
            )}
            {usage?.threadTokens != null && usage.threadTokens !== usage.totalTokens && (
                <div className="flex justify-between gap-3">
                    <span>Session total</span>
                    <span className="text-right tabular-nums text-foreground/60">{formatTokens(usage.threadTokens)}</span>
                </div>
            )}
            {compacted && (
                <div className="flex justify-between gap-3">
                    <span>Compacted</span>
                    <span className="text-right text-foreground/60">
                        {compacted}{usage?.compactedCount && usage.compactedCount > 1 ? ` · ${usage.compactedCount}x` : ""}
                    </span>
                </div>
            )}
        </div>
    )
}

function estimateContextTokens(
    messages: Message[],
    draftValue: string,
    attachments: DraftAttachment[],
    systemTokens: number | null,
    baselineBreakdown: ContextUsageBreakdown | null
) {
    let chars = 0
    let attachmentTokens = 0

    for (const message of messages) {
        chars += message.role.length + message.content.length + 8
        for (const attachment of message.attachments ?? []) {
            attachmentTokens += estimateAttachmentTokens(attachment)
        }
    }

    if (draftValue.trim()) chars += draftValue.length + 8

    for (const attachment of attachments) {
        const uploaded = attachment.uploaded
        attachmentTokens += uploaded
            ? estimateAttachmentTokens(uploaded)
            : estimateAttachmentTokens({
                mimeType: attachment.file?.type ?? "",
                size: attachment.file?.size ?? 0,
                type: attachment.type === "image" || attachment.type === "pdf" ? attachment.type : "other",
            })
    }

    const baseTokens = systemTokens && systemTokens > 0
        ? systemTokens
        : BASE_CHAT_OVERHEAD_TOKENS
    const textTokens = estimateCharCountTokens(chars)
    const breakdown: ContextUsageBreakdown = cloneBreakdown(baselineBreakdown) ?? {
        categories: [{ id: "system", label: "System prompt", tokens: baseTokens }],
        deferred: [],
        estimatedTokens: baseTokens,
        accuracy: "estimated",
    }
    addBreakdownTokens(breakdown.categories, "messages", textTokens)
    addBreakdownTokens(breakdown.categories, "attachments", attachmentTokens)
    const tokens = sumBreakdownTokens(breakdown.categories)
    breakdown.estimatedTokens = tokens
    return {
        tokens: Math.max(baseTokens, tokens),
        breakdown,
    }
}

function estimateDraftBreakdown(draftValue: string, attachments: DraftAttachment[]) {
    const messageTokens = draftValue.trim() ? estimateTextTokens(`${draftValue}\n`) : 0
    let attachmentTokens = 0
    for (const attachment of attachments) {
        const uploaded = attachment.uploaded
        attachmentTokens += uploaded
            ? estimateAttachmentTokens(uploaded)
            : estimateAttachmentTokens({
                mimeType: attachment.file?.type ?? "",
                size: attachment.file?.size ?? 0,
                type: attachment.type === "image" || attachment.type === "pdf" ? attachment.type : "other",
            })
    }
    return {
        messageTokens,
        attachmentTokens,
        totalTokens: messageTokens + attachmentTokens,
    }
}

function cloneBreakdown(value: ContextUsageBreakdown | null): ContextUsageBreakdown | null {
    if (!value) return null
    return {
        ...value,
        categories: value.categories.map((item) => ({ ...item })),
        deferred: value.deferred?.map((item) => ({ ...item })),
    }
}

function addBreakdownTokens(
    categories: ContextUsageBreakdownEntry[],
    id: ContextUsageCategoryId,
    tokens: number
): void {
    if (!tokens) return
    const existing = categories.find((item) => item.id === id)
    if (existing) {
        existing.tokens += tokens
        return
    }
    const label = id === "messages"
        ? "Messages"
        : id === "attachments"
            ? "Attachments"
            : id === "provider"
                ? "Provider & tool state"
                : id
    categories.push({ id, label, tokens })
}

function reconcileDisplayBreakdown(
    breakdown: ContextUsageBreakdown,
    tokens: number
): ContextUsageBreakdown {
    const current = sumBreakdownTokens(breakdown.categories)
    if (current < tokens) {
        addBreakdownTokens(breakdown.categories, "provider", tokens - current)
    }
    return breakdown
}

function sumBreakdownTokens(categories: ContextUsageBreakdownEntry[]): number {
    return categories.reduce((total, item) => total + item.tokens, 0)
}

function formatTokens(value: number): string {
    if (!Number.isFinite(value)) return "-"
    if (value >= 1_000_000) {
        const n = value / 1_000_000
        return `${n.toFixed(n >= 10 || value % 1_000_000 === 0 ? 0 : 1)}M`
    }
    if (value >= 1000) {
        const n = value / 1000
        return `${n.toFixed(n >= 10 || value % 1000 === 0 ? 0 : 1)}K`
    }
    return value.toLocaleString()
}

function finiteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function excludeCachedTokens(tokens: number, cached: number | null): number {
    if (!cached || cached <= 0) return tokens
    return Math.max(0, tokens - Math.min(tokens, cached))
}

function freshInputTokens(usage: ContextUsageSnapshot): number | null {
    const input = finiteNumber(usage.inputTokens)
    if (input === null) return null
    const cached = finiteNumber(usage.cachedTokens) ?? 0
    return excludeCachedTokens(input, cached)
}

function formatTimeAgo(timestamp: number): string {
    const delta = Date.now() - timestamp
    if (!Number.isFinite(delta) || delta < 0) return "just now"
    const minutes = Math.floor(delta / 60000)
    if (minutes < 1) return "just now"
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
}

function formatSource(source: ChatStatusSource): string {
    if (source === "agentOverride") return "agent override"
    if (source === "agentDefault") return "agent default"
    return "global default"
}
