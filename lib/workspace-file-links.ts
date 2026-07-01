import { appPath } from "@/lib/app-path"
import { isHtmlFile } from "@/lib/preview-kinds"
import type { Attachment } from "@/lib/types"

function normalizeWorkspacePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/")
}

function encodePathSegments(value: string): string | null {
  const parts = normalizeWorkspacePath(value).split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) return null
  return parts.map((part) => encodeURIComponent(part)).join("/")
}

/** Direct, profile-gated document URL for files stored under workspace/files/.
 *  Unlike /api/workspace/files, this route serves HTML inline with scripts
 *  blocked, so review pages/newsletters render instead of downloading. */
export function workspaceFilesDirectHref(workspacePath: string | undefined): string | null {
  if (!workspacePath) return null
  const normalized = normalizeWorkspacePath(workspacePath)
  if (!normalized.startsWith("files/")) return null
  const innerPath = normalized.slice("files/".length)
  const encoded = encodePathSegments(innerPath)
  return encoded ? appPath(`/files/${encoded}`) : null
}

export function workspaceHtmlPreviewHref(
  att: Pick<Attachment, "filename" | "mimeType"> & { workspacePath?: string }
): string | null {
  if (!isHtmlFile(att)) return null
  return workspaceFilesDirectHref(att.workspacePath)
}
