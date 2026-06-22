"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"
import { ChevronRight, Dumbbell, Timer } from "lucide-react"

import {
  ACTIVE_WORKOUT_EVENT,
  type ActiveWorkoutSummary,
  readActiveWorkoutSummary,
} from "@/lib/workout/active-workout"
import { cn } from "@/lib/utils"

function formatClock(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec))
  const minutes = Math.floor(sec / 60)
  const seconds = sec % 60
  if (minutes < 60) return `${minutes}:${seconds.toString().padStart(2, "0")}`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}:${remainingMinutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
}

function statusLabel(summary: ActiveWorkoutSummary, now: number): string {
  if (summary.rest) {
    const remainingSec = (summary.rest.endsAt - now) / 1000
    return remainingSec > 0
      ? `Rest ${formatClock(remainingSec)}`
      : "Rest done"
  }

  if (summary.activeSet) {
    if (summary.activeSet.finishedAt) return "Save current set"
    return `Set ${formatClock((now - summary.activeSet.startedAt) / 1000)}`
  }

  return "Workout active"
}

function detailLabel(summary: ActiveWorkoutSummary): string {
  const timed = summary.rest ?? summary.activeSet
  if (!timed) return summary.title
  return `${timed.exerciseName} · set ${timed.setIndex + 1}`
}

export function ActiveWorkoutFloatingButton() {
  const router = useRouter()
  const pathname = usePathname()
  const [summary, setSummary] = React.useState<ActiveWorkoutSummary | null>(null)
  const [now, setNow] = React.useState(0)

  React.useEffect(() => {
    const refresh = () => {
      setSummary(readActiveWorkoutSummary())
      setNow(Date.now())
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key && !event.key.startsWith("workout:active:")) return
      refresh()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh()
    }

    refresh()
    window.addEventListener(ACTIVE_WORKOUT_EVENT, refresh)
    window.addEventListener("storage", onStorage)
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.removeEventListener(ACTIVE_WORKOUT_EVENT, refresh)
      window.removeEventListener("storage", onStorage)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [])

  const hasLiveTimer = Boolean(summary?.rest || summary?.activeSet)
  React.useEffect(() => {
    if (!hasLiveTimer) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [hasLiveTimer])

  if (!summary) return null

  const targetPath = `/artifact/${encodeURIComponent(summary.artifactId)}`
  if (pathname === targetPath) return null

  const status = statusLabel(summary, now)
  const detail = detailLabel(summary)

  return (
    <button
      type="button"
      onClick={() => router.push(targetPath)}
      className={cn(
        "fixed right-4 z-[70] flex max-w-[min(21rem,calc(100vw-2rem))] items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-2 text-left text-foreground shadow-lg transition-colors hover:bg-muted",
        "bottom-[calc(1rem+env(safe-area-inset-bottom))]"
      )}
      aria-label={`Return to active workout: ${summary.title}`}
      title={`Return to active workout: ${summary.title}`}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        {summary.rest ? <Timer className="size-4" /> : <Dumbbell className="size-4" />}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[13px] font-medium">{status}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}
