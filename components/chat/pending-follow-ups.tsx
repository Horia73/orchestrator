"use client"

import * as React from "react"
import { Loader2, Paperclip } from "lucide-react"
import type { PendingFollowUpStatus } from "@/hooks/chat-store-reducer"

export interface PendingFollowUpItem {
  id: string
  content: string
  attachmentCount: number
  status: PendingFollowUpStatus
}

interface PendingFollowUpsProps {
  items: PendingFollowUpItem[]
}

function statusLabel(status: PendingFollowUpStatus): string {
  if (status === "queued") return "Queued"
  if (status === "claimed") return "Starting…"
  return "Sending…"
}

export const PendingFollowUps = React.memo(function PendingFollowUps({
  items,
}: PendingFollowUpsProps) {
  if (items.length === 0) return null

  return (
    <section
      aria-label="Pending follow-up messages"
      aria-live="polite"
      className="mb-2 max-h-44 space-y-1.5 overflow-y-auto rounded-xl"
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="rounded-xl border border-border/60 bg-muted/80 px-3.5 py-2.5 text-foreground shadow-sm backdrop-blur-sm"
        >
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {item.status !== "queued" && (
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            )}
            <span>{statusLabel(item.status)}</span>
          </div>
          {item.content && (
            <p className="line-clamp-3 text-[14px] leading-5 break-words whitespace-pre-wrap">
              {item.content}
            </p>
          )}
          {item.attachmentCount > 0 && (
            <div className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
              <Paperclip className="size-3" aria-hidden="true" />
              <span>
                {item.attachmentCount} attachment
                {item.attachmentCount === 1 ? "" : "s"}
              </span>
            </div>
          )}
        </div>
      ))}
    </section>
  )
})
