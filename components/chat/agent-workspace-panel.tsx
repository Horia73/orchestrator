"use client"

import * as React from "react"

import { AttachmentCard } from "@/components/attachment-card"
import type { ArtifactPayload } from "@/components/artifact-panel"
import { StreamingBubble } from "@/components/message-bubble"
import { TodoBar } from "@/components/todo-bar"
import { TerminalOutput } from "@/components/tool-call-view"
import { FULL_HISTORY_SCROLLBACK } from "@/components/tool-call-terminal"
import { cn } from "@/lib/utils"
import type {
  AgentCallReasoningEntry,
  Attachment,
  ReasoningEntry,
} from "@/lib/types"

const BROWSER_AGENT_TERMINAL_STYLE: React.CSSProperties = {
  height: "min(460px, calc(100vh - 260px))",
  minHeight: "320px",
}

const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"])

type SelectedAgentTool = {
  runId: string
  artifact: ArtifactPayload
}

export function AgentWorkspacePanel({
  run,
  childRun,
  onClose,
  onAttachmentClick,
}: {
  run: AgentCallReasoningEntry
  childRun?: AgentCallReasoningEntry
  onClose: () => void
  onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
}) {
  const [selectedTool, setSelectedTool] =
    React.useState<SelectedAgentTool | null>(null)

  React.useEffect(() => {
    setSelectedTool(null)
  }, [run.runId, childRun?.runId])

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
      className="flex h-full min-h-0 flex-col border-l border-border bg-background"
      onWheelCapture={containWheelWithinPanel}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium">
            {run.agentName}
          </div>
          <div className="text-[12px] text-muted-foreground">
            {run.status === "aborted" ? "stopped" : run.status}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Close
        </button>
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
          <AgentRunPane
            run={childRun}
            compact
            selectedArtifact={childInlineTool ?? null}
            onArtifactClick={(artifact) =>
              setSelectedTool({ runId: childRun.runId, artifact })
            }
            onSelectedArtifactClose={() => setSelectedTool(null)}
            onAttachmentClick={onAttachmentClick}
          />
        ) : null}
      </div>
    </div>
  )
}

function containWheelWithinPanel(event: React.WheelEvent<HTMLElement>) {
  const axis = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? "y" : "x"

  // xterm manages its own wheel-to-scroll on `.xterm-viewport`, and CSS
  // `overscroll-behavior: contain` already keeps the chain off the page.
  // Intercepting here (stopPropagation) would freeze the terminal, so when the
  // buffer has something to scroll we let the event reach xterm untouched.
  if (axis === "y") {
    const xtermRoot =
      event.target instanceof Element ? event.target.closest(".xterm") : null
    const viewport = xtermRoot?.querySelector<HTMLElement>(".xterm-viewport")
    if (viewport && viewport.scrollHeight > viewport.clientHeight + 1) return
  }

  const scroller = findScrollableAncestor(
    event.target,
    event.currentTarget,
    axis
  )
  if (!scroller) return

  event.stopPropagation()
  const delta = axis === "y" ? event.deltaY : event.deltaX
  if (shouldBlockScrollChain(scroller, axis, delta)) {
    event.preventDefault()
  }
}

function findScrollableAncestor(
  target: EventTarget | null,
  boundary: HTMLElement,
  axis: "x" | "y"
): HTMLElement | null {
  let node = target instanceof HTMLElement ? target : null
  while (node) {
    if (isScrollableOnAxis(node, axis)) return node
    if (node === boundary) break
    node = node.parentElement
  }
  return null
}

function isScrollableOnAxis(element: HTMLElement, axis: "x" | "y"): boolean {
  const style = window.getComputedStyle(element)
  if (axis === "y") {
    return (
      SCROLLABLE_OVERFLOW.has(style.overflowY) &&
      element.scrollHeight > element.clientHeight + 1
    )
  }
  return (
    SCROLLABLE_OVERFLOW.has(style.overflowX) &&
    element.scrollWidth > element.clientWidth + 1
  )
}

function shouldBlockScrollChain(
  element: HTMLElement,
  axis: "x" | "y",
  delta: number
): boolean {
  if (delta === 0) return false
  if (axis === "y") {
    const max = element.scrollHeight - element.clientHeight
    return delta < 0 ? element.scrollTop <= 0 : element.scrollTop >= max - 1
  }
  const max = element.scrollWidth - element.clientWidth
  return delta < 0 ? element.scrollLeft <= 0 : element.scrollLeft >= max - 1
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
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {args && (
          <details className="mb-3 rounded-md border border-border/70 bg-muted/25">
            <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-muted-foreground">
              Arguments
            </summary>
            <pre className="overflow-auto px-3 pb-3 text-[12px] leading-relaxed text-muted-foreground">
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

function AgentRunPane({
  run,
  compact,
  selectedArtifact,
  onArtifactClick,
  onSelectedArtifactClose,
  onAttachmentClick,
}: {
  run: AgentCallReasoningEntry
  compact?: boolean
  selectedArtifact?: ArtifactPayload | null
  onArtifactClick?: (artifact: ArtifactPayload) => void
  onSelectedArtifactClose?: () => void
  onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
}) {
  const isBrowserAgent = run.agentId === "browser_agent"

  return (
    <div className="min-h-0 overflow-auto px-4 py-4">
      {compact && (
        <div className="mb-3 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
          Nested agent: {run.agentName}
        </div>
      )}
      <div className="mb-4 rounded-md border border-border bg-muted/30 p-3">
        <div className="mb-1 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
          Prompt
        </div>
        <div className="max-h-44 overflow-auto text-[13px] break-words whitespace-pre-wrap text-muted-foreground">
          {run.prompt}
        </div>
      </div>
      {!!run.attachments?.length && (
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
        <BrowserAgentOutputTerminal run={run} />
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

function BrowserAgentOutputTerminal({ run }: { run: AgentCallReasoningEntry }) {
  return (
    <div
      className="flex flex-col overflow-hidden rounded-md border border-[#24242a] bg-[#0c0c0e] text-left shadow-sm"
      style={BROWSER_AGENT_TERMINAL_STYLE}
    >
      <TerminalOutput
        text={browserAgentTerminalText(run)}
        cursorBlink={run.status === "running"}
        resetKey={run.runId}
        autoScroll
        scrollback={FULL_HISTORY_SCROLLBACK}
      />
    </div>
  )
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
    .replace(/\nTerminal output:\n```text\n[\s\S]*?\n```\n?/g, "\n")
    .trimEnd()
}

function extractBrowserAgentTerminalTranscript(content: string): string {
  const match = content.match(/\nTerminal output:\n```text\n([\s\S]*?)\n```\n?/)
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
