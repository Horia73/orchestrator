"use client"

import * as React from "react"
import type { ArtifactOpenAttrs, ArtifactRow } from "@/lib/artifacts/schema"

/**
 * Draft artifact — chunks accumulated client-side while the server is still
 * streaming. Promoted to a real ArtifactRow when `artifact_end` arrives
 * (server has persisted; we replace the draft with the canonical row).
 *
 * `messageId` is the assistant message id the stream belongs to; we use it
 * so the inline placeholder shows up in the right bubble.
 */
export interface DraftArtifact {
    clientToken: string
    messageId: string
    attrs: ArtifactOpenAttrs
    content: string
    /** Unix ms — for "Generating… (3s)" type indicators. */
    startedAt: number
}

/**
 * Live artifact registry for one conversation.
 *
 * Two write paths:
 *   - bootstrap: initial fetch of /api/artifacts/conversation/:id when the
 *     view opens, so messages already in the DB show their artifacts on first
 *     paint instead of a "loading" flash
 *   - stream: the SSE handler in the chat store dispatches the `artifact_end`
 *     row to `addArtifact()` as soon as the server finalises it
 *
 * Read path is just `getByMessage(messageId)` / `getByIdentifier(...)` etc.
 * Designed as a React context so any depth of message-bubble subcomponent can
 * grab the artifact it needs without prop drilling.
 */

interface ConversationArtifactsValue {
    /** All known artifacts for this conversation, in insert order. */
    all: ArtifactRow[]
    /** Artifacts indexed by messageId for the inline renderer's per-message lookup. */
    byMessage: Map<string, ArtifactRow[]>
    /**
     * Latest version per identifier — what to show by default when the user
     * scrolls back to an older message that references the artifact.
     */
    latestByIdentifier: Map<string, ArtifactRow>
    /** All versions of one identifier, oldest first. Drives the panel's version dropdown. */
    versionsByIdentifier: Map<string, ArtifactRow[]>
    /** Append/replace a row received via SSE (or after a manual refetch). */
    addArtifact: (row: ArtifactRow) => void
    /** Force a re-fetch from /api/artifacts (e.g. when reopening a conversation). */
    refresh: () => Promise<void>
    /** True while the bootstrap fetch is in flight. */
    loading: boolean
    error: string | null

    // ── Streaming draft surface ─────────────────────────────────────────
    /** In-progress artifacts indexed by clientToken. Cleared on artifact_end. */
    drafts: Map<string, DraftArtifact>
    /** Drafts grouped by messageId so the renderer can show them inline as they stream. */
    draftsByMessage: Map<string, DraftArtifact[]>
}

const Ctx = React.createContext<ConversationArtifactsValue | null>(null)

function buildIndices(rows: ArtifactRow[]): {
    byMessage: Map<string, ArtifactRow[]>
    latestByIdentifier: Map<string, ArtifactRow>
    versionsByIdentifier: Map<string, ArtifactRow[]>
} {
    const byMessage = new Map<string, ArtifactRow[]>()
    const versionsByIdentifier = new Map<string, ArtifactRow[]>()
    for (const row of rows) {
        const list = byMessage.get(row.messageId) ?? []
        list.push(row)
        byMessage.set(row.messageId, list)
        const versions = versionsByIdentifier.get(row.identifier) ?? []
        versions.push(row)
        versionsByIdentifier.set(row.identifier, versions)
    }
    // Sort version chains and derive "latest".
    const latestByIdentifier = new Map<string, ArtifactRow>()
    for (const [id, versions] of versionsByIdentifier) {
        versions.sort((a, b) => a.version - b.version)
        latestByIdentifier.set(id, versions[versions.length - 1])
    }
    return { byMessage, latestByIdentifier, versionsByIdentifier }
}

export function ConversationArtifactsProvider({
    conversationId,
    children,
}: {
    conversationId: string
    children: React.ReactNode
}) {
    const [all, setAll] = React.useState<ArtifactRow[]>([])
    const [drafts, setDrafts] = React.useState<Map<string, DraftArtifact>>(new Map())
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)
    const refreshRequestRef = React.useRef(0)
    const refreshAbortRef = React.useRef<AbortController | null>(null)

    const refresh = React.useCallback(async () => {
        const requestId = ++refreshRequestRef.current
        refreshAbortRef.current?.abort()
        const controller = new AbortController()
        refreshAbortRef.current = controller
        const isStale = () => controller.signal.aborted || requestId !== refreshRequestRef.current

        if (!conversationId) {
            setAll([])
            setLoading(false)
            if (refreshAbortRef.current === controller) refreshAbortRef.current = null
            return
        }
        setLoading(true)
        try {
            const res = await fetch(`/api/artifacts/conversation/${encodeURIComponent(conversationId)}`, {
                signal: controller.signal,
            })
            if (isStale()) return
            if (!res.ok) throw new Error(`Failed to load artifacts (${res.status})`)
            const json = (await res.json()) as { artifacts: ArtifactRow[] }
            if (isStale()) return
            setAll(json.artifacts)
            setError(null)
        } catch (err) {
            if (isStale() || (err instanceof Error && err.name === "AbortError")) return
            setError(err instanceof Error ? err.message : "Unknown error")
        } finally {
            if (!isStale()) {
                setLoading(false)
                if (refreshAbortRef.current === controller) refreshAbortRef.current = null
            }
        }
    }, [conversationId])

    React.useEffect(() => { void refresh() }, [refresh])

    React.useEffect(() => {
        return () => refreshAbortRef.current?.abort()
    }, [])

    // Live updates: the chat SSE loop dispatches `orch:artifact*` events.
    //   - `orch:artifact-start` opens a draft so the inline renderer can show
    //     a streaming placeholder with the title.
    //   - `orch:artifact-chunk` appends content to the draft so the placeholder
    //     can render the partial content (e.g. half of a Mermaid diagram).
    //   - `orch:artifact` (kept name for backcompat) finalises: the server-
    //     persisted row replaces the draft and lives in `all`.
    React.useEffect(() => {
        if (typeof window === "undefined") return

        function onFinal(e: Event) {
            const detail = (e as CustomEvent<ArtifactRow>).detail
            if (!detail || typeof detail !== "object") return
            if (detail.conversationId !== conversationId) return
            setAll(prev => {
                const idx = prev.findIndex(r => r.id === detail.id)
                if (idx >= 0) {
                    const next = prev.slice()
                    next[idx] = detail
                    return next
                }
                return [...prev, detail]
            })
            // Clear matching draft, if any — match on identifier since the
            // draft doesn't know the final UUID. There can only ever be one
            // active draft per identifier per message.
            setDrafts(prev => {
                let changed = false
                const next = new Map(prev)
                for (const [token, d] of prev) {
                    if (d.messageId === detail.messageId && d.attrs.identifier === detail.identifier) {
                        next.delete(token)
                        changed = true
                    }
                }
                return changed ? next : prev
            })
        }

        function onStart(e: Event) {
            const detail = (e as CustomEvent<{ clientToken: string; messageId: string; attrs: ArtifactOpenAttrs }>).detail
            if (!detail?.clientToken || !detail?.messageId || !detail?.attrs) return
            setDrafts(prev => {
                const next = new Map(prev)
                next.set(detail.clientToken, {
                    clientToken: detail.clientToken,
                    messageId: detail.messageId,
                    attrs: detail.attrs,
                    content: "",
                    startedAt: Date.now(),
                })
                return next
            })
        }

        function onChunk(e: Event) {
            const detail = (e as CustomEvent<{ clientToken: string; content: string }>).detail
            if (!detail?.clientToken || typeof detail.content !== "string") return
            setDrafts(prev => {
                const existing = prev.get(detail.clientToken)
                if (!existing) return prev
                const next = new Map(prev)
                next.set(detail.clientToken, { ...existing, content: existing.content + detail.content })
                return next
            })
        }

        window.addEventListener("orch:artifact", onFinal)
        window.addEventListener("orch:artifact-start", onStart)
        window.addEventListener("orch:artifact-chunk", onChunk)
        return () => {
            window.removeEventListener("orch:artifact", onFinal)
            window.removeEventListener("orch:artifact-start", onStart)
            window.removeEventListener("orch:artifact-chunk", onChunk)
        }
    }, [conversationId])

    const addArtifact = React.useCallback((row: ArtifactRow) => {
        setAll(prev => {
            // Idempotent insert: if we already have this id, replace; else append.
            const idx = prev.findIndex(r => r.id === row.id)
            if (idx >= 0) {
                const next = prev.slice()
                next[idx] = row
                return next
            }
            return [...prev, row]
        })
    }, [])

    const indices = React.useMemo(() => buildIndices(all), [all])
    const draftsByMessage = React.useMemo(() => {
        const m = new Map<string, DraftArtifact[]>()
        for (const d of drafts.values()) {
            const list = m.get(d.messageId) ?? []
            list.push(d)
            m.set(d.messageId, list)
        }
        return m
    }, [drafts])

    const value = React.useMemo<ConversationArtifactsValue>(
        () => ({ all, ...indices, addArtifact, refresh, loading, error, drafts, draftsByMessage }),
        [all, indices, addArtifact, refresh, loading, error, drafts, draftsByMessage]
    )

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useConversationArtifacts(): ConversationArtifactsValue {
    const ctx = React.useContext(Ctx)
    if (!ctx) {
        // Safe fallback so renderers that mount outside the provider don't
        // crash (they just won't see live artifacts). Surfaces during message
        // previews in the sidebar, draft contexts, etc.
        return {
            all: [],
            byMessage: new Map(),
            latestByIdentifier: new Map(),
            versionsByIdentifier: new Map(),
            addArtifact: () => {},
            refresh: async () => {},
            loading: false,
            error: null,
            drafts: new Map(),
            draftsByMessage: new Map(),
        }
    }
    return ctx
}
