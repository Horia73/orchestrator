"use client"

import * as React from "react"
import { History, Info, Trophy } from "lucide-react"

import { cn } from "@/lib/utils"
import type { Exercise, WorkoutUnits } from "@/lib/workout/schema"
import {
    formatDuration,
    formatSetSequence,
    formatWeight,
} from "@/lib/workout/format"

import { GlossaryInfo } from "./glossary-info"
import { MuscleChips } from "./muscle-chips"

/**
 * Header of one exercise card.
 *
 * Three rows of content:
 *   1. Name + (i) form-cue button (right) — name links nothing in Phase 1
 *   2. Muscle group chips
 *   3. Previous-session line ("Last: 60×8/8/7 @ RPE 9") + PB badge (right)
 *
 * The form-cue popover is rendered inline as a `<details>` for Phase 1
 * simplicity (no popover lib pulled in). Phase 2 can swap to a proper
 * Radix popover if the UX needs it.
 */
export function ExerciseHeader({
    exercise,
    units,
    className,
}: {
    exercise: Exercise
    units: WorkoutUnits
    className?: string
}) {
    const cues = exercise.formCues ?? []
    const hasContext = !!(exercise.previous || exercise.personalBest)

    return (
        <header className={cn("flex flex-col gap-1.5", className)}>
            <div className="flex items-start gap-2">
                <h3 className="min-w-0 flex-1 truncate text-base font-semibold leading-tight text-foreground">
                    {exercise.name}
                </h3>
                {cues.length > 0 || exercise.videoUrl ? (
                    <FormCuesPopover cues={cues} videoUrl={exercise.videoUrl} />
                ) : null}
            </div>
            <MuscleChips muscles={exercise.muscleGroups} />
            {hasContext ? (
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                    {exercise.previous ? (
                        <PreviousLine exercise={exercise} units={units} />
                    ) : null}
                    {exercise.personalBest ? (
                        <PrBadge pb={exercise.personalBest} units={units} />
                    ) : null}
                </div>
            ) : null}
        </header>
    )
}

function PreviousLine({ exercise, units }: { exercise: Exercise; units: WorkoutUnits }) {
    if (!exercise.previous) return null
    const seq = formatSetSequence(exercise.previous.allSets ?? [])
    const date = humanDate(exercise.previous.date)
    return (
        <div className="inline-flex items-center gap-1.5">
            <History className="size-3" strokeWidth={1.75} aria-hidden />
            <span>
                Last <span className="text-foreground/70">{date}</span>
                {seq ? <span className="ml-1 tabular-nums text-foreground/85">{withUnits(seq, exercise, units)}</span> : null}
            </span>
        </div>
    )
}

function withUnits(seq: string, exercise: Exercise, units: WorkoutUnits): string {
    // For weighted variants, append the unit after the first number block
    // so "60/60/57 × 8/8/7" reads as "60/60/57 kg × 8/8/7".
    if (exercise.kind === 'weighted' || exercise.kind === 'weighted_bw') {
        return seq.replace(' × ', ` ${units} × `)
    }
    return seq
}

function PrBadge({
    pb,
    units,
}: {
    pb: NonNullable<Exercise['personalBest']>
    units: WorkoutUnits
}) {
    const main = pb.weightKg !== undefined && pb.reps !== undefined
        ? `${formatWeight(pb.weightKg, units)} × ${pb.reps}`
        : pb.durationSec !== undefined
            ? formatDuration(pb.durationSec)
            : pb.reps !== undefined
                ? `${pb.reps} reps`
                : null
    if (!main) return null
    return (
        <div
            className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-300"
            title={`Personal best · ${humanDate(pb.achievedAt)}${pb.estimated1RM ? ` · est. 1RM ${pb.estimated1RM} ${units}` : ''}`}
        >
            <Trophy className="size-3" strokeWidth={2} aria-hidden />
            <span className="text-[11px] font-semibold tabular-nums">
                PB {main}
            </span>
            <GlossaryInfo term="pb" />
            {pb.estimated1RM ? (
                <span className="inline-flex items-center gap-0.5 text-[10px] tabular-nums opacity-75">
                    · 1RM ~{pb.estimated1RM}
                    <GlossaryInfo term="1rm" />
                </span>
            ) : null}
        </div>
    )
}

function FormCuesPopover({ cues, videoUrl }: { cues: string[]; videoUrl?: string }) {
    return (
        <details className="group/cues relative">
            <summary
                aria-label="Form cues"
                title="Form cues"
                className={cn(
                    "flex size-7 cursor-pointer list-none items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground transition-colors",
                    "hover:bg-muted hover:text-foreground",
                    "[&::-webkit-details-marker]:hidden",
                )}
            >
                <Info className="size-3.5" strokeWidth={1.75} />
            </summary>
            <div className="absolute right-0 top-full z-20 mt-1 w-72 rounded-lg border border-border/70 bg-popover p-3 text-[12.5px] shadow-lg">
                {cues.length > 0 ? (
                    <ul className="flex flex-col gap-1.5 text-foreground/85">
                        {cues.map((c, i) => (
                            <li key={i} className="leading-relaxed">
                                {c}
                            </li>
                        ))}
                    </ul>
                ) : null}
                {videoUrl ? (
                    <a
                        href={videoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                            "mt-2 inline-flex items-center gap-1 text-[11.5px] font-medium text-primary hover:underline",
                            cues.length === 0 && "mt-0",
                        )}
                    >
                        Watch demo →
                    </a>
                ) : null}
            </div>
        </details>
    )
}

function humanDate(iso: string): string {
    const d = new Date(iso + 'T00:00:00Z')
    if (Number.isNaN(d.getTime())) return iso
    const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
    if (days <= 0) return 'today'
    if (days === 1) return 'yesterday'
    if (days < 7) return `${days} days ago`
    if (days < 30) return `${Math.round(days / 7)}w ago`
    try {
        return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d)
    } catch {
        return iso
    }
}
