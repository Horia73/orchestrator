"use client"

import * as React from "react"
import { Download, X } from "lucide-react"
import { cn } from "@/lib/utils"

/** Shared button styling for every in-modal document viewer toolbar — kept
 *  identical to the PDF viewer's toolbar so the office/code viewers feel like
 *  one consistent surface. */
export const toolbarBtnCls =
    "flex size-8 items-center justify-center rounded text-pdf-text hover:bg-pdf-hover hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none"

/** Outer frame every viewer renders into: dark canvas, column layout, rounded
 *  to match the modal shell. */
export function ViewerFrame({ children }: { children: React.ReactNode }) {
    return (
        <section
            className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg bg-pdf-canvas text-pdf-text"
            onClick={(e) => e.stopPropagation()}
        >
            {children}
        </section>
    )
}

/** A consistent toolbar: file title on the left, caller-supplied controls in
 *  the middle, then Download (original file) + Close on the right. */
export function ViewerToolbar({
    icon,
    filename,
    badge,
    children,
    downloadUrl,
    downloadName,
    onClose,
}: {
    icon?: React.ReactNode
    filename: string
    badge?: React.ReactNode
    children?: React.ReactNode
    downloadUrl?: string
    downloadName?: string
    onClose: () => void
}) {
    return (
        <header className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-pdf-border bg-pdf-toolbar px-3 py-2 select-none">
            <div className="flex min-w-0 flex-1 items-center gap-2">
                {icon}
                <span className="truncate text-sm font-medium text-pdf-text" title={filename}>
                    {filename}
                </span>
                {badge}
            </div>
            <div className="flex shrink-0 items-center gap-1">
                {children}
                {downloadUrl ? (
                    <a
                        href={downloadUrl}
                        download={downloadName ?? filename}
                        className={toolbarBtnCls}
                        aria-label="Download"
                        title="Download"
                    >
                        <Download className="size-4" />
                    </a>
                ) : null}
                <button type="button" onClick={onClose} className={toolbarBtnCls} aria-label="Close" title="Close">
                    <X className="size-4" />
                </button>
            </div>
        </header>
    )
}

/** Small uppercase format chip (XLSX / DOCX / PPTX …) shown next to the title. */
export function FormatBadge({ label, className }: { label: string; className?: string }) {
    return (
        <span
            className={cn(
                "shrink-0 rounded border border-white/15 bg-black/25 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-pdf-text-muted",
                className
            )}
        >
            {label}
        </span>
    )
}
