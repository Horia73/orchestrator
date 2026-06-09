"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"

import type { StreamingStatus } from "@/hooks/chat-store-utils"
import { cn } from "@/lib/utils"

const MIN_VISIBLE_MS = 1000

function statusLabel(status: StreamingStatus): string {
  if (status === "offline") return "Waiting for connection"
  if (status === "recovering") return "Reconnecting"
  return "Connecting"
}

/**
 * Latches a streaming status so a fast connection still shows the pill for a
 * minimum dwell time. On a good network the live `status` can flip
 * connecting → null in well under a second, which reads as a buggy flash — the
 * latch keeps the pill up for at least `minVisibleMs` once it appears.
 */
export function useStickyConnectionStatus(
  status: StreamingStatus,
  minVisibleMs = MIN_VISIBLE_MS
): StreamingStatus {
  const [shown, setShown] = React.useState<StreamingStatus>(null)
  const shownAtRef = React.useRef(0)

  React.useEffect(() => {
    if (status) {
      if (!shown) shownAtRef.current = Date.now()
      setShown(status)
      return
    }
    if (!shown) return
    const remaining = Math.max(
      0,
      minVisibleMs - (Date.now() - shownAtRef.current)
    )
    const timer = window.setTimeout(() => setShown(null), remaining)
    return () => window.clearTimeout(timer)
  }, [status, shown, minVisibleMs])

  return shown
}

/**
 * Bottom-centered "Connecting / Reconnecting" pill. Sits just above the chat
 * input and fades in/out without blocking pointer events. Driven by the live
 * `status`; the dwell latch and fade-out keep it from flickering when the
 * server connects quickly.
 */
export function ChatConnectionPill({
  status,
  style,
}: {
  status: StreamingStatus
  style?: React.CSSProperties
}) {
  const shown = useStickyConnectionStatus(status)
  const visible = shown !== null
  // Hold the last label through the fade-out so the text doesn't blank mid
  // animation after `shown` clears.
  const [label, setLabel] = React.useState(() => statusLabel("connecting"))
  React.useEffect(() => {
    if (shown) setLabel(statusLabel(shown))
  }, [shown])

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-20 flex justify-center px-4"
      style={style}
    >
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center gap-2 rounded-full border border-border/70 bg-background/90 px-3.5 py-1.5",
          "text-[13px] font-medium text-muted-foreground shadow-[0_8px_24px_rgba(32,23,16,0.10)] backdrop-blur",
          "transition-all duration-300 ease-out motion-reduce:transition-none",
          visible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-1 opacity-0"
        )}
      >
        <Loader2 className="size-3.5 animate-spin text-muted-foreground/80" />
        <span>{label}…</span>
      </div>
    </div>
  )
}
