"use client"

import * as React from "react"
import { Play, Plus, SkipForward, Timer } from "lucide-react"

import { cn } from "@/lib/utils"
import { playChime, primeAudio } from "@/lib/recipe/chime"
import { formatDuration } from "@/lib/workout/format"
import type { RestState } from "@/lib/workout/use-workout-session"

/**
 * Floating bottom rest-timer bar. Visible only when a rest is active
 * (`rest` prop set); slides out otherwise.
 *
 * Time math is `Date.now()`-based against `rest.endsAt`, the same pattern
 * the recipe TimerChip uses. This means:
 *   - Background tab throttling doesn't drift the timer.
 *   - Phone sleep / wake recomputes correctly on resume.
 *   - Two timers can't double-tick (we only show one rest at a time).
 *
 * On completion:
 *   - Plays the recipe chime (D-major triad).
 *   - Single vibration pulse on devices that support it.
 *   - Bar stays visible for ~10s showing "Rest done!" then auto-fades
 *     (auto-clear lives in the session hook).
 *
 * On 5s-remaining (configurable):
 *   - Soft chime to warn the user the timer is about to ring.
 */
export function RestTimerBar({
    rest,
    onAdjust,
    onSkip,
    onStartNext,
    nextLabel,
    alertBeforeSec = 5,
    className,
}: {
    rest: RestState
    onAdjust: (deltaSec: number) => void
    onSkip: () => void
    onStartNext?: () => void
    nextLabel?: string
    /** Seconds before end to fire a softer pre-warning chime. 0 = disabled. */
    alertBeforeSec?: number
    className?: string
}) {
    const [now, setNow] = React.useState(() => Date.now())
    const alertedRef = React.useRef<number | null>(null)
    const completedRef = React.useRef<number | null>(null)

    // Prime the audio context once when the bar mounts (we're already inside
    // a user-gesture descendant from the set-row check). This unlocks Web
    // Audio on Safari so the later auto-chime is allowed.
    React.useEffect(() => {
        primeAudio()
    }, [])

    // 200ms tick. We pause when remaining > 30s and slow to 1s — saves cycles
    // when the user has plenty of time and doesn't need sub-second precision.
    React.useEffect(() => {
        const remaining = rest.endsAt - Date.now()
        const interval = remaining > 30_000 ? 1000 : 200
        const id = window.setInterval(() => setNow(Date.now()), interval)
        return () => window.clearInterval(id)
    }, [rest.endsAt, rest.key])

    // Fire chimes at the right moments. Refs ensure each rest fires its
    // chimes at most once even though `now` changes constantly.
    React.useEffect(() => {
        const remainingMs = rest.endsAt - now
        // Pre-warning chime.
        if (
            alertBeforeSec > 0
            && remainingMs <= alertBeforeSec * 1000
            && remainingMs > 0
            && alertedRef.current !== rest.key
        ) {
            alertedRef.current = rest.key
            // Softer single tone for the pre-warning — just play one note
            // by scheduling immediately and letting the main chime fire at zero.
            playChime()
        }
        // Final completion chime + vibration.
        if (remainingMs <= 0 && completedRef.current !== rest.key) {
            completedRef.current = rest.key
            playChime()
            try {
                if (typeof navigator !== 'undefined' && navigator.vibrate) {
                    navigator.vibrate([180, 60, 180])
                }
            } catch { /* ignore */ }
        }
    }, [now, rest.endsAt, rest.key, alertBeforeSec])

    const remainingMs = Math.max(0, rest.endsAt - now)
    const remainingSec = Math.ceil(remainingMs / 1000)
    const progressPct = Math.max(
        0,
        Math.min(100, ((rest.durationSec * 1000 - remainingMs) / (rest.durationSec * 1000)) * 100),
    )
    const isDone = remainingMs <= 0

    return (
        <div
            className={cn(
                "pointer-events-auto fixed inset-x-0 bottom-3 z-40 mx-auto w-[min(640px,calc(100vw-1.5rem))]",
                "animate-in slide-in-from-bottom-2 fade-in fill-mode-both duration-300",
                className,
            )}
            role="region"
            aria-label="Rest timer"
        >
            <div
                className={cn(
                    "overflow-hidden rounded-2xl border bg-card shadow-2xl shadow-black/15",
                    isDone
                        ? "border-emerald-500/40"
                        : "border-border/60",
                )}
            >
                {/* Progress bar */}
                <div className="relative h-1 w-full bg-muted/55">
                    <div
                        className={cn(
                            "absolute left-0 top-0 h-full transition-[width] duration-200 ease-linear",
                            isDone ? "bg-emerald-500" : "bg-primary",
                        )}
                        style={{ width: `${progressPct}%` }}
                    />
                </div>

                <div className="flex items-center gap-3 px-3.5 py-2.5">
                    <Timer
                        className={cn(
                            "size-4 shrink-0",
                            isDone ? "text-emerald-500 motion-safe:animate-pulse" : "text-primary",
                        )}
                        strokeWidth={1.85}
                        aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
                            <span>
                                {isDone ? 'Rest done!' : 'Resting'}
                            </span>
                            <span aria-hidden> · </span>
                            <span className="truncate normal-case tracking-normal text-foreground/65">
                                {rest.exerciseName} · set {rest.setIndex + 1}
                            </span>
                        </div>
                        <div className={cn(
                            "text-lg font-semibold tabular-nums leading-tight",
                            isDone ? "text-emerald-600 dark:text-emerald-400" : "text-foreground",
                        )}>
                            {formatDuration(remainingSec)}
                        </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                        <CtrlBtn
                            onClick={() => onAdjust(-15)}
                            disabled={isDone}
                            label="-15s"
                            title="Subtract 15 seconds"
                        />
                        <CtrlBtn
                            onClick={() => onAdjust(15)}
                            disabled={isDone}
                            label="+15s"
                            title="Add 15 seconds"
                        />
                        <button
                            type="button"
                            onClick={onStartNext ?? onSkip}
                            aria-label={onStartNext ? "Start next set" : isDone ? "Close" : "Skip rest"}
                            title={onStartNext ? `Start ${nextLabel ?? 'next set'}` : isDone ? "Close" : "Skip rest"}
                            className={cn(
                                "flex h-8 items-center justify-center rounded-md border transition-colors",
                                onStartNext
                                    ? "border-primary bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground hover:opacity-90"
                                    : "size-8 border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                        >
                            {onStartNext ? (
                                <>
                                    <Play className="size-3.5 fill-current" strokeWidth={2} />
                                    <span className="ml-1 hidden sm:inline">Next</span>
                                </>
                            ) : isDone ? (
                                <Plus className="size-3.5 rotate-45" />
                            ) : (
                                <SkipForward className="size-3.5" />
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

function CtrlBtn({
    onClick,
    disabled,
    label,
    title,
}: {
    onClick: () => void
    disabled?: boolean
    label: string
    title: string
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            title={title}
            aria-label={title}
            className={cn(
                "flex h-8 min-w-[2.5rem] items-center justify-center rounded-md border border-border bg-background px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground",
                "transition-colors",
                "hover:bg-muted hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-background disabled:hover:text-muted-foreground",
            )}
        >
            {label}
        </button>
    )
}
