"use client"

import * as React from "react"
import { AlertTriangle, CalendarDays, CloudOff, RefreshCw } from "lucide-react"

import { cn } from "@/lib/utils"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import { parseWeatherArtifact, type WeatherArtifact } from "@/lib/weather/schema"

import { useConversationArtifacts } from "../use-conversation-artifacts"
import { WeatherHero } from "./weather/hero"
import { WeatherHourly } from "./weather/hourly"
import { WeatherDailyList } from "./weather/daily"
import { WeatherDetails } from "./weather/details"

/**
 * Weather artifact renderer.
 *
 * Unlike the map renderer (which sandboxes Google Maps JS inside an iframe
 * for runtime isolation), the weather renderer is pure structured
 * data — there is nothing for an iframe to gain us. So this is a native
 * React composition that picks up the host app's theme, fonts, and Tailwind
 * tokens, and animates entry with the existing tw-animate-css utilities.
 *
 * Layout:
 *   1. <WeatherHero>           — gradient card with big temperature
 *   2. <WeatherHourly>         — horizontal scroll, next 24 hours
 *   3. <WeatherDailyList>      — 10-day forecast with temperature range bars
 *      (omitted in inline mode to keep the card compact)
 *   4. <WeatherDetails>        — UV / wind / sunrise / humidity / visibility / etc.
 *   5. Attribution footer
 *
 * Each section fades in with a small stagger so the artifact "builds" instead
 * of popping. Inline mode (default for chat) drops the daily list + air
 * quality so the artifact fits in the conversation flow; panel mode shows
 * everything.
 *
 * Malformed JSON / schema violations render a styled error card — never a
 * silent blank artifact.
 */
export function WeatherRenderer({
    source,
    title,
    mode = 'inline',
    className,
    artifactId,
}: {
    source: string
    title: string
    mode?: 'inline' | 'panel'
    className?: string
    /** Stable UUID of the artifact row. When present the renderer can
     *  call the refresh API and mutate the conversation-artifacts store
     *  with the new version. Absent in non-chat preview contexts. */
    artifactId?: string
}) {
    const parsed = React.useMemo(() => parseWeatherArtifact(source), [source])

    if (!parsed.ok) {
        return <WeatherErrorCard message={parsed.error} className={className} />
    }

    // Mode is kept on the API for compatibility but the renderer now shows
    // the full layout in both modes — the chat is wide enough and the user
    // wanted a single consistent card regardless of placement.
    void mode

    return (
        <div
            className={cn(
                "flex w-full min-w-0 max-w-full flex-col gap-3 overflow-hidden text-foreground",
                className,
            )}
            aria-label={title}
        >
            {parsed.value.alerts?.length ? (
                <Stagger delay={0}>
                    <WeatherAlerts artifact={parsed.value} />
                </Stagger>
            ) : null}

            <Stagger delay={0}>
                <WeatherHero
                    artifact={parsed.value}
                    todayHigh={parsed.value.daily[0]?.temperatureHigh ?? parsed.value.current.temperature}
                    todayLow={parsed.value.daily[0]?.temperatureLow ?? parsed.value.current.temperature}
                />
            </Stagger>

            {parsed.value.calendarContext?.length ? (
                <Stagger delay={90}>
                    <WeatherCalendarContext artifact={parsed.value} />
                </Stagger>
            ) : null}

            <Stagger delay={60}>
                <WeatherHourly artifact={parsed.value} />
            </Stagger>

            <Stagger delay={120}>
                <WeatherDailyList artifact={parsed.value} />
            </Stagger>

            <Stagger delay={180}>
                <WeatherDetails artifact={parsed.value} />
            </Stagger>

            <Attribution artifact={parsed.value} artifactId={artifactId} />
        </div>
    )
}

function WeatherAlerts({ artifact }: { artifact: WeatherArtifact }) {
    const alerts = artifact.alerts ?? []
    if (alerts.length === 0) return null
    const top = alerts.slice(0, 3)
    return (
        <div className="flex flex-col gap-1.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2.5 text-amber-950 shadow-sm dark:text-amber-100">
            {top.map((alert) => (
                <div key={alert.id} className="grid grid-cols-[auto_1fr] gap-2">
                    <AlertTriangle className={cn("mt-0.5 size-4", alertSeverityClass(alert.severity))} strokeWidth={1.85} />
                    <div className="min-w-0">
                        <div className="truncate text-[12.5px] font-semibold">
                            {alert.title}
                            {alert.source === 'forecast' && (
                                <span className="ml-1 font-medium text-current/55">forecast heads-up</span>
                            )}
                        </div>
                        <div className="text-[12px] leading-snug text-current/70">
                            {alert.summary}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    )
}

function WeatherCalendarContext({ artifact }: { artifact: WeatherArtifact }) {
    const events = artifact.calendarContext ?? []
    if (events.length === 0) return null
    return (
        <div className="rounded-xl border border-border/45 bg-background/70 px-3 py-2.5 shadow-sm">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-foreground/55">
                <CalendarDays className="size-3.5 text-sky-500" strokeWidth={1.75} />
                <span>Calendar</span>
            </div>
            <div className="flex flex-col gap-1.5">
                {events.slice(0, 3).map((event, idx) => (
                    <div key={`${event.title}-${event.startTime}-${idx}`} className="flex min-w-0 items-center justify-between gap-3 text-[12.5px]">
                        <div className="min-w-0">
                            <div className="truncate font-medium text-foreground">{event.title}</div>
                            <div className="truncate text-foreground/50">
                                {formatEventTime(event.startTime, artifact.location.timezone)}
                                {event.locationName ? ` · ${event.locationName}` : ''}
                            </div>
                        </div>
                        <div className="shrink-0 text-right tabular-nums text-foreground/70">
                            {typeof event.temperature === 'number' ? `${Math.round(event.temperature)}°` : ''}
                            {typeof event.precipitationProbability === 'number' ? (
                                <span className="ml-1 text-sky-500">{Math.round(event.precipitationProbability)}%</span>
                            ) : null}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}

/**
 * Tiny entry-animation wrapper. Uses tw-animate-css utilities (already in
 * the dependency graph) so we don't bring in Framer Motion just for the
 * stagger. Negative durations get clamped to 0.
 */
function Stagger({ delay, children }: { delay: number; children: React.ReactNode }) {
    return (
        <div
            className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500"
            style={{ animationDelay: `${Math.max(0, delay)}ms` }}
        >
            {children}
        </div>
    )
}

function Attribution({
    artifact,
    artifactId,
}: {
    artifact: WeatherArtifact
    artifactId?: string
}) {
    const provider = providerLabel(artifact.provider)
    const [, forceTick] = React.useReducer((n: number) => n + 1, 0)
    React.useEffect(() => {
        const id = setInterval(forceTick, 60_000)
        return () => clearInterval(id)
    }, [])
    const fetchedAbsolute = formatAbsoluteHMS(artifact.fetchedAt, artifact.location.timezone)
    const fetchedRelative = formatRelative(artifact.fetchedAt)

    // The artifacts store — when present, refresh mutates it directly so
    // the inline card swaps to the new version without a chat round-trip.
    // The hook returns a no-op fallback outside a provider (preview
    // pages, etc.), in which case the button hides anyway via `canRefresh`.
    const store = useConversationArtifacts()

    const [refreshing, setRefreshing] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)

    // Refresh is only available in the live chat (where artifactId is set
    // and the conversation provider is mounted). In preview / static
    // viewers the button hides.
    const canRefresh = !!artifactId

    const onRefresh = React.useCallback(async () => {
        if (!artifactId || refreshing) return
        setRefreshing(true)
        setError(null)
        try {
            const resp = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/refresh-weather`, {
                method: 'POST',
            })
            if (!resp.ok) {
                let detail = `HTTP ${resp.status}`
                try {
                    const body = await resp.json() as { error?: string }
                    if (body.error) detail = body.error
                } catch { /* ignore */ }
                throw new Error(detail)
            }
            const row = await resp.json() as ArtifactRow
            // Push into the conversation store so RenderMessageContent
            // picks up the new (higher) version and re-mounts the card.
            store?.addArtifact(row)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
            setTimeout(() => setError(null), 5_000)
        } finally {
            setRefreshing(false)
        }
    }, [artifactId, refreshing, store])

    return (
        <div className="flex items-center justify-between gap-2 px-1 text-[10.5px] text-foreground/40 tabular-nums">
            <div className="min-w-0 truncate">
                {provider}
                {fetchedAbsolute && (
                    <>
                        <span aria-hidden> · </span>
                        Updated {fetchedAbsolute}
                        {fetchedRelative && (
                            <>
                                <span aria-hidden> · </span>
                                <span className="text-foreground/35">{fetchedRelative}</span>
                            </>
                        )}
                    </>
                )}
                {artifact.attribution && (
                    <>
                        <span aria-hidden> · </span>
                        {artifact.attribution}
                    </>
                )}
                {error && (
                    <>
                        <span aria-hidden> · </span>
                        <span className="text-rose-500" title={error}>refresh failed</span>
                    </>
                )}
            </div>
            {canRefresh && (
                <button
                    type="button"
                    onClick={onRefresh}
                    disabled={refreshing}
                    title={refreshing ? "Refreshing…" : "Refresh forecast"}
                    aria-label="Refresh forecast"
                    className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded text-foreground/45 transition-colors",
                        "hover:bg-foreground/10 hover:text-foreground",
                        "disabled:opacity-50 disabled:cursor-default",
                    )}
                >
                    <RefreshCw
                        className={cn("size-3", refreshing && "animate-spin")}
                        strokeWidth={1.75}
                    />
                </button>
            )}
        </div>
    )
}

function alertSeverityClass(severity: NonNullable<WeatherArtifact['alerts']>[number]['severity']): string {
    switch (severity) {
        case 'warning': return 'text-rose-500'
        case 'watch': return 'text-orange-500'
        case 'advisory': return 'text-amber-500'
        case 'info': return 'text-sky-500'
    }
}

function formatEventTime(value: string, timezone: string): string {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return value
    try {
        return new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: timezone,
            hourCycle: 'h23',
        }).format(d)
    } catch {
        return new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(d)
    }
}


function providerLabel(provider: WeatherArtifact['provider']): string {
    switch (provider) {
        case 'google': return 'Powered by Google Weather'
        case 'open-meteo': return 'Powered by Open-Meteo'
        case 'manual': return ''
    }
}

/**
 * "5:47:12 PM" absolute clock-time in the location's timezone. The user
 * wanted seconds visible so the card reads like a live readout from the
 * field — matches "fetchedAt" precisely instead of rounding to the minute.
 */
function formatAbsoluteHMS(iso: string, timezone: string): string | null {
    if (!iso) return null
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    try {
        return new Intl.DateTimeFormat(undefined, {
            hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: timezone,
        }).format(d)
    } catch {
        return new Intl.DateTimeFormat(undefined, {
            hour: 'numeric', minute: '2-digit', second: '2-digit',
        }).format(d)
    }
}

/**
 * "2m ago" style relative timestamp. Always paired with an absolute clock
 * time in the UI, so we keep this strictly short. Past 24h falls back to
 * an absolute short date.
 */
function formatRelative(iso: string): string | null {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    const diff = Date.now() - d.getTime()
    if (diff < 60_000) return 'just now'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    try {
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(d)
    } catch {
        return d.toISOString()
    }
}

function WeatherErrorCard({ message, className }: { message: string; className?: string }) {
    return (
        <div
            className={cn(
                "my-2 flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12.5px] text-rose-700",
                "dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300",
                className,
            )}
        >
            <CloudOff className="mt-0.5 size-4 shrink-0" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
                <div className="font-semibold">Weather artifact failed to parse</div>
                <div className="mt-0.5 break-words font-mono text-[11.5px] opacity-85">{message}</div>
            </div>
        </div>
    )
}
