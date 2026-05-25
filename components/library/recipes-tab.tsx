"use client"

import * as React from "react"
import { ChefHat, RefreshCw } from "lucide-react"

import { cn } from "@/lib/utils"
import { LibraryEmptyState } from "./library-empty-state"
import { LibrarySearchBar, matchesQuery } from "./search-bar"
import { RecipesGrid } from "./recipes-grid"
import type { LibraryRecipeRow } from "@/app/api/library/recipes/route"

/**
 * Recipes tab content — fetches /api/library/recipes and renders a grid
 * with client-side search across title, subtitle, and source conversation.
 */
export function RecipesTab() {
    const [data, setData] = React.useState<LibraryRecipeRow[] | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)
    const [query, setQuery] = React.useState('')

    const load = React.useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const r = await fetch('/api/library/recipes?limit=100')
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            const j = await r.json() as { recipes: LibraryRecipeRow[] }
            setData(j.recipes)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setLoading(false)
        }
    }, [])

    React.useEffect(() => { void load() }, [load])

    const filtered = React.useMemo(() => {
        if (!data) return null
        if (!query) return data
        return data.filter((r) => matchesQuery(query, r.title, r.subtitle, r.conversationTitle))
    }, [data, query])

    const hasAnyData = (data?.length ?? 0) > 0

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                    Toate rețetele pe care le-ai cerut în chat, într-o galerie. Click pe orice card te duce înapoi la conversația respectivă.
                </p>
                <button
                    type="button"
                    onClick={() => void load()}
                    disabled={loading}
                    className={cn(
                        "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors",
                        "hover:bg-muted hover:text-foreground",
                        "disabled:cursor-default disabled:opacity-50",
                    )}
                >
                    <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
                    Refresh
                </button>
            </div>

            {hasAnyData ? (
                <LibrarySearchBar
                    placeholder="Caută rețete după titlu sau conversație…"
                    onDebouncedChange={setQuery}
                    className="max-w-md"
                />
            ) : null}

            {error ? (
                <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
                    {error}
                </div>
            ) : null}

            {data === null && loading ? (
                <SkeletonCards />
            ) : filtered && filtered.length > 0 ? (
                <RecipesGrid recipes={filtered} />
            ) : hasAnyData ? (
                <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                    Nicio rețetă pentru <span className="font-medium text-foreground">&ldquo;{query}&rdquo;</span>.
                </div>
            ) : (
                <LibraryEmptyState
                    icon={ChefHat}
                    title="Nicio rețetă salvată încă"
                    description="Cere o rețetă în chat (&ldquo;fă-mi o rețetă pentru carbonara&rdquo;) și cardul apare aici automat."
                />
            )}
        </div>
    )
}

function SkeletonCards() {
    return (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
                <li
                    key={i}
                    className="h-56 animate-pulse rounded-xl border border-border/40 bg-muted/25"
                />
            ))}
        </ul>
    )
}
