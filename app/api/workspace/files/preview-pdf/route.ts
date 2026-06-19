import fs from "fs"
import { Readable } from "stream"
import { NextRequest } from "next/server"

import { resolveServableWorkspaceFile } from "@/lib/workspace-files-resolve"
import { convertWorkspacePptxToPdf, isPptxId, pptxPreviewAvailable } from "@/lib/office/pptx-convert"
import { runWithRequestProfile } from "@/lib/profiles/server"

/**
 * Derived preview for PowerPoint files that live in the agent workspace (linked
 * inline by the assistant). Resolves the sandbox path, converts the .pptx/.ppt
 * to PDF inside the container (LibreOffice) and streams it, so the client can
 * render it with the existing pdf.js viewer. The raw file is still served by the
 * sibling /api/workspace/files route for download.
 */
export async function GET(request: NextRequest) {
    return runWithRequestProfile(request, async () => {
        const rawPath = request.nextUrl.searchParams.get("path")
        if (!rawPath) {
            return new Response("Missing path", { status: 400 })
        }

        const filePath = resolveServableWorkspaceFile(rawPath)
        if (!filePath) return new Response("Not found", { status: 404 })
        if (!isPptxId(filePath)) return new Response("Unsupported preview type", { status: 415 })

        if (!(await pptxPreviewAvailable())) {
            return new Response("PowerPoint preview is not available on this server", { status: 503 })
        }

        let pdfPath: string
        try {
            pdfPath = await convertWorkspacePptxToPdf(filePath)
        } catch (err) {
            console.error("Workspace PPTX→PDF conversion failed:", err)
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
