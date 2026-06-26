"use client"

import * as React from "react"
import { ExternalLink, Globe, Loader2, RotateCw, TriangleAlert } from "lucide-react"

import { cn } from "@/lib/utils"
import {
    parseDevPreviewArtifact,
    devPreviewLocalSrc,
    type DevPreviewArtifact,
} from "@/lib/dev-preview/schema"

/**
 * Renderer for `application/vnd.ant.dev-preview` — an embedded "mini-browser"
 * pointed at a managed project-run dev server reverse-proxied through the live
 * app at `/dev-preview/<run-id>/`. Lets the user watch a site the agent is
 * building (new Next.js project, self-dev change, etc.) from anywhere, without
 * needing access to the loopback dev port on the host.
 *
 * The frame shows the live dev server through the proxy. The proxy can't
 * upgrade Next's HMR WebSocket, so edits are picked up on reload rather than
 * pushed automatically — hence the explicit reload control in the chrome.
 */
export function DevPreviewRenderer({
    source,
    title,
    mode = "inline",
}: {
    source: string
    title?: string
    mode?: "inline" | "panel"
    artifactId?: string
}) {
    const parsed = React.useMemo(() => parseDevPreviewArtifact(source), [source])

    if (!parsed.ok) {
        return (
            <div className="my-1 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                    <p className="font-medium text-destructive">Live preview card failed to parse</p>
                    <p className="mt-0.5 break-words text-xs text-muted-foreground">{parsed.error}</p>
                </div>
            </div>
        )
    }

    return <DevPreviewFrame preview={parsed.value} fallbackTitle={title} mode={mode} />
}

function DevPreviewFrame({
    preview,
    fallbackTitle,
    mode,
}: {
    preview: DevPreviewArtifact
    fallbackTitle?: string
    mode: "inline" | "panel"
}) {
    const [reloadKey, setReloadKey] = React.useState(0)
    const [loading, setLoading] = React.useState(true)

    const localSrc = React.useMemo(() => devPreviewLocalSrc(preview), [preview])
    // A reload nonce forces a real navigation (re-sets the preview cookie) and
    // a fresh load state without exposing the nonce in the displayed URL chip.
    const iframeSrc = reloadKey === 0 ? localSrc : `${localSrc}&_r=${reloadKey}`
    const openUrl = preview.publicUrl || preview.lanUrl || localSrc
    const displayTitle = preview.title || fallbackTitle || "Live preview"

    const refresh = React.useCallback(() => {
        setLoading(true)
        setReloadKey((k) => k + 1)
    }, [])

    return (
        <div
            className={cn(
                "flex min-h-0 w-full flex-col overflow-hidden rounded-xl border border-border bg-background",
                mode === "panel" ? "h-full" : "my-2 h-[440px] max-h-[70vh]"
            )}
        >
            {/* Browser chrome */}
            <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2.5 py-1.5">
                <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-foreground">{displayTitle}</span>
                    <span className="hidden min-w-0 truncate rounded-md bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))] sm:inline">
                        {preview.basePath}/
                    </span>
                </div>
                <button
                    type="button"
                    onClick={refresh}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                    aria-label="Reload preview"
                    title="Reload preview"
                >
                    <RotateCw className="size-4" />
                </button>
                <a
                    href={openUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                    aria-label="Open preview in a new tab"
                    title="Open in new tab"
                >
                    <ExternalLink className="size-4" />
                </a>
            </div>

            {/* Live frame */}
            <div className="relative min-h-0 flex-1 bg-background">
                {loading ? (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-muted-foreground">
                        <Loader2 className="size-5 animate-spin" />
                        <span className="text-xs">Loading live preview…</span>
                    </div>
                ) : null}
                <iframe
                    key={reloadKey}
                    src={iframeSrc}
                    title={displayTitle}
                    onLoad={() => setLoading(false)}
                    className="size-full border-0 bg-white"
                    // The preview is the user's own generated site, served same-origin
                    // through our authenticated proxy, so it needs same-origin + scripts
                    // for real apps (localStorage, HMR client, client routing) to work.
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
                    allow="clipboard-read; clipboard-write; fullscreen"
                    referrerPolicy="no-referrer"
                />
            </div>
        </div>
    )
}
