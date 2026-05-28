"use client"

import * as React from "react"
import {
  CheckSquare,
  Copy,
  Download,
  RefreshCw,
  Share2,
  Trash2,
  X,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { useConfirm } from "@/components/ui/confirm-dialog"

import { LibraryEmptyState } from "./library-empty-state"
import { LibrarySearchBar, matchesQuery } from "./search-bar"
import {
  libraryItemUrl,
  removeAttachmentsFromCache,
  useAttachments,
  type LibraryAttachment,
  type LibraryAttachmentType,
} from "./use-attachments"

export interface LibrarySelectionProps {
  selectionMode: boolean
  selectedIds: ReadonlySet<string>
  onToggleSelection: (id: string) => void
}

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
  renderItems: (
    attachments: LibraryAttachment[],
    selection: LibrarySelectionProps
  ) => React.ReactNode
  className?: string
}) {
  const { data, loading, error, reload } = useAttachments(type)
  const [query, setQuery] = React.useState("")
  const [selectionMode, setSelectionMode] = React.useState(false)
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const [actionMessage, setActionMessage] = React.useState<string | null>(null)
  const [actionBusy, setActionBusy] = React.useState(false)
  const [canNativeShare, setCanNativeShare] = React.useState(false)
  const { confirm, dialog } = useConfirm()

  const filtered = React.useMemo(() => {
    if (!data) return null
    if (!query) return data
    return data.filter((a) =>
      matchesQuery(
        query,
        a.filename,
        a.mimeType,
        a.conversationTitle ?? "",
        a.workspacePath ?? ""
      )
    )
  }, [data, query])

  const hasAnyData = (data?.length ?? 0) > 0
  const selectedItems = React.useMemo(() => {
    if (!data || selectedIds.size === 0) return []
    return data.filter((item) => selectedIds.has(item.id))
  }, [data, selectedIds])
  const visibleItems = React.useMemo(() => filtered ?? [], [filtered])
  const allVisibleSelected = React.useMemo(
    () =>
      visibleItems.length > 0 &&
      visibleItems.every((item) => selectedIds.has(item.id)),
    [selectedIds, visibleItems]
  )

  React.useEffect(() => {
    if (!data) return
    setSelectedIds((current) => {
      const available = new Set(data.map((item) => item.id))
      const next = new Set(
        Array.from(current).filter((id) => available.has(id))
      )
      return next.size === current.size ? current : next
    })
  }, [data])

  React.useEffect(() => {
    setCanNativeShare(
      typeof navigator !== "undefined" && typeof navigator.share === "function"
    )
  }, [])

  const toggleSelectionMode = React.useCallback(() => {
    setActionMessage(null)
    if (selectionMode) setSelectedIds(new Set())
    setSelectionMode((current) => !current)
  }, [selectionMode])

  const toggleItem = React.useCallback((id: string) => {
    setActionMessage(null)
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleVisible = React.useCallback(() => {
    setActionMessage(null)
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allVisibleSelected) {
        for (const item of visibleItems) next.delete(item.id)
      } else {
        for (const item of visibleItems) next.add(item.id)
      }
      return next
    })
  }, [allVisibleSelected, visibleItems])

  const shareSelected = React.useCallback(async () => {
    if (selectedItems.length === 0) return
    const links = selectedItems.map((item) =>
      new URL(libraryItemUrl(item), window.location.origin).toString()
    )
    const text = links.join("\n")
    try {
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.share === "function"
      ) {
        await navigator.share({
          title:
            selectedItems.length === 1
              ? selectedItems[0].filename
              : `${selectedItems.length} library items`,
          text,
          ...(selectedItems.length === 1 ? { url: links[0] } : {}),
        })
        setActionMessage("Share deschis.")
      } else {
        await navigator.clipboard.writeText(text)
        setActionMessage(
          links.length === 1 ? "Link copiat." : "Linkuri copiate."
        )
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      try {
        await navigator.clipboard.writeText(text)
        setActionMessage(
          links.length === 1 ? "Link copiat." : "Linkuri copiate."
        )
      } catch {
        setActionMessage("Nu am putut copia linkurile.")
      }
    }
  }, [selectedItems])

  const downloadSelected = React.useCallback(() => {
    if (selectedItems.length === 0) return
    for (const item of selectedItems) {
      const anchor = document.createElement("a")
      anchor.href = libraryItemUrl(item)
      anchor.download = item.filename
      anchor.rel = "noopener noreferrer"
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
    }
    setActionMessage(
      selectedItems.length === 1
        ? "Download pornit."
        : `${selectedItems.length} download-uri pornite.`
    )
  }, [selectedItems])

  const deleteSelected = React.useCallback(async () => {
    if (selectedItems.length === 0) return
    const ok = await confirm({
      title:
        selectedItems.length === 1
          ? "Ștergi itemul selectat?"
          : `Ștergi ${selectedItems.length} itemuri?`,
      message:
        "Acțiunea elimină upload-urile din conversații sau fișierele extra din workspace. Fișierele standard din workspace nu sunt listate aici.",
      confirmLabel: "Șterge",
      destructive: true,
    })
    if (!ok) return

    setActionBusy(true)
    setActionMessage(null)
    const items = selectedItems.map((item) => ({
      id: item.id,
      source: item.source,
      workspacePath: item.workspacePath,
    }))
    try {
      const res = await fetch("/api/library/attachments", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const deletedIds = selectedItems.map((item) => item.id)
      removeAttachmentsFromCache(deletedIds)
      setSelectedIds(new Set())
      setSelectionMode(false)
      setActionMessage(
        selectedItems.length === 1 ? "Item șters." : "Itemuri șterse."
      )
      await reload()
    } catch (e) {
      setActionMessage(
        e instanceof Error
          ? `Ștergere eșuată: ${e.message}`
          : "Ștergere eșuată."
      )
    } finally {
      setActionBusy(false)
    }
  }, [confirm, reload, selectedItems])

  const selection: LibrarySelectionProps = React.useMemo(
    () => ({
      selectionMode,
      selectedIds,
      onToggleSelection: toggleItem,
    }),
    [selectedIds, selectionMode, toggleItem]
  )

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-end gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {description}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {hasAnyData ? (
            <button
              type="button"
              onClick={toggleSelectionMode}
              disabled={actionBusy}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors",
                "hover:bg-muted hover:text-foreground",
                "disabled:cursor-default disabled:opacity-50"
              )}
            >
              {selectionMode ? (
                <X className="size-3.5" />
              ) : (
                <CheckSquare className="size-3.5" />
              )}
              {selectionMode ? "Cancel" : "Select"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loading}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors",
              "hover:bg-muted hover:text-foreground",
              "disabled:cursor-default disabled:opacity-50"
            )}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      {selectionMode ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/25 px-2.5 py-2">
          <span className="min-w-0 flex-1 text-[12.5px] font-medium text-foreground">
            {selectedItems.length} selectate
          </span>
          <button
            type="button"
            onClick={toggleVisible}
            disabled={visibleItems.length === 0 || actionBusy}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:cursor-default disabled:opacity-50"
          >
            <CheckSquare className="size-3.5" />
            {allVisibleSelected ? "Deselect" : "Select all"}
          </button>
          <button
            type="button"
            onClick={downloadSelected}
            disabled={selectedItems.length === 0 || actionBusy}
            title="Download selected"
            className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:cursor-default disabled:opacity-50"
          >
            <Download className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => void shareSelected()}
            disabled={selectedItems.length === 0 || actionBusy}
            title="Share selected"
            className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:cursor-default disabled:opacity-50"
          >
            {canNativeShare ? (
              <Share2 className="size-4" />
            ) : (
              <Copy className="size-4" />
            )}
          </button>
          <button
            type="button"
            onClick={() => void deleteSelected()}
            disabled={selectedItems.length === 0 || actionBusy}
            title="Delete selected"
            className="grid size-8 place-items-center rounded-md text-rose-700 transition-colors hover:bg-rose-500/10 disabled:cursor-default disabled:opacity-50 dark:text-rose-300"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      ) : null}

      {hasAnyData ? (
        <div className="flex flex-wrap items-center gap-3">
          <LibrarySearchBar
            placeholder={
              searchPlaceholder ?? "Caută după nume, tip, conversație sau path…"
            }
            onDebouncedChange={setQuery}
            className="w-full max-w-md"
          />
          {actionMessage ? (
            <span className="text-[12px] text-muted-foreground">
              {actionMessage}
            </span>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      {data === null && loading ? (
        <AttachmentSkeleton type={type} />
      ) : filtered && filtered.length > 0 ? (
        renderItems(filtered, selection)
      ) : hasAnyData ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
          Niciun rezultat pentru{" "}
          <span className="font-medium text-foreground">
            &ldquo;{query}&rdquo;
          </span>
          .
        </div>
      ) : (
        <LibraryEmptyState
          icon={emptyIcon}
          title={emptyTitle}
          description={emptyDescription}
          hint={emptyHint}
        />
      )}
      {dialog}
    </div>
  )
}

function AttachmentSkeleton({ type }: { type: LibraryAttachmentType }) {
  if (type !== "media") {
    return (
      <ul className="flex flex-col gap-1.5" aria-hidden>
        {Array.from({ length: 7 }).map((_, i) => (
          <li
            key={i}
            className="flex h-[62px] animate-pulse items-center gap-3 rounded-xl border border-border/45 bg-card px-4"
          >
            <span className="size-9 rounded-md bg-muted/60" />
            <span className="min-w-0 flex-1 space-y-2">
              <span className="block h-3 w-2/5 rounded bg-muted/70" />
              <span className="block h-2.5 w-3/5 rounded bg-muted/45" />
            </span>
            <span className="size-7 rounded-md bg-muted/45" />
          </li>
        ))}
      </ul>
    )
  }

  return (
    <ul
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5"
      aria-hidden
    >
      {Array.from({ length: 10 }).map((_, i) => (
        <li
          key={i}
          className="relative aspect-square overflow-hidden rounded-lg border border-border/40 bg-muted/35"
        >
          <span className="library-media-shimmer absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-background/70 to-transparent" />
        </li>
      ))}
    </ul>
  )
}
