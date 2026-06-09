"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { HelpCircle } from "lucide-react"

import { cn } from "@/lib/utils"
import { getGlossary } from "@/lib/workout/glossary"

/**
 * Tiny (?) icon that pops a glossary explanation when clicked.
 *
 * Use inline next to any jargon the user might not know:
 *
 *     RPE 8 <GlossaryInfo term="rpe" />
 *
 * Renders a `<details>` element so the popover is keyboard-accessible
 * (Enter/Space) and closes when the user clicks outside or hits Esc.
 * Falls back to inert (icon hidden) when the term isn't in the glossary
 * — no broken (?) buttons.
 */
export function GlossaryInfo({
    term,
    className,
    label,
}: {
    term: string
    className?: string
    /** Optional accessible label override; defaults to the term title. */
    label?: string
}) {
    const entry = getGlossary(term)
    const tooltipId = React.useId()
    const [mounted, setMounted] = React.useState(false)
    const [open, setOpen] = React.useState(false)
    const [position, setPosition] = React.useState<{
        left: number
        top: number
        width: number
    } | null>(null)
    const buttonRef = React.useRef<HTMLButtonElement | null>(null)
    const tooltipRef = React.useRef<HTMLDivElement | null>(null)
    const closeTimerRef = React.useRef<number | null>(null)
    const pinnedOpenRef = React.useRef(false)

    React.useEffect(() => {
        setMounted(true)
        return () => {
            if (closeTimerRef.current != null) {
                window.clearTimeout(closeTimerRef.current)
            }
        }
    }, [])

    const clearCloseTimer = React.useCallback(() => {
        if (closeTimerRef.current == null) return
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
    }, [])

    const scheduleClose = React.useCallback(() => {
        if (pinnedOpenRef.current) return
        clearCloseTimer()
        closeTimerRef.current = window.setTimeout(() => {
            setOpen(false)
            closeTimerRef.current = null
        }, 180)
    }, [clearCloseTimer])

    const updatePosition = React.useCallback(() => {
        const button = buttonRef.current
        if (!button) return

        const rect = button.getBoundingClientRect()
        const width = 256
        const margin = 8
        const tooltipHeight = tooltipRef.current?.offsetHeight ?? 132
        const fitsBelow = rect.bottom + margin + tooltipHeight <= window.innerHeight
        const top = fitsBelow
            ? rect.bottom + margin
            : Math.max(margin, rect.top - tooltipHeight - margin)
        const left = Math.min(
            Math.max(rect.left + rect.width / 2 - width / 2, margin),
            Math.max(margin, window.innerWidth - width - margin)
        )

        setPosition({ left, top, width })
    }, [])

    React.useEffect(() => {
        if (!open) return
        updatePosition()
        const raf = window.requestAnimationFrame(updatePosition)
        window.addEventListener("resize", updatePosition)
        window.addEventListener("scroll", updatePosition, true)
        return () => {
            window.cancelAnimationFrame(raf)
            window.removeEventListener("resize", updatePosition)
            window.removeEventListener("scroll", updatePosition, true)
        }
    }, [open, updatePosition])

    React.useEffect(() => {
        if (!open) return

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null
            if (!target) return
            if (buttonRef.current?.contains(target)) return
            if (tooltipRef.current?.contains(target)) return
            pinnedOpenRef.current = false
            setOpen(false)
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return
            pinnedOpenRef.current = false
            setOpen(false)
        }

        document.addEventListener("pointerdown", handlePointerDown)
        document.addEventListener("keydown", handleKeyDown)
        return () => {
            document.removeEventListener("pointerdown", handlePointerDown)
            document.removeEventListener("keydown", handleKeyDown)
        }
    }, [open])

    if (!entry) return null
    const a11yLabel = label ?? `What is ${entry.title}?`

    return (
        <span
            className={cn("inline-flex align-middle", className)}
            onMouseEnter={() => {
                clearCloseTimer()
                setOpen(true)
            }}
            onMouseLeave={scheduleClose}
        >
            <button
                ref={buttonRef}
                type="button"
                aria-label={a11yLabel}
                aria-expanded={open}
                aria-describedby={open ? tooltipId : undefined}
                title={a11yLabel}
                onClick={() => {
                    clearCloseTimer()
                    if (pinnedOpenRef.current) {
                        pinnedOpenRef.current = false
                        setOpen(false)
                    } else {
                        pinnedOpenRef.current = true
                        setOpen(true)
                    }
                }}
                onFocus={() => setOpen(true)}
                onBlur={scheduleClose}
                className={cn(
                    "flex size-3.5 items-center justify-center rounded-full text-muted-foreground/55 transition-colors",
                    "hover:bg-muted hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                )}
            >
                <HelpCircle className="size-3" strokeWidth={1.75} aria-hidden />
            </button>
            {mounted && open && position && typeof document !== "undefined"
                ? createPortal(
                    <div
                        ref={tooltipRef}
                        id={tooltipId}
                        role="tooltip"
                        onMouseEnter={clearCloseTimer}
                        onMouseLeave={scheduleClose}
                        style={{
                            left: position.left,
                            top: position.top,
                            width: position.width,
                        }}
                        className="fixed z-[120] rounded-lg border border-border/70 bg-popover p-3 text-left shadow-xl"
                    >
                        <div className="mb-1 flex items-baseline gap-1.5">
                            <span className="text-[12.5px] font-semibold text-foreground">{entry.title}</span>
                            {entry.aka ? (
                                <span className="text-[10.5px] text-muted-foreground">({entry.aka})</span>
                            ) : null}
                        </div>
                        <p className="text-[12px] leading-relaxed text-foreground/85">
                            {entry.body}
                        </p>
                        {entry.example ? (
                            <p className="mt-1.5 rounded bg-muted/55 px-2 py-1 text-[11.5px] italic text-muted-foreground">
                                {entry.example}
                            </p>
                        ) : null}
                    </div>,
                    document.body
                )
                : null}
        </span>
    )
}
