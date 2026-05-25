"use client"

import * as React from "react"
import { Repeat } from "lucide-react"

import { cn } from "@/lib/utils"
import type { ExerciseGroup, WorkoutUnits } from "@/lib/workout/schema"
import { formatDuration, formatGroupKind } from "@/lib/workout/format"
import type { WorkoutSessionApi } from "@/lib/workout/use-workout-session"

import { ExerciseCard } from "./exercise-card"
import { GlossaryInfo } from "./glossary-info"

/**
 * Wraps one ExerciseGroup. Straight groups render bare (just the single
 * exercise card); superset / circuit / giant_set groups get a labelled
 * container with a rounds badge so the structure is visible at a glance.
 */
export function GroupCard({
    group,
    index,
    units,
    sessionApi,
    interactive = false,
    barKg,
    plates,
    className,
}: {
    group: ExerciseGroup
    /** 1-based index in the workout. */
    index: number
    units: WorkoutUnits
    sessionApi?: WorkoutSessionApi
    interactive?: boolean
    barKg?: number
    plates?: readonly number[]
    className?: string
}) {
    const isCompound = group.kind !== 'straight' || group.exercises.length > 1
    if (!isCompound) {
        return (
            <ExerciseCard
                exercise={group.exercises[0]}
                units={units}
                sessionApi={sessionApi}
                interactive={interactive}
                barKg={barKg}
                plates={plates}
                className={className}
            />
        )
    }

    const kindLabel = group.label ?? autoLabel(group.kind, index)
    const accentClass = groupAccentClass(group.kind)

    return (
        <section
            className={cn(
                "rounded-xl border border-l-4 bg-card/40 px-3 py-3 shadow-sm",
                accentClass,
                className,
            )}
            aria-label={kindLabel}
        >
            <header className="mb-2.5 flex items-center justify-between gap-2 px-1">
                <h3 className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-foreground/75">
                    {kindLabel}
                    <GlossaryInfo term={group.kind} />
                </h3>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    {group.rounds ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-border/55 bg-background px-2 py-0.5 tabular-nums">
                            <Repeat className="size-3" strokeWidth={1.85} aria-hidden />
                            {group.rounds}×
                        </span>
                    ) : null}
                    {group.restBetweenSec !== undefined ? (
                        <span className="tabular-nums">
                            Rest {formatDuration(group.restBetweenSec)}
                        </span>
                    ) : null}
                </div>
            </header>
            <div className="flex flex-col gap-2.5">
                {group.exercises.map((ex, i) => (
                    <ExerciseCard
                        key={ex.id || i}
                        exercise={ex}
                        units={units}
                        sessionApi={sessionApi}
                        interactive={interactive}
                        barKg={barKg}
                        plates={plates}
                        className="border-border/40 bg-background/65"
                    />
                ))}
            </div>
        </section>
    )
}

function autoLabel(kind: string, index: number): string {
    const base = formatGroupKind(kind) || kind
    const alpha = String.fromCharCode(65 + ((index - 1) % 26))
    return `${base} ${alpha}`
}

function groupAccentClass(kind: string): string {
    switch (kind) {
        case 'superset':
            return 'border-l-violet-500/60 border-border/45'
        case 'circuit':
            return 'border-l-sky-500/60 border-border/45'
        case 'giant_set':
            return 'border-l-rose-500/60 border-border/45'
        default:
            return 'border-border/45'
    }
}
