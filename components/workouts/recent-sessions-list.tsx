"use client"

import * as React from "react"
import { Calendar, ChevronDown, Clock, ListChecks, Timer, Trophy, Weight } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/workout/format"
import { useIdlePrefetch } from "@/hooks/use-idle-prefetch"
import { Collapse } from "@/components/ui/collapse"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { SectionEmpty } from "@/components/workouts/section-card"

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
    /** Present only on sessions logged after the rest-analytics change. */
    restSummary?: {
        totalRestSec: number
        avgRestSec?: number
        plannedAvgRestSec?: number
        skippedCount: number
    }
    /** Completed sets per targeted muscle group; feeds the muscle-balance view. */
    muscleBreakdown?: Array<{ group: string; sets: number }>
}

const VISIBLE_DEFAULT = 8

/**
 * Recent sessions list inside the Workouts tab. Rendered as divided rows
 * inside the parent SectionCard (no per-row borders — one container, one
 * border, like the rest of the Library lists).
 *
 * Each row is collapsible: header shows the highlights, click to expand
 * and fetch the full markdown summary from /api/workouts/sessions/:slug.
 * Long histories collapse to the first few rows with a "Show all" footer.
 *
 * Expansion is smooth-by-default: each row warms its summary on idle (see
 * useIdlePrefetch) so the content is already in the DOM, then the panel eases
 * open with the height-animated Collapse straight to the real height — no
 * "Loading…" text, no spinner (the sub-100ms local fetch made any spinner a
 * flicker), and no height jitter. If a row is somehow tapped before prefetch we
 * reveal once content arrives. On fetch error the row shows it inline + retry.
 */
export function RecentSessionsList({
    sessions,
    className,
}: {
    sessions: SessionSummaryRow[]
    className?: string
}) {
    const [showAll, setShowAll] = React.useState(false)

    if (sessions.length === 0) {
        return (
            <SectionEmpty>
                No saved workouts yet. Start a session from chat and tap <span className="font-medium text-foreground">Finish workout</span> to see it here.
            </SectionEmpty>
        )
    }

    const visible = showAll ? sessions : sessions.slice(0, VISIBLE_DEFAULT)
    return (
        <div className={cn("flex flex-col", className)}>
            <ul className="divide-y divide-border/45">
                {visible.map((s) => (
                    <SessionRow key={s.slug} session={s} />
                ))}
            </ul>
            {sessions.length > VISIBLE_DEFAULT ? (
                <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="border-t border-border/45 py-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                >
                    {showAll ? "Show fewer" : `Show all ${sessions.length}`}
                </button>
            ) : null}
        </div>
    )
}

function SessionRow({ session }: { session: SessionSummaryRow }) {
    const [open, setOpen] = React.useState(false)
    const [markdown, setMarkdown] = React.useState<string | null>(null)
    const [error, setError] = React.useState<string | null>(null)
    const inflight = React.useRef<Promise<void> | null>(null)

    // Fetch the summary once and cache it. Dedupes concurrent calls (idle
    // prefetch + a fast tap) onto one in-flight promise so a tap never reveals
    // an empty panel mid-fetch. Never rejects — errors land in `error` state.
    const load = React.useCallback(() => {
        if (markdown !== null) return Promise.resolve()
        if (inflight.current) return inflight.current
        const run = (async () => {
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
                inflight.current = null
            }
        })()
        inflight.current = run
        return run
    }, [markdown, session.slug])

    // Warm the summary on idle so the content is already in the DOM (clipped)
    // by the time the row is tapped — the panel then just eases open.
    useIdlePrefetch(load)

    const onToggle = React.useCallback(() => {
        if (open) {
            setOpen(false)
            return
        }
        if (markdown !== null || error !== null) {
            setOpen(true)
            return
        }
        // Tapped before the prefetch landed — reveal once content arrives.
        void load().then(() => setOpen(true))
    }, [open, markdown, error, load])

    const date = session.startedAt.slice(0, 10)
    return (
        <li>
            <button
                type="button"
                onClick={() => void onToggle()}
                className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
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
                        {session.restSummary?.avgRestSec ? (
                            <Stat
                                icon={<Timer className="size-3" />}
                                value={`${formatDuration(Math.round(session.restSummary.avgRestSec))} rest${
                                    session.restSummary.skippedCount
                                        ? ` · ${session.restSummary.skippedCount} skip`
                                        : ''
                                }`}
                            />
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
                    <ChevronDown
                        className={cn(
                            "size-4 transition-transform duration-300 ease-out motion-reduce:transition-none",
                            open && "rotate-180",
                        )}
                    />
                </span>
            </button>
            <Collapse open={open}>
                <div
                    className={cn(
                        "border-t border-border/45 bg-muted/15 px-4 py-3 transition-opacity duration-200 ease-out motion-reduce:transition-none",
                        open ? "opacity-100" : "opacity-0",
                    )}
                >
                    {error ? (
                        <div className="text-[12px] text-rose-500">
                            {error} · <button onClick={() => void load().then(() => setOpen(true))} className="underline">retry</button>
                        </div>
                    ) : markdown ? (
                        <div className="text-[12.5px] text-foreground/90">
                            <MarkdownRenderer content={markdown} compact />
                        </div>
                    ) : null}
                </div>
            </Collapse>
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
