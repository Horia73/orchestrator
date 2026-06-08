"use client"

import * as React from "react"
import { AlertTriangle } from "lucide-react"
import { ViewerFrame, ViewerToolbar } from "@/components/office/viewer-chrome"

/**
 * Backstop for the document viewers. If a renderer throws synchronously (a
 * malformed file, an unexpected library error), we never want a blank modal —
 * we degrade to the same "download the original" affordance the generic
 * attachment card offers. Async parse failures are handled inside each viewer;
 * this catches everything else.
 */
export class ViewerErrorBoundary extends React.Component<
    { filename: string; downloadUrl: string; onClose: () => void; children: React.ReactNode },
    { failed: boolean }
> {
    state = { failed: false }

    static getDerivedStateFromError() {
        return { failed: true }
    }

    componentDidCatch(error: unknown) {
        console.error("Document preview failed to render:", error)
    }

    render() {
        if (!this.state.failed) return this.props.children
        return (
            <ViewerFrame>
                <ViewerToolbar
                    filename={this.props.filename}
                    downloadUrl={this.props.downloadUrl}
                    onClose={this.props.onClose}
                />
                <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-pdf-text-muted">
                    <AlertTriangle className="size-7 text-amber-400" />
                    <p className="text-sm text-pdf-text">This file couldn&apos;t be previewed.</p>
                    <a
                        href={this.props.downloadUrl}
                        download={this.props.filename}
                        className="text-sm text-white underline underline-offset-2 hover:text-white/80"
                    >
                        Download {this.props.filename}
                    </a>
                </div>
            </ViewerFrame>
        )
    }
}
