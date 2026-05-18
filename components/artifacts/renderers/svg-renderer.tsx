"use client"

import * as React from "react"
import DOMPurify from "isomorphic-dompurify"

import { cn } from "@/lib/utils"

/**
 * Render an SVG artifact. The content comes from the model so we run it
 * through DOMPurify before injection — strips <script>, on*= handlers, and
 * `javascript:` URLs while keeping the visual markup intact.
 *
 * isomorphic-dompurify is intentional: same package works server-side (SSR)
 * and in the browser, so the sanitised output is identical across renders.
 */
export function SvgRenderer({ source, className }: { source: string; className?: string }) {
    const sanitised = React.useMemo(() => {
        return DOMPurify.sanitize(source, {
            USE_PROFILES: { svg: true, svgFilters: true },
            // Belt-and-braces against script-y attrs the SVG profile already strips.
            FORBID_TAGS: ['script', 'foreignObject'],
            FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover'],
        })
    }, [source])

    return (
        <div
            className={cn("[&_svg]:h-auto [&_svg]:max-w-full", className)}
            dangerouslySetInnerHTML={{ __html: sanitised }}
        />
    )
}
