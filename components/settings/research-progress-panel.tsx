"use client"

import * as React from "react"
import { AlertCircle, Bot, CheckCircle2, CircleDotDashed, FileSearch, Loader2, X } from "lucide-react"

import { StreamingBubble } from "@/components/message-bubble"
import { cn } from "@/lib/utils"
import type { AgentKind } from "@/lib/ai/agents/types"
import type { AgentCallReasoningEntry, ContentSegment, ReasoningEntry, ToolCallReasoningEntry, ToolStreamDelta } from "@/lib/types"
import type { ModelResearchClientEvent } from "@/components/settings/use-settings"

interface ResearchProgressPanelProps {
  events: ModelResearchClientEvent[]
  researching: boolean
  statusOnly?: boolean
  modelStatuses?: CurrentModelResearchStatus[]
  onCollapse: () => void
  onClear: () => void
}

type ResearchRunStatus = "running" | "updated" | "unchanged" | "incomplete" | "failed" | "stopped"
type ModelMetadataStatus = "complete" | "incomplete"
type TranscriptMode = "reasoning" | "content"
const IDLE_NOTICE_AFTER_MS = 45_000
const RUN_STALE_AFTER_MS = 90_000

export interface CurrentModelResearchStatus {
  key: string
  providerId: string
  modelId: string
  name: string
  status: ModelMetadataStatus
  missing: string[]
  fields: Array<{ label: string; value: string; tone?: "ok" | "missing" | "muted" }>
  lastResearchedAt?: number
}

interface AgentTranscriptState {
  agent?: AgentCallReasoningEntry
  phase: number
  mode: TranscriptMode
}

interface ResearchRun {
  key: string
  providerId: string
  modelId: string
  name: string
  index: number
  total: number
  missing: string[]
  status: ResearchRunStatus
  attempt: number
  maxAttempts: number
  retryReason?: string
  lastEventAt?: number
  agent?: AgentCallReasoningEntry
  result?: Extract<ModelResearchClientEvent, { type: "model_result" }>
}

interface ResearchTimeline {
  ready?: Extract<ModelResearchClientEvent, { type: "ready" }>
  done?: Extract<ModelResearchClientEvent, { type: "done" }>
  stopped?: Extract<ModelResearchClientEvent, { type: "stopped" }>
  error?: Extract<ModelResearchClientEvent, { type: "error" }>
  runs: ResearchRun[]
  activeRun?: ResearchRun
}

export function ResearchProgressPanel({ events, researching, statusOnly = false, modelStatuses = [], onCollapse, onClear }: ResearchProgressPanelProps) {
  const timeline = React.useMemo(() => buildResearchTimeline(events), [events])
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null)
  const [selectedStatusKey, setSelectedStatusKey] = React.useState<string | null>(null)
  const [now, setNow] = React.useState(() => Date.now())
  const hasRunTimeline = !statusOnly && (researching || events.length > 0 || timeline.runs.length > 0)
  const statusSummary = React.useMemo(() => summarizeModelStatuses(modelStatuses), [modelStatuses])

  React.useEffect(() => {
    if (!hasRunTimeline) return
    const timer = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(timer)
  }, [hasRunTimeline])

  React.useEffect(() => {
    if (!researching) return
    setSelectedKey(null)
  }, [researching, timeline.activeRun?.key])

  React.useEffect(() => {
    if (hasRunTimeline || modelStatuses.length === 0) return
    const selectedExists = selectedStatusKey && modelStatuses.some(model => model.key === selectedStatusKey)
    if (selectedExists) return
    setSelectedStatusKey(modelStatuses.find(model => model.status === "incomplete")?.key ?? modelStatuses[0]?.key ?? null)
  }, [hasRunTimeline, modelStatuses, selectedStatusKey])

  const selectedRun = selectedKey
    ? timeline.runs.find(run => run.key === selectedKey) ?? timeline.activeRun
    : timeline.activeRun
  const selectedStatus = selectedStatusKey
    ? modelStatuses.find(model => model.key === selectedStatusKey) ?? modelStatuses[0]
    : modelStatuses.find(model => model.status === "incomplete") ?? modelStatuses[0]
  const hasRunningRun = timeline.runs.some(run => run.status === "running")
  const runningRunCount = timeline.runs.filter(run => run.status === "running").length
  const finishedRunCount = timeline.runs.filter(run => run.status !== "running").length
  const maxConcurrency = timeline.ready?.concurrency ?? 6
  // The denominator must come from a source that survives event eviction, and
  // can never legitimately be smaller than how many runs we've already seen —
  // otherwise the counter renders nonsense like "3/0" or "0/0".
  const knownTotal = Math.max(
    timeline.ready?.total ?? 0,
    timeline.done?.total ?? 0,
    selectedRun?.total ?? 0,
    ...timeline.runs.map(run => run.total),
    0
  )
  const progressTotal = Math.max(knownTotal, timeline.runs.length, runningRunCount + finishedRunCount)
  const selectedIndex = selectedRun ? Math.min(Math.max(selectedRun.index, 1), Math.max(progressTotal, 1)) : 0
  const lastRunEventAt = Math.max(...timeline.runs.map(run => run.lastEventAt ?? 0), 0)
  const staleElapsedMs = lastRunEventAt > 0 ? now - lastRunEventAt : null
  const unfinishedRunTimeline = hasRunTimeline
    && !timeline.done
    && !timeline.error
    && !timeline.stopped
    && hasRunningRun
  const runAppearsActive = unfinishedRunTimeline
    && (researching || (lastRunEventAt > 0 && now - lastRunEventAt < RUN_STALE_AFTER_MS))
  const runAppearsStale = unfinishedRunTimeline && !runAppearsActive
  const staleRun = runAppearsStale ? timeline.runs.find(run => run.status === "running") ?? selectedRun : undefined
  const staleRunName = staleRun?.name ?? "the selected model"

  const headline = runAppearsStale
    ? staleElapsedMs === null
      ? `No live stream is active for ${staleRunName}`
      : `No live updates for ${formatDuration(staleElapsedMs)} on ${staleRunName}`
    : hasRunTimeline && runningRunCount > 1
    ? `${runningRunCount} running · ${finishedRunCount}/${progressTotal} finished · max ${maxConcurrency} at once`
    : hasRunTimeline && selectedRun
    ? `${selectedIndex}/${Math.max(progressTotal, 1)}: ${selectedRun.name}`
    : hasRunTimeline && timeline.stopped
      ? timeline.stopped.message
    : hasRunTimeline && timeline.done
      ? `Done: ${timeline.done.updated} patched, ${timeline.done.incomplete ?? 0} incomplete, ${timeline.done.failed} failed`
    : hasRunTimeline && timeline.ready
        ? `${progressTotal} active models queued · max ${maxConcurrency} at once`
      : `${statusSummary.complete} complete · ${statusSummary.incomplete} incomplete · ${modelStatuses.length} active models`
  const title = hasRunTimeline ? "Research agent live" : "Model research status"
  const hasIncompleteStatuses = statusSummary.incomplete > 0

  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-card">
      <div className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {researching ? (
              <Loader2 className="size-3.5 animate-spin text-foreground/55" />
            ) : runAppearsActive ? (
              <Loader2 className="size-3.5 animate-spin text-foreground/55" />
            ) : runAppearsStale ? (
              <AlertCircle className="size-3.5 text-amber-600" />
            ) : timeline.error ? (
              <AlertCircle className="size-3.5 text-destructive" />
            ) : !hasRunTimeline && hasIncompleteStatuses ? (
              <AlertCircle className="size-3.5 text-amber-600" />
            ) : (
              <CheckCircle2 className="size-3.5 text-emerald-600" />
            )}
            <h3 className="text-[13px] font-semibold text-foreground/80">{title}</h3>
          </div>
          <p className="mt-0.5 truncate text-[12px] text-foreground/50">{headline}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!researching && events.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex h-7 items-center rounded-md px-2 text-[12px] font-medium text-foreground/45 transition-colors hover:bg-muted hover:text-foreground"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onCollapse}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/45 transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Hide research preview"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="grid min-h-0 lg:h-[min(76vh,780px)] lg:min-h-[520px] lg:grid-cols-[230px_minmax(0,1fr)]">
        <div className="max-h-48 overflow-auto border-b border-border/60 bg-muted/15 p-2 lg:max-h-none lg:border-r lg:border-b-0">
          {!hasRunTimeline && modelStatuses.length > 0 ? (
            <div className="space-y-1">
              {modelStatuses.map(model => {
                const active = model.key === selectedStatus?.key
                return (
                  <button
                    key={model.key}
                    type="button"
                    onClick={() => setSelectedStatusKey(model.key)}
                    className={cn(
                      "flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors",
                      active ? "bg-background text-foreground shadow-sm ring-1 ring-border/70" : "text-foreground/65 hover:bg-background/70"
                    )}
                  >
                    <ModelStatusDot status={model.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">{model.name}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-foreground/42">
                        {model.providerId}:{model.modelId}
                      </span>
                      {model.missing.length > 0 ? (
                        <span className="mt-1 block truncate text-[11px] text-amber-700 dark:text-amber-400">
                          Missing {formatMissingFields(model.missing)}
                        </span>
                      ) : (
                        <span className="mt-1 block truncate text-[11px] text-emerald-700 dark:text-emerald-400">
                          Complete metadata
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : timeline.runs.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg px-2 py-2 text-[12px] text-foreground/45">
              <CircleDotDashed className="size-3.5" />
              Waiting for the first model.
            </div>
          ) : (
            <div className="space-y-1">
              {timeline.runs.map(run => {
                const active = run.key === selectedRun?.key
                const visibleMissing = visibleMissingFields(run)
                return (
                  <button
                    key={run.key}
                    type="button"
                    onClick={() => setSelectedKey(run.key)}
                    className={cn(
                      "flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors",
                      active ? "bg-background text-foreground shadow-sm ring-1 ring-border/70" : "text-foreground/65 hover:bg-background/70"
                    )}
                  >
                    <ResearchStatusDot status={run.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">{run.name}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-foreground/42">
                        {run.providerId}:{run.modelId}
                      </span>
                      {run.attempt > 1 ? (
                        <span className="mt-1 block truncate text-[11px] text-blue-700 dark:text-blue-300">
                          Retry {run.attempt}/{run.maxAttempts}
                        </span>
                      ) : visibleMissing.length > 0 && (
                        <span className="mt-1 block truncate text-[11px] text-amber-700 dark:text-amber-400">
                          Missing {formatMissingFields(visibleMissing)}
                        </span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="max-h-[70vh] min-h-[360px] overflow-auto p-3 lg:max-h-none lg:min-h-0">
          {timeline.error ? (
            <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-[12.5px] text-destructive">
              {timeline.error.message}
            </div>
          ) : selectedRun ? (
            <ResearchRunPreview run={selectedRun} now={now} />
          ) : !hasRunTimeline && selectedStatus ? (
            <CurrentModelStatusPreview model={selectedStatus} />
          ) : (
            <div className="flex h-full min-h-[180px] items-center justify-center text-[12.5px] text-foreground/45">
              No model status available.
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function ResearchRunPreview({ run, now }: { run: ResearchRun; now: number }) {
  const transcript = run.agent ? normalizeAgentTranscript(run.agent) : { content: "", contentSegments: [] as ContentSegment[] }
  const isRunning = run.status === "running"
  const idleMs = isRunning && run.lastEventAt ? now - run.lastEventAt : null
  const isIdle = idleMs !== null && idleMs > IDLE_NOTICE_AFTER_MS
  const isStale = isRunning && (!run.lastEventAt || (idleMs !== null && idleMs > RUN_STALE_AFTER_MS))

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border/60 bg-background px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Bot className="size-3.5 shrink-0 text-foreground/45" />
            <p className="truncate text-[13px] font-semibold text-foreground/82">{run.name}</p>
          </div>
          <p className="mt-0.5 truncate text-[11.5px] text-foreground/45">
            {run.providerId}:{run.modelId}
          </p>
        </div>
        <ResearchStatusPill status={run.status} />
      </div>

      {run.retryReason && (
        <div className="rounded-lg border border-blue-500/25 bg-blue-500/10 px-3 py-2.5 text-[12.5px] text-blue-800 dark:text-blue-300">
          Retry {run.attempt}/{run.maxAttempts}: {run.retryReason}
        </div>
      )}

      {isIdle && (
        <div
          className={cn(
            "rounded-lg border px-3 py-2.5 text-[12.5px]",
            isStale
              ? "border-amber-500/25 bg-amber-500/10 text-amber-800 dark:text-amber-300"
              : "border-border/70 bg-muted/30 text-foreground/58"
          )}
        >
          No researcher events for {formatDuration(idleMs ?? 0)}. {isStale ? "This preview is stale; start research again to continue." : "Still waiting on the current provider or tool call. Retries will appear here if the attempt times out or fails."}
        </div>
      )}

      {run.agent ? (
        <div className="min-w-0 rounded-lg border border-border/60 bg-background px-3 py-3">
          <div className="mb-2 flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-wider text-foreground/45">
            <FileSearch className="size-3.5" />
            Transcript
          </div>
          <StreamingBubble
            reasoning={run.agent.reasoning ?? []}
            content={transcript.content}
            contentSegments={transcript.contentSegments}
            streamingMode={isRunning ? inferStreamingMode(run.agent) : null}
            showCursor={isRunning}
            thinkingDone={run.agent.status !== "running"}
            thinkingSeconds={run.agent.status === "running" ? elapsedSeconds(run.agent.startedAt) : undefined}
            searchToolDisplay="expanded"
            thoughtAutoOpen={false}
            thoughtAutoExpandTools={false}
            liveCollapsedTitle
          />
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-3 py-8 text-center text-[12.5px] text-foreground/45">
          Researcher has not emitted a transcript for this model yet.
        </div>
      )}

      {run.result && <ResearchResultBlock result={run.result} />}
    </div>
  )
}

function ResearchResultBlock({ result }: { result: Extract<ModelResearchClientEvent, { type: "model_result" }> }) {
  const failed = result.status === "failed"
  const incomplete = result.status === "incomplete"

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 text-[12.5px]",
        failed
          ? "border-destructive/25 bg-destructive/5 text-destructive"
          : incomplete
            ? "border-amber-500/25 bg-amber-500/10 text-amber-800 dark:text-amber-300"
            : "border-emerald-500/20 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
      )}
    >
      <div className="flex items-center gap-2 font-medium">
        {failed ? <AlertCircle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
        <span>{result.status === "updated" ? "Metadata patched" : result.status === "unchanged" ? "No metadata changes" : result.status === "incomplete" ? "Still incomplete" : "Research failed"}</span>
      </div>
      {(result.summary || result.error) && (
        <p className="mt-1.5 leading-relaxed text-current/85">{result.error ?? result.summary}</p>
      )}
      {result.remainingMissing && result.remainingMissing.length > 0 && (
        <p className="mt-1.5 text-[11.5px] text-current/75">Remaining: {formatMissingFields(result.remainingMissing)}</p>
      )}
      {result.unresolved && result.unresolved.length > 0 && (
        <div className="mt-2 space-y-1">
          {result.unresolved.slice(0, 4).map(item => (
            <p key={`${item.field}-${item.reason ?? ""}`} className="text-[11.5px] leading-snug text-current/75">
              {formatMissingFields([item.field])}{item.reason ? `: ${item.reason}` : ""}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

function CurrentModelStatusPreview({ model }: { model: CurrentModelResearchStatus }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border/60 bg-background px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <FileSearch className="size-3.5 shrink-0 text-foreground/45" />
            <p className="truncate text-[13px] font-semibold text-foreground/82">{model.name}</p>
          </div>
          <p className="mt-0.5 truncate text-[11.5px] text-foreground/45">
            {model.providerId}:{model.modelId}
          </p>
        </div>
        <ModelStatusPill status={model.status} />
      </div>

      <div className="rounded-lg border border-border/60 bg-background px-3 py-3">
        <div className="mb-2 flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-wider text-foreground/45">
          <FileSearch className="size-3.5" />
          Current metadata
        </div>
        <div className="divide-y divide-border/50">
          {model.fields.map(field => (
            <div key={field.label} className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 py-2 text-[12.5px]">
              <span className="text-foreground/45">{field.label}</span>
              <span
                className={cn(
                  "min-w-0 break-words",
                  field.tone === "missing" && "text-amber-700 dark:text-amber-400",
                  field.tone === "ok" && "text-emerald-700 dark:text-emerald-400",
                  field.tone === "muted" && "text-foreground/45",
                  !field.tone && "text-foreground/72"
                )}
              >
                {field.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      {model.missing.length > 0 ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-[12.5px] text-amber-800 dark:text-amber-300">
          Missing: {formatMissingFields(model.missing)}
        </div>
      ) : (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2.5 text-[12.5px] text-emerald-800 dark:text-emerald-300">
          All tracked metadata fields are complete.
        </div>
      )}
    </div>
  )
}

function buildResearchTimeline(events: ModelResearchClientEvent[]): ResearchTimeline {
  const runs: ResearchRun[] = []
  const byKey = new Map<string, ResearchRun>()
  const agentStateByKey = new Map<string, AgentTranscriptState>()
  let ready: ResearchTimeline["ready"]
  let done: ResearchTimeline["done"]
  let stopped: ResearchTimeline["stopped"]
  let error: ResearchTimeline["error"]
  let lastKey: string | undefined

  const ensureRun = (key: string): ResearchRun => {
    const existing = byKey.get(key)
    if (existing) return existing
    const [providerId = "provider", modelId = "model"] = key.split(":")
    const run: ResearchRun = {
      key,
      providerId,
      modelId,
      name: key,
      index: runs.length + 1,
      total: ready?.total ?? 0,
      missing: [],
      status: "running",
      attempt: 1,
      maxAttempts: 1,
    }
    byKey.set(key, run)
    runs.push(run)
    return run
  }

  for (const event of events) {
    if (event.type === "ready") {
      ready = event
      continue
    }
    if (event.type === "done") {
      done = event
      continue
    }
    if (event.type === "stopped") {
      stopped = event
      for (const run of runs) {
        if (run.status === "running") run.status = "stopped"
        run.lastEventAt = event.at ?? run.lastEventAt
      }
      continue
    }
    if (event.type === "error") {
      error = event
      continue
    }
    if (event.type === "model_start") {
      const existing = byKey.get(event.key)
      const run: ResearchRun = {
        key: event.key,
        providerId: event.providerId,
        modelId: event.modelId,
        name: event.name,
        index: event.index,
        total: event.total,
        missing: event.missing,
        status: "running",
        attempt: existing?.attempt ?? 1,
        maxAttempts: existing?.maxAttempts ?? 1,
        retryReason: existing?.retryReason,
        lastEventAt: event.at ?? existing?.lastEventAt,
        agent: existing?.agent,
        result: existing?.result,
      }
      byKey.set(event.key, run)
      const existingIndex = runs.findIndex(item => item.key === event.key)
      if (existingIndex >= 0) runs[existingIndex] = run
      else runs.push(run)
      lastKey = event.key
      continue
    }
    if (event.type === "agent_event") {
      const run = ensureRun(event.key)
      const previous = agentStateByKey.get(event.key) ?? { agent: run.agent, phase: 0, mode: "reasoning" }
      const nextState = applyAgentRunEvent(previous, event.event)
      agentStateByKey.set(event.key, nextState)
      run.agent = nextState.agent
      run.lastEventAt = event.at ?? run.lastEventAt
      lastKey = event.key
      continue
    }
    if (event.type === "model_retry") {
      const run = ensureRun(event.key)
      run.status = "running"
      run.attempt = event.attempt
      run.maxAttempts = event.maxAttempts
      run.retryReason = event.reason
      run.lastEventAt = event.at ?? run.lastEventAt
      lastKey = event.key
      continue
    }
    if (event.type === "model_result") {
      const run = ensureRun(event.key)
      run.status = event.status === "failed" ? "failed" : event.status
      run.result = event
      run.missing = event.remainingMissing ?? (event.status === "updated" || event.status === "unchanged" ? [] : run.missing)
      run.lastEventAt = event.at ?? run.lastEventAt
      lastKey = event.key
    }
  }

  const activeRun = runs.find(run => run.status === "running") ?? (lastKey ? byKey.get(lastKey) : undefined) ?? runs.at(-1)
  return { ready, done, stopped, error, runs, activeRun }
}

function visibleMissingFields(run: ResearchRun): string[] {
  if (run.status === "updated" || run.status === "unchanged") return []
  return run.missing
}

function applyAgentRunEvent(state: AgentTranscriptState, event: Record<string, unknown>): AgentTranscriptState {
  const type = stringValue(event.type)
  const runId = stringValue(event.runId)

  if (type === "agent_start") {
    if (!runId) return state
    const existing = state.agent?.runId === runId ? state.agent : undefined
    const agentId = stringValue(event.agentId) ?? "researcher"
    const agentName = stringValue(event.agentName) ?? "Researcher"
    return {
      phase: 0,
      mode: "reasoning",
      agent: {
      type: "agent_call",
      id: `agent_${runId}`,
      phase: 0,
      toolCallId: stringValue(event.toolCallId),
      runId,
      parentRunId: stringValue(event.parentRunId),
      agentId,
      agentName,
      kind: normalizeAgentKind(event.kind),
      title: agentName,
      prompt: stringValue(event.prompt) ?? existing?.prompt ?? "",
      status: "running",
      startedAt: numberValue(event.startedAt) ?? existing?.startedAt ?? Date.now(),
      content: existing?.content ?? "",
      contentSegments: existing?.contentSegments ?? [],
      reasoning: existing?.reasoning ?? [],
      attachments: existing?.attachments,
      error: existing?.error,
      thinkingDuration: existing?.thinkingDuration,
      },
    }
  }

  if (!runId) return state
  const current = state.agent ?? createPlaceholderAgent(runId)

  if (type === "agent_thinking") {
    const chunk = stringValue(event.content)
    if (!chunk) return { ...state, agent: current }
    const nextState = state.mode === "content"
      ? { ...state, phase: state.phase + 1, mode: "reasoning" as const }
      : { ...state, mode: "reasoning" as const }
    return { ...nextState, agent: appendAgentThought(current, chunk, nextState.phase) }
  }

  if (type === "agent_thinking_done") {
    const seconds = numberValue(event.seconds)
    return { ...state, agent: seconds === undefined ? current : { ...current, thinkingDuration: seconds } }
  }

  if (type === "agent_content") {
    const chunk = stringValue(event.content)
    if (!chunk) return { ...state, agent: current }
    return {
      ...state,
      mode: "content",
      agent: appendAgentContent(current, chunk, state.phase),
    }
  }

  if (type === "agent_tool_call") {
    const nextState = state.mode === "content"
      ? { ...state, phase: state.phase + 1, mode: "reasoning" as const }
      : { ...state, mode: "reasoning" as const }
    const toolCall = objectValue(event.toolCall)
    const toolCallId = stringValue(toolCall?.id)
    if (!toolCallId) return { ...nextState, agent: current }
    const toolName = stringValue(toolCall?.name)
    const args = objectValue(toolCall?.arguments) as Record<string, unknown> | undefined
    const title = stringValue(toolCall?.title) ?? toolName ?? "tool"
    if (current.reasoning?.some(item => item.type === "tool_call" && item.toolCallId === toolCallId)) return { ...nextState, agent: current }
    return {
      ...nextState,
      agent: {
        ...current,
        reasoning: [
          ...(current.reasoning ?? []),
          {
            type: "tool_call",
            id: `tool_${toolCallId}`,
            phase: nextState.phase,
            toolCallId,
            title,
            content: "",
            toolName,
            args,
            status: "running",
            startedAt: Date.now(),
          },
        ],
      },
    }
  }

  if (type === "agent_tool_delta") {
    const toolCallId = stringValue(event.toolCallId)
    const delta = normalizeToolDelta(event.delta)
    if (!toolCallId || !delta) return { ...state, agent: current }
    return { ...state, agent: updateAgentTool(current, toolCallId, entry => ({
      ...entry,
      toolName: entry.toolName ?? stringValue(event.toolName),
      status: "running",
      deltas: [...(entry.deltas ?? []), delta],
    })) }
  }

  if (type === "agent_tool_result") {
    const toolCallId = stringValue(event.toolCallId)
    if (!toolCallId) return { ...state, agent: current }
    const { content, success } = normalizeToolResult(event.result)
    return { ...state, agent: updateAgentTool(current, toolCallId, entry => ({
      ...entry,
      content,
      success,
      status: success === false ? "error" : "ok",
      endedAt: Date.now(),
    })) }
  }

  if (type === "agent_done") {
    const doneAgent: AgentCallReasoningEntry = {
      ...current,
      status: normalizeAgentStatus(event.status),
      endedAt: numberValue(event.endedAt) ?? Date.now(),
      content: stringValue(event.content) ?? current.content,
      contentSegments: normalizeContentSegments(event.contentSegments) ?? current.contentSegments,
      reasoning: normalizeReasoning(event.reasoning) ?? current.reasoning,
      attachments: Array.isArray(event.attachments)
        ? event.attachments as AgentCallReasoningEntry["attachments"]
        : current.attachments,
      error: stringValue(event.error) ?? current.error,
      thinkingDuration: numberValue(event.thinkingDuration) ?? current.thinkingDuration,
    }
    return {
      ...state,
      mode: doneAgent.content ? "content" : state.mode,
      agent: doneAgent,
    }
  }

  return { ...state, agent: current }
}

function createPlaceholderAgent(runId: string): AgentCallReasoningEntry {
  return {
    type: "agent_call",
    id: `agent_${runId}`,
    phase: 0,
    runId,
    agentId: "researcher",
    agentName: "Researcher",
    kind: "text",
    title: "Researcher",
    prompt: "",
    status: "running",
    startedAt: Date.now(),
    content: "",
    contentSegments: [],
    reasoning: [],
  }
}

function appendAgentThought(entry: AgentCallReasoningEntry, chunk: string, phase: number): AgentCallReasoningEntry {
  const reasoning = [...(entry.reasoning ?? [])]
  const last = reasoning[reasoning.length - 1]
  if (last?.type === "thought" && last.phase === phase) {
    reasoning[reasoning.length - 1] = { ...last, content: last.content + chunk }
  } else {
    reasoning.push({
      type: "thought",
      id: `thought_${reasoning.length + 1}`,
      phase,
      content: chunk,
    })
  }
  return { ...entry, reasoning }
}

function appendAgentContent(entry: AgentCallReasoningEntry, chunk: string, phase: number): AgentCallReasoningEntry {
  const contentSegments = [...(entry.contentSegments ?? [])]
  const last = contentSegments[contentSegments.length - 1]
  if (last && last.phase === phase) contentSegments[contentSegments.length - 1] = { ...last, content: last.content + chunk }
  else contentSegments.push({ phase, content: chunk })
  return { ...entry, content: entry.content + chunk, contentSegments }
}

function updateAgentTool(
  entry: AgentCallReasoningEntry,
  toolCallId: string,
  updater: (entry: ToolCallReasoningEntry) => ToolCallReasoningEntry
): AgentCallReasoningEntry {
  return {
    ...entry,
    reasoning: (entry.reasoning ?? []).map(item =>
      item.type === "tool_call" && item.toolCallId === toolCallId ? updater(item) : item
    ),
  }
}

// The researcher's *answer* is a machine JSON payload (status/fields/sources).
// We never want to dump that — raw or half-streamed — into the transcript;
// the green result block already conveys the outcome. Strip fenced blocks and
// the JSON blob, keeping only any human-readable narrative. (The separate
// `reasoning` array — the model's thinking and tool calls — is untouched and
// still shows what the researcher is doing.)
function stripResearchJson(content: string): string {
  let s = content
    .replace(/```[\s\S]*?```/g, "")          // closed code fences
    .replace(/```[a-zA-Z]*[\s\S]*$/g, "")     // an open (still streaming) fence and everything after it
  const firstBrace = s.search(/[{[]/)
  if (firstBrace !== -1) {
    const tail = s.slice(firstBrace).trim()
    if (/^[{[]/.test(tail) || /"(status|fields|sources|unresolved|pricing|contextWindow|capabilities|kinds)"\s*:/.test(tail)) {
      // Everything from the first brace on is the (possibly partial) payload —
      // and any trailing notes after it are noise here too.
      s = s.slice(0, firstBrace)
    }
  }
  return s.trim()
}

function normalizeAgentTranscript(agent: AgentCallReasoningEntry): { content: string; contentSegments: ContentSegment[] } {
  const cleaned = stripResearchJson(agent.content)
  const segments = (agent.contentSegments ?? [])
    .map(seg => ({ ...seg, content: stripResearchJson(seg.content) }))
    .filter(seg => seg.content.trim().length > 0)
  return {
    content: cleaned,
    contentSegments: segments.length > 0
      ? segments
      : (cleaned ? [{ phase: 0, content: cleaned }] : []),
  }
}

function inferStreamingMode(agent: AgentCallReasoningEntry): "reasoning" | "content" {
  const lastReasoning = agent.reasoning?.at(-1)
  if (lastReasoning?.type === "tool_call" && lastReasoning.status === "running") return "reasoning"
  if (agent.content.length > 0) return "content"
  return "reasoning"
}

function elapsedSeconds(startedAt: number): number {
  return Math.max(0, Math.round((Date.now() - startedAt) / 1000))
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
}

function ResearchStatusDot({ status }: { status: ResearchRunStatus }) {
  return (
    <span
      className={cn(
        "mt-1 size-2.5 shrink-0 rounded-full",
        status === "running" && "animate-pulse bg-blue-500",
        status === "updated" && "bg-emerald-500",
        status === "unchanged" && "bg-foreground/25",
        status === "incomplete" && "bg-amber-500",
        status === "failed" && "bg-destructive",
        status === "stopped" && "bg-foreground/35"
      )}
    />
  )
}

function ResearchStatusPill({ status }: { status: ResearchRunStatus }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[11.5px] font-medium capitalize",
        status === "running" && "bg-blue-500/10 text-blue-700 dark:text-blue-300",
        status === "updated" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        status === "unchanged" && "bg-muted text-foreground/55",
        status === "incomplete" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
        status === "failed" && "bg-destructive/10 text-destructive",
        status === "stopped" && "bg-muted text-foreground/55"
      )}
    >
      {status}
    </span>
  )
}

function ModelStatusDot({ status }: { status: ModelMetadataStatus }) {
  return (
    <span
      className={cn(
        "mt-1 size-2.5 shrink-0 rounded-full",
        status === "complete" ? "bg-emerald-500" : "bg-amber-500"
      )}
    />
  )
}

function ModelStatusPill({ status }: { status: ModelMetadataStatus }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[11.5px] font-medium capitalize",
        status === "complete" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
      )}
    >
      {status}
    </span>
  )
}

function summarizeModelStatuses(models: CurrentModelResearchStatus[]): { complete: number; incomplete: number } {
  let complete = 0
  let incomplete = 0
  for (const model of models) {
    if (model.status === "incomplete") incomplete += 1
    else complete += 1
  }
  return { complete, incomplete }
}

function normalizeToolDelta(value: unknown): ToolStreamDelta | null {
  const delta = objectValue(value)
  const text = stringValue(delta?.text)
  const stream = stringValue(delta?.stream)
  if (!text || !stream) return null
  return {
    stream: (stream === "stdout" || stream === "stderr" || stream === "pty" || stream === "message") ? stream : "message",
    text,
    timestamp: numberValue(delta?.timestamp),
  }
}

function normalizeToolResult(value: unknown): { content: string; success?: boolean } {
  const result = objectValue(value)
  const success = typeof result?.success === "boolean" ? result.success : undefined
  if (success === false) return { content: `Error: ${String(result?.error ?? "Tool failed")}`, success }
  const data = result?.data
  if (typeof data === "string") return { content: data, success }
  if (data && typeof data === "object") return { content: JSON.stringify(data, null, 2), success }
  return { content: String(data ?? result?.content ?? ""), success }
}

function normalizeAgentKind(value: unknown): AgentKind {
  const kind = stringValue(value)
  return kind === "image" || kind === "video" || kind === "speech" || kind === "music" || kind === "concierge" || kind === "phone" || kind === "android"
    ? kind
    : "text"
}

function normalizeAgentStatus(value: unknown): AgentCallReasoningEntry["status"] {
  return value === "ok" || value === "error" || value === "aborted" || value === "running" ? value : "ok"
}

function normalizeContentSegments(value: unknown): ContentSegment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const segments = value.filter(item => {
    const segment = objectValue(item)
    return typeof segment?.phase === "number" && typeof segment?.content === "string"
  }) as ContentSegment[]
  return segments.length > 0 ? segments : undefined
}

function normalizeReasoning(value: unknown): ReasoningEntry[] | undefined {
  return Array.isArray(value) ? value as ReasoningEntry[] : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function formatMissingFields(fields: string[]): string {
  const labels: Record<string, string> = {
    pricing: "pricing",
    contextWindow: "context size",
    maxOutputTokens: "max output",
    knowledgeCutoff: "knowledge cutoff",
    thinkingLevels: "thinking levels",
    defaultThinkingLevel: "default thinking",
  }
  return fields.map(field => labels[field] ?? field).join(", ")
}
