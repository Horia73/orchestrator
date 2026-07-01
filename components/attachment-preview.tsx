"use client"

import * as React from "react"
import { FileText, X } from "lucide-react"
import { AudioPlayer } from "@/components/attachment-card"
import { PdfThumbnail } from "@/components/pdf-thumbnail"
import { appPath } from "@/lib/app-path"
import { cn } from "@/lib/utils"
import type { AttachedFile } from "@/hooks/use-file-attachments"

export function AttachmentSkeleton({ type }: { type: "image" | "pdf" | "file" }) {
    if (type === "image") {
        return <div className="size-[128px] rounded-lg bg-muted/40 animate-pulse" />
    }
    return (
        <div className="size-[128px] rounded-lg bg-muted/20 animate-pulse flex flex-col p-2.5 gap-1.5">
            <div className="flex-1 rounded bg-muted/40" />
            <div className="h-4 w-10 rounded bg-muted/40" />
        </div>
    )
}

export function AttachmentPreview({
    attachment,
    onRemove,
    onClick,
    onRendered,
}: {
    attachment: AttachedFile
    onRemove: () => void
    onClick?: () => void
    onRendered?: () => void
}) {
    const [hovered, setHovered] = React.useState(false)
    const fileName = attachment.file?.name ?? attachment.uploaded?.filename ?? "File"
    const serverUrl = attachment.uploaded
        ? appPath(`/api/uploads/${encodeURIComponent(attachment.uploaded.id)}`)
        : undefined
    const isLoading = attachment.uploading || attachment.rendering
    const errorLabel = attachment.error?.includes("no longer available") ? "File missing" : "Upload failed"

    if (attachment.uploading) {
        return (
            <div className="relative shrink-0">
                <AttachmentSkeleton type={attachment.type} />
            </div>
        )
    }

    // Audio attachments get the same inline player as in the sent message, so the
    // user can preview/play before sending instead of seeing a bare file chip.
    if (attachment.uploaded?.type === "audio" && serverUrl) {
        return (
            <div
                className="relative shrink-0 self-center"
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
            >
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onRemove() }}
                    className={cn(
                        "absolute -top-1.5 -left-1.5 z-10 flex size-5 items-center justify-center rounded-full bg-background border border-border shadow-sm text-muted-foreground transition-all duration-200 ease-out hover:text-foreground hover:bg-muted",
                        hovered ? "opacity-100 scale-100" : "opacity-0 scale-75"
                    )}
                    aria-label="Remove file"
                >
                    <X className="size-3" strokeWidth={2.5} />
                </button>
                <AudioPlayer url={serverUrl} />
            </div>
        )
    }

    return (
        <div
            className="relative shrink-0 cursor-pointer"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={onClick}
        >
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRemove() }}
                className={cn(
                    "absolute -top-1.5 -left-1.5 z-10 flex size-5 items-center justify-center rounded-full bg-background border border-border shadow-sm text-muted-foreground transition-all duration-200 ease-out hover:text-foreground hover:bg-muted",
                    hovered ? "opacity-100 scale-100" : "opacity-0 scale-75"
                )}
                aria-label="Remove file"
            >
                <X className="size-3" strokeWidth={2.5} />
            </button>

            {attachment.type === "image" && (attachment.previewUrl || serverUrl) ? (
                <div className="size-[128px] rounded-lg border border-border/60 overflow-hidden bg-muted/30">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={attachment.previewUrl || serverUrl}
                        alt={fileName}
                        className="size-full object-contain"
                    />
                </div>
            ) : attachment.type === "pdf" ? (
                <div className="relative size-[128px] rounded-lg border border-border/60 bg-white dark:bg-muted/20 overflow-hidden">
                    {isLoading && (
                        <div className="absolute inset-0 z-[5]">
                            <AttachmentSkeleton type="pdf" />
                        </div>
                    )}
                    <div className="w-full h-full overflow-hidden">
                        <PdfThumbnail file={attachment.file} url={serverUrl} onRendered={onRendered} />
                    </div>
                    <div className="absolute bottom-1.5 left-1.5 z-10">
                        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1.5 py-0.5 rounded border border-border/50 bg-white/90 dark:bg-background/90 backdrop-blur-xs">
                            PDF
                        </span>
                    </div>
                </div>
            ) : (
                <div className="flex flex-col items-start justify-between size-[128px] rounded-lg border border-border/60 bg-white dark:bg-muted/20 p-2.5">
                    <FileText className="size-5 text-muted-foreground" />
                    <div className="flex flex-col gap-0.5 min-w-0 w-full">
                        <span className="text-[11px] font-medium truncate w-full leading-tight">
                            {fileName}
                        </span>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                            {fileName.split(".").pop()?.toUpperCase() || "FILE"}
                        </span>
                    </div>
                </div>
            )}
            {attachment.error && (
                <div className="absolute inset-x-1.5 bottom-1.5 rounded-md border border-destructive/30 bg-background/95 px-1.5 py-1 text-[10px] font-medium text-destructive shadow-sm">
                    {errorLabel}
                </div>
            )}
        </div>
    )
}
