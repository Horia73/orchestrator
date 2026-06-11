"use client"

import * as React from "react"
import { Scale } from "lucide-react"

import { cn } from "@/lib/utils"
import { MACRO_BAR_CLASS, MACRO_LABEL, muscleLabel, muscleMacro, type MuscleMacro } from "@/lib/workout/muscles"
import { SectionCard, SectionEmpty } from "@/components/workouts/section-card"

const DAY_MS = 86_400_000

export interface MuscleBalanceSession {
    startedAt: string
    muscleBreakdown?: Array<{ group: string; sets: number }>
}

type Window = 7 | 30

/**
 * Weekly (or 30-day) sets-per-muscle-group breakdown, aggregated from session
 * muscle data. Each completed set counts toward every muscle the exercise
 * targets — the standard volume-landmark convention. Bars are colored by macro
 * group (push / pull / legs / core) so imbalances pop visually.
 */
export function MuscleBalance({
    sessions,
    className,
}: {
    sessions: MuscleBalanceSession[]
    className?: string
}) {
    const [windowDays, setWindowDays] = React.useState<Window>(7)
    // Captured once at mount so the window doesn't shift on every render.
    const [nowMs] = React.useState(() => Date.now())

    const rows = React.useMemo(() => {
        const cutoff = nowMs - windowDays * DAY_MS
        const byGroup = new Map<string, number>()
        for (const session of sessions) {
            const ms = new Date(session.startedAt).getTime()
            if (!Number.isFinite(ms) || ms < cutoff) continue
            for (const entry of session.muscleBreakdown ?? []) {
                if (entry.sets > 0) byGroup.set(entry.group, (byGroup.get(entry.group) ?? 0) + entry.sets)
            }
        }
        return Array.from(byGroup, ([group, sets]) => ({ group, sets }))
            .sort((a, b) => b.sets - a.sets)
    }, [sessions, windowDays, nowMs])

    const max = rows.length > 0 ? rows[0].sets : 0
    const totalSets = rows.reduce((sum, r) => sum + r.sets, 0)
    const macrosPresent = React.useMemo(() => {
        const seen = new Set<MuscleMacro>()
        for (const row of rows) seen.add(muscleMacro(row.group))
        // Stable legend order regardless of which macro tops the list.
        return (Object.keys(MACRO_LABEL) as MuscleMacro[]).filter((m) => seen.has(m))
    }, [rows])

    return (
        <SectionCard
            title="Muscle balance"
            icon={<Scale className="size-3.5" strokeWidth={2} />}
            actions={
                <div className="inline-flex rounded-md border border-border bg-background p-0.5">
                    {([7, 30] as const).map((w) => (
                        <button
                            key={w}
                            type="button"
                            onClick={() => setWindowDays(w)}
                            className={cn(
                                "rounded px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors",
                                windowDays === w
                                    ? "bg-muted text-foreground"
                                    : "text-muted-foreground hover:text-foreground",
                            )}
                        >
                            {w}d
                        </button>
                    ))}
                </div>
            }
            className={className}
        >
            {rows.length === 0 ? (
                <SectionEmpty>
                    No sets logged in the last {windowDays} days. Finished sessions feed this breakdown.
                </SectionEmpty>
            ) : (
                <div className="flex flex-col gap-2 px-4 py-3.5">
                    <ul className="flex flex-col gap-1.5">
                        {rows.map((row) => {
                            const macro = muscleMacro(row.group)
                            return (
                                <li key={row.group} className="flex items-center gap-2.5">
                                    <span className="w-[88px] shrink-0 truncate text-[12px] text-foreground/80">
                                        {muscleLabel(row.group)}
                                    </span>
                                    <div className="h-3.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/50">
                                        <div
                                            className={cn("h-full rounded-full", MACRO_BAR_CLASS[macro])}
                                            style={{ width: `${Math.max(6, (row.sets / max) * 100)}%` }}
                                        />
                                    </div>
                                    <span className="w-7 shrink-0 text-right text-[12px] font-semibold tabular-nums text-foreground">
                                        {row.sets}
                                    </span>
                                </li>
                            )
                        })}
                    </ul>
                    <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            {macrosPresent.map((macro) => (
                                <span key={macro} className="inline-flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                                    <span className={cn("size-2 rounded-full", MACRO_BAR_CLASS[macro])} />
                                    {MACRO_LABEL[macro]}
                                </span>
                            ))}
                        </div>
                        <p className="text-[10.5px] tabular-nums text-muted-foreground/75">
                            {totalSets} working sets · {rows.length} muscle group{rows.length === 1 ? "" : "s"}
                        </p>
                    </div>
                </div>
            )}
        </SectionCard>
    )
}
