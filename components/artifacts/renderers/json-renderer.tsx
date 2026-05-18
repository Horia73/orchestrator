"use client"

import * as React from "react"
import { CodeRenderer } from "./code-renderer"

/**
 * JSON artifact — pretty-print + syntax highlight via Shiki.
 * Falls back to raw text when parsing fails so a malformed artifact still
 * shows its content instead of throwing.
 */
export function JsonRenderer({ source, className }: { source: string; className?: string }) {
    const formatted = React.useMemo(() => {
        try {
            return JSON.stringify(JSON.parse(source), null, 2)
        } catch {
            return source
        }
    }, [source])
    return <CodeRenderer source={formatted} language="json" className={className} />
}
