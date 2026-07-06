"use client"

import * as React from "react"
import {
    X, PanelLeftClose, PanelLeftOpen, ZoomIn, ZoomOut,
    Printer, Download, RotateCw, ChevronLeft, ChevronRight,
    FileText, Loader2, Lock,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { usePreviewZoomGestures } from "@/hooks/use-preview-zoom-gestures"

// ---------------------------------------------------------------------------
// Chrome-style PDF Viewer. Pages are rendered to JPEG dataURLs sequentially and
// streamed into the list as they complete (incremental first paint, no blocking
// on the whole document).
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

// Print rasterized page images via an off-screen (NOT display:none) iframe.
// Safari refuses to render a PDF embedded in a hidden iframe, so printing the
// raw PDF blob there produces blank pages; printing plain <img> HTML is reliable
// across browsers. The iframe is positioned off-screen rather than hidden so its
// content is still laid out and actually paints for the print. One image per
// printed page, contained so a page is never split across two sheets.
function printPageImages(images: string[]): void {
    const iframe = document.createElement("iframe")
    iframe.setAttribute("aria-hidden", "true")
    iframe.style.position = "fixed"
    iframe.style.left = "-10000px"
    iframe.style.top = "0"
    iframe.style.width = "100%"
    iframe.style.height = "100%"
    iframe.style.border = "0"
    iframe.srcdoc = `<!doctype html><meta charset="utf-8"><style>
@page { margin: 0 }
* { margin: 0; padding: 0; box-sizing: border-box }
.page { display: flex; align-items: center; justify-content: center; width: 100%; height: 100vh; overflow: hidden; break-inside: avoid; page-break-after: always }
.page:last-child { page-break-after: auto }
.page img { max-width: 100%; max-height: 100%; }
</style>${images.map((src) => `<div class="page"><img src="${src}"></div>`).join("")}`
    iframe.onload = () => {
        const win = iframe.contentWindow
        const doc = iframe.contentDocument
        const imgs = doc ? Array.from(doc.images) : []
        Promise.all(
            imgs.map((img) =>
                img.complete
                    ? Promise.resolve()
                    : new Promise<void>((resolve) => {
                          img.onload = () => resolve()
                          img.onerror = () => resolve()
                      })
            )
        ).then(() => {
            win?.focus()
            win?.print()
            setTimeout(() => iframe.remove(), 1000)
        })
    }
    document.body.appendChild(iframe)
}

export function PdfViewer({
    url,
    filename,
    onClose,
    downloadUrl,
    downloadName,
}: {
    url: string
    filename: string
    onClose: () => void
    /** When the rendered PDF is derived (e.g. converted from PPTX), Download
     *  should fetch the original file instead of the PDF. Defaults to `url`. */
    downloadUrl?: string
    downloadName?: string
}) {
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
    const [printing, setPrinting] = React.useState(false)
    // Password-protected PDFs: pdfjs pauses the loading task and hands us a
    // callback; the promise stays pending until the callback gets the password.
    const [passwordPrompt, setPasswordPrompt] = React.useState<null | { incorrect: boolean }>(null)
    const [passwordInput, setPasswordInput] = React.useState("")
    const passwordCallbackRef = React.useRef<((password: string) => void) | null>(null)

    // Render pages
    React.useEffect(() => {
        let cancelled = false
        setPasswordPrompt(null)
        setPasswordInput("")
        passwordCallbackRef.current = null
        async function render() {
            try {
                const pdfjsLib = await import("pdfjs-dist")
                pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"
                const response = await fetch(url)
                const bytes = await response.arrayBuffer()
                if (cancelled) return
                pdfBytesRef.current = bytes.slice(0)
                const loadingTask = pdfjsLib.getDocument({ data: bytes })
                loadingTask.onPassword = (updatePassword: (password: string) => void, reason: number) => {
                    if (cancelled) return
                    passwordCallbackRef.current = updatePassword
                    setPasswordInput("")
                    setPasswordPrompt({ incorrect: reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD })
                }
                const pdf = await loadingTask.promise
                if (cancelled) return
                setPasswordPrompt(null)
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

    // --- Anchored zoom -----------------------------------------------------
    // Every zoom keeps one content point fixed under the gesture (cursor,
    // pinch midpoint, or viewport center for the toolbar buttons). The anchor
    // is remembered as a fraction of a reference page, and after React commits
    // the new page widths a layout effect shifts the scroll position so that
    // page-relative point lands back under the anchor. Measuring real
    // geometry (instead of scaling scroll offsets) keeps it exact across the
    // fits-viewport → overflows-viewport transition and the fixed page gaps.
    const zoomRef = React.useRef(zoom)
    React.useEffect(() => {
        zoomRef.current = zoom
    }, [zoom])
    const zoomAnchorRef = React.useRef<{ ax: number; ay: number; pageIndex: number; fx: number; fy: number } | null>(null)

    const zoomAtPoint = React.useCallback((clientX: number, clientY: number, nextZoomRaw: number) => {
        const container = mainRef.current
        const next = clampZoom(nextZoomRaw)
        if (next === zoomRef.current) return
        if (!container) { setZoom(next); return }
        // Reference page: the one under the anchor, else the nearest row.
        let pageIndex = -1
        let bestDist = Infinity
        for (let i = 0; i < pageRefs.current.length; i++) {
            const el = pageRefs.current[i]
            if (!el) continue
            const r = el.getBoundingClientRect()
            const d = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0
            if (d < bestDist) { bestDist = d; pageIndex = i }
            if (d === 0) break
        }
        const card = pageIndex >= 0 ? (pageRefs.current[pageIndex]?.firstElementChild as HTMLElement | null) : null
        if (!card) { setZoom(next); return }
        const containerRect = container.getBoundingClientRect()
        const cardRect = card.getBoundingClientRect()
        zoomAnchorRef.current = {
            ax: clientX - containerRect.left,
            ay: clientY - containerRect.top,
            pageIndex,
            fx: cardRect.width > 0 ? (clientX - cardRect.left) / cardRect.width : 0.5,
            fy: cardRect.height > 0 ? (clientY - cardRect.top) / cardRect.height : 0.5,
        }
        setZoom(next)
    }, [])

    React.useLayoutEffect(() => {
        const anchor = zoomAnchorRef.current
        zoomAnchorRef.current = null
        if (!anchor) return
        const container = mainRef.current
        const card = pageRefs.current[anchor.pageIndex]?.firstElementChild as HTMLElement | null
        if (!container || !card) return
        const containerRect = container.getBoundingClientRect()
        const cardRect = card.getBoundingClientRect()
        container.scrollLeft += cardRect.left - containerRect.left + anchor.fx * cardRect.width - anchor.ax
        container.scrollTop += cardRect.top - containerRect.top + anchor.fy * cardRect.height - anchor.ay
    }, [zoom])

    const zoomStep = React.useCallback((delta: number) => {
        const container = mainRef.current
        if (!container) { setZoom(prev => clampZoom(prev + delta)); return }
        const rect = container.getBoundingClientRect()
        zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, zoomRef.current + delta)
    }, [zoomAtPoint])

    // Ctrl+scroll, trackpad pinch and touch pinch-to-zoom
    usePreviewZoomGestures(mainRef, {
        onZoomAt: React.useCallback((x: number, y: number, factor: number) => {
            zoomAtPoint(x, y, zoomRef.current * factor)
        }, [zoomAtPoint]),
        onPinchPan: React.useCallback((dx: number, dy: number) => {
            const container = mainRef.current
            if (!container) return
            container.scrollLeft -= dx
            container.scrollTop -= dy
        }, []),
    })

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

    const handlePasswordSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        const submit = passwordCallbackRef.current
        if (!submit || !passwordInput) return
        submit(passwordInput)
    }

    const handlePrint = React.useCallback(async () => {
        const bytes = pdfBytesRef.current
        if (printing || !bytes) return
        setPrinting(true)
        try {
            const pdfjsLib = await import("pdfjs-dist")
            pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"
            // Rasterize at 3x (~216 DPI for a 72-DPI PDF) so A3 line work stays
            // legible on paper. slice(0) hands getDocument its own buffer —
            // it detaches the one it is given, and we keep pdfBytesRef for reuse.
            const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise
            const images: string[] = []
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i)
                const natural = page.getViewport({ scale: 1 })
                // Target ~3x (~216 DPI) for crisp A3 line work, but cap the longest
                // side so large-format pages (A1/A0) don't exceed the browser's
                // canvas area limit (~16M px) and come back blank.
                const scale = Math.max(1, Math.min(3, 4500 / Math.max(natural.width, natural.height)))
                const viewport = page.getViewport({ scale })
                const canvas = document.createElement("canvas")
                canvas.width = viewport.width
                canvas.height = viewport.height
                const ctx = canvas.getContext("2d")
                if (!ctx) continue
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await page.render({ canvasContext: ctx, viewport } as any).promise
                images.push(canvas.toDataURL("image/png"))
            }
            if (images.length > 0) printPageImages(images)
        } catch (err) {
            console.error("PDF print failed:", err)
        } finally {
            setPrinting(false)
        }
    }, [printing])

    const handleDownload = () => {
        const a = document.createElement("a")
        a.href = downloadUrl ?? url
        a.download = downloadName ?? filename
        a.click()
    }

    return (
        <section className="flex h-full min-h-0 flex-col bg-pdf-canvas text-pdf-text overflow-hidden rounded-lg" onClick={(e) => e.stopPropagation()}>
            {/* Toolbar */}
            <header className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-pdf-border bg-pdf-toolbar pr-[calc(0.75rem+env(safe-area-inset-right))] pl-[calc(0.75rem+env(safe-area-inset-left))] pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2 select-none md:px-3 md:pt-2">
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
                        onClick={() => zoomStep(-0.1)}
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
                        onClick={() => zoomStep(0.1)}
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
                    <button type="button" onClick={handlePrint} disabled={printing || pages.length === 0} className={toolbarBtnCls} aria-label="Print" title="Print">
                        {printing ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />}
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

                {/* Main pages area. min-w-0 is load-bearing: without it, zoomed
                    pages push their max-content width into this flex item's
                    automatic minimum size — the scroll container then never
                    overflows horizontally (the modal clips it instead) and the
                    right side of a zoomed page becomes unreachable. */}
                <div className="relative min-h-0 min-w-0 flex-1 bg-pdf-canvas">
                    <div ref={mainRef} className="h-full overflow-auto" style={{ overscrollBehavior: "contain" }}>
                        {loading && pages.length === 0 && !passwordPrompt && (
                            <div className="flex h-full items-center justify-center text-sm text-pdf-text">
                                <Loader2 className="mr-2 size-5 animate-spin" />
                                Loading PDF...
                            </div>
                        )}
                        {passwordPrompt && pages.length === 0 && (
                            <div className="flex h-full items-center justify-center p-6">
                                <form
                                    onSubmit={handlePasswordSubmit}
                                    className="flex w-full max-w-xs flex-col items-center gap-3 rounded-lg border border-pdf-border bg-pdf-toolbar p-6 text-center shadow-md"
                                >
                                    <Lock className="size-6 text-pdf-text-muted" />
                                    <p className="text-sm text-pdf-text">This PDF is password-protected.</p>
                                    {passwordPrompt.incorrect && (
                                        <p className="text-xs text-red-400">Incorrect password. Try again.</p>
                                    )}
                                    <input
                                        type="password"
                                        autoFocus
                                        value={passwordInput}
                                        onChange={(e) => setPasswordInput(e.target.value)}
                                        placeholder="Password"
                                        aria-label="PDF password"
                                        className="h-9 w-full rounded border border-pdf-divider bg-black/40 px-2 text-base text-pdf-text outline-none focus:ring-1 focus:ring-pdf-accent md:text-sm"
                                    />
                                    <button
                                        type="submit"
                                        disabled={!passwordInput}
                                        className="h-9 w-full rounded bg-pdf-accent text-sm font-medium text-black/80 transition-opacity disabled:opacity-40"
                                    >
                                        Unlock
                                    </button>
                                </form>
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
