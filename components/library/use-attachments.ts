"use client"

import * as React from "react"

import { appApiPath, appPath } from "@/lib/app-path"

export interface LibraryAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  type: "image" | "pdf" | "document" | "spreadsheet" | "presentation" | "audio" | "video" | "other"
  source: "attachment" | "workspace"
  url: string
  conversationId?: string
  conversationTitle?: string
  messageId?: string
  messageTimestamp: number
  workspacePath?: string
  workspaceUpdatedAt?: number
}

export type LibraryAttachmentType = "media" | "audio" | "files"

const attachmentCache = new Map<LibraryAttachmentType, LibraryAttachment[]>()
const attachmentRequests = new Map<
  LibraryAttachmentType,
  Promise<LibraryAttachment[]>
>()
const ALL_ATTACHMENT_TYPES: LibraryAttachmentType[] = [
  "media",
  "audio",
  "files",
]

async function fetchAttachments(type: LibraryAttachmentType, force = false) {
  if (!force) {
    const inFlight = attachmentRequests.get(type)
    if (inFlight) return inFlight
  }

  const request = fetch(appApiPath("/api/library/attachments", { type }))
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as { attachments: LibraryAttachment[] }
      attachmentCache.set(type, j.attachments)
      return j.attachments
    })
    .finally(() => {
      attachmentRequests.delete(type)
    })

  attachmentRequests.set(type, request)
  return request
}

/**
 * Fetch attachments of a given type from /api/library/attachments. Returns
 * a stable shape `{ data, loading, error, reload }` so each tab can plug it
 * in identically. Auto-fetches on mount and when `type` changes.
 */
export function useAttachments(type: LibraryAttachmentType) {
  const [data, setData] = React.useState<LibraryAttachment[] | null>(
    () => attachmentCache.get(type) ?? null
  )
  const [loading, setLoading] = React.useState(() => !attachmentCache.has(type))
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(
    async (force = false) => {
      const cached = attachmentCache.get(type)
      if (cached && !force) {
        setData(cached)
        setError(null)
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)
      try {
        setData(await fetchAttachments(type, force))
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [type]
  )

  React.useEffect(() => {
    void load()
  }, [load])

  const reload = React.useCallback(() => load(true), [load])

  return { data, loading, error, reload }
}

export function prefetchAttachments(
  types: LibraryAttachmentType[] = ALL_ATTACHMENT_TYPES
) {
  for (const type of types) {
    if (attachmentCache.has(type) || attachmentRequests.has(type)) continue
    void fetchAttachments(type).catch(() => {
      // Tabs surface the error when opened; prefetch should stay silent.
    })
  }
}

export function removeAttachmentsFromCache(ids: Iterable<string>) {
  const deleted = new Set(ids)
  if (deleted.size === 0) return
  for (const [type, cached] of attachmentCache) {
    attachmentCache.set(
      type,
      cached.filter((item) => !deleted.has(item.id))
    )
  }
}

export function libraryItemUrl(item: LibraryAttachment): string {
  if (item.url) return appPath(item.url)
  if (item.source === "workspace" && item.workspacePath) {
    return appApiPath("/api/workspace/files", { path: item.workspacePath })
  }
  return appPath(`/api/uploads/${encodeURIComponent(item.id)}`)
}

export function libraryItemSourceLabel(item: LibraryAttachment): string {
  if (item.source === "workspace")
    return item.workspacePath
      ? `Workspace · ${item.workspacePath}`
      : "Workspace"
  return item.conversationTitle ? `Chat · ${item.conversationTitle}` : "Chat"
}

/** Format bytes as "1.2 MB" / "340 KB" / "12 B". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

/** "5 min ago" / "2h ago" / "Mar 14" relative time formatter. */
export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(new Date(ts))
  } catch {
    return new Date(ts).toISOString().slice(0, 10)
  }
}
