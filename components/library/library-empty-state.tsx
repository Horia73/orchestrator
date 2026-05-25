"use client"

import * as React from "react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Empty-state placeholder for Library tabs whose domain doesn't yet have
 * a history backend. Same visual language as the WorkoutsHistory empty
 * states so the page reads consistently across tabs.
 */
export function LibraryEmptyState({
    icon: Icon,
    title,
    description,
    hint,
    className,
}: {
    icon: LucideIcon
    title: string
    description: string
    hint?: string
    className?: string
}) {
    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/15 px-6 py-12 text-center",
                className,
            )}
        >
            <span className="flex size-12 items-center justify-center rounded-full bg-background/80 text-muted-foreground shadow-sm">
                <Icon className="size-5" strokeWidth={1.75} />
            </span>
            <div className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold text-foreground">{title}</h3>
                <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
                    {description}
                </p>
            </div>
            {hint ? (
                <p className="rounded-full bg-background/70 px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
                    {hint}
                </p>
            ) : null}
        </div>
    )
}
