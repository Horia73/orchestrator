"use client"

import * as React from "react"
import { CheckCircle, Play, RotateCcw, SkipForward } from "lucide-react"

import { cn } from "@/lib/utils"
import type { WorkoutSessionApi, WorkoutSetRef } from "@/lib/workout/use-workout-session"

/**
 * Session action bar.
 *
 * The renderer mounts this once as a fixed bottom control. Row taps are free
 * order; this bar owns only session-level start/finish/discard.
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
    const hasFloatingTimer = !!activeSet || !!sessionApi.session.rest
    const [finishEarlySets, setFinishEarlySets] = React.useState<WorkoutSetRef[] | null>(null)

    if (placement === 'top' || isFinished) return null

    const shellClass = cn(
        "pointer-events-auto fixed inset-x-0 z-30 mx-auto w-[min(640px,calc(100vw-1.5rem))]",
        "animate-in slide-in-from-bottom-2 fade-in fill-mode-both duration-300",
        hasFloatingTimer ? "bottom-[5.75rem]" : "bottom-3",
        className,
    )

    if (!isActive) {
        return (
            <div className={shellClass} role="region" aria-label="Workout session controls">
                <button
                    type="button"
                    onClick={start}
                    className={cn(
                        "group/start flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-2xl shadow-black/15 transition-transform",
                        "hover:opacity-95 active:scale-[0.99]",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    )}
                >
                    <Play className="size-4 fill-current" strokeWidth={2} />
                    Start workout
                </button>
            </div>
        )
    }

    const handleFinish = () => {
        if (activeSet) return
        if (sessionApi.remainingSets.length > 0) {
            setFinishEarlySets(sessionApi.remainingSets)
            return
        }
        finish()
    }

    return (
        <>
            <div className={shellClass} role="region" aria-label="Workout session controls">
                <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-card p-2 shadow-2xl shadow-black/15">
                    <button
                        type="button"
                        onClick={reset}
                        className={cn(
                            "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-[12px] font-medium text-muted-foreground transition-colors",
                            "hover:bg-muted hover:text-foreground",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                        title="Discard session"
                    >
                        <RotateCcw className="size-3.5" />
                        <span className="hidden sm:inline">Discard</span>
                    </button>
                    <button
                        type="button"
                        onClick={handleFinish}
                        disabled={!!activeSet}
                        title={activeSet ? "Salvează sau anulează setul curent înainte de Finish workout" : undefined}
                        className={cn(
                            "flex h-10 min-w-0 flex-1 items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 text-sm font-semibold text-white transition-transform",
                            "hover:bg-emerald-700 active:scale-[0.99]",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2",
                            "disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:hover:bg-muted disabled:active:scale-100",
                        )}
                    >
                        <CheckCircle className="size-4" strokeWidth={2} />
                        {activeSet ? "Salvează setul curent" : "Finish workout"}
                    </button>
                </div>
            </div>

            {finishEarlySets ? (
                <FinishEarlyDialog
                    setsToSkip={finishEarlySets}
                    onConfirm={(reason) => {
                        sessionApi.skipSets(finishEarlySets, reason?.trim() || 'Finish workout early')
                        setFinishEarlySets(null)
                        finish()
                    }}
                    onCancel={() => setFinishEarlySets(null)}
                />
            ) : null}
        </>
    )
}

function FinishEarlyDialog({
    setsToSkip,
    onConfirm,
    onCancel,
}: {
    setsToSkip: readonly WorkoutSetRef[]
    onConfirm: (reason?: string) => void
    onCancel: () => void
}) {
    const [reason, setReason] = React.useState('')
    const preview = setsToSkip.slice(0, 4)
    const remaining = setsToSkip.length - preview.length

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label="Finish workout early"
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 px-4 backdrop-blur-sm"
        >
            <div className="w-full max-w-sm rounded-xl border border-border/70 bg-popover p-4 shadow-xl">
                <div className="text-sm font-semibold text-foreground">
                    Finish workout early?
                </div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                    Seturile rămase vor fi marcate skipped, separat de seturile completate.
                </p>
                <ul className="mt-3 flex flex-col gap-1 text-[12px] text-foreground/80">
                    {preview.map((set) => (
                        <li key={`${set.exerciseId}-${set.setIndex}`} className="rounded bg-muted/45 px-2 py-1">
                            {set.exerciseName} · set {set.setIndex + 1}
                        </li>
                    ))}
                    {remaining > 0 ? (
                        <li className="px-2 py-0.5 text-muted-foreground">
                            +{remaining} în plus
                        </li>
                    ) : null}
                </ul>
                <label className="mt-3 block">
                    <span className="mb-1 block text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                        Motiv opțional
                    </span>
                    <input
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        placeholder="ex: terminat mai devreme, prea obosit"
                        className="h-10 w-full rounded-md border border-border bg-background px-2.5 text-base text-foreground outline-none transition-shadow focus:ring-2 focus:ring-ring sm:h-9 sm:text-[12.5px]"
                    />
                </label>
                <div className="mt-3 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="inline-flex h-9 items-center rounded-md border border-border bg-background px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        Anulează
                    </button>
                    <button
                        type="button"
                        onClick={() => onConfirm(reason)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md bg-emerald-600 px-3 text-[12px] font-semibold text-white transition-colors hover:bg-emerald-700"
                    >
                        <SkipForward className="size-3.5" strokeWidth={2} />
                        Finish și skip
                    </button>
                </div>
            </div>
        </div>
    )
}
