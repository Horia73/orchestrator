import { NextResponse } from "next/server"

import {
  deleteLibraryAttachments,
  listAllAttachments,
  type AttachmentLibraryEntry,
} from "@/lib/db"
import {
  deleteExtraWorkspaceFile,
  listExtraWorkspaceFiles,
} from "@/lib/library/workspace-extra-files"

/**
 * GET /api/library/attachments?type=image|video|audio|pdf|document|other|media|audio|files
 *
 * `media` is an alias for image + video (rendered as a single grid in the UI).
 * `files` is an alias for pdf + document + other (everything that isn't a/v).
 *
 * Returns newest-first across conversation attachments and extra workspace
 * files. Standard workspace files (USER.md, MEMORY.md, runbooks, config, etc.)
 * are intentionally excluded so Library only shows user/generated extras.
 */
type LibraryEntryType = AttachmentLibraryEntry["type"]
const MEDIA_TYPES = new Set<LibraryEntryType>(["image", "video"])
const FILE_TYPES = new Set<LibraryEntryType>(["pdf", "document", "other"])

interface LibraryAttachmentResponse {
  id: string
  filename: string
  mimeType: string
  size: number
  type: LibraryEntryType
  source: "attachment" | "workspace"
  url: string
  conversationId?: string
  conversationTitle?: string
  messageId?: string
  messageTimestamp: number
  workspacePath?: string
  workspaceUpdatedAt?: number
}

function uploadUrl(id: string): string {
  return `/api/uploads/${encodeURIComponent(id)}`
}

function normalizeAttachment(
  a: AttachmentLibraryEntry
): LibraryAttachmentResponse {
  return {
    ...a,
    source: "attachment",
    url: uploadUrl(a.id),
  }
}

function isConcreteType(value: string): value is LibraryEntryType {
  return ["image", "video", "pdf", "document", "audio", "other"].includes(value)
}

function filterByType(
  entries: LibraryAttachmentResponse[],
  typeParam: string | null
): LibraryAttachmentResponse[] {
  if (typeParam === "media") {
    return entries.filter((a) => MEDIA_TYPES.has(a.type))
  }
  if (typeParam === "files") {
    return entries.filter((a) => FILE_TYPES.has(a.type))
  }
  if (typeParam === "audio") {
    return entries.filter((a) => a.type === "audio")
  }
  if (typeParam && isConcreteType(typeParam)) {
    return entries.filter((a) => a.type === typeParam)
  }
  return entries
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const typeParam = url.searchParams.get("type")

  const all: LibraryAttachmentResponse[] = [
    ...listAllAttachments().map(normalizeAttachment),
    ...listExtraWorkspaceFiles(),
  ].sort((a, b) => b.messageTimestamp - a.messageTimestamp)
  const filtered = filterByType(all, typeParam)

  return NextResponse.json({
    attachments: filtered,
    total: filtered.length,
  })
}

export async function DELETE(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const items =
    body &&
    typeof body === "object" &&
    Array.isArray((body as { items?: unknown }).items)
      ? (body as { items: unknown[] }).items
      : null
  if (!items)
    return NextResponse.json({ error: "Missing items array" }, { status: 400 })

  const attachmentIds: string[] = []
  const workspacePaths: string[] = []

  for (const item of items) {
    if (!item || typeof item !== "object") continue
    const record = item as {
      source?: unknown
      id?: unknown
      workspacePath?: unknown
      path?: unknown
    }
    if (record.source === "workspace") {
      const workspacePath =
        typeof record.workspacePath === "string"
          ? record.workspacePath
          : typeof record.path === "string"
            ? record.path
            : null
      if (workspacePath) workspacePaths.push(workspacePath)
      continue
    }
    if (typeof record.id === "string") attachmentIds.push(record.id)
  }

  const attachmentResult = deleteLibraryAttachments(attachmentIds)
  let deletedWorkspaceFiles = 0
  const missingWorkspaceFiles: string[] = []
  for (const workspacePath of Array.from(new Set(workspacePaths))) {
    try {
      if (deleteExtraWorkspaceFile(workspacePath)) deletedWorkspaceFiles++
      else missingWorkspaceFiles.push(workspacePath)
    } catch (error) {
      missingWorkspaceFiles.push(workspacePath)
    }
  }

  return NextResponse.json({
    deleted: attachmentResult.deleted + deletedWorkspaceFiles,
    attachments: attachmentResult,
    workspace: {
      requested: new Set(workspacePaths).size,
      deleted: deletedWorkspaceFiles,
      missing: missingWorkspaceFiles,
    },
  })
}
