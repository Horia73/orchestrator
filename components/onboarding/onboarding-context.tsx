"use client"

import * as React from "react"

import { appApiPath, appPath } from "@/lib/app-path"

export type OnboardingStepId =
  | "welcome"
  | "profile"
  | "models"
  | "api-keys"
  | "remote-access"
  | "integrations"
  | "complete"

export interface OnboardingStepDef {
  id: OnboardingStepId
  /** Short label shown in the progress rail. */
  label: string
  /** Optional steps can be skipped; required steps cannot. */
  skippable?: boolean
  /** Hidden from the progress rail (welcome/complete bookends). */
  bookend?: boolean
}

export const ONBOARDING_STEPS: OnboardingStepDef[] = [
  { id: "welcome", label: "Welcome", bookend: true },
  { id: "profile", label: "Profile" },
  { id: "models", label: "Models" },
  { id: "api-keys", label: "API keys", skippable: true },
  { id: "remote-access", label: "Access", skippable: true },
  { id: "integrations", label: "Integrations", skippable: true },
  { id: "complete", label: "Done", bookend: true },
]

export interface OnboardingData {
  profileId: string | null
  userName: string
  /** Integration ids the user wants the agent to help set up. */
  selectedIntegrations: string[]
  /** True once HTTPS / remote access is configured (gates OAuth integrations). */
  httpsConfigured: boolean
  /** provider:model assigned to the orchestrator agent (the forced choice). */
  orchestratorModel: string | null
  /** The live boot conversation the user lands in after onboarding. */
  bootConversationId: string | null
}

interface OnboardingContextValue {
  steps: OnboardingStepDef[]
  index: number
  step: OnboardingStepDef
  data: OnboardingData
  setData: (patch: Partial<OnboardingData>) => void
  next: () => void
  back: () => void
  /** Record a skip for the current (skippable) step and advance. */
  skip: () => void
  goTo: (id: OnboardingStepId) => void
  /** Finalize: mark complete server-side and leave the wizard. */
  completeWizard: () => Promise<void>
  completing: boolean
}

const OnboardingContext = React.createContext<OnboardingContextValue | null>(null)

export function useOnboarding(): OnboardingContextValue {
  const ctx = React.useContext(OnboardingContext)
  if (!ctx) throw new Error("useOnboarding must be used within <OnboardingProvider>")
  return ctx
}

async function postOnboarding(body: unknown): Promise<void> {
  try {
    await fetch(appApiPath("/api/onboarding"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    })
  } catch {
    // Persistence is best-effort; the wizard stays usable offline-ish.
  }
}

export function OnboardingProvider({
  children,
  initial,
}: {
  children: React.ReactNode
  initial?: Partial<OnboardingData> & { step?: OnboardingStepId; skipped?: string[] }
}) {
  const steps = ONBOARDING_STEPS

  const [index, setIndex] = React.useState(() => {
    if (initial?.step) {
      const i = steps.findIndex((s) => s.id === initial.step)
      // Never resume straight into the celebration bookend.
      if (i >= 0 && steps[i].id !== "complete") return i
    }
    return 0
  })

  const [data, setDataState] = React.useState<OnboardingData>(() => ({
    profileId: initial?.profileId ?? null,
    userName: initial?.userName ?? "",
    selectedIntegrations: initial?.selectedIntegrations ?? [],
    httpsConfigured: initial?.httpsConfigured ?? false,
    orchestratorModel: initial?.orchestratorModel ?? null,
    bootConversationId: null,
  }))
  const skippedRef = React.useRef<Set<string>>(new Set(initial?.skipped ?? []))
  const [completing, setCompleting] = React.useState(false)

  const setData = React.useCallback((patch: Partial<OnboardingData>) => {
    setDataState((prev) => ({ ...prev, ...patch }))
  }, [])

  // Mark the wizard started once, so the grandfather inference can't flip an
  // in-progress install to "complete" underneath the user.
  React.useEffect(() => {
    void postOnboarding({ action: "start" })
  }, [])

  const persist = React.useCallback(
    (stepId: OnboardingStepId) => {
      void postOnboarding({
        action: "patch",
        step: stepId,
        skipped: Array.from(skippedRef.current),
        context: {
          userName: data.userName || undefined,
          integrations: data.selectedIntegrations,
          httpsConfigured: data.httpsConfigured,
          orchestratorModel: data.orchestratorModel || undefined,
        },
      })
    },
    [data],
  )

  const goToIndex = React.useCallback(
    (i: number) => {
      const clamped = Math.max(0, Math.min(steps.length - 1, i))
      setIndex(clamped)
      persist(steps[clamped].id)
    },
    [persist, steps],
  )

  const next = React.useCallback(() => goToIndex(index + 1), [goToIndex, index])
  const back = React.useCallback(() => goToIndex(index - 1), [goToIndex, index])
  const goTo = React.useCallback(
    (id: OnboardingStepId) => {
      const i = steps.findIndex((s) => s.id === id)
      if (i >= 0) goToIndex(i)
    },
    [goToIndex, steps],
  )

  const skip = React.useCallback(() => {
    skippedRef.current.add(steps[index].id)
    goToIndex(index + 1)
  }, [goToIndex, index, steps])

  const completeWizard = React.useCallback(async () => {
    setCompleting(true)
    await postOnboarding({
      action: "complete",
      reason: "wizard",
      context: {
        userName: data.userName || undefined,
        integrations: data.selectedIntegrations,
        httpsConfigured: data.httpsConfigured,
        orchestratorModel: data.orchestratorModel || undefined,
      },
    })
    // Full reload so the server layout re-evaluates the (now satisfied) gate and
    // the chat store hydrates the freshly-seeded boot conversation cleanly. Land
    // directly in the boot conversation when we have one.
    const target = data.bootConversationId
      ? appPath(`/?chat=${encodeURIComponent(data.bootConversationId)}`)
      : appPath("/")
    window.location.assign(target)
  }, [data])

  const value: OnboardingContextValue = {
    steps,
    index,
    step: steps[index],
    data,
    setData,
    next,
    back,
    skip,
    goTo,
    completeWizard,
    completing,
  }

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>
}
