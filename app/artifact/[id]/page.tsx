"use client"

import * as React from "react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, X } from "lucide-react"

import { ArtifactBody } from "@/components/artifacts/artifact-inline"
import { ArtifactPanel } from "@/components/artifacts/artifact-panel"
import { ConversationArtifactsProvider } from "@/components/artifacts/use-conversation-artifacts"
import { WorkoutSurfaceView } from "@/components/workout/workout-surface-view"
import { useChatStore } from "@/hooks/use-chat-store"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import { cn } from "@/lib/utils"

type ArtifactPageRow = ArtifactRow & {
    conversationOrigin?: "user" | "inbox" | null
}

export default function ArtifactFullscreenPage() {
    const params = useParams<{ id: string }>()
    const router = useRouter()
    const searchParams = useSearchParams()
    const { newChat } = useChatStore()
    // Entry point that opened this viewer. Used only as the safe Back fallback
    // when there is no browser history entry to return to.
    const from = searchParams?.get("from") ?? null
    const [artifact, setArtifact] = React.useState<ArtifactPageRow | null>(null)
    const [error, setError] = React.useState<string | null>(null)

    React.useEffect(() => {
        if (!params?.id) return
        let cancelled = false
        fetch(`/api/artifacts/${encodeURIComponent(params.id)}`)
            .then(async (r) => {
                if (!r.ok) throw new Error(r.status === 404 ? "Artifact not found" : `Failed to load (${r.status})`)
                return (await r.json()) as ArtifactPageRow
            })
            .then((row) => { if (!cancelled) setArtifact(row) })
            .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
        return () => { cancelled = true }
    }, [params?.id])

    const returnHref = React.useMemo(
        () => artifact ? returnHrefForArtifact(artifact, from) : "/",
        [artifact, from]
    )

    const handleBack = React.useCallback(() => {
        if (window.history.length > 1) {
            router.back()
            return
        }
        router.replace(returnHref)
    }, [returnHref, router])

    const handleClose = React.useCallback(() => {
        newChat()
        router.push("/")
    }, [newChat, router])

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

    // Workouts get the dedicated full-screen surface with the in-surface AI
    // coach (lateral chat) — every entry point (launch card, library, deep
    // link) funnels through here.
    if (artifact.type === "application/vnd.ant.workout") {
        return (
            <ConversationArtifactsProvider conversationId={artifact.conversationId}>
                <WorkoutSurfaceView
                    artifact={artifact}
                    onBack={handleBack}
                    onClose={handleClose}
                />
            </ConversationArtifactsProvider>
        )
    }

    const opensInFullscreen =
        artifact.display === "fullscreen" ||
        artifact.type === "application/vnd.ant.recipe"

    return (
        <ConversationArtifactsProvider conversationId={artifact.conversationId}>
            {opensInFullscreen ? (
                <FullscreenArtifact
                    artifact={artifact}
                    onBack={handleBack}
                    onClose={handleClose}
                />
            ) : (
                <div className="h-dvh w-screen bg-background">
                    <ArtifactPanel
                        artifact={artifact}
                        onClose={handleClose}
                        onSelect={(a) => router.replace(`/artifact/${a.id}`)}
                        className="border-l-0"
                    />
                </div>
            )}
        </ConversationArtifactsProvider>
    )
}

function FullscreenArtifact({
    artifact,
    onBack,
    onClose,
}: {
    artifact: ArtifactRow
    onBack: () => void
    onClose: () => void
}) {
    const isWorkout = artifact.type === "application/vnd.ant.workout"
    const isRecipe = artifact.type === "application/vnd.ant.recipe"
    return (
        <main
            className={cn(
                "flex h-dvh w-screen flex-col overflow-hidden bg-background text-foreground",
                (isWorkout || isRecipe) && "touch-pan-y"
            )}
        >
            <header className="sticky top-0 z-20 border-b border-border/70 bg-background/95 px-3 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2 backdrop-blur">
                <div className={cn(
                    "mx-auto flex h-11 w-full items-center gap-2",
                    isRecipe ? "max-w-3xl" : "max-w-4xl",
                )}>
                    <button
                        type="button"
                        onClick={onBack}
                        className="flex size-10 shrink-0 items-center justify-center rounded-full text-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                        aria-label="Back"
                        title="Back"
                    >
                        <ArrowLeft className="size-5" />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-[15px] font-semibold leading-5" title={artifact.title}>
                            {artifact.title}
                        </div>
                        <div className="truncate text-[11px] leading-4 text-muted-foreground">
                            {isWorkout ? "Workout mode" : prettyType(artifact.type)}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex size-10 shrink-0 items-center justify-center rounded-full text-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
                        aria-label="Close"
                        title="Close"
                    >
                        <X className="size-5" />
                    </button>
                </div>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className={cn(
                    "mx-auto w-full max-w-4xl px-3 py-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-4 sm:py-4",
                    (isWorkout || isRecipe) && "max-w-3xl",
                    isRecipe && "sm:py-6"
                )}>
                    <ArtifactBody artifact={artifact} mode="panel" />
                </div>
            </div>
        </main>
    )
}

function returnHrefForArtifact(artifact: ArtifactPageRow, from?: string | null): string {
    // Opened from the Library grid → go back to the matching Library tab, not
    // the conversation that originally produced the artifact.
    if (from === "library") {
        return `/library?tab=${libraryTabForType(artifact.type)}`
    }
    const id = encodeURIComponent(artifact.conversationId)
    return artifact.conversationOrigin === "inbox"
        ? `/inbox?item=${id}`
        : `/?chat=${id}`
}

function libraryTabForType(type: string): string {
    switch (type) {
        case "application/vnd.ant.workout": return "workouts"
        case "application/vnd.ant.map": return "maps"
        case "application/vnd.ant.recipe": return "recipes"
        default: return "artifacts"
    }
}

function prettyType(mime: string): string {
    switch (mime) {
        case "application/vnd.ant.workout": return "Workout"
        case "application/vnd.ant.recipe": return "Recipe"
        case "application/vnd.ant.weather": return "Weather"
        case "application/vnd.ant.map": return "Map"
        case "application/vnd.ant.react": return "React"
        case "text/html": return "HTML"
        default: return mime
    }
}
