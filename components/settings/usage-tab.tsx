"use client"

import * as React from "react"
import {
    AlertCircle,
    AlertTriangle,
    ArrowDownRight,
    ArrowUpRight,
    Clock,
    Loader2,
    RefreshCcw,
    Minus,
    Terminal as TerminalIcon,
} from "lucide-react"
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts"

import { cn } from "@/lib/utils"
import type {
    UsageRange,
    UsageReport,
    UsageTotals,
    UsageByModel,
    UsageByAgent,
    UsageByTool,
} from "@/lib/observability/schema"
import {
    quotaPaceLabel,
    formatResetCountdown,
    FIVE_HOUR_SECONDS,
    WEEKLY_SECONDS,
} from "@/lib/cli/quota-pace"
import { useUsage } from "./use-usage"
import { useCliUsage, type CliQuotaSnapshot, type CliQuotaWindow } from "./use-cli-usage"

const RANGE_OPTIONS: Array<{ value: UsageRange; label: string }> = [
    { value: "24h", label: "Last 24h" },
    { value: "7d", label: "Last 7 days" },
    { value: "30d", label: "Last 30 days" },
    { value: "90d", label: "Last 90 days" },
    { value: "all", label: "All time" },
]

export function UsageTab() {
    const [range, setRange] = React.useState<UsageRange>("30d")
    const { data, loading, error, refresh } = useUsage(range)

    return (
        <div className="flex w-full min-w-0 max-w-full flex-col gap-5 overflow-x-hidden">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] sm:flex-none [&::-webkit-scrollbar]:hidden">
                    <div className="inline-flex h-9 min-w-max items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
                        {RANGE_OPTIONS.map(o => (
                            <button
                                key={o.value}
                                onClick={() => setRange(o.value)}
                                className={cn(
                                    "h-8 shrink-0 rounded-md px-3 text-[12.5px] font-medium transition-all",
                                    range === o.value
                                        ? "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-border/60"
                                        : "text-foreground/55 hover:text-foreground/85"
                                )}
                            >
                                {o.label}
                            </button>
                        ))}
                    </div>
                </div>

                <button
                    onClick={refresh}
                    title="Refresh"
                    className="ml-auto inline-flex size-8 items-center justify-center rounded-lg border border-border bg-background text-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground"
                >
                    <RefreshCcw className={cn("size-3.5", loading && "animate-spin")} />
                </button>
            </div>

            {error && (
                <div className="flex items-start gap-2.5 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    <p>{error}</p>
                </div>
            )}

            {!data && loading && <SkeletonState />}

            {data && data.totals.requests === 0 && (
                <div className="rounded-2xl border border-dashed border-border/70 bg-muted/30 px-5 py-12 text-center text-[14px] text-foreground/55">
                    No usage data in this range yet. Send a chat to see activity here.
                </div>
            )}

            {data && data.totals.requests > 0 && <UsageContent data={data} />}

            <CliQuotaSection />
        </div>
    )
}

// ---------------------------------------------------------------------------
// CLI subscription quotas (Codex)
// ---------------------------------------------------------------------------

const CLI_LABELS: Record<string, { name: string; description: string }> = {
    "codex": {
        name: "Codex CLI",
        description: "OpenAI subscription. Live from the same /wham/usage endpoint codex's /status polls.",
    },
}

const CLI_ORDER = ["codex"] as const

function CliQuotaSection() {
    const { data, loading, error, refresh } = useCliUsage()

    return (
        <section className="mt-6 flex min-w-0 flex-col gap-3 border-t border-border/60 pt-6">
            <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="text-[15px] font-semibold text-foreground/85">CLI subscription quotas</h2>
                    <p className="mt-0.5 text-[12.5px] text-foreground/50">
                        5-hour rolling and 7-day rolling windows for the local Codex CLI.
                    </p>
                </div>
                <button
                    onClick={refresh}
                    disabled={loading}
                    title="Re-pull quota snapshots"
                    className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium text-foreground/70 transition-colors",
                        "hover:bg-muted/60 hover:text-foreground",
                        loading && "opacity-60"
                    )}
                >
                    {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />}
                    <span className="hidden sm:inline">Refresh</span>
                </button>
            </div>

            {error && (
                <div className="flex items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    <p>{error}</p>
                </div>
            )}

            <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
                {!data && loading && (
                    <div className="h-[170px] animate-pulse rounded-2xl border border-border/60 bg-muted/40" />
                )}
                {data && CLI_ORDER.map(id => (
                    <CliQuotaCard key={id} id={id} snapshot={data[id]} />
                ))}
            </div>
        </section>
    )
}

function CliQuotaCard({ id, snapshot }: { id: string; snapshot: CliQuotaSnapshot | undefined }) {
    const label = CLI_LABELS[id] ?? { name: id, description: "" }

    return (
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card p-4 md:rounded-2xl">
            <div className="flex items-start gap-2.5">
                <span className="flex size-8 items-center justify-center rounded-lg bg-foreground/5">
                    <TerminalIcon className="size-4 text-foreground/70" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                        <h3 className="truncate text-[14px] font-semibold text-foreground">{label.name}</h3>
                        {snapshot?.available && <Badge tone="success">Live</Badge>}
                    </div>
                    <p className="mt-0.5 text-[11.5px] leading-snug text-foreground/55">{label.description}</p>
                </div>
            </div>

            {!snapshot || !snapshot.available ? (
                <div className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 text-[12.5px] text-foreground/60">
                    <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                    <p>{snapshot?.error ?? "No data yet."}</p>
                </div>
            ) : (
                <div className="flex flex-col gap-3.5">
                    <QuotaBar label="5-hour window" window={snapshot.fiveHour} fallbackWindowSeconds={FIVE_HOUR_SECONDS} />
                    <QuotaBar label="7-day window" window={snapshot.weekly} fallbackWindowSeconds={WEEKLY_SECONDS} />
                </div>
            )}
        </div>
    )
}

function QuotaBar({ label, window: w, muted, fallbackWindowSeconds }: {
    label: string
    window: CliQuotaWindow | undefined
    muted?: boolean
    fallbackWindowSeconds: number
}) {
    if (!w) {
        return (
            <div className="flex items-center justify-between text-[12.5px] text-foreground/50">
                <span>{label}</span>
                <span>—</span>
            </div>
        )
    }
    const pct = Math.max(0, Math.min(100, w.usedPercent))
    const tone = pct >= 90 ? "danger" : pct >= 75 ? "warn" : "ok"
    const barColor =
        tone === "danger" ? "bg-destructive"
            : tone === "warn" ? "bg-amber-500"
                : "bg-emerald-500"
    const pace = quotaPaceLabel(w, fallbackWindowSeconds)
    return (
        <div className={cn("flex flex-col gap-1.5", muted && "opacity-75")}>
            <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                <span className="font-medium text-foreground/80">{label}</span>
                <span className="tabular-nums text-foreground/65">
                    <span className={cn(
                        "font-semibold",
                        tone === "danger" && "text-destructive",
                        tone === "warn" && "text-amber-600 dark:text-amber-400"
                    )}>
                        {pct.toFixed(1)}%
                    </span>
                    {" "}used
                </span>
            </div>
            <div className="relative h-2 overflow-hidden rounded-full bg-muted/70 ring-1 ring-inset ring-border/40">
                <div
                    className={cn("absolute inset-y-0 left-0 rounded-full transition-all", barColor)}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <div className="flex items-center gap-1 text-[11px] tabular-nums text-foreground/50">
                <Clock className="size-3" />
                <span>{formatResetCountdown(w.resetsAt)}</span>
            </div>
            {pace && (
                <div className={cn(
                    "flex items-center gap-1 text-[11px] tabular-nums",
                    pace.tone === "danger" ? "text-destructive"
                        : pace.tone === "warn" ? "text-amber-600 dark:text-amber-400"
                            : "text-foreground/55"
                )}>
                    {(pace.tone === "danger" || pace.tone === "warn") && <AlertTriangle className="size-3 shrink-0" />}
                    <span>{pace.text}</span>
                </div>
            )}
        </div>
    )
}

function Badge({ tone, children }: { tone: "success" | "muted"; children: React.ReactNode }) {
    const cls = tone === "success"
        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : "bg-muted text-foreground/55"
    return (
        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium", cls)}>
            {children}
        </span>
    )
}

function UsageContent({ data }: { data: UsageReport }) {
    return (
        <>
            <KpiCards totals={data.totals} previous={data.previousTotals} />

            <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
                <ChartCard title="Tokens per day" subtitle="Total tokens (input + output + thinking, excl. cached)">
                    <TokensChart daily={data.daily} />
                </ChartCard>
                <ChartCard title="Estimated cost per day" subtitle="USD, based on registry pricing">
                    <CostChart daily={data.daily} />
                </ChartCard>
            </div>

            <ByModelTable rows={data.byModel} />
            <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
                <ByAgentTable rows={data.byAgent} />
                <ByToolTable rows={data.byTool} />
            </div>

            <p className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-[11.5px] text-foreground/55">
                Cost is estimated from registry pricing — for ground truth, check your provider&apos;s billing console.
                {data.totals.uncostedRequests > 0 && (
                    <> {data.totals.uncostedRequests} request{data.totals.uncostedRequests === 1 ? "" : "s"} use models with unknown pricing and aren&apos;t included in the cost total.</>
                )}
                {data.totals.subscriptionRequests > 0 && (
                    <> {data.totals.subscriptionRequests} request{data.totals.subscriptionRequests === 1 ? "" : "s"} use subscription-priced models (counted as $0).</>
                )}
            </p>
        </>
    )
}

// ---------------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------------

function KpiCards({ totals, previous }: { totals: UsageTotals; previous: UsageTotals | null }) {
    const errorRate = totals.requests > 0 ? totals.errors / totals.requests : 0
    const previousErrorRate = previous && previous.requests > 0 ? previous.errors / previous.requests : null
    // Headline excludes cache reads — cached is a near-free, run-inflating subset
    // of input (see usage-mapper mapAnthropic). Cached stays visible in the By model table.
    const freshTokens = Math.max(0, totals.totalTokens - totals.cachedTokens)

    return (
        <div className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-4">
            <Kpi
                label="Requests"
                value={totals.requests.toLocaleString()}
                delta={previous ? pctDelta(totals.requests, previous.requests) : null}
            />
            <Kpi
                label="Total tokens"
                value={formatTokensCompact(freshTokens)}
                hint={`${formatTokensCompact(Math.max(0, totals.inputTokens - totals.cachedTokens))} in · ${formatTokensCompact(totals.outputTokens)} out · ${formatTokensCompact(totals.thinkingTokens)} thinking`}
                delta={previous ? pctDelta(freshTokens, Math.max(0, previous.totalTokens - previous.cachedTokens)) : null}
            />
            <Kpi
                label="Estimated cost"
                value={formatUsd(totals.estimatedCostUsd)}
                hint={totals.cachedTokens > 0 ? `${formatTokensCompact(totals.cachedTokens)} cached` : undefined}
                delta={previous ? pctDelta(totals.estimatedCostUsd, previous.estimatedCostUsd) : null}
            />
            <Kpi
                label="Error rate"
                value={`${(errorRate * 100).toFixed(1)}%`}
                hint={`${totals.errors} of ${totals.requests}`}
                delta={previousErrorRate !== null ? pctDelta(errorRate, previousErrorRate) : null}
                deltaInverted
            />
        </div>
    )
}

function Kpi({ label, value, hint, delta, deltaInverted }: {
    label: string
    value: string
    hint?: string
    delta: number | null
    /** When true, a positive delta is shown as bad (e.g. error rate going up). */
    deltaInverted?: boolean
}) {
    return (
        <div className="min-w-0 rounded-xl border border-border/70 bg-card px-4 py-3.5 md:rounded-2xl">
            <div className="text-[11.5px] font-medium uppercase tracking-wider text-foreground/50">{label}</div>
            <div className="mt-1 flex items-baseline gap-2">
                <div className="min-w-0 text-[22px] font-semibold tabular-nums text-foreground">{value}</div>
                {delta !== null && Number.isFinite(delta) && (
                    <DeltaBadge value={delta} inverted={deltaInverted} />
                )}
            </div>
            {hint && <div className="mt-0.5 text-[11.5px] tabular-nums text-foreground/50">{hint}</div>}
        </div>
    )
}

function DeltaBadge({ value, inverted }: { value: number; inverted?: boolean }) {
    if (Math.abs(value) < 0.005) {
        return (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[10.5px] font-medium text-foreground/55">
                <Minus className="size-3" />
                0%
            </span>
        )
    }
    const positive = value > 0
    const good = inverted ? !positive : positive
    return (
        <span
            className={cn(
                "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium",
                good
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "bg-destructive/10 text-destructive"
            )}
        >
            {positive ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
            {Math.abs(value * 100).toFixed(0)}%
        </span>
    )
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function ChartCard({ title, subtitle, children }: {
    title: string
    subtitle?: string
    children: React.ReactNode
}) {
    return (
        <div className="min-w-0 rounded-xl border border-border/70 bg-card p-4 md:rounded-2xl">
            <div className="mb-3">
                <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
                {subtitle && <p className="mt-0.5 text-[12px] text-foreground/55">{subtitle}</p>}
            </div>
            <div className="h-[220px] w-full">{children}</div>
        </div>
    )
}

function TokensChart({ daily }: { daily: UsageReport["daily"] }) {
    const data = daily.map(d => ({
        date: d.date,
        total: Math.max(0, d.inputTokens - (d.cachedTokens ?? 0)) + d.outputTokens + d.thinkingTokens,
    }))

    return (
        <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 5, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" vertical={false} />
                <XAxis dataKey="date" tickFormatter={shortDate} fontSize={11} stroke="currentColor" className="text-foreground/45" />
                <YAxis fontSize={11} stroke="currentColor" tickFormatter={formatTokensCompact} className="text-foreground/45" />
                <Tooltip
                    content={<ChartTooltip valueFormatter={v => v.toLocaleString()} />}
                />
                <Area type="monotone" dataKey="total" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.2} name="Total tokens" />
            </AreaChart>
        </ResponsiveContainer>
    )
}

function CostChart({ daily }: { daily: UsageReport["daily"] }) {
    const data = daily.map(d => ({ date: d.date, cost: Number(d.estimatedCostUsd.toFixed(6)) }))

    return (
        <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 5, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" vertical={false} />
                <XAxis dataKey="date" tickFormatter={shortDate} fontSize={11} stroke="currentColor" className="text-foreground/45" />
                <YAxis fontSize={11} stroke="currentColor" tickFormatter={v => formatUsd(v)} className="text-foreground/45" />
                <Tooltip content={<ChartTooltip valueFormatter={v => formatUsd(v as number)} />} />
                <Bar dataKey="cost" fill="#0ea5e9" name="Cost (USD)" radius={[4, 4, 0, 0]} />
            </BarChart>
        </ResponsiveContainer>
    )
}

interface ChartTooltipProps {
    active?: boolean
    payload?: Array<{ name?: string; value?: number; color?: string; dataKey?: string }>
    label?: string
    valueFormatter: (v: number) => string
}

function ChartTooltip({ active, payload, label, valueFormatter }: ChartTooltipProps) {
    if (!active || !payload?.length) return null
    return (
        <div className="rounded-lg border border-border/70 bg-card px-2.5 py-2 text-[11.5px] shadow-xl">
            {label && <div className="mb-1 font-medium tabular-nums text-foreground">{label}</div>}
            {payload.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                    <span className="size-1.5 rounded-full" style={{ backgroundColor: p.color }} />
                    <span className="text-foreground/65">{p.name}</span>
                    <span className="ml-auto tabular-nums text-foreground">{valueFormatter(p.value ?? 0)}</span>
                </div>
            ))}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function ByModelTable({ rows }: { rows: UsageByModel[] }) {
    if (rows.length === 0) return null
    return (
        <div className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card md:rounded-2xl">
            <div className="border-b border-border/70 bg-muted/30 px-4 py-2.5 text-[14px] font-semibold text-foreground">
                By model
            </div>
            <div className="max-w-full overflow-x-auto">
                <table className="min-w-[760px] w-full text-[13px] md:min-w-0">
                    <thead>
                        <tr className="border-b border-border/50 text-left text-[11px] font-medium uppercase tracking-wider text-foreground/55">
                            <th className="px-4 py-2">Model</th>
                            <th className="px-3 py-2 text-right">Requests</th>
                            <th className="px-3 py-2 text-right">Errors</th>
                            <th className="px-3 py-2 text-right">Input</th>
                            <th className="px-3 py-2 text-right">Output</th>
                            <th className="px-3 py-2 text-right">Thinking</th>
                            <th className="px-3 py-2 text-right">Cached</th>
                            <th className="px-3 py-2 text-right">Avg think</th>
                            <th className="px-3 py-2 text-right">Cost</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(r => (
                            <tr key={`${r.provider}:${r.model}`} className="border-b border-border/30 last:border-b-0">
                                <td className="px-4 py-2.5">
                                    <div className="flex items-center gap-2">
                                        <span className={cn("inline-block size-1.5 shrink-0 rounded-full", providerColor(r.provider))} />
                                        <div className="min-w-0">
                                            <div className="truncate font-medium text-foreground">{r.displayName}</div>
                                            <div className="truncate text-[11px] text-foreground/45">{r.provider} · {r.model}</div>
                                        </div>
                                    </div>
                                </td>
                                <td className="px-3 py-2.5 text-right tabular-nums">{r.requests.toLocaleString()}</td>
                                <td className={cn("px-3 py-2.5 text-right tabular-nums", r.errors > 0 && "text-destructive")}>
                                    {r.errors}
                                </td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-foreground/70">{formatTokensCompact(r.inputTokens)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-foreground/70">{formatTokensCompact(r.outputTokens)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-foreground/70">{formatTokensCompact(r.thinkingTokens)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-foreground/70">{formatTokensCompact(r.cachedTokens)}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-foreground/70">{r.avgThinkingMs > 0 ? `${(r.avgThinkingMs / 1000).toFixed(1)}s` : "—"}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums">
                                    {r.pricingState === "priced"
                                        ? formatUsd(r.estimatedCostUsd)
                                        : r.pricingState === "subscription"
                                            ? <span className="text-foreground/45">incl.</span>
                                            : <span className="text-amber-600 dark:text-amber-400">—</span>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

function ByAgentTable({ rows }: { rows: UsageByAgent[] }) {
    return (
        <div className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card md:rounded-2xl">
            <div className="border-b border-border/70 bg-muted/30 px-4 py-2.5 text-[14px] font-semibold text-foreground">
                By agent
            </div>
            {rows.length === 0 ? (
                <p className="px-4 py-6 text-center text-[13px] text-foreground/45">No data.</p>
            ) : (
                <div className="max-w-full overflow-x-auto md:overflow-visible">
                    <table className="min-w-[420px] w-full text-[13px] md:min-w-0">
                        <thead>
                            <tr className="border-b border-border/50 text-left text-[11px] font-medium uppercase tracking-wider text-foreground/55">
                                <th className="px-4 py-2">Agent</th>
                                <th className="px-3 py-2 text-right">Requests</th>
                                <th className="px-3 py-2 text-right">Tokens</th>
                                <th className="px-3 py-2 text-right">Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(r => (
                                <tr key={r.agentId} className="border-b border-border/30 last:border-b-0">
                                    <td className="px-4 py-2.5 font-medium text-foreground">{r.agentId}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums">{r.requests.toLocaleString()}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-foreground/70">
                                        {formatTokensCompact(r.inputTokens + r.outputTokens + r.thinkingTokens)}
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums">{formatUsd(r.estimatedCostUsd)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}

function ByToolTable({ rows }: { rows: UsageByTool[] }) {
    return (
        <div className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card md:rounded-2xl">
            <div className="border-b border-border/70 bg-muted/30 px-4 py-2.5 text-[14px] font-semibold text-foreground">
                By tool
            </div>
            {rows.length === 0 ? (
                <p className="px-4 py-6 text-center text-[13px] text-foreground/45">No tool calls in this range.</p>
            ) : (
                <div className="max-h-[420px] max-w-full overflow-auto">
                    <table className="min-w-[420px] w-full text-[13px] md:min-w-0">
                        <thead className="sticky top-0 z-10 bg-card">
                            <tr className="border-b border-border/50 text-left text-[11px] font-medium uppercase tracking-wider text-foreground/55">
                                <th className="bg-card px-4 py-2">Tool</th>
                                <th className="bg-card px-3 py-2 text-right">Calls</th>
                                <th className="bg-card px-3 py-2 text-right">Failures</th>
                                <th className="bg-card px-3 py-2 text-right">Avg duration</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(r => (
                                <tr key={r.toolName} className="border-b border-border/30 last:border-b-0">
                                    <td className="px-4 py-2.5 font-medium text-foreground">{r.toolName}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums">{r.calls.toLocaleString()}</td>
                                    <td className={cn("px-3 py-2.5 text-right tabular-nums", r.failures > 0 && "text-destructive")}>
                                        {r.failures}
                                    </td>
                                    <td className="px-3 py-2.5 text-right tabular-nums text-foreground/70">
                                        {r.avgDurationMs !== null ? `${r.avgDurationMs} ms` : "—"}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}

function SkeletonState() {
    return (
        <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {[0, 1, 2, 3].map(i => (
                    <div key={i} className="h-20 animate-pulse rounded-2xl border border-border/60 bg-muted/40" />
                ))}
            </div>
            <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-foreground/55">
                <Loader2 className="size-4 animate-spin" /> Computing usage…
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pctDelta(now: number, prev: number): number | null {
    if (prev === 0 && now === 0) return 0
    if (prev === 0) return null
    return (now - prev) / prev
}

function formatTokensCompact(n: number): string {
    if (n === 0) return "0"
    if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
    if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return n.toLocaleString()
}

function formatUsd(n: number): string {
    if (n === 0) return "$0"
    if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`
    if (Math.abs(n) < 1) return `$${n.toFixed(3)}`
    return `$${n.toFixed(2)}`
}

function shortDate(iso: string): string {
    if (!iso) return ""
    const [, m, d] = iso.split("-")
    return `${m}/${d}`
}

function providerColor(providerId: string): string {
    if (providerId === "google") return "bg-blue-500"
    if (providerId === "anthropic") return "bg-orange-500"
    if (providerId === "openai") return "bg-emerald-500"
    return "bg-foreground/40"
}
