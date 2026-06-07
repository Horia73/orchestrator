"use client"

import * as React from "react"
import { CheckCircle2, Timer, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/workout/format"
import type { ActiveSetState } from "@/lib/workout/use-workout-session"

/**
 * Floating bottom working-set timer. A set is not logged from the row tap:
 * row tap starts this timer, Finish stops it, then the row expands an editor
 * where the user confirms actual weight/reps before Save logs the set.
 */
export function SetTimerBar({
    activeSet,
    onFinish,
    onCancel,
    className,
}: {
    activeSet: ActiveSetState
    onFinish: () => void
    onCancel: () => void
    className?: string
}) {
    const [now, setNow] = React.useState(() => Date.now())

    React.useEffect(() => {
        if (activeSet.finishedAt) return
        const id = window.setInterval(() => setNow(Date.now()), 250)
        return () => window.clearInterval(id)
    }, [activeSet.finishedAt, activeSet.key])

    const end = activeSet.finishedAt ?? now
    const elapsedSec = Math.max(0, Math.floor((end - activeSet.startedAt) / 1000))
    const isFinished = !!activeSet.finishedAt

    return (
        <div
            className={cn(
                "pointer-events-auto fixed inset-x-0 bottom-3 z-40 mx-auto w-[min(640px,calc(100vw-1.5rem))]",
                "animate-in slide-in-from-bottom-2 fade-in fill-mode-both duration-300",
                className,
            )}
            role="region"
            aria-label="Working set timer"
        >
            <div
                className={cn(
                    "overflow-hidden rounded-xl border bg-card shadow-2xl shadow-black/15",
                    isFinished ? "border-emerald-500/40" : "border-primary/35",
                )}
            >
                <div className="flex items-center gap-3 px-3.5 py-2.5">
                    <Timer
                        className={cn(
                            "size-4 shrink-0",
                            isFinished ? "text-emerald-500" : "text-primary motion-safe:animate-pulse",
                        )}
                        strokeWidth={1.85}
                        aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                            <span>{isFinished ? "Set finished" : "Set running"}</span>
                            <span aria-hidden>·</span>
                            <span className="truncate normal-case tracking-normal text-foreground/65">
                                {activeSet.exerciseName} · set {activeSet.setIndex + 1}
                            </span>
                        </div>
                        <div
                            className={cn(
                                "text-lg font-semibold tabular-nums leading-tight",
                                isFinished ? "text-emerald-600 dark:text-emerald-400" : "text-foreground",
                            )}
                        >
                            {formatDuration(elapsedSec)}
                        </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                        {!isFinished ? (
                            <button
                                type="button"
                                onClick={onFinish}
                                className={cn(
                                    "inline-flex h-9 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-[12px] font-semibold text-white transition-colors",
                                    "hover:bg-emerald-700",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2",
                                )}
                            >
                                <CheckCircle2 className="size-3.5" strokeWidth={2} />
                                Finish
                            </button>
                        ) : (
                            <div className="hidden text-right text-[11px] leading-tight text-muted-foreground sm:block">
                                Edit and save the set
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={onCancel}
                            aria-label="Cancel set timer"
                            title="Cancel set timer"
                            className={cn(
                                "flex size-9 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors",
                                "hover:bg-muted hover:text-foreground",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                        >
                            <X className="size-3.5" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
