"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import {
    X, PanelLeftClose, PanelLeftOpen, ZoomIn, ZoomOut,
    Printer, Download, RotateCw, ChevronLeft, ChevronRight,
    FileText, Loader2,
} from "lucide-react"
import { appPath } from "@/lib/app-path"
import { cn } from "@/lib/utils"
import type { Attachment } from "@/lib/types"

interface FilePreviewModalProps {
    attachment: Attachment | null
    onClose: () => void
}

// ---------------------------------------------------------------------------
// Chrome-style PDF Viewer
// ---------------------------------------------------------------------------

interface PdfPage {
    dataUrl: string
    width: number
    height: number
}

const MIN_ZOOM = 0.25
const MAX_ZOOM = 5
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100))

const toolbarBtnCls = "flex size-8 items-center justify-center rounded text-pdf-text hover:bg-pdf-hover hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none"

function PdfViewer({ url, filename, onClose }: { url: string; filename: string; onClose: () => void }) {
    const mainRef = React.useRef<HTMLDivElement>(null)
    const [pages, setPages] = React.useState<PdfPage[]>([])
    const [totalPages, setTotalPages] = React.useState(0)
    const [loading, setLoading] = React.useState(true)
    const [sidebarOpen, setSidebarOpen] = React.useState(true)
    const [activePage, setActivePage] = React.useState(0)
    const [zoom, setZoom] = React.useState(1)
    const [rotation, setRotation] = React.useState(0)
    const [pageInput, setPageInput] = React.useState("1")
    const pageRefs = React.useRef<(HTMLDivElement | null)[]>([])
    const pdfBytesRef = React.useRef<ArrayBuffer | null>(null)

    // Render pages
    React.useEffect(() => {
        let cancelled = false
        async function render() {
            try {
                const pdfjsLib = await import("pdfjs-dist")
                pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"
                const response = await fetch(url)
                const bytes = await response.arrayBuffer()
                if (cancelled) return
                pdfBytesRef.current = bytes
                const pdf = await pdfjsLib.getDocument({ data: bytes }).promise
                if (cancelled) return
                setTotalPages(pdf.numPages)
                const rendered: PdfPage[] = []
                for (let i = 1; i <= pdf.numPages; i++) {
                    if (cancelled) return
                    const page = await pdf.getPage(i)
                    const viewport = page.getViewport({ scale: 1 })
                    const sv = page.getViewport({ scale: 2 })
                    const canvas = document.createElement("canvas")
                    canvas.width = sv.width
                    canvas.height = sv.height
                    const ctx = canvas.getContext("2d")!
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    await page.render({ canvasContext: ctx, viewport: sv } as any).promise
                    rendered.push({ dataUrl: canvas.toDataURL("image/jpeg", 0.92), width: viewport.width, height: viewport.height })
                    if (!cancelled) setPages([...rendered])
                }
            } catch (err) {
                console.error("PDF render failed:", err)
            } finally {
                if (!cancelled) setLoading(false)
            }
        }
        render()
        return () => { cancelled = true }
    }, [url])

    // Track active page on scroll
    React.useEffect(() => {
        const container = mainRef.current
        if (!container || pages.length === 0) return
        const onScroll = () => {
            const center = container.scrollTop + container.clientHeight / 3
            let closest = 0, minDist = Infinity
            for (let i = 0; i < pageRefs.current.length; i++) {
                const el = pageRefs.current[i]
                if (!el) continue
                const dist = Math.abs(el.offsetTop - center)
                if (dist < minDist) { minDist = dist; closest = i }
            }
            if (closest !== activePage) {
                setActivePage(closest)
                setPageInput(String(closest + 1))
            }
        }
        container.addEventListener("scroll", onScroll, { passive: true })
        return () => container.removeEventListener("scroll", onScroll)
    }, [pages.length, activePage])

    // Ctrl+scroll and pinch-to-zoom
    React.useEffect(() => {
        const container = mainRef.current
        if (!container) return
        const onWheel = (e: WheelEvent) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault()
                setZoom(prev => clampZoom(prev + -e.deltaY * 0.01))
            }
        }
        const onGestureChange = (e: Event) => {
            e.preventDefault()
            setZoom(prev => clampZoom(prev * (e as unknown as { scale: number }).scale))
        }
        const onGestureStart = (e: Event) => e.preventDefault()
        container.addEventListener("wheel", onWheel, { passive: false })
        container.addEventListener("gesturestart", onGestureStart, { passive: false } as EventListenerOptions)
        container.addEventListener("gesturechange", onGestureChange, { passive: false } as EventListenerOptions)
        return () => {
            container.removeEventListener("wheel", onWheel)
            container.removeEventListener("gesturestart", onGestureStart)
            container.removeEventListener("gesturechange", onGestureChange)
        }
    }, [])

    const scrollToPage = React.useCallback((index: number) => {
        const el = pageRefs.current[index]
        if (el && mainRef.current) mainRef.current.scrollTo({ top: el.offsetTop - 8, behavior: "instant" })
    }, [])

    const commitPageInput = () => {
        const num = parseInt(pageInput)
        if (num >= 1 && num <= totalPages) scrollToPage(num - 1)
        else setPageInput(String(activePage + 1))
    }
    const handlePageSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        commitPageInput()
    }

    const goToPage = React.useCallback((pageIndex: number) => {
        const clamped = Math.max(0, Math.min(totalPages - 1, pageIndex))
        scrollToPage(clamped)
        setActivePage(clamped)
        setPageInput(String(clamped + 1))
    }, [scrollToPage, totalPages])

    const handlePrint = () => {
        if (!pdfBytesRef.current) return
        const blob = new Blob([pdfBytesRef.current], { type: "application/pdf" })
        const blobUrl = URL.createObjectURL(blob)
        const iframe = document.createElement("iframe")
        iframe.style.display = "none"
        iframe.src = blobUrl
        document.body.appendChild(iframe)
        iframe.addEventListener("load", () => {
            iframe.contentWindow?.print()
            setTimeout(() => { document.body.removeChild(iframe); URL.revokeObjectURL(blobUrl) }, 1000)
        })
    }

    const handleDownload = () => {
        const a = document.createElement("a")
        a.href = url
        a.download = filename
        a.click()
    }

    return (
        <section className="flex h-full min-h-0 flex-col bg-pdf-canvas text-pdf-text overflow-hidden rounded-lg" onClick={(e) => e.stopPropagation()}>
            {/* Toolbar */}
            <header className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-pdf-border bg-pdf-toolbar px-3 py-2 select-none">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <button
                        type="button"
                        onClick={() => setSidebarOpen(!sidebarOpen)}
                        className={toolbarBtnCls}
                        aria-label={sidebarOpen ? "Hide thumbnails" : "Show thumbnails"}
                        aria-pressed={sidebarOpen}
                        title={sidebarOpen ? "Hide thumbnails" : "Show thumbnails"}
                    >
                        {sidebarOpen ? <PanelLeftClose className="size-4" /> : <PanelLeftOpen className="size-4" />}
                    </button>
                    <FileText className="size-4 shrink-0 text-pdf-text-muted" />
                    <span className="truncate text-sm font-medium text-pdf-text" title={filename}>
                        {filename}
                    </span>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                    <button
                        type="button"
                        onClick={() => goToPage(activePage - 1)}
                        disabled={activePage <= 0 || totalPages <= 0}
                        className={toolbarBtnCls}
                        aria-label="Previous page"
                        title="Previous page"
                    >
                        <ChevronLeft className="size-4" />
                    </button>
                    <form onSubmit={handlePageSubmit} className="flex items-center gap-1 rounded-md border border-pdf-divider bg-black/40 px-2 py-1 text-xs text-pdf-text-muted">
                        <input
                            type="text"
                            value={pageInput}
                            inputMode="numeric"
                            onChange={(e) => setPageInput(e.target.value.replace(/[^\d]/g, ""))}
                            onBlur={commitPageInput}
                            className="h-6 w-12 rounded border border-pdf-divider bg-pdf-toolbar px-1 text-center text-xs text-pdf-text outline-none focus:ring-1 focus:ring-pdf-accent"
                            aria-label="Current page"
                        />
                        <span>/ {totalPages || "—"}</span>
                    </form>
                    <button
                        type="button"
                        onClick={() => goToPage(activePage + 1)}
                        disabled={activePage >= totalPages - 1 || totalPages <= 0}
                        className={toolbarBtnCls}
                        aria-label="Next page"
                        title="Next page"
                    >
                        <ChevronRight className="size-4" />
                    </button>

                    <div className="mx-1 h-6 w-px bg-pdf-divider" />

                    <button
                        type="button"
                        onClick={() => setZoom(prev => clampZoom(prev - 0.1))}
                        disabled={zoom <= MIN_ZOOM}
                        className={toolbarBtnCls}
                        aria-label="Zoom out"
                        title="Zoom out"
                    >
                        <ZoomOut className="size-4" />
                    </button>
                    <span className="w-12 text-center text-xs tabular-nums text-pdf-text-muted select-none">
                        {Math.round(zoom * 100)}%
                    </span>
                    <button
                        type="button"
                        onClick={() => setZoom(prev => clampZoom(prev + 0.1))}
                        disabled={zoom >= MAX_ZOOM}
                        className={toolbarBtnCls}
                        aria-label="Zoom in"
                        title="Zoom in"
                    >
                        <ZoomIn className="size-4" />
                    </button>

                    <div className="mx-1 h-6 w-px bg-pdf-divider" />

                    <button type="button" onClick={() => setRotation((r) => (r + 90) % 360)} className={toolbarBtnCls} aria-label="Rotate" title="Rotate">
                        <RotateCw className="size-4" />
                    </button>
                    <button type="button" onClick={handlePrint} className={toolbarBtnCls} aria-label="Print" title="Print">
                        <Printer className="size-4" />
                    </button>
                    <button type="button" onClick={handleDownload} className={toolbarBtnCls} aria-label="Download" title="Download">
                        <Download className="size-4" />
                    </button>
                    <button type="button" onClick={onClose} className={toolbarBtnCls} aria-label="Close" title="Close">
                        <X className="size-4" />
                    </button>
                </div>
            </header>

            <div className="flex min-h-0 flex-1">
                {/* Sidebar */}
                <aside
                    className={cn(
                        "flex shrink-0 flex-col overflow-hidden bg-pdf-sidebar transition-[width] duration-200 ease-in-out",
                        sidebarOpen ? "w-36 border-r border-pdf-border" : "w-0"
                    )}
                >
                    <div className="flex flex-col gap-1 overflow-y-auto p-2 w-36">
                        {pages.map((page, i) => (
                            <button
                                key={i}
                                type="button"
                                onClick={() => goToPage(i)}
                                className={cn(
                                    "flex w-full flex-col items-center gap-1 rounded-md p-1.5 text-[11px] tabular-nums transition-colors",
                                    i === activePage ? "bg-pdf-divider text-white" : "text-pdf-text-muted hover:bg-pdf-hover hover:text-white"
                                )}
                            >
                                <div className={cn(
                                    "flex items-center justify-center overflow-hidden rounded-sm bg-white shadow-sm",
                                    i === activePage ? "ring-2 ring-pdf-accent" : "ring-1 ring-black/35"
                                )} style={{ width: 116 }}>
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                        src={page.dataUrl}
                                        alt={`Page ${i + 1}`}
                                        className="block w-full bg-white"
                                        style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined }}
                                    />
                                </div>
                                <span>{i + 1}</span>
                            </button>
                        ))}
                    </div>
                </aside>

                {/* Main pages area */}
                <div className="relative min-h-0 flex-1 bg-pdf-canvas">
                    <div ref={mainRef} className="h-full overflow-auto" style={{ overscrollBehavior: "contain" }}>
                        {loading && pages.length === 0 && (
                            <div className="flex h-full items-center justify-center text-sm text-pdf-text">
                                <Loader2 className="mr-2 size-5 animate-spin" />
                                Loading PDF...
                            </div>
                        )}
                        {pages.length > 0 && (
                            <div className="flex min-h-full w-max min-w-full flex-col items-stretch gap-4 px-4 py-5">
                                {pages.map((page, i) => (
                                    <div
                                        key={i}
                                        ref={(el) => { pageRefs.current[i] = el }}
                                        className="flex justify-center scroll-mt-4"
                                    >
                                        <div
                                            className="overflow-hidden rounded-sm bg-white shadow-md ring-1 ring-black/30"
                                            style={{
                                                width: page.width * zoom,
                                                transform: rotation ? `rotate(${rotation}deg)` : undefined,
                                            }}
                                        >
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img src={page.dataUrl} alt={`Page ${i + 1}`} className="block w-full bg-white" />
                                        </div>
                                    </div>
                                ))}
                                {loading && (
                                    <div className="py-3 text-center text-xs text-pdf-text-muted">
                                        Loading page {pages.length + 1} of {totalPages}...
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </section>
    )
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function FilePreviewModal({ attachment, onClose }: FilePreviewModalProps) {
    const isOpen = !!attachment
    const [mounted, setMounted] = React.useState(false)

    React.useEffect(() => { setMounted(true) }, [])

    React.useEffect(() => {
        if (!isOpen) return
        const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
        window.addEventListener("keydown", handler)
        return () => window.removeEventListener("keydown", handler)
    }, [isOpen, onClose])

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

    const url = appPath(`/api/uploads/${encodeURIComponent(attachment.id)}`)

    if (attachment.type === "pdf") {
        return createPortal(
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-2 md:p-3" onClick={onClose} role="dialog" aria-modal="true">
                <div
                    className="h-[96vh] w-full max-w-[98vw] overflow-hidden rounded-lg bg-pdf-canvas shadow-2xl ring-1 ring-black/35"
                    onClick={(e) => e.stopPropagation()}
                >
                    <PdfViewer url={url} filename={attachment.filename} onClose={onClose} />
                </div>
            </div>,
            document.body
        )
    }

    return createPortal(
        <div className="fixed inset-0 z-[100] flex flex-col" onClick={onClose}>
            <div className="absolute inset-0 bg-black/80" />
            <div className="relative z-10 flex items-center justify-between px-5 py-3 shrink-0" onClick={(e) => e.stopPropagation()}>
                <span className="text-sm font-medium text-white/90 truncate max-w-[70vw]">{attachment.filename}</span>
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
                {attachment.type === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={url} alt={attachment.filename} className="max-w-full max-h-full rounded-lg object-contain" />
                ) : attachment.type === "video" ? (
                    <video
                        src={url}
                        controls
                        autoPlay
                        className="max-h-full max-w-full rounded-lg bg-black"
                    />
                ) : (
                    <div className="flex flex-col items-center gap-4 text-white/80 bg-white/10 backdrop-blur-md rounded-2xl px-10 py-8">
                        <span className="text-lg font-medium text-white">{attachment.filename}</span>
                        <span className="text-sm">{(attachment.size / 1024).toFixed(1)} KB</span>
                        <a href={url} download={attachment.filename} className="text-sm text-white underline underline-offset-2 hover:text-white/80">
                            Download file
                        </a>
                    </div>
                )}
            </div>
        </div>,
        document.body
    )
}
