"use client"

import * as React from "react"
import { CalendarDays, CloudSun, Cog, Globe, Home, Mail, MessageSquare } from "lucide-react"

import type { WatchEvent, WatchSource } from "./types"

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

export function formatRelative(target: number | null, now: number): string {
  if (target == null) return "—"
  const diff = Math.round((target - now) / 1000)
  if (diff <= 0) return "due now"
  const d = Math.floor(diff / 86400)
  let rem = diff - d * 86400
  const h = Math.floor(rem / 3600)
  rem -= h * 3600
  const m = Math.floor(rem / 60)
  const s = rem - m * 60
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m && parts.length < 2) parts.push(`${m}m`)
  if (!d && !h && !m) parts.push(`${s}s`)
  return `in ${parts.slice(0, 2).join(" ")}`
}

export function formatPast(target: number | null, now: number): string {
  if (target == null) return "—"
  const diff = Math.round((now - target) / 1000)
  if (diff < 0) return "now"
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function formatCadence(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

export function sourceIcon(source: WatchSource, className = "size-4") {
  switch (source) {
    case "gmail":
      return <Mail className={className} />
    case "google_calendar":
      return <CalendarDays className={className} />
    case "whatsapp":
      return <MessageSquare className={className} />
    case "home_assistant":
      return <Home className={className} />
    case "web":
      return <Globe className={className} />
    case "weather":
      return <CloudSun className={className} />
    case "custom":
      return <Cog className={className} />
  }
}

export function sourceLabel(source: WatchSource): string {
  switch (source) {
    case "gmail":
      return "Gmail"
    case "google_calendar":
      return "Google Calendar"
    case "whatsapp":
      return "WhatsApp"
    case "home_assistant":
      return "Home Assistant"
    case "web":
      return "Web"
    case "weather":
      return "Weather"
    case "custom":
      return "Model-owned"
  }
}

export function eventKindBadgeClass(kind: WatchEvent["kind"]): string {
  switch (kind) {
    case "match":
    case "notify":
    case "wake":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
    case "suppress":
      return "bg-slate-100 text-slate-700 dark:bg-slate-900/60 dark:text-slate-300"
    case "feedback":
      return "bg-indigo-100 text-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-300"
    case "action":
      return "bg-purple-100 text-purple-900 dark:bg-purple-950/40 dark:text-purple-300"
    case "error":
      return "bg-red-100 text-red-900 dark:bg-red-950/40 dark:text-red-300"
    case "cadence_change":
      return "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
    case "followup":
      return "bg-sky-100 text-sky-900 dark:bg-sky-950/40 dark:text-sky-300"
    case "user_signal":
      return "bg-teal-100 text-teal-900 dark:bg-teal-950/40 dark:text-teal-300"
    case "check":
    default:
      return "bg-foreground/5 text-foreground/55"
  }
}

export async function asError(res: Response): Promise<string> {
  try {
    const data = await res.json()
    return typeof data?.error === "string"
      ? data.error
      : `Request failed (${res.status})`
  } catch {
    return `Request failed (${res.status})`
  }
}
