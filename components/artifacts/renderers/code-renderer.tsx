"use client"

import { useShikiHighlight } from "@/hooks/use-shiki-highlight"
import { cn } from "@/lib/utils"

/**
 * Code artifact renderer using Shiki. Highlight runs async; while it's
 * pending we show a plain monospace block so the user sees the raw code
 * immediately (no skeleton flash).
 *
 * Shiki ships a big set of languages — we accept whatever the model labels;
 * if it's not recognised Shiki falls back to plaintext on its own.
 */
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
    const html = useShikiHighlight(source, lang)

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
