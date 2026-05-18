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
  Trash2,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useConfirm } from "@/components/ui/confirm-dialog"

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

export function UpdateTab() {
  const [status, setStatus] = React.useState<UpdateStatus | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [checking, setChecking] = React.useState(false)
  const [updating, setUpdating] = React.useState(false)
  const [resetting, setResetting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [resetMessage, setResetMessage] = React.useState<string | null>(null)
  const { confirm, dialog } = useConfirm()

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

  const handleFactoryReset = async () => {
    const ok = await confirm({
      title: "Factory reset Orchestrator?",
      message: "This clears conversations, inbox, scheduled tasks, watchlist, uploads, artifacts, and workspace memory. Env secrets are preserved.",
      confirmLabel: "Factory reset",
      destructive: true,
    })
    if (!ok) return

    setResetting(true)
    setResetMessage(null)
    try {
      const res = await fetch("/api/settings/factory-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ confirm: "factory-reset", preserveEnvLocal: true }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || `Factory reset failed (${res.status})`)
      setResetMessage("Factory reset complete. Reloading initial workspace.")
      window.setTimeout(() => window.location.assign("/"), 800)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Factory reset failed.")
    } finally {
      setResetting(false)
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
      {dialog}
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
            </div>
          )}
        </CardContent>
      </Card>

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
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-xl border border-border/60 bg-muted/25 p-3 text-[12px] leading-relaxed text-foreground/65">
                {status.latest.body}
              </pre>
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

      <Card className="rounded-xl border-destructive/25">
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-[15px] text-destructive">Factory Reset</CardTitle>
            <p className="mt-1 text-[12.5px] text-foreground/55">
              Return the app data to first-run state while keeping installation env secrets.
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={handleFactoryReset}
            disabled={resetting}
          >
            {resetting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            Reset
          </Button>
        </CardHeader>
        {resetMessage && (
          <CardContent>
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[12.5px] text-emerald-700 dark:text-emerald-400">
              {resetMessage}
            </div>
          </CardContent>
        )}
      </Card>
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
