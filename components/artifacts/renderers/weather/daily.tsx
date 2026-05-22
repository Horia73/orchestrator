"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"

import type { WeatherArtifact, WeatherDaily } from "@/lib/weather/schema"
import { cn } from "@/lib/utils"

import { WeatherIcon } from "./icon"
import { subCardTint } from "./gradients"
import { DailyHourlyExpansion, sliceHourlyForExpansion } from "./daily-expansion"

/**
 * 10-day forecast list — the iOS Weather signature view.
 *
 * Each row: day label · weather icon · low · range bar · high.
 *
 * The range bar is a gradient (blue → orange) where the day's portion is
 * highlighted over the dim "full week" background. If today's row is
 * included, a small dot marks the current temperature on the bar.
 *
 * The week's min/max are computed once and threaded through every row so
 * the bars share a common scale.
 */
export function WeatherDailyList({
    artifact,
}: {
    artifact: WeatherArtifact
}) {
    const tint = subCardTint(artifact.current.condition, artifact.current.isDay)

    const todayIso = artifact.daily[0]?.date
    const tomorrowIso = artifact.daily[1]?.date

    // Single open row at a time — like an accordion. Default to today
    // collapsed so the card opens compact.
    const [expanded, setExpanded] = React.useState<string | null>(null)
    const expandableDays = React.useMemo(() => {
        const out = new Map<string, boolean>()
        for (const day of artifact.daily) {
            out.set(
                day.date,
                sliceHourlyForExpansion(
                    artifact.hourly,
                    day.date,
                    todayIso,
                    artifact.location.timezone,
                    artifact.fetchedAt,
                ).length > 0,
            )
        }
        return out
    }, [artifact.daily, artifact.hourly, artifact.location.timezone, artifact.fetchedAt, todayIso])

    React.useEffect(() => {
        if (expanded && !expandableDays.get(expanded)) setExpanded(null)
    }, [expanded, expandableDays])

    if (artifact.daily.length === 0) return null

    // Week-wide low/high — shared scale for every row's range bar.
    const weekLow = Math.min(...artifact.daily.map(d => d.temperatureLow))
    const weekHigh = Math.max(...artifact.daily.map(d => d.temperatureHigh))
    const span = Math.max(1, weekHigh - weekLow)

    return (
        <div className={cn("rounded-xl border border-border/40 px-3 py-3 shadow-sm", tint)}>
            <div className="mb-2 px-1 text-[10.5px] font-medium uppercase tracking-wider text-foreground/55">
                {artifact.daily.length}-day forecast
            </div>
            <div className="divide-y divide-border/30">
                {artifact.daily.map((day) => {
                    const canExpand = expandableDays.get(day.date) === true
                    return (
                        <React.Fragment key={day.date}>
                            <DailyRow
                                day={day}
                                isToday={day.date === todayIso}
                                isTomorrow={day.date === tomorrowIso}
                                currentTemperature={day.date === todayIso ? artifact.current.temperature : undefined}
                                timezone={artifact.location.timezone}
                                weekLow={weekLow}
                                weekHigh={weekHigh}
                                span={span}
                                canExpand={canExpand}
                                isExpanded={expanded === day.date && canExpand}
                                onToggle={() => {
                                    if (!canExpand) return
                                    setExpanded(prev => prev === day.date ? null : day.date)
                                }}
                            />
                            {expanded === day.date && canExpand && (
                                <DailyHourlyExpansion artifact={artifact} date={day.date} />
                            )}
                        </React.Fragment>
                    )
                })}
            </div>
        </div>
    )
}

/**
 * Locale-aware "Today" / "Tomorrow" via Intl.RelativeTimeFormat. Falls back
 * to English if the API returns a non-string. Mostly cosmetic — the strings
 * differ by a few characters per language and the rest of the row supplies
 * context, so a fallback is acceptable.
 */
function localiseRelative(timezone: string, offsetDays: 0 | 1): string {
    void timezone
    try {
        const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
        // 'auto' returns "today"/"tomorrow" in the user's locale.
        const formatted = rtf.format(offsetDays, 'day')
        if (typeof formatted === 'string' && formatted.length > 0) {
            // RelativeTimeFormat often lowercases; uppercase the first letter
            // to match the rest of the column ("Today" not "today").
            return formatted.charAt(0).toUpperCase() + formatted.slice(1)
        }
    } catch { /* ignore */ }
    return offsetDays === 0 ? 'Today' : 'Tomorrow'
}

function DailyRow({
    day,
    isToday,
    isTomorrow,
    currentTemperature,
    timezone,
    weekLow,
    weekHigh,
    span,
    canExpand,
    isExpanded,
    onToggle,
}: {
    day: WeatherDaily
    isToday: boolean
    isTomorrow: boolean
    currentTemperature?: number
    timezone: string
    weekLow: number
    weekHigh: number
    span: number
    canExpand: boolean
    isExpanded: boolean
    onToggle: () => void
}) {
    // Today / Tomorrow / weekday — matches iOS Weather. Uses the user's
    // browser locale so RO users see "Astăzi/Mâine/Sâm" automatically;
    // EN sees "Today/Tomorrow/Sat"; etc.
    const dayLabel = isToday
        ? localiseRelative(timezone, 0)
        : isTomorrow
            ? localiseRelative(timezone, 1)
            : formatDay(day.date, timezone)

    // Range bar geometry — left/right offsets as 0..1 over the week's span.
    const leftFrac = (day.temperatureLow - weekLow) / span
    const rightFrac = (day.temperatureHigh - weekLow) / span

    // Optional "now" dot — only on the today row, clipped to the day's segment.
    const nowFrac = typeof currentTemperature === 'number'
        ? Math.max(leftFrac, Math.min(rightFrac, (currentTemperature - weekLow) / span))
        : null

    void weekHigh

    const content = (
        <>
            <div className="w-16 shrink-0 text-[13px] font-medium text-foreground/85">
                {dayLabel}
            </div>
            <WeatherIcon
                condition={day.condition}
                isDay
                className="size-5 text-foreground/70"
            />
            <PrecipDroplet probability={day.precipitationProbability} />
            <div className="w-8 shrink-0 text-right text-[12.5px] tabular-nums text-foreground/55">
                {Math.round(day.temperatureLow)}°
            </div>
            <div className="flex-1 min-w-0">
                <RangeBar
                    leftFrac={leftFrac}
                    rightFrac={rightFrac}
                    nowFrac={nowFrac}
                />
            </div>
            <div className="w-8 shrink-0 text-right text-[12.5px] font-medium tabular-nums text-foreground">
                {Math.round(day.temperatureHigh)}°
            </div>
        </>
    )

    if (!canExpand) {
        return (
            <div
                aria-label={`${dayLabel} forecast — ${day.conditionLabel}`}
                className="flex w-full items-center gap-3 rounded-md py-2 text-left"
            >
                {content}
                <div className="size-3.5 shrink-0" aria-hidden />
            </div>
        )
    }

    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-label={`${dayLabel} forecast — ${day.conditionLabel}`}
            className={cn(
                "group flex w-full items-center gap-3 rounded-md py-2 text-left transition-colors",
                "hover:bg-foreground/[0.04] focus:outline-none focus-visible:bg-foreground/[0.04] focus-visible:ring-1 focus-visible:ring-foreground/20",
            )}
        >
            {content}
            <ChevronDown
                className={cn(
                    "size-3.5 shrink-0 text-foreground/30 transition-transform duration-200",
                    isExpanded && "rotate-180 text-foreground/55",
                )}
                strokeWidth={2}
                aria-hidden
            />
        </button>
    )
}

/**
 * The temperature range bar. Renders a 6px-tall pill: dim background spans
 * the full row, a saturated blue→orange gradient fills the day's portion,
 * and an optional white-ringed dot marks the live current temperature on
 * today's row.
 */
function RangeBar({
    leftFrac,
    rightFrac,
    nowFrac,
}: {
    leftFrac: number
    rightFrac: number
    nowFrac: number | null
}) {
    const leftPct = clampPct(leftFrac * 100)
    const widthPct = clampPct((rightFrac - leftFrac) * 100)
    const nowPct = nowFrac == null ? null : clampPct(nowFrac * 100)

    return (
        <div className="relative h-[6px] w-full overflow-visible rounded-full bg-foreground/10">
            <div
                className="absolute inset-y-0 rounded-full bg-gradient-to-r from-sky-400 via-yellow-300 to-orange-500"
                style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 4)}%` }}
            />
            {nowPct !== null && (
                <div
                    className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-foreground shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
                    style={{ left: `${nowPct}%` }}
                    aria-label="current temperature"
                />
            )}
        </div>
    )
}

function clampPct(v: number): number {
    if (!Number.isFinite(v)) return 0
    if (v < 0) return 0
    if (v > 100) return 100
    return v
}

/**
 * Tiny rain probability marker next to the day icon when ≥ 30%. Kept
 * understated to match iOS Weather (small blue droplet glyph + percentage).
 * Below 30% we render nothing so quiet days stay quiet.
 */
function PrecipDroplet({ probability }: { probability: number }) {
    if (probability < 30) return <div className="w-10 shrink-0" aria-hidden />
    return (
        <div className="flex w-10 shrink-0 items-center gap-0.5 text-sky-500 dark:text-sky-400">
            <svg viewBox="0 0 24 24" className="size-3" fill="currentColor" aria-hidden>
                <path d="M12 2c-3.5 4.5-6 8-6 11a6 6 0 0012 0c0-3-2.5-6.5-6-11z" />
            </svg>
            <span className="text-[10px] font-semibold tabular-nums">{Math.round(probability)}%</span>
        </div>
    )
}

/**
 * Day label: "Today" / "Tomorrow" handled by the caller; here we format
 * "Mon", "Tue" etc. in the location's timezone.
 *
 * Returns weekday short name (Mon/Tue/...).
 */
function formatDay(isoDate: string, timezone: string): string {
    // isoDate is YYYY-MM-DD; treat as midnight in the target timezone.
    // Building it via Date(isoDate) treats it as UTC midnight, which then
    // formats correctly in any timezone for the weekday (≥ 12h offset edge
    // cases would shift a day, but those zones don't exist in the wild).
    const d = new Date(isoDate + 'T12:00:00Z')
    try {
        return new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: timezone }).format(d)
    } catch {
        return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d)
    }
}
