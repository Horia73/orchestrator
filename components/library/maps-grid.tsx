"use client"

import * as React from "react"
import Link from "next/link"
import { Calendar, MapPin, MapPinned, Route, Spline } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatRelativeTime } from "./use-attachments"
import type { LibraryMapRow } from "@/app/api/library/maps/route"

/**
 * Card grid for map artifacts. Uses the existing /api/maps/static endpoint
 * to render a real Google Static Maps thumbnail when the API key is
 * configured. Falls back to a gradient + icon when no key (so the page is
 * still useful without Google Maps Platform set up).
 *
 * Each card: 16:9 thumbnail, title, basemap label, counts of pins / routes
 * / polygons / days, source conversation, relative time.
 */
export function MapsGrid({
    maps,
    className,
}: {
    maps: LibraryMapRow[]
    className?: string
}) {
    return (
        <ul
            className={cn(
                "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3",
                className,
            )}
            aria-label="Maps grid"
        >
            {maps.map((m) => (
                <li key={m.id}>
                    <MapCard map={m} />
                </li>
            ))}
        </ul>
    )
}

function MapCard({ map }: { map: LibraryMapRow }) {
    return (
        <Link
            href={`/?conversation=${encodeURIComponent(map.conversationId)}#message-artifact-${encodeURIComponent(map.identifier)}`}
            className={cn(
                "group/map-card flex h-full flex-col overflow-hidden rounded-xl border border-border/55 bg-card shadow-sm transition-all",
                "hover:-translate-y-0.5 hover:border-border hover:shadow-md",
            )}
        >
            <MapThumbnail map={map} />
            <div className="flex flex-1 flex-col gap-2 px-3.5 py-3">
                <div>
                    <h3 className="line-clamp-1 text-sm font-semibold text-foreground">{map.title}</h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                        {map.center[1].toFixed(3)}, {map.center[0].toFixed(3)}
                        {typeof map.zoom === 'number' ? ` · z${Math.round(map.zoom)}` : ''}
                        {' · '}
                        <span className="text-foreground/65">{prettyBasemap(map.basemap)}</span>
                    </p>
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] text-muted-foreground tabular-nums">
                    {map.pinCount > 0 ? (
                        <Chip icon={<MapPin className="size-3" />}>
                            {map.pinCount} pin{map.pinCount === 1 ? '' : 's'}
                        </Chip>
                    ) : null}
                    {map.routeCount > 0 ? (
                        <Chip icon={<Route className="size-3" />}>
                            {map.routeCount} route{map.routeCount === 1 ? '' : 's'}
                        </Chip>
                    ) : null}
                    {map.polygonCount > 0 ? (
                        <Chip icon={<Spline className="size-3" />}>
                            {map.polygonCount} area{map.polygonCount === 1 ? '' : 's'}
                        </Chip>
                    ) : null}
                    {map.dayCount > 0 ? (
                        <Chip icon={<Calendar className="size-3" />}>
                            {map.dayCount} day{map.dayCount === 1 ? '' : 's'}
                        </Chip>
                    ) : null}
                </div>
                <div className="flex items-center justify-between text-[10.5px] text-muted-foreground/75">
                    <span className="truncate normal-case">{map.conversationTitle ?? 'Conversation'}</span>
                    <span className="shrink-0 tabular-nums">{formatRelativeTime(map.createdAt)}</span>
                </div>
            </div>
        </Link>
    )
}

function MapThumbnail({ map }: { map: LibraryMapRow }) {
    const [failed, setFailed] = React.useState(false)
    const thumbnailUrl = `/api/maps/static?artifactId=${encodeURIComponent(map.id)}&width=640&height=360`

    if (failed) {
        return (
            <div className="flex aspect-[16/9] w-full items-center justify-center bg-gradient-to-br from-emerald-500/10 via-teal-500/10 to-sky-500/15">
                <MapPinned className="size-8 text-foreground/35" strokeWidth={1.4} aria-hidden />
            </div>
        )
    }
    return (
        <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted/40">
            <img
                src={thumbnailUrl}
                alt={`Map preview for ${map.title}`}
                loading="lazy"
                onError={() => setFailed(true)}
                className="size-full object-cover transition-transform duration-300 group-hover/map-card:scale-[1.03]"
            />
        </div>
    )
}

function Chip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted/55 px-1.5 py-0.5 text-foreground/75">
            <span className="text-muted-foreground/65">{icon}</span>
            {children}
        </span>
    )
}

function prettyBasemap(basemap: string): string {
    switch (basemap) {
        case 'satellite': return 'Satellite'
        case 'satellite-streets': return 'Hybrid'
        default: return basemap
    }
}
