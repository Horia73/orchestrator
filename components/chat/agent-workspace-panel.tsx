"use client"

import * as React from "react"
import { Check, Copy, X } from "lucide-react"

import { AttachmentCard } from "@/components/attachment-card"
import type { ArtifactPayload } from "@/components/artifact-panel"
import { StreamingBubble } from "@/components/message-bubble"
import { TodoBar } from "@/components/todo-bar"
import { useTrapWheel } from "@/components/use-trap-wheel"
import { useRevealOnScroll } from "@/hooks/use-reveal-on-scroll"
import { agentRoleAndName } from "@/lib/agent-label"
import { appPath } from "@/lib/app-path"
import { copyTextToClipboard } from "@/lib/clipboard"
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

type BrowserTranscriptPart =
  | { kind: "text"; id: string; text: string }
  | { kind: "attachment"; id: string; attachment: Attachment; label: string }

const UPLOAD_MARKDOWN_RE =
  /(!?)\[([^\]]*)\]\([^)]*?\/api\/uploads\/([A-Za-z0-9._%-]+)[^)]*\)/g

const SAVED_BROWSER_EVIDENCE_RE = /^Saved browser (screenshot|video)\b/i

type SelectedAgentTool = {
  runId: string
  artifact: ArtifactPayload
}

export function AgentWorkspacePanel({
  run,
  childRuns,
  onClose,
  onAttachmentClick,
}: {
  run: AgentCallReasoningEntry
  childRuns?: AgentCallReasoningEntry[]
  onClose: () => void
  onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
}) {
  const [selectedTool, setSelectedTool] =
    React.useState<SelectedAgentTool | null>(null)
  const [selectedChildRunId, setSelectedChildRunId] = React.useState<
    string | null
  >(null)
  const [copiedOutput, setCopiedOutput] = React.useState(false)
  const copyResetTimerRef = React.useRef<number | null>(null)
  // Sub-agents the user hid from this panel via the chip "×". View-only — the
  // run keeps going and is still reachable from the message trace; this just
  // declutters the Sub-agents bar. Reset when the primary agent changes.
  const [dismissedRunIds, setDismissedRunIds] = React.useState<Set<string>>(
    () => new Set()
  )
  const scrollbarVisible = useRevealOnScroll()
  const wheelTrapRef = useTrapWheel<HTMLDivElement>()

  React.useEffect(() => {
    setDismissedRunIds(new Set())
    setSelectedChildRunId(null)
  }, [run.runId])

  const children = (childRuns ?? []).filter(
    (child) => !dismissedRunIds.has(child.runId)
  )
  const dismissChild = React.useCallback((runId: string) => {
    setDismissedRunIds((prev) => {
      const next = new Set(prev)
      next.add(runId)
      return next
    })
    setSelectedChildRunId((current) => (current === runId ? null : current))
  }, [])
  const selectChild = React.useCallback((entry: AgentCallReasoningEntry) => {
    setSelectedChildRunId(entry.runId)
  }, [])
  const selectedChildRun =
    children.find((child) => child.runId === selectedChildRunId) ?? null
  // The lower pane previews one nested agent. By default it follows the running
  // child, then the newest child; once the user clicks a chip, that chip stays
  // loaded in this pane instead of replacing the panel's primary agent.
  const autoChildRun =
    children.find((c) => c.status === "running") ??
    children[children.length - 1]
  const childRun = selectedChildRun ?? autoChildRun
  const showChildSelector = children.length > 0

  React.useEffect(() => {
    if (
      selectedChildRunId &&
      !children.some((child) => child.runId === selectedChildRunId)
    ) {
      setSelectedChildRunId(null)
    }
  }, [children, selectedChildRunId])

  React.useEffect(() => {
    setSelectedTool(null)
  }, [run.runId, childRun?.runId])

  React.useEffect(() => {
    if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current)
    setCopiedOutput(false)
  }, [run.runId])

  React.useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current)
    }
  }, [])

  const outputChars = run.content.length
  const outputDetail =
    outputChars > 0
      ? `${formatCompactCount(outputChars)} output${run.agentThreadId ? " saved" : ""}`
      : null
  const handleCopyOutput = React.useCallback(async () => {
    if (!run.content.trim()) return
    if (!await copyTextToClipboard(run.content)) return
    if (copyResetTimerRef.current) window.clearTimeout(copyResetTimerRef.current)
    setCopiedOutput(true)
    copyResetTimerRef.current = window.setTimeout(() => setCopiedOutput(false), 1600)
  }, [run.content])

  const splitTool = selectedTool && !childRun ? selectedTool.artifact : null
  const parentInlineTool =
    !splitTool && selectedTool?.runId === run.runId
      ? selectedTool.artifact
      : null
  const childInlineTool =
    !splitTool && childRun && selectedTool?.runId === childRun.runId
      ? selectedTool.artifact
      : null

  return (
    <div
      ref={wheelTrapRef}
      className="flex h-full min-h-0 flex-col border-l border-border bg-background"
      data-agent-scroll-visible={scrollbarVisible.active ? "true" : "false"}
      onScrollCapture={scrollbarVisible.reveal}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border pr-[calc(1rem+env(safe-area-inset-right))] pl-[calc(1rem+env(safe-area-inset-left))] pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 md:px-4 md:pt-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium">
            {agentRoleAndName(run)}
          </div>
          <div
            className="truncate text-[12px] text-muted-foreground"
            title={run.agentThreadId ? `Agent thread ${run.agentThreadId}` : undefined}
          >
            {[
              run.status === "aborted" ? "stopped" : run.status,
              outputDetail,
              run.agentThreadId ? `thread ${shortThreadId(run.agentThreadId)}` : null,
            ].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {run.content.trim() && (
            <button
              type="button"
              onClick={handleCopyOutput}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Copy full agent output"
              title="Copy full agent output"
            >
              {copiedOutput ? <Check className="size-4" /> : <Copy className="size-4" />}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close agent panel"
            title="Close"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
      <div
        className={cn(
          "grid min-h-0 flex-1",
          splitTool
            ? "grid-rows-[minmax(0,1fr)_1px_minmax(220px,0.72fr)]"
            : childRun
              ? "grid-rows-[minmax(0,1fr)_1px_minmax(0,1fr)]"
              : "grid-rows-1"
        )}
      >
        <AgentRunPane
          run={run}
          selectedArtifact={parentInlineTool}
          onArtifactClick={(artifact) =>
            setSelectedTool({ runId: run.runId, artifact })
          }
          onSelectedArtifactClose={() => setSelectedTool(null)}
          onAttachmentClick={onAttachmentClick}
        />
        {(childRun || splitTool) && (
          <div className="h-px bg-border" aria-hidden="true" />
        )}
        {splitTool ? (
          <AgentToolResultPreview
            artifact={splitTool}
            variant="pane"
            onClose={() => setSelectedTool(null)}
          />
        ) : childRun ? (
          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
            {showChildSelector && (
              <ChildAgentSelector
                runs={children}
                activeRunId={childRun.runId}
                onSelect={selectChild}
                onDismiss={dismissChild}
              />
            )}
            <AgentRunPane
              key={childRun.runId}
              run={childRun}
              compact
              hideNestedLabel={showChildSelector}
              selectedArtifact={childInlineTool ?? null}
              onArtifactClick={(artifact) =>
                setSelectedTool({ runId: childRun.runId, artifact })
              }
              onSelectedArtifactClose={() => setSelectedTool(null)}
              onAttachmentClick={onAttachmentClick}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function AgentToolResultPreview({
  artifact,
  variant,
  onClose,
}: {
  artifact: ArtifactPayload
  variant: "pane" | "inline"
  onClose?: () => void
}) {
  const isToolResult = artifact.kind === "tool-result"
  const body = isToolResult ? artifact.resultJson : artifact.code
  const args = isToolResult
    ? JSON.stringify(artifact.args ?? {}, null, 2)
    : null
  const subtitle = isToolResult
    ? `${artifact.toolName}${artifact.success ? "" : " · error"}`
    : artifact.language

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col border border-border bg-background",
        variant === "pane"
          ? "h-full border-x-0 border-b-0"
          : "mt-4 max-h-[340px] rounded-md"
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">
            {artifact.title}
          </div>
          <div
            className={cn(
              "text-[11px] text-muted-foreground",
              isToolResult && !artifact.success && "text-destructive"
            )}
          >
            {subtitle}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Close
          </button>
        )}
      </div>
      <div className="agent-scroll min-h-0 flex-1 overflow-auto p-3">
        {args && (
          <details className="mb-3 rounded-md border border-border/70 bg-muted/25">
            <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-muted-foreground">
              Arguments
            </summary>
            <pre className="agent-scroll overflow-auto px-3 pb-3 text-[12px] leading-relaxed text-muted-foreground">
              {args}
            </pre>
          </details>
        )}
        <pre className="text-[12px] leading-relaxed break-words whitespace-pre-wrap text-foreground/85">
          {body || "No output yet."}
        </pre>
      </div>
    </div>
  )
}

function ChildAgentSelector({
  runs,
  activeRunId,
  onSelect,
  onDismiss,
}: {
  runs: AgentCallReasoningEntry[]
  activeRunId: string
  /** Load a sub-agent into this panel's nested preview pane. */
  onSelect?: (entry: AgentCallReasoningEntry) => void
  /** Hide a sub-agent from this panel (view-only; the run keeps going). */
  onDismiss?: (runId: string) => void
}) {
  return (
    <div className="agent-scroll flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-3 py-2">
      <span className="mr-1 shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {runs.length === 1 ? "Sub-agent" : "Sub-agents"}
      </span>
      {runs.map((run) => {
        const active = run.runId === activeRunId
        const label = agentRoleAndName(run)
        return (
          <div
            key={run.runId}
            className={cn(
              "flex shrink-0 items-center rounded-full border text-[12px] transition-colors",
              active
                ? "border-foreground/25 bg-muted text-foreground"
                : "border-border text-muted-foreground",
              onSelect && !active && "hover:bg-muted/50"
            )}
          >
            <button
              type="button"
              onClick={onSelect ? () => onSelect(run) : undefined}
              disabled={!onSelect}
              aria-pressed={active}
              title={onSelect ? `View ${label}` : label}
              className={cn(
                "flex items-center gap-1.5 rounded-full py-1 pl-2.5 transition-colors",
                onDismiss ? "pr-1.5" : "pr-2.5",
                onSelect && "hover:text-foreground"
              )}
            >
              <AgentStatusDot status={run.status} />
              <span className="max-w-[160px] truncate">{label}</span>
            </button>
            {onDismiss && (
              <button
                type="button"
                onClick={() => onDismiss(run.runId)}
                title={`Remove ${label} from panel`}
                aria-label={`Remove ${label} from panel`}
                className="mr-1 flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function AgentStatusDot({
  status,
}: {
  status: AgentCallReasoningEntry["status"]
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "running"
          ? "animate-pulse bg-sky-500"
          : status === "error"
            ? "bg-destructive"
            : status === "aborted"
              ? "bg-muted-foreground/50"
              : "bg-emerald-500"
      )}
    />
  )
}

function formatCompactCount(value: number): string {
  if (value >= 1_000_000) return `${trimCompact(value / 1_000_000)}m chars`
  if (value >= 1_000) return `${trimCompact(value / 1_000)}k chars`
  return `${value} chars`
}

function trimCompact(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "")
}

function shortThreadId(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 8)}...` : threadId
}

function AgentRunPane({
  run,
  compact,
  hideNestedLabel,
  selectedArtifact,
  onArtifactClick,
  onSelectedArtifactClose,
  onAttachmentClick,
}: {
  run: AgentCallReasoningEntry
  compact?: boolean
  hideNestedLabel?: boolean
  selectedArtifact?: ArtifactPayload | null
  onArtifactClick?: (artifact: ArtifactPayload) => void
  onSelectedArtifactClose?: () => void
  onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
}) {
  const isBrowserAgent = run.agentId === "browser_agent"

  return (
    <div className="agent-scroll min-h-0 overflow-auto px-4 py-4">
      {compact && !hideNestedLabel && (
        <div className="mb-3 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
          Nested agent: {agentRoleAndName(run)}
        </div>
      )}
      <div className="mb-4 rounded-md border border-border bg-muted/30 p-3">
        <div className="mb-1 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
          Prompt
        </div>
        <div className="agent-scroll max-h-44 overflow-auto text-[13px] break-words whitespace-pre-wrap text-muted-foreground">
          {run.prompt}
        </div>
      </div>
      {!!run.attachments?.length && !isBrowserAgent && (
        <div className="mb-4 flex flex-wrap gap-2">
          {run.attachments.map((att) => (
            <AttachmentCard
              key={att.id}
              attachment={att}
              onClick={() => onAttachmentClick?.(att, run.attachments)}
            />
          ))}
        </div>
      )}
      {run.error && !isBrowserAgent && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-[13px] text-destructive">
          {run.error}
        </div>
      )}
      <TodoBar
        reasoning={run.reasoning ?? []}
        storageKey={`todo-bar:agent:${run.runId}:expanded`}
        hideCompleted={run.status !== "running"}
      />
      {isBrowserAgent ? (
        <BrowserAgentOutputTerminal
          run={run}
          onAttachmentClick={onAttachmentClick}
        />
      ) : (
        <StreamingBubble
          reasoning={run.reasoning ?? []}
          content={run.content}
          contentSegments={
            run.contentSegments ??
            (run.content ? [{ phase: 0, content: run.content }] : [])
          }
          streamingMode={run.status === "running" ? "reasoning" : null}
          showCursor={
            run.status === "running" && !run.content && !run.reasoning?.length
          }
          onArtifactClick={onArtifactClick}
          onAttachmentClick={onAttachmentClick}
        />
      )}
      {selectedArtifact && !isBrowserAgent && (
        <AgentToolResultPreview
          artifact={selectedArtifact}
          variant="inline"
          onClose={onSelectedArtifactClose}
        />
      )}
    </div>
  )
}

function BrowserAgentOutputTerminal({
  run,
  onAttachmentClick,
}: {
  run: AgentCallReasoningEntry
  onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
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
      className="flex flex-col overflow-hidden rounded-md border border-[#24242a] bg-[#0c0c0e] text-left shadow-sm"
      style={BROWSER_AGENT_TERMINAL_STYLE}
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
