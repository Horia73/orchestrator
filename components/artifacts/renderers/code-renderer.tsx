"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Code artifact renderer using Shiki. Highlight runs async; while it's
 * pending we show a plain monospace block so the user sees the raw code
 * immediately (no skeleton flash).
 *
 * Shiki ships a big set of languages — we accept whatever the model labels;
 * if it's not recognised Shiki falls back to plaintext on its own.
 */
const highlightCache = new Map<string, string>()

export function CodeRenderer({
    source,
    language,
    className,
}: {
    source: string
    language?: string | null
    className?: string
}) {
    const lang = (language ?? 'text').toLowerCase()
    const cacheKey = `${lang}:${source}`
    const [html, setHtml] = React.useState<string | null>(() => highlightCache.get(cacheKey) ?? null)

    React.useEffect(() => {
        if (highlightCache.has(cacheKey)) {
            setHtml(highlightCache.get(cacheKey)!)
            return
        }
        let cancelled = false
        // Dynamic import keeps Shiki out of the chat route's initial bundle;
        // the plain <pre> fallback below already shows the code instantly.
        import("shiki")
            .then(({ codeToHtml }) =>
                codeToHtml(source, { lang, theme: 'github-light' })
            )
            .then(result => {
                if (cancelled) return
                highlightCache.set(cacheKey, result)
                setHtml(result)
            })
            .catch(() => { /* leave fallback */ })
        return () => { cancelled = true }
    }, [cacheKey, source, lang])

    if (html) {
        return (
            <div
                className={cn(
                    "overflow-x-auto rounded-lg border border-border/60 bg-muted/30 p-3 text-[12.5px] [&_pre]:!bg-transparent [&_pre]:!m-0",
                    className
                )}
                dangerouslySetInnerHTML={{ __html: html }}
            />
        )
    }
    return (
        <pre className={cn(
            "overflow-x-auto rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-[12.5px] leading-relaxed text-foreground/85",
            className
        )}>
            {source}
        </pre>
    )
}
