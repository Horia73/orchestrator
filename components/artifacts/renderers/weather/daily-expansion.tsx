"use client"

import * as React from "react"

import type { WeatherArtifact, WeatherHourly } from "@/lib/weather/schema"
import { uvLabel } from "@/lib/weather/weather-codes"
import { cn } from "@/lib/utils"

import { WeatherIcon } from "./icon"

// ---------------------------------------------------------------------------
// Expanded-day hourly strip.
//
// When the user clicks a row in the 10-day list, this component renders the
// 24 hours of that date as a compact horizontal scroll of hour-by-hour cells
// (icon + temp + precip% / UV).
//
// The hourly data comes from the parent artifact, sliced to the clicked
// date in the location's timezone. When no hours match (e.g. user clicked
// a day past the hourly horizon), we render an "no hourly data" hint
// instead of an empty container.
// ---------------------------------------------------------------------------

export function DailyHourlyExpansion({
    artifact,
    date,
}: {
    artifact: WeatherArtifact
    date: string
}) {
    const tz = artifact.location.timezone
    const todayDate = artifact.daily[0]?.date

    const hours = React.useMemo(
        () => sliceHourlyForExpansion(artifact.hourly, date, todayDate, tz, artifact.fetchedAt),
        [artifact.hourly, date, todayDate, tz, artifact.fetchedAt],
    )

    if (hours.length === 0) {
        return (
            <div className="px-3 py-2 text-[11.5px] text-foreground/55">
                Hourly forecast was not included for this day.
            </div>
        )
    }

    return (
        <div className="mt-1.5 mb-0.5 flex w-full min-w-0 flex-col gap-1 rounded-lg bg-foreground/[0.025] p-2 ring-1 ring-foreground/5">
            <div className="w-full min-w-0 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
                <div className="flex gap-0.5">
                    {hours.map((h, idx) => (
                        <HourCell
                            key={h.time + idx}
                            hour={h}
                            timezone={tz}
                        />
                    ))}
                </div>
            </div>
        </div>
    )
}

function HourCell({
    hour,
    timezone,
}: {
    hour: WeatherHourly
    timezone: string
}) {
    const showPrecip = hour.precipitationProbability >= 20
    // Only show UV when it matters — daytime hours with index >= 3 (Moderate
    // and up). Below that the iOS Weather convention is to suppress to
    // avoid noise.
    const showUv = hour.isDay && typeof hour.uvIndex === 'number' && hour.uvIndex >= 3
    return (
        <div className="flex w-11 shrink-0 flex-col items-center gap-0.5 rounded px-0.5 py-1 text-foreground/85">
            <div className="text-[10px] tabular-nums text-foreground/65">
                {formatHourCompact(hour.time, timezone)}
            </div>
            <WeatherIcon
                condition={hour.condition}
                isDay={hour.isDay}
                className="size-4 text-foreground/70"
            />
            {showPrecip ? (
                <div className="text-[9px] font-semibold leading-none text-sky-600 dark:text-sky-400">
                    {Math.round(hour.precipitationProbability)}%
                </div>
            ) : showUv ? (
                <div
                    className={cn(
                        "text-[9px] font-semibold leading-none",
                        uvChipTint(hour.uvIndex!),
                    )}
                    title={`UV ${Math.round(hour.uvIndex!)} • ${uvLabel(hour.uvIndex!)}`}
                >
                    UV{Math.round(hour.uvIndex!)}
                </div>
            ) : (
                <div className="h-[10px]" aria-hidden />
            )}
            <div className="text-[11px] font-semibold tabular-nums">
                {Math.round(hour.temperature)}°
            </div>
        </div>
    )
}

/**
 * UV chip colour matches iOS / EPA convention: Low green, Moderate yellow,
 * High orange, Very High red, Extreme violet. Picked from Tailwind 500
 * weights so the chip pops without overwhelming the row.
 */
function uvChipTint(uv: number): string {
    if (uv < 3) return 'text-emerald-600 dark:text-emerald-400'
    if (uv < 6) return 'text-yellow-600 dark:text-yellow-400'
    if (uv < 8) return 'text-orange-500'
    if (uv < 11) return 'text-rose-500'
    return 'text-violet-500'
}

/**
 * Pull the hourly entries whose local date (in the location's timezone)
 * matches `targetDate` (YYYY-MM-DD).
 *
 * Open-Meteo returns naive ISO strings (no tz suffix when timezone=auto),
 * Google returns RFC3339 with offset — both are handled by Date parsing
 * + Intl.DateTimeFormat in the target tz.
 */
export function sliceHourlyForExpansion(
    hourly: WeatherHourly[],
    targetDate: string,
    todayDate: string | undefined,
    timezone: string,
    fetchedAt: string,
): WeatherHourly[] {
    const sameDay = sliceHourlyForDate(hourly, targetDate, timezone)

    // Late in the day, providers that do not expose hourly history can only
    // give 1-2 remaining local hours for "Today". Falling back to the rolling
    // next 24h makes the expansion useful instead of looking empty.
    if (targetDate === todayDate && sameDay.length < 6) {
        const next24 = sliceNextHours(hourly, fetchedAt, 24)
        if (next24.length > sameDay.length) return next24
    }

    return sameDay
}

function sliceHourlyForDate(hourly: WeatherHourly[], targetDate: string, timezone: string): WeatherHourly[] {
    if (!targetDate) return []
    const out: WeatherHourly[] = []
    for (const h of hourly) {
        const local = hourLocalDate(h.time, timezone)
        if (local === targetDate) out.push(h)
    }
    return out
}

function sliceNextHours(hourly: WeatherHourly[], fetchedAt: string, count: number): WeatherHourly[] {
    const fetchedMs = Date.parse(fetchedAt)
    const withTime = hourly
        .map((h) => ({ h, ms: hourMs(h.time) }))
        .filter((item) => item.ms !== null)
        .sort((a, b) => (a.ms ?? 0) - (b.ms ?? 0))

    if (!withTime.length) return hourly.slice(0, count)
    if (!Number.isFinite(fetchedMs)) return withTime.slice(0, count).map(item => item.h)

    const future = withTime.filter(item => (item.ms ?? 0) >= fetchedMs - 60 * 60 * 1000)
    return (future.length ? future : withTime).slice(0, count).map(item => item.h)
}

function hourMs(iso: string): number | null {
    if (!iso) return null
    const d = new Date(hasExplicitTimezone(iso) ? iso : iso + 'Z')
    if (Number.isNaN(d.getTime())) return null
    return d.getTime()
}

function hourLocalDate(iso: string, timezone: string): string {
    if (!iso) return ''
    // Naive legacy Open-Meteo strings are already local wall-clock values.
    if (!hasExplicitTimezone(iso)) return iso.slice(0, 10)
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timezone,
        }).formatToParts(d)
        const y = parts.find(p => p.type === 'year')?.value
        const m = parts.find(p => p.type === 'month')?.value
        const dy = parts.find(p => p.type === 'day')?.value
        if (y && m && dy) return `${y}-${m}-${dy}`
    } catch { /* ignore */ }
    return iso.slice(0, 10)
}

function formatHourCompact(iso: string, timezone: string): string {
    if (!iso) return ''
    if (!hasExplicitTimezone(iso)) {
        const wallClock = iso.slice(11, 16)
        return /^\d{2}:\d{2}$/.test(wallClock) ? wallClock : ''
    }
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso.slice(11, 16)
    try {
        return new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: timezone }).format(d)
    } catch {
        return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(d)
    }
}

function hasExplicitTimezone(iso: string): boolean {
    return /(?:Z|[+\-]\d\d:?\d\d)$/i.test(iso)
}

void cn
