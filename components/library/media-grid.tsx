"use client"

import * as React from "react"
import Link from "next/link"
import { Image as ImageIcon, MessageSquare, Play, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatBytes, formatRelativeTime, type LibraryAttachment } from "./use-attachments"

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
    className,
}: {
    attachments: LibraryAttachment[]
    className?: string
}) {
    const [activeIndex, setActiveIndex] = React.useState<number | null>(null)

    const open = React.useCallback((i: number) => setActiveIndex(i), [])
    const close = React.useCallback(() => setActiveIndex(null), [])
    const next = React.useCallback(() => {
        setActiveIndex((i) => (i === null ? null : (i + 1) % attachments.length))
    }, [attachments.length])
    const prev = React.useCallback(() => {
        setActiveIndex((i) => (i === null ? null : (i - 1 + attachments.length) % attachments.length))
    }, [attachments.length])

    React.useEffect(() => {
        if (activeIndex === null) return
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') close()
            else if (e.key === 'ArrowRight') next()
            else if (e.key === 'ArrowLeft') prev()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [activeIndex, close, next, prev])

    return (
        <>
            <ul
                className={cn(
                    "grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5",
                    className,
                )}
                aria-label="Media grid"
            >
                {attachments.map((a, i) => (
                    <li key={a.id}>
                        <button
                            type="button"
                            onClick={() => open(i)}
                            className={cn(
                                "group/tile relative block aspect-square w-full overflow-hidden rounded-lg border border-border/45 bg-muted/30 transition-shadow",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                "hover:shadow-md",
                            )}
                            aria-label={`Open ${a.filename}`}
                        >
                            {a.type === 'image' ? (
                                <img
                                    src={`/api/uploads/${encodeURIComponent(a.id)}`}
                                    alt={a.filename}
                                    loading="lazy"
                                    className="size-full object-cover transition-transform group-hover/tile:scale-[1.03]"
                                />
                            ) : (
                                <>
                                    <video
                                        src={`/api/uploads/${encodeURIComponent(a.id)}`}
                                        muted
                                        playsInline
                                        preload="metadata"
                                        className="size-full object-cover"
                                    />
                                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/15">
                                        <span className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white shadow-lg">
                                            <Play className="size-5" strokeWidth={1.75} />
                                        </span>
                                    </span>
                                </>
                            )}
                            <span
                                className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/65 to-transparent px-2 pb-1.5 pt-6 text-[10.5px] text-white opacity-0 transition-opacity group-hover/tile:opacity-100"
                            >
                                <span className="truncate">{a.filename}</span>
                                <span className="shrink-0 tabular-nums">{formatBytes(a.size)}</span>
                            </span>
                        </button>
                    </li>
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
    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={attachment.filename}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm animate-in fade-in duration-150"
            onClick={onClose}
        >
            <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                title="Close (Esc)"
                className="absolute right-3 top-3 z-10 flex size-9 items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22"
            >
                <X className="size-5" />
            </button>

            {onPrev ? (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onPrev() }}
                    aria-label="Previous"
                    className="absolute left-3 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22"
                >
                    ‹
                </button>
            ) : null}
            {onNext ? (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onNext() }}
                    aria-label="Next"
                    className="absolute right-3 top-1/2 z-10 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/22"
                >
                    ›
                </button>
            ) : null}

            <div className="flex max-h-[92vh] max-w-[92vw] flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
                {attachment.type === 'video' ? (
                    <video
                        src={`/api/uploads/${encodeURIComponent(attachment.id)}`}
                        controls
                        autoPlay
                        className="max-h-[78vh] max-w-full rounded-lg bg-black"
                    />
                ) : (
                    <img
                        src={`/api/uploads/${encodeURIComponent(attachment.id)}`}
                        alt={attachment.filename}
                        className="max-h-[78vh] max-w-full rounded-lg object-contain"
                    />
                )}
                <div className="flex w-full flex-wrap items-center justify-between gap-3 text-[12.5px] text-white/85">
                    <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{attachment.filename}</span>
                        <span className="text-[11px] text-white/55">
                            {formatBytes(attachment.size)} · {formatRelativeTime(attachment.messageTimestamp)} · {index + 1} / {total}
                        </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Link
                            href={`/?conversation=${encodeURIComponent(attachment.conversationId)}#message-${encodeURIComponent(attachment.messageId)}`}
                            className="inline-flex items-center gap-1.5 rounded-md bg-white/12 px-2.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-white/22"
                        >
                            <MessageSquare className="size-3.5" />
                            View in chat
                        </Link>
                        <a
                            href={`/api/uploads/${encodeURIComponent(attachment.id)}`}
                            download={attachment.filename}
                            className="inline-flex items-center gap-1.5 rounded-md bg-white/12 px-2.5 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-white/22"
                        >
                            <ImageIcon className="size-3.5" />
                            Open file
                        </a>
                    </div>
                </div>
            </div>
        </div>
    )
}
