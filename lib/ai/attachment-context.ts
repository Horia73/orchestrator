import type { Attachment } from "@/lib/types"
import { resolveExistingUploadPath } from "@/lib/uploads"

export function canProviderReadLocalUploads(providerId: string): boolean {
    return providerId === "codex" || providerId === "claude-code"
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
        const location =
            options.includeLocalPath && filePath
                ? `local path: ${filePath}`
                : filePath
                    ? `upload_id: ${att.id}`
                    : `upload_id: ${att.id}; local upload file is no longer available`

        lines.push(
            `- ${filename} (${mimeType}, ${formatAttachmentSize(att.size)}); ${location}`
        )
    }

    if (!lines.length) return ""

    return [
        `The user attached ${lines.length === 1 ? "this file" : "these files"}:`,
        ...lines,
        `Use upload_id when a tool asks for one of these uploaded attachments. Use local paths only when filesystem inspection is available.`,
    ].join("\n")
}

export function appendPromptContext(content: string, context: string): string {
    if (!context) return content
    return content.trim() ? `${content}\n\n${context}` : context
}
