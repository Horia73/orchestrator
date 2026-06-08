"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

/** Custom on/off switch — replaces native checkboxes for boolean toggles. */
export function Switch({
    checked,
    onCheckedChange,
    disabled,
    className,
    "aria-label": ariaLabel,
}: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
    disabled?: boolean
    className?: string
    "aria-label"?: string
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={ariaLabel}
            disabled={disabled}
            onClick={() => onCheckedChange(!checked)}
            className={cn(
                "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 disabled:opacity-50",
                checked ? "bg-foreground" : "bg-foreground/20",
                className,
            )}
        >
            <span
                className={cn(
                    "inline-block size-4 transform rounded-full bg-background shadow-sm ring-1 ring-black/5 transition-transform",
                    checked ? "translate-x-[18px]" : "translate-x-0.5",
                )}
            />
        </button>
    )
}
