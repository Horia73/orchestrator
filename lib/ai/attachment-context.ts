import type { Attachment } from "@/lib/types"
import { resolveExistingUploadPath } from "@/lib/uploads"

export function canProviderReadLocalUploads(providerId: string): boolean {
    return providerId === "codex"
}

function formatAttachmentSize(bytes: unknown): string {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0)
        return "unknown size"
    if (bytes < 1024) return `${bytes} B`
    const kb = bytes / 1024
    if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`
    const mb = kb / 1024
    if (mb < 1024) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
    const gb = mb / 1024
    return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
}

export function buildAttachmentContext(
    attachments: Attachment[],
    options: { includeLocalPath: boolean }
): string {
    const lines: string[] = []

    for (const att of attachments) {
        if (!att || typeof att.id !== "string") continue

        const filename =
            typeof att.filename === "string" && att.filename.trim()
                ? att.filename.trim()
                : att.id
        const mimeType =
            typeof att.mimeType === "string" && att.mimeType.trim()
                ? att.mimeType.split(";")[0].trim()
                : "application/octet-stream"
        const filePath = resolveExistingUploadPath(att.id)
        const locationParts = [`upload_id: ${att.id}`]
        if (options.includeLocalPath && filePath) {
            locationParts.push(`local path: ${filePath}`)
        } else if (!filePath) {
            locationParts.push("local upload file is no longer available")
        }

        lines.push(
            `- ${filename} (${mimeType}, ${formatAttachmentSize(att.size)}); ${locationParts.join("; ")}`
        )
    }

    if (!lines.length) return ""

    return [
        `The user attached ${lines.length === 1 ? "this file" : "these files"}:`,
        ...lines,
        `When a tool asks for upload_id, copy the exact upload_id above, including the file extension (for example .jpg/.pdf); do not strip it from a local path. Use local paths only when filesystem inspection is available.`,
        `Uploads are read-only originals stored outside your workspace. To edit, convert, or otherwise process one with filesystem tools (Bash/ffmpeg, Read/Write/Edit), first stage a copy inside the workspace — copy_upload_to_workspace(upload_id) when available — and work on the copy; never modify the original upload file in place.`,
    ].join("\n")
}

export function appendPromptContext(content: string, context: string): string {
    if (!context) return content
    return content.trim() ? `${content}\n\n${context}` : context
}
