"use client"

import { cn } from "@/lib/utils"

import { formatPast, formatRelative, useNow } from "./helpers"
import type { HeartbeatStatus } from "./types"

export function StatusHeader({
  status,
  loading,
}: {
  status: HeartbeatStatus | null
  loading: boolean
}) {
  const now = useNow(1000)
  const hb = status?.heartbeat
  const armed = hb !== null && hb !== undefined && hb.enabled
  const enabledWatches = status?.counts.enabled ?? 0

  return (
    <div className="border-b border-border/60 px-5 py-3 text-[12px] text-foreground/65">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "size-2 rounded-full",
              loading
                ? "bg-foreground/30"
                : armed
                  ? "bg-emerald-500"
                  : "bg-foreground/30",
            )}
          />
          <span className="font-semibold text-foreground">
            Smart monitor heartbeat
          </span>
          <span>
            {loading
              ? "loading…"
              : !hb
                ? "not installed yet"
                : !hb.enabled
                  ? enabledWatches > 0
                    ? "paused (watches will not run)"
                    : "paused (no enabled watches)"
                  : "armed"}
          </span>
        </div>
        {hb && hb.enabled && (
          <span title={hb.next_run_at ? new Date(hb.next_run_at).toLocaleString() : ""}>
            next tick {formatRelative(hb.next_run_at, now)}
          </span>
        )}
        {hb?.last_run_at && (
          <span title={new Date(hb.last_run_at).toLocaleString()}>
            last tick {formatPast(hb.last_run_at, now)}
            {hb.last_run_status === "error" ? " · errored" : ""}
          </span>
        )}
        {status && (
          <span>
            {status.counts.enabled} active · {status.counts.paused} paused
            {status.counts.errored > 0 && (
              <span className="text-[#802020] dark:text-red-300">
                {" "}
                · {status.counts.errored} errored
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  )
}
