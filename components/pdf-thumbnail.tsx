"use client"

import * as React from "react"
import { appPath } from "@/lib/app-path"
import { cn } from "@/lib/utils"

interface PdfThumbnailProps {
    /** Local File object (for compose-area previews) */
    file?: File
    /** Remote URL (for saved attachments) */
    url?: string
    /** Called when the first page finishes rendering (or fails) */
    onRendered?: () => void
}

export function PdfThumbnail({ file, url, onRendered }: PdfThumbnailProps) {
    const canvasRef = React.useRef<HTMLCanvasElement>(null)
    const [loaded, setLoaded] = React.useState(false)

    React.useEffect(() => {
        let cancelled = false

        async function render() {
            try {
                const pdfjsLib = await import("pdfjs-dist")
                pdfjsLib.GlobalWorkerOptions.workerSrc = appPath("/pdf.worker.min.mjs")

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                let source: any
                if (file) {
                    source = { data: await file.arrayBuffer() }
                } else if (url) {
                    source = url
                } else {
                    return
                }

                const pdf = await pdfjsLib.getDocument(source).promise
                const page = await pdf.getPage(1)
                if (cancelled) return

                const canvas = canvasRef.current
                if (!canvas) return

                // Scale like object-cover: fill the card, crop overflow
                const cardSize = 384 // 3× for retina (card is 128×128 CSS px)
                const viewport = page.getViewport({ scale: 1 })
                const scale = Math.max(cardSize / viewport.width, cardSize / viewport.height)
                const scaledViewport = page.getViewport({ scale })

                canvas.width = scaledViewport.width
                canvas.height = scaledViewport.height

                const ctx = canvas.getContext("2d")
                if (!ctx) return

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await page.render({ canvasContext: ctx, viewport: scaledViewport } as any).promise
                if (!cancelled) {
                    setLoaded(true)
                    onRendered?.()
                }
            } catch {
                onRendered?.()
            }
        }

        render()
        return () => { cancelled = true }
    }, [file, url]) // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <canvas
            ref={canvasRef}
            className={cn(
                "w-full h-full object-cover transition-opacity duration-200",
                loaded ? "opacity-100" : "opacity-0"
            )}
        />
    )
}
