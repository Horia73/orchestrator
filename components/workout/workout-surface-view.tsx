"use client"

import * as React from "react"
import { ArrowLeft, Sparkles, X } from "lucide-react"

import { WorkoutCanvas } from "@/components/artifacts/renderers/workout-renderer"
import { WorkoutErrorCard } from "@/components/artifacts/renderers/workout/workout-error-card"
import { useAppEvent } from "@/hooks/use-app-events"
import { useDocumentViewportLock } from "@/hooks/use-document-viewport-lock"
import { useMobileKeyboardInset } from "@/hooks/use-keyboard-inset"
import { useIsMobile } from "@/hooks/use-mobile"
import { useRevealOnScroll } from "@/hooks/use-reveal-on-scroll"
import { useScreenWakeLock } from "@/hooks/use-screen-wake-lock"
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
  // Pin the document so iOS Safari can't pan the page when the coach chat
  // input focuses — the chat panel's own keyboard inset is the only lift.
  useDocumentViewportLock()
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

  // Tool-driven edits (PatchWorkout) insert a new version server-side, which
  // arrives as an `artifacts.changed` app event rather than the `orch:artifact`
  // window event. Fetch the changed row and adopt it if it's a newer version
  // of THIS workout.
  useAppEvent(["artifacts.changed"], (event) => {
    if (event.type !== "artifacts.changed") return
    if (event.conversationId && event.conversationId !== artifact.conversationId) return
    const changedId = event.artifactId
    if (!changedId || changedId === artifact.id) return
    void fetch(`/api/artifacts/${encodeURIComponent(changedId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((row: ArtifactRow | null) => {
        if (!row || row.type !== "application/vnd.ant.workout") return
        if (row.identifier !== artifact.identifier) return
        if (row.version < artifact.version) return
        setArtifact(row)
      })
      .catch(() => undefined)
  })

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
  const { active: scrollbarActive, reveal: revealScrollbar } = useRevealOnScroll()
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const scrollRestoredRef = React.useRef(false)
  const scrollSaveFrameRef = React.useRef<number | null>(null)
  useScreenWakeLock()

  const sessionApi = useWorkoutSession(workout.sessionId, workout, {
    artifactId: artifact.id,
  })
  const hasWorkoutTimer = Boolean(sessionApi.session.activeSet || sessionApi.session.rest)
  const workoutScrollKey = `scroll:workout:${workout.sessionId}`

  React.useLayoutEffect(() => {
    if (!sessionApi.isRestored) return
    const element = scrollRef.current
    if (!element) return
    scrollRestoredRef.current = false
    const saved = readWorkoutScroll(workoutScrollKey)
    let innerFrame = 0
    const outerFrame = window.requestAnimationFrame(() => {
      innerFrame = window.requestAnimationFrame(() => {
        if (saved > 0) {
          element.scrollTop = Math.min(
            saved,
            Math.max(0, element.scrollHeight - element.clientHeight)
          )
        }
        scrollRestoredRef.current = true
      })
    })
    return () => {
      window.cancelAnimationFrame(outerFrame)
      if (innerFrame) window.cancelAnimationFrame(innerFrame)
    }
  }, [sessionApi.isRestored, workoutScrollKey])

  const persistWorkoutScroll = React.useCallback(() => {
    const element = scrollRef.current
    if (!scrollRestoredRef.current || !element) return
    writeWorkoutScroll(workoutScrollKey, element.scrollTop)
  }, [workoutScrollKey])

  const handleWorkoutScroll = React.useCallback(() => {
    revealScrollbar()
    if (scrollSaveFrameRef.current !== null) return
    scrollSaveFrameRef.current = window.requestAnimationFrame(() => {
      scrollSaveFrameRef.current = null
      persistWorkoutScroll()
    })
  }, [persistWorkoutScroll, revealScrollbar])

  React.useEffect(() => () => {
    if (scrollSaveFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollSaveFrameRef.current)
      scrollSaveFrameRef.current = null
    }
    persistWorkoutScroll()
  }, [persistWorkoutScroll])

  const buildPromptContext = React.useCallback(
    () =>
      summarizeWorkoutForPrompt(sessionApi.workout, sessionApi.session, {
        identifier: artifact.identifier,
        title: artifact.title,
        artifactId: artifact.id,
      }),
    [sessionApi.workout, sessionApi.session, artifact.identifier, artifact.title, artifact.id]
  )

  return (
    <SurfaceShell>
      <SurfaceControls onBack={onBack} onClose={onClose} />
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          data-workout-scroll
          className="transient-scrollbar min-w-0 flex-1 overflow-y-auto overscroll-contain"
          data-scrollbar-visible={scrollbarActive ? "true" : "false"}
          onScroll={handleWorkoutScroll}
        >
          <div
            data-workout-content
            className="mx-auto w-full max-w-3xl px-3 pt-[calc(4rem+env(safe-area-inset-top))] pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-4"
          >
            <WorkoutCanvas
              sessionApi={sessionApi}
              title={artifact.title}
              artifactId={artifact.id}
              prefetchImages
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
            sideConversationKey={`session:${workout.sessionId}`}
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
          sideConversationKey={`session:${workout.sessionId}`}
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
  const rootRef = React.useRef<HTMLElement>(null)
  const focusedFieldRef = React.useRef<HTMLElement | null>(null)
  const keyboardInset = useMobileKeyboardInset()

  const revealFocusedField = React.useCallback(() => {
    if (keyboardInset <= 0) return
    const root = rootRef.current
    const field = focusedFieldRef.current
    if (!root || !field || !root.contains(field)) return
    if (field.closest("[data-workout-chat-panel]")) return

    const workoutScroller = root.querySelector<HTMLElement>(
      "[data-workout-scroll]"
    )
    if (!workoutScroller) return

    let scroller: HTMLElement = workoutScroller
    let ancestor = field.parentElement
    while (ancestor && ancestor !== root) {
      const overflowY = window.getComputedStyle(ancestor).overflowY
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        ancestor.scrollHeight > ancestor.clientHeight + 1
      ) {
        scroller = ancestor
        break
      }
      ancestor = ancestor.parentElement
    }

    const scrollerRect = scroller.getBoundingClientRect()
    const fieldRect = field.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    const visibleTop = Math.max(scrollerRect.top, rootRect.top) + 16
    const visibleBottom =
      Math.min(scrollerRect.bottom, rootRect.bottom - keyboardInset) - 16
    let delta = 0

    if (fieldRect.bottom > visibleBottom) {
      delta = fieldRect.bottom - visibleBottom
    } else if (fieldRect.top < visibleTop) {
      delta = fieldRect.top - visibleTop
    }
    if (Math.abs(delta) <= 1) return

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches
    scroller.scrollTo({
      top: Math.max(0, scroller.scrollTop + delta),
      behavior: reducedMotion ? "auto" : "smooth",
    })
  }, [keyboardInset])

  React.useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (!isWorkoutTypingField(target)) return
      if (target.closest("[data-workout-chat-panel]")) return
      focusedFieldRef.current = target
      window.requestAnimationFrame(revealFocusedField)
    }
    const onFocusOut = () => {
      window.requestAnimationFrame(() => {
        const active = document.activeElement
        focusedFieldRef.current =
          isWorkoutTypingField(active) && root.contains(active) ? active : null
      })
    }

    root.addEventListener("focusin", onFocusIn)
    root.addEventListener("focusout", onFocusOut)
    return () => {
      root.removeEventListener("focusin", onFocusIn)
      root.removeEventListener("focusout", onFocusOut)
    }
  }, [revealFocusedField])

  React.useLayoutEffect(() => {
    if (keyboardInset <= 0) return
    const frame = window.requestAnimationFrame(revealFocusedField)
    return () => window.cancelAnimationFrame(frame)
  }, [keyboardInset, revealFocusedField])

  return (
    <main
      ref={rootRef}
      data-workout-surface
      className="flex h-dvh w-screen flex-col overflow-hidden bg-background text-foreground touch-pan-y"
      style={{
        "--orch-mobile-keyboard-inset": `${keyboardInset}px`,
      } as React.CSSProperties}
    >
      {children}
    </main>
  )
}

function isWorkoutTypingField(
  target: EventTarget | Element | null
): target is HTMLInputElement | HTMLTextAreaElement {
  if (target instanceof HTMLTextAreaElement) return true
  if (!(target instanceof HTMLInputElement)) return false
  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "radio",
    "range",
    "reset",
    "submit",
  ].includes(target.type)
}

function SurfaceControls({
  onBack,
  onClose,
}: {
  onBack: () => void
  onClose: () => void
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[calc(0.75rem+env(safe-area-inset-top))] z-[75] mx-auto flex w-full max-w-3xl items-center justify-between px-3 sm:px-4">
      <button
        type="button"
        onClick={onBack}
        className="pointer-events-auto flex size-10 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/92 text-foreground/70 shadow-lg backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Back"
        title="Back"
      >
        <ArrowLeft className="size-5" />
      </button>
      <button
        type="button"
        onClick={onClose}
        className="pointer-events-auto flex size-10 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/92 text-foreground/70 shadow-lg backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
        aria-label="New chat"
        title="New chat"
      >
        <X className="size-5" />
      </button>
    </div>
  )
}

function readWorkoutScroll(key: string): number {
  try {
    const value = Number.parseInt(window.localStorage.getItem(key) ?? "", 10)
    return Number.isFinite(value) ? Math.max(0, value) : 0
  } catch {
    return 0
  }
}

function writeWorkoutScroll(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, Math.max(0, Math.round(value)).toString())
  } catch {
    /* localStorage may be unavailable in private contexts */
  }
}
