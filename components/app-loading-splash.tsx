"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

const EXIT_MS = 420

/**
 * Full-screen wordmark splash shown during the very first app load (while the
 * chat store hydrates its conversation list). It overlays the blank shell so
 * the user sees a calm branded screen instead of an empty viewport, then fades
 * out smoothly the moment the app is ready. Self-managing: keep `loading` wired
 * to the store's `isLoading` and the component handles its own exit animation.
 */
export function AppLoadingSplash({ loading }: { loading: boolean }) {
  const [mounted, setMounted] = React.useState(loading)
  const [exiting, setExiting] = React.useState(false)

  React.useEffect(() => {
    if (loading) {
      setMounted(true)
      setExiting(false)
      return
    }
    if (!mounted) return
    setExiting(true)
    const timer = window.setTimeout(() => setMounted(false), EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [loading, mounted])

  if (!mounted) return null

  return (
    <div
      aria-hidden
      className={cn(
        "fixed inset-0 z-[60] flex items-center justify-center bg-background",
        "transition-opacity duration-[420ms] ease-out motion-reduce:transition-none",
        exiting ? "opacity-0" : "opacity-100"
      )}
    >
      <span className="app-splash-word -translate-y-[10vh] [font-family:var(--font-display)] text-[clamp(3rem,15vw,3.75rem)] font-medium tracking-[-0.035em] text-foreground/80 md:-translate-y-[6vh] md:text-7xl">
        Orchestrator
      </span>
    </div>
  )
}
