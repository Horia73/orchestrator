"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Render a standalone LaTeX artifact (block math). KaTeX renders fast, but the
 * library itself is ~280 KB — load it on demand so it stays out of the chat
 * route's initial bundle (LaTeX artifacts are rare).
 *
 * `displayMode` = true forces block layout (\\begin{equation} style) rather
 * than inline math. The model is producing a full LaTeX artifact, not
 * inline-mixed prose.
 */

type KatexModule = typeof import("katex").default

let katexCached: KatexModule | null = null
let katexLoading: Promise<KatexModule> | null = null

// Same CDN stylesheet the markdown renderer uses for inline math — loaded
// once, on demand, instead of bundling katex.min.css into the route CSS.
let katexCssLoaded = false
function ensureKatexCss() {
    if (katexCssLoaded || typeof document === "undefined") return
    katexCssLoaded = true
    const link = document.createElement("link")
    link.rel = "stylesheet"
    link.href = "https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css"
    link.crossOrigin = "anonymous"
    document.head.appendChild(link)
}

function loadKatex(): Promise<KatexModule> {
    ensureKatexCss()
    if (!katexLoading) {
        katexLoading = import("katex").then((mod) => {
            katexCached = mod.default
            return mod.default
        })
    }
    return katexLoading
}

export function LatexRenderer({ source, className }: { source: string; className?: string }) {
    const [katex, setKatex] = React.useState<KatexModule | null>(katexCached)

    React.useEffect(() => {
        if (katex) return
        let cancelled = false
        void loadKatex().then((mod) => {
            if (!cancelled) setKatex(() => mod)
        })
        return () => {
            cancelled = true
        }
    }, [katex])

    const html = React.useMemo(() => {
        if (!katex) return null
        try {
            return katex.renderToString(source, {
                displayMode: true,
                throwOnError: false,
                output: 'html',
            })
        } catch (err) {
            return `<span class="text-destructive">LaTeX render failed: ${err instanceof Error ? err.message : 'unknown'}</span>`
        }
    }, [katex, source])

    if (html == null) {
        return (
            <pre className={cn("overflow-x-auto py-2 font-mono text-[12.5px] text-foreground/70", className)}>
                {source}
            </pre>
        )
    }
    return (
        <div
            className={cn("overflow-x-auto py-2", className)}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    )
}
