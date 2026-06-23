"use client"

import * as React from "react"
import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useOnboarding } from "@/components/onboarding/onboarding-context"

/** Slim step rail across the top of the wizard. Bookends are hidden. */
export function OnboardingProgress() {
  const { steps, index } = useOnboarding()
  const visible = steps.filter((s) => !s.bookend)
  const currentVisibleIdx = visible.findIndex((s) => s.id === steps[index]?.id)

  return (
    <div className="flex items-center justify-center gap-1.5">
      {visible.map((s, i) => {
        const done = currentVisibleIdx > i
        const active = currentVisibleIdx === i
        return (
          <div key={s.id} className="flex items-center gap-1.5">
            <span
              className={cn(
                "h-1.5 rounded-full transition-all duration-300 ease-out",
                active ? "w-8 bg-foreground" : done ? "w-4 bg-foreground/40" : "w-4 bg-foreground/15",
              )}
            />
          </div>
        )
      })}
    </div>
  )
}

/**
 * Standard step layout: a centered column with an icon, title, subtitle, the
 * step body, and a footer slot. Steps render their own primary CTA via
 * <OnboardingFooter> so labels can vary ("Continue", "Begin adventure", …).
 */
export function OnboardingStepShell({
  icon,
  title,
  subtitle,
  children,
  footer,
  wide,
}: {
  icon?: React.ReactNode
  title: string
  subtitle?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-10">
        <div className={cn("flex w-full flex-col", wide ? "max-w-3xl" : "max-w-md")}>
          {icon ? (
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground/5 text-foreground">
              {icon}
            </div>
          ) : null}
          <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
          ) : null}
          {children ? <div className="mt-7">{children}</div> : null}
        </div>
      </div>
      {footer ? (
        <div className="border-t border-border/60 bg-background/80 px-6 py-4 backdrop-blur">
          <div className={cn("mx-auto w-full", wide ? "max-w-3xl" : "max-w-md")}>{footer}</div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Footer with Back / Skip / Primary. `onPrimary` defaults to advancing; steps
 * that must do async work first pass their own handler.
 */
export function OnboardingFooter({
  primaryLabel = "Continue",
  onPrimary,
  primaryDisabled,
  busy,
  hideBack,
  secondary,
}: {
  primaryLabel?: string
  onPrimary?: () => void
  primaryDisabled?: boolean
  busy?: boolean
  hideBack?: boolean
  /** Custom secondary control (e.g. a "Skip for now" link). Overrides the auto Skip. */
  secondary?: React.ReactNode
}) {
  const { index, back, next } = useOnboarding()

  // No auto "Skip for now": when Continue already advances freely it's
  // redundant. Steps where skipping has real consequences (e.g. remote access)
  // pass their own `secondary` control.
  const secondaryNode = secondary ?? <span />

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        {!hideBack && index > 0 ? (
          <Button variant="ghost" size="icon" onClick={back} aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        ) : (
          <span className="w-9" />
        )}
        {secondaryNode}
      </div>
      <Button onClick={onPrimary ?? next} disabled={primaryDisabled || busy} className="min-w-32">
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            {primaryLabel}
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </Button>
    </div>
  )
}
