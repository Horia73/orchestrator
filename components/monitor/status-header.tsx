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
    <div className="border-b border-border/60 px-4 py-3 text-[12px] text-foreground/65 md:px-5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              loading
                ? "bg-foreground/30"
                : armed
                  ? "bg-emerald-500"
                  : "bg-foreground/30"
            )}
          />
          <span className="min-w-0 truncate font-semibold text-foreground">
            Smart monitor agent
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
          <span
            title={
              hb.next_run_at ? new Date(hb.next_run_at).toLocaleString() : ""
            }
          >
            next wake {formatRelative(hb.next_run_at, now)}
          </span>
        )}
        {hb?.last_run_at && (
          <span title={new Date(hb.last_run_at).toLocaleString()}>
            last wake {formatPast(hb.last_run_at, now)}
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
