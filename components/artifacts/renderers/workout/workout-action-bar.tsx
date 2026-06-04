"use client"

import * as React from "react"
import { CheckCircle, Play, RotateCcw, Save, Timer } from "lucide-react"

import { cn } from "@/lib/utils"
import type { WorkoutSessionApi } from "@/lib/workout/use-workout-session"
import type { Exercise, WorkoutArtifact } from "@/lib/workout/schema"

/**
 * Top / bottom action bar.
 *
 * Renders one of three states:
 *   - Not started:     "Start workout" CTA (full-width, prominent)
 *   - In progress:     "Finish" + "Reset" (compact, secondary buttons)
 *   - Finished:        "Start again" CTA + finished badge
 *
 * Placement is up to the parent — typically once at the top under the
 * stats row, and again at the bottom after the cooldown.
 */
export function WorkoutActionBar({
    sessionApi,
    placement,
    className,
}: {
    sessionApi: WorkoutSessionApi
    placement: 'top' | 'bottom'
    className?: string
}) {
    const { isActive, isFinished, start, finish, reset } = sessionApi
    const activeSet = sessionApi.session.activeSet

    if (isFinished) {
        if (placement === 'top') {
            return (
                <div
                    className={cn(
                        "flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5",
                        className,
                    )}
                >
                    <CheckCircle className="size-4 text-emerald-600 dark:text-emerald-400" strokeWidth={1.85} />
                    <span className="text-[12.5px] font-medium text-emerald-700 dark:text-emerald-300">
                        Sesiune terminată
                    </span>
                    <button
                        type="button"
                        onClick={reset}
                        className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                        <RotateCcw className="size-3" />
                        Pornește din nou
                    </button>
                </div>
            )
        }
        return null
    }

    if (!isActive) {
        if (placement === 'bottom') return null
        return (
            <button
                type="button"
                onClick={start}
                className={cn(
                    "group/start flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition-transform",
                    "hover:opacity-95 active:scale-[0.99]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    className,
                )}
            >
                <Play className="size-4 fill-current" strokeWidth={2} />
                Start workout
            </button>
        )
    }

    // Active (between start and finish).
    if (placement === 'top') {
        return (
            <div className={cn("flex flex-col gap-2", className)}>
                <NextSetPanel sessionApi={sessionApi} />
                <button
                    type="button"
                    onClick={reset}
                    className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Discard session"
                >
                    <RotateCcw className="size-3" />
                    Discard
                </button>
            </div>
        )
    }

    return (
        <button
            type="button"
            onClick={finish}
            disabled={!!activeSet}
            title={activeSet ? "Salvează sau anulează setul curent înainte de Finish workout" : undefined}
            className={cn(
                "flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-transform",
                "hover:opacity-95 active:scale-[0.99]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2",
                "disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:hover:opacity-100 disabled:active:scale-100",
                className,
            )}
        >
            <CheckCircle className="size-4" strokeWidth={2} />
            {activeSet ? "Salvează setul curent" : "Finish workout"}
        </button>
    )
}

function NextSetPanel({ sessionApi }: { sessionApi: WorkoutSessionApi }) {
    const activeSet = sessionApi.session.activeSet
    const rest = sessionApi.session.rest
    const nextSet = sessionApi.nextSet
    const nextExercise = nextSet ? findExercise(sessionApi.workout, nextSet.exerciseId) : null
    const canStartNext = !!nextSet && !!nextExercise && !activeSet

    const state = (() => {
        if (activeSet?.finishedAt) return 'save'
        if (activeSet) return 'running'
        if (rest) return 'rest'
        if (canStartNext) return 'next'
        return 'done'
    })()

    const icon = state === 'running' || state === 'rest'
        ? <Timer className="size-4" strokeWidth={1.85} />
        : state === 'save'
            ? <Save className="size-4" strokeWidth={1.85} />
            : <Play className="size-4 fill-current" strokeWidth={2} />

    const title = (() => {
        if (activeSet) return `${activeSet.exerciseName} · set ${activeSet.setIndex + 1}`
        if (nextSet) return `${nextSet.exerciseName} · set ${nextSet.setIndex + 1}`
        return 'Toate seturile planificate sunt parcurse'
    })()

    const helper = (() => {
        if (state === 'running') return 'Setul rulează jos. Apasă Finish când ai terminat.'
        if (state === 'save') return 'Confirmă valorile actuale și salvează setul înainte de următorul.'
        if (state === 'rest') return 'Pauză activă. Dacă pornești următorul set, pauza se închide automat.'
        if (state === 'done') return 'Poți termina workout-ul din butonul de jos.'
        return 'Pornește de aici ca să mergi secvențial, fără să sari accidental.'
    })()

    const buttonLabel = (() => {
        if (state === 'running') return 'În lucru'
        if (state === 'save') return 'Salvează setul'
        if (state === 'rest') return 'Start next'
        if (state === 'done') return 'Gata'
        return 'Pornește next'
    })()

    return (
        <div className="rounded-xl border border-primary/20 bg-primary/[0.04] px-3 py-2.5">
            <div className="flex items-center gap-3">
                <span
                    className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-full",
                        state === 'save'
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : state === 'running' || state === 'rest'
                                ? "bg-primary/12 text-primary"
                                : "bg-muted text-muted-foreground",
                    )}
                >
                    {icon}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {state === 'rest' ? 'Pauză activă' : state === 'done' ? 'Gata' : 'Următorul pas'}
                    </div>
                    <div className="truncate text-sm font-semibold text-foreground">{title}</div>
                    <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{helper}</div>
                </div>
                <button
                    type="button"
                    disabled={!canStartNext}
                    onClick={() => {
                        if (!nextExercise || !nextSet) return
                        sessionApi.startSet(nextExercise, nextSet.setIndex)
                    }}
                    className={cn(
                        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-semibold text-primary-foreground transition-colors",
                        "hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        "disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:hover:opacity-100",
                    )}
                >
                    <Play className="size-3.5 fill-current" strokeWidth={2} />
                    <span className="hidden sm:inline">{buttonLabel}</span>
                    <span className="sm:hidden">Next</span>
                </button>
            </div>
        </div>
    )
}

function findExercise(workout: WorkoutArtifact, exerciseId: string): Exercise | null {
    for (const group of workout.groups) {
        const exercise = group.exercises.find((candidate) => candidate.id === exerciseId)
        if (exercise) return exercise
    }
    return null
}
