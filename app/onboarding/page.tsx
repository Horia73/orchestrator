"use client"

import * as React from "react"

import { appApiPath } from "@/lib/app-path"
import {
  OnboardingProvider,
  type OnboardingData,
  type OnboardingStepId,
} from "@/components/onboarding/onboarding-context"
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard"

type InitialSeed = Partial<OnboardingData> & { step?: OnboardingStepId; skipped?: string[] }

export default function OnboardingPage() {
  const [ready, setReady] = React.useState(false)
  const [seed, setSeed] = React.useState<InitialSeed | undefined>(undefined)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(appApiPath("/api/onboarding"), { cache: "no-store" })
        const json = await res.json().catch(() => null)
        if (cancelled) return
        if (json?.complete) {
          window.location.assign(appApiPath("/"))
          return
        }
        const ctx = json?.state?.context ?? {}
        setSeed({
          step: json?.state?.step ?? undefined,
          skipped: json?.state?.skipped ?? [],
          userName: ctx.userName ?? undefined,
          selectedIntegrations: ctx.integrations ?? undefined,
          httpsConfigured: ctx.httpsConfigured ?? undefined,
          orchestratorModel: ctx.orchestratorModel ?? undefined,
        })
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!ready) {
    return <div className="min-h-dvh bg-background" />
  }

  return (
    <OnboardingProvider initial={seed}>
      <OnboardingWizard />
    </OnboardingProvider>
  )
}
