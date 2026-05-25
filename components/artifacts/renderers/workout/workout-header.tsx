"use client"

import * as React from "react"
import { Clock, Flame, Calendar } from "lucide-react"

import { cn } from "@/lib/utils"
import type { WorkoutArtifact } from "@/lib/workout/schema"
import { formatDifficulty, formatMinutes } from "@/lib/workout/format"

import { EquipmentChips } from "./equipment-chips"

/**
 * Top of the workout card: title, optional subtitle, program tag, and a
 * meta strip with time + difficulty + equipment chips.
 *
 * Program tag (when present) shows "Stronglifts · Week 4 · Day B" as a
 * subtle accented pill above the title.
 *
 * Equipment chips aggregate all unique equipment across every exercise
 * in the workout so the user knows what to bring without scrolling.
 */
export function WorkoutHeader({
    workout,
    className,
}: {
    workout: WorkoutArtifact
    className?: string
}) {
    const aggregateEquipment = React.useMemo(() => {
        const seen = new Set<string>()
        const ordered: string[] = []
        for (const group of workout.groups) {
            for (const ex of group.exercises) {
                for (const eq of ex.equipment ?? []) {
                    if (!seen.has(eq)) {
                        seen.add(eq)
                        ordered.push(eq)
                    }
                }
            }
        }
        return ordered as readonly import("@/lib/workout/schema").WorkoutEquipment[]
    }, [workout])

    const metas: Array<{ key: string; icon: React.ReactNode; label: string }> = []
    if (workout.estimatedDurationMin) {
        metas.push({
            key: 'time',
            icon: <Clock className="size-3.5" aria-hidden />,
            label: formatMinutes(workout.estimatedDurationMin),
        })
    }
    if (workout.difficulty) {
        metas.push({
            key: 'difficulty',
            icon: <Flame className="size-3.5" aria-hidden />,
            label: formatDifficulty(workout.difficulty),
        })
    }
    if (workout.generatedAt) {
        const date = formatGeneratedDate(workout.generatedAt)
        if (date) {
            metas.push({
                key: 'date',
                icon: <Calendar className="size-3.5" aria-hidden />,
                label: date,
            })
        }
    }

    return (
        <header className={cn("flex flex-col gap-2.5", className)}>
            {workout.program ? <ProgramPill program={workout.program} /> : null}
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {workout.title}
            </h1>
            {workout.subtitle ? (
                <p className="text-sm text-muted-foreground leading-relaxed">
                    {workout.subtitle}
                </p>
            ) : null}
            {metas.length > 0 ? (
                <dl className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                    {metas.map((m) => (
                        <div key={m.key} className="inline-flex items-center gap-1.5">
                            {m.icon}
                            <span>{m.label}</span>
                        </div>
                    ))}
                </dl>
            ) : null}
            {aggregateEquipment.length > 0 ? (
                <EquipmentChips equipment={aggregateEquipment} className="mt-0.5" />
            ) : null}
        </header>
    )
}

function ProgramPill({ program }: { program: NonNullable<WorkoutArtifact['program']> }) {
    const parts: string[] = [program.name]
    if (program.week !== undefined) parts.push(`Week ${program.week}`)
    if (program.day !== undefined) parts.push(`Day ${program.day}`)
    return (
        <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-primary">
            {parts.join(' · ')}
        </div>
    )
}

function formatGeneratedDate(iso: string): string | null {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    try {
        return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d)
    } catch {
        return d.toISOString().slice(0, 10)
    }
}
