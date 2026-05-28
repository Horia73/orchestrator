"use client"

import * as React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  GitBranch,
  Loader2,
  RefreshCcw,
  RotateCw,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface ActiveRunInfo {
  conversationId: string
  messageId: string
  startedAt: number
}

interface CurrentInstallInfo {
  version: string
  commit: string | null
  branch: string | null
  dirty: boolean
}

interface LatestReleaseInfo {
  version: string
  tag: string
  name: string
  htmlUrl: string
  publishedAt: string | null
  body: string | null
  fallback?: boolean
}

type UpdatePhase = "idle" | "queued" | "updating" | "restarting" | "completed" | "failed"

interface UpdateJob {
  id: string
  phase: UpdatePhase
  targetVersion: string
  targetTag: string
  queuedAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
  failedAt?: number
  activeRunCount?: number
  waitReason?: string
  error?: string
  logPath?: string
}

interface UpdateStatus {
  current: CurrentInstallInfo
  latest: LatestReleaseInfo | null
  updateAvailable: boolean
  latestCheckedAt: number | null
  latestError: string | null
  activeRuns: ActiveRunInfo[]
  job: UpdateJob | null
  config: {
    repo: string
    idleGraceMs: number
    serviceManager: string | null
    managedInstall: boolean
    dockerHostUpdater: boolean
  }
}

const ACTIVE_PHASES = new Set<UpdatePhase>(["queued", "updating", "restarting"])

type FactoryResetScope = "chat" | "automations" | "memory" | "integrations" | "env"

const DEFAULT_RESET_SCOPES: FactoryResetScope[] = ["chat", "automations", "memory", "integrations"]

const RESET_SCOPE_OPTIONS: Array<{
  id: FactoryResetScope
  label: string
  description: string
  destructive?: boolean
}> = [
  {
    id: "chat",
    label: "Chat, inbox & logs",
    description: "Conversations, messages, generated artifacts, uploads, agent threads, and activity logs.",
  },
  {
    id: "automations",
    label: "Automations & saved data",
    description: "Scheduled tasks, push subscriptions, Smart Monitor watches, watchlist data, and saved map places.",
  },
  {
    id: "memory",
    label: "Memory",
    description: "USER.md, MEMORY.md, daily memory, onboarding state, and monitor notes.",
  },
  {
    id: "integrations",
    label: "Integration sessions",
    description: "OAuth tokens, WhatsApp session files, browser-agent profile state, and private integration state.",
  },
  {
    id: "env",
    label: ".env.local",
    description: "Provider keys, service URLs, OAuth client secrets, and local runtime config.",
    destructive: true,
  },
]

function formatDate(value: string | number | null | undefined) {
  if (!value) return "Never"
  const date = typeof value === "number" ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return "Unknown"
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function phaseLabel(phase: UpdatePhase | null | undefined) {
  if (!phase) return "Idle"
  if (phase === "queued") return "Queued"
  if (phase === "updating") return "Updating"
  if (phase === "restarting") return "Restarting"
  if (phase === "completed") return "Completed"
  if (phase === "failed") return "Failed"
  return "Idle"
}

function statusTone(status: UpdateStatus | null) {
  if (!status) return "muted"
  if (status.job?.phase === "failed") return "error"
  if (status.job && ACTIVE_PHASES.has(status.job.phase)) return "busy"
  if (status.updateAvailable) return "available"
  return "ok"
}

const UPDATE_LOG_MAX_LINES = 500

function UpdateLogTerminal({ jobId }: { jobId: string }) {
  const [lines, setLines] = React.useState<string[]>([])
  const [connection, setConnection] = React.useState<"connecting" | "live" | "error">(
    "connecting"
  )
  const scrollRef = React.useRef<HTMLPreElement | null>(null)
  const userScrolledUpRef = React.useRef(false)

  React.useEffect(() => {
    setLines([])
    setConnection("connecting")

    const source = new EventSource("/api/update/log")

    const handleOpen = () => setConnection((c) => (c === "error" ? c : "live"))
    const handleReady = () => setConnection("live")
    const handleLog = (event: MessageEvent) => {
      const data = typeof event.data === "string" ? event.data : String(event.data ?? "")
      setLines((prev) => {
        const next = prev.length >= UPDATE_LOG_MAX_LINES
          ? [...prev.slice(prev.length - UPDATE_LOG_MAX_LINES + 1), data]
          : [...prev, data]
        return next
      })
    }
    const handleError = () => {
      // EventSource auto-reconnects on transient drops; surface the state but
      // do not tear the stream down. The browser will retry with
      // Last-Event-ID so we resume from the byte offset we already received.
      setConnection("error")
    }

    source.addEventListener("open", handleOpen)
    source.addEventListener("ready", handleReady)
    source.addEventListener("log", handleLog)
    source.addEventListener("error", handleError)

    return () => {
      source.removeEventListener("open", handleOpen)
      source.removeEventListener("ready", handleReady)
      source.removeEventListener("log", handleLog)
      source.removeEventListener("error", handleError)
      source.close()
    }
  }, [jobId])

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (userScrolledUpRef.current) return
    el.scrollTop = el.scrollHeight
  }, [lines])

  const handleScroll = React.useCallback((event: React.UIEvent<HTMLPreElement>) => {
    const el = event.currentTarget
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
    userScrolledUpRef.current = distanceFromBottom > 16
  }, [])

  const indicatorLabel =
    connection === "live" ? "live" : connection === "error" ? "reconnecting" : "connecting"
  const indicatorDot =
    connection === "live"
      ? "bg-emerald-500"
      : connection === "error"
        ? "bg-amber-500"
        : "bg-foreground/30"

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border/60 bg-foreground/[0.025] dark:bg-white/[0.03]">
      <div className="flex items-center justify-between border-b border-border/60 px-2.5 py-1 text-[11px] font-medium tracking-wider text-foreground/45 uppercase">
        <span>Host updater log</span>
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "size-1.5 rounded-full",
              indicatorDot,
              connection === "connecting" && "animate-pulse"
            )}
          />
          <span className="text-[10.5px]">{indicatorLabel}</span>
        </span>
      </div>
      <pre
        ref={scrollRef}
        onScroll={handleScroll}
        className="max-h-64 min-h-[8rem] overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-5 text-foreground/75 whitespace-pre-wrap break-words"
      >
        {lines.length === 0 ? (
          <span className="text-foreground/40 italic">Waiting for output...</span>
        ) : (
          lines.join("\n")
        )}
      </pre>
    </div>
  )
}

export function UpdateTab() {
  const [status, setStatus] = React.useState<UpdateStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [checking, setChecking] = React.useState(false)
  const [updating, setUpdating] = React.useState(false)
  const [resetting, setResetting] = React.useState(false)
  const [resetModalOpen, setResetModalOpen] = React.useState(false)
  const [resetConfirmText, setResetConfirmText] = React.useState("")
  const [resetScopes, setResetScopes] = React.useState<FactoryResetScope[]>(DEFAULT_RESET_SCOPES)
  const [error, setError] = React.useState<string | null>(null)
  const [resetMessage, setResetMessage] = React.useState<string | null>(null)
  const [memoryBusy, setMemoryBusy] = React.useState<"export" | "import" | null>(null)
  const [memoryMessage, setMemoryMessage] = React.useState<{ tone: "success" | "error"; text: string } | null>(null)
  const [cliBusy, setCliBusy] = React.useState<"update" | "restart" | null>(null)
  const [cliMessage, setCliMessage] = React.useState<{ tone: "success" | "error"; text: string } | null>(null)
  const memoryImportInputRef = React.useRef<HTMLInputElement | null>(null)

  const loadStatus = React.useCallback(async (refresh = false) => {
    const res = await fetch(`/api/update/status${refresh ? "?refresh=1" : ""}`, { cache: "no-store" })
    if (!res.ok) throw new Error(`Failed to load update status (${res.status})`)
    return (await res.json()) as UpdateStatus
  }, [])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadStatus()
      .then(next => {
        if (cancelled) return
        setStatus(next)
        setError(null)
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load update status.")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadStatus])

  React.useEffect(() => {
    if (!status?.job || !ACTIVE_PHASES.has(status.job.phase)) return
    const timer = setInterval(() => {
      loadStatus()
        .then(next => {
          setStatus(next)
          setError(null)
        })
        .catch(err => setError(err instanceof Error ? err.message : "Failed to refresh update status."))
    }, 2000)
    return () => clearInterval(timer)
  }, [loadStatus, status?.job])

  const handleCheck = async () => {
    setChecking(true)
    try {
      const next = await loadStatus(true)
      setStatus(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check for updates.")
    } finally {
      setChecking(false)
    }
  }

  const handleUpdate = async () => {
    setUpdating(true)
    try {
      const res = await fetch("/api/update/apply", { method: "POST", cache: "no-store" })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || `Failed to queue update (${res.status})`)
      setStatus(json as UpdateStatus)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue update.")
    } finally {
      setUpdating(false)
    }
  }

  const handleCliUpdate = async () => {
    setCliBusy("update")
    setCliMessage(null)
    try {
      const res = await fetch("/api/update/cli", { method: "POST", cache: "no-store" })
      const json = await res.json().catch(() => null) as { ok?: boolean; versions?: string; error?: string } | null
      if (!res.ok || !json?.ok) throw new Error(json?.error || `CLI update failed (${res.status})`)
      const versions = json.versions ? ` — ${json.versions.replace(/\n+/g, " · ")}` : ""
      setCliMessage({ tone: "success", text: `CLIs updated${versions}. Container is restarting — give it a moment.` })
    } catch (err) {
      setCliMessage({ tone: "error", text: err instanceof Error ? err.message : "CLI update failed." })
    } finally {
      setCliBusy(null)
    }
  }

  const handleContainerRestart = async () => {
    setCliBusy("restart")
    setCliMessage(null)
    try {
      const res = await fetch("/api/update/restart", { method: "POST", cache: "no-store" })
      const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Restart failed (${res.status})`)
      setCliMessage({ tone: "success", text: "Container is restarting — give it a moment, then reload." })
    } catch (err) {
      setCliMessage({ tone: "error", text: err instanceof Error ? err.message : "Restart failed." })
    } finally {
      setCliBusy(null)
    }
  }

  const toggleResetScope = React.useCallback((scope: FactoryResetScope) => {
    setResetScopes(current => (
      current.includes(scope)
        ? current.filter(item => item !== scope)
        : [...current, scope]
    ))
  }, [])

  const handleFactoryReset = async () => {
    if (resetConfirmText.trim().toLowerCase() !== "delete") return
    if (resetScopes.length === 0) return

    setResetting(true)
    setResetMessage(null)
    try {
      const res = await fetch("/api/settings/factory-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          confirm: "factory-reset",
          scopes: resetScopes,
          preserveEnvLocal: !resetScopes.includes("env"),
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || `Factory reset failed (${res.status})`)
      setResetMessage(`Reset complete: ${formatScopeSummary(resetScopes)}. Reloading.`)
      setResetModalOpen(false)
      window.setTimeout(() => window.location.assign("/"), 800)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Factory reset failed.")
    } finally {
      setResetting(false)
    }
  }

  const openFactoryReset = () => {
    setResetConfirmText("")
    setResetScopes(DEFAULT_RESET_SCOPES)
    setResetModalOpen(true)
  }

  const handleMemoryExport = async () => {
    setMemoryBusy("export")
    setMemoryMessage(null)
    try {
      const res = await fetch("/api/settings/memory/export", { cache: "no-store" })
      const text = await res.text()
      if (!res.ok) {
        const parsed = parseJsonObject(text)
        throw new Error(parsed?.error || `Memory export failed (${res.status})`)
      }
      const blob = new Blob([text], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = filenameFromContentDisposition(res.headers.get("content-disposition")) ?? `orchestrator-memory-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setMemoryMessage({ tone: "success", text: "Memory export downloaded." })
    } catch (err) {
      setMemoryMessage({ tone: "error", text: err instanceof Error ? err.message : "Memory export failed." })
    } finally {
      setMemoryBusy(null)
    }
  }

  const handleMemoryImportFile = async (file: File | null | undefined) => {
    if (!file) return
    setMemoryBusy("import")
    setMemoryMessage(null)
    try {
      const text = await file.text()
      const bundle = JSON.parse(text) as unknown
      const count = bundle && typeof bundle === "object" && Array.isArray((bundle as { files?: unknown }).files)
        ? (bundle as { files: unknown[] }).files.length
        : null
      const ok = window.confirm(
        count === null
          ? "Import this memory file and replace matching local memory files?"
          : `Import ${count} memory file${count === 1 ? "" : "s"} and replace matching local memory files?`
      )
      if (!ok) return

      const res = await fetch("/api/settings/memory/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(bundle),
      })
      const json = await res.json().catch(() => null) as { importedFiles?: unknown[]; error?: string } | null
      if (!res.ok) throw new Error(json?.error || `Memory import failed (${res.status})`)
      setMemoryMessage({
        tone: "success",
        text: `Imported ${json?.importedFiles?.length ?? count ?? 0} memory file${(json?.importedFiles?.length ?? count ?? 0) === 1 ? "" : "s"}.`,
      })
    } catch (err) {
      setMemoryMessage({ tone: "error", text: err instanceof Error ? err.message : "Memory import failed." })
    } finally {
      setMemoryBusy(null)
      if (memoryImportInputRef.current) memoryImportInputRef.current.value = ""
    }
  }

  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-[180px] animate-pulse rounded-2xl border border-border/60 bg-muted/40" />
        <div className="h-[180px] animate-pulse rounded-2xl border border-border/60 bg-muted/40" />
      </div>
    )
  }

  const tone = statusTone(status)
  const activeJob = status?.job && ACTIVE_PHASES.has(status.job.phase) ? status.job : null
  const updateDisabled = updating || Boolean(activeJob) || !status?.updateAvailable || status.current.dirty || !status.config.managedInstall
  const serviceLabel = status?.config.serviceManager === "docker" && status.config.dockerHostUpdater
    ? "Docker + host updater"
    : status?.config.serviceManager ?? "Manual"

  return (
    <div className="flex flex-col gap-4">
      <FactoryResetModal
        open={resetModalOpen}
        value={resetConfirmText}
        resetting={resetting}
        selectedScopes={resetScopes}
        onChange={setResetConfirmText}
        onToggleScope={toggleResetScope}
        onClose={() => {
          if (!resetting) setResetModalOpen(false)
        }}
        onConfirm={handleFactoryReset}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground/85">Updates</h2>
          <p className="mt-0.5 text-[12.5px] text-foreground/50">
            {status?.config.repo ?? "GitHub"} releases power managed app updates.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleCheck} disabled={checking || updating}>
            {checking ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCcw className="size-3.5" />}
            Check
          </Button>
          <Button size="sm" onClick={handleUpdate} disabled={updateDisabled}>
            {updating ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            Update
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-[13px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <Card className="rounded-xl">
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-[15px]">Status</CardTitle>
            <p className="mt-1 text-[12.5px] text-foreground/55">
              Last checked {formatDate(status?.latestCheckedAt)}
            </p>
          </div>
          <StatusBadge tone={tone} status={status} />
        </CardHeader>
        <CardContent className="gap-4">
          <div className="grid gap-3 md:grid-cols-3">
            <InfoTile label="Installed" value={`v${status?.current.version ?? "0.0.0"}`} icon={GitBranch} />
            <InfoTile
              label="Latest"
              value={status?.latest ? status.latest.tag : "No release"}
              icon={status?.updateAvailable ? Download : CheckCircle2}
            />
            <InfoTile
              label="Active AI"
              value={String(status?.activeRuns.length ?? 0)}
              icon={(status?.activeRuns.length ?? 0) > 0 ? Loader2 : Clock3}
              spin={(status?.activeRuns.length ?? 0) > 0}
            />
          </div>

          {status?.current.dirty && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12.5px] text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>Local file changes block managed updates.</span>
            </div>
          )}

          {status && !status.config.managedInstall && (
            <div className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 text-[12.5px] text-foreground/55">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {status.config.serviceManager === "docker"
                  ? "Docker one-click updates need the installer host update bridge. Re-run the installer on the server or run `orchestrator update` there."
                  : "Managed installer service is required for one-click restart."}
              </span>
            </div>
          )}

          {status?.latestError && (
            <div className="rounded-xl border border-border/60 bg-muted/35 px-3 py-2.5 text-[12.5px] text-foreground/60">
              {status.latestError}
            </div>
          )}

          {status?.job && (
            <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {ACTIVE_PHASES.has(status.job.phase) ? (
                    <Loader2 className="size-3.5 animate-spin text-primary" />
                  ) : status.job.phase === "failed" ? (
                    <AlertTriangle className="size-3.5 text-destructive" />
                  ) : (
                    <CheckCircle2 className="size-3.5 text-emerald-600" />
                  )}
                  <span className="text-[13px] font-medium text-foreground/80">
                    {phaseLabel(status.job.phase)} {status.job.targetTag}
                  </span>
                </div>
                <span className="font-mono text-[11.5px] text-foreground/45">{status.job.id.slice(0, 8)}</span>
              </div>
              {status.job.waitReason && (
                <p className="mt-2 text-[12.5px] text-foreground/55">{status.job.waitReason}</p>
              )}
              {status.job.error && (
                <p className="mt-2 text-[12.5px] text-destructive">{status.job.error}</p>
              )}
              {ACTIVE_PHASES.has(status.job.phase) &&
                status.config.serviceManager === "docker" && (
                  <UpdateLogTerminal jobId={status.job.id} />
                )}
            </div>
          )}
        </CardContent>
      </Card>

      {status?.config.serviceManager === "docker" && status.config.dockerHostUpdater && (
        <Card className="rounded-xl">
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle className="text-[15px]">CLI tools</CardTitle>
              <p className="mt-1 text-[12.5px] text-foreground/55">
                Claude Code and Codex live in a mounted volume, so app updates never refresh them.
                Update them in place (this restarts the container), or restart the container on its own.
              </p>
            </div>
            <TerminalIcon className="size-4 shrink-0 text-foreground/45" />
          </CardHeader>
          <CardContent className="gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={handleCliUpdate}
                disabled={cliBusy !== null || Boolean(activeJob)}
              >
                {cliBusy === "update" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                Update CLIs
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleContainerRestart}
                disabled={cliBusy !== null || Boolean(activeJob)}
              >
                {cliBusy === "restart" ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
                Restart container
              </Button>
            </div>
            {cliMessage && (
              <div
                className={cn(
                  "rounded-xl border px-3 py-2.5 text-[12.5px]",
                  cliMessage.tone === "success"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
                    : "border-destructive/30 bg-destructive/5 text-destructive"
                )}
              >
                {cliMessage.text}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle className="text-[15px]">Installed Build</CardTitle>
          </CardHeader>
          <CardContent>
            <DetailRow label="Version" value={`v${status?.current.version ?? "0.0.0"}`} />
            <DetailRow label="Commit" value={status?.current.commit ?? "Unknown"} mono />
            <DetailRow label="Branch" value={status?.current.branch || "Detached"} mono />
            <DetailRow label="Service" value={serviceLabel} />
          </CardContent>
        </Card>

        <Card className="rounded-xl">
          <CardHeader className="flex-row items-start justify-between gap-3">
            <CardTitle className="text-[15px]">Latest Release</CardTitle>
            {status?.latest?.htmlUrl && (
              <Button variant="ghost" size="icon-sm" asChild title="Open release">
                <a href={status.latest.htmlUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <DetailRow label="Version" value={status?.latest?.tag ?? "No release"} />
            <DetailRow label="Published" value={formatDate(status?.latest?.publishedAt)} />
            {status?.latest?.fallback && <DetailRow label="Source" value="Installed fallback" />}
            {status?.latest?.body ? (
              <ReleaseNotesMarkdown content={status.latest.body} />
            ) : (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-8 text-center text-[12.5px] text-foreground/45">
                No release notes.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {status?.activeRuns.length ? (
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle className="text-[15px]">Active Runs</CardTitle>
          </CardHeader>
          <CardContent className="gap-2">
            {status.activeRuns.map(run => (
              <div
                key={`${run.conversationId}:${run.messageId}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/25 px-3 py-2"
              >
                <span className="font-mono text-[12px] text-foreground/70">{run.conversationId.slice(0, 8)}</span>
                <span className="text-[12px] text-foreground/45">Started {formatDate(run.startedAt)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {resetMessage && (
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[12.5px] text-emerald-700 dark:text-emerald-400">
          {resetMessage}
        </div>
      )}

      <div className="mt-2 border-t border-border/60 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-[13px] font-medium text-foreground/70">Danger zone</h3>
            <p className="mt-0.5 text-[12.5px] text-foreground/45">
              Reset selected local data, or move memory between Orchestrator installs.
            </p>
          </div>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-border/70 bg-card px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="text-[13px] font-medium text-foreground/75">Memory portability</h4>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-foreground/45">
                  Export or import USER, MEMORY, daily memory, onboarding, and monitor notes. Review exports before sharing.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleMemoryExport}
                  disabled={memoryBusy !== null}
                  aria-label="Export memory"
                >
                  {memoryBusy === "export" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                  Export
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => memoryImportInputRef.current?.click()}
                  disabled={memoryBusy !== null}
                  aria-label="Import memory"
                >
                  {memoryBusy === "import" ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
                  Import
                </Button>
                <input
                  ref={memoryImportInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={event => { void handleMemoryImportFile(event.target.files?.[0]) }}
                />
              </div>
            </div>
            {memoryMessage && (
              <p
                className={cn(
                  "mt-2 text-[12px]",
                  memoryMessage.tone === "success" ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"
                )}
              >
                {memoryMessage.text}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="text-[13px] font-medium text-destructive">Factory reset</h4>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-destructive/75">
                  Choose exactly which local data groups to clear before confirming.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={openFactoryReset}
                disabled={resetting}
                className="border-destructive/25 bg-background/70 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                {resetting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                Open reset
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function formatScopeSummary(scopes: FactoryResetScope[]): string {
  if (scopes.length === 0) return "nothing"
  return scopes
    .map(scope => RESET_SCOPE_OPTIONS.find(option => option.id === scope)?.label ?? scope)
    .join(", ")
}

function parseJsonObject(text: string): { error?: string } | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === "object" ? value as { error?: string } : null
  } catch {
    return null
  }
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(value)
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1].trim().replace(/^"|"$/g, ""))
  } catch {
    return match[1].trim().replace(/^"|"$/g, "")
  }
}

function ReleaseNotesMarkdown({ content }: { content: string }) {
  return (
    <div className="max-h-56 overflow-auto rounded-xl border border-border/60 bg-muted/20 px-3.5 py-3 text-[12.5px] leading-relaxed text-foreground/70">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h3 className="mb-2 text-[15px] font-semibold text-foreground">{children}</h3>,
          h2: ({ children }) => <h4 className="mb-1.5 mt-3 text-[14px] font-semibold text-foreground/85 first:mt-0">{children}</h4>,
          h3: ({ children }) => <h5 className="mb-1 mt-2.5 text-[13px] font-semibold text-foreground/80 first:mt-0">{children}</h5>,
          p: ({ children }) => <p className="my-1.5">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[11.5px] text-foreground/80">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-2 overflow-auto rounded-lg border border-border/60 bg-background p-2.5 text-[11.5px]">
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function FactoryResetModal({
  open,
  value,
  resetting,
  selectedScopes,
  onChange,
  onToggleScope,
  onClose,
  onConfirm,
}: {
  open: boolean
  value: string
  resetting: boolean
  selectedScopes: FactoryResetScope[]
  onChange: (value: string) => void
  onToggleScope: (scope: FactoryResetScope) => void
  onClose: () => void
  onConfirm: () => void
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const canConfirm = value.trim().toLowerCase() === "delete" && selectedScopes.length > 0

  React.useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/35 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-border/70 bg-card p-5 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
              <Trash2 className="size-4" />
            </span>
            <div>
              <h3 className="text-[16px] font-semibold text-foreground">Factory reset Orchestrator?</h3>
              <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/55">
                Select the local data groups to clear. Unchecked groups stay in place.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={resetting}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md p-0 text-foreground/45 transition-colors hover:bg-foreground/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {RESET_SCOPE_OPTIONS.map(scope => {
            const checked = selectedScopes.includes(scope.id)
            return (
              <label
                key={scope.id}
                className={cn(
                  "grid cursor-pointer grid-cols-[18px_minmax(0,1fr)] gap-2.5 rounded-xl border px-3 py-2.5 transition-colors",
                  checked
                    ? scope.destructive
                      ? "border-destructive/35 bg-destructive/5"
                      : "border-foreground/15 bg-muted/35"
                    : "border-border/60 bg-background/50 hover:bg-muted/30",
                  resetting && "pointer-events-none opacity-60"
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={resetting}
                  onChange={() => onToggleScope(scope.id)}
                  className="mt-0.5 size-4 accent-current"
                />
                <span className="min-w-0">
                  <span className={cn("block text-[13px] font-medium", scope.destructive ? "text-destructive" : "text-foreground/80")}>
                    {scope.label}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-foreground/50">
                    {scope.description}
                  </span>
                </span>
              </label>
            )
          })}
        </div>

        <div className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-[12.5px] leading-relaxed text-destructive">
          This action cannot be undone from the UI. Selected now: {selectedScopes.length > 0 ? formatScopeSummary(selectedScopes) : "nothing"}.
        </div>

        <label className="mt-4 block">
          <span className="text-[12px] font-medium uppercase tracking-wider text-foreground/50">
            Type delete to confirm
          </span>
          <input
            ref={inputRef}
            value={value}
            onChange={event => onChange(event.target.value)}
            disabled={resetting}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            className="mt-1.5 h-10 w-full rounded-lg border border-border bg-background px-3 font-mono text-[13px] text-foreground outline-none transition-shadow focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60"
            placeholder="delete"
          />
        </label>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={resetting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={!canConfirm || resetting}
          >
            {resetting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            Reset selected
          </Button>
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ tone, status }: { tone: string; status: UpdateStatus | null }) {
  const label = status?.job && ACTIVE_PHASES.has(status.job.phase)
    ? phaseLabel(status.job.phase)
    : status?.job?.phase === "failed"
      ? "Failed"
      : status?.updateAvailable
        ? "Available"
        : "Up to date"

  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium",
        tone === "ok" && "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        tone === "available" && "border-primary/25 bg-primary/10 text-primary",
        tone === "busy" && "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300",
        tone === "error" && "border-destructive/25 bg-destructive/10 text-destructive",
        tone === "muted" && "border-border bg-muted text-foreground/55"
      )}
    >
      {tone === "busy" ? <RotateCw className="size-3 animate-spin" /> : null}
      {tone === "ok" ? <CheckCircle2 className="size-3" /> : null}
      {tone === "error" ? <AlertTriangle className="size-3" /> : null}
      {label}
    </span>
  )
}

function InfoTile({
  label,
  value,
  icon: Icon,
  spin = false,
}: {
  label: string
  value: string
  icon: React.ComponentType<{ className?: string }>
  spin?: boolean
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background px-3 py-3">
      <div className="flex items-center gap-2 text-[12px] text-foreground/45">
        <Icon className={cn("size-3.5", spin && "animate-spin")} />
        {label}
      </div>
      <div className="mt-2 truncate font-mono text-[17px] font-semibold text-foreground/85">{value}</div>
    </div>
  )
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-b-0">
      <span className="text-[12.5px] text-foreground/45">{label}</span>
      <span className={cn("truncate text-right text-[12.5px] text-foreground/75", mono && "font-mono")}>{value}</span>
    </div>
  )
}
