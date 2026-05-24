"use client"

import * as React from "react"
import {
    Check,
    ChevronDown,
    Code,
    Copy,
    Download,
    ExternalLink,
    Eye,
    Maximize2,
    Minimize2,
    X,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { copyTextToClipboard } from "@/lib/clipboard"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import { ArtifactBody } from "./artifact-inline"
import { CodeRenderer } from "./renderers/code-renderer"
import { useConversationArtifacts } from "./use-conversation-artifacts"

/**
 * Artifact types whose renderer produces a different visual output than
 * the raw source (code is compiled, executed, or otherwise transformed).
 * For these we show a Preview/Code toggle in the panel header so users can
 * read the source without exporting the artifact.
 *
 * Textual types (markdown, code, csv, json, latex) are deliberately omitted
 * — the "preview" already IS the source, so a toggle would just duplicate
 * the view.
 */
const SOURCE_TOGGLEABLE_TYPES = new Set([
    'application/vnd.ant.react',
    'text/html',
    'application/vnd.ant.mermaid',
    'application/vnd.ant.map',
    'application/vnd.ant.weather',
    'image/svg+xml',
    'text/vnd.graphviz',
])

function sourceLanguageFor(artifact: ArtifactRow): string {
    if (artifact.language) return artifact.language
    switch (artifact.type) {
        case 'application/vnd.ant.react': return 'tsx'
        case 'text/html': return 'html'
        case 'application/vnd.ant.mermaid': return 'text'
        case 'application/vnd.ant.map': return 'json'
        case 'application/vnd.ant.weather': return 'json'
        case 'image/svg+xml': return 'xml'
        case 'text/vnd.graphviz': return 'dot'
        default: return 'text'
    }
}

/**
 * Side-pane artifact viewer.
 *
 * Reads the current artifact from props and the version chain from the
 * conversation context — that lets us render a dropdown of historical
 * versions without the parent having to thread them through.
 *
 * The panel is purely a presentation layer: open/close state lives in the
 * page (so the chat-view can layout its split). `onClose` and `onSelect` let
 * the page swap the active artifact when the user picks a different version.
 */
export function ArtifactPanel({
    artifact,
    onClose,
    onSelect,
    onFullscreenToggle,
    fullscreen = false,
    className,
}: {
    artifact: ArtifactRow
    onClose: () => void
    onSelect?: (a: ArtifactRow) => void
    onFullscreenToggle?: () => void
    fullscreen?: boolean
    className?: string
}) {
    const { versionsByIdentifier } = useConversationArtifacts()
    const versions = versionsByIdentifier.get(artifact.identifier) ?? [artifact]
    const [versionMenuOpen, setVersionMenuOpen] = React.useState(false)
    const versionMenuRef = React.useRef<HTMLDivElement>(null)
    // Preview vs raw-source toggle. Default to preview for runtime-y types so
    // opening an artifact shows the rendered output first; Code mode is one
    // click away. Resets to preview whenever the artifact identity changes so
    // switching versions doesn't strand the user on the wrong view.
    const canToggleSource = SOURCE_TOGGLEABLE_TYPES.has(artifact.type)
    const [showSource, setShowSource] = React.useState(false)
    React.useEffect(() => { setShowSource(false) }, [artifact.id])

    React.useEffect(() => {
        function onClick(e: MouseEvent) {
            if (!versionMenuOpen) return
            if (versionMenuRef.current && !versionMenuRef.current.contains(e.target as Node)) {
                setVersionMenuOpen(false)
            }
        }
        document.addEventListener('mousedown', onClick)
        return () => document.removeEventListener('mousedown', onClick)
    }, [versionMenuOpen])

    const [copied, setCopied] = React.useState(false)
    const handleCopy = async () => {
        if (!await copyTextToClipboard(artifact.content)) return
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
    }
    const handleDownload = () => {
        const blob = new Blob([artifact.content], { type: artifact.type || 'text/plain' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${artifact.identifier}-v${artifact.version}`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
    }

    return (
        <aside
            className={cn(
                "flex h-full min-h-0 flex-col bg-background",
                "border-l border-border/70",
                fullscreen && "fixed inset-0 z-50 border-l-0",
                className
            )}
        >
            <header className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-3 py-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold text-foreground" title={artifact.title}>
                            {artifact.title}
                        </div>
                        <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-foreground/45">
                            <span>{prettyType(artifact.type)}</span>
                            {versions.length > 1 ? (
                                <div ref={versionMenuRef} className="relative">
                                    <button
                                        onClick={() => setVersionMenuOpen(o => !o)}
                                        className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-foreground/70 hover:bg-muted hover:text-foreground"
                                    >
                                        v{artifact.version} of {versions.length}
                                        <ChevronDown className="size-3" />
                                    </button>
                                    {versionMenuOpen && (
                                        <div className="absolute left-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-lg border border-border/70 bg-card shadow-lg">
                                            {versions.slice().reverse().map(v => (
                                                <button
                                                    key={v.id}
                                                    onClick={() => {
                                                        setVersionMenuOpen(false)
                                                        onSelect?.(v)
                                                    }}
                                                    className={cn(
                                                        "flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-muted",
                                                        v.id === artifact.id && "bg-muted font-medium"
                                                    )}
                                                >
                                                    <span>v{v.version}</span>
                                                    <span className="text-[10.5px] text-foreground/45 tabular-nums">
                                                        {new Date(v.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <span>v{artifact.version}</span>
                            )}
                        </div>
                        {artifact.filePath && (
                            <div className="mt-0.5 truncate text-[10.5px] normal-case tracking-normal text-foreground/40" title={artifact.filePath}>
                                {artifact.filePath}
                            </div>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-0.5">
                    {canToggleSource && (
                        <div className="mr-1 flex items-center rounded-md border border-border/60 bg-background p-0.5">
                            <ToggleButton
                                active={!showSource}
                                onClick={() => setShowSource(false)}
                                title="Show rendered preview"
                            >
                                <Eye className="size-3.5" />
                                <span className="text-[11px] font-medium">Preview</span>
                            </ToggleButton>
                            <ToggleButton
                                active={showSource}
                                onClick={() => setShowSource(true)}
                                title="Show source code"
                            >
                                <Code className="size-3.5" />
                                <span className="text-[11px] font-medium">Code</span>
                            </ToggleButton>
                        </div>
                    )}
                    <IconButton onClick={handleCopy} title={copied ? "Copied" : "Copy"}>
                        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    </IconButton>
                    <IconButton onClick={handleDownload} title="Download">
                        <Download className="size-3.5" />
                    </IconButton>
                    <IconButton
                        onClick={() => window.open(`/artifact/${artifact.id}`, "_blank", "noopener,noreferrer")}
                        title="Open in new tab"
                    >
                        <ExternalLink className="size-3.5" />
                    </IconButton>
                    {onFullscreenToggle && (
                        <IconButton onClick={onFullscreenToggle} title={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
                            {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                        </IconButton>
                    )}
                    <IconButton onClick={onClose} title="Close">
                        <X className="size-4" />
                    </IconButton>
                </div>
            </header>
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
                {showSource ? (
                    <CodeRenderer source={artifact.content} language={sourceLanguageFor(artifact)} />
                ) : (
                    <ArtifactBody artifact={artifact} mode="panel" />
                )}
            </div>
        </aside>
    )
}

function ToggleButton({
    active,
    onClick,
    title,
    children,
}: {
    active: boolean
    onClick: () => void
    title: string
    children: React.ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={title}
            aria-pressed={active}
            className={cn(
                "flex items-center gap-1 rounded-[5px] px-2 py-1 transition-colors",
                active
                    ? "bg-muted text-foreground"
                    : "text-foreground/55 hover:bg-muted/50 hover:text-foreground"
            )}
        >
            {children}
        </button>
    )
}

function IconButton({ onClick, title, children }: {
    onClick: () => void
    title: string
    children: React.ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={title}
            aria-label={title}
            className="flex size-7 items-center justify-center rounded-md text-foreground/55 transition-colors hover:bg-muted hover:text-foreground"
        >
            {children}
        </button>
    )
}

function prettyType(mime: string): string {
    switch (mime) {
        case 'text/markdown': return 'markdown'
        case 'application/vnd.ant.mermaid': return 'mermaid'
        case 'image/svg+xml': return 'svg'
        case 'text/csv': return 'csv'
        case 'application/json': return 'json'
        case 'application/x-latex': return 'latex'
        case 'application/vnd.ant.code': return 'code'
        case 'text/html': return 'html'
        case 'application/vnd.ant.react': return 'react'
        case 'application/vnd.ant.map': return 'map'
        case 'application/vnd.ant.weather': return 'weather'
        case 'application/xml': return 'xml'
        case 'text/vnd.graphviz': return 'graphviz'
        default: return mime
    }
}
