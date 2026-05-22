"use client"

import * as React from "react"

import type { WeatherArtifact, WeatherHourly } from "@/lib/weather/schema"
import { cn } from "@/lib/utils"

import { WeatherIcon } from "./icon"
import { subCardTint } from "./gradients"

/**
 * Hourly forecast strip — horizontal scroll of next ~24 hours.
 *
 * Each cell shows: hour label, optional rain-probability droplet, icon,
 * temperature. The current hour is highlighted with "Now" instead of the
 * time, matching iOS Weather.
 */
export function WeatherHourly({
    artifact,
}: {
    artifact: WeatherArtifact
}) {
    const tint = subCardTint(artifact.current.condition, artifact.current.isDay)
    const tempSymbol = '°'
    const tz = artifact.location.timezone
    const hours = React.useMemo(
        () => nextForecastHours(artifact.hourly, artifact.fetchedAt, 24),
        [artifact.hourly, artifact.fetchedAt],
    )

    if (hours.length === 0) return null

    return (
        <div className={cn("w-full min-w-0 rounded-xl border border-border/40 px-3 py-3 shadow-sm", tint)}>
            <div className="mb-2 px-1 text-[10.5px] font-medium uppercase tracking-wider text-foreground/55">
                Hourly forecast
            </div>
            {/* Horizontal scroll with the visual scrollbar permanently hidden.
                Tailwind v4 doesn't ship a `scrollbar-hide` utility by default,
                so we apply the cross-browser combo inline. The strip still
                scrolls via touch / wheel / drag — only the chrome is muted.
                `w-full min-w-0` is essential here: without it the inner flex
                grows to fit ~240 cells and forces the entire renderer wide. */}
            <div
                className="w-full min-w-0 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            >
                <div className="flex gap-0.5">
                    {hours.map((h, idx) => (
                        <HourlyCell
                            key={h.time + idx}
                            hour={h}
                            isFirst={idx === 0}
                            tempSymbol={tempSymbol}
                            timezone={tz}
                        />
                    ))}
                </div>
            </div>
        </div>
    )
}

function HourlyCell({
    hour,
    isFirst,
    tempSymbol,
    timezone,
}: {
    hour: WeatherHourly
    isFirst: boolean
    tempSymbol: string
    timezone: string
}) {
    const label = isFirst ? 'Now' : formatHour(hour.time, timezone)
    const showPrecip = hour.precipitationProbability >= 20

    return (
        <div className="flex w-14 shrink-0 flex-col items-center gap-1 rounded-md px-1.5 py-1.5 text-foreground transition-colors hover:bg-foreground/5">
            <div className={cn(
                "text-[11px] font-medium tabular-nums",
                isFirst ? "text-foreground" : "text-foreground/70",
            )}>
                {label}
            </div>
            <WeatherIcon
                condition={hour.condition}
                isDay={hour.isDay}
                className={cn(
                    "size-5",
                    iconTintFromCondition(hour),
                )}
            />
            {showPrecip ? (
                <div className="text-[9.5px] font-semibold leading-none text-sky-600 dark:text-sky-400">
                    {Math.round(hour.precipitationProbability)}%
                </div>
            ) : (
                <div className="h-[10px]" aria-hidden />
            )}
            <div className="mt-0.5 text-[12.5px] font-semibold tabular-nums">
                {Math.round(hour.temperature)}{tempSymbol}
            </div>
        </div>
    )
}

/**
 * Tint matches iOS — sunny → amber, cloudy → neutral, rain → blue, snow →
 * light blue, storm → violet. Kept small so icons don't fight the hero.
 */
function iconTintFromCondition(h: WeatherHourly): string {
    switch (h.condition) {
        case 'clear':
            return h.isDay ? 'text-amber-500' : 'text-indigo-300'
        case 'partly-cloudy':
            return h.isDay ? 'text-sky-500' : 'text-indigo-400'
        case 'cloudy':
        case 'overcast':
        case 'fog':
            return 'text-slate-500 dark:text-slate-400'
        case 'drizzle':
        case 'rain':
        case 'heavy-rain':
            return 'text-sky-500 dark:text-sky-400'
        case 'sleet':
        case 'snow':
        case 'heavy-snow':
        case 'hail':
            return 'text-cyan-500 dark:text-cyan-300'
        case 'thunderstorm':
            return 'text-violet-500 dark:text-violet-400'
        case 'windy':
            return 'text-teal-500 dark:text-teal-400'
        default:
            return 'text-foreground/60'
    }
}

/**
 * Format the hour cell label. Google returns RFC3339 with the location's
 * offset, so we parse to UTC then format in the target timezone.
 *
 * Uses 24-hour or 12-hour based on the user's browser locale via the
 * Intl API — matches iOS Weather's behaviour for international users.
 */
function formatHour(isoTime: string, timezone: string): string {
    if (!isoTime) return '--'
    if (!hasExplicitTimezone(isoTime)) {
        const wallClock = isoTime.slice(11, 16)
        return /^\d{2}:\d{2}$/.test(wallClock) ? wallClock : '--'
    }
    const d = new Date(isoTime)
    if (Number.isNaN(d.getTime())) return '--'
    try {
        return new Intl.DateTimeFormat(undefined, {
            hour: 'numeric',
            timeZone: timezone,
        }).format(d)
    } catch {
        // Bad tz id (Google returned something unexpected) — fall back to browser local.
        return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(d)
    }
}

function nextForecastHours(hourly: WeatherHourly[], fetchedAt: string, count: number): WeatherHourly[] {
    const fetchedMs = Date.parse(fetchedAt)
    const withTime = hourly
        .map(hour => ({ hour, ms: hourMs(hour.time) }))
        .filter(item => Number.isFinite(item.ms))
        .sort((a, b) => a.ms - b.ms)

    if (withTime.length === 0) return hourly.slice(0, count)
    if (!Number.isFinite(fetchedMs)) return withTime.slice(0, count).map(item => item.hour)

    const future = withTime.filter(item => item.ms >= fetchedMs - 60 * 60 * 1000)
    return (future.length ? future : withTime).slice(0, count).map(item => item.hour)
}

function hourMs(isoTime: string): number {
    if (!isoTime) return Number.NaN
    return Date.parse(hasExplicitTimezone(isoTime) ? isoTime : `${isoTime}Z`)
}

function hasExplicitTimezone(isoTime: string): boolean {
    return /(?:Z|[+\-]\d\d:?\d\d)$/i.test(isoTime)
}
