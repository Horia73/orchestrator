"use client"

import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"

import {
  sourceIcon,
  sourceLabel,
} from "./helpers"
import type { WatchRow } from "./types"

export function WatchRowCard({
  watch,
  selected,
  busy,
  onSelect,
  onToggleEnabled,
}: {
  watch: WatchRow
  selected: boolean
  busy: boolean
  onSelect: () => void
  onToggleEnabled: (enabled: boolean) => Promise<void>
}) {
  const hasError = watch.consecutive_errors > 0

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        "group w-full cursor-pointer rounded-lg border border-border/60 bg-background px-3 py-3 text-left transition-colors hover:bg-[#f0ede6]/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/30 dark:hover:bg-muted",
        selected && "border-foreground/40 bg-[#f0ede6] dark:bg-muted",
        !watch.enabled && "opacity-65",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 text-foreground/55">
          {sourceIcon(watch.source)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold text-foreground">
              {watch.title}
            </span>
            {hasError && (
              <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-[#802020] dark:bg-red-950/30 dark:text-red-300">
                error
              </span>
            )}
            {!watch.enabled && (
              <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] text-foreground/65">
                paused
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-foreground/55">
            {sourceLabel(watch.source)} · {watch.target}
          </div>
          <div className="mt-1 truncate text-[12px] text-foreground/60">
            {watch.rule_description}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-foreground/45">
            <span>agent managed</span>
            {watch.suppress_pattern_count > 0 && (
              <span>{watch.suppress_pattern_count} learned filter(s)</span>
            )}
            {watch.allowed_action_count > 0 && (
              <span>{watch.allowed_action_count} action(s)</span>
            )}
          </div>
        </div>
        <div
          className="ml-2 shrink-0"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Switch
            checked={watch.enabled}
            disabled={busy}
            onCheckedChange={(next) => {
              void onToggleEnabled(next)
            }}
            aria-label={watch.enabled ? "Pause watch" : "Enable watch"}
          />
        </div>
      </div>
    </div>
  )
}
