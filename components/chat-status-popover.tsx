"use client"

import * as React from "react"
import {
    AlertCircle,
    CheckCircle2,
    ChevronRight,
    Loader2,
} from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import type { Attachment, ContextUsageSnapshot, Message } from "@/lib/types"

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
    /** Estimated orchestrator system prompt size, in tokens. Null when unavailable. */
    systemPromptTokens?: number | null
}

interface CliQuotaWindow {
    usedPercent: number
    resetsAt: number
}

interface CliQuotaSnapshot {
    cliId: "claude-code" | "codex"
    available: boolean
    error?: string
    fiveHour?: CliQuotaWindow
    weekly?: CliQuotaWindow
    weeklySonnet?: CliQuotaWindow
    source: "api" | "log" | "tui" | "none"
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

export function ChatStatusPopover({ messages, draftValue, attachments, contextUsage }: ChatStatusPopoverProps) {
    const [open, setOpen] = React.useState(false)
    const isMobile = useIsMobile()
    const status = useChatStatus()
    const activeCliId = isCliProvider(status.data?.chat.provider.id)
        ? status.data.chat.provider.id
        : null
    const quotas = useLazyCliUsage(
        open && activeCliId !== null && Boolean(status.data?.chat.available),
        activeCliId
    )
    const systemPromptTokens = status.data?.systemPromptTokens ?? null
    const contextEstimate = React.useMemo(
        () => estimateContextTokens(messages, draftValue, attachments, systemPromptTokens),
        [attachments, draftValue, messages, systemPromptTokens]
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
            <Tooltip>
                <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                        <button
                            type="button"
                            className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                            aria-label="Chat status"
                        >
                            <ContextRing pct={contextPct} />
                        </button>
                    </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent side="top">{modelReady ? "Status" : "No model loaded"}</TooltipContent>
            </Tooltip>

            <PopoverContent
                side="top"
                align={isMobile ? "center" : "end"}
                sideOffset={isMobile ? 8 : 10}
                collisionPadding={isMobile ? 12 : undefined}
                className={cn(
                    "max-h-[calc(var(--radix-popover-content-available-height)-8px)] overflow-y-auto rounded-lg p-0",
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
                            <MetricRow
                                label="Context window"
                                value={contextDisplay.contextWindow
                                    ? `${formatTokens(contextDisplay.tokens)} / ${formatTokens(contextDisplay.contextWindow)} (${formatPercent(contextPct ?? 0)})`
                                    : `${formatTokens(contextDisplay.tokens)} / unknown`}
                                progress={contextPct ?? 0}
                                tone="context"
                                trailing={<ChevronRight className="size-4 text-foreground/45" />}
                            />
                            <ContextUsageDetails display={contextDisplay} />
                            {activeCliId && <PlanUsageSection cliId={activeCliId} quotas={quotas} />}
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
                    />
                    <MetricRow
                        label="Weekly · all models"
                        value={formatQuotaValue(snapshot.weekly)}
                        progress={snapshot.weekly?.usedPercent ?? 0}
                        tone="weekly"
                    />
                    {snapshot.weeklySonnet && (
                        <MetricRow
                            label="Weekly · Sonnet"
                            value={formatQuotaValue(snapshot.weeklySonnet)}
                            progress={snapshot.weeklySonnet.usedPercent}
                            tone="sonnet"
                        />
                    )}
                </div>
            )}
        </section>
    )
}

function MetricRow({
    label,
    value,
    progress,
    tone,
    trailing,
}: {
    label: string
    value: string
    progress: number
    tone: "context" | "weekly" | "sonnet"
    trailing?: React.ReactNode
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
    return `${formatPercent(window.usedPercent)} · ${formatResetShort(window.resetsAt)}`
}

function formatResetShort(resetsAt: number): string {
    if (!resetsAt || !Number.isFinite(resetsAt)) return "reset unknown"
    const now = Math.floor(Date.now() / 1000)
    const delta = resetsAt - now
    if (delta <= 0) return "rolled over"
    const days = Math.floor(delta / 86400)
    const hours = Math.floor(delta / 3600)
    const minutes = Math.floor((delta % 3600) / 60)
    if (days >= 1) return `resets ${days}d`
    if (hours >= 1) return `resets ${hours}h`
    return `resets ${minutes}m`
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

function useChatStatus() {
    const [data, setData] = React.useState<ChatStatusResponse | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)

    React.useEffect(() => {
        const controller = new AbortController()
        setLoading(true)

        fetch("/api/chat/status", { cache: "no-store", signal: controller.signal })
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
    }, [])

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
    const draftTokens = realTokens !== null
        ? estimateDraftTokens(args.draftValue, args.attachments)
        : 0
    const tokens = realTokens !== null
        ? realTokens + draftTokens
        : args.contextEstimate.tokens
    const contextWindow = finiteNumber(usageMatches ? usage?.contextWindow : null)
        ?? finiteNumber(chat?.model?.contextWindow)
    const pct = contextWindow
        ? Math.max(0, Math.min(100, (tokens / contextWindow) * 100))
        : null
    const source = realTokens !== null
        ? `${usage?.accuracy === "live" ? "Live provider tokens" : "Actual provider tokens"}${draftTokens > 0 ? " + draft estimate" : ""}`
        : "Local estimate"

    return {
        tokens,
        contextWindow,
        pct,
        source,
        usage: realTokens !== null ? usage ?? null : null,
        draftTokens,
    }
}

function ContextUsageDetails({ display }: { display: ContextDisplay }) {
    const usage = display.usage
    const requestParts = usage ? [
        usage.inputTokens != null ? `${formatTokens(usage.inputTokens)} in` : null,
        usage.outputTokens != null ? `${formatTokens(usage.outputTokens)} out` : null,
        usage.thinkingTokens != null && usage.thinkingTokens > 0 ? `${formatTokens(usage.thinkingTokens)} reasoning` : null,
        usage.cachedTokens != null && usage.cachedTokens > 0 ? `${formatTokens(usage.cachedTokens)} cached` : null,
    ].filter(Boolean).join(" · ") : ""
    const compacted = usage?.lastCompactedAt ? formatTimeAgo(usage.lastCompactedAt) : null

    return (
        <div className="mt-2 space-y-1.5 text-[12px] leading-snug text-foreground/50">
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
    systemTokens: number | null
) {
    let chars = 0
    let attachmentTokens = 0
    let attachmentCount = 0

    for (const message of messages) {
        chars += message.role.length + message.content.length + 8
        for (const attachment of message.attachments ?? []) {
            attachmentTokens += estimateAttachmentTokens(attachment)
            attachmentCount += 1
        }
    }

    if (draftValue.trim()) chars += draftValue.length + 8

    for (const attachment of attachments) {
        const uploaded = attachment.uploaded
        attachmentTokens += uploaded
            ? estimateAttachmentTokens(uploaded)
            : estimateAttachmentTokens({
                id: "",
                filename: attachment.file?.name ?? "file",
                mimeType: attachment.file?.type ?? "",
                size: attachment.file?.size ?? 0,
                type: attachment.type === "image" || attachment.type === "pdf" ? attachment.type : "other",
            })
        attachmentCount += 1
    }

    // The system prompt dominates base context; use the real measured size
    // when the status endpoint provided it, else fall back to a flat guess.
    const baseTokens = systemTokens && systemTokens > 0 ? systemTokens : BASE_CHAT_OVERHEAD_TOKENS
    const textTokens = Math.ceil(chars / 4)
    return {
        tokens: Math.max(baseTokens, baseTokens + textTokens + attachmentTokens),
        attachmentCount,
    }
}

function estimateDraftTokens(draftValue: string, attachments: DraftAttachment[]): number {
    let tokens = draftValue.trim() ? Math.ceil((draftValue.length + 8) / 4) : 0
    for (const attachment of attachments) {
        const uploaded = attachment.uploaded
        tokens += uploaded
            ? estimateAttachmentTokens(uploaded)
            : estimateAttachmentTokens({
                id: "",
                filename: attachment.file?.name ?? "file",
                mimeType: attachment.file?.type ?? "",
                size: attachment.file?.size ?? 0,
                type: attachment.type === "image" || attachment.type === "pdf" ? attachment.type : "other",
            })
    }
    return tokens
}

function estimateAttachmentTokens(attachment: Attachment): number {
    if (attachment.type === "image") return 1200
    if (attachment.type === "pdf" || attachment.type === "document") {
        return Math.min(60_000, Math.max(800, Math.ceil(attachment.size / 12)))
    }
    if (attachment.type === "audio" || attachment.type === "video") return 0
    return Math.min(12_000, Math.max(100, Math.ceil(attachment.size / 24)))
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
