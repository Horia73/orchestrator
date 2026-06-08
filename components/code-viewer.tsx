"use client"

import * as React from "react"
import { FileCode2, Loader2, AlertTriangle, WrapText } from "lucide-react"
import { ViewerFrame, ViewerToolbar, FormatBadge, toolbarBtnCls } from "@/components/office/viewer-chrome"
import { extToShikiLang } from "@/lib/preview-kinds"
import { cn } from "@/lib/utils"

const MAX_BYTES = 2_000_000 // 2 MB — beyond this we truncate to keep highlighting snappy

const CODE_CSS = `
.codeview pre{margin:0;padding:14px 16px;border-radius:0;font-size:12.5px;line-height:1.6;tab-size:4;overflow:visible;}
.codeview code{counter-reset:step;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.codeview .line::before{content:counter(step);counter-increment:step;display:inline-block;width:2.25rem;margin-right:1.1rem;text-align:right;color:rgba(235,235,235,0.28);user-select:none;}
.codeview.wrap pre,.codeview.wrap code{white-space:pre-wrap;word-break:break-word;}
`

export function CodeViewer({
    url,
    filename,
    onClose,
}: {
    url: string
    filename: string
    onClose: () => void
}) {
    const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading")
    const [html, setHtml] = React.useState<string | null>(null)
    const [raw, setRaw] = React.useState<string>("")
    const [truncated, setTruncated] = React.useState(false)
    const [wrap, setWrap] = React.useState(false)
    const lang = extToShikiLang(filename)

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
                try {
                    const { codeToHtml } = await import("shiki")
                    const out = await codeToHtml(text, { lang, theme: "github-dark" })
                    if (!cancelled) setHtml(out)
                } catch {
                    // Unknown grammar or highlight failure → keep the plain fallback.
                }
            } catch (err) {
                console.error("Code preview failed:", err)
                if (!cancelled) setStatus("error")
            }
        }
        load()
        return () => {
            cancelled = true
        }
    }, [url, lang])

    return (
        <ViewerFrame>
            <style>{CODE_CSS}</style>
            <ViewerToolbar
                icon={<FileCode2 className="size-4 shrink-0 text-pdf-text-muted" />}
                filename={filename}
                badge={<FormatBadge label={lang === "text" ? "TEXT" : lang.toUpperCase()} />}
                downloadUrl={url}
                downloadName={filename}
                onClose={onClose}
            >
                <button
                    type="button"
                    onClick={() => setWrap((w) => !w)}
                    className={cn(toolbarBtnCls, wrap && "bg-pdf-hover text-white")}
                    aria-pressed={wrap}
                    aria-label="Toggle word wrap"
                    title="Toggle word wrap"
                >
                    <WrapText className="size-4" />
                </button>
                <div className="mx-1 h-6 w-px bg-pdf-divider" />
            </ViewerToolbar>

            <div className="relative min-h-0 flex-1 bg-[#24292e]">
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
                    <div className="absolute inset-0 overflow-auto" style={{ overscrollBehavior: "contain" }}>
                        {truncated ? (
                            <div className="sticky top-0 z-10 border-b border-white/10 bg-amber-500/15 px-4 py-1.5 text-[11px] text-amber-200">
                                Large file — showing the first {(MAX_BYTES / 1_000_000).toFixed(0)} MB. Download for the full file.
                            </div>
                        ) : null}
                        <div className={cn("codeview min-w-full", wrap && "wrap")}>
                            {html ? (
                                <div dangerouslySetInnerHTML={{ __html: html }} />
                            ) : (
                                <pre className="m-0 p-[14px_16px] font-mono text-[12.5px] leading-relaxed text-neutral-200">{raw}</pre>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </ViewerFrame>
    )
}
