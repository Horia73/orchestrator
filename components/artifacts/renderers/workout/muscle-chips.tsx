"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import type { MuscleGroup } from "@/lib/workout/schema"

/**
 * Compact muscle-group chip row under an exercise name.
 *
 * Color coding is by macro-group (push / pull / lower / core / cardio) so
 * the user gets a fast visual cue when scanning a workout — push days look
 * blueish, lower days look greenish, etc. The mapping is intentionally soft
 * (low saturation) so it doesn't fight the rest of the UI.
 */
export function MuscleChips({
    muscles,
    className,
}: {
    muscles: readonly MuscleGroup[]
    className?: string
}) {
    if (!muscles.length) return null
    return (
        <div className={cn("flex flex-wrap items-center gap-1", className)}>
            {muscles.map((m) => (
                <span
                    key={m}
                    className={cn(
                        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium tracking-tight",
                        muscleColorClass(m),
                    )}
                >
                    {MUSCLE_LABEL[m] ?? m}
                </span>
            ))}
        </div>
    )
}

function muscleColorClass(m: MuscleGroup): string {
    switch (m) {
        // Push — blue
        case 'chest':
        case 'front_delt':
        case 'side_delt':
        case 'triceps':
            return 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
        // Pull — violet
        case 'lats':
        case 'mid_back':
        case 'traps':
        case 'rhomboids':
        case 'biceps':
        case 'forearms':
        case 'rear_delt':
            return 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
        // Lower — emerald
        case 'quads':
        case 'hamstrings':
        case 'glutes':
        case 'calves':
        case 'adductors':
        case 'abductors':
            return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        // Core — amber
        case 'abs':
        case 'obliques':
        case 'lower_back':
            return 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
        // Cardio / full body — slate
        case 'cardio':
        case 'full_body':
            return 'bg-slate-500/10 text-slate-700 dark:text-slate-300'
        default:
            return 'bg-muted text-muted-foreground'
    }
}

const MUSCLE_LABEL: Partial<Record<MuscleGroup, string>> = {
    chest: 'Chest',
    front_delt: 'Front Delt',
    side_delt: 'Side Delt',
    rear_delt: 'Rear Delt',
    triceps: 'Triceps',
    lats: 'Lats',
    mid_back: 'Mid Back',
    traps: 'Traps',
    rhomboids: 'Rhomboids',
    biceps: 'Biceps',
    forearms: 'Forearms',
    quads: 'Quads',
    hamstrings: 'Hamstrings',
    glutes: 'Glutes',
    calves: 'Calves',
    adductors: 'Adductors',
    abductors: 'Abductors',
    abs: 'Abs',
    obliques: 'Obliques',
    lower_back: 'Lower Back',
    full_body: 'Full Body',
    cardio: 'Cardio',
}
