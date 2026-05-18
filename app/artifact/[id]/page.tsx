"use client"

import * as React from "react"
import { useParams, useRouter } from "next/navigation"

import { ArtifactPanel } from "@/components/artifacts/artifact-panel"
import { ConversationArtifactsProvider } from "@/components/artifacts/use-conversation-artifacts"
import type { ArtifactRow } from "@/lib/artifacts/schema"

export default function ArtifactFullscreenPage() {
    const params = useParams<{ id: string }>()
    const router = useRouter()
    const [artifact, setArtifact] = React.useState<ArtifactRow | null>(null)
    const [error, setError] = React.useState<string | null>(null)

    React.useEffect(() => {
        if (!params?.id) return
        let cancelled = false
        fetch(`/api/artifacts/${encodeURIComponent(params.id)}`)
            .then(async (r) => {
                if (!r.ok) throw new Error(r.status === 404 ? "Artifact not found" : `Failed to load (${r.status})`)
                return (await r.json()) as ArtifactRow
            })
            .then((row) => { if (!cancelled) setArtifact(row) })
            .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
        return () => { cancelled = true }
    }, [params?.id])

    const handleClose = React.useCallback(() => {
        try { window.close() } catch { /* not opened by script */ }
        router.push("/")
    }, [router])

    if (error) {
        return (
            <div className="flex h-dvh w-screen items-center justify-center bg-background text-sm text-muted-foreground">
                {error}
            </div>
        )
    }

    if (!artifact) {
        return (
            <div className="flex h-dvh w-screen items-center justify-center bg-background text-sm text-muted-foreground">
                Loading…
            </div>
        )
    }

    return (
        <ConversationArtifactsProvider conversationId={artifact.conversationId}>
            <div className="h-dvh w-screen bg-background">
                <ArtifactPanel
                    artifact={artifact}
                    onClose={handleClose}
                    onSelect={(a) => router.replace(`/artifact/${a.id}`)}
                    className="border-l-0"
                />
            </div>
        </ConversationArtifactsProvider>
    )
}
