"use client"

import { cn } from "@/lib/utils"
import type { MapDay } from "@/lib/maps/schema"

// ---------------------------------------------------------------------------
// Day tabs — modern pills matching the app's Tailwind tokens.
// ---------------------------------------------------------------------------

/**
 * Day tabs — minimalist underline tabs. No pill chrome, no fills. Active
 * tab is just the row that has the accent underline. Reads as plain text
 * navigation, gets out of the way visually. "All" is the overview tab.
 *
 * Names compact when verbose: "Day 1 — Imperial center" renders as just
 * "Day 1" in the tab; the full label still shows in the sidebar header
 * (panel/fullscreen mode) and in the chips row caption.
 */
export function DayTabs({
  days,
  activeDay,
  offsetForMapChrome,
  onChange,
}: {
  days: MapDay[]
  activeDay: number
  offsetForMapChrome: boolean
  onChange: (index: number) => void
}) {
  const totalPlaces = days.reduce((sum, day) => sum + day.pins.length, 0)
  return (
    <div
      role="tablist"
      aria-label="Trip days"
      className={cn(
        "flex min-h-11 items-center gap-1.5 overflow-x-auto border-b border-border/60 px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        offsetForMapChrome && "mt-14 max-lg:mt-28"
      )}
      style={{ overflowX: "auto" }}
    >
      <DayTabButton
        label="All"
        detail={`${totalPlaces} places`}
        active={activeDay === -1}
        onClick={() => onChange(-1)}
      />
      {days.map((d, idx) => (
        <DayTabButton
          key={d.id}
          label={shortDayLabel(d.label, idx)}
          detail={dayTabDetail(d)}
          active={activeDay === idx}
          onClick={() => onChange(idx)}
        />
      ))}
    </div>
  )
}

function DayTabButton({
  label,
  detail,
  active,
  onClick,
}: {
  label: string
  detail: string | null
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-9 shrink-0 items-center gap-2 rounded-md border px-2.5 text-left text-[12px] font-semibold whitespace-nowrap transition-colors",
        active
          ? "border-foreground/25 bg-foreground text-background shadow-sm"
          : "border-border/60 bg-background text-foreground/80 hover:bg-muted hover:text-foreground"
      )}
    >
      <span>{label}</span>
      {detail && (
        <span
          className={cn(
            "text-[11px] font-medium",
            active ? "text-background/75" : "text-muted-foreground"
          )}
        >
          {detail}
        </span>
      )}
    </button>
  )
}

function dayTabDetail(day: MapDay): string | null {
  const parts = [
    day.date ? compactDateLabel(day.date) : null,
    day.pins.length > 0 ? `${day.pins.length}` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : null
}

/** "Day 1 — Centrul imperial" → "Day 1" when verbose. Falls back to label. */
function shortDayLabel(label: string, idx: number): string {
  const m = label.match(/^(Day|Ziua|Día|Tag|Giorno|Jour)\s*\d+/i)
  if (m) return m[0]
  if (label.length > 12) return `Day ${idx + 1}`
  return label
}

export function compactDateLabel(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ""
  const date = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? new Date(`${trimmed}T00:00:00`)
    : null
  if (date && Number.isFinite(date.getTime())) {
    return date.toLocaleDateString([], {
      month: "short",
      day: "numeric",
    })
  }
  return trimmed.length > 10 ? trimmed.slice(0, 10) : trimmed
}
