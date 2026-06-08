"use client"

import * as React from "react"
import { FileText, Loader2, AlertTriangle, ZoomIn, ZoomOut, Info } from "lucide-react"
import { ViewerFrame, ViewerToolbar, FormatBadge, toolbarBtnCls } from "@/components/office/viewer-chrome"

const MIN_ZOOM = 0.5
const MAX_ZOOM = 2
const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100))

export function DocxViewer({ url, filename, onClose }: { url: string; filename: string; onClose: () => void }) {
    const hostRef = React.useRef<HTMLDivElement>(null)
    const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading")
    const [zoom, setZoom] = React.useState(1)

    React.useEffect(() => {
        let cancelled = false
        async function render() {
            try {
                const res = await fetch(url)
                if (!res.ok) throw new Error(`fetch ${res.status}`)
                const buf = await res.arrayBuffer()
                if (cancelled) return
                const docx = await import("docx-preview")
                const host = hostRef.current
                if (!host || cancelled) return
                host.innerHTML = ""
                await docx.renderAsync(buf, host, undefined, {
                    inWrapper: true,
                    breakPages: true,
                    ignoreLastRenderedPageBreak: true,
                    renderHeaders: true,
                    renderFooters: true,
                    renderFootnotes: true,
                    useBase64URL: true,
                })
                if (cancelled) return
                // docx-preview injects live DOM (incl. <a> built straight from the
                // document's relationships) with NO scheme validation. A crafted
                // .docx can carry a `javascript:`/`data:` hyperlink that would run
                // in this same-origin app on click. Neutralize dangerous schemes
                // and harden the rest before showing the result.
                host.querySelectorAll("a[href]").forEach((a) => {
                    const href = (a.getAttribute("href") || "").trim().toLowerCase()
                    if (href.startsWith("javascript:") || href.startsWith("data:") || href.startsWith("vbscript:")) {
                        a.removeAttribute("href")
                    } else {
                        a.setAttribute("target", "_blank")
                        a.setAttribute("rel", "noopener noreferrer nofollow")
                    }
                })
                setStatus("ready")
            } catch (err) {
                console.error("DOCX preview failed:", err)
                if (!cancelled) setStatus("error")
            }
        }
        render()
        return () => {
            cancelled = true
        }
    }, [url])

    return (
        <ViewerFrame>
            <ViewerToolbar
                icon={<FileText className="size-4 shrink-0 text-pdf-text-muted" />}
                filename={filename}
                badge={<FormatBadge label="DOCX" />}
                downloadUrl={url}
                downloadName={filename}
                onClose={onClose}
            >
                <button
                    type="button"
                    onClick={() => setZoom((z) => clamp(z - 0.1))}
                    disabled={zoom <= MIN_ZOOM}
                    className={toolbarBtnCls}
                    aria-label="Zoom out"
                    title="Zoom out"
                >
                    <ZoomOut className="size-4" />
                </button>
                <span className="w-12 text-center text-xs tabular-nums text-pdf-text-muted select-none">{Math.round(zoom * 100)}%</span>
                <button
                    type="button"
                    onClick={() => setZoom((z) => clamp(z + 0.1))}
                    disabled={zoom >= MAX_ZOOM}
                    className={toolbarBtnCls}
                    aria-label="Zoom in"
                    title="Zoom in"
                >
                    <ZoomIn className="size-4" />
                </button>
                <div className="mx-1 h-6 w-px bg-pdf-divider" />
            </ViewerToolbar>

            <div className="relative min-h-0 flex-1 bg-pdf-canvas">
                {status === "loading" ? (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-pdf-text">
                        <Loader2 className="mr-2 size-5 animate-spin" />
                        Loading document…
                    </div>
                ) : null}
                {status === "error" ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center text-pdf-text-muted">
                        <AlertTriangle className="size-7 text-amber-400" />
                        <p className="text-sm text-pdf-text">This document couldn&apos;t be previewed.</p>
                        <a href={url} download={filename} className="text-sm text-white underline underline-offset-2 hover:text-white/80">
                            Download {filename}
                        </a>
                    </div>
                ) : null}
                <div className="h-full overflow-auto" style={{ display: status === "ready" ? "block" : "none", overscrollBehavior: "contain" }}>
                    {status === "ready" ? (
                        <div className="flex items-center gap-1.5 px-4 pt-3 text-[11px] text-pdf-text-muted">
                            <Info className="size-3.5" />
                            Field values (page numbers, table of contents) and exact pagination may differ from Word.
                        </div>
                    ) : null}
                    <div className="py-4" style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}>
                        <div ref={hostRef} />
                    </div>
                </div>
            </div>
        </ViewerFrame>
    )
}
