"use client"

import * as React from "react"
import { CalendarDays, Flame } from "lucide-react"

import { cn } from "@/lib/utils"

const WEEKS = 16
const DAY_MS = 86_400_000
const WEEKDAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"]

/**
 * GitHub-style training heatmap + consistency headline, built purely from
 * session start dates (no extra fetch). Columns are weeks (Mon→Sun rows),
 * the rightmost column is the current week. Cell shade scales with the number
 * of sessions logged that day.
 */
export function TrainingCalendar({
    sessions,
    className,
}: {
    sessions: Array<{ startedAt: string }>
    className?: string
}) {
    // Captured once at mount so the heatmap stays stable across re-renders.
    const [nowMs] = React.useState(() => Date.now())
    const model = React.useMemo(() => buildCalendar(sessions, nowMs), [sessions, nowMs])

    return (
        <section
            className={cn(
                "flex flex-col gap-3 rounded-xl border border-border/60 bg-card px-4 py-3.5 shadow-sm",
                className,
            )}
            aria-label="Training consistency"
        >
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h2 className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground/65">
                    <CalendarDays className="size-3.5 text-muted-foreground" strokeWidth={2} />
                    Training calendar
                </h2>
                <div className="flex items-center gap-4">
                    <HeadlineStat
                        icon={<Flame className="size-3.5" strokeWidth={2} />}
                        value={`${model.weekStreak} wk`}
                        label="streak"
                        accent={model.weekStreak > 0}
                    />
                    <HeadlineStat value={String(model.thisWeekCount)} label="this week" />
                    <HeadlineStat value={String(model.last30Count)} label="last 30d" />
                </div>
            </div>

            <div className="flex gap-1.5 overflow-x-auto">
                <div className="flex flex-col gap-[3px] pr-0.5 pt-[2px]">
                    {WEEKDAY_LABELS.map((label, i) => (
                        <span
                            key={i}
                            className="flex h-[13px] items-center text-[8.5px] leading-none text-muted-foreground/55"
                        >
                            {i % 2 === 1 ? label : ""}
                        </span>
                    ))}
                </div>
                <div className="flex gap-[3px]">
                    {model.columns.map((col, ci) => (
                        <div key={ci} className="flex flex-col gap-[3px]">
                            {col.map((cell, ri) => (
                                <Cell key={ri} cell={cell} />
                            ))}
                        </div>
                    ))}
                </div>
            </div>

            <div className="flex items-center justify-end gap-1.5 text-[9.5px] text-muted-foreground/65">
                <span>less</span>
                {[0, 1, 2, 3].map((level) => (
                    <span key={level} className={cn("size-[11px] rounded-[3px]", LEVEL_CLASS[level])} />
                ))}
                <span>more</span>
            </div>
        </section>
    )
}

function HeadlineStat({
    icon,
    value,
    label,
    accent,
}: {
    icon?: React.ReactNode
    value: string
    label: string
    accent?: boolean
}) {
    return (
        <div className="flex flex-col items-end leading-none">
            <span
                className={cn(
                    "inline-flex items-center gap-1 text-base font-semibold tabular-nums text-foreground",
                    accent && "text-amber-600 dark:text-amber-400",
                )}
            >
                {icon ? <span className={cn(accent && "text-amber-500")}>{icon}</span> : null}
                {value}
            </span>
            <span className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
        </div>
    )
}

interface DayCell {
    /** YYYY-MM-DD, or null for padding days outside the window. */
    date: string | null
    count: number
    isToday: boolean
    isFuture: boolean
}

const LEVEL_CLASS: Record<number, string> = {
    0: "bg-muted/45",
    1: "bg-primary/30",
    2: "bg-primary/60",
    3: "bg-primary",
}

function Cell({ cell }: { cell: DayCell }) {
    if (cell.date === null || cell.isFuture) {
        return <span className="size-[13px] rounded-[3px] bg-transparent" aria-hidden />
    }
    const level = cell.count === 0 ? 0 : cell.count === 1 ? 1 : cell.count === 2 ? 2 : 3
    const title = `${cell.date} · ${cell.count} session${cell.count === 1 ? "" : "s"}`
    return (
        <span
            title={title}
            className={cn(
                "size-[13px] rounded-[3px] transition-colors",
                LEVEL_CLASS[level],
                cell.isToday && "ring-1 ring-foreground/40 ring-offset-1 ring-offset-card",
            )}
        />
    )
}

function startOfDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Monday=0 … Sunday=6 index for the weekday rows. */
function mondayIndex(d: Date): number {
    return (d.getDay() + 6) % 7
}

function buildCalendar(sessions: Array<{ startedAt: string }>, nowMs: number) {
    const counts = new Map<string, number>()
    for (const s of sessions) {
        const key = s.startedAt.slice(0, 10)
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    const today = startOfDay(new Date(nowMs))
    const todayKey = isoKey(today)
    // Grid starts on the Monday of the week (WEEKS-1) weeks before the current.
    const gridStart = new Date(today.getTime() - (mondayIndex(today) + (WEEKS - 1) * 7) * DAY_MS)

    const columns: DayCell[][] = []
    for (let c = 0; c < WEEKS; c++) {
        const col: DayCell[] = []
        for (let r = 0; r < 7; r++) {
            const day = new Date(gridStart.getTime() + (c * 7 + r) * DAY_MS)
            const key = isoKey(day)
            col.push({
                date: key,
                count: counts.get(key) ?? 0,
                isToday: key === todayKey,
                isFuture: day.getTime() > today.getTime(),
            })
        }
        columns.push(col)
    }

    // Headline counts.
    const todayMs = today.getTime()
    const thisWeekStartMs = todayMs - mondayIndex(today) * DAY_MS
    let thisWeekCount = 0
    let last30Count = 0
    for (const [key, count] of counts) {
        const ms = startOfDay(new Date(key + "T00:00:00")).getTime()
        if (!Number.isFinite(ms)) continue
        if (ms >= thisWeekStartMs && ms <= todayMs) thisWeekCount += count
        if (ms >= todayMs - 29 * DAY_MS && ms <= todayMs) last30Count += count
    }

    // Week streak: consecutive weeks (from the current one) with ≥1 session.
    // A still-empty current week doesn't break a streak that ran through last
    // week, so we start counting from the first non-empty recent week.
    const weekHas = columns.map((col) => col.some((cell) => !cell.isFuture && cell.count > 0))
    let weekStreak = 0
    let i = weekHas.length - 1
    if (i >= 0 && !weekHas[i]) i-- // skip an empty current week
    for (; i >= 0; i--) {
        if (weekHas[i]) weekStreak++
        else break
    }

    return { columns, weekStreak, thisWeekCount, last30Count }
}

function isoKey(d: Date): string {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${y}-${m}-${day}`
}
