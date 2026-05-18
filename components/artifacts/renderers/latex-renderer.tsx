"use client"

import * as React from "react"
import katex from "katex"
import "katex/dist/katex.min.css"

import { cn } from "@/lib/utils"

/**
 * Render a standalone LaTeX artifact (block math). KaTeX's library renders
 * fast and synchronously — no need to lazy-load.
 *
 * `displayMode` = true forces block layout (\\begin{equation} style) rather
 * than inline math. The model is producing a full LaTeX artifact, not
 * inline-mixed prose.
 */
export function LatexRenderer({ source, className }: { source: string; className?: string }) {
    const html = React.useMemo(() => {
        try {
            return katex.renderToString(source, {
                displayMode: true,
                throwOnError: false,
                output: 'html',
            })
        } catch (err) {
            return `<span class="text-destructive">LaTeX render failed: ${err instanceof Error ? err.message : 'unknown'}</span>`
        }
    }, [source])
    return (
        <div
            className={cn("overflow-x-auto py-2", className)}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    )
}
