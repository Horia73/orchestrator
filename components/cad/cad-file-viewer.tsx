"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { Box, Loader2 } from "lucide-react"

import { ViewerFrame, ViewerToolbar, FormatBadge } from "@/components/office/viewer-chrome"
import { cadModelFormatFor } from "@/components/cad/cad-model-format"

const CadModelViewer = dynamic(
    () => import("@/components/cad/cad-model-viewer"),
    {
        ssr: false,
        loading: () => (
            <div className="flex h-full w-full items-center justify-center">
                <Loader2 className="size-6 animate-spin text-pdf-text-muted" />
            </div>
        ),
    }
)

/**
 * Full-modal preview for 3D model files (.glb / .stl / .3mf) — the Library /
 * attachment counterpart of the CAD artifact card. Same interactive viewer,
 * wrapped in the shared document-viewer chrome.
 */
export function CadFileViewer({ url, filename, onClose }: { url: string; filename: string; onClose: () => void }) {
    const format = cadModelFormatFor(filename)

    return (
        <ViewerFrame>
            <ViewerToolbar
                icon={<Box className="size-4 shrink-0 text-pdf-text-muted" />}
                filename={filename}
                badge={<FormatBadge label={format?.toUpperCase() ?? "3D"} />}
                downloadUrl={url}
                downloadName={filename}
                onClose={onClose}
            />
            <div className="relative min-h-0 flex-1">
                {format ? (
                    <CadModelViewer src={url} format={format} />
                ) : (
                    <div className="flex h-full items-center justify-center text-sm text-pdf-text-muted">
                        Unsupported 3D format
                    </div>
                )}
            </div>
        </ViewerFrame>
    )
}
