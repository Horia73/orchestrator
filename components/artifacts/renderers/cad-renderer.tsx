"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { Download, Loader2, TriangleAlert } from "lucide-react"

import { cn } from "@/lib/utils"
import { appApiPath } from "@/lib/app-path"
import { parseCadArtifact, cadFileLabel, type CadArtifact } from "@/lib/cad/schema"

// three.js is heavy (~600 kB) — load the viewer only when a CAD artifact is
// actually on screen instead of shipping it with the chat bundle.
const CadModelViewer = dynamic(
    () => import("@/components/cad/cad-model-viewer"),
    {
        ssr: false,
        loading: () => (
            <div className="flex h-full w-full items-center justify-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
        ),
    }
)

/**
 * Renderer for `application/vnd.ant.cad` — an interactive 3D viewer card for
 * CAD parts the agent generated in the workspace (GLB for viewing, STEP/STL/
 * 3MF chips for download). Read-only viewer: orbit/zoom/pan/grid/wireframe.
 */
export function CadRenderer({
    source,
    mode = "inline",
}: {
    source: string
    title?: string
    mode?: "inline" | "panel"
    artifactId?: string
}) {
    const parsed = React.useMemo(() => parseCadArtifact(source), [source])

    if (!parsed.ok) {
        return (
            <div className="my-1 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                    <p className="font-medium text-destructive">CAD model card failed to parse</p>
                    <p className="mt-0.5 break-words text-xs text-muted-foreground">{parsed.error}</p>
                </div>
            </div>
        )
    }

    return <CadCard cad={parsed.value} mode={mode} />
}

function workspaceFileUrl(path: string): string {
    return appApiPath("/api/workspace/files", { path })
}

function CadCard({ cad, mode }: { cad: CadArtifact; mode: "inline" | "panel" }) {
    const files = cad.files ?? []

    return (
        <div
            className={cn(
                "flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card",
                mode === "panel" && "h-full"
            )}
        >
            <div
                className={cn(
                    "relative w-full bg-muted/40",
                    mode === "panel" ? "min-h-[320px] flex-1" : "h-[320px] md:h-[400px]"
                )}
            >
                <CadModelViewer
                    src={workspaceFileUrl(cad.model.glb)}
                    format="glb"
                    dimensionsMm={cad.boundingBoxMm ?? null}
                />
            </div>

            <div className="flex flex-col gap-2 border-t border-border px-3.5 py-3">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <h3 className="min-w-0 break-words text-sm font-semibold leading-snug">{cad.name}</h3>
                    {cad.partCount != null && cad.partCount > 1 && (
                        <span className="shrink-0 text-xs text-muted-foreground">{cad.partCount} parts</span>
                    )}
                </div>

                {cad.description && (
                    <p className="text-[13px] leading-relaxed text-muted-foreground">{cad.description}</p>
                )}

                {files.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {files.map((file) => (
                            <a
                                key={file.path}
                                href={workspaceFileUrl(file.path)}
                                download
                                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                                title={file.path}
                            >
                                <Download className="size-3 text-muted-foreground" />
                                {cadFileLabel(file)}
                            </a>
                        ))}
                    </div>
                )}

                {cad.notes && cad.notes.length > 0 && (
                    <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                        {cad.notes.map((note, i) => (
                            <li key={i}>{note}</li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    )
}
