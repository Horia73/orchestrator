"use client"

import * as React from "react"
import { AppWindow } from "lucide-react"
import { useAppEvent } from "@/hooks/use-app-events"

/**
 * Launch card for a registered internal app (application/vnd.ant.app-link).
 *
 * The artifact body is a small JSON pointer emitted by the AppShow tool:
 * { appId, slug, title, description?, icon?, artifactId }. The card
 * re-resolves the app live so it always opens the CURRENT code version —
 * a repoint (AppSave) after the card was emitted still lands on new code.
 * When the app was unregistered, it falls back to the artifactId embedded
 * at emit time so old conversations keep a working (frozen) link.
 */

interface AppLinkBody {
    appId: string
    slug: string
    title: string
    description?: string
    icon?: string
    artifactId: string
}

interface ResolvedApp {
    id: string
    slug: string
    title: string
    description: string | null
    icon: string | null
    artifactId: string
    codeMissing: boolean
}

function parseBody(source: string): AppLinkBody | null {
    try {
        const parsed = JSON.parse(source) as Partial<AppLinkBody>
        if (typeof parsed.appId !== 'string' || typeof parsed.title !== 'string' || typeof parsed.artifactId !== 'string') {
            return null
        }
        return parsed as AppLinkBody
    } catch {
        return null
    }
}

export function AppLinkRenderer({ source }: { source: string }) {
    const body = React.useMemo(() => parseBody(source), [source])
    // undefined = resolving, null = app no longer registered
    const [app, setApp] = React.useState<ResolvedApp | null | undefined>(undefined)

    const refresh = React.useCallback(() => {
        if (!body) return
        let cancelled = false
        void fetch(`/api/apps/${encodeURIComponent(body.appId)}`)
            .then(async (res) => (res.ok ? (await res.json() as { app: ResolvedApp }).app : null))
            .catch(() => null)
            .then((resolved) => {
                if (!cancelled) setApp(resolved)
            })
        return () => { cancelled = true }
    }, [body])

    React.useEffect(() => refresh(), [refresh])
    useAppEvent(['apps.changed'], React.useCallback((event) => {
        if (!body || !('appId' in event) || !event.appId || event.appId === body.appId) refresh()
    }, [body, refresh]))

    if (!body) return null

    const unregistered = app === null
    const targetArtifactId = app?.codeMissing ? null : (app?.artifactId ?? body.artifactId)
    const title = app?.title ?? body.title
    const description = app?.description ?? body.description
    const icon = app?.icon ?? body.icon
    const disabled = app?.codeMissing === true

    const open = () => {
        if (!targetArtifactId || disabled) return
        window.open(`/artifact/${targetArtifactId}`, '_blank', 'noopener,noreferrer')
    }

    return (
        <button
            type="button"
            onClick={open}
            disabled={disabled}
            className="my-2 flex w-full max-w-full items-center gap-3 rounded-lg border border-border/70 bg-muted/25 px-3.5 py-3 text-left text-sm text-foreground/80 transition-colors hover:border-border hover:bg-muted/45 disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={`Open app in new tab: ${title}`}
            title={disabled ? 'App code is missing' : 'Open app in new tab'}
        >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]">
                {icon
                    ? <span className="text-xl leading-none" aria-hidden>{icon}</span>
                    : <AppWindow className="size-5" />}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{title}</span>
                <span className="mt-1 block truncate text-[12px] text-muted-foreground">
                    {disabled
                        ? 'Codul aplicației lipsește — cere-mi să o reconstruiesc.'
                        : unregistered
                            ? 'Aplicație neînregistrată — se deschide ultima versiune cunoscută.'
                            : description || 'Aplicație internă'}
                </span>
            </span>
            <span className="shrink-0 rounded-md bg-background px-2.5 py-1 text-[12px] font-medium text-foreground/70 shadow-[inset_0_0_0_1px_hsl(var(--border))]">
                Open app
            </span>
        </button>
    )
}
