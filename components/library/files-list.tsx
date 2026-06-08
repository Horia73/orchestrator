"use client"

import * as React from "react"
import Link from "next/link"
import {
  Check,
  Square,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileType2,
  File as FileIcon,
  Presentation,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { FilePreviewModal } from "@/components/file-preview-modal"
import { isInAppPreviewable } from "@/lib/preview-kinds"
import type { Attachment } from "@/lib/types"
import type { LibrarySelectionProps } from "./attachments-tab"
import {
  formatBytes,
  formatRelativeTime,
  libraryItemSourceLabel,
  libraryItemUrl,
  type LibraryAttachment,
} from "./use-attachments"

/**
 * Non-media files (PDFs, docs, spreadsheets, code, csv, json, txt, etc.)
 * rendered as a list. Icons are picked by extension/MIME to give a quick
 * visual cue without thumbnails (free of a render pass for unsupported
 * formats).
 *
 * Each row exposes two actions: download (uses the same `/api/uploads/:id`
 * blob with a `download` attr) and open-in-new-tab (lets the browser
 * preview PDFs / text inline).
 */
export function FilesList({
  attachments,
  selection,
  className,
}: {
  attachments: LibraryAttachment[]
  selection?: LibrarySelectionProps
  className?: string
}) {
  const [preview, setPreview] = React.useState<Attachment | null>(null)
  return (
    <>
      <ul
        className={cn("flex flex-col gap-1.5", className)}
        aria-label="Files list"
      >
        {attachments.map((a) => (
          <FileRow
            key={a.id}
            attachment={a}
            selected={selection?.selectedIds.has(a.id) ?? false}
            selectionMode={selection?.selectionMode ?? false}
            onToggleSelection={selection?.onToggleSelection}
            onPreview={setPreview}
          />
        ))}
      </ul>
      <FilePreviewModal attachment={preview} onClose={() => setPreview(null)} />
    </>
  )
}

function FileRow({
  attachment,
  selected,
  selectionMode,
  onToggleSelection,
  onPreview,
}: {
  attachment: LibraryAttachment
  selected: boolean
  selectionMode: boolean
  onToggleSelection?: (id: string) => void
  onPreview?: (a: Attachment) => void
}) {
  const { Icon, tint } = iconForAttachment(attachment)
  const previewable = isInAppPreviewable(attachment)
  const fileUrl = libraryItemUrl(attachment)
  const chatHref =
    attachment.conversationId && attachment.messageId
      ? `/?conversation=${encodeURIComponent(attachment.conversationId)}#message-${encodeURIComponent(attachment.messageId)}`
      : null

  return (
    <li
      className={cn(
        "overflow-hidden rounded-xl border border-border/55 bg-card shadow-sm transition-colors hover:border-border",
        selected && "border-primary ring-2 ring-primary/20"
      )}
    >
      <div className="flex items-center gap-3 px-4 py-2.5">
        {selectionMode ? (
          <button
            type="button"
            onClick={() => onToggleSelection?.(attachment.id)}
            aria-label={
              selected
                ? `Deselect ${attachment.filename}`
                : `Select ${attachment.filename}`
            }
            aria-pressed={selected}
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-md transition-colors",
              selected
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {selected ? (
              <Check className="size-4" />
            ) : (
              <Square className="size-4" />
            )}
          </button>
        ) : null}
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-md bg-muted/55",
            tint
          )}
        >
          <Icon className="size-4" strokeWidth={1.75} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          {previewable && onPreview ? (
            <button
              type="button"
              onClick={() => onPreview({ ...attachment, url: fileUrl })}
              className="block w-full truncate text-left text-sm font-medium text-foreground hover:underline"
              title={`Preview ${attachment.filename}`}
            >
              {attachment.filename}
            </button>
          ) : (
            <div
              className="truncate text-sm font-medium text-foreground"
              title={attachment.filename}
            >
              {attachment.filename}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground tabular-nums">
            <span>{formatBytes(attachment.size)}</span>
            <span>·</span>
            <span>{formatRelativeTime(attachment.messageTimestamp)}</span>
            <span>·</span>
            <span className="truncate normal-case">
              {libraryItemSourceLabel(attachment)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {previewable && onPreview ? (
            <button
              type="button"
              onClick={() => onPreview({ ...attachment, url: fileUrl })}
              title="Preview"
              aria-label="Preview"
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Eye className="size-3.5" />
            </button>
          ) : null}
          <a
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in new tab"
            aria-label="Open in new tab"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="size-3.5" />
          </a>
          <a
            href={fileUrl}
            download={attachment.filename}
            title="Download"
            aria-label="Download"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Download className="size-3.5" />
          </a>
          {chatHref ? (
            <Link
              href={chatHref}
              title="View in chat"
              aria-label="View in chat"
              className="ml-1 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Chat →
            </Link>
          ) : null}
        </div>
      </div>
    </li>
  )
}

interface IconChoice {
  Icon: LucideIcon
  tint: string
}

function iconForAttachment(a: LibraryAttachment): IconChoice {
  const lower = a.filename.toLowerCase()
  const mime = a.mimeType.toLowerCase()
  if (
    a.type === "pdf" ||
    mime === "application/pdf" ||
    lower.endsWith(".pdf")
  ) {
    return { Icon: FileType2, tint: "text-rose-500 dark:text-rose-400" }
  }
  if (lower.endsWith(".json") || mime.includes("json")) {
    return { Icon: FileJson, tint: "text-amber-600 dark:text-amber-400" }
  }
  if (
    a.type === "spreadsheet" ||
    lower.endsWith(".csv") ||
    lower.endsWith(".tsv") ||
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    mime.includes("spreadsheet")
  ) {
    return {
      Icon: FileSpreadsheet,
      tint: "text-emerald-600 dark:text-emerald-400",
    }
  }
  if (
    a.type === "presentation" ||
    lower.endsWith(".ppt") ||
    lower.endsWith(".pptx") ||
    mime.includes("presentationml")
  ) {
    return { Icon: Presentation, tint: "text-orange-600 dark:text-orange-400" }
  }
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".py") ||
    lower.endsWith(".rb") ||
    lower.endsWith(".go") ||
    lower.endsWith(".rs") ||
    lower.endsWith(".sh") ||
    lower.endsWith(".zsh") ||
    lower.endsWith(".html") ||
    lower.endsWith(".css") ||
    lower.endsWith(".xml") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml")
  ) {
    return { Icon: FileCode2, tint: "text-sky-600 dark:text-sky-400" }
  }
  if (
    lower.endsWith(".txt") ||
    lower.endsWith(".md") ||
    mime.startsWith("text/") ||
    lower.endsWith(".log") ||
    lower.endsWith(".rtf")
  ) {
    return { Icon: FileText, tint: "text-foreground/70" }
  }
  if (
    lower.endsWith(".doc") ||
    lower.endsWith(".docx") ||
    mime.includes("msword") ||
    mime.includes("wordprocessingml")
  ) {
    return { Icon: FileText, tint: "text-blue-600 dark:text-blue-400" }
  }
  return { Icon: FileIcon, tint: "text-muted-foreground" }
}
