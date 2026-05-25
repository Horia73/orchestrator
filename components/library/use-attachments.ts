"use client"

import * as React from "react"

export interface LibraryAttachment {
    id: string
    filename: string
    mimeType: string
    size: number
    type: 'image' | 'pdf' | 'document' | 'audio' | 'video' | 'other'
    conversationId: string
    conversationTitle: string
    messageId: string
    messageTimestamp: number
}

export type LibraryAttachmentType = 'media' | 'audio' | 'files'

/**
 * Fetch attachments of a given type from /api/library/attachments. Returns
 * a stable shape `{ data, loading, error, reload }` so each tab can plug it
 * in identically. Auto-fetches on mount and when `type` changes.
 */
export function useAttachments(type: LibraryAttachmentType) {
    const [data, setData] = React.useState<LibraryAttachment[] | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)

    const load = React.useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const r = await fetch(`/api/library/attachments?type=${encodeURIComponent(type)}`)
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            const j = await r.json() as { attachments: LibraryAttachment[] }
            setData(j.attachments)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setLoading(false)
        }
    }, [type])

    React.useEffect(() => {
        void load()
    }, [load])

    return { data, loading, error, reload: load }
}

/** Format bytes as "1.2 MB" / "340 KB" / "12 B". */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
    const mb = bytes / (1024 * 1024)
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

/** "5 min ago" / "2h ago" / "Mar 14" relative time formatter. */
export function formatRelativeTime(ts: number): string {
    const diff = Date.now() - ts
    if (diff < 60_000) return 'just now'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
    try {
        return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ts))
    } catch {
        return new Date(ts).toISOString().slice(0, 10)
    }
}
