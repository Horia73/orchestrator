"use client"

import * as React from "react"
import { Clock, Flame } from "lucide-react"

import { cn } from "@/lib/utils"
import type { RecipeArtifact } from "@/lib/recipe/schema"

/**
 * Top-of-recipe header: title, optional subtitle, and a meta strip with time
 * + difficulty. Servings deliberately omitted here — the RecipeActionBar
 * right below this is the single interactive source of truth for that value
 * (showing it in both places risks the header going stale when the user
 * steps).
 */
export function RecipeHeader({
    recipe,
    className,
}: {
    recipe: RecipeArtifact
    className?: string
}) {
    const totalMinutes = recipe.totalMinutes
        ?? ((recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0) || undefined)

    const metas: Array<{ key: string; icon: React.ReactNode; label: string }> = []
    if (totalMinutes !== undefined && totalMinutes > 0) {
        metas.push({
            key: "time",
            icon: <Clock className="size-3.5" aria-hidden />,
            label: formatMinutes(totalMinutes),
        })
    }
    if (recipe.difficulty) {
        metas.push({
            key: "difficulty",
            icon: <Flame className="size-3.5" aria-hidden />,
            label: DIFFICULTY_LABEL[recipe.difficulty],
        })
    }

    return (
        <header className={cn("flex flex-col gap-2", className)}>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {recipe.title}
            </h1>
            {recipe.subtitle ? (
                <p className="text-sm text-muted-foreground leading-relaxed">
                    {recipe.subtitle}
                </p>
            ) : null}
            {metas.length > 0 ? (
                <dl className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
                    {metas.map((m) => (
                        <div key={m.key} className="inline-flex items-center gap-1.5">
                            {m.icon}
                            <span>{m.label}</span>
                        </div>
                    ))}
                </dl>
            ) : null}
        </header>
    )
}

const DIFFICULTY_LABEL: Record<NonNullable<RecipeArtifact["difficulty"]>, string> = {
    usor: "Ușor",
    mediu: "Mediu",
    greu: "Greu",
}

function formatMinutes(min: number): string {
    if (min < 60) return `${min} min`
    const h = Math.floor(min / 60)
    const m = min % 60
    if (m === 0) return `${h} h`
    return `${h} h ${m} min`
}
