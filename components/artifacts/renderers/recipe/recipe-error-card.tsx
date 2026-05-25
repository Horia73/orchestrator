"use client"

import * as React from "react"
import { AlertTriangle } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Shown in place of the recipe card when the artifact body can't be parsed.
 * Surfaces the parser's single human-readable error so the model (or the
 * developer reading the screenshot) can see what to fix instead of staring
 * at an empty card.
 */
export function RecipeErrorCard({
    message,
    className,
}: {
    message: string
    className?: string
}) {
    return (
        <div
            role="alert"
            className={cn(
                "flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3",
                "text-sm text-foreground",
                className,
            )}
        >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium">Rețeta nu a putut fi afișată</span>
                <span className="text-muted-foreground">{message}</span>
            </div>
        </div>
    )
}
