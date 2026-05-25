"use client"

import * as React from "react"
import { RefreshCw } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

import { LibraryEmptyState } from "./library-empty-state"
import { LibrarySearchBar, matchesQuery } from "./search-bar"
import {
    useAttachments,
    type LibraryAttachment,
    type LibraryAttachmentType,
} from "./use-attachments"

/**
 * Generic tab content wrapper for the attachment-style tabs (Media, Audio,
 * Files). Owns fetch + refresh + search + loading + empty-state, and hands
 * the filtered attachments to whichever renderer the caller passes via
 * `renderItems`.
 *
 * The search input is debounced and filters client-side across filename,
 * MIME type, and source conversation title — keeps interactions instant
 * without a network round-trip per keystroke.
 */
export function AttachmentsTab({
    type,
    description,
    emptyIcon,
    emptyTitle,
    emptyDescription,
    emptyHint,
    searchPlaceholder,
    renderItems,
    className,
}: {
    type: LibraryAttachmentType
    description: string
    emptyIcon: LucideIcon
    emptyTitle: string
    emptyDescription: string
    emptyHint?: string
    searchPlaceholder?: string
    renderItems: (attachments: LibraryAttachment[]) => React.ReactNode
    className?: string
}) {
    const { data, loading, error, reload } = useAttachments(type)
    const [query, setQuery] = React.useState('')

    const filtered = React.useMemo(() => {
        if (!data) return null
        if (!query) return data
        return data.filter((a) => matchesQuery(query, a.filename, a.mimeType, a.conversationTitle))
    }, [data, query])

    const hasAnyData = (data?.length ?? 0) > 0

    return (
        <div className={cn("flex flex-col gap-4", className)}>
            <div className="flex flex-wrap items-end gap-3">
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">{description}</p>
                <button
                    type="button"
                    onClick={() => void reload()}
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
                    placeholder={searchPlaceholder ?? 'Caută după nume, tip sau conversație…'}
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
                <SkeletonGrid />
            ) : filtered && filtered.length > 0 ? (
                renderItems(filtered)
            ) : hasAnyData ? (
                <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                    Niciun rezultat pentru <span className="font-medium text-foreground">&ldquo;{query}&rdquo;</span>.
                </div>
            ) : (
                <LibraryEmptyState
                    icon={emptyIcon}
                    title={emptyTitle}
                    description={emptyDescription}
                    hint={emptyHint}
                />
            )}
        </div>
    )
}

function SkeletonGrid() {
    return (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
                <li
                    key={i}
                    className="aspect-square animate-pulse rounded-lg border border-border/40 bg-muted/30"
                />
            ))}
        </ul>
    )
}
