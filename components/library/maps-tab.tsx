"use client"

import * as React from "react"
import { MapPinned, RefreshCw } from "lucide-react"

import { cn } from "@/lib/utils"
import { LibraryEmptyState } from "./library-empty-state"
import { LibrarySearchBar, matchesQuery } from "./search-bar"
import { MapsGrid } from "./maps-grid"
import type { LibraryMapRow } from "@/app/api/library/maps/route"

/**
 * Maps tab content — fetches /api/library/maps and renders a grid with
 * client-side search across title and source conversation.
 */
export function MapsTab() {
    const [data, setData] = React.useState<LibraryMapRow[] | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)
    const [query, setQuery] = React.useState('')

    const load = React.useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const r = await fetch('/api/library/maps?limit=100')
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            const j = await r.json() as { maps: LibraryMapRow[] }
            setData(j.maps)
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
        return data.filter((m) => matchesQuery(query, m.title, m.conversationTitle))
    }, [data, query])

    const hasAnyData = (data?.length ?? 0) > 0

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                    Hărțile generate în chat, cu preview și click → conversația originală. Pentru hărți live cu interacțiune, vezi <span className="font-medium text-foreground">Smart Maps</span> din sidebar.
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
                    placeholder="Caută hărți după titlu sau conversație…"
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
                <MapsGrid maps={filtered} />
            ) : hasAnyData ? (
                <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                    Nicio hartă pentru <span className="font-medium text-foreground">&ldquo;{query}&rdquo;</span>.
                </div>
            ) : (
                <LibraryEmptyState
                    icon={MapPinned}
                    title="Nicio hartă încă"
                    description="Cere o hartă în chat (&ldquo;arată-mi un traseu prin Cluj&rdquo;) și cardul apare aici automat."
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
