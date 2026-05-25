"use client"

import * as React from "react"
import { ExternalLink } from "lucide-react"

import type { ArtifactOpenAttrs, ArtifactRow } from "@/lib/artifacts/schema"
import { ArtifactParser } from "@/lib/artifacts/parser"
import { decideRowRenderTarget } from "@/lib/artifacts/render-decision"
import { ArtifactInline } from "./artifact-inline"
import { MarkdownRenderer } from "@/components/markdown-renderer"
import { useConversationArtifacts } from "./use-conversation-artifacts"

interface RenderArgs {
    /** Raw assistant content (may contain `<artifact>` tags). */
    content: string
    /**
     * Message id the content belongs to. We use it to look up only the
     * artifacts produced by THIS message — that way an artifact reused later
     * in the conversation doesn't accidentally show in an earlier bubble.
     */
    messageId: string
    onExpand?: (a: ArtifactRow) => void
    suppressArtifactTypes?: string[]
}

/**
 * Render an assistant message's textual content, replacing each
 * `<artifact>` block with the matching `ArtifactInline` card.
 *
 * Strategy:
 *   1. Run the message text through the same parser used server-side. Out
 *      come prose runs and artifact-start/end markers in order.
 *   2. Build an in-order array of "prose segment" or "artifact placeholder"
 *      pieces and render each appropriately.
 *   3. For artifact placeholders, look up the row in the ConversationArtifacts
 *      provider by (identifier, version). The chat SSE bridge pushes new rows
 *      into that provider as `artifact_end` fires, so live and reloaded
 *      messages render identically.
 *
 * If a placeholder doesn't have a matching row yet (mid-stream before
 * `artifact_end`), we render a "Generating artifact…" stub so users see
 * something happening.
 */
export function RenderMessageContent({ content, messageId, onExpand, suppressArtifactTypes }: RenderArgs) {
    const { byMessage } = useConversationArtifacts()
    const rowsForMessage = React.useMemo(() => byMessage.get(messageId) ?? [], [byMessage, messageId])
    const suppressedTypes = React.useMemo(
        () => new Set(suppressArtifactTypes ?? []),
        [suppressArtifactTypes]
    )

    // Map identifier → artifact row for this message. Multiple versions in
    // the same message would be unusual but possible — we keep the latest
    // one, which matches the per-conv "latestByIdentifier" semantics.
    const rowByIdentifier = React.useMemo(() => {
        const m = new Map<string, ArtifactRow>()
        for (const r of rowsForMessage) {
            const existing = m.get(r.identifier)
            if (!existing || r.version > existing.version) m.set(r.identifier, r)
        }
        return m
    }, [rowsForMessage])

    const segments = React.useMemo(() => parseContentToSegments(content), [content])

    return (
        <>
            {segments.map((seg, i) => {
                if (seg.kind === "prose") {
                    if (!seg.text.trim()) return null
                    return <MarkdownRenderer key={`p-${i}`} content={seg.text} />
                }
                if (suppressedTypes.has(seg.attrs.type)) {
                    return (
                        <SuppressedArtifactNotice
                            key={`s-${i}-${seg.attrs.identifier}`}
                            title={seg.attrs.title}
                            type={seg.attrs.type}
                        />
                    )
                }
                // Prefer the persisted row when it has landed — it carries the
                // canonical sanitised content + version metadata. While the
                // model is still streaming the body, synthesise a transient
                // row from the parsed segment so the card renders live.
                const realRow = rowByIdentifier.get(seg.attrs.identifier)
                // While the body is mid-stream, route runtime-y types (React,
                // HTML, mermaid) through application/vnd.ant.code so the
                // sandboxed iframe isn't asked to compile half-written JSX on
                // every token. Markdown / SVG / CSV stay live — they fail
                // gracefully on partial input.
                //
                // Map and weather artifacts are JSON-bodied. Showing them as
                // streamed code makes the user stare at a one-line horizontally
                // scrolling JSON until the close tag lands; a friendly
                // "building map / weather" placeholder is much better UX while
                // the model fills in the body.
                const streaming = !seg.closed && !realRow
                const isPlaceholderTarget = streaming && PLACEHOLDER_TYPES.has(seg.attrs.type)
                if (isPlaceholderTarget) {
                    return (
                        <StreamingPlaceholder
                            key={`p-${i}-${seg.attrs.identifier}`}
                            type={seg.attrs.type}
                            title={seg.attrs.title}
                        />
                    )
                }
                const streamingType = streaming && RUNTIME_TYPES.has(seg.attrs.type)
                    ? 'application/vnd.ant.code'
                    : seg.attrs.type
                const streamingLanguage = streaming
                    ? streamingLanguageFor(seg.attrs)
                    : seg.attrs.language ?? null
                const artifact: ArtifactRow = realRow ?? {
                    id: `streaming-${seg.attrs.identifier}`,
                    conversationId: "",
                    messageId,
                    identifier: seg.attrs.identifier,
                    version: 0,
                    type: streamingType,
                    title: seg.attrs.title,
                    language: streamingLanguage,
                    display: seg.attrs.display ?? null,
                    content: seg.content,
                    createdAt: 0,
                }
                if (onExpand && decideRowRenderTarget(artifact) === "panel") {
                    return (
                        <PanelArtifactButton
                            key={`a-${i}-${artifact.id}`}
                            artifact={artifact}
                            onExpand={onExpand}
                        />
                    )
                }
                return <ArtifactInline key={`a-${i}-${artifact.id}`} artifact={artifact} onExpand={onExpand} />
            })}
        </>
    )
}

function SuppressedArtifactNotice({ title, type }: { title: string; type: string }) {
    const label = type === 'application/vnd.ant.map' ? 'Updated the main map' : 'Updated artifact'
    return (
        <div className="my-2 rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-[13px] text-muted-foreground">
            <span className="font-medium text-foreground">{label}</span>
            <span className="mx-1">·</span>
            <span>{title}</span>
        </div>
    )
}

function PanelArtifactButton({
    artifact,
    onExpand,
}: {
    artifact: ArtifactRow
    onExpand: (a: ArtifactRow) => void
}) {
    return (
        <button
            type="button"
            onClick={() => onExpand(artifact)}
            className="my-2 flex max-w-full items-center gap-2 rounded-lg border border-border/70 bg-muted/25 px-3 py-2 text-left text-sm text-foreground/80 transition-colors hover:border-border hover:bg-muted/45"
            aria-label={`Open ${artifact.title} in side panel`}
            title="Open in side panel"
        >
            <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{artifact.title}</span>
        </button>
    )
}

/**
 * MIME types whose renderers compile or execute the body. Substituted for a
 * plain code view during streaming so the user sees the source build up line
 * by line instead of a cascade of failed compilations.
 */
const RUNTIME_TYPES = new Set([
    'application/vnd.ant.react',
    'text/html',
    'application/vnd.ant.mermaid',
    'application/vnd.ant.map',
    'application/vnd.ant.weather',
    'application/vnd.ant.recipe',
])

/**
 * MIME types whose streamed body is JSON-shaped — the user gets ZERO value
 * from staring at a single-line horizontally scrolling JSON dump while the
 * model fills it in. We swap in a tiny placeholder card so the message
 * bubble stays calm; the real renderer mounts once the closing tag lands.
 */
const PLACEHOLDER_TYPES = new Set([
    'application/vnd.ant.map',
    'application/vnd.ant.weather',
    'application/vnd.ant.recipe',
])

function StreamingPlaceholder({ type, title }: { type: string; title: string }) {
    const kind = STREAMING_KIND_LABEL[type] ?? 'artifact'
    return (
        <div className="my-2 flex items-center gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-sm">
            <div className="size-2 animate-pulse rounded-full bg-blue-500" aria-hidden />
            <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-foreground">{title}</div>
                <div className="text-[12px] text-muted-foreground">Building {kind}…</div>
            </div>
        </div>
    )
}

const STREAMING_KIND_LABEL: Record<string, string> = {
    'application/vnd.ant.map': 'map',
    'application/vnd.ant.weather': 'weather',
    'application/vnd.ant.recipe': 'recipe',
}

function streamingLanguageFor(attrs: ArtifactOpenAttrs): string | null {
    if (attrs.language) return attrs.language
    switch (attrs.type) {
        case 'application/vnd.ant.react': return 'tsx'
        case 'text/html': return 'html'
        case 'application/vnd.ant.mermaid': return 'text'
        case 'application/vnd.ant.map': return 'json'
        case 'application/vnd.ant.weather': return 'json'
        case 'application/vnd.ant.recipe': return 'json'
        default: return null
    }
}

type ContentSegment =
    | { kind: "prose"; text: string }
    | { kind: "artifact"; attrs: ArtifactOpenAttrs; content: string; closed: boolean }

/**
 * Drive the streaming parser to completion on a static string and collect
 * top-level segments. We coalesce runs of prose so the markdown renderer
 * gets contiguous text (preserves list/heading semantics across artifact
 * boundaries).
 *
 * We deliberately do NOT call `parser.end()` — that would flush partial-tag
 * bytes (e.g. `<artifac` mid-stream) back into the prose stream and the user
 * would see the half-tag literal flash on screen as the bytes arrive. Holding
 * them inside the parser hides the flicker. The trade-off: a stream that ends
 * with a truncated open tag will silently drop those bytes from the rendered
 * output (they still live in the DB row, so a reload after the model adds the
 * closing `>` recovers them).
 */
function parseContentToSegments(content: string): ContentSegment[] {
    const parser = new ArtifactParser()
    const events = parser.feed(content)
    const out: ContentSegment[] = []
    let proseBuffer = ""
    let currentArtifact: { attrs: ArtifactOpenAttrs; content: string } | null = null

    const flushProse = () => {
        if (proseBuffer) {
            out.push({ kind: "prose", text: proseBuffer })
            proseBuffer = ""
        }
    }
    const flushOpenArtifact = () => {
        if (currentArtifact) {
            out.push({ kind: "artifact", attrs: currentArtifact.attrs, content: currentArtifact.content, closed: false })
            currentArtifact = null
        }
    }

    for (const ev of events) {
        switch (ev.kind) {
            case "prose":
                if (!currentArtifact) proseBuffer += ev.text
                break
            case "artifact_start":
                flushProse()
                currentArtifact = { attrs: ev.attrs, content: "" }
                break
            case "artifact_chunk":
                if (currentArtifact) currentArtifact.content += ev.text
                break
            case "artifact_end":
                if (currentArtifact) {
                    out.push({ kind: "artifact", attrs: currentArtifact.attrs, content: currentArtifact.content, closed: true })
                    currentArtifact = null
                }
                break
            case "artifact_error":
                // Malformed open tag — the raw literal will arrive as `prose`
                // separately, so nothing to do here.
                break
        }
    }
    flushProse()
    flushOpenArtifact()
    return out
}
