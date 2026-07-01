"use client"

import * as React from "react"
import { AlertTriangle, ExternalLink, FileCode2, Globe, Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"
import {
    FormatBadge,
    ViewerFrame,
    ViewerToolbar,
    toolbarBtnCls,
} from "@/components/office/viewer-chrome"

type ViewMode = "preview" | "source"

const SOURCE_CSS = `
.html-source pre{margin:0;padding:14px 16px;font-size:12.5px;line-height:1.6;tab-size:4;white-space:pre-wrap;word-break:break-word;}
`

function srcDocForStaticPreview(source: string): string {
    const base = '<base href="about:srcdoc">\n'
    const lower = source.toLowerCase()
    const headOpen = lower.indexOf("<head>")
    if (headOpen >= 0) {
        const insertAt = headOpen + "<head>".length
        return source.slice(0, insertAt) + base + source.slice(insertAt)
    }
    const htmlOpen = source.match(/<html\b[^>]*>/i)
    if (htmlOpen?.index !== undefined) {
        const insertAt = htmlOpen.index + htmlOpen[0].length
        return source.slice(0, insertAt) + `<head>${base}</head>` + source.slice(insertAt)
    }
    return `<head>${base}</head>${source}`
}

export function HtmlFileViewer({
    url,
    previewUrl,
    filename,
    onClose,
}: {
    url: string
    previewUrl?: string
    filename: string
    onClose: () => void
}) {
    const [mode, setMode] = React.useState<ViewMode>("preview")
    const [source, setSource] = React.useState<string | null>(null)
    const [status, setStatus] = React.useState<"idle" | "loading" | "ready" | "error">("idle")
    const needsSource = mode === "source" || !previewUrl

    React.useEffect(() => {
        if (!needsSource || source !== null) return
        let cancelled = false
        async function load() {
            setStatus("loading")
            try {
                const response = await fetch(url)
                if (!response.ok) throw new Error(`fetch ${response.status}`)
                const text = await response.text()
                if (cancelled) return
                setSource(text)
                setStatus("ready")
            } catch (err) {
                console.error("HTML preview failed:", err)
                if (!cancelled) setStatus("error")
            }
        }
        void load()
        return () => {
            cancelled = true
        }
    }, [needsSource, source, url])

    const canShowSource = source !== null || status !== "error"

    return (
        <ViewerFrame>
            <style>{SOURCE_CSS}</style>
            <ViewerToolbar
                icon={<Globe className="size-4 shrink-0 text-pdf-text-muted" />}
                filename={filename}
                badge={<FormatBadge label="HTML" />}
                downloadUrl={url}
                downloadName={filename}
                onClose={onClose}
            >
                <div className="mr-1 inline-flex overflow-hidden rounded border border-pdf-divider">
                    <button
                        type="button"
                        onClick={() => setMode("preview")}
                        className={cn(
                            "inline-flex h-8 items-center gap-1.5 px-2.5 text-[12px] font-medium transition-colors",
                            mode === "preview"
                                ? "bg-pdf-hover text-white"
                                : "text-pdf-text-muted hover:bg-pdf-hover/70 hover:text-white"
                        )}
                        aria-pressed={mode === "preview"}
                    >
                        <Globe className="size-3.5" />
                        Preview
                    </button>
                    <button
                        type="button"
                        onClick={() => setMode("source")}
                        disabled={!canShowSource}
                        className={cn(
                            "inline-flex h-8 items-center gap-1.5 border-l border-pdf-divider px-2.5 text-[12px] font-medium transition-colors disabled:opacity-40",
                            mode === "source"
                                ? "bg-pdf-hover text-white"
                                : "text-pdf-text-muted hover:bg-pdf-hover/70 hover:text-white"
                        )}
                        aria-pressed={mode === "source"}
                    >
                        <FileCode2 className="size-3.5" />
                        Source
                    </button>
                </div>
                {previewUrl ? (
                    <a
                        href={previewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={toolbarBtnCls}
                        aria-label="Open rendered page"
                        title="Open rendered page"
                    >
                        <ExternalLink className="size-4" />
                    </a>
                ) : null}
                <div className="mx-1 h-6 w-px bg-pdf-divider" />
            </ViewerToolbar>

            <div className="relative min-h-0 flex-1 bg-white">
                {mode === "preview" ? (
                    previewUrl ? (
                        <iframe
                            title={filename}
                            src={previewUrl}
                            className="h-full w-full border-0 bg-white"
                        />
                    ) : status === "ready" && source !== null ? (
                        <iframe
                            title={filename}
                            sandbox="allow-downloads allow-popups"
                            srcDoc={srcDocForStaticPreview(source)}
                            className="h-full w-full border-0 bg-white"
                        />
                    ) : (
                        <LoadingOrError status={status} filename={filename} url={url} />
                    )
                ) : status === "ready" && source !== null ? (
                    <div className="html-source absolute inset-0 overflow-auto bg-[#24292e] text-neutral-200">
                        <pre className="font-mono">{source}</pre>
                    </div>
                ) : (
                    <LoadingOrError status={status} filename={filename} url={url} />
                )}
            </div>
        </ViewerFrame>
    )
}

function LoadingOrError({
    status,
    filename,
    url,
}: {
    status: "idle" | "loading" | "ready" | "error"
    filename: string
    url: string
}) {
    if (status === "error") {
        return (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#24292e] p-8 text-center text-pdf-text-muted">
                <AlertTriangle className="size-7 text-amber-400" />
                <p className="text-sm text-pdf-text">This HTML file couldn&apos;t be previewed.</p>
                <a href={url} download={filename} className="text-sm text-white underline underline-offset-2 hover:text-white/80">
                    Download {filename}
                </a>
            </div>
        )
    }
    return (
        <div className="absolute inset-0 flex items-center justify-center bg-[#24292e] text-sm text-pdf-text">
            <Loader2 className="mr-2 size-5 animate-spin" />
            Loading…
        </div>
    )
}
