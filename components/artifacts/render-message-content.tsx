"use client"

import * as React from "react"
import { AlertTriangle, Clock3, Dumbbell, ExternalLink, ListChecks, Maximize2 } from "lucide-react"

import type { ArtifactOpenAttrs, ArtifactRow } from "@/lib/artifacts/schema"
import { ArtifactParser } from "@/lib/artifacts/parser"
import { decideRowRenderTarget } from "@/lib/artifacts/render-decision"
import { parseWorkoutArtifact } from "@/lib/workout/parser"
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
    const { byMessage, draftsByMessage, loading: artifactsLoading } = useConversationArtifacts()
    const rowsForMessage = React.useMemo(() => byMessage.get(messageId) ?? [], [byMessage, messageId])
    const draftsForMessage = React.useMemo(
        () => draftsByMessage.get(messageId) ?? [],
        [draftsByMessage, messageId]
    )
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
                const hasDraft = !realRow && draftsForMessage.some(
                    draft => draft.attrs.identifier === seg.attrs.identifier
                )
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
                const renderTarget = decideRowRenderTarget(artifact)
                if (seg.closed && !realRow && (hasDraft || artifactsLoading)) {
                    return (
                        <StreamingPlaceholder
                            key={`w-${i}-${seg.attrs.identifier}`}
                            type={seg.attrs.type}
                            title={seg.attrs.title}
                        />
                    )
                }
                if (renderTarget !== "inline" && !realRow) {
                    return (
                        <UnavailableArtifactNotice
                            key={`u-${i}-${seg.attrs.identifier}`}
                            identifier={seg.attrs.identifier}
                            type={seg.attrs.type}
                            title={seg.attrs.title}
                        />
                    )
                }
                if (renderTarget === "fullscreen") {
                    return (
                        <ArtifactLaunchCard
                            key={`f-${i}-${artifact.id}`}
                            artifact={artifact}
                            target="fullscreen"
                        />
                    )
                }
                if (renderTarget === "panel") {
                    return (
                        <ArtifactLaunchCard
                            key={`pnl-${i}-${artifact.id}`}
                            artifact={artifact}
                            target="panel"
                            onExpand={onExpand}
                        />
                    )
                }
                return <ArtifactInline key={`a-${i}-${artifact.id}`} artifact={artifact} onExpand={onExpand} />
            })}
        </>
    )
}

function UnavailableArtifactNotice({
    identifier,
    title,
    type,
}: {
    identifier: string
    title: string
    type: string
}) {
    const { reconcileMissingArtifact } = useConversationArtifacts()
    // Self-heal before blaming the content: a missing row is more often a
    // stale client registry (missed SSE event while backgrounded) than a
    // validation failure. The provider refetches once per identifier; if the
    // row lands, this notice unmounts and the real card renders. Only a row
    // that is STILL missing after the refetch keeps this notice on screen.
    React.useEffect(() => {
        reconcileMissingArtifact(identifier)
    }, [identifier, reconcileMissingArtifact])
    return (
        <div className="my-2 flex items-start gap-3 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3.5 py-3 text-sm text-amber-950 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{title || "Artifact"}</div>
                <div className="mt-1 text-[12px] leading-5 opacity-85">
                    Artifactul nu a putut fi afișat — conținutul de {prettyArtifactType(type)} lipsește sau nu a trecut validarea. Dacă rămâne așa, cere-i agentului să regenereze cardul complet, fără să renunțe la conținut.
                </div>
            </div>
        </div>
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

function ArtifactLaunchCard({
    artifact,
    target,
    onExpand,
}: {
    artifact: ArtifactRow
    target: "panel" | "fullscreen"
    onExpand?: (a: ArtifactRow) => void
}) {
    const workout = React.useMemo(
        () => artifact.type === "application/vnd.ant.workout"
            ? summarizeWorkoutArtifact(artifact.content)
            : null,
        [artifact.content, artifact.type]
    )
    const isFullscreen = target === "fullscreen"
    const buttonLabel = artifact.type === "application/vnd.ant.workout"
        ? "Open workout"
        : isFullscreen
            ? "Open full screen"
            : "Open artifact"
    const open = () => {
        if (target === "panel" && onExpand) {
            onExpand(artifact)
            return
        }
        window.location.assign(`/artifact/${artifact.id}`)
    }

    return (
        <button
            type="button"
            onClick={open}
            className="my-2 flex w-full max-w-full items-center gap-3 rounded-lg border border-border/70 bg-muted/25 px-3.5 py-3 text-left text-sm text-foreground/80 transition-colors hover:border-border hover:bg-muted/45"
            aria-label={`${buttonLabel}: ${artifact.title}`}
            title={buttonLabel}
        >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border))]">
                {artifact.type === "application/vnd.ant.workout"
                    ? <Dumbbell className="size-5" />
                    : isFullscreen
                        ? <Maximize2 className="size-5" />
                        : <ExternalLink className="size-5" />}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{artifact.title}</span>
                {workout ? (
                    <span className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[12px] leading-5 text-muted-foreground">
                        {typeof workout.minutes === "number" ? (
                            <span className="inline-flex items-center gap-1">
                                <Clock3 className="size-3.5" />
                                {workout.minutes} min
                            </span>
                        ) : null}
                        <span className="inline-flex items-center gap-1">
                            <Dumbbell className="size-3.5" />
                            {workout.exercises} exercises
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <ListChecks className="size-3.5" />
                            {workout.sets} sets
                        </span>
                    </span>
                ) : (
                    <span className="mt-1 block truncate text-[12px] text-muted-foreground">
                        {isFullscreen ? "Full-screen artifact" : "Panel artifact"}
                    </span>
                )}
            </span>
            <span className="shrink-0 rounded-md bg-background px-2.5 py-1 text-[12px] font-medium text-foreground/70 shadow-[inset_0_0_0_1px_hsl(var(--border))]">
                {buttonLabel}
            </span>
        </button>
    )
}

function summarizeWorkoutArtifact(content: string): { minutes?: number; exercises: number; sets: number } | null {
    const parsed = parseWorkoutArtifact(content)
    if (!parsed.ok) return null

    let exercises = 0
    let sets = 0
    for (const group of parsed.value.groups) {
        exercises += group.exercises.length
        for (const exercise of group.exercises) {
            sets += exercise.planned.length
        }
    }

    return {
        minutes: parsed.value.estimatedDurationMin,
        exercises,
        sets,
    }
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
    'application/vnd.ant.workout',
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
    'application/vnd.ant.workout',
    'application/vnd.ant.app-link',
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
    'application/vnd.ant.workout': 'workout',
    'application/vnd.ant.app-link': 'app card',
}

function prettyArtifactType(type: string): string {
    switch (type) {
        case 'application/vnd.ant.map': return 'hartă'
        case 'application/vnd.ant.weather': return 'meteo'
        case 'application/vnd.ant.recipe': return 'rețetă'
        case 'application/vnd.ant.workout': return 'workout'
        default: return type
    }
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
        case 'application/vnd.ant.workout': return 'json'
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
