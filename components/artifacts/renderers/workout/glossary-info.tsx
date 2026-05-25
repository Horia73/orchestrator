"use client"

import * as React from "react"
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
    if (!entry) return null
    const a11yLabel = label ?? `Ce înseamnă ${entry.title}?`

    return (
        <details
            className={cn("group/glossary relative inline-block align-middle", className)}
            onMouseLeave={(e) => {
                // Close when the pointer leaves the entire details element.
                const detailsEl = e.currentTarget
                window.setTimeout(() => {
                    if (!detailsEl.matches(':hover')) detailsEl.open = false
                }, 200)
            }}
        >
            <summary
                aria-label={a11yLabel}
                title={a11yLabel}
                className={cn(
                    "flex size-3.5 cursor-pointer list-none items-center justify-center rounded-full text-muted-foreground/55 transition-colors",
                    "hover:bg-muted hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                    "[&::-webkit-details-marker]:hidden",
                )}
            >
                <HelpCircle className="size-3" strokeWidth={1.75} aria-hidden />
            </summary>
            <div
                role="tooltip"
                className="absolute left-1/2 top-full z-30 mt-1.5 w-64 -translate-x-1/2 rounded-lg border border-border/70 bg-popover p-3 text-left shadow-lg"
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
            </div>
        </details>
    )
}
