"use client"

import * as React from "react"
import Link from "next/link"
import { Check, Download, MessageSquare, Play, X } from "lucide-react"

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
 * Images + videos rendered as a justified (Google Photos style) gallery.
 *
 * Tiles keep each item's real aspect ratio: rows share a uniform height and
 * the items in a full row scale to fill the container edge-to-edge, so tall
 * screenshots and wide panoramas show whole — no center-cropping into a
 * square. Aspect ratios are measured client-side on load (the attachment
 * metadata carries no dimensions); until an item is measured it falls back to
 * a square and re-justifies once its intrinsic size is known.
 *
 * Each tile is a clickable button that opens a lightbox overlay. The lightbox
 * is offset by the left navigation rail (read from `[data-slot=sidebar-inset]`)
 * so the sidebar stays visible and usable while a preview is open.
 *
 * From the lightbox the user can click "View in chat" to jump to the source
 * conversation. Esc / arrow keys navigate.
 */

const ROW_GAP = 8 // px — matches the `gap-2` between tiles/rows
const DEFAULT_RATIO = 1 // square fallback until an item is measured

const useIsoLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect

function rowTargetHeight(width: number): number {
  if (width < 480) return 124
  if (width < 768) return 150
  if (width < 1280) return 172
  return 196
}

function clampRatio(ratio: number | undefined): number {
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) return DEFAULT_RATIO
  // Keep pathological panoramas / slivers from collapsing a whole row, while
  // still honouring genuinely tall (e.g. 200×1000) or wide images.
  return Math.min(6, Math.max(0.15, ratio))
}

interface LayoutCell {
  item: LibraryAttachment
  index: number
  ratio: number
}
interface LayoutRow {
  height: number
  cells: LayoutCell[]
  /** Full rows fill the container width; the trailing row is left-aligned. */
  justified: boolean
}

/**
 * Pack items into justified rows. Accumulates items until their combined width
 * at the target height fills the container, then scales that row's height so it
 * fits exactly. The final partial row keeps the target height (left-aligned).
 */
function computeRows(
  items: LibraryAttachment[],
  ratioOf: (item: LibraryAttachment) => number,
  width: number,
  target: number,
): LayoutRow[] {
  if (width <= 0 || items.length === 0) return []

  const rows: LayoutRow[] = []
  let cells: LayoutCell[] = []
  let ratioSum = 0

  const flush = (justified: boolean) => {
    if (cells.length === 0) return
    const gaps = (cells.length - 1) * ROW_GAP
    let height = target
    if (justified || ratioSum * target + gaps > width) {
      height = (width - gaps) / ratioSum
    }
    rows.push({ height, cells, justified })
    cells = []
    ratioSum = 0
  }

  items.forEach((item, index) => {
    const ratio = ratioOf(item)
    cells.push({ item, index, ratio })
    ratioSum += ratio
    const gaps = (cells.length - 1) * ROW_GAP
    if (ratioSum * target + gaps >= width) flush(true)
  })
  flush(false)

  return rows
}

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

  // --- Justified layout state -------------------------------------------------
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = React.useState(0)

  useIsoLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    // Window resize is a cheap fallback for environments that throttle or
    // disable ResizeObserver, and covers the sidebar collapse/expand reflow.
    window.addEventListener("resize", update)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", update)
    }
  }, [])

  // Measured aspect ratios live in a ref and are flushed once per frame, so a
  // burst of image `onLoad` events triggers a single re-layout, not one each.
  const ratiosRef = React.useRef<Map<string, number>>(new Map())
  const [ratioVersion, setRatioVersion] = React.useState(0)
  const rafRef = React.useRef<number | null>(null)

  const reportRatio = React.useCallback((id: string, ratio: number) => {
    const next = clampRatio(ratio)
    const current = ratiosRef.current.get(id)
    if (current !== undefined && Math.abs(current - next) < 0.001) return
    ratiosRef.current.set(id, next)
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        setRatioVersion((v) => v + 1)
      })
    }
  }, [])

  React.useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  const target = React.useMemo(() => rowTargetHeight(width), [width])
  const rows = React.useMemo(
    () =>
      computeRows(
        attachments,
        (item) => ratiosRef.current.get(item.id) ?? DEFAULT_RATIO,
        width,
        target,
      ),
    // ratioVersion stands in for the mutable ratiosRef read inside computeRows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attachments, width, target, ratioVersion],
  )

  // --- Lightbox navigation ----------------------------------------------------
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
      <div
        ref={containerRef}
        role="group"
        aria-label="Media grid"
        className={cn("flex flex-col gap-2", className)}
      >
        {rows.map((row, ri) => (
          <div
            key={ri}
            className="flex gap-2"
            style={{ height: row.height }}
          >
            {row.cells.map((cell) => (
              <MediaTile
                key={cell.item.id}
                attachment={cell.item}
                index={cell.index}
                eager={cell.index < 10}
                style={
                  row.justified
                    ? { flexGrow: cell.ratio, flexBasis: 0 }
                    : {
                        width: cell.ratio * row.height,
                        flexGrow: 0,
                        flexShrink: 0,
                      }
                }
                selected={selection?.selectedIds.has(cell.item.id) ?? false}
                selectionMode={selection?.selectionMode ?? false}
                onOpen={open}
                onToggleSelection={selection?.onToggleSelection}
                onRatio={reportRatio}
              />
            ))}
          </div>
        ))}
      </div>

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

function MediaTile({
  attachment,
  index,
  eager,
  style,
  selected,
  selectionMode,
  onOpen,
  onToggleSelection,
  onRatio,
}: {
  attachment: LibraryAttachment
  index: number
  eager: boolean
  style: React.CSSProperties
  selected: boolean
  selectionMode: boolean
  onOpen: (index: number) => void
  onToggleSelection?: (id: string) => void
  onRatio: (id: string, ratio: number) => void
}) {
  const [videoReady, setVideoReady] = React.useState(false)
  const fileUrl = libraryItemUrl(attachment)
  const id = attachment.id

  React.useEffect(() => {
    setVideoReady(false)
  }, [fileUrl])

  const handleNaturalSize = React.useCallback(
    (w: number, h: number) => {
      if (w > 0 && h > 0) onRatio(id, w / h)
    },
    [id, onRatio]
  )

  return (
    <button
      type="button"
      style={style}
      onClick={() => {
        if (selectionMode && onToggleSelection) onToggleSelection(id)
        else onOpen(index)
      }}
      className={cn(
        "group/tile relative block h-full min-w-0 overflow-hidden rounded-lg border border-border/45 bg-muted/30 transition-[border-color,box-shadow]",
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
          onNaturalSize={handleNaturalSize}
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
            onLoadedMetadata={(e) => {
              const v = e.currentTarget
              handleNaturalSize(v.videoWidth, v.videoHeight)
            }}
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
  )
}

/**
 * Tracks the left edge of the main content area (the navigation rail's width,
 * which collapses 18rem ↔ 3rem and is 0 on mobile where the rail is off-canvas)
 * so the lightbox overlay can start after the sidebar instead of covering it.
 */
function useContentLeftInset(): number {
  const [left, setLeft] = React.useState(0)
  useIsoLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')
    if (!el) return
    const update = () => setLeft(el.getBoundingClientRect().left)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener("resize", update)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", update)
    }
  }, [])
  return left
}

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
  const leftInset = useContentLeftInset()
  const chatHref =
    attachment.conversationId && attachment.messageId
      ? `/?chat=${encodeURIComponent(attachment.conversationId)}&msg=${encodeURIComponent(attachment.messageId)}`
      : null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={attachment.filename}
      className="fixed inset-0 z-50 flex animate-in items-center justify-center bg-black/75 backdrop-blur-sm duration-150 fade-in"
      style={{ left: leftInset }}
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
              <Download className="size-3.5" />
              Download
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
