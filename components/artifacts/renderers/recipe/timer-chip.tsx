"use client"

import * as React from "react"
import { Check, Play, Square } from "lucide-react"

import { cn } from "@/lib/utils"
import { playChime, primeAudio } from "@/lib/recipe/chime"

/**
 * Inline live countdown chip rendered next to step text.
 *
 * State machine:
 *
 *   idle → click → running → (tick to zero) → done
 *   running → click → idle (cancel/reset)
 *   done    → click → idle (acknowledge/reset)
 *
 * Timing is `Date.now()`-based, not pure setInterval counting. If the browser
 * throttles the interval (background tab, throttled timers, OS sleep), the
 * next tick still computes the correct remaining time from the absolute end
 * timestamp, and the chip fires immediately if it's past zero.
 *
 * On completion: plays a synthesized chime via Web Audio, requests a single
 * vibration pulse on devices that support it, and fires a Notification if
 * permission was already granted (we never *request* permission from a
 * recipe — the inbox has its own opt-in flow).
 *
 * Multiple chips coexist independently — state is per-instance.
 */
export function TimerChip({
    seconds,
    label: stepLabel,
    className,
}: {
    /** Total countdown duration in seconds — fixed for the chip's lifetime. */
    seconds: number
    /** Optional step title used in the completion notification body. */
    label?: string
    className?: string
}) {
    type Phase = "idle" | "running" | "done"
    const [phase, setPhase] = React.useState<Phase>("idle")
    const [remainingMs, setRemainingMs] = React.useState(seconds * 1000)
    const endTimeRef = React.useRef<number | null>(null)

    // Restart logic when `seconds` prop changes (e.g. artifact version update).
    React.useEffect(() => {
        setPhase("idle")
        setRemainingMs(seconds * 1000)
        endTimeRef.current = null
    }, [seconds])

    // Ticking interval. We use 200ms granularity — enough for smooth `mm:ss`
    // updates, gentle on the main thread, and means a 1-second timer still
    // reaches zero within ~200ms of true completion.
    React.useEffect(() => {
        if (phase !== "running") return
        const end = endTimeRef.current
        if (end === null) return

        let cancelled = false
        const tick = () => {
            if (cancelled) return
            const left = Math.max(0, end - Date.now())
            setRemainingMs(left)
            if (left <= 0) {
                endTimeRef.current = null
                setPhase("done")
                fireCompletionFeedback(stepLabel, seconds)
            }
        }
        // Run a first tick immediately so the display updates without waiting
        // a full interval; then schedule the recurring tick.
        tick()
        const id = window.setInterval(tick, 200)
        return () => {
            cancelled = true
            window.clearInterval(id)
        }
    }, [phase, seconds, stepLabel])

    const onClick = React.useCallback(() => {
        if (phase === "idle") {
            primeAudio()
            endTimeRef.current = Date.now() + seconds * 1000
            setRemainingMs(seconds * 1000)
            setPhase("running")
        } else {
            // running or done → reset to idle
            endTimeRef.current = null
            setRemainingMs(seconds * 1000)
            setPhase("idle")
        }
    }, [phase, seconds])

    const display = formatDuration(Math.ceil(remainingMs / 1000))
    const isLowTime = phase === "running" && remainingMs > 0 && remainingMs <= 10_000

    const ariaLabel =
        phase === "idle" ? `Pornește cronometru pentru ${display}`
        : phase === "running" ? `Oprește cronometru — rămân ${display}`
        : "Cronometru terminat — apasă pentru a reseta"

    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={ariaLabel}
            className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
                "text-xs font-medium tabular-nums transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                phase === "idle" && "border-border bg-muted/60 text-foreground hover:bg-muted",
                phase === "running" && !isLowTime && "border-primary/40 bg-primary/10 text-foreground hover:bg-primary/15",
                phase === "running" && isLowTime && "border-destructive/60 bg-destructive/15 text-foreground animate-pulse",
                phase === "done" && "border-emerald-500/60 bg-emerald-500/15 text-foreground",
                className,
            )}
        >
            {phase === "idle" && <Play className="size-3" aria-hidden />}
            {phase === "running" && <Square className="size-3 fill-current" aria-hidden />}
            {phase === "done" && <Check className="size-3" aria-hidden />}
            <span>{phase === "done" ? "Gata!" : display}</span>
        </button>
    )
}

function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00"
    const s = Math.floor(seconds % 60)
    const m = Math.floor((seconds / 60) % 60)
    const h = Math.floor(seconds / 3600)
    const pad = (n: number) => n.toString().padStart(2, "0")
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
    return `${m}:${pad(s)}`
}

/**
 * Three independent completion signals, each gated on availability. Wrapped
 * in try/catch so a flaky API never takes down the whole chip.
 */
function fireCompletionFeedback(stepLabel: string | undefined, seconds: number): void {
    // 1. Sound — synthesized, no asset needed.
    try { playChime() } catch { /* swallow */ }

    // 2. Vibration — silent no-op on desktop / unsupported browsers.
    try {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
            navigator.vibrate([120, 60, 120])
        }
    } catch { /* swallow */ }

    // 3. Notification — only if the user has already granted permission for
    //    this origin. We never request from a recipe; the inbox opt-in flow
    //    is the canonical place to ask.
    try {
        if (typeof window !== "undefined"
            && "Notification" in window
            && Notification.permission === "granted") {
            const title = stepLabel ? `${stepLabel} — gata` : "Cronometru terminat"
            const body = `${formatDuration(seconds)} s-au scurs.`
            new Notification(title, { body, tag: "recipe-timer", silent: false })
        }
    } catch { /* swallow */ }
}
