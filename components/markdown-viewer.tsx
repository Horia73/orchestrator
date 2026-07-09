"use client"

import * as React from "react"
import { FileText, Loader2, AlertTriangle, Eye, Code2 } from "lucide-react"
import { ViewerFrame, ViewerToolbar, FormatBadge, toolbarBtnCls } from "@/components/office/viewer-chrome"
import { MarkdownArtifactRenderer } from "@/components/artifacts/renderers/markdown-artifact-renderer"
import { cn } from "@/lib/utils"

const MAX_BYTES = 2_000_000 // 2 MB — beyond this we truncate to keep rendering snappy

/**
 * Renders a `.md` / `.markdown` file GitHub-style: the default view is the
 * typeset prose (reusing {@link MarkdownArtifactRenderer}, tables/task-lists/math
 * included), with a toggle to the raw source. Fetch/loading/error/truncation
 * mirror the CodeViewer so both text viewers behave identically.
 */
export function MarkdownViewer({
    url,
    filename,
    onClose,
}: {
    url: string
    filename: string
    onClose: () => void
}) {
    const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading")
    const [raw, setRaw] = React.useState<string>("")
    const [truncated, setTruncated] = React.useState(false)
    const [mode, setMode] = React.useState<"rendered" | "source">("rendered")

    React.useEffect(() => {
        let cancelled = false
        async function load() {
            try {
                const res = await fetch(url)
                if (!res.ok) throw new Error(`fetch ${res.status}`)
                let text = await res.text()
                if (cancelled) return
                let didTruncate = false
                if (text.length > MAX_BYTES) {
                    text = text.slice(0, MAX_BYTES)
                    didTruncate = true
                }
                setRaw(text)
                setTruncated(didTruncate)
                setStatus("ready")
            } catch (err) {
                console.error("Markdown preview failed:", err)
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
                icon={<FileText className="size-4 shrink-0 text-pdf-text-muted" />}
                filename={filename}
                badge={<FormatBadge label="MD" />}
                downloadUrl={url}
                downloadName={filename}
                onClose={onClose}
            >
                <button
                    type="button"
                    onClick={() => setMode((m) => (m === "rendered" ? "source" : "rendered"))}
                    className={cn(toolbarBtnCls, mode === "source" && "bg-pdf-hover text-white")}
                    aria-pressed={mode === "source"}
                    aria-label={mode === "rendered" ? "View source" : "View rendered"}
                    title={mode === "rendered" ? "View source" : "View rendered"}
                >
                    {mode === "rendered" ? <Code2 className="size-4" /> : <Eye className="size-4" />}
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
                ) : (
                    // Readable surface for the rendered doc: the app's own light/dark
                    // page background (not the dark viewer canvas), so `prose` and
                    // `dark:prose-invert` land on the contrast they're designed for.
                    <div className="absolute inset-0 overflow-auto bg-background text-foreground" style={{ overscrollBehavior: "contain" }}>
                        {truncated ? (
                            <div className="sticky top-0 z-10 border-b border-border/60 bg-amber-500/15 px-4 py-1.5 text-[11px] text-amber-600 dark:text-amber-300">
                                Large file — showing the first {(MAX_BYTES / 1_000_000).toFixed(0)} MB. Download for the full file.
                            </div>
                        ) : null}
                        {mode === "rendered" ? (
                            <div className="mx-auto w-full max-w-3xl px-5 py-6 md:px-8 md:py-8">
                                <MarkdownArtifactRenderer source={raw} />
                            </div>
                        ) : (
                            <pre className="m-0 whitespace-pre-wrap break-words px-5 py-6 font-mono text-[12.5px] leading-relaxed text-foreground/90 md:px-8">
                                {raw}
                            </pre>
                        )}
                    </div>
                )}
            </div>
        </ViewerFrame>
    )
}
