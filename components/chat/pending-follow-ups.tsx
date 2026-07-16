"use client"

import * as React from "react"
import { Paperclip } from "lucide-react"

export interface PendingFollowUpItem {
  id: string
  content: string
  attachmentCount: number
}

interface PendingFollowUpsProps {
  items: PendingFollowUpItem[]
}

/**
 * Queued steering messages, rendered exactly like the user bubbles they will
 * become. They sit above the input (outside the transcript) while the current
 * turn streams, and move into the chat only when their own turn starts — so a
 * message "appears in the chat" at the moment it actually reaches the model.
 */
export const PendingFollowUps = React.memo(function PendingFollowUps({
  items,
}: PendingFollowUpsProps) {
  if (items.length === 0) return null

  return (
    <section
      aria-label="Queued messages"
      aria-live="polite"
      className="mb-2 max-h-44 space-y-2 overflow-y-auto"
    >
      {items.map((item) => (
        <div key={item.id} className="flex flex-col items-end gap-1 pr-1">
          <div className="max-w-[85%] rounded-[10px] bg-[#f0ede6] px-4 py-2.5 text-[16px] whitespace-pre-wrap break-words select-text dark:bg-muted">
            {item.content}
            {item.attachmentCount > 0 && (
              <div
                className={
                  "flex items-center gap-1 text-xs text-muted-foreground" +
                  (item.content ? " mt-1.5" : "")
                }
              >
                <Paperclip className="size-3" aria-hidden="true" />
                <span>
                  {item.attachmentCount} attachment
                  {item.attachmentCount === 1 ? "" : "s"}
                </span>
              </div>
            )}
          </div>
        </div>
      ))}
    </section>
  )
})
