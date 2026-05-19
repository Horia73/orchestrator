"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Render an SVG artifact. The content comes from the model so we run it
 * through DOMPurify before injection — strips <script>, on*= handlers, and
 * `javascript:` URLs while keeping the visual markup intact.
 *
 * DOMPurify is imported lazily on the client only. A static import pulls in
 * isomorphic-dompurify → jsdom, whose transitive deps mix ESM/CJS and crash
 * SSR module evaluation under turbopack. Sanitisation is deterministic
 * regardless of where it runs, and the real XSS protection is sanitising
 * before the browser parses the markup — which still happens here. We never
 * inject `source`; the node stays empty until the sanitised result is ready.
 */
type DOMPurifyLike = { sanitize: (s: string, cfg?: unknown) => string }
let dompurifyPromise: Promise<DOMPurifyLike> | null = null
function loadDOMPurify(): Promise<DOMPurifyLike> {
    dompurifyPromise ??= import("isomorphic-dompurify").then(
        (m) => (m.default ?? m) as unknown as DOMPurifyLike
    )
    return dompurifyPromise
}

export function SvgRenderer({ source, className }: { source: string; className?: string }) {
    const [sanitised, setSanitised] = React.useState<string | null>(null)

    React.useEffect(() => {
        let cancelled = false
        void loadDOMPurify().then((DOMPurify) => {
            if (cancelled) return
            setSanitised(
                DOMPurify.sanitize(source, {
                    USE_PROFILES: { svg: true, svgFilters: true },
                    // Belt-and-braces against script-y attrs the SVG profile
                    // already strips.
                    FORBID_TAGS: ["script", "foreignObject"],
                    FORBID_ATTR: ["onload", "onerror", "onclick", "onmouseover"],
                })
            )
        })
        return () => {
            cancelled = true
        }
    }, [source])

    return (
        <div
            className={cn("[&_svg]:h-auto [&_svg]:max-w-full", className)}
            {...(sanitised != null
                ? { dangerouslySetInnerHTML: { __html: sanitised } }
                : {})}
        />
    )
}
