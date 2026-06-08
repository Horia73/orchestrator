"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { X, ChevronLeft, ChevronRight } from "lucide-react"
import { appPath } from "@/lib/app-path"
import { PdfViewer } from "@/components/pdf-viewer"
import { SpreadsheetViewer } from "@/components/office/spreadsheet-viewer"
import { DocxViewer } from "@/components/office/docx-viewer"
import { PptxViewer } from "@/components/office/pptx-viewer"
import { SvgViewer } from "@/components/office/svg-viewer"
import { CodeViewer } from "@/components/code-viewer"
import { ViewerErrorBoundary } from "@/components/office/viewer-error-boundary"
import { isDocxFile, isSvgFile, isCodeOrTextFile } from "@/lib/preview-kinds"
import type { Attachment } from "@/lib/types"

interface FilePreviewModalProps {
    attachment: Attachment | null
    /** Sibling attachments in the same group. When more than one is an
     *  image/video, the lightbox shows left/right gallery navigation. */
    gallery?: Attachment[]
    onClose: () => void
}

// ---------------------------------------------------------------------------
// Shared modal shell — the dark, near-full-screen frame every document viewer
// (PDF, spreadsheet, presentation, docx, code) renders into.
// ---------------------------------------------------------------------------

function ModalShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-2 md:p-3"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
        >
            <div
                className="h-[96vh] w-full max-w-[98vw] overflow-hidden rounded-lg bg-pdf-canvas shadow-2xl ring-1 ring-black/35"
                onClick={(e) => e.stopPropagation()}
            >
                {children}
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function FilePreviewModal({ attachment, gallery, onClose }: FilePreviewModalProps) {
    const isOpen = !!attachment
    const [mounted, setMounted] = React.useState(false)

    // Navigable siblings: images/videos render in the lightbox, so the
    // left/right arrows only cycle through those (PDFs/files are skipped).
    const navItems = React.useMemo(() => {
        const source = gallery && gallery.length ? gallery : attachment ? [attachment] : []
        return source.filter(a => a.type === "image" || a.type === "video")
    }, [gallery, attachment])

    // Which sibling is showing. Seeded from the opened attachment and reset
    // whenever a different attachment is opened; arrow navigation mutates it
    // without touching the parent's selection state.
    const [currentId, setCurrentId] = React.useState<string | null>(attachment?.id ?? null)
    React.useEffect(() => { setCurrentId(attachment?.id ?? null) }, [attachment?.id])

    const showPrev = React.useCallback(() => {
        setCurrentId(id => {
            const i = navItems.findIndex(a => a.id === id)
            return i > 0 ? navItems[i - 1].id : id
        })
    }, [navItems])
    const showNext = React.useCallback(() => {
        setCurrentId(id => {
            const i = navItems.findIndex(a => a.id === id)
            return i >= 0 && i < navItems.length - 1 ? navItems[i + 1].id : id
        })
    }, [navItems])

    React.useEffect(() => { setMounted(true) }, [])

    React.useEffect(() => {
        if (!isOpen) return
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") { onClose(); return }
            if (e.key === "ArrowLeft") showPrev()
            else if (e.key === "ArrowRight") showNext()
        }
        window.addEventListener("keydown", handler)
        return () => window.removeEventListener("keydown", handler)
    }, [isOpen, onClose, showPrev, showNext])

    React.useEffect(() => {
        if (!isOpen) return
        const { style } = document.body
        const prevOverflow = style.overflow
        const prevPaddingRight = style.paddingRight
        const computedPR = Number.parseFloat(window.getComputedStyle(document.body).paddingRight) || 0
        const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
        style.overflow = "hidden"
        if (scrollbarWidth > 0) style.paddingRight = `${computedPR + scrollbarWidth}px`
        return () => { style.overflow = prevOverflow; style.paddingRight = prevPaddingRight }
    }, [isOpen])

    if (!mounted || !attachment) return null

    // The sibling currently on screen. Falls back to the opened attachment
    // (e.g. a PDF, which is filtered out of navItems) so direct opens still work.
    const active = navItems.find(a => a.id === currentId) ?? attachment
    const activeIndex = navItems.findIndex(a => a.id === active.id)
    const hasGallery = navItems.length > 1 && activeIndex >= 0
    const url = active.url ?? appPath(`/api/uploads/${encodeURIComponent(active.id)}`)

    // --- Document viewers (share the modal shell + error-boundary fallback) ---
    // Key the shell by attachment id so opening a different file while the modal
    // is already open mounts a fresh viewer — otherwise per-file state (selected
    // sheet, zoom, refs, error) would leak from the previous document.
    const framed = (node: React.ReactNode, withBoundary = true) =>
        createPortal(
            <ModalShell key={active.id} onClose={onClose}>
                {withBoundary ? (
                    <ViewerErrorBoundary filename={active.filename} downloadUrl={url} onClose={onClose}>
                        {node}
                    </ViewerErrorBoundary>
                ) : (
                    node
                )}
            </ModalShell>,
            document.body
        )

    if (active.type === "pdf") {
        return framed(<PdfViewer url={url} filename={active.filename} onClose={onClose} />, false)
    }
    if (active.type === "spreadsheet") {
        return framed(<SpreadsheetViewer url={url} filename={active.filename} mimeType={active.mimeType} onClose={onClose} />)
    }
    if (active.type === "presentation") {
        return framed(
            <PptxViewer
                previewUrl={appPath(`/api/uploads/${encodeURIComponent(active.id)}/preview-pdf`)}
                downloadUrl={url}
                filename={active.filename}
                onClose={onClose}
            />
        )
    }
    if (isSvgFile(active)) {
        return framed(<SvgViewer url={url} filename={active.filename} onClose={onClose} />)
    }
    if (isDocxFile(active)) {
        return framed(<DocxViewer url={url} filename={active.filename} onClose={onClose} />)
    }
    if (isCodeOrTextFile(active)) {
        return framed(<CodeViewer url={url} filename={active.filename} onClose={onClose} />)
    }

    // --- Image / video lightbox + generic download fallback ---
    return createPortal(
        <div className="fixed inset-0 z-[100] flex flex-col" onClick={onClose}>
            <div className="absolute inset-0 bg-black/80" />
            <div className="relative z-10 flex items-center justify-between px-5 py-3 shrink-0" onClick={(e) => e.stopPropagation()}>
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-white/90">
                    <span className="truncate max-w-[60vw]">{active.filename}</span>
                    {hasGallery && (
                        <span className="shrink-0 tabular-nums text-white/55">{activeIndex + 1} / {navItems.length}</span>
                    )}
                </span>
                <button
                    type="button"
                    onClick={onClose}
                    className="flex size-9 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                    aria-label="Close"
                >
                    <X className="size-5" />
                </button>
            </div>
            <div className="relative z-[1] flex-1 w-full flex items-center justify-center px-3 pb-3 min-h-0 overflow-hidden" onClick={(e) => e.stopPropagation()}>
                {hasGallery && (
                    <button
                        type="button"
                        onClick={showPrev}
                        disabled={activeIndex <= 0}
                        className="absolute left-2 top-1/2 z-10 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/60 hover:text-white disabled:pointer-events-none disabled:opacity-25"
                        aria-label="Previous image"
                    >
                        <ChevronLeft className="size-6" />
                    </button>
                )}
                {active.type === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt={active.filename} className="max-w-full max-h-full rounded-lg object-contain" />
                ) : active.type === "video" ? (
                    <video
                        key={active.id}
                        src={url}
                        controls
                        autoPlay
                        className="max-h-full max-w-full rounded-lg bg-black"
                    />
                ) : (
                    <div className="flex flex-col items-center gap-4 text-white/80 bg-white/10 backdrop-blur-md rounded-2xl px-10 py-8">
                        <span className="text-lg font-medium text-white">{active.filename}</span>
                        <span className="text-sm">{(active.size / 1024).toFixed(1)} KB</span>
                        <a href={url} download={active.filename} className="text-sm text-white underline underline-offset-2 hover:text-white/80">
                            Download file
                        </a>
                    </div>
                )}
                {hasGallery && (
                    <button
                        type="button"
                        onClick={showNext}
                        disabled={activeIndex >= navItems.length - 1}
                        className="absolute right-2 top-1/2 z-10 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white/80 backdrop-blur-sm transition-colors hover:bg-black/60 hover:text-white disabled:pointer-events-none disabled:opacity-25"
                        aria-label="Next image"
                    >
                        <ChevronRight className="size-6" />
                    </button>
                )}
            </div>
        </div>,
        document.body
    )
}
