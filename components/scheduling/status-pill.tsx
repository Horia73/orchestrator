"use client"

import { cn } from "@/lib/utils"

const STATUS_STYLE: Record<string, string> = {
  scheduled:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  running: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  done: "bg-muted text-foreground/60",
  error: "bg-red-50 text-[#802020] dark:bg-red-950 dark:text-red-300",
  missed: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  paused: "bg-muted text-foreground/55",
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
        STATUS_STYLE[status] ?? "bg-muted"
      )}
    >
      {status}
    </span>
  )
}
