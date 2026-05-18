"use client"

import * as React from "react"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { cn } from "@/lib/utils"

/**
 * Thin wrapper over the existing MarkdownRenderer. We keep it as a separate
 * file so the artifact renderer registry stays uniform (every type has its
 * own component); swapping the markdown stack later doesn't ripple through
 * the registry.
 */
export function MarkdownArtifactRenderer({ source, className }: { source: string; className?: string }) {
    return (
        <div className={cn("artifact-markdown", className)}>
            <MarkdownRenderer content={source} />
        </div>
    )
}
