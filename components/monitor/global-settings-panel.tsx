"use client"

import * as React from "react"
import { Check, Loader2, Moon, X } from "lucide-react"

import { Switch } from "@/components/ui/switch"

import { asError } from "./helpers"
import type { MonitorSettings } from "./types"

const SYSTEM_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
})()

export function GlobalSettingsPanel({
  open,
  onClose,
  onChanged,
}: {
  open: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const [settings, setSettings] = React.useState<MonitorSettings | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [enabled, setEnabled] = React.useState(false)
  const [from, setFrom] = React.useState("23:00")
  const [to, setTo] = React.useState("07:00")
  const [timezone, setTimezone] = React.useState(SYSTEM_TZ)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch("/api/monitor/settings", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await asError(res))
        return res.json()
      })
      .then((data: { settings: MonitorSettings }) => {
        if (cancelled) return
        setSettings(data.settings)
        if (data.settings.quietHours) {
          setEnabled(true)
          setFrom(data.settings.quietHours.from)
          setTo(data.settings.quietHours.to)
          setTimezone(data.settings.quietHours.timezone)
        } else {
          setEnabled(false)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Load failed")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const body = enabled
        ? { quietHours: { from, to, timezone } }
        : { quietHours: null }
      const res = await fetch("/api/monitor/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(await asError(res))
      onChanged()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed")
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="border-b border-border/60 bg-[#f0ede6]/50 px-5 py-4 dark:bg-muted/40">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Moon className="size-4 text-foreground/55" />
          <h3 className="text-[14px] font-semibold">Global quiet hours</h3>
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-foreground/55 hover:bg-background"
          title="Close"
        >
          <X className="size-4" />
        </button>
      </div>

      {loading ? (
        <div className="flex h-10 items-center gap-2 text-[12px] text-foreground/55">
          <Loader2 className="size-3 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <p className="mb-3 text-[12px] text-foreground/65">
            When active, Smart Monitor still records matches in each watch&apos;s audit log but does NOT wake the orchestrator (so you don&apos;t get an Inbox ping). Per-watch quiet hours override this default.
          </p>

          <div className="mb-3 flex items-center gap-2">
            <Switch
              checked={enabled}
              disabled={busy}
              onCheckedChange={setEnabled}
              aria-label="Enable global quiet hours"
            />
            <span className="text-[13px]">
              {enabled ? "Enabled" : "Disabled (no global quiet hours)"}
            </span>
          </div>

          {enabled && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1.5fr]">
              <label className="block text-[12px]">
                <span className="mb-1 block text-foreground/55">From</span>
                <input
                  type="time"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  disabled={busy}
                  className="h-9 w-full rounded-md border border-border/60 bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-foreground/15 disabled:opacity-50"
                />
              </label>
              <label className="block text-[12px]">
                <span className="mb-1 block text-foreground/55">To</span>
                <input
                  type="time"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  disabled={busy}
                  className="h-9 w-full rounded-md border border-border/60 bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-foreground/15 disabled:opacity-50"
                />
              </label>
              <label className="block text-[12px]">
                <span className="mb-1 block text-foreground/55">Timezone (IANA)</span>
                <input
                  type="text"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  disabled={busy}
                  placeholder="e.g. Europe/Bucharest"
                  className="h-9 w-full rounded-md border border-border/60 bg-background px-2 text-[13px] outline-none focus:ring-2 focus:ring-foreground/15 disabled:opacity-50"
                />
              </label>
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-[12px] text-[#802020] dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          )}

          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void save()}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-foreground px-3 text-[13px] font-medium text-background hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="h-9 rounded-md border border-border/60 px-3 text-[13px] hover:bg-background disabled:opacity-50"
            >
              Cancel
            </button>
            {settings?.quietHours && enabled === false && (
              <span className="ml-2 text-[12px] text-foreground/55">
                Save will clear current quiet hours.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
