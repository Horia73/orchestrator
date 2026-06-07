"use client"

import * as React from "react"
import { Plus } from "lucide-react"

import { cn } from "@/lib/utils"
import type { Exercise, PlannedSet, WorkoutUnits } from "@/lib/workout/schema"
import type { WorkoutSessionApi } from "@/lib/workout/use-workout-session"

import { WeightPicker } from "./weight-picker"
import { RepsPicker } from "./reps-picker"

/**
 * Mid-workout freestyle-set add. Visible only when the workout is active.
 *
 * Click opens a picker matched to the exercise kind:
 *   - weighted / weighted_bw → opens WeightPicker first, then RepsPicker
 *   - bodyweight → RepsPicker only
 *   - hold → simple seconds input (uses RepsPicker UI repurposed)
 *   - cardio / interval → picker is hidden; freestyle adds are skipped for
 *     these kinds in Phase 4 (rare ask — usually you just edit the planned
 *     interval count instead).
 *
 * Defaults seed from the LAST planned set so the user just confirms the
 * common case ("one more at the same weight"). The new set inherits the
 * planned kind so it visually matches the prior set's badge styling.
 */
export function AddSetButton({
    exercise,
    units,
    sessionApi,
    barKg,
    plates,
    className,
}: {
    exercise: Exercise
    units: WorkoutUnits
    sessionApi: WorkoutSessionApi
    barKg?: number
    plates?: readonly number[]
    className?: string
}) {
    void units
    const lastPlanned = exercise.planned[exercise.planned.length - 1] as unknown as Record<string, unknown>
    const supportsFreestyle = exercise.kind === 'weighted' || exercise.kind === 'weighted_bw' || exercise.kind === 'bodyweight'

    type Phase = 'idle' | 'weight' | 'reps'
    const [phase, setPhase] = React.useState<Phase>('idle')
    const [stagedWeight, setStagedWeight] = React.useState<number | null>(null)

    if (!supportsFreestyle) return null

    const handleStart = () => {
        if (exercise.kind === 'bodyweight') {
            setPhase('reps')
        } else {
            setPhase('weight')
        }
    }

    const handleWeightApplied = (kg: number) => {
        setStagedWeight(kg)
        setPhase('reps')
    }

    const handleRepsApplied = (reps: number) => {
        const planned: PlannedSet = (() => {
            if (exercise.kind === 'bodyweight') {
                return { kind: 'working', reps }
            }
            return {
                kind: 'working',
                weightKg: stagedWeight ?? (typeof lastPlanned.weightKg === 'number' ? lastPlanned.weightKg : 0),
                reps,
            } as PlannedSet
        })()
        sessionApi.addSet(exercise, planned)
        setStagedWeight(null)
        setPhase('idle')
    }

    const handleClose = () => {
        setStagedWeight(null)
        setPhase('idle')
    }

    const initialWeight =
        typeof lastPlanned.weightKg === 'number' ? lastPlanned.weightKg : 0
    const initialReps = (() => {
        const r = lastPlanned.reps
        if (typeof r === 'number') return r
        if (Array.isArray(r)) return (r as [number, number])[1]
        return 8
    })()

    return (
        <div className={cn("relative flex justify-start", className)}>
            <button
                type="button"
                onClick={handleStart}
                className={cn(
                    "group/add-set inline-flex items-center gap-1.5 rounded-md border border-dashed border-border bg-background/45 px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground transition-colors",
                    "hover:border-primary/40 hover:bg-primary/[0.05] hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
            >
                <Plus className="size-3" strokeWidth={2} />
                Add set
            </button>

            {phase === 'weight' && (
                <div className="absolute left-0 top-full z-30 mt-1">
                    <WeightPicker
                        initialKg={stagedWeight ?? initialWeight}
                        barKg={barKg}
                        plates={plates}
                        reps={initialReps}
                        onApply={handleWeightApplied}
                        onClose={handleClose}
                    />
                </div>
            )}

            {phase === 'reps' && (
                <div className="absolute left-0 top-full z-30 mt-1">
                    <RepsPicker
                        initialReps={initialReps}
                        plannedRange={typeof lastPlanned.reps === 'number' || Array.isArray(lastPlanned.reps) ? (lastPlanned.reps as number | [number, number]) : undefined}
                        onApply={handleRepsApplied}
                        onClose={handleClose}
                    />
                </div>
            )}
        </div>
    )
}
