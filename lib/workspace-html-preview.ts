import { appPath } from "@/lib/app-path"

export interface WorkspaceHtmlPreview {
  id: string
  title: string
  filePath: string
  src: string
}

const HTML_WORKSPACE_EXT_RE = /\.(?:html?|xhtml)$/i
const WORKSPACE_PATH_MARKER = "/.orchestrator/workspace/"

function stripMarkdownTitle(href: string): string {
  const trimmed = href.trim()
  const titleStart = trimmed.search(/\s+["']/)
  return titleStart > 0 ? trimmed.slice(0, titleStart).trim() : trimmed
}

function withoutSearchOrHash(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? value
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function basename(value: string): string {
  return withoutSearchOrHash(value).split(/[\\/]/).filter(Boolean).pop() || "preview.html"
}

function routeForWorkspacePath(filePath: string): string {
  const insideFiles = filePath.replace(/^files\/+/, "")
  const encoded = insideFiles
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  return appPath(`/files/${encoded}`)
}

function workspacePathFromHref(rawHref: string): string | null {
  const href = stripMarkdownTitle(rawHref)
  if (!href || href.startsWith("#") || href.startsWith("?")) return null
  if (/^(?:mailto|tel|javascript):/i.test(href)) return null

  if (href.startsWith("/api/workspace/files?")) {
    try {
      const pathValue = new URLSearchParams(href.slice(href.indexOf("?") + 1)).get("path")
      return pathValue?.startsWith("files/") ? pathValue : null
    } catch {
      return null
    }
  }

  let candidate = href
  try {
    const url = new URL(href)
    if (url.protocol === "file:") {
      candidate = safeDecode(url.pathname)
    } else if (url.protocol === "http:" || url.protocol === "https:") {
      candidate = safeDecode(url.pathname)
    } else {
      return null
    }
  } catch {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null
  }

  const pathOnly = withoutSearchOrHash(candidate).replace(/\\/g, "/")
  const workspaceIndex = pathOnly.indexOf(WORKSPACE_PATH_MARKER)
  if (workspaceIndex >= 0) {
    const workspacePath = pathOnly.slice(workspaceIndex + WORKSPACE_PATH_MARKER.length)
    return workspacePath.startsWith("files/") ? workspacePath : null
  }
  if (pathOnly.startsWith("/files/")) return `files/${pathOnly.slice("/files/".length)}`
  if (pathOnly.startsWith("files/")) return pathOnly
  return null
}

export function workspaceHtmlPreviewFromHref(
  href: string | undefined,
  label?: string
): WorkspaceHtmlPreview | null {
  if (!href) return null
  const filePath = workspacePathFromHref(href)
  if (!filePath || !HTML_WORKSPACE_EXT_RE.test(withoutSearchOrHash(filePath))) return null
  const cleanPath = safeDecode(withoutSearchOrHash(filePath))
  const title = label?.trim() || basename(cleanPath)
  return {
    id: cleanPath,
    title,
    filePath: cleanPath,
    src: routeForWorkspacePath(cleanPath),
  }
}

function pushPreview(
  previews: WorkspaceHtmlPreview[],
  seen: Set<string>,
  href: string,
  label?: string
): void {
  const preview = workspaceHtmlPreviewFromHref(href, label)
  if (!preview || seen.has(preview.id)) return
  seen.add(preview.id)
  previews.push(preview)
}

export function extractWorkspaceHtmlPreviewsFromMarkdown(content: string): WorkspaceHtmlPreview[] {
  const previews: WorkspaceHtmlPreview[] = []
  const seen = new Set<string>()

  const markdownLinkRe = /\[([^\]]+)\]\(([^)]+)\)/g
  for (const match of content.matchAll(markdownLinkRe)) {
    pushPreview(previews, seen, match[2] ?? "", match[1])
  }

  const directLinkRe = /(?:https?:\/\/[^\s)]+)?\/?files\/[^\s)]*?\.(?:html?|xhtml)(?:[?#][^\s)]*)?/gi
  for (const match of content.matchAll(directLinkRe)) {
    pushPreview(previews, seen, match[0] ?? "")
  }

  return previews
}
