"use client"

import * as React from "react"

import { WeatherRenderer } from "@/components/artifacts/renderers/weather-renderer"

/**
 * Dev-only preview surface for the weather artifact renderer. Lets us iterate
 * on the instant-mount + "Working…" placeholder flow without spinning up a
 * full chat conversation:
 *
 *   - pending:    card mounted instantly; both smart tiles show "Working…"
 *   - why-filled: WeatherSetWhy landed; Outfit tile still "Working…"
 *   - complete:   both setters landed; no placeholders
 *   - base:       smartGuidance:false — neither smart tile is shown
 *
 * The point is that `pending` and `complete` have the SAME footprint, so
 * filling the tiles in place causes no reflow. Not linked from anywhere;
 * navigate to /dev/weather-preview directly.
 */
export default function WeatherPreviewPage() {
    const [variant, setVariant] = React.useState<keyof typeof SAMPLES>("pending")
    // Render the card client-only. In the real app weather cards stream in and
    // mount client-side, so SSR-ing the renderer here would surface unrelated
    // SVG sub-pixel hydration warnings that production never hits.
    const [mounted, setMounted] = React.useState(false)
    React.useEffect(() => setMounted(true), [])

    return (
        <div className="mx-auto flex max-w-xl flex-col gap-4 p-6">
            <header className="flex flex-wrap items-center gap-2 border-b border-border/40 pb-3">
                <h1 className="text-xl font-semibold tracking-tight">Weather renderer preview</h1>
                <span className="text-xs text-muted-foreground">instant + placeholders</span>
                <div className="ml-auto inline-flex rounded-md border border-border/60 bg-background p-0.5 text-xs">
                    {(Object.keys(SAMPLES) as Array<keyof typeof SAMPLES>).map((k) => (
                        <button
                            key={k}
                            onClick={() => setVariant(k)}
                            className={`rounded px-2.5 py-1 transition-colors ${variant === k ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
                        >
                            {k}
                        </button>
                    ))}
                </div>
            </header>
            {mounted ? (
                <WeatherRenderer
                    source={JSON.stringify(SAMPLES[variant])}
                    title="Weather in Bucharest"
                    mode="panel"
                />
            ) : (
                <div className="h-[400px] rounded-xl border border-border/40" />
            )}
            <details className="mt-6 rounded-md border border-border/40 bg-muted/20 p-3 text-xs">
                <summary className="cursor-pointer font-medium text-muted-foreground">Source JSON</summary>
                <pre className="mt-2 overflow-auto text-[11px]">{JSON.stringify(SAMPLES[variant], null, 2)}</pre>
            </details>
        </div>
    )
}

const BASE = {
    location: {
        name: "Bucharest",
        country: "RO",
        coordinates: [26.1, 44.43],
        timezone: "Europe/Bucharest",
    },
    units: "metric" as const,
    fetchedAt: "2026-06-16T09:00:00+03:00",
    provider: "google" as const,
    current: {
        temperature: 22.5,
        feelsLike: 21,
        condition: "partly-cloudy" as const,
        conditionLabel: "Partly cloudy",
        isDay: true,
        humidity: 64,
        windSpeed: 3.2,
        windDirection: 45,
        precipitation: 0,
        pressure: 1013,
        visibility: 10,
        uvIndex: 4,
        cloudCover: 40,
    },
    airQuality: { aqi: 42, aqiLabel: "Good", pm25: 8 },
    hourly: [
        { time: "2026-06-16T09:00:00+03:00", temperature: 22, condition: "partly-cloudy" as const, precipitationProbability: 10, isDay: true, uvIndex: 4 },
        { time: "2026-06-16T10:00:00+03:00", temperature: 24, condition: "partly-cloudy" as const, precipitationProbability: 15, isDay: true, uvIndex: 5 },
        { time: "2026-06-16T11:00:00+03:00", temperature: 25, condition: "cloudy" as const, precipitationProbability: 30, isDay: true, uvIndex: 6 },
        { time: "2026-06-16T12:00:00+03:00", temperature: 26, condition: "rain" as const, precipitationProbability: 45, isDay: true, uvIndex: 5 },
    ],
    daily: [
        { date: "2026-06-16", condition: "rain" as const, conditionLabel: "Light rain", temperatureHigh: 26, temperatureLow: 14, precipitationProbability: 45, precipitationSum: 2.1, uvIndexMax: 6, sunrise: "2026-06-16T05:31:00+03:00", sunset: "2026-06-16T21:03:00+03:00", windSpeedMax: 5.5 },
        { date: "2026-06-17", condition: "partly-cloudy" as const, conditionLabel: "Partly cloudy", temperatureHigh: 28, temperatureLow: 15, precipitationProbability: 10, precipitationSum: 0, uvIndexMax: 7, sunrise: "2026-06-17T05:31:00+03:00", sunset: "2026-06-17T21:04:00+03:00", windSpeedMax: 4.2 },
        { date: "2026-06-18", condition: "clear" as const, conditionLabel: "Sunny", temperatureHigh: 30, temperatureLow: 17, precipitationProbability: 5, precipitationSum: 0, uvIndexMax: 8, sunrise: "2026-06-18T05:31:00+03:00", sunset: "2026-06-18T21:04:00+03:00", windSpeedMax: 3.8 },
    ],
}

const WHY = [
    { source: "model" as const, kind: "precipitation" as const, title: "Rain builds midday", value: "45%", explanation: "A 45% chance peaks around noon — worth an umbrella if you're out then.", severity: "caution" as const },
    { source: "model" as const, kind: "feels_like" as const, title: "Feels a touch cooler", value: "21°", explanation: "Light wind pulls the apparent temperature just below the reading.", severity: "neutral" as const },
]

const OUTFIT = {
    source: "model" as const,
    generatedAt: "2026-06-16T09:00:05+03:00",
    headline: "Light layer + umbrella",
    summary: "Comfortable at 22° now, but pack a packable umbrella for the midday showers.",
    items: ["Feels 21°", "45% rain", "Wind 3 m/s"],
}

const SAMPLES = {
    pending: { ...BASE, pending: ["why", "outfit"] as Array<"why" | "outfit"> },
    "why-filled": { ...BASE, why: WHY, pending: ["outfit"] as Array<"why" | "outfit"> },
    complete: { ...BASE, why: WHY, outfit: OUTFIT },
    base: { ...BASE },
} as const
