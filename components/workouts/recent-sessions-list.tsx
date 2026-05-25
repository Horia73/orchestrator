"use client"

import * as React from "react"
import { Calendar, ChevronDown, ChevronUp, Clock, ListChecks, Trophy, Weight } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/workout/format"

export interface SessionSummaryRow {
    slug: string
    sessionId: string
    title: string
    subtitle?: string
    program?: { name: string; week?: number; day?: number }
    difficulty?: string
    units: string
    startedAt: string
    totalDurationSec: number
    totalSetsCompleted: number
    totalSetsPlanned: number
    totalVolumeKg: number
    prCount: number
    exerciseCount: number
    exerciseNames: string[]
}

/**
 * List of recent sessions on the /workouts page.
 *
 * Each row is collapsible: header shows the highlights, click to expand
 * and fetch the full markdown summary from /api/workouts/sessions/:slug.
 *
 * Loading state is per-row (multiple sessions can be open at once). On fetch
 * error, the row shows the error inline and offers a retry.
 */
export function RecentSessionsList({
    sessions,
    className,
}: {
    sessions: SessionSummaryRow[]
    className?: string
}) {
    if (sessions.length === 0) {
        return (
            <div className={cn(
                "rounded-xl border border-dashed border-border bg-muted/25 p-6 text-center text-sm text-muted-foreground",
                className,
            )}>
                Niciun workout salvat încă. Începe o sesiune din chat și apasă <span className="font-medium text-foreground">Finish workout</span> ca să apară aici.
            </div>
        )
    }
    return (
        <ul className={cn("flex flex-col gap-2", className)}>
            {sessions.map((s) => (
                <SessionRow key={s.slug} session={s} />
            ))}
        </ul>
    )
}

function SessionRow({ session }: { session: SessionSummaryRow }) {
    const [open, setOpen] = React.useState(false)
    const [markdown, setMarkdown] = React.useState<string | null>(null)
    const [loading, setLoading] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)

    const onToggle = async () => {
        const willOpen = !open
        setOpen(willOpen)
        if (willOpen && markdown === null && !loading) {
            setLoading(true)
            setError(null)
            try {
                const r = await fetch(`/api/workouts/sessions/${encodeURIComponent(session.slug)}`)
                if (!r.ok) {
                    const j = await r.json().catch(() => ({})) as { error?: string }
                    throw new Error(j.error ?? `HTTP ${r.status}`)
                }
                const body = await r.json() as { markdown: string }
                setMarkdown(body.markdown)
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
            } finally {
                setLoading(false)
            }
        }
    }

    const date = session.startedAt.slice(0, 10)
    return (
        <li className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm transition-colors hover:border-border">
            <button
                type="button"
                onClick={() => void onToggle()}
                className="flex w-full items-start gap-3 px-4 py-3 text-left"
                aria-expanded={open}
            >
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <h3 className="text-sm font-semibold text-foreground">{session.title}</h3>
                        {session.program ? (
                            <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                                {session.program.name}{session.program.week ? ` · W${session.program.week}` : ''}{session.program.day ? `D${session.program.day}` : ''}
                            </span>
                        ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                        <Stat icon={<Calendar className="size-3" />} value={date} />
                        <Stat icon={<Clock className="size-3" />} value={formatDuration(session.totalDurationSec)} />
                        <Stat icon={<ListChecks className="size-3" />} value={`${session.totalSetsCompleted}/${session.totalSetsPlanned} sets`} />
                        {session.totalVolumeKg > 0 ? (
                            <Stat icon={<Weight className="size-3" />} value={`${Math.round(session.totalVolumeKg).toLocaleString()} ${session.units}`} />
                        ) : null}
                        {session.prCount > 0 ? (
                            <Stat
                                icon={<Trophy className="size-3" />}
                                value={`${session.prCount} PR${session.prCount > 1 ? 's' : ''}`}
                                accent
                            />
                        ) : null}
                    </div>
                    <div className="mt-1.5 truncate text-[11.5px] text-foreground/65">
                        {session.exerciseNames.join(' · ')}
                    </div>
                </div>
                <span className="mt-1 shrink-0 text-muted-foreground/65">
                    {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                </span>
            </button>
            {open ? (
                <div className="border-t border-border/45 bg-muted/15 px-4 py-3">
                    {loading ? (
                        <div className="text-[12px] text-muted-foreground">Loading…</div>
                    ) : error ? (
                        <div className="text-[12px] text-rose-500">
                            {error} · <button onClick={() => void onToggle()} className="underline">retry</button>
                        </div>
                    ) : markdown ? (
                        <pre className="whitespace-pre-wrap break-words font-sans text-[12.5px] leading-relaxed text-foreground/90">
                            {markdown}
                        </pre>
                    ) : null}
                </div>
            ) : null}
        </li>
    )
}

function Stat({
    icon,
    value,
    accent,
}: {
    icon: React.ReactNode
    value: string
    accent?: boolean
}) {
    return (
        <span className={cn(
            "inline-flex items-center gap-1 tabular-nums",
            accent && "text-amber-700 dark:text-amber-400",
        )}>
            <span className="text-muted-foreground/65">{icon}</span>
            {value}
        </span>
    )
}
