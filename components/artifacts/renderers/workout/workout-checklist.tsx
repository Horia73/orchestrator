"use client"

import * as React from "react"
import { Circle, Flame, Snowflake } from "lucide-react"

import { cn } from "@/lib/utils"
import type { WorkoutChecklist as WorkoutChecklistType } from "@/lib/workout/schema"
import { formatMinutes } from "@/lib/workout/format"

/**
 * Warmup / cooldown checklist. Free-form bulleted list with optional
 * estimated minutes. Phase 1 is read-only — Phase 2 will add interactive
 * checkboxes that persist to session state.
 *
 * Visual treatment differentiates warmup (warm orange accent) from cooldown
 * (cool blue accent) so they don't look identical when both present.
 */
export function WorkoutChecklist({
    title,
    checklist,
    variant,
    className,
}: {
    title: string
    checklist: WorkoutChecklistType
    variant: 'warmup' | 'cooldown'
    className?: string
}) {
    const Icon = variant === 'warmup' ? Flame : Snowflake
    const accentClass = variant === 'warmup'
        ? 'text-orange-500 dark:text-orange-400'
        : 'text-sky-500 dark:text-sky-400'

    return (
        <section
            className={cn(
                "rounded-xl border border-border/50 bg-muted/25 px-4 py-3",
                className,
            )}
            aria-labelledby={`workout-${variant}-heading`}
        >
            <div className="mb-2 flex items-center gap-2">
                <Icon className={cn("size-3.5", accentClass)} aria-hidden strokeWidth={1.85} />
                <h3
                    id={`workout-${variant}-heading`}
                    className="text-[11px] font-semibold uppercase tracking-wider text-foreground/70"
                >
                    {title}
                </h3>
                {checklist.estimatedMinutes ? (
                    <span className="ml-auto text-[10.5px] tabular-nums text-muted-foreground">
                        {formatMinutes(checklist.estimatedMinutes)}
                    </span>
                ) : null}
            </div>
            <ul role="list" className="flex flex-col gap-1.5">
                {checklist.items.map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm leading-relaxed text-foreground/85">
                        <Circle className="mt-1 size-3 shrink-0 text-muted-foreground/55" aria-hidden strokeWidth={1.75} />
                        <span className="min-w-0">{item}</span>
                    </li>
                ))}
            </ul>
        </section>
    )
}
