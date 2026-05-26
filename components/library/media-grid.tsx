"use client"

import * as React from "react"
import Link from "next/link"
import {
  Check,
  Download,
  Image as ImageIcon,
  MessageSquare,
  Play,
  X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { LibraryLoadableImage } from "./loadable-thumbnail"
import type { LibrarySelectionProps } from "./attachments-tab"
import {
  formatBytes,
  formatRelativeTime,
  libraryItemSourceLabel,
  libraryItemUrl,
  type LibraryAttachment,
} from "./use-attachments"

/**
 * Images + videos rendered as a responsive square grid.
 *
 * Layout: 2 cols on phone, 3 on tablet, 4 on small desktop, 5 on wide.
 * Each tile is a clickable button that opens a lightbox overlay.
 *
 * Videos get a play-arrow overlay and use the same upload URL — clicking
 * opens the lightbox where the inline `<video controls>` element handles
 * playback. Images render as `<img>` directly (native lazy loading).
 *
 * From the lightbox the user can click "View in chat" to jump to the
 * source conversation where the message lives. The lightbox traps focus
 * and supports Esc / arrow keys for navigation.
 */
export function MediaGrid({
  attachments,
  selection,
  className,
}: {
  attachments: LibraryAttachment[]
  selection?: LibrarySelectionProps
  className?: string
}) {
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null)

  const open = React.useCallback((i: number) => setActiveIndex(i), [])
  const close = React.useCallback(() => setActiveIndex(null), [])
  const next = React.useCallback(() => {
    setActiveIndex((i) => (i === null ? null : (i + 1) % attachments.length))
  }, [attachments.length])
  const prev = React.useCallback(() => {
    setActiveIndex((i) =>
      i === null ? null : (i - 1 + attachments.length) % attachments.length
    )
  }, [attachments.length])

  React.useEffect(() => {
    if (activeIndex === null) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close()
      else if (e.key === "ArrowRight") next()
      else if (e.key === "ArrowLeft") prev()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [activeIndex, close, next, prev])

  return (
    <>
      <ul
        className={cn(
          "grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5",
          className
        )}
        aria-label="Media grid"
      >
        {attachments.map((a, i) => (
          <MediaTile
            key={a.id}
            attachment={a}
            index={i}
            eager={i < 10}
            selected={selection?.selectedIds.has(a.id) ?? false}
            selectionMode={selection?.selectionMode ?? false}
            onOpen={open}
            onToggleSelection={selection?.onToggleSelection}
          />
        ))}
      </ul>

      {activeIndex !== null ? (
        <Lightbox
          attachment={attachments[activeIndex]}
          onClose={close}
          onNext={attachments.length > 1 ? next : undefined}
          onPrev={attachments.length > 1 ? prev : undefined}
          index={activeIndex}
          total={attachments.length}
        />
      ) : null}
    </>
  )
}

const MediaTile = React.memo(function MediaTile({
  attachment,
  index,
  eager,
  selected,
  selectionMode,
  onOpen,
  onToggleSelection,
}: {
  attachment: LibraryAttachment
  index: number
  eager: boolean
  selected: boolean
  selectionMode: boolean
  onOpen: (index: number) => void
  onToggleSelection?: (id: string) => void
}) {
  const [videoReady, setVideoReady] = React.useState(false)
  const fileUrl = libraryItemUrl(attachment)

  React.useEffect(() => {
    setVideoReady(false)
  }, [fileUrl])

  return (
    <li>
      <button
        type="button"
        onClick={() => {
          if (selectionMode && onToggleSelection)
            onToggleSelection(attachment.id)
          else onOpen(index)
        }}
        className={cn(
          "group/tile relative block aspect-square w-full overflow-hidden rounded-lg border border-border/45 bg-muted/30 transition-[border-color,box-shadow]",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          selectionMode ? "hover:border-primary/60" : "hover:shadow-md",
          selected && "border-primary shadow-sm ring-2 ring-primary/30"
        )}
        aria-label={
          selectionMode
            ? `Select ${attachment.filename}`
            : `Open ${attachment.filename}`
        }
        aria-pressed={selectionMode ? selected : undefined}
      >
        {attachment.type === "image" ? (
          <LibraryLoadableImage
            src={fileUrl}
            alt={attachment.filename}
            loading={eager ? "eager" : "lazy"}
            decoding="async"
            className="size-full object-cover group-hover/tile:scale-[1.03]"
          />
        ) : (
          <>
            {!videoReady ? (
              <span className="pointer-events-none absolute inset-0 overflow-hidden bg-muted/45">
                <span className="library-media-shimmer absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-background/70 to-transparent" />
              </span>
            ) : null}
            <video
              src={fileUrl}
              muted
              playsInline
              preload={eager ? "auto" : "metadata"}
              onLoadedData={() => setVideoReady(true)}
              onError={() => setVideoReady(true)}
              className={cn(
                "size-full object-cover transition-opacity duration-300",
                videoReady ? "opacity-100" : "opacity-0"
              )}
            />
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/15">
              <span className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white shadow-lg">
                <Play className="size-5" strokeWidth={1.75} />
              </span>
            </span>
          </>
        )}
        <span
          className={cn(
            "pointer-events-none absolute top-2 left-2 flex size-6 items-center justify-center rounded-full border border-white/70 bg-black/35 text-white shadow-sm transition-opacity",
            selectionMode || selected
              ? "opacity-100"
              : "opacity-0 group-hover/tile:opacity-100"
          )}
        >
          {selected ? <Check className="size-3.5" strokeWidth={2.4} /> : null}
        </span>
        <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/65 to-transparent px-2 pt-6 pb-1.5 text-[10.5px] text-white opacity-0 transition-opacity group-hover/tile:opacity-100">
          <span className="truncate">{attachment.filename}</span>
          <span className="shrink-0 tabular-nums">
            {formatBytes(attachment.size)}
          </span>
        </span>
      </button>
    </li>
  )
})

function Lightbox({
  attachment,
  onClose,
  onNext,
  onPrev,
  index,
  total,
}: {
  attachment: LibraryAttachment
  onClose: () => void
  onNext?: () => void
  onPrev?: () => void
  index: number
  total: number
}) {
  const fileUrl = libraryItemUrl(attachment)
  const chatHref =
    attachment.conversationId && attachment.messageId
      ? `/?conversation=${encodeURIComponent(attachment.conversationId)}#message-${encodeURIComponent(attachment.messageId)}`
      : null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={attachment.filename}
      className="fixed inset-0 z-50 flex animate-in items-center justify-center bg-black/75 backdrop-blur-sm duration-150 fade-in"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        title="Close (Esc)"
        className="absolute top-3 right-3 z-10 flex size-9 items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22"
      >
        <X className="size-5" />
      </button>

      {onPrev ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onPrev()
          }}
          aria-label="Previous"
          className="absolute top-1/2 left-3 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22"
        >
          ‹
        </button>
      ) : null}
      {onNext ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onNext()
          }}
          aria-label="Next"
          className="absolute top-1/2 right-3 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22"
        >
          ›
        </button>
      ) : null}

      <div
        className="flex max-h-[92vh] max-w-[92vw] flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {attachment.type === "video" ? (
          <video
            src={fileUrl}
            controls
            autoPlay
            className="max-h-[78vh] max-w-full rounded-lg bg-black"
          />
        ) : (
          <div className="relative inline-flex min-h-40 max-w-full min-w-64 items-center justify-center overflow-hidden rounded-lg bg-white/5">
            <LibraryLoadableImage
              src={fileUrl}
              alt={attachment.filename}
              loading="eager"
              className="max-h-[78vh] max-w-full object-contain"
              skeletonClassName="bg-white/10"
            />
          </div>
        )}
        <div className="flex w-full flex-wrap items-center justify-between gap-3 text-[12.5px] text-white/85">
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{attachment.filename}</span>
            <span className="text-[11px] text-white/55">
              {formatBytes(attachment.size)} ·{" "}
              {formatRelativeTime(attachment.messageTimestamp)} ·{" "}
              {libraryItemSourceLabel(attachment)} · {index + 1} / {total}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {chatHref ? (
              <Link
                href={chatHref}
                className="inline-flex items-center gap-1.5 rounded-md bg-white/12 px-2.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-white/22"
              >
                <MessageSquare className="size-3.5" />
                View in chat
              </Link>
            ) : null}
            <a
              href={fileUrl}
              download={attachment.filename}
              className="inline-flex items-center gap-1.5 rounded-md bg-white/12 px-2.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-white/22"
            >
              {attachment.type === "image" ? (
                <ImageIcon className="size-3.5" />
              ) : (
                <Download className="size-3.5" />
              )}
              Open file
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
