"use client"

import * as React from "react"
import { History, Info, Replace, Trophy } from "lucide-react"

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
    const alternatives = exercise.alternatives ?? []
    const hasContext = !!(exercise.previous || exercise.personalBest)

    return (
        <header className={cn("flex flex-col gap-1.5", className)}>
            <div className="flex items-start gap-2">
                <h3 className="min-w-0 flex-1 truncate text-base font-semibold leading-tight text-foreground">
                    {exercise.name}
                </h3>
                {cues.length > 0 || alternatives.length > 0 || exercise.videoUrl || exercise.description || exercise.imageUrl || exercise.imageQuery ? (
                    <FormCuesPopover
                        exerciseName={exercise.name}
                        cues={cues}
                        description={exercise.description}
                        imageUrl={exercise.imageUrl}
                        imageQuery={exercise.imageQuery}
                        videoUrl={exercise.videoUrl}
                        alternatives={alternatives}
                    />
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

function FormCuesPopover({
    exerciseName,
    cues,
    description,
    imageUrl,
    imageQuery,
    videoUrl,
    alternatives,
}: {
    exerciseName: string
    cues: string[]
    description?: string
    imageUrl?: string
    imageQuery?: string
    videoUrl?: string
    alternatives?: string[]
}) {
    const hasAlternatives = alternatives && alternatives.length > 0
    const [open, setOpen] = React.useState(false)
    return (
        <details
            className="group/cues relative"
            open={open}
            onToggle={(event) => setOpen(event.currentTarget.open)}
        >
            <summary
                aria-label="Exercise info"
                title="Exercise info"
                className={cn(
                    "flex size-7 cursor-pointer list-none items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground transition-colors",
                    "hover:bg-muted hover:text-foreground",
                    "[&::-webkit-details-marker]:hidden",
                )}
            >
                <Info className="size-3.5" strokeWidth={1.75} />
            </summary>
            <div className="absolute right-0 top-full z-20 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border/70 bg-popover p-3 text-[12.5px] shadow-lg">
                {open ? (
                    <ExerciseDemoImage
                        exerciseName={exerciseName}
                        imageUrl={imageUrl}
                        imageQuery={imageQuery}
                    />
                ) : null}
                {description ? (
                    <p className="mb-3 text-[12.5px] leading-relaxed text-foreground/85">
                        {description}
                    </p>
                ) : null}
                {cues.length > 0 ? (
                    <>
                        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-foreground/55">
                            Form cues
                        </div>
                        <ul className="flex flex-col gap-1.5 text-foreground/85">
                            {cues.map((c, i) => (
                                <li key={i} className="leading-relaxed">
                                    {c}
                                </li>
                            ))}
                        </ul>
                    </>
                ) : null}
                {hasAlternatives ? (
                    <>
                        <div className={cn(
                            "mb-1 inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-foreground/55",
                            cues.length > 0 && "mt-3",
                        )}>
                            <Replace className="size-3" strokeWidth={2} aria-hidden />
                            Alternatives
                        </div>
                        <ul className="flex flex-col gap-1 text-foreground/85">
                            {alternatives!.map((a, i) => (
                                <li
                                    key={i}
                                    className="rounded bg-muted/55 px-2 py-1 text-[12px] leading-snug"
                                >
                                    {a}
                                </li>
                            ))}
                        </ul>
                    </>
                ) : null}
                {videoUrl ? (
                    <a
                        href={videoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                            "mt-2 inline-flex items-center gap-1 text-[11.5px] font-medium text-primary hover:underline",
                            cues.length === 0 && !hasAlternatives && "mt-0",
                        )}
                    >
                        Watch demo →
                    </a>
                ) : null}
            </div>
        </details>
    )
}

interface WorkoutImage {
    url: string
    sourceUrl: string
    attribution: string
    width: number
    height: number
}

interface WorkoutImageResponse {
    images?: WorkoutImage[]
}

function ExerciseDemoImage({
    exerciseName,
    imageUrl,
    imageQuery,
}: {
    exerciseName: string
    imageUrl?: string
    imageQuery?: string
}) {
    const [result, setResult] = React.useState<WorkoutImage | null>(
        imageUrl ? {
            url: imageUrl,
            sourceUrl: imageUrl,
            attribution: 'Demo image',
            width: 16,
            height: 9,
        } : null,
    )
    const [failed, setFailed] = React.useState(false)
    const [imageBroken, setImageBroken] = React.useState(false)
    const query = imageQuery ?? `${exerciseName} exercise machine`
    const [fallbackReady, setFallbackReady] = React.useState(false)

    React.useEffect(() => {
        if (imageUrl || failed) return
        const controller = new AbortController()
        fetch(`/api/workout-images?q=${encodeURIComponent(query)}&limit=1`, { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                const data = await response.json() as WorkoutImageResponse
                setResult(data.images?.[0] ?? null)
            })
            .catch((error) => {
                if (error instanceof DOMException && error.name === 'AbortError') return
                setFailed(true)
            })
        return () => controller.abort()
    }, [query, imageUrl, failed])

    React.useEffect(() => {
        if (imageUrl || result) return
        const timer = window.setTimeout(() => setFallbackReady(true), 1200)
        return () => window.clearTimeout(timer)
    }, [imageUrl, result, query])

    const display = result ?? (fallbackReady ? {
        url: `/api/workout-images/first?q=${encodeURIComponent(query)}`,
        sourceUrl: `https://commons.wikimedia.org/w/index.php?search=${encodeURIComponent(query)}&title=Special:MediaSearch&type=image`,
        attribution: 'Wikimedia Commons',
        width: 16,
        height: 9,
    } satisfies WorkoutImage : null)

    if (!display || imageBroken) return null

    const ratio = display.width > 0 && display.height > 0
        ? `${display.width} / ${display.height}`
        : '16 / 9'

    return (
        <figure className="mb-3 overflow-hidden rounded-md border border-border/50 bg-muted/35">
            {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary Commons/uploaded URLs are lazy previews, not LCP content. */}
            <img
                src={display.url}
                alt={`${exerciseName} demo`}
                loading="lazy"
                className="block w-full object-cover"
                style={{ aspectRatio: ratio }}
                onError={() => setImageBroken(true)}
            />
            <figcaption className="flex items-center justify-between gap-2 px-2 py-1 text-[10px] text-muted-foreground">
                <span className="min-w-0 truncate">{display.attribution}</span>
                <a
                    href={display.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-primary hover:underline"
                >
                    source
                </a>
            </figcaption>
        </figure>
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
