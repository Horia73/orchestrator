"use client"

import * as React from "react"
import { ChevronDown, Loader2, Square } from "lucide-react"
import type { BackgroundJobApiRow } from "@/lib/background-jobs-api"
import { cn } from "@/lib/utils"

// Running tracked background jobs for the open conversation, surfaced as a
// muted tray row above the composer (same visual family as the pending
// follow-ups tray). While a job runs the transcript shows nothing — this is
// the live handle: expand for the command, elapsed time, log tail, and Stop.
// Completion itself is announced by the server-authored notice card, so the
// chip simply disappears once no jobs are running.

const POLL_INTERVAL_MS = 8_000
const LOG_TAIL_CHARS = 8_000

function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000))
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes - hours * 60}m`
}

export function BackgroundJobsChip({ conversationId }: { conversationId: string | null }) {
  const [jobs, setJobs] = React.useState<BackgroundJobApiRow[]>([])
  const [open, setOpen] = React.useState(false)
  const [now, setNow] = React.useState(() => Date.now())
  const [logJobId, setLogJobId] = React.useState<string | null>(null)
  const [logTail, setLogTail] = React.useState<string>("")
  const [stoppingIds, setStoppingIds] = React.useState<ReadonlySet<string>>(new Set())

  const refresh = React.useCallback(async () => {
    if (!conversationId) return
    try {
      const res = await fetch(
        `/api/background-jobs?conversationId=${encodeURIComponent(conversationId)}&runningOnly=1`,
        { cache: "no-store" }
      )
      if (!res.ok) return
      const json = (await res.json()) as { jobs?: BackgroundJobApiRow[] }
      setJobs(Array.isArray(json.jobs) ? json.jobs : [])
      setNow(Date.now())
    } catch {
      // Transient fetch failure — keep the last known state; next tick retries.
    }
  }, [conversationId])

  React.useEffect(() => {
    setJobs([])
    setOpen(false)
    setLogJobId(null)
    if (!conversationId) return
    void refresh()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [conversationId, refresh])

  const openLog = React.useCallback(async (jobId: string) => {
    setLogJobId((current) => (current === jobId ? null : jobId))
    setLogTail("")
    try {
      const res = await fetch(
        `/api/background-jobs/${encodeURIComponent(jobId)}/log?chars=${LOG_TAIL_CHARS}`,
        { cache: "no-store" }
      )
      if (!res.ok) return
      const json = (await res.json()) as { tail?: string }
      setLogTail(typeof json.tail === "string" && json.tail ? json.tail : "(no output yet)")
    } catch {
      setLogTail("(could not load the log right now)")
    }
  }, [])

  const stopJob = React.useCallback(
    async (jobId: string) => {
      setStoppingIds((current) => new Set(current).add(jobId))
      try {
        await fetch(`/api/background-jobs/${encodeURIComponent(jobId)}/kill`, { method: "POST" })
        await refresh()
      } catch {
        // The next poll shows the real state either way.
      } finally {
        setStoppingIds((current) => {
          const next = new Set(current)
          next.delete(jobId)
          return next
        })
      }
    },
    [refresh]
  )

  if (!conversationId || jobs.length === 0) return null

  const oldest = jobs.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b))

  return (
    <section
      aria-label="Running background jobs"
      className="mb-2 overflow-hidden rounded-xl border border-border/60 bg-muted/80 shadow-sm backdrop-blur-sm"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
        aria-expanded={open}
      >
        <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
          {jobs.length === 1
            ? oldest.description || oldest.command
            : `${jobs.length} background jobs running`}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {formatElapsed(oldest.startedAt, now)}
        </span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/60 px-3.5 pt-2 pb-2.5">
          {jobs.map((job) => (
            <div key={job.id} className="text-[12px]">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  {job.description && (
                    <div className="truncate text-foreground">{job.description}</div>
                  )}
                  <div className="truncate font-mono text-[11px] text-muted-foreground" title={job.command}>
                    {job.command}
                  </div>
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {formatElapsed(job.startedAt, now)}
                </span>
                <button
                  type="button"
                  onClick={() => void openLog(job.id)}
                  className="shrink-0 rounded-md border border-border/70 px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Log
                </button>
                <button
                  type="button"
                  onClick={() => void stopJob(job.id)}
                  disabled={stoppingIds.has(job.id)}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-border/70 px-2 py-1.5 text-[11px] text-muted-foreground hover:text-destructive disabled:opacity-50"
                >
                  {stoppingIds.has(job.id) ? (
                    <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                  ) : (
                    <Square className="size-3" aria-hidden="true" />
                  )}
                  Stop
                </button>
              </div>
              {logJobId === job.id && (
                <pre className="tool-call-scroll mt-1.5 max-h-44 overflow-auto rounded-md border border-border/60 bg-background/80 p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap">
                  {logTail || "Loading log…"}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
