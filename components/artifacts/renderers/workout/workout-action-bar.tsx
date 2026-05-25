"use client"

import * as React from "react"
import { CheckCircle, Play, RotateCcw } from "lucide-react"

import { cn } from "@/lib/utils"
import type { WorkoutSessionApi } from "@/lib/workout/use-workout-session"

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
        // Top placement shows only a slim reset link during active session.
        return (
            <div className={cn("flex items-center justify-end gap-2", className)}>
                <button
                    type="button"
                    onClick={reset}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
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
            className={cn(
                "flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-transform",
                "hover:opacity-95 active:scale-[0.99]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2",
                className,
            )}
        >
            <CheckCircle className="size-4" strokeWidth={2} />
            Finish workout
        </button>
    )
}
