"use client"

import * as React from "react"
import { PartyPopper } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import { useOnboarding } from "@/components/onboarding/onboarding-context"

export function CompleteStep() {
  const { completeWizard, completing, data } = useOnboarding()
  const [entered, setEntered] = React.useState(false)

  React.useEffect(() => {
    const id = window.requestAnimationFrame(() => setEntered(true))
    return () => window.cancelAnimationFrame(id)
  }, [])

  const name = data.userName?.trim()

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10 text-center">
      <div
        className={`flex flex-col items-center transition-all duration-500 ease-out ${
          entered ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
        }`}
      >
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-3xl bg-foreground/5 text-foreground">
          <PartyPopper className="h-8 w-8" />
        </div>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
          {name ? `You're all set, ${name}` : "You're all set"}
        </h1>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
          Orchestrator is ready. Your assistant is waiting in a fresh conversation — say hello and
          it&apos;ll take it from there.
        </p>
        <Button size="lg" className="mt-8 min-w-48" onClick={() => void completeWizard()} disabled={completing}>
          {completing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Begin adventure"}
        </Button>
      </div>
    </div>
  )
}
