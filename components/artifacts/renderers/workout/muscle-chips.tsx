"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import type { MuscleGroup } from "@/lib/workout/schema"
import { MACRO_CHIP_CLASS, muscleLabel, muscleMacro } from "@/lib/workout/muscles"

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
                        MACRO_CHIP_CLASS[muscleMacro(m)],
                    )}
                >
                    {muscleLabel(m)}
                </span>
            ))}
        </div>
    )
}
