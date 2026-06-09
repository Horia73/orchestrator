"use client"

import * as React from "react"
import { ArrowLeft, Sparkles, X } from "lucide-react"

import { WorkoutCanvas } from "@/components/artifacts/renderers/workout-renderer"
import { WorkoutErrorCard } from "@/components/artifacts/renderers/workout/workout-error-card"
import { useIsMobile } from "@/hooks/use-mobile"
import { useRevealOnScroll } from "@/hooks/use-reveal-on-scroll"
import type { ArtifactRow } from "@/lib/artifacts/schema"
import type { WorkoutArtifact } from "@/lib/workout/schema"
import { parseWorkoutArtifact } from "@/lib/workout/parser"
import { summarizeWorkoutForPrompt } from "@/lib/workout/prompt-context"
import { useWorkoutSession } from "@/lib/workout/use-workout-session"
import { cn } from "@/lib/utils"

import { WorkoutChatPanel } from "./workout-chat-panel"

type SurfaceArtifactRow = ArtifactRow & {
  conversationOrigin?: "user" | "inbox" | null
}

/**
 * Full-screen workout surface with an in-surface AI coach (lateral chat),
 * mirroring the Smart Maps surface. Rendered by `/artifact/[id]` for workout
 * artifacts.
 *
 * Live editing: the chat reuses the main chat engine with the workout
 * capability active and a live prompt context. When the agent re-emits the
 * workout artifact (same identifier + sessionId), the chat store fires the
 * `orch:artifact` window event; we adopt the newer version in place so the plan
 * updates live while the session hook (keyed by sessionId) preserves all logged
 * progress.
 */
export function WorkoutSurfaceView({
  artifact: initialArtifact,
  onBack,
  onClose,
}: {
  artifact: SurfaceArtifactRow
  onBack: () => void
  onClose: () => void
}) {
  const [artifact, setArtifact] = React.useState(initialArtifact)
  const sourceConversationId = React.useMemo(
    () =>
      initialArtifact.conversationOrigin === "inbox" ||
      initialArtifact.conversationOrigin === null
        ? null
        : initialArtifact.conversationId,
    [initialArtifact.conversationId, initialArtifact.conversationOrigin]
  )

  // Keep in sync if the route swaps to a different artifact id entirely.
  React.useEffect(() => {
    setArtifact(initialArtifact)
  }, [initialArtifact])

  // Live-adopt newer versions of THIS workout emitted by the in-surface chat.
  React.useEffect(() => {
    const handler = (event: Event) => {
      const row = (event as CustomEvent<ArtifactRow>).detail
      if (!row || row.type !== "application/vnd.ant.workout") return
      if (row.identifier !== artifact.identifier) return
      if (row.version < artifact.version) return
      setArtifact(row)
    }
    window.addEventListener("orch:artifact", handler)
    return () => window.removeEventListener("orch:artifact", handler)
  }, [artifact.identifier, artifact.version])

  const parsed = React.useMemo(
    () => parseWorkoutArtifact(artifact.content),
    [artifact.content]
  )

  if (!parsed.ok) {
    return (
      <SurfaceShell>
        <div className="mx-auto w-full max-w-3xl px-3 py-4">
          <SurfaceControls onBack={onBack} onClose={onClose} />
          <WorkoutErrorCard message={parsed.error} />
        </div>
      </SurfaceShell>
    )
  }

  return (
    <WorkoutSurfaceInner
      artifact={artifact}
      workout={parsed.value}
      sourceConversationId={sourceConversationId}
      onBack={onBack}
      onClose={onClose}
    />
  )
}

function WorkoutSurfaceInner({
  artifact,
  workout,
  sourceConversationId,
  onBack,
  onClose,
}: {
  artifact: ArtifactRow
  workout: WorkoutArtifact
  sourceConversationId: string | null
  onBack: () => void
  onClose: () => void
}) {
  const isMobile = useIsMobile()
  const [chatOpen, setChatOpen] = React.useState(false)
  const scrollbarVisible = useRevealOnScroll()

  const sessionApi = useWorkoutSession(workout.sessionId, workout, {
    artifactId: artifact.id,
  })
  const hasWorkoutTimer = Boolean(sessionApi.session.activeSet || sessionApi.session.rest)

  const buildPromptContext = React.useCallback(
    () =>
      summarizeWorkoutForPrompt(sessionApi.workout, sessionApi.session, {
        identifier: artifact.identifier,
        title: artifact.title,
      }),
    [sessionApi.workout, sessionApi.session, artifact.identifier, artifact.title]
  )

  return (
    <SurfaceShell>
      <div className="relative flex min-h-0 flex-1">
        <div
          className="transient-scrollbar min-w-0 flex-1 overflow-y-auto overscroll-contain"
          data-scrollbar-visible={scrollbarVisible.active ? "true" : "false"}
          onScroll={scrollbarVisible.reveal}
        >
          <div className="mx-auto w-full max-w-3xl px-3 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-4 sm:pt-4">
            <SurfaceControls onBack={onBack} onClose={onClose} />
            <WorkoutCanvas
              sessionApi={sessionApi}
              title={artifact.title}
              artifactId={artifact.id}
            />
          </div>
        </div>

        {/* Desktop: docked chat column (returns null when closed). */}
        {!isMobile && (
          <WorkoutChatPanel
            open={chatOpen}
            mobile={false}
            docked
            activeWorkoutTitle={artifact.title}
            preferredConversationId={sourceConversationId}
            buildPromptContext={buildPromptContext}
            onCollapse={() => setChatOpen(false)}
          />
        )}
      </div>

      {/* Mobile: bottom-sheet chat (position fixed). */}
      {isMobile && (
        <WorkoutChatPanel
          open={chatOpen}
          mobile
          activeWorkoutTitle={artifact.title}
          preferredConversationId={sourceConversationId}
          buildPromptContext={buildPromptContext}
          onCollapse={() => setChatOpen(false)}
        />
      )}

      {/* Floating opener when the chat is collapsed. */}
      {!chatOpen && (
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          className={cn(
            "fixed right-4 z-[60] inline-flex items-center gap-2 rounded-full border border-border/70 bg-background px-4 py-2.5 text-[13px] font-medium text-foreground shadow-lg transition-colors hover:bg-muted",
            hasWorkoutTimer
              ? "bottom-[calc(6.75rem+env(safe-area-inset-bottom))]"
              : "bottom-[calc(1rem+env(safe-area-inset-bottom))]"
          )}
          aria-label="Open workout coach"
        >
          <Sparkles className="size-4" />
          Coach
        </button>
      )}
    </SurfaceShell>
  )
}

function SurfaceShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex h-dvh w-screen flex-col overflow-hidden bg-background text-foreground touch-pan-y">
      {children}
    </main>
  )
}

function SurfaceControls({
  onBack,
  onClose,
}: {
  onBack: () => void
  onClose: () => void
}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <button
        type="button"
        onClick={onBack}
        className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background text-foreground/70 shadow-sm transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Back"
        title="Back"
      >
        <ArrowLeft className="size-5" />
      </button>
      <button
        type="button"
        onClick={onClose}
        className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background text-foreground/70 shadow-sm transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Close"
        title="Close"
      >
        <X className="size-5" />
      </button>
    </div>
  )
}
