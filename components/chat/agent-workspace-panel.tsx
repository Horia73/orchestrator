"use client"

import * as React from "react"
import { Check, Copy, X } from "lucide-react"

import { AttachmentCard } from "@/components/attachment-card"
import type { ArtifactPayload } from "@/components/artifact-panel"
import {
  BrowserAgentOutputTerminal,
  BrowserAgentWorkspace,
} from "@/components/chat/browser-agent-workspace"
import { StreamingBubble } from "@/components/message-bubble"
import { TodoBar } from "@/components/todo-bar"
import { useTrapWheel } from "@/components/use-trap-wheel"
import { useRevealOnScroll } from "@/hooks/use-reveal-on-scroll"
import {
  agentRoleAndName,
  distinctAgentRoleAndNames,
} from "@/lib/agent-label"
import { directChildAgentRuns } from "@/lib/agent-hierarchy"
import { copyTextToClipboard } from "@/lib/clipboard"
import { cn } from "@/lib/utils"
import type {
  AgentCallReasoningEntry,
  Attachment,
  ToolCallReasoningEntry,
} from "@/lib/types"

type SelectedAgentTool = {
  runId: string
  artifact: ArtifactPayload
}

export function AgentWorkspacePanel({
  run,
  allRuns,
  onClose,
  onAttachmentClick,
  onLoadToolCallDetails,
}: {
  run: AgentCallReasoningEntry
  allRuns: AgentCallReasoningEntry[]
  onClose: () => void
  onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
  onLoadToolCallDetails?: (toolCallId: string) => Promise<ToolCallReasoningEntry>
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

  const children = React.useMemo(
    () =>
      directChildAgentRuns(allRuns, run.runId).filter(
        (child) => !dismissedRunIds.has(child.runId)
      ),
    [allRuns, dismissedRunIds, run.runId]
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
  const selectRunTool = React.useCallback(
    (runId: string, artifact: ArtifactPayload) =>
      setSelectedTool({ runId, artifact }),
    []
  )

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
          selectedTool={splitTool ? null : selectedTool}
          onRunArtifactClick={selectRunTool}
          onSelectedArtifactClose={() => setSelectedTool(null)}
          onAttachmentClick={onAttachmentClick}
          onLoadToolCallDetails={onLoadToolCallDetails}
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
                parentRun={run}
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
              allRuns={allRuns}
              showNestedChildren
              selectedTool={selectedTool}
              onRunArtifactClick={selectRunTool}
              onSelectedArtifactClose={() => setSelectedTool(null)}
              onAttachmentClick={onAttachmentClick}
              onLoadToolCallDetails={onLoadToolCallDetails}
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
  parentRun,
  runs,
  activeRunId,
  onSelect,
  onDismiss,
}: {
  parentRun: AgentCallReasoningEntry
  runs: AgentCallReasoningEntry[]
  activeRunId: string
  /** Load a sub-agent into this panel's nested preview pane. */
  onSelect?: (entry: AgentCallReasoningEntry) => void
  /** Hide a sub-agent from this panel (view-only; the run keeps going). */
  onDismiss?: (runId: string) => void
}) {
  const labels = distinctAgentRoleAndNames(runs, [parentRun])
  return (
    <div className="agent-scroll flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-3 py-2">
      <span className="mr-1 shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {runs.length === 1 ? "Sub-agent" : "Sub-agents"}
      </span>
      {runs.map((run, index) => {
        const active = run.runId === activeRunId
        const label = labels[index]
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
  embedded,
  allRuns,
  showNestedChildren,
  selectedTool,
  onRunArtifactClick,
  onSelectedArtifactClose,
  onAttachmentClick,
  onLoadToolCallDetails,
}: {
  run: AgentCallReasoningEntry
  compact?: boolean
  hideNestedLabel?: boolean
  embedded?: boolean
  allRuns?: AgentCallReasoningEntry[]
  showNestedChildren?: boolean
  selectedTool?: SelectedAgentTool | null
  onRunArtifactClick?: (runId: string, artifact: ArtifactPayload) => void
  onSelectedArtifactClose?: () => void
  onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
  onLoadToolCallDetails?: (toolCallId: string) => Promise<ToolCallReasoningEntry>
}) {
  const isBrowserAgent = run.agentId === "browser_agent"
  const selectedArtifact =
    selectedTool?.runId === run.runId ? selectedTool.artifact : null

  // Primary browser runs get the dedicated workspace: live view locked to the
  // stream aspect + Console/Network/Transcript tabs filling the rest. Nested
  // (compact) browser runs keep the plain transcript terminal.
  if (isBrowserAgent && !compact) {
    return <BrowserAgentWorkspace run={run} onAttachmentClick={onAttachmentClick} />
  }

  return (
    <div
      className={cn(
        embedded
          ? "border-t border-border/70 px-3 py-4"
          : "agent-scroll min-h-0 overflow-auto px-4 py-4"
      )}
    >
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
          onArtifactClick={
            onRunArtifactClick
              ? (artifact) => onRunArtifactClick(run.runId, artifact)
              : undefined
          }
          onAttachmentClick={onAttachmentClick}
          onLoadToolCallDetails={onLoadToolCallDetails}
        />
      )}
      {selectedArtifact && !isBrowserAgent && (
        <AgentToolResultPreview
          artifact={selectedArtifact}
          variant="inline"
          onClose={onSelectedArtifactClose}
        />
      )}
      {showNestedChildren && allRuns && (
        <NestedAgentSection
          parentRun={run}
          allRuns={allRuns}
          selectedTool={selectedTool}
          onRunArtifactClick={onRunArtifactClick}
          onSelectedArtifactClose={onSelectedArtifactClose}
          onAttachmentClick={onAttachmentClick}
          onLoadToolCallDetails={onLoadToolCallDetails}
        />
      )}
    </div>
  )
}

/**
 * Render one more generation inside the selected child's transcript. Each
 * generation derives only direct parentRunId edges, so a grandchild can never
 * leak into the root selector or a sibling branch. MAX_AGENT_DEPTH keeps this
 * recursion shallow and bounded.
 */
function NestedAgentSection({
  parentRun,
  allRuns,
  selectedTool,
  onRunArtifactClick,
  onSelectedArtifactClose,
  onAttachmentClick,
  onLoadToolCallDetails,
}: {
  parentRun: AgentCallReasoningEntry
  allRuns: AgentCallReasoningEntry[]
  selectedTool?: SelectedAgentTool | null
  onRunArtifactClick?: (runId: string, artifact: ArtifactPayload) => void
  onSelectedArtifactClose?: () => void
  onAttachmentClick?: (attachment: Attachment, gallery?: Attachment[]) => void
  onLoadToolCallDetails?: (toolCallId: string) => Promise<ToolCallReasoningEntry>
}) {
  const children = React.useMemo(
    () => directChildAgentRuns(allRuns, parentRun.runId),
    [allRuns, parentRun.runId]
  )
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null)
  const selectedRun =
    children.find((child) => child.runId === selectedRunId) ?? null
  const activeRun =
    selectedRun ??
    children.find((child) => child.status === "running") ??
    children[children.length - 1]

  React.useEffect(() => {
    if (
      selectedRunId &&
      !children.some((child) => child.runId === selectedRunId)
    ) {
      setSelectedRunId(null)
    }
  }, [children, selectedRunId])

  if (!activeRun) return null

  return (
    <div className="mt-5 overflow-hidden rounded-md border border-border/80 bg-background">
      <ChildAgentSelector
        parentRun={parentRun}
        runs={children}
        activeRunId={activeRun.runId}
        onSelect={(entry) => setSelectedRunId(entry.runId)}
      />
      <AgentRunPane
        key={activeRun.runId}
        run={activeRun}
        compact
        embedded
        hideNestedLabel
        allRuns={allRuns}
        showNestedChildren
        selectedTool={selectedTool}
        onRunArtifactClick={onRunArtifactClick}
        onSelectedArtifactClose={onSelectedArtifactClose}
        onAttachmentClick={onAttachmentClick}
        onLoadToolCallDetails={onLoadToolCallDetails}
      />
    </div>
  )
}
