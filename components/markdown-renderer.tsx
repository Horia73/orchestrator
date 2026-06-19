"use client"

import * as React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import type { Options as RemarkMathOptions } from "remark-math"
import rehypeKatex from "rehype-katex"
import { Copy, Check, FileText, FileSpreadsheet, Presentation, Image as ImageIcon, Video } from "lucide-react"
import { cn } from "@/lib/utils"
import { copyTextToClipboard } from "@/lib/clipboard"
import { appApiPath, appPath } from "@/lib/app-path"
import { UPLOAD_MIME_MAP } from "@/lib/upload-mime"
import {
  is3DModelFile,
  isCodeOrTextFile,
  isDocxFile,
  isPresentationFile,
  isSpreadsheetFile,
  isSvgFile,
} from "@/lib/preview-kinds"
import type { Components } from "react-markdown"
import type { Attachment } from "@/lib/types"

// ---------------------------------------------------------------------------
// Inline image preview
//
// Images an agent embeds inline as markdown (e.g. `![](/api/uploads/<id>)`)
// render as plain <img> tags with no way to open them in the file preview
// lightbox. A surface that wants those images clickable (the chat view) wraps
// its content in MarkdownImagePreviewProvider; MarkdownImage then reconstructs
// a minimal Attachment from the upload URL and hands it to the provided
// handler. Surfaces without a provider keep the previous static behavior.
// ---------------------------------------------------------------------------

type MarkdownImageClickHandler = (attachment: Attachment) => void
const MarkdownImageClickContext =
  React.createContext<MarkdownImageClickHandler | null>(null)

export function MarkdownImagePreviewProvider({
  onPreview,
  children,
}: {
  onPreview: MarkdownImageClickHandler
  children: React.ReactNode
}) {
  return (
    <MarkdownImageClickContext.Provider value={onPreview}>
      {children}
    </MarkdownImageClickContext.Provider>
  )
}

const UPLOAD_IMAGE_ID_RE = /\/api\/uploads\/([^/?#]+)/

// ---------------------------------------------------------------------------
// KaTeX CSS (loaded once)
// ---------------------------------------------------------------------------

let katexCssLoaded = false
function ensureKatexCss() {
  if (katexCssLoaded || typeof document === "undefined") return
  katexCssLoaded = true
  const link = document.createElement("link")
  link.rel = "stylesheet"
  link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css"
  link.crossOrigin = "anonymous"
  document.head.appendChild(link)
}

// ---------------------------------------------------------------------------
// Highlighted code block (async shiki → cached HTML)
// ---------------------------------------------------------------------------

const highlightCache = new Map<string, string>()
const remarkMathOptions: RemarkMathOptions = { singleDollarTextMath: false }

function HighlightedCode({
  code,
  language,
}: {
  code: string
  language: string
}) {
  const [html, setHtml] = React.useState<string | null>(() => {
    const key = `${language}:${code}`
    return highlightCache.get(key) ?? null
  })

  React.useEffect(() => {
    const key = `${language}:${code}`
    if (highlightCache.has(key)) {
      setHtml(highlightCache.get(key)!)
      return
    }

    let cancelled = false
    let idleHandle: number | null = null

    // Defer Shiki (dynamic import + tokenization) to browser idle time. The
    // plain <pre> fallback already shows the code instantly, so highlighting is
    // a pure enhancement — running it on idle keeps it off the conversation-open
    // critical path (first paint + scroll restore), where a burst of code blocks
    // would otherwise jank the main thread on mobile. The `timeout` guarantees
    // it still runs promptly when the tab never goes fully idle.
    const highlight = () => {
      import("shiki")
        .then(({ codeToHtml }) =>
          codeToHtml(code, {
            lang: language,
            theme: "github-light",
          })
        )
        .then((result) => {
          if (cancelled) return
          highlightCache.set(key, result)
          setHtml(result)
        })
        .catch(() => {
          if (!cancelled) setHtml("")
        })
    }

    const ric = (
      window as typeof window & {
        requestIdleCallback?: (
          cb: () => void,
          opts?: { timeout: number }
        ) => number
      }
    ).requestIdleCallback
    if (typeof ric === "function") {
      idleHandle = ric(highlight, { timeout: 1200 })
    } else {
      idleHandle = window.setTimeout(highlight, 1)
    }

    return () => {
      cancelled = true
      if (idleHandle == null) return
      const cic = (
        window as typeof window & {
          cancelIdleCallback?: (handle: number) => void
        }
      ).cancelIdleCallback
      if (typeof cic === "function") cic(idleHandle)
      else window.clearTimeout(idleHandle)
    }
  }, [code, language])

  if (html === null || html === "") {
    return (
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed">
        <code>{code}</code>
      </pre>
    )
  }

  return (
    <div
      className="overflow-x-auto px-4 py-3 text-[13px] leading-relaxed [&_code]:!bg-transparent [&_code]:!font-mono [&_code]:!text-[13px] [&_code]:!leading-relaxed [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:!p-0"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// ---------------------------------------------------------------------------
// Code block wrapper with copy button
// ---------------------------------------------------------------------------

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)

  const handleCopy = React.useCallback(async () => {
    if (!(await copyTextToClipboard(code))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }, [code])

  return (
    <div
      className="relative my-3 overflow-hidden rounded-xl border border-border/50 bg-white dark:bg-muted/15"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {language && (
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="font-mono text-xs text-muted-foreground">
            {language}
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={handleCopy}
        className={cn(
          "absolute top-1.5 right-2 z-10 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-all duration-150 hover:bg-muted hover:text-foreground",
          hovered ? "opacity-100" : "opacity-0"
        )}
        aria-label="Copy code"
        title="Copy code"
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
      <HighlightedCode code={code} language={language || "text"} />
    </div>
  )
}

function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const onPreview = React.useContext(MarkdownImageClickContext)
  const [failed, setFailed] = React.useState(false)
  const rawSrc = typeof src === "string" ? src : undefined
  // An agent embedding a generated image inline (e.g. `![chart](files/chart.png)`
  // or a full workspace path) references it by its workspace path — exactly what
  // the output contract tells it to do for files. Resolve that through the same
  // /api/workspace/files endpoint that download links use; otherwise the relative
  // src 404s against the chat route and the image silently shows as unavailable.
  // Uploads (`/api/uploads/<id>`) and absolute URLs fall through unchanged.
  const workspaceSrc = workspaceDownloadHref(rawSrc)
  const imageSrc = workspaceSrc ?? (rawSrc ? appPath(rawSrc) : undefined)
  const isWhatsAppQr =
    typeof imageSrc === "string" &&
    imageSrc.includes("/api/integrations/whatsapp/qr")

  const uploadId = rawSrc?.match(UPLOAD_IMAGE_ID_RE)?.[1]
  const canPreview = !!onPreview && !!uploadId && !isWhatsAppQr

  if (!imageSrc) return null
  if (failed) {
    return (
      <span className="my-2 inline-flex rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-[12px] text-muted-foreground">
        {isWhatsAppQr ? "WhatsApp QR expired" : alt || "Image unavailable"}
      </span>
    )
  }

  const handleClick =
    canPreview && uploadId
      ? () => {
          const id = decodeURIComponent(uploadId)
          const ext = id.includes(".")
            ? id.slice(id.lastIndexOf(".") + 1).toLowerCase()
            : ""
          onPreview?.({
            id,
            filename: alt || id,
            mimeType: ext ? `image/${ext === "jpg" ? "jpeg" : ext}` : "image/*",
            size: 0,
            type: "image",
          })
        }
      : undefined

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imageSrc}
      alt={alt || ""}
      className={cn(
        "my-2 max-w-full rounded-lg",
        canPreview && "cursor-zoom-in transition-opacity hover:opacity-90"
      )}
      onError={() => setFailed(true)}
      onClick={handleClick}
      role={canPreview ? "button" : undefined}
      title={canPreview ? "Open image" : undefined}
    />
  )
}

// Inline code that is exactly a single http(s) URL (e.g. a preview link the
// model wrapped in backticks) should still be clickable, not an inert code span.
const INLINE_URL_RE = /^https?:\/\/[^\s]+$/i

const WORKSPACE_PATH_MARKER = "/.orchestrator/workspace/"
const DOWNLOADABLE_WORKSPACE_EXT_RE =
  /\.(?:docx?|xlsx?|pptx?|pdf|txt|md|csv|json|xml|rtf|png|jpe?g|gif|webp|heic|heif|mp3|wav|m4a|aac|aiff|flac|ogg|mp4|webm|mov|mpeg|mpg|avi|wmv|3gp|glb|stl|3mf|step|stp|gcode)(?:[?#].*)?$/i

// iOS standalone PWAs frequently swallow the *first* tap on a `target="_blank"`
// link — the user has to tap twice for it to open. Driving the open from the
// click gesture via `window.open` makes a single tap reliable there, and
// behaves identically to the default on desktop (we bail on modifier/middle
// clicks so "open in new tab/window" keeps working).
function handleNewTabLinkClick(
  event: React.MouseEvent<HTMLAnchorElement>,
  href: string
) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return
  }
  event.preventDefault()
  window.open(href, "_blank", "noopener,noreferrer")
}

// The raw workspace path a link points at (the value to feed as `?path=`), or
// null when the href is not a workspace file. Shared by the download-link path
// and the inline file-card path so both agree on what counts as a workspace file.
function workspaceCandidatePath(href: string | undefined): string | null {
  const raw = href?.trim()
  if (!raw || raw.startsWith("#") || raw.startsWith("?")) return null
  if (raw.startsWith("/api/workspace/files?")) {
    try {
      return new URLSearchParams(raw.slice(raw.indexOf("?") + 1)).get("path")
    } catch {
      return null
    }
  }
  if (/^(?:mailto|tel|javascript):/i.test(raw)) return null

  let candidate = raw
  let hasProtocol = false
  try {
    const url = new URL(raw)
    hasProtocol = true
    if (url.protocol !== "file:") return null
    candidate = url.pathname
  } catch {
    hasProtocol = /^[a-z][a-z0-9+.-]*:/i.test(raw)
  }

  if (hasProtocol && !raw.startsWith("file://")) return null

  const pathOnly = candidate.split(/[?#]/, 1)[0]?.replace(/\\/g, "/") ?? ""
  const isWorkspacePath = pathOnly.includes(WORKSPACE_PATH_MARKER)
  const isRelativeWorkspaceFile =
    !pathOnly.startsWith("/") &&
    !pathOnly.includes("://") &&
    DOWNLOADABLE_WORKSPACE_EXT_RE.test(candidate)

  if (!isWorkspacePath && !isRelativeWorkspaceFile) return null
  return candidate
}

function workspaceDownloadHref(href: string | undefined): string | undefined {
  const candidate = workspaceCandidatePath(href)
  if (candidate == null) return undefined
  return appApiPath("/api/workspace/files", { path: candidate })
}

interface WorkspaceFileRef {
  /** Raw workspace path to feed as the `?path=` query param. */
  filePath: string
  /** Resolved one-click download URL (/api/workspace/files?path=…). */
  downloadHref: string
  /** Basename for display. */
  filename: string
  /** MIME guessed from the extension (may be "" for unknown types). */
  mimeType: string
}

function workspaceFileRef(href: string | undefined): WorkspaceFileRef | null {
  const candidate = workspaceCandidatePath(href)
  if (candidate == null) return null
  const filename =
    candidate.split(/[?#]/, 1)[0]?.split(/[\\/]/).filter(Boolean).pop() || "file"
  const dot = filename.lastIndexOf(".")
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : ""
  return {
    filePath: candidate,
    downloadHref: appApiPath("/api/workspace/files", { path: candidate }),
    filename,
    mimeType: UPLOAD_MIME_MAP[ext] ?? "",
  }
}

// Which in-app viewer category a workspace file opens in the FilePreviewModal,
// or null when the modal has no real preview for it (archives, audio, etc.) —
// those keep a plain download link instead of a card. Mirrors the predicates the
// modal itself routes on.
function workspacePreviewKind(filename: string, mimeType: string): Attachment["type"] | null {
  const att = { filename, mimeType }
  const dot = filename.lastIndexOf(".")
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : ""
  if (ext === "pdf" || mimeType === "application/pdf") return "pdf"
  if (isPresentationFile(att)) return "presentation"
  if (isSpreadsheetFile(att)) return "spreadsheet"
  if (isSvgFile(att)) return "image"
  if (isDocxFile(att)) return "document"
  if (is3DModelFile(att)) return "other"
  if (mimeType.startsWith("image/")) return "image"
  if (mimeType.startsWith("video/")) return "video"
  if (isCodeOrTextFile(att)) return "document"
  return null
}

const WORKSPACE_FILE_ICON: Record<Attachment["type"], React.ComponentType<{ className?: string }>> = {
  image: ImageIcon,
  video: Video,
  pdf: FileText,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  audio: FileText,
  other: FileText,
}

// A compact, inline-flex card for a workspace file the assistant links inline.
// Clicking opens the in-app FilePreviewModal (PDF/Office/code/3D/image) instead
// of a bare download. Rendered as a <button> (phrasing content) so it is valid
// inside the surrounding <p>. Only shown when a preview handler is in context;
// otherwise the link falls back to a plain one-click download.
function WorkspaceFileCard({
  fileRef,
  kind,
  onPreview,
}: {
  fileRef: WorkspaceFileRef
  kind: Attachment["type"]
  onPreview: MarkdownImageClickHandler
}) {
  const Icon = WORKSPACE_FILE_ICON[kind] ?? FileText
  const dot = fileRef.filename.lastIndexOf(".")
  const ext = dot >= 0 ? fileRef.filename.slice(dot + 1).toUpperCase() : kind.toUpperCase()
  const open = () => {
    onPreview({
      id: fileRef.filePath,
      filename: fileRef.filename,
      mimeType: fileRef.mimeType || "application/octet-stream",
      size: 0,
      type: kind,
      origin: "workspace",
      url: fileRef.downloadHref,
      previewUrl:
        kind === "presentation"
          ? appApiPath("/api/workspace/files/preview-pdf", { path: fileRef.filePath })
          : undefined,
    })
  }
  return (
    <button
      type="button"
      onClick={open}
      title={`Open ${fileRef.filename}`}
      className="my-1 inline-flex max-w-full items-center gap-2 rounded-lg border border-border/70 bg-white px-3 py-2 text-left align-middle text-[13px] text-foreground/90 transition-colors hover:border-border hover:bg-muted/40 dark:bg-muted/20"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{fileRef.filename}</span>
      <span className="shrink-0 rounded border border-border/50 bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {ext}
      </span>
    </button>
  )
}

// Link renderer: a workspace document opens the in-app preview card when a
// preview handler is available; everything else stays a normal link (workspace
// files without an in-app viewer become one-click downloads via workspaceDownloadHref).
function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const onPreview = React.useContext(MarkdownImageClickContext)
  const fileRef = workspaceFileRef(href)
  if (fileRef && onPreview) {
    const kind = workspacePreviewKind(fileRef.filename, fileRef.mimeType)
    if (kind) {
      return <WorkspaceFileCard fileRef={fileRef} kind={kind} onPreview={onPreview} />
    }
  }
  const downloadHref = fileRef?.downloadHref
  const resolvedHref = downloadHref ?? (href ? appPath(href) : undefined)
  return (
    <a
      href={resolvedHref}
      target={downloadHref ? undefined : "_blank"}
      rel={downloadHref ? undefined : "noopener noreferrer"}
      onClick={
        downloadHref || !resolvedHref
          ? undefined
          : (event) => handleNewTabLinkClick(event, resolvedHref)
      }
      className="text-primary underline underline-offset-2 transition-colors hover:text-primary/80"
    >
      {children}
    </a>
  )
}

// ---------------------------------------------------------------------------
// Custom react-markdown components
// ---------------------------------------------------------------------------

const baseComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mt-5 mb-2 text-[22px] font-semibold tracking-tight md:-ml-16 md:pl-16">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-2 text-[18px] font-semibold tracking-tight md:-ml-16 md:pl-16">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-[16px] font-semibold md:-ml-16 md:pl-16">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-3 mb-1 text-[15px] font-semibold md:-ml-16 md:pl-16">{children}</h4>
  ),
  p: ({ children }) => <p className="my-2 leading-relaxed md:-ml-16 md:pl-16">{children}</p>,
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => (
    <del className="text-muted-foreground">{children}</del>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground italic md:-ml-16 md:pl-[calc(4rem+0.75rem)]">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => {
    const match = /language-(\w+)/.exec(className || "")
    const language = match ? match[1] : ""
    const code = String(children).replace(/\n$/, "")

    if (match) {
      return <CodeBlock language={language} code={code} />
    }

    // Inline code that is exactly a URL renders as a clickable link.
    const trimmed = code.trim()
    if (INLINE_URL_RE.test(trimmed)) {
      return (
        <a
          href={trimmed}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => handleNewTabLinkClick(event, trimmed)}
          className="font-mono text-[13px] break-all text-primary underline underline-offset-2 transition-colors hover:text-primary/80"
        >
          {children}
        </a>
      )
    }

    // Inline code
    return (
      <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px]">
        {children}
      </code>
    )
  },
  pre: ({ children }) => {
    const child = React.Children.only(children) as React.ReactElement<{
      className?: string
    }>
    if (child?.props?.className && /language-/.test(child.props.className)) {
      return <>{children}</>
    }
    const code = String(
      (child as React.ReactElement<{ children?: React.ReactNode }>)?.props
        ?.children ?? ""
    ).replace(/\n$/, "")
    return <CodeBlock language="" code={code} />
  },
  hr: () => <hr className="my-4 border-t border-border/60" />,
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border/50">
      <table className="w-full text-[14px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="border-b border-border/40 bg-muted/40">{children}</thead>
  ),
  tbody: ({ children }) => (
    <tbody className="divide-y divide-border/30">{children}</tbody>
  ),
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => (
    <th className="px-3 py-2 text-left text-[13px] font-semibold text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-3 py-2">{children}</td>,
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
}

const contextComponents: Components = {
  ...baseComponents,
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-6 md:-ml-16 md:pl-[calc(4rem+1.5rem)] [&_ol]:my-1 [&_ol]:ml-0 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:my-1 [&_ul]:ml-0 [&_ul]:list-disc [&_ul]:pl-6">
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol
      start={start}
      className="my-2 list-decimal space-y-1 pl-6 md:-ml-16 md:pl-[calc(4rem+1.5rem)] [&_ol]:my-1 [&_ol]:ml-0 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:my-1 [&_ul]:ml-0 [&_ul]:list-disc [&_ul]:pl-6"
    >
      {children}
    </ol>
  ),
  li: ({ children, node }) => {
    const firstChild = node?.children?.[0]
    const isTaskItem =
      firstChild &&
      firstChild.type === "element" &&
      firstChild.tagName === "input" &&
      (firstChild.properties as Record<string, unknown>)?.type === "checkbox"

    if (isTaskItem) {
      const checked = !!(firstChild.properties as Record<string, unknown>)
        ?.checked
      return (
        <li className="flex items-start gap-2">
          <span
            className={cn(
              "mt-[3px] flex size-4 shrink-0 items-center justify-center rounded border text-[11px]",
              checked
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background"
            )}
          >
            {checked && <Check className="size-3" strokeWidth={3} />}
          </span>
          <div className="min-w-0">
            {React.Children.toArray(children).slice(1)}
          </div>
        </li>
      )
    }

    return <li className="leading-relaxed">{children}</li>
  },
}

const compactComponents: Components = {
  ...contextComponents,
  h1: ({ children }) => (
    <h1 className="mt-3 mb-1.5 text-[15px] font-semibold tracking-tight">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-3 mb-1.5 text-[14px] font-semibold tracking-tight">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-2.5 mb-1 text-[13px] font-semibold tracking-tight">
      {children}
    </h3>
  ),
  p: ({ children }) => <p className="my-1.5 leading-relaxed">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-1.5 list-disc space-y-1 pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5">
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol
      start={start}
      className="my-1.5 list-decimal space-y-1 pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
    >
      {children}
    </ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
}

// ---------------------------------------------------------------------------
// Exported renderer
// ---------------------------------------------------------------------------

export const MarkdownRenderer = React.memo(function MarkdownRenderer({
  content,
  compact = false,
}: {
  content: string
  compact?: boolean
}) {
  React.useEffect(() => {
    if (
      content.includes("$") ||
      content.includes("\\(") ||
      content.includes("\\[")
    ) {
      ensureKatexCss()
    }
  }, [content])

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkMath, remarkMathOptions]]}
      rehypePlugins={[rehypeKatex]}
      components={compact ? compactComponents : contextComponents}
    >
      {content}
    </ReactMarkdown>
  )
})
