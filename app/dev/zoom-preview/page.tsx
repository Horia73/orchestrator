"use client"

// TEMPORARY dev harness for verifying anchored zoom in PdfViewer and
// ImageAnnotationEditor. Not shipped — deleted before commit.

import * as React from "react"
import { PdfViewer } from "@/components/pdf-viewer"
import { ImageAnnotationEditor } from "@/components/image-annotation-editor"

function makeTestImage(): string {
    const canvas = document.createElement("canvas")
    canvas.width = 1600
    canvas.height = 1000
    const ctx = canvas.getContext("2d")!
    const grad = ctx.createLinearGradient(0, 0, 1600, 1000)
    grad.addColorStop(0, "#0ea5e9")
    grad.addColorStop(1, "#9333ea")
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, 1600, 1000)
    ctx.strokeStyle = "rgba(255,255,255,0.5)"
    for (let x = 0; x <= 1600; x += 100) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 1000); ctx.stroke() }
    for (let y = 0; y <= 1000; y += 100) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(1600, y); ctx.stroke() }
    ctx.fillStyle = "#fff"
    ctx.font = "48px sans-serif"
    ctx.fillText("TL", 20, 60)
    ctx.fillText("TR", 1480, 60)
    ctx.fillText("BL", 20, 980)
    ctx.fillText("BR", 1480, 980)
    ctx.fillText("CENTER", 700, 515)
    return canvas.toDataURL("image/png")
}

export default function ZoomPreviewPage() {
    const [pdfUrl, setPdfUrl] = React.useState<string | null>(null)
    const [imageUrl, setImageUrl] = React.useState<string | null>(null)

    React.useEffect(() => {
        setImageUrl(makeTestImage())
        let url: string | null = null
        let cancelled = false
        ;(async () => {
            const { PDFDocument, rgb } = await import("pdf-lib")
            const doc = await PDFDocument.create()
            // Shapes only — no text, so pdf.js never needs standard font data.
            for (let i = 0; i < 3; i++) {
                const page = doc.addPage([612, 792])
                page.drawRectangle({ x: 20, y: 20, width: 572, height: 752, borderWidth: 4, borderColor: rgb(0.9, 0.1, 0.1) })
                page.drawRectangle({ x: 30, y: 712, width: 50 + i * 40, height: 50, color: rgb(0.1, 0.3, 0.9) })
                page.drawRectangle({ x: 532, y: 30, width: 50, height: 50, color: rgb(0.1, 0.7, 0.2) })
                page.drawCircle({ x: 306, y: 396, size: 60, color: rgb(0.95, 0.75, 0.1) })
            }
            const bytes = await doc.save()
            if (cancelled) return
            url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }))
            setPdfUrl(url)
        })()
        return () => {
            cancelled = true
            if (url) URL.revokeObjectURL(url)
        }
    }, [])

    return (
        <div className="flex h-screen w-screen flex-col gap-3 overflow-hidden bg-neutral-900 p-3">
            <div data-testid="pdf-pane" className="h-1/2 min-h-0 overflow-hidden rounded-lg">
                {pdfUrl && <PdfViewer url={pdfUrl} filename="test.pdf" onClose={() => {}} />}
            </div>
            <div data-testid="image-pane" className="flex h-1/2 min-h-0 flex-col overflow-hidden rounded-lg bg-black/80">
                {imageUrl && <ImageAnnotationEditor imageUrl={imageUrl} filename="test.png" />}
            </div>
        </div>
    )
}
