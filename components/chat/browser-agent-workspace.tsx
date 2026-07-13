"use client"

import * as React from "react"

import { BrowserAgentLiveView } from "@/components/browser-agent-live-view"
import { TodoBar } from "@/components/todo-bar"
import { appPath } from "@/lib/app-path"
import { cn } from "@/lib/utils"
import type {
  AgentCallReasoningEntry,
  Attachment,
  ReasoningEntry,
} from "@/lib/types"

const BROWSER_AGENT_TERMINAL_STYLE: React.CSSProperties = {
  height: "min(560px, max(320px, calc(100dvh - 220px)))",
  minHeight: "300px",
  overscrollBehavior: "contain",
}

const DIAGNOSTICS_POLL_MS = 2_500

type BrowserTranscriptPart =
  | { kind: "text"; id: string; text: string }
  | { kind: "attachment"; id: string; attachment: Attachment; label: string }

const UPLOAD_MARKDOWN_RE =
  /(!?)\[([^\]]*)\]\([^)]*?\/api\/uploads\/([A-Za-z0-9._%-]+)[^)]*\)/g

const SAVED_BROWSER_EVIDENCE_RE = /^Saved browser (screenshot|video)\b/i

export function isBrowserAgentRunAwaitingUser(entry: AgentCallReasoningEntry): boolean {
  return /\bSession status:\s*awaiting_user\b/i.test(entry.content)
}

export function browserSessionIdFromRunContent(content: string): string | null {
  const match = content.match(/\bBrowser session:\s*([A-Za-z0-9_.:-]+)/i)
  return match?.[1] ?? null
}

// ---------------------------------------------------------------------------
// BrowserAgentWorkspace — the desktop side-panel layout for a browser run:
// live view on top (width-driven aspect), Console / Network / Transcript
// tabs filling the space below.
// ---------------------------------------------------------------------------

interface BrowserConsoleEntryPayload {
  timestamp: string
  level: string
  text: string
  url: string
  lineNumber?: number
}

interface BrowserPageErrorEntryPayload {
  timestamp: string
  message: string
  stack?: string
  url: string
}

interface BrowserNetworkEntryPayload {
  timestamp: string
  url: string
  method: string
  resourceType: string
  status?: number
  statusText?: string
  failureText?: string
}

interface BrowserDiagnosticsPayload {
  supported: boolean
  capturedAt: string
  currentUrl: string
  consoleMessages: BrowserConsoleEntryPayload[]
  pageErrors: BrowserPageErrorEntryPayload[]
  failedRequests: BrowserNetworkEntryPayload[]
  httpErrors: BrowserNetworkEntryPayload[]
}

interface BrowserDiagnosticsResponse {
  sessionId: string | null
  status: string | null
  running: boolean
  diagnostics: BrowserDiagnosticsPayload | null
}

function useBrowserDiagnostics(
  sessionId: string | null,
  active: boolean
): BrowserDiagnosticsResponse | null {
  const [data, setData] = React.useState<BrowserDiagnosticsResponse | null>(null)

  React.useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const url = sessionId
          ? `/api/browser-agent/diagnostics?sessionId=${encodeURIComponent(sessionId)}`
          : "/api/browser-agent/diagnostics"
        const res = await fetch(url, { cache: "no-store" })
        if (!res.ok) return
        const payload = (await res.json()) as BrowserDiagnosticsResponse
        if (!cancelled) setData(payload)
      } catch {
        // Polling is best-effort; the next tick retries.
      }
    }
    void tick()
    if (!active) {
      return () => {
        cancelled = true
      }
    }
    const interval = window.setInterval(tick, DIAGNOSTICS_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [sessionId, active])

  return data
}

export function BrowserAgentWorkspace({
  run,
  onAttachmentClick,
}: {
  run: AgentCallReasoningEntry
  onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
}) {
  const awaitingUser = isBrowserAgentRunAwaitingUser(run)
  const sessionId = browserSessionIdFromRunContent(run.content)
  const active = run.status === "running" || awaitingUser

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-4 pt-3 pb-4 [container-type:inline-size]">
      <details className="shrink-0 rounded-md border border-border bg-muted/30">
        <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
          Prompt
        </summary>
        <div className="agent-scroll max-h-40 overflow-auto px-3 pb-3 text-[13px] break-words whitespace-pre-wrap text-muted-foreground">
          {run.prompt}
        </div>
      </details>
      {run.error && (
        <div className="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {run.error}
        </div>
      )}
      {awaitingUser && (
        <div className="shrink-0 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-200">
          Browser is waiting for user input or confirmation.
        </div>
      )}
      <TodoBar
        reasoning={run.reasoning ?? []}
        storageKey={`todo-bar:agent:${run.runId}:expanded`}
        hideCompleted={run.status !== "running"}
      />
      {/* Size the live area from the panel's actual content width, so a 16:9
          stream occupies the frame instead of floating inside a fixed 60/40
          vertical split. The viewport-height cap keeps the diagnostics usable
          on short windows. Before the stream is ready there is no viewport,
          so the wrapper still collapses to the availability/status chip. */}
      <div className="min-h-0 min-w-0 shrink-0 has-[.browser-agent-live-viewport]:h-[min(calc(56.25cqw+4.75rem),calc(100dvh-14.5rem))] has-[.browser-agent-live-viewport]:min-h-[200px]">
        <BrowserAgentLiveView
          variant="panel"
          active={active}
          sessionId={sessionId}
        />
      </div>
      <BrowserAgentDiagnosticsTabs
        run={run}
        sessionId={sessionId}
        active={active}
        onAttachmentClick={onAttachmentClick}
      />
    </div>
  )
}

type BrowserPanelTab = "console" | "network" | "transcript"

function BrowserAgentDiagnosticsTabs({
  run,
  sessionId,
  active,
  onAttachmentClick,
}: {
  run: AgentCallReasoningEntry
  sessionId: string | null
  active: boolean
  onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
}) {
  const [tab, setTab] = React.useState<BrowserPanelTab>("transcript")
  const data = useBrowserDiagnostics(sessionId, active)
  const diagnostics = data?.diagnostics ?? null

  const consoleCount =
    (diagnostics?.consoleMessages.length ?? 0) + (diagnostics?.pageErrors.length ?? 0)
  const networkCount =
    (diagnostics?.failedRequests.length ?? 0) + (diagnostics?.httpErrors.length ?? 0)

  return (
    <div className="flex min-h-[140px] min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-[#24242a] bg-[#0c0c0e] shadow-sm">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 px-2 py-1.5">
        <BrowserPanelTabButton
          label="Transcript"
          active={tab === "transcript"}
          onClick={() => setTab("transcript")}
        />
        <BrowserPanelTabButton
          label="Console"
          count={consoleCount}
          active={tab === "console"}
          onClick={() => setTab("console")}
        />
        <BrowserPanelTabButton
          label="Network"
          count={networkCount}
          active={tab === "network"}
          onClick={() => setTab("network")}
        />
      </div>
      {tab === "transcript" ? (
        <BrowserAgentOutputTerminal
          run={run}
          onAttachmentClick={onAttachmentClick}
          fill
          frameless
        />
      ) : tab === "console" ? (
        <BrowserConsoleFeed diagnostics={diagnostics} />
      ) : (
        <BrowserNetworkFeed diagnostics={diagnostics} />
      )}
    </div>
  )
}

function BrowserPanelTabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count?: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-[12px] font-medium transition-colors",
        active
          ? "bg-white/10 text-zinc-100"
          : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
      )}
    >
      {label}
      {typeof count === "number" && count > 0 && (
        <span className="rounded-full bg-white/10 px-1.5 text-[10px] leading-4 text-zinc-300">
          {count}
        </span>
      )}
    </button>
  )
}

/**
 * Scroll container that sticks to the bottom while new entries stream in,
 * releasing the pin when the user scrolls up (same behavior as the terminal).
 */
function useStickToBottom(dependency: unknown) {
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const stickRef = React.useRef(true)

  React.useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !stickRef.current) return
    const frame = requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [dependency])

  const handleScroll = React.useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const distanceFromBottom =
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
    stickRef.current = distanceFromBottom < 12
  }, [])

  return { scrollerRef, handleScroll }
}

function formatDiagnosticTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString("en-GB", { hour12: false })
}

function consoleLevelClass(level: string): string {
  const normalized = level.toLowerCase()
  if (normalized === "error" || normalized === "pageerror") return "text-red-400"
  if (normalized === "warning" || normalized === "warn") return "text-amber-300"
  if (normalized === "debug") return "text-zinc-500"
  return "text-sky-300"
}

function BrowserConsoleFeed({
  diagnostics,
}: {
  diagnostics: BrowserDiagnosticsPayload | null
}) {
  const entries = React.useMemo(() => {
    if (!diagnostics) return []
    const merged = [
      ...diagnostics.consoleMessages.map((entry) => ({
        timestamp: entry.timestamp,
        level: entry.level,
        text: entry.text,
        detail: entry.url,
      })),
      ...diagnostics.pageErrors.map((entry) => ({
        timestamp: entry.timestamp,
        level: "pageerror",
        text: entry.message,
        detail: entry.stack?.split("\n")[1]?.trim() || entry.url,
      })),
    ]
    return merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }, [diagnostics])

  const { scrollerRef, handleScroll } = useStickToBottom(entries.length)

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      className="agent-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2 font-mono text-[11.5px] leading-[1.5] [overflow-wrap:anywhere] [touch-action:pan-y] [-webkit-overflow-scrolling:touch]"
    >
      {entries.length === 0 ? (
        <div className="py-1 text-zinc-500">
          {diagnostics
            ? "No console output captured yet."
            : "Waiting for the browser session..."}
        </div>
      ) : (
        entries.map((entry, index) => (
          <div key={`${entry.timestamp}-${index}`} className="flex gap-2 py-px">
            <span className="shrink-0 text-zinc-600">
              {formatDiagnosticTime(entry.timestamp)}
            </span>
            <span className={cn("shrink-0 uppercase", consoleLevelClass(entry.level))}>
              {entry.level === "pageerror" ? "error" : entry.level}
            </span>
            <span className="min-w-0 whitespace-pre-wrap text-zinc-200">
              {entry.text}
              {entry.detail && (
                <span className="text-zinc-500"> — {entry.detail}</span>
              )}
            </span>
          </div>
        ))
      )}
    </div>
  )
}

function BrowserNetworkFeed({
  diagnostics,
}: {
  diagnostics: BrowserDiagnosticsPayload | null
}) {
  const entries = React.useMemo(() => {
    if (!diagnostics) return []
    const merged = [
      ...diagnostics.httpErrors.map((entry) => ({ ...entry, kind: "http" as const })),
      ...diagnostics.failedRequests.map((entry) => ({ ...entry, kind: "failed" as const })),
    ]
    return merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }, [diagnostics])

  const { scrollerRef, handleScroll } = useStickToBottom(entries.length)

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      className="agent-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2 font-mono text-[11.5px] leading-[1.5] [overflow-wrap:anywhere] [touch-action:pan-y] [-webkit-overflow-scrolling:touch]"
    >
      {entries.length === 0 ? (
        <div className="py-1 text-zinc-500">
          {diagnostics
            ? "No failed requests or HTTP errors captured."
            : "Waiting for the browser session..."}
        </div>
      ) : (
        entries.map((entry, index) => (
          <div key={`${entry.timestamp}-${index}`} className="flex gap-2 py-px">
            <span className="shrink-0 text-zinc-600">
              {formatDiagnosticTime(entry.timestamp)}
            </span>
            <span className="shrink-0 text-red-400">
              {entry.kind === "http" ? entry.status ?? "?" : "FAIL"}
            </span>
            <span className="shrink-0 text-zinc-400">{entry.method}</span>
            <span className="min-w-0 whitespace-pre-wrap text-zinc-200">
              {entry.url}
              <span className="text-zinc-500">
                {" "}
                ({entry.resourceType}
                {entry.kind === "http" && entry.statusText ? `, ${entry.statusText}` : ""}
                {entry.kind === "failed" && entry.failureText ? `, ${entry.failureText}` : ""})
              </span>
            </span>
          </div>
        ))
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// BrowserAgentOutputTerminal — the status transcript with inline evidence.
// Used standalone (nested browser runs, mobile panel) and as the Transcript
// tab of the diagnostics box above.
// ---------------------------------------------------------------------------

export function BrowserAgentOutputTerminal({
  run,
  onAttachmentClick,
  fill,
  frameless,
}: {
  run: AgentCallReasoningEntry
  onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
  /** Fill the parent instead of the fixed viewport-derived height. */
  fill?: boolean
  /** Skip the border/background chrome (the parent already draws it). */
  frameless?: boolean
}) {
  const text = browserAgentTerminalText(run)
  const attachments = run.attachments ?? []
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const stickToBottomRef = React.useRef(true)

  React.useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !stickToBottomRef.current) return
    const frame = requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [text, attachments.length])

  const handleScroll = React.useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const distanceFromBottom =
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
    stickToBottomRef.current = distanceFromBottom < 12
  }, [])

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden",
        fill && "min-h-0 flex-1",
        !frameless && "rounded-md border border-[#24242a] bg-[#0c0c0e] text-left shadow-sm"
      )}
      style={fill ? { overscrollBehavior: "contain" } : BROWSER_AGENT_TERMINAL_STYLE}
    >
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className="agent-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 font-mono text-[12px] leading-[1.45] text-zinc-100 [overflow-wrap:anywhere] [touch-action:pan-y] [-webkit-overflow-scrolling:touch]"
      >
        <BrowserAgentTranscript
          text={text}
          attachments={attachments}
          onAttachmentClick={onAttachmentClick}
        />
        {run.status === "running" && (
          <span className="inline-block h-[1em] w-[7px] translate-y-[2px] animate-pulse bg-zinc-100" />
        )}
      </div>
    </div>
  )
}

function BrowserAgentTranscript({
  text,
  attachments,
  onAttachmentClick,
}: {
  text: string
  attachments: Attachment[]
  onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
}) {
  const parts = React.useMemo(
    () => browserAgentTranscriptParts(text, attachments),
    [text, attachments]
  )

  return (
    <div className="min-w-0">
      {parts.map((part) =>
        part.kind === "text" ? (
          <pre key={part.id} className="m-0 whitespace-pre-wrap break-words">
            {part.text}
          </pre>
        ) : (
          <BrowserAgentInlineAttachment
            key={part.id}
            attachment={part.attachment}
            label={part.label}
            gallery={attachments}
            onAttachmentClick={onAttachmentClick}
          />
        )
      )}
    </div>
  )
}

function BrowserAgentInlineAttachment({
  attachment,
  label,
  gallery,
  onAttachmentClick,
}: {
  attachment: Attachment
  label: string
  gallery: Attachment[]
  onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
}) {
  const url =
    attachment.url ??
    appPath(`/api/uploads/${encodeURIComponent(attachment.id)}`)
  const displayLabel = label || attachment.filename
  const attachmentGallery = gallery.some((item) => item.id === attachment.id)
    ? gallery
    : [...gallery, attachment]

  if (attachment.type === "image") {
    return (
      <button
        type="button"
        onClick={() => onAttachmentClick?.(attachment, attachmentGallery)}
        className="my-2 block w-full max-w-[360px] overflow-hidden rounded-md border border-white/15 bg-black/45 text-left transition-colors hover:border-white/35"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={displayLabel}
          className="block max-h-[240px] w-full bg-black object-contain"
        />
        <span className="block truncate border-t border-white/10 px-2 py-1.5 text-[11px] text-zinc-300">
          {displayLabel}
        </span>
      </button>
    )
  }

  if (attachment.type === "video") {
    return (
      <div className="my-2 w-full max-w-[420px] overflow-hidden rounded-md border border-white/15 bg-black/45">
        <video
          src={url}
          controls
          preload="metadata"
          className="block aspect-video w-full bg-black object-contain"
        />
        <button
          type="button"
          onClick={() => onAttachmentClick?.(attachment, attachmentGallery)}
          className="block w-full truncate border-t border-white/10 px-2 py-1.5 text-left text-[11px] text-zinc-300 hover:bg-white/5"
        >
          {displayLabel}
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => onAttachmentClick?.(attachment, attachmentGallery)}
      className="my-2 block max-w-full rounded-md border border-white/15 bg-white/5 px-2 py-1.5 text-left text-[11px] text-zinc-300 hover:bg-white/10"
    >
      {displayLabel}
    </button>
  )
}

function browserAgentTranscriptParts(
  text: string,
  attachments: Attachment[]
): BrowserTranscriptPart[] {
  const attachmentsById = new Map(attachments.map((att) => [att.id, att]))
  const seenAttachmentIds = new Set<string>()
  const parts: BrowserTranscriptPart[] = []
  let textBuffer = ""

  const pushText = () => {
    if (!textBuffer) return
    parts.push({ kind: "text", id: `text-${parts.length}`, text: textBuffer })
    textBuffer = ""
  }

  for (const line of text.split("\n")) {
    const media = uploadReferencesInLine(line)
    if (media.length === 0) {
      textBuffer += `${line}\n`
      const savedEvidence = savedBrowserEvidenceLine(line)
      if (savedEvidence) {
        const attachment = nextUnseenEvidenceAttachment(
          attachments,
          seenAttachmentIds,
          savedEvidence.kind,
          savedEvidence.filename
        )
        if (attachment) {
          seenAttachmentIds.add(attachment.id)
          pushText()
          parts.push({
            kind: "attachment",
            id: `attachment-${attachment.id}`,
            attachment,
            label: attachment.filename,
          })
        }
      }
      continue
    }

    const renderableMedia = media.flatMap((item) => {
      const attachment = attachmentsById.get(item.id)
      const inlineAttachment =
        attachment ?? attachmentFromUploadReference(item)
      if (!inlineAttachment || seenAttachmentIds.has(inlineAttachment.id)) {
        return []
      }
      return [{ reference: item, attachment: inlineAttachment }]
    })
    UPLOAD_MARKDOWN_RE.lastIndex = 0
    const cleaned = line.replace(UPLOAD_MARKDOWN_RE, "").trim()
    if (cleaned && (renderableMedia.length > 0 || !isEvidenceOnlyLine(cleaned))) {
      textBuffer += `${cleaned}\n`
    }
    pushText()

    for (const item of renderableMedia) {
      const attachment = item.attachment
      seenAttachmentIds.add(attachment.id)
      parts.push({
        kind: "attachment",
        id: `attachment-${attachment.id}`,
        attachment,
        label: item.reference.label || attachment.filename,
      })
    }
  }

  const missingEvidence = attachments.filter(
    (att) => !seenAttachmentIds.has(att.id)
  )
  if (missingEvidence.length > 0) {
    if (textBuffer && !textBuffer.endsWith("\n\n")) textBuffer += "\n"
    textBuffer += "Captured evidence:\n"
    pushText()
    for (const attachment of missingEvidence) {
      seenAttachmentIds.add(attachment.id)
      parts.push({
        kind: "attachment",
        id: `attachment-${attachment.id}`,
        attachment,
        label: attachment.filename,
      })
    }
  } else {
    pushText()
  }

  return parts.length > 0
    ? parts
    : [{ kind: "text", id: "text-empty", text: "No output yet.\n" }]
}

function uploadReferencesInLine(
  line: string
): Array<{ id: string; label: string; kind: Attachment["type"] }> {
  const out: Array<{ id: string; label: string; kind: Attachment["type"] }> = []
  UPLOAD_MARKDOWN_RE.lastIndex = 0
  for (const match of line.matchAll(UPLOAD_MARKDOWN_RE)) {
    const id = safeDecodeURIComponent(match[3] ?? "")
    out.push({
      label: match[2]?.replace(/\\([\\\]])/g, "$1").trim() ?? "",
      id,
      kind: match[1] === "!" ? "image" : attachmentTypeFromFilename(id),
    })
  }
  return out
}

function isEvidenceOnlyLine(value: string): boolean {
  return /^Browser (screenshot|video)(?:\s*\([^)]*\))?:?$/i.test(value)
}

function savedBrowserEvidenceLine(
  line: string
): { kind: "image" | "video"; filename?: string } | null {
  const trimmed = line.trim()
  const match = trimmed.match(SAVED_BROWSER_EVIDENCE_RE)
  if (!match) return null
  return {
    kind: match[1]?.toLowerCase() === "video" ? "video" : "image",
    filename: trimmed.match(/\(([^()]+)\)\.\s*$/)?.[1],
  }
}

function nextUnseenEvidenceAttachment(
  attachments: Attachment[],
  seenAttachmentIds: Set<string>,
  kind: "image" | "video",
  filename?: string
): Attachment | null {
  const candidates = attachments.filter(
    (attachment) =>
      !seenAttachmentIds.has(attachment.id) &&
      (kind === "image"
        ? attachment.type === "image"
        : attachment.type === "video")
  )
  if (candidates.length === 0) return null
  if (!filename) return candidates[0] ?? null
  return (
    candidates.find((attachment) => attachment.filename === filename) ??
    candidates[0] ??
    null
  )
}

function attachmentFromUploadReference(reference: {
  id: string
  label: string
  kind: Attachment["type"]
}): Attachment | null {
  if (!reference.id) return null
  const mimeType = mimeTypeFromFilename(reference.id, reference.kind)
  return {
    id: reference.id,
    filename: reference.label || reference.id,
    mimeType,
    size: 0,
    type: reference.kind,
    url: appPath(`/api/uploads/${encodeURIComponent(reference.id)}`),
  }
}

function attachmentTypeFromFilename(filename: string): Attachment["type"] {
  const ext = filename.toLowerCase().split(".").pop()
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext ?? "")) {
    return "image"
  }
  if (["webm", "mp4", "mov"].includes(ext ?? "")) return "video"
  return "other"
}

function mimeTypeFromFilename(
  filename: string,
  fallbackType: Attachment["type"]
): string {
  const ext = filename.toLowerCase().split(".").pop()
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
  if (ext === "png") return "image/png"
  if (ext === "webp") return "image/webp"
  if (ext === "gif") return "image/gif"
  if (ext === "webm") return "video/webm"
  if (ext === "mp4") return "video/mp4"
  if (fallbackType === "image") return "image/jpeg"
  if (fallbackType === "video") return "video/webm"
  return "application/octet-stream"
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function browserAgentTerminalText(run: AgentCallReasoningEntry): string {
  const segmentedContent =
    run.contentSegments?.map((segment) => segment.content).join("") ?? ""
  const content = run.content || segmentedContent
  const liveText = browserAgentReasoningTerminalText(run.reasoning)
  if (run.status === "running" && liveText)
    return normalizeTerminalText(liveText)
  if (liveText && content) {
    return normalizeTerminalText(
      joinTerminalSections([
        liveText,
        stripBrowserAgentTerminalTranscript(content),
      ])
    )
  }
  if (content) {
    const finalTranscript = extractBrowserAgentTerminalTranscript(content)
    if (finalTranscript) return normalizeTerminalText(finalTranscript)
    return normalizeTerminalText(
      stripBrowserAgentTerminalTranscript(content) || content
    )
  }
  if (liveText) return normalizeTerminalText(liveText)
  if (run.error) return `Error: ${run.error}\n`
  if (run.status === "running") return "Browser agent is running...\n"
  return "No output yet.\n"
}

function browserAgentReasoningTerminalText(
  reasoning?: ReasoningEntry[]
): string {
  if (!reasoning?.length) return ""
  return reasoning.map(reasoningEntryTerminalText).filter(Boolean).join("")
}

function reasoningEntryTerminalText(entry: ReasoningEntry): string {
  if (entry.type === "thought") return entry.content
  if (entry.type === "tool_call") {
    const streamed = entry.deltas?.map((delta) => delta.text).join("") ?? ""
    if (streamed) return streamed
    if (entry.content) return `${entry.title}\n${entry.content}\n`
    if (entry.status === "running") return `${entry.title}...\n`
    return ""
  }
  if (entry.type === "agent_call") {
    return browserAgentReasoningTerminalText(entry.reasoning)
  }
  return ""
}

function stripBrowserAgentTerminalTranscript(content: string): string {
  return content
    .replace(/(?:^|\n)Terminal output:\n```text\n[\s\S]*?\n```\n?/g, "\n")
    .trimEnd()
}

function extractBrowserAgentTerminalTranscript(content: string): string {
  const match = content.match(/(?:^|\n)Terminal output:\n```text\n([\s\S]*?)\n```\n?/)
  return match?.[1]?.trimEnd() ?? ""
}

function joinTerminalSections(sections: string[]): string {
  return sections
    .map((section) => section.trimEnd())
    .filter(Boolean)
    .join("\n\n")
}

function normalizeTerminalText(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`
}
