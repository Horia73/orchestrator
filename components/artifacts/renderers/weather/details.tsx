"use client"

import * as React from "react"
import {
    History,
    Cloud,
    Droplets,
    ExternalLink,
    Eye,
    Gauge,
    Info,
    Leaf,
    Radio,
    Shirt,
    Sparkle,
    Sunrise,
    Sun,
    Thermometer,
    Wind as WindIcon,
} from "lucide-react"

import type { WeatherArtifact, WeatherCurrent, WeatherDaily, WeatherUnits } from "@/lib/weather/schema"
import { uvLabel, windCompass } from "@/lib/weather/weather-codes"
import { cn } from "@/lib/utils"

import { subCardTint } from "./gradients"
import { SunArcInline } from "./sun-arc"
import { WindCompass } from "./wind-compass"

// ---------------------------------------------------------------------------
// Details grid — Apple-style.
//
// Apple Weather's detail cards put a HUGE primary number near the top of
// each tile (~3-4x the body text size) and a short natural-language caption
// at the bottom ("Wind is making it feel cooler", "Perfectly clear view").
// Empty mid-space is intentional — generous breathing room signals quality.
//
// Tiles are square-ish, 2-col grid base, with select "showcase" tiles
// (Wind, Sunrise·Sunset, Moon) spanning the full width via col-span-2.
// Inside those wide tiles we use a compact list-on-left + small viz-on-right
// pattern so they stay information-dense without feeling cramped.
// ---------------------------------------------------------------------------

export function WeatherDetails({
    artifact,
}: {
    artifact: WeatherArtifact
}) {
    const tint = subCardTint(artifact.current.condition, artifact.current.isDay)
    const c = artifact.current
    const todaySun = artifact.daily[0]
    const tomorrow = artifact.daily[1]
    const distSymbol = artifact.units === 'metric' ? 'km' : 'mi'
    const windSymbol = artifact.units === 'metric' ? 'm/s' : 'mph'
    const captions = buildCaptions(artifact)
    const showSmartGuidance = Boolean(artifact.outfit && artifact.why?.length)

    return (
        <div className={cn("w-full min-w-0 rounded-xl border border-border/40 px-3 py-3 shadow-sm", tint)}>
            <div className="mb-2 px-1 text-[10.5px] font-medium uppercase tracking-wider text-foreground/55">
                Details
            </div>
            {/* Apple-style 2-col grid. Showcase tiles (Wind, Sunrise·Sunset,
                AQ) span both columns. Tiles are tall and breathe; the big
                number is the focal point, captions sit at the bottom. */}
            <div className="grid grid-cols-2 gap-2">
                <NumberTile
                    icon={Thermometer}
                    label="Feels Like"
                    value={`${Math.round(c.feelsLike)}°`}
                    caption={captions.feelsLike}
                    accent="text-rose-500"
                />
                <UvTile uvIndex={c.uvIndex} caption={captions.uv} />

                <WindTile
                    direction={c.windDirection}
                    windValue={Math.round(c.windSpeed)}
                    gustsValue={typeof c.windGust === 'number' ? Math.round(c.windGust) : null}
                    unitLabel={windSymbol}
                    cardinal={windCompass(c.windDirection)}
                />

                <SunriseTile
                    sunrise={todaySun?.sunrise ?? ''}
                    sunset={todaySun?.sunset ?? ''}
                    timezone={artifact.location.timezone}
                />
                <PrecipitationTile
                    today={artifact.daily[0]?.precipitationSum ?? 0}
                    todayUnit={artifact.units === 'metric' ? 'mm' : 'in'}
                    tomorrow={tomorrow ? { sum: tomorrow.precipitationSum, prob: tomorrow.precipitationProbability } : null}
                />

                {showSmartGuidance && artifact.outfit && (
                    <OutfitTile
                        outfit={artifact.outfit}
                        spanFull={!artifact.airQuality}
                    />
                )}
                {artifact.airQuality && (
                    <NumberTile
                        icon={Sparkle}
                        label="Air Quality"
                        value={`${Math.round(artifact.airQuality.aqi)}`}
                        valueUnit={artifact.airQuality.aqiLabel}
                        caption={captions.airQuality}
                        accent={aqiAccent(artifact.airQuality.aqi)}
                        spanFull={!showSmartGuidance}
                    />
                )}

                {showSmartGuidance && artifact.why?.length ? (
                    <WhyTile rows={artifact.why} />
                ) : null}

                {artifact.historical && (
                    <HistoricalTile historical={artifact.historical} units={artifact.units} />
                )}
                {artifact.pollen && (
                    <PollenTile pollen={artifact.pollen} />
                )}
                {artifact.radar && (
                    <RadarTile radar={artifact.radar} />
                )}

                <NumberTile
                    icon={Eye}
                    label="Visibility"
                    value={`${formatDistance(c.visibility)} ${distSymbol}`}
                    caption={captions.visibility}
                    accent="text-indigo-500"
                />
                <NumberTile
                    icon={Droplets}
                    label="Humidity"
                    value={`${Math.round(c.humidity)}%`}
                    caption={captions.humidity}
                    accent="text-sky-500"
                />

                <NumberTile
                    icon={Gauge}
                    label="Pressure"
                    value={`${Math.round(c.pressure)}`}
                    valueUnit="hPa"
                    caption={captions.pressure}
                    accent="text-violet-500"
                />
                <NumberTile
                    icon={Cloud}
                    label="Cloud Cover"
                    value={`${Math.round(c.cloudCover)}%`}
                    caption={captions.cloudCover}
                    accent="text-slate-500"
                />
            </div>
        </div>
    )
}

function WhyTile({ rows }: { rows: NonNullable<WeatherArtifact['why']> }) {
    return (
        <div className="col-span-2 relative flex min-h-[128px] flex-col rounded-xl bg-background/60 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-foreground/55">
                <Info className="size-3.5 text-blue-500" strokeWidth={1.75} />
                <span className="truncate">Why It Feels This Way</span>
            </div>
            <div className="mt-2 grid gap-2">
                {rows.slice(0, 3).map((row) => (
                    <div key={`${row.kind}-${row.title}`} className="grid grid-cols-[1fr_auto] items-start gap-3 border-b border-foreground/10 pb-2 last:border-0 last:pb-0">
                        <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium text-foreground">{row.title}</div>
                            <div className="text-[12px] leading-snug text-foreground/55">{row.explanation}</div>
                        </div>
                        <div className={cn("text-[13px] font-semibold tabular-nums", whySeverityClass(row.severity))}>
                            {row.value}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}

function HistoricalTile({
    historical,
    units,
}: {
    historical: NonNullable<WeatherArtifact['historical']>
    units: WeatherUnits
}) {
    const temp = historical.temperatureHigh ?? historical.temperatureLow
    const tempUnit = units === 'metric' ? '°' : '°'
    const delta = temp ? `${temp.anomaly > 0 ? '+' : ''}${temp.anomaly.toFixed(1)}${tempUnit}` : '—'
    return (
        <div className="relative flex min-h-[124px] flex-col rounded-xl bg-background/60 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-foreground/55">
                <History className="size-3.5 text-fuchsia-500" strokeWidth={1.75} />
                <span className="truncate">History</span>
            </div>
            <div className="mt-1 text-[34px] font-light leading-none tabular-nums text-foreground">
                {delta}
            </div>
            <div className="mt-1 text-[13px] font-medium text-foreground/85">
                vs {historical.sampleYears} yrs
            </div>
            <div className="mt-auto pt-3 text-[12px] leading-snug text-foreground/55">
                {historical.summary}
            </div>
        </div>
    )
}

function PollenTile({ pollen }: { pollen: NonNullable<WeatherArtifact['pollen']> }) {
    const primary = pollen.primary ?? pollen.species[0]
    if (!primary) return null
    return (
        <div className="relative flex min-h-[124px] flex-col rounded-xl bg-background/60 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-foreground/55">
                <Leaf className="size-3.5 text-lime-600" strokeWidth={1.75} />
                <span className="truncate">Pollen</span>
            </div>
            <div className="mt-1 text-[28px] font-light leading-tight text-foreground">
                {primary.label}
            </div>
            <div className="mt-1 text-[13px] font-medium capitalize text-foreground/85">
                {primary.level.replace('_', ' ')} · {primary.value.toFixed(primary.value < 10 ? 1 : 0)}
            </div>
            <div className="mt-auto pt-3 text-[12px] leading-snug text-foreground/55">
                {pollen.summary}
            </div>
        </div>
    )
}

function RadarTile({ radar }: { radar: NonNullable<WeatherArtifact['radar']> }) {
    const body = (
        <>
            <div
                className="absolute inset-0 opacity-90"
                style={{
                    backgroundImage: `linear-gradient(rgba(15,23,42,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,.08) 1px, transparent 1px), url("${radar.imageUrl}")`,
                    backgroundSize: '28px 28px, 28px 28px, cover',
                    backgroundPosition: 'center',
                }}
                aria-hidden
            />
            <div className="relative flex min-h-[150px] flex-col px-4 py-3">
                <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-foreground/65">
                    <Radio className="size-3.5 text-cyan-500" strokeWidth={1.75} />
                    <span className="truncate">Radar</span>
                </div>
                <div className="mt-auto flex max-w-[76%] flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-background/75 px-2 py-1 text-[12px] leading-snug text-foreground/70 backdrop-blur">
                    <span>Latest RainViewer frame, {formatRadarAge(radar.frameTime)}.</span>
                    {radar.viewerUrl && (
                        <span className="inline-flex items-center gap-1 font-medium text-foreground">
                            Open live map
                            <ExternalLink className="size-3" strokeWidth={1.75} />
                        </span>
                    )}
                </div>
            </div>
        </>
    )

    if (radar.viewerUrl) {
        return (
            <a
                className="col-span-2 relative min-h-[150px] overflow-hidden rounded-xl bg-background/60 outline-none transition ring-offset-background hover:brightness-[.98] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                href={radar.viewerUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open live RainViewer radar map"
            >
                {body}
            </a>
        )
    }

    return (
        <div className="col-span-2 relative min-h-[150px] overflow-hidden rounded-xl bg-background/60">
            {body}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Tile primitives — Apple-style typography.
// ---------------------------------------------------------------------------

/**
 * Generic "single big number" tile. Layout from top to bottom:
 *   - small icon + UPPERCASE label
 *   - HUGE value
 *   - optional thin valueUnit immediately under the value
 *   - mt-auto pushes the caption to the bottom of the tile
 *
 * Apple's hierarchy is roughly 36-44px for the number, 11-13px for the
 * label, 13-15px for the caption — we pick the Tailwind equivalents.
 */
function NumberTile({
    icon: Icon,
    label,
    value,
    valueUnit,
    caption,
    accent,
    spanFull,
}: {
    icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
    label: string
    value: string
    valueUnit?: string
    caption?: string | null
    accent?: string
    spanFull?: boolean
}) {
    return (
        <div
            className={cn(
                "relative flex min-h-[124px] flex-col rounded-xl bg-background/60 px-4 py-3",
                spanFull && "col-span-2",
            )}
        >
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-foreground/55">
                <Icon className={cn("size-3.5", accent)} strokeWidth={1.75} />
                <span className="truncate">{label}</span>
            </div>
            <div className="mt-1 text-[34px] font-light leading-none tabular-nums text-foreground">
                {value}
            </div>
            {valueUnit && (
                <div className="mt-1 text-[13px] font-medium text-foreground/85">
                    {valueUnit}
                </div>
            )}
            {caption && (
                <div className="mt-auto pt-3 text-[12px] leading-snug text-foreground/55">
                    {caption}
                </div>
            )}
        </div>
    )
}

/**
 * UV Index — same shape as NumberTile but with a horizontal severity bar
 * under the value (matches Apple). The marker on the bar sits at the
 * current UV position relative to the 0-11+ scale.
 */
function UvTile({ uvIndex, caption }: { uvIndex: number; caption: string | null | undefined }) {
    const label = uvLabel(uvIndex)
    const positionPct = Math.max(0, Math.min(100, (uvIndex / 11) * 100))
    return (
        <div className="relative flex min-h-[124px] flex-col rounded-xl bg-background/60 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-foreground/55">
                <Sun className="size-3.5 text-amber-500" strokeWidth={1.75} />
                <span className="truncate">UV Index</span>
            </div>
            <div className="mt-1 text-[34px] font-light leading-none tabular-nums text-foreground">
                {Math.round(uvIndex)}
            </div>
            <div className="mt-1 text-[13px] font-medium text-foreground/85">
                {label}
            </div>
            {/* Severity bar */}
            <div className="mt-2 h-[5px] w-full overflow-hidden rounded-full bg-foreground/10">
                <div
                    className="h-full rounded-full"
                    style={{
                        width: '100%',
                        background: 'linear-gradient(to right, #10b981 0%, #84cc16 20%, #facc15 40%, #f97316 60%, #ef4444 80%, #a855f7 100%)',
                    }}
                />
                <div
                    className="-mt-[5px] h-[5px] w-[5px] rounded-full bg-white ring-2 ring-foreground/20"
                    style={{ marginLeft: `calc(${positionPct}% - 2.5px)` }}
                    aria-hidden
                />
            </div>
            {caption && (
                <div className="mt-auto pt-2 text-[12px] leading-snug text-foreground/55">
                    {caption}
                </div>
            )}
        </div>
    )
}

/**
 * Wind tile — Apple layout: list of 3 rows on the left (Wind / Gusts /
 * Direction) and a compact compass on the right. Spans both columns.
 * No empty space.
 */
function WindTile({
    direction,
    windValue,
    gustsValue,
    unitLabel,
    cardinal,
}: {
    direction: number
    windValue: number
    gustsValue: number | null
    unitLabel: string
    cardinal: string
}) {
    return (
        <div className="col-span-2 flex min-h-[140px] flex-col rounded-xl bg-background/60 px-4 py-3 text-teal-500">
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-foreground/55">
                <WindIcon className="size-3.5 text-teal-500" strokeWidth={1.75} />
                <span className="truncate">Wind</span>
            </div>
            <div className="mt-2 grid grid-cols-[1fr_auto] items-center gap-3">
                {/* Left: dense list, no extra padding */}
                <div className="flex flex-col gap-2 text-[13px] text-foreground">
                    <div className="flex items-baseline justify-between gap-3 border-b border-foreground/10 pb-2">
                        <span className="text-foreground/70">Wind</span>
                        <span className="tabular-nums font-medium">{windValue} {unitLabel}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3 border-b border-foreground/10 pb-2">
                        <span className="text-foreground/70">Gusts</span>
                        <span className="tabular-nums font-medium">
                            {gustsValue !== null ? `${gustsValue} ${unitLabel}` : '—'}
                        </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                        <span className="text-foreground/70">Direction</span>
                        <span className="tabular-nums font-medium">{Math.round(direction)}° {cardinal}</span>
                    </div>
                </div>
                {/* Right: compass — sized to balance the list visually. */}
                <WindCompass
                    direction={direction}
                    speedLabel={windValue.toString()}
                    unitLabel={unitLabel}
                    cardinal={cardinal}
                />
            </div>
        </div>
    )
}

/**
 * Sunrise / Sunset — Apple style: big sunrise time, mini inline arc with
 * sun (or moon) marker, "Sunset: HH:MM" line at the bottom.
 */
function SunriseTile({
    sunrise,
    sunset,
    timezone,
}: {
    sunrise: string
    sunset: string
    timezone: string
}) {
    if (!sunrise && !sunset) return null
    return (
        <div className="relative flex min-h-[140px] flex-col rounded-xl bg-background/60 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-foreground/55">
                <Sunrise className="size-3.5 text-orange-500" strokeWidth={1.75} />
                <span className="truncate">Sunrise</span>
            </div>
            <div className="mt-1 text-[34px] font-light leading-none tabular-nums text-foreground">
                {formatHHMM(sunrise, timezone)}
            </div>
            {/* Inline arc — small, fills the middle of the tile. */}
            <SunArcInline sunrise={sunrise} sunset={sunset} timezone={timezone} className="mt-2" />
            <div className="mt-auto pt-2 text-[12px] leading-snug text-foreground/55">
                Sunset: {formatHHMM(sunset, timezone)}
            </div>
        </div>
    )
}

/**
 * Precipitation — Apple style: today's total + tomorrow's outlook.
 */
function PrecipitationTile({
    today,
    todayUnit,
    tomorrow,
}: {
    today: number
    todayUnit: string
    tomorrow: { sum: number; prob: number } | null
}) {
    const tomorrowText = tomorrow && (tomorrow.sum > 0 || tomorrow.prob >= 30)
        ? `${tomorrow.sum > 0 ? `${tomorrow.sum.toFixed(tomorrow.sum < 10 ? 1 : 0)} ${todayUnit}` : `${Math.round(tomorrow.prob)}% chance`} expected tomorrow.`
        : tomorrow
            ? 'Little expected tomorrow.'
            : null
    return (
        <div className="relative flex min-h-[124px] flex-col rounded-xl bg-background/60 px-4 py-3">
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-foreground/55">
                <Droplets className="size-3.5 text-sky-500" strokeWidth={1.75} />
                <span className="truncate">Precipitation</span>
            </div>
            <div className="mt-1 text-[34px] font-light leading-none tabular-nums text-foreground">
                {today < 10 ? today.toFixed(1) : Math.round(today)}{' '}
                <span className="text-[20px] font-medium">{todayUnit}</span>
            </div>
            <div className="mt-1 text-[13px] font-medium text-foreground/85">
                Today
            </div>
            {tomorrowText && (
                <div className="mt-auto pt-2 text-[12px] leading-snug text-foreground/55">
                    {tomorrowText}
                </div>
            )}
        </div>
    )
}

function OutfitTile({
    outfit,
    spanFull,
}: {
    outfit: NonNullable<WeatherArtifact['outfit']>
    spanFull?: boolean
}) {
    return (
        <div
            className={cn(
                "relative flex min-h-[124px] flex-col rounded-xl bg-background/60 px-4 py-3",
                spanFull && "col-span-2",
            )}
        >
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-foreground/55">
                <Shirt className="size-3.5 text-emerald-500" strokeWidth={1.75} />
                <span className="truncate">Outfit</span>
            </div>
            <div className="mt-1 text-[26px] font-light leading-tight text-foreground">
                {outfit.headline}
            </div>
            {outfit.items?.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                    {outfit.items.map((chip) => (
                        <span
                            key={chip}
                            className="rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[11px] font-medium text-foreground/65"
                        >
                            {chip}
                        </span>
                    ))}
                </div>
            ) : null}
            <div className="mt-auto pt-3 text-[12px] leading-snug text-foreground/55">
                {outfit.summary}
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Caption generator — natural language under each tile.
//
// Inspired by Apple's contextual captions ("Wind is making it feel cooler",
// "Perfectly clear view", "The dew point is 12° right now"). Each generator
// returns either a friendly sentence or null when there's nothing useful
// to say.
// ---------------------------------------------------------------------------

interface DetailCaptions {
    feelsLike: string | null
    uv: string | null
    visibility: string | null
    humidity: string | null
    pressure: string | null
    cloudCover: string | null
    airQuality: string | null
}

function buildCaptions(artifact: WeatherArtifact): DetailCaptions {
    const c = artifact.current
    const t = artifact.daily[0]
    return {
        feelsLike: feelsLikeCaption(c),
        uv: uvCaption(c, t),
        visibility: visibilityCaption(c, artifact.units),
        humidity: humidityCaption(c, artifact.units),
        pressure: pressureCaption(c),
        cloudCover: cloudCoverCaption(c),
        airQuality: airQualityCaption(artifact.airQuality),
    }
}

function feelsLikeCaption(c: WeatherCurrent): string | null {
    const diff = c.feelsLike - c.temperature
    if (Math.abs(diff) < 1) return 'Similar to the actual temperature.'
    if (diff < -2 && c.windSpeed > 4) return 'Wind is making it feel cooler.'
    if (diff < -2 && c.humidity < 35) return 'Dry air making it feel cooler.'
    if (diff < -2) return 'Feels cooler than the air temperature.'
    if (diff > 2 && c.humidity > 70) return 'Humidity is making it feel warmer.'
    if (diff > 2) return 'Feels warmer than the air temperature.'
    return null
}

function uvCaption(c: WeatherCurrent, today?: WeatherDaily): string | null {
    const peak = today?.uvIndexMax ?? c.uvIndex
    if (!c.isDay) return 'No UV exposure tonight.'
    if (c.uvIndex < 3 && peak < 3) return 'Low for the rest of the day.'
    if (c.uvIndex < 3 && peak >= 6) return `Will reach ${Math.round(peak)} later today.`
    if (c.uvIndex >= 8) return 'Take precautions — sunburn risk is high.'
    if (c.uvIndex >= 6) return 'Sun protection recommended.'
    if (c.uvIndex >= 3) return 'Moderate — short bursts of sun are fine.'
    return null
}

function visibilityCaption(c: WeatherCurrent, units: WeatherUnits): string | null {
    const km = units === 'metric' ? c.visibility : c.visibility / 0.621371
    if (km >= 16) return 'Perfectly clear view.'
    if (km >= 10) return 'Clear conditions.'
    if (km >= 5) return 'Some haze in the distance.'
    if (km >= 2) return 'Reduced visibility.'
    return 'Heavy haze or fog right now.'
}

function humidityCaption(c: WeatherCurrent, units: WeatherUnits): string | null {
    if (typeof c.dewPoint !== 'number') {
        if (c.humidity > 80) return 'Air feels heavy and muggy.'
        if (c.humidity < 30) return 'Air is very dry.'
        return null
    }
    const dew = Math.round(c.dewPoint)
    const symbol = units === 'metric' ? '°' : '°'
    return `The dew point is ${dew}${symbol} right now.`
}

function pressureCaption(c: WeatherCurrent): string | null {
    if (c.pressure >= 1023) return 'High pressure — typically settled weather.'
    if (c.pressure <= 1005) return 'Low pressure — unsettled conditions possible.'
    return null
}

function cloudCoverCaption(c: WeatherCurrent): string | null {
    if (c.cloudCover < 15) return 'Mostly clear sky.'
    if (c.cloudCover < 50) return 'A few clouds around.'
    if (c.cloudCover < 85) return 'Mostly cloudy.'
    return 'Overcast.'
}

function airQualityCaption(aq: WeatherArtifact['airQuality']): string | null {
    if (!aq) return null
    if (aq.aqi <= 50) return 'Air quality is good across the area.'
    if (aq.aqi <= 100) return 'Air quality is acceptable for most.'
    if (aq.aqi <= 150) return 'Sensitive groups may experience effects.'
    if (aq.aqi <= 200) return 'Limit prolonged outdoor exertion.'
    return 'Avoid outdoor activity if possible.'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHHMM(iso: string, timezone: string): string {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    // Force 24-hour clock: "05:43 AM" wraps in narrow tiles. The 24-hour
    // form is also what most European locales expect by default. Drop the
    // automatic AM/PM that Intl.DateTimeFormat sometimes inserts.
    try {
        return new Intl.DateTimeFormat(undefined, {
            hour: '2-digit', minute: '2-digit', timeZone: timezone, hourCycle: 'h23',
        }).format(d)
    } catch {
        return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
    }
}

function formatDistance(v: number): string {
    if (v < 10) return v.toFixed(1)
    return Math.round(v).toString()
}

function aqiAccent(aqi: number): string {
    if (aqi <= 50) return 'text-emerald-500'
    if (aqi <= 100) return 'text-yellow-500'
    if (aqi <= 150) return 'text-orange-500'
    if (aqi <= 200) return 'text-rose-500'
    if (aqi <= 300) return 'text-violet-500'
    return 'text-red-700'
}

function whySeverityClass(severity: NonNullable<WeatherArtifact['why']>[number]['severity']): string {
    switch (severity) {
        case 'caution': return 'text-orange-500'
        case 'useful': return 'text-blue-500'
        case 'neutral': return 'text-foreground/60'
    }
}

function formatRadarAge(frameTime: string): string {
    const ms = Date.parse(frameTime)
    if (!Number.isFinite(ms)) return 'recent'
    const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000))
    if (minutes < 2) return 'just now'
    if (minutes < 90) return `${minutes} min ago`
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(ms))
}
