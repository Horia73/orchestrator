"use client"

import * as React from "react"
import { AlertCircle, Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Mermaid is ~200KB. Lazy-load on mount so the first chat page render isn't
 * blocked by the import. The Mermaid singleton is cached at module scope —
 * we don't re-initialise per render.
 */
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null

function loadMermaid() {
    if (!mermaidPromise) {
        mermaidPromise = import("mermaid").then(mod => {
            const m = mod.default
            m.initialize({
                startOnLoad: false,
                theme: "default",
                securityLevel: "strict",
                fontFamily: "inherit",
            })
            return m
        })
    }
    return mermaidPromise
}

export function MermaidRenderer({ source, className }: { source: string; className?: string }) {
    const [svg, setSvg] = React.useState<string | null>(null)
    const [error, setError] = React.useState<string | null>(null)
    const reactId = React.useId()
    const renderId = React.useMemo(() => `m-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`, [reactId])

    React.useEffect(() => {
        let cancelled = false
        loadMermaid()
            .then(m => m.render(renderId, source))
            .then(result => {
                if (cancelled) return
                setSvg(result.svg)
                setError(null)
            })
            .catch(err => {
                if (cancelled) return
                setError(err instanceof Error ? err.message : "Failed to render diagram")
            })
        return () => { cancelled = true }
    }, [renderId, source])

    if (error) {
        return (
            <div className={cn("flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12.5px] text-amber-700 dark:text-amber-400", className)}>
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <div>
                    <div className="font-medium">Mermaid render failed</div>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] opacity-80">{error}</pre>
                </div>
            </div>
        )
    }

    if (!svg) {
        return (
            <div className={cn("flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-4 text-[12.5px] text-foreground/55", className)}>
                <Loader2 className="size-3.5 animate-spin" />
                Rendering diagram…
            </div>
        )
    }

    // Mermaid produces sanitised SVG; injecting via innerHTML is safe.
    return (
        <div
            className={cn("[&_svg]:max-w-full [&_svg]:h-auto", className)}
            dangerouslySetInnerHTML={{ __html: svg }}
        />
    )
}
