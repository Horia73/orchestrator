"use client"

import * as React from "react"
import {
    AlertCircle,
    CheckCircle2,
    ChevronRight,
    Loader2,
    RefreshCcw,
    Square,
    XCircle,
} from "lucide-react"

import { cn } from "@/lib/utils"
import type { BackgroundJobApiRow } from "@/lib/background-jobs-api"

// Profile-wide view over tracked background jobs (running + the 14-day
// retained history): status, command, duration, log viewer, and Stop for
// running jobs. Lives at the top of Settings → Logs, next to request logs.

const LIST_LIMIT = 50
const RUNNING_POLL_MS = 10_000
const LOG_CHARS = 60_000

function formatDuration(startedAt: number, endedAt: number | null, now: number): string {
    const ms = Math.max(0, (endedAt ?? now) - startedAt)
    const seconds = Math.round(ms / 1000)
    if (seconds < 90) return `${seconds}s`
    const minutes = Math.round(seconds / 60)
    if (minutes < 90) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    return `${hours}h ${minutes - hours * 60}m`
}

function statusMeta(job: BackgroundJobApiRow): { label: string; icon: React.ReactNode; tone: string } {
    if (job.status === "running") {
        return { label: "Running", icon: <Loader2 className="size-3.5 animate-spin" aria-hidden />, tone: "text-sky-500" }
    }
    if (job.status === "exited" && job.exitCode === 0) {
        return { label: "OK", icon: <CheckCircle2 className="size-3.5" aria-hidden />, tone: "text-emerald-500" }
    }
    if (job.status === "exited") {
        return { label: `Exit ${job.exitCode ?? "?"}`, icon: <XCircle className="size-3.5" aria-hidden />, tone: "text-red-500" }
    }
    if (job.status === "failed") {
        return { label: "Failed to start", icon: <XCircle className="size-3.5" aria-hidden />, tone: "text-red-500" }
    }
    if (job.status === "killed") {
        return { label: "Killed", icon: <Square className="size-3.5" aria-hidden />, tone: "text-amber-500" }
    }
    return { label: "Lost", icon: <AlertCircle className="size-3.5" aria-hidden />, tone: "text-amber-500" }
}

export function BackgroundJobsSection() {
    const [open, setOpen] = React.useState(false)
    const [jobs, setJobs] = React.useState<BackgroundJobApiRow[]>([])
    const [loading, setLoading] = React.useState(true)
    const [now, setNow] = React.useState(() => Date.now())
    const [logJobId, setLogJobId] = React.useState<string | null>(null)
    const [logTail, setLogTail] = React.useState("")
    const [stoppingIds, setStoppingIds] = React.useState<ReadonlySet<string>>(new Set())

    const refresh = React.useCallback(async () => {
        try {
            const res = await fetch(`/api/background-jobs?limit=${LIST_LIMIT}`, { cache: "no-store" })
            if (!res.ok) return
            const json = (await res.json()) as { jobs?: BackgroundJobApiRow[] }
            setJobs(Array.isArray(json.jobs) ? json.jobs : [])
            setNow(Date.now())
        } catch {
            // Transient — the next refresh retries.
        } finally {
            setLoading(false)
        }
    }, [])

    React.useEffect(() => {
        void refresh()
    }, [refresh])

    const runningCount = jobs.filter((job) => job.status === "running").length

    // Keep durations honest while anything runs, without polling when idle.
    React.useEffect(() => {
        if (runningCount === 0) return
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void refresh()
        }, RUNNING_POLL_MS)
        return () => clearInterval(timer)
    }, [runningCount, refresh])

    const toggleLog = React.useCallback(async (jobId: string) => {
        setLogJobId((current) => (current === jobId ? null : jobId))
        setLogTail("")
        try {
            const res = await fetch(`/api/background-jobs/${encodeURIComponent(jobId)}/log?chars=${LOG_CHARS}`, { cache: "no-store" })
            if (!res.ok) return
            const json = (await res.json()) as { tail?: string }
            setLogTail(typeof json.tail === "string" && json.tail ? json.tail : "(no output captured)")
        } catch {
            setLogTail("(could not load the log right now)")
        }
    }, [])

    const stopJob = React.useCallback(async (jobId: string) => {
        setStoppingIds((current) => new Set(current).add(jobId))
        try {
            await fetch(`/api/background-jobs/${encodeURIComponent(jobId)}/kill`, { method: "POST" })
            await refresh()
        } catch {
            // Next refresh shows the real state.
        } finally {
            setStoppingIds((current) => {
                const next = new Set(current)
                next.delete(jobId)
                return next
            })
        }
    }, [refresh])

    return (
        <section className="rounded-lg border border-border/70">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                aria-expanded={open}
            >
                <ChevronRight
                    className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
                    aria-hidden
                />
                <span className="text-[13px] font-medium">Background jobs</span>
                <span className="text-[12px] text-muted-foreground tabular-nums">
                    {loading ? "…" : runningCount > 0 ? `${runningCount} running · ${jobs.length} total` : `${jobs.length} in the last 14 days`}
                </span>
                {runningCount > 0 && <Loader2 className="size-3 animate-spin text-sky-500" aria-hidden />}
                <span className="flex-1" />
                <span
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                        event.stopPropagation()
                        void refresh()
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                            event.stopPropagation()
                            void refresh()
                        }
                    }}
                    className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
                    aria-label="Refresh background jobs"
                >
                    <RefreshCcw className="size-3.5" aria-hidden />
                </span>
            </button>

            {open && (
                <div className="border-t border-border/70">
                    {jobs.length === 0 ? (
                        <p className="px-3 py-3 text-[12.5px] text-muted-foreground">
                            No background jobs in the last 14 days. Agents start them for long builds, downloads, and batch work; finished records are pruned automatically.
                        </p>
                    ) : (
                        <ul className="divide-y divide-border/60">
                            {jobs.map((job) => {
                                const meta = statusMeta(job)
                                return (
                                    <li key={job.id} className="px-3 py-2.5 text-[12.5px]">
                                        <div className="flex items-center gap-2.5">
                                            <span className={cn("flex shrink-0 items-center gap-1", meta.tone)}>
                                                {meta.icon}
                                                <span className="text-[11.5px]">{meta.label}</span>
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                {job.description && <div className="truncate">{job.description}</div>}
                                                <div className="truncate font-mono text-[11px] text-muted-foreground" title={job.command}>
                                                    {job.command}
                                                </div>
                                            </div>
                                            {job.runner === "container" && (
                                                <span
                                                    className="shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                                                    title="Runs in its own container — survives app restarts and updates"
                                                >
                                                    container
                                                </span>
                                            )}
                                            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                                                {formatDuration(job.startedAt, job.endedAt, now)}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => void toggleLog(job.id)}
                                                className="shrink-0 rounded-md border border-border/70 px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                                            >
                                                Log
                                            </button>
                                            {job.status === "running" && (
                                                <button
                                                    type="button"
                                                    onClick={() => void stopJob(job.id)}
                                                    disabled={stoppingIds.has(job.id)}
                                                    className="flex shrink-0 items-center gap-1 rounded-md border border-border/70 px-2 py-1.5 text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-50"
                                                >
                                                    {stoppingIds.has(job.id) ? (
                                                        <Loader2 className="size-3 animate-spin" aria-hidden />
                                                    ) : (
                                                        <Square className="size-3" aria-hidden />
                                                    )}
                                                    Stop
                                                </button>
                                            )}
                                        </div>
                                        {logJobId === job.id && (
                                            <pre className="tool-call-scroll mt-2 max-h-72 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap">
                                                {logTail || "Loading log…"}
                                            </pre>
                                        )}
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </div>
            )}
        </section>
    )
}
