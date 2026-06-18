"use client"

import * as React from "react"

import { DevPreviewRenderer } from "@/components/artifacts/renderers/dev-preview-renderer"

/**
 * Dev-only preview surface for the `application/vnd.ant.dev-preview` mini-browser
 * renderer. Lets us iterate on the browser chrome (title, URL chip, reload /
 * open-in-new-tab, loading overlay) and the inline-vs-panel footprint without
 * spinning up a real managed preview + reverse proxy.
 *
 * The embedded iframe points at a `/dev-preview/...` path that has no running
 * preview locally, so it resolves to the proxy's "not found" text — that is
 * expected here; the point is the chrome, not live site content. Not linked
 * from anywhere; navigate to /dev/dev-preview-preview directly.
 */
const SAMPLE = JSON.stringify({
    runId: "new-demo-site-20260618",
    basePath: "/dev-preview/new-demo-site-20260618",
    token: "demo-token",
    publicUrl: "https://example.com/dev-preview/new-demo-site-20260618/?preview_token=demo-token",
    title: "Demo Next.js site",
})

export default function DevPreviewRendererPreviewPage() {
    const [mounted, setMounted] = React.useState(false)
    React.useEffect(() => setMounted(true), [])

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
            <header className="border-b border-border/40 pb-3">
                <h1 className="text-xl font-semibold tracking-tight">Dev-preview renderer</h1>
                <p className="text-xs text-muted-foreground">
                    Live mini-browser chrome for managed project-run / self-dev previews.
                </p>
            </header>

            <section className="flex flex-col gap-2">
                <h2 className="text-sm font-medium text-muted-foreground">Inline mode</h2>
                {mounted ? <DevPreviewRenderer source={SAMPLE} mode="inline" /> : null}
            </section>

            <section className="flex flex-col gap-2">
                <h2 className="text-sm font-medium text-muted-foreground">Panel mode (fills height)</h2>
                <div className="h-[480px]">
                    {mounted ? <DevPreviewRenderer source={SAMPLE} mode="panel" /> : null}
                </div>
            </section>
        </div>
    )
}
