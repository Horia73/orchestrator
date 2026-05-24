"use client"

import { Loader2, MapPin } from "lucide-react"

import { cn } from "@/lib/utils"

import { INLINE_HEIGHT_PX } from "./constants"

// ---------------------------------------------------------------------------
// Small chrome components (loading / error cards) — Tailwind only, no
// iframe, so they slot in naturally inside the chat bubble.
// ---------------------------------------------------------------------------

export function LoadingCard({
  className,
  title,
  mode,
  frameless = false,
}: {
  className?: string
  title: string
  mode: "inline" | "panel"
  frameless?: boolean
}) {
  const height = mode === "panel" ? "100%" : `${INLINE_HEIGHT_PX}px`
  return (
    <div
      className={cn(
        "relative overflow-hidden bg-muted/30",
        frameless
          ? "rounded-none border-0"
          : "rounded-xl border border-border/60",
        className
      )}
      style={{ height }}
      aria-label={title}
    >
      <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading map…
      </div>
    </div>
  )
}

export function ErrorCard({
  className,
  title,
  detail,
  frameless = false,
}: {
  className?: string
  title: string
  detail: string
  frameless?: boolean
}) {
  return (
    <div
      className={cn(
        "my-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700",
        "dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300",
        frameless &&
          "m-0 flex h-full items-center justify-center rounded-none border-0",
        className
      )}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{title}</div>
          <div className="mt-0.5 font-mono text-[11.5px] break-words opacity-85">
            {detail}
          </div>
        </div>
      </div>
    </div>
  )
}
