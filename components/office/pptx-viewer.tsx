"use client"

import * as React from "react"
import { Loader2, AlertTriangle, Presentation } from "lucide-react"
import { PdfViewer } from "@/components/pdf-viewer"
import { ViewerFrame, ViewerToolbar, FormatBadge } from "@/components/office/viewer-chrome"

type State = "loading" | "ready" | "unavailable" | "error"

export function PptxViewer({
    previewUrl,
    downloadUrl,
    filename,
    onClose,
}: {
    previewUrl: string
    downloadUrl: string
    filename: string
    onClose: () => void
}) {
    const [state, setState] = React.useState<State>("loading")
    const [blobUrl, setBlobUrl] = React.useState<string | null>(null)

    React.useEffect(() => {
        let cancelled = false
        let objUrl: string | null = null
        async function go() {
            try {
                const res = await fetch(previewUrl)
                if (cancelled) return
                if (res.status === 503) {
                    setState("unavailable")
                    return
                }
                if (!res.ok) {
                    setState("error")
                    return
                }
                const blob = await res.blob()
                if (cancelled) return
                objUrl = URL.createObjectURL(blob)
                setBlobUrl(objUrl)
                setState("ready")
            } catch (err) {
                console.error("PPTX preview failed:", err)
                if (!cancelled) setState("error")
            }
        }
        go()
        return () => {
            cancelled = true
            if (objUrl) URL.revokeObjectURL(objUrl)
        }
    }, [previewUrl])

    if (state === "ready" && blobUrl) {
        return (
            <PdfViewer
                url={blobUrl}
                filename={filename}
                downloadUrl={downloadUrl}
                downloadName={filename}
                onClose={onClose}
            />
        )
    }

    return (
        <ViewerFrame>
            <ViewerToolbar
                icon={<Presentation className="size-4 shrink-0 text-pdf-text-muted" />}
                filename={filename}
                badge={<FormatBadge label="PPTX" />}
                downloadUrl={downloadUrl}
                downloadName={filename}
                onClose={onClose}
            />
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-pdf-text-muted">
                {state === "loading" ? (
                    <>
                        <Loader2 className="size-6 animate-spin text-pdf-text" />
                        <p className="text-sm text-pdf-text">Preparing slides…</p>
                        <p className="text-xs">First open of a deck can take a few seconds.</p>
                    </>
                ) : (
                    <>
                        <AlertTriangle className="size-7 text-amber-400" />
                        <p className="text-sm text-pdf-text">
                            {state === "unavailable"
                                ? "Slide preview isn't available on this server."
                                : "This presentation couldn't be rendered."}
                        </p>
                        <a href={downloadUrl} download={filename} className="text-sm text-white underline underline-offset-2 hover:text-white/80">
                            Download {filename}
                        </a>
                    </>
                )}
            </div>
        </ViewerFrame>
    )
}
