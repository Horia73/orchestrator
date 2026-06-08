"use client"

import * as React from "react"
import { Image as ImageIcon, Code2, Loader2, AlertTriangle } from "lucide-react"
import { ViewerFrame, ViewerToolbar, FormatBadge, toolbarBtnCls } from "@/components/office/viewer-chrome"
import { SvgRenderer } from "@/components/artifacts/renderers/svg-renderer"
import { cn } from "@/lib/utils"

/**
 * Preview an uploaded .svg. The file is served as text/plain (so direct
 * navigation can't execute it as a same-origin document), so we fetch the
 * source and render it through the shared DOMPurify-backed SvgRenderer — the
 * picture, sanitized — with a toggle to inspect the raw source.
 */
export function SvgViewer({ url, filename, onClose }: { url: string; filename: string; onClose: () => void }) {
    const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading")
    const [source, setSource] = React.useState("")
    const [mode, setMode] = React.useState<"image" | "source">("image")

    React.useEffect(() => {
        let cancelled = false
        async function load() {
            try {
                const res = await fetch(url)
                if (!res.ok) throw new Error(`fetch ${res.status}`)
                const text = await res.text()
                if (cancelled) return
                setSource(text)
                setStatus("ready")
            } catch (err) {
                console.error("SVG preview failed:", err)
                if (!cancelled) setStatus("error")
            }
        }
        load()
        return () => {
            cancelled = true
        }
    }, [url])

    return (
        <ViewerFrame>
            <ViewerToolbar
                icon={<ImageIcon className="size-4 shrink-0 text-pdf-text-muted" />}
                filename={filename}
                badge={<FormatBadge label="SVG" />}
                downloadUrl={url}
                downloadName={filename}
                onClose={onClose}
            >
                <button
                    type="button"
                    onClick={() => setMode((m) => (m === "image" ? "source" : "image"))}
                    className={cn(toolbarBtnCls, mode === "source" && "bg-pdf-hover text-white")}
                    aria-pressed={mode === "source"}
                    aria-label={mode === "image" ? "View source" : "View image"}
                    title={mode === "image" ? "View source" : "View image"}
                >
                    <Code2 className="size-4" />
                </button>
                <div className="mx-1 h-6 w-px bg-pdf-divider" />
            </ViewerToolbar>

            <div className="relative min-h-0 flex-1">
                {status === "loading" ? (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-pdf-text">
                        <Loader2 className="mr-2 size-5 animate-spin" />
                        Loading…
                    </div>
                ) : status === "error" ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center text-pdf-text-muted">
                        <AlertTriangle className="size-7 text-amber-400" />
                        <p className="text-sm text-pdf-text">This file couldn&apos;t be previewed.</p>
                        <a href={url} download={filename} className="text-sm text-white underline underline-offset-2 hover:text-white/80">
                            Download {filename}
                        </a>
                    </div>
                ) : mode === "image" ? (
                    <div
                        className="absolute inset-0 flex items-center justify-center overflow-auto p-8"
                        style={{
                            // Checkerboard so transparent SVGs stay visible.
                            backgroundImage:
                                "linear-gradient(45deg,#e2e2e2 25%,transparent 25%),linear-gradient(-45deg,#e2e2e2 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e2e2e2 75%),linear-gradient(-45deg,transparent 75%,#e2e2e2 75%)",
                            backgroundSize: "20px 20px",
                            backgroundPosition: "0 0,0 10px,10px -10px,-10px 0",
                            backgroundColor: "#fff",
                        }}
                    >
                        <SvgRenderer source={source} className="max-h-full max-w-full [&_svg]:max-h-[80vh]" />
                    </div>
                ) : (
                    <div className="absolute inset-0 overflow-auto bg-[#24292e]">
                        <pre className="m-0 p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-neutral-200">
                            {source}
                        </pre>
                    </div>
                )}
            </div>
        </ViewerFrame>
    )
}
