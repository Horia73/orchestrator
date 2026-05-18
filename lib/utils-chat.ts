import type { Attachment } from "@/lib/types"

export function generateId(): string {
    return Math.random().toString(36).substring(2, 15)
}

export function generateTitle(userMessage: string, attachments?: Attachment[]): string {
    const trimmed = userMessage.trim()
    if (trimmed) {
        const words = trimmed.split(/\s+/).slice(0, 5).join(" ")
        return truncateTitle(words.length < trimmed.length ? `${words}...` : words)
    }

    if (attachments?.length === 1) {
        return truncateTitle(attachments[0].filename || "Attached file")
    }

    if (attachments?.length) {
        return `${attachments.length} attached files`
    }

    return "New chat"
}

function truncateTitle(title: string): string {
    return title.length > 80 ? `${title.slice(0, 77)}...` : title
}
