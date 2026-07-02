"use client"

import * as React from "react"
import Link from "next/link"
import {
    AppWindow,
    Braces,
    Check,
    Copy,
    FileCode2,
    FileText,
    Globe,
    ExternalLink,
    Loader2,
    Network,
    RefreshCw,
    Share2,
    Shapes,
    Sigma,
    Table,
    Trash2,
    Workflow,
    type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { appApiPath, appPath } from "@/lib/app-path"
import { copyTextToClipboard } from "@/lib/clipboard"
import { useAppEvent } from "@/hooks/use-app-events"
import { LibraryEmptyState } from "./library-empty-state"
import { LibrarySearchBar, matchesQuery } from "./search-bar"
import { formatRelativeTime } from "./use-attachments"
import type { LibraryArtifactRow, LibraryPublishedAppRow } from "@/app/api/library/artifacts/route"
import type { AppListItem } from "@/lib/apps/store"

/**
 * Artifacts tab — every conversation artifact without a dedicated Library
 * home (markdown, code, HTML/React, SVG, CSV, JSON, diagrams…), plus a
 * pinned "Apps" section on top for registered internal apps.
 */

let cachedApps: AppListItem[] | null = null
let cachedArtifacts: LibraryArtifactRow[] | null = null
let cachedPublishedApps: LibraryPublishedAppRow[] | null = null

const TYPE_META: Record<string, { label: string; icon: LucideIcon }> = {
    'text/markdown': { label: 'Markdown', icon: FileText },
    'application/vnd.ant.code': { label: 'Code', icon: FileCode2 },
    'text/html': { label: 'HTML', icon: Globe },
    'application/vnd.ant.react': { label: 'React', icon: Shapes },
    'image/svg+xml': { label: 'SVG', icon: Shapes },
    'text/csv': { label: 'CSV', icon: Table },
    'application/json': { label: 'JSON', icon: Braces },
    'application/vnd.ant.mermaid': { label: 'Diagram', icon: Workflow },
    'application/x-latex': { label: 'LaTeX', icon: Sigma },
    'text/vnd.graphviz': { label: 'Graphviz', icon: Network },
    'application/xml': { label: 'XML', icon: FileCode2 },
}

function typeMeta(type: string): { label: string; icon: LucideIcon } {
    return TYPE_META[type] ?? { label: type.split('/').pop() ?? type, icon: FileText }
}

export function ArtifactsTab() {
    const [apps, setApps] = React.useState<AppListItem[] | null>(() => cachedApps)
    const [artifacts, setArtifacts] = React.useState<LibraryArtifactRow[] | null>(() => cachedArtifacts)
    const [publishedApps, setPublishedApps] = React.useState<LibraryPublishedAppRow[] | null>(() => cachedPublishedApps)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)
    const [query, setQuery] = React.useState('')
    const [typeFilter, setTypeFilter] = React.useState<string | null>(null)

    const load = React.useCallback(async (opts?: { silent?: boolean }) => {
        if (!opts?.silent) setLoading(true)
        setError(null)
        try {
            const [appsRes, artifactsRes] = await Promise.all([
                fetch('/api/apps'),
                fetch('/api/library/artifacts?limit=200'),
            ])
            if (!appsRes.ok) throw new Error(`HTTP ${appsRes.status}`)
            if (!artifactsRes.ok) throw new Error(`HTTP ${artifactsRes.status}`)
            const appsJson = await appsRes.json() as { apps: AppListItem[] }
            const artifactsJson = await artifactsRes.json() as {
                artifacts: LibraryArtifactRow[]
                publishedApps?: LibraryPublishedAppRow[]
            }
            cachedApps = appsJson.apps
            cachedArtifacts = artifactsJson.artifacts
            cachedPublishedApps = artifactsJson.publishedApps ?? []
            setApps(appsJson.apps)
            setArtifacts(artifactsJson.artifacts)
            setPublishedApps(artifactsJson.publishedApps ?? [])
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setLoading(false)
        }
    }, [])

    React.useEffect(() => { void load() }, [load])

    // Keep the tab live: app registrations and new artifacts land without a
    // manual refresh (cheap metadata fetches, silent — no skeleton flash).
    useAppEvent(['apps.changed', 'artifacts.changed'], React.useCallback(() => {
        void load({ silent: true })
    }, [load]))

    const deleteApp = React.useCallback(async (app: AppListItem) => {
        if (!window.confirm(`Ștergi aplicația „${app.title}”? Datele ei se pierd; codul rămâne în conversație.`)) return
        try {
            const res = await fetch(`/api/apps/${encodeURIComponent(app.id)}`, { method: 'DELETE' })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setApps((current) => {
                const next = (current ?? []).filter((a) => a.id !== app.id)
                cachedApps = next
                return next
            })
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        }
    }, [])

    const updatePublishedAppShare = React.useCallback((
        slug: string,
        shareUrl: string,
        shareAccess: LibraryPublishedAppRow['shareAccess'],
    ) => {
        setPublishedApps((current) => {
            const next = (current ?? []).map((app) => app.slug === slug
                ? { ...app, shareUrl, shareAccess, funnelUrl: shareUrl }
                : app)
            cachedPublishedApps = next
            return next
        })
    }, [])

    const presentTypes = React.useMemo(() => {
        const seen = new Map<string, number>()
        for (const a of artifacts ?? []) seen.set(a.type, (seen.get(a.type) ?? 0) + 1)
        return [...seen.entries()].sort((x, y) => y[1] - x[1])
    }, [artifacts])

    const filteredApps = React.useMemo(() => {
        if (!apps) return null
        if (!query) return apps
        return apps.filter((a) => matchesQuery(query, a.title, a.slug, a.description))
    }, [apps, query])

    const filteredPublishedApps = React.useMemo(() => {
        if (!publishedApps) return null
        if (!query) return publishedApps
        return publishedApps.filter((a) => matchesQuery(query, a.title, a.slug, a.basePath, a.runId ?? "", a.shareUrl ?? ""))
    }, [publishedApps, query])

    const filteredArtifacts = React.useMemo(() => {
        if (!artifacts) return null
        let rows = artifacts
        if (typeFilter) rows = rows.filter((a) => a.type === typeFilter)
        if (query) rows = rows.filter((a) => matchesQuery(query, a.title, a.identifier, a.conversationTitle, typeMeta(a.type).label))
        return rows
    }, [artifacts, query, typeFilter])

    const hasAnyData = (apps?.length ?? 0) > 0 || (publishedApps?.length ?? 0) > 0 || (artifacts?.length ?? 0) > 0
    const initialLoading = apps === null && publishedApps === null && artifacts === null && loading

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                    Aplicațiile interne, paginile publicate și celelalte artefacte din conversații — documente, cod, diagrame.
                </p>
                <button
                    type="button"
                    onClick={() => void load()}
                    disabled={loading}
                    className={cn(
                        "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors",
                        "hover:bg-muted hover:text-foreground",
                        "disabled:cursor-default disabled:opacity-50",
                    )}
                >
                    <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
                    Refresh
                </button>
            </div>

            {hasAnyData ? (
                <LibrarySearchBar
                    placeholder="Caută după titlu, tip sau conversație…"
                    onDebouncedChange={setQuery}
                    className="max-w-md"
                />
            ) : null}

            {error ? (
                <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
                    {error}
                </div>
            ) : null}

            {initialLoading ? (
                <SkeletonCards />
            ) : !hasAnyData ? (
                <LibraryEmptyState
                    icon={Shapes}
                    title="Niciun artefact încă"
                    description="Cere în chat un document, o pagină publicată, un calculator sau orice mini-aplicație — apare aici automat."
                />
            ) : (
                <>
                    {filteredApps && filteredApps.length > 0 ? (
                        <section className="flex flex-col gap-2">
                            <h2 className="inline-flex items-center gap-1.5 text-[13px] font-semibold tracking-tight text-foreground">
                                <AppWindow className="size-4 text-primary" strokeWidth={1.85} />
                                Apps
                            </h2>
                            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                {filteredApps.map((app) => (
                                    <AppCard key={app.id} app={app} onDelete={() => void deleteApp(app)} />
                                ))}
                            </ul>
                        </section>
                    ) : null}

                    {filteredPublishedApps && filteredPublishedApps.length > 0 ? (
                        <section className="flex flex-col gap-2">
                            <h2 className="inline-flex items-center gap-1.5 text-[13px] font-semibold tracking-tight text-foreground">
                                <Globe className="size-4 text-primary" strokeWidth={1.85} />
                                Webpages
                            </h2>
                            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                {filteredPublishedApps.map((app) => (
                                    <PublishedAppCard
                                        key={app.slug}
                                        app={app}
                                        onShared={updatePublishedAppShare}
                                        onError={setError}
                                    />
                                ))}
                            </ul>
                        </section>
                    ) : null}

                    {artifacts && artifacts.length > 0 ? (
                        <section className="flex flex-col gap-2">
                            {((filteredApps?.length ?? 0) > 0 || (filteredPublishedApps?.length ?? 0) > 0) ? (
                                <h2 className="text-[13px] font-semibold tracking-tight text-foreground">Artefacte</h2>
                            ) : null}
                            {presentTypes.length > 1 ? (
                                <div className="scrollbar-hide -mx-1 flex gap-1.5 overflow-x-auto px-1 py-0.5">
                                    <TypeChip label="Toate" active={typeFilter === null} onClick={() => setTypeFilter(null)} />
                                    {presentTypes.map(([type, count]) => (
                                        <TypeChip
                                            key={type}
                                            label={`${typeMeta(type).label} (${count})`}
                                            active={typeFilter === type}
                                            onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                                        />
                                    ))}
                                </div>
                            ) : null}
                            {filteredArtifacts && filteredArtifacts.length > 0 ? (
                                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                    {filteredArtifacts.map((row) => (
                                        <ArtifactCard key={row.id} row={row} />
                                    ))}
                                </ul>
                            ) : (
                                <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                                    Niciun artefact pentru filtrul curent.
                                </div>
                            )}
                        </section>
                    ) : null}
                </>
            )}
        </div>
    )
}

function PublishedAppCard({
    app,
    onShared,
    onError,
}: {
    app: LibraryPublishedAppRow
    onShared: (slug: string, shareUrl: string, shareAccess: LibraryPublishedAppRow['shareAccess']) => void
    onError: (message: string | null) => void
}) {
    const [sharing, setSharing] = React.useState(false)
    const [copied, setCopied] = React.useState(false)
    const shareUrl = app.shareUrl ?? app.funnelUrl
    const shareTitle = shareUrl ? "Copiază linkul public" : "Creează link public"

    const copyShareUrl = React.useCallback(async (url: string) => {
        const ok = await copyTextToClipboard(url)
        if (!ok) {
            onError(`Linkul public este gata, dar nu l-am putut copia automat: ${url}`)
            return
        }
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1400)
    }, [onError])

    const share = React.useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault()
        event.stopPropagation()
        if (sharing) return

        if (shareUrl) {
            await copyShareUrl(shareUrl)
            return
        }

        setSharing(true)
        onError(null)
        try {
            const res = await fetch(appApiPath(`/api/published-apps/${encodeURIComponent(app.slug)}/share`), {
                method: "POST",
            })
            const json = await res.json().catch(() => null) as {
                ok?: boolean
                shareUrl?: string
                shareAccess?: LibraryPublishedAppRow['shareAccess']
                error?: string
                output?: string
            } | null
            if (!res.ok || json?.ok !== true || !json.shareUrl) {
                throw new Error(json?.error || json?.output || `HTTP ${res.status}`)
            }
            onShared(app.slug, json.shareUrl, json.shareAccess ?? "tailscale-funnel")
            await copyShareUrl(json.shareUrl)
        } catch (e) {
            onError(e instanceof Error ? e.message : String(e))
        } finally {
            setSharing(false)
        }
    }, [app.slug, copyShareUrl, onError, onShared, shareUrl, sharing])

    return (
        <li className="group relative">
            <Link
                href={appPath(app.basePath)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center gap-3 rounded-xl border border-border/70 bg-muted/25 px-3.5 py-3 pr-12 text-left text-sm transition-colors hover:border-border hover:bg-muted/45"
                title="Open published webpage"
            >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]">
                    <Globe className="size-5" strokeWidth={1.85} />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium text-foreground">{app.title}</span>
                        {shareUrl ? (
                            <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-700 dark:text-emerald-300">
                                Public
                            </span>
                        ) : null}
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground">
                        <span className="truncate">{app.basePath}</span>
                        <ExternalLink className="size-3 shrink-0" />
                    </span>
                    <span className="mt-1 block text-[11.5px] text-muted-foreground/80">
                        {formatRelativeTime(app.publishedAt)}
                    </span>
                </span>
            </Link>
            <button
                type="button"
                onClick={(event) => void share(event)}
                disabled={sharing}
                className={cn(
                    "absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-md border border-border/60 bg-background/90 text-muted-foreground shadow-sm transition-colors",
                    "hover:border-border hover:bg-muted hover:text-foreground",
                    "disabled:cursor-default disabled:opacity-70",
                )}
                aria-label={`${shareTitle} pentru ${app.title}`}
                title={shareTitle}
            >
                {sharing ? (
                    <Loader2 className="size-3.5 animate-spin" />
                ) : copied ? (
                    <Check className="size-3.5 text-emerald-600" />
                ) : shareUrl ? (
                    <Copy className="size-3.5" />
                ) : (
                    <Share2 className="size-3.5" />
                )}
            </button>
        </li>
    )
}

function TypeChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
                active
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
        >
            {label}
        </button>
    )
}

function AppCard({ app, onDelete }: { app: AppListItem; onDelete: () => void }) {
    const disabled = app.codeMissing
    const inner = (
        <>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]">
                {app.icon
                    ? <span className="text-xl leading-none" aria-hidden>{app.icon}</span>
                    : <AppWindow className="size-5" />}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{app.title}</span>
                <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                    {disabled
                        ? 'Codul lipsește — cere în chat reconstruirea aplicației.'
                        : app.description || app.slug}
                </span>
                <span className="mt-1 block text-[11.5px] text-muted-foreground/80">
                    {formatRelativeTime(app.updatedAt)}
                </span>
            </span>
        </>
    )

    return (
        <li className="group relative">
            {disabled ? (
                <div className="flex w-full items-center gap-3 rounded-xl border border-border/50 bg-muted/15 px-3.5 py-3 text-left text-sm opacity-60">
                    {inner}
                </div>
            ) : (
                <Link
                    href={`/artifact/${app.artifactId}?from=library`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex w-full items-center gap-3 rounded-xl border border-border/70 bg-muted/25 px-3.5 py-3 text-left text-sm transition-colors hover:border-border hover:bg-muted/45"
                    title="Open app in new tab"
                >
                    {inner}
                </Link>
            )}
            <button
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete() }}
                className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-background hover:text-rose-500 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
                aria-label={`Șterge aplicația ${app.title}`}
                title="Șterge aplicația"
            >
                <Trash2 className="size-3.5" />
            </button>
        </li>
    )
}

function ArtifactCard({ row }: { row: LibraryArtifactRow }) {
    const { label, icon: Icon } = typeMeta(row.type)
    return (
        <li>
            <Link
                href={`/artifact/${row.id}?from=library`}
                className="flex w-full items-center gap-3 rounded-xl border border-border/70 bg-muted/25 px-3.5 py-3 text-left text-sm transition-colors hover:border-border hover:bg-muted/45"
            >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]">
                    <Icon className="size-5" strokeWidth={1.85} />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium text-foreground">{row.title}</span>
                        {row.appSlug ? (
                            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10.5px] font-medium text-primary">
                                App
                            </span>
                        ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                        {label}
                        {row.conversationTitle ? ` · ${row.conversationTitle}` : ''}
                    </span>
                    <span className="mt-1 block text-[11.5px] text-muted-foreground/80">
                        {formatRelativeTime(row.createdAt)}
                    </span>
                </span>
            </Link>
        </li>
    )
}

function SkeletonCards() {
    return (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
                <li
                    key={i}
                    className="h-[88px] animate-pulse rounded-xl border border-border/40 bg-muted/25"
                />
            ))}
        </ul>
    )
}
