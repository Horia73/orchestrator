"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import { AppLinkRenderer } from "./renderers/app-link-renderer"
import { CadRenderer } from "./renderers/cad-renderer"
import { CodeRenderer } from "./renderers/code-renderer"
import { CsvRenderer } from "./renderers/csv-renderer"
import { DevPreviewRenderer } from "./renderers/dev-preview-renderer"
import { HtmlSandboxRenderer } from "./renderers/html-sandbox-renderer"
import { JsonRenderer } from "./renderers/json-renderer"
import { LatexRenderer } from "./renderers/latex-renderer"
import { MapRenderer } from "./renderers/map-renderer"
import { MarkdownArtifactRenderer } from "./renderers/markdown-artifact-renderer"
import { MermaidRenderer } from "./renderers/mermaid-renderer"
import { QuestionRenderer } from "./renderers/question-renderer"
import { ReactSandboxRenderer } from "./renderers/react-sandbox-renderer"
import { RecipeRenderer } from "./renderers/recipe-renderer"
import { SvgRenderer } from "./renderers/svg-renderer"
import { WeatherRenderer } from "./renderers/weather-renderer"
import { WorkoutRenderer } from "./renderers/workout-renderer"

/**
 * Inline artifact placement.
 *
 * Renders the artifact body directly into the message flow with no card
 * chrome — no border, no header row, no per-card buttons. The MessageBubble
 * surfaces copy/download/expand affordances in its hover meta row (next to
 * the existing message-copy button) so a chat with an artifact reads as one
 * continuous message instead of an inset widget.
 *
 * `onExpand` is unused here but kept on the prop type so call sites can
 * thread it through to the meta-row buttons via the helper below.
 */
export function ArtifactInline({
    artifact,
    className,
}: {
    artifact: ArtifactRow
    onExpand?: (a: ArtifactRow) => void
    className?: string
}) {
    return (
        <div className={cn("my-2 min-w-0", className)}>
            <ArtifactBody artifact={artifact} />
        </div>
    )
}

/**
 * Trigger a browser download of the artifact body using a Blob URL. Filename
 * uses the model's identifier + the right extension for the MIME type.
 */
export function downloadArtifact(artifact: ArtifactRow): void {
    const blob = new Blob([artifact.content], { type: artifact.type || 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filenameFor(artifact)
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
}

/**
 * Pure renderer router — no card chrome. Used inside the side panel where
 * the panel itself supplies the chrome.
 *
 * `mode` only affects the runtime-y renderers (HTML / React sandbox iframes):
 *   - 'inline' (default): caps height at 720px and shows a 240px loader so
 *                         a giant artifact in chat doesn't take over the
 *                         scroll.
 *   - 'panel': no height cap, loader fills the parent — the side panel
 *              handles overflow.
 */
export function ArtifactBody({
    artifact,
    mode = 'inline',
}: {
    artifact: ArtifactRow
    mode?: 'inline' | 'panel'
}) {
    const t = artifact.type
    const content = artifact.content
    const sandboxMode = mode === 'panel' ? 'unbounded' : 'bounded'

    switch (t) {
        case 'text/markdown':
            return <MarkdownArtifactRenderer source={content} />
        case 'application/vnd.ant.mermaid':
            return <MermaidRenderer source={content} />
        case 'image/svg+xml':
            return <SvgRenderer source={content} />
        case 'text/csv':
            return <CsvRenderer source={content} />
        case 'application/json':
            return <JsonRenderer source={content} />
        case 'application/x-latex':
            return <LatexRenderer source={content} />
        case 'application/vnd.ant.code':
            return <CodeRenderer source={content} language={artifact.language} />
        case 'text/html':
            return <HtmlSandboxRenderer source={content} title={artifact.title} mode={sandboxMode} artifactId={artifact.id} />
        case 'application/vnd.ant.react':
            return <ReactSandboxRenderer source={content} title={artifact.title} mode={sandboxMode} artifactId={artifact.id} />
        case 'application/vnd.ant.app-link':
            return <AppLinkRenderer source={content} />
        case 'application/vnd.ant.map':
            return <MapRenderer source={content} title={artifact.title} mode={mode} artifactId={artifact.id} />
        case 'application/vnd.ant.weather':
            return <WeatherRenderer source={content} title={artifact.title} mode={mode} artifactId={artifact.id} />
        case 'application/vnd.ant.recipe':
            return <RecipeRenderer source={content} title={artifact.title} mode={mode} artifactId={artifact.id} />
        case 'application/vnd.ant.workout':
            return <WorkoutRenderer source={content} title={artifact.title} mode={mode} artifactId={artifact.id} />
        case 'application/vnd.ant.cad':
            return <CadRenderer source={content} title={artifact.title} mode={mode} artifactId={artifact.id} />
        case 'application/vnd.ant.question':
            return <QuestionRenderer artifact={artifact} />
        case 'application/vnd.ant.dev-preview':
            return <DevPreviewRenderer source={content} title={artifact.title} mode={mode} artifactId={artifact.id} />
        case 'application/xml':
        case 'text/vnd.graphviz':
            // No first-class renderer yet — fall through to syntax-highlighted code.
            return <CodeRenderer source={content} language={t.includes('xml') ? 'xml' : 'dot'} />
        default:
            return <CodeRenderer source={content} language={artifact.language ?? 'text'} />
    }
}

function filenameFor(a: ArtifactRow): string {
    const base = a.identifier.replace(/[^a-z0-9_-]+/gi, '-')
    const ext = extensionFor(a.type, a.language)
    return `${base}${ext ? '.' + ext : ''}`
}

function extensionFor(mime: string, language?: string | null): string {
    switch (mime) {
        case 'text/markdown': return 'md'
        case 'application/vnd.ant.mermaid': return 'mmd'
        case 'image/svg+xml': return 'svg'
        case 'text/csv': return 'csv'
        case 'application/json': return 'json'
        case 'application/x-latex': return 'tex'
        case 'text/html': return 'html'
        case 'application/vnd.ant.react': return 'tsx'
        case 'application/vnd.ant.map': return 'json'
        case 'application/vnd.ant.weather': return 'json'
        case 'application/vnd.ant.recipe': return 'json'
        case 'application/vnd.ant.workout': return 'json'
        case 'application/vnd.ant.cad': return 'json'
        case 'application/vnd.ant.dev-preview': return 'json'
        case 'application/vnd.ant.app-link': return 'json'
        case 'application/vnd.ant.code': return language || 'txt'
        case 'application/xml': return 'xml'
        case 'text/vnd.graphviz': return 'dot'
        default: return language || 'txt'
    }
}
