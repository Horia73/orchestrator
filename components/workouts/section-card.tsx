"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Shared card shell for the Workouts dashboard sections. Every block on the
 * tab (calendar, muscle balance, sessions, PRs) renders through this so the
 * page reads as one system: same border, same header treatment, same radius
 * as the rest of the Library.
 */
export function SectionCard({
    title,
    icon,
    actions,
    className,
    contentClassName,
    children,
}: {
    title: string
    icon?: React.ReactNode
    actions?: React.ReactNode
    className?: string
    contentClassName?: string
    children: React.ReactNode
}) {
    return (
        <section
            className={cn(
                "flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm",
                className,
            )}
        >
            <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-border/45 px-4 py-2.5">
                <h2 className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {icon}
                    {title}
                </h2>
                {actions}
            </header>
            <div className={cn("min-w-0 flex-1", contentClassName)}>{children}</div>
        </section>
    )
}

/** Muted count badge for SectionCard headers ("12 sessions", "8 exercises"). */
export function SectionCount({ children }: { children: React.ReactNode }) {
    return (
        <span className="text-[11px] font-medium tabular-nums text-muted-foreground/75">
            {children}
        </span>
    )
}

/** Centered empty-state body used inside a SectionCard. */
export function SectionEmpty({ children }: { children: React.ReactNode }) {
    return (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {children}
        </div>
    )
}
