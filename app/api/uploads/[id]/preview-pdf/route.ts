import fs from "fs"
import { Readable } from "stream"
import { NextRequest } from "next/server"
import { resolveExistingUploadPath } from "@/lib/uploads"
import { convertPptxToPdf, isPptxId, pptxPreviewAvailable } from "@/lib/office/pptx-convert"
import { runWithRequestProfile } from "@/lib/profiles/server"

/**
 * Derived preview for PowerPoint uploads: converts the .pptx/.ppt to PDF inside
 * the container (LibreOffice) and streams it, so the client can render it with
 * the existing pdf.js viewer. The original file is still served raw from the
 * sibling /api/uploads/[id] route for download.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    return runWithRequestProfile(_request, async () => {
        const { id } = await params

        const source = resolveExistingUploadPath(id)
        if (!source) return new Response("Not found", { status: 404 })
        if (!isPptxId(id)) return new Response("Unsupported preview type", { status: 415 })

        if (!(await pptxPreviewAvailable())) {
            return new Response("PowerPoint preview is not available on this server", { status: 503 })
        }

        let pdfPath: string
        try {
            pdfPath = await convertPptxToPdf(id)
        } catch (err) {
            console.error("PPTX→PDF conversion failed:", err)
            return new Response("Conversion failed", { status: 502 })
        }

        let stat: fs.Stats
        try {
            stat = fs.statSync(pdfPath)
            if (!stat.isFile()) return new Response("Conversion failed", { status: 502 })
        } catch {
            return new Response("Conversion failed", { status: 502 })
        }

        const stream = Readable.toWeb(fs.createReadStream(pdfPath)) as ReadableStream<Uint8Array>
        return new Response(stream, {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Length": String(stat.size),
                "Cache-Control": "private, max-age=86400",
                "X-Content-Type-Options": "nosniff",
            },
        })
    })
}
