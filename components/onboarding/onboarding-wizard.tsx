"use client"

import * as React from "react"
import { Monitor } from "lucide-react"

import { useIsMobile } from "@/hooks/use-mobile"
import { OnboardingProgress } from "@/components/onboarding/onboarding-chrome"
import { useOnboarding } from "@/components/onboarding/onboarding-context"
import { WelcomeStep } from "@/components/onboarding/steps/welcome-step"
import { ProfileStep } from "@/components/onboarding/steps/profile-step"
import { ModelsStep } from "@/components/onboarding/steps/models-step"
import { ApiKeysStep } from "@/components/onboarding/steps/api-keys-step"
import { RemoteAccessStep } from "@/components/onboarding/steps/remote-access-step"
import { IntegrationsStep } from "@/components/onboarding/steps/integrations-step"
import { CompleteStep } from "@/components/onboarding/steps/complete-step"

function StepBody() {
  const { step } = useOnboarding()
  switch (step.id) {
    case "welcome":
      return <WelcomeStep />
    case "profile":
      return <ProfileStep />
    case "models":
      return <ModelsStep />
    case "api-keys":
      return <ApiKeysStep />
    case "remote-access":
      return <RemoteAccessStep />
    case "integrations":
      return <IntegrationsStep />
    case "complete":
      return <CompleteStep />
    default:
      return null
  }
}

/** Fades each step in on mount so step changes cross-fade rather than hard-cut. */
function StepTransition({ stepKey, children }: { stepKey: string; children: React.ReactNode }) {
  const [entered, setEntered] = React.useState(false)
  React.useEffect(() => {
    setEntered(false)
    const id = window.requestAnimationFrame(() => setEntered(true))
    return () => window.cancelAnimationFrame(id)
  }, [stepKey])
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col transition-opacity duration-200 ease-out motion-reduce:transition-none ${
        entered ? "opacity-100" : "opacity-0"
      }`}
    >
      {children}
    </div>
  )
}

function MobileBlock() {
  return (
    <div className="flex min-h-dvh w-full flex-1 flex-col items-center justify-center px-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-foreground/5 text-foreground">
        <Monitor className="h-7 w-7" />
      </div>
      <h1 className="mt-6 font-display text-xl font-semibold tracking-tight text-foreground">
        Finish setup on a computer
      </h1>
      <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">
        First-time setup needs a bigger screen — signing into providers and connecting tools. Open
        Orchestrator on your laptop or desktop to continue. You can use your phone once it&apos;s set
        up.
      </p>
    </div>
  )
}

export function OnboardingWizard() {
  const isMobile = useIsMobile()
  const { step } = useOnboarding()

  if (isMobile) return <MobileBlock />

  const showHeader = !step.bookend

  return (
    <div className="flex min-h-dvh w-full flex-1 flex-col bg-background">
      <header className="flex items-center justify-between px-6 py-4">
        <span className="font-display text-sm font-semibold tracking-tight text-foreground">
          Orchestrator
        </span>
        <div className={showHeader ? "opacity-100" : "opacity-0"}>
          <OnboardingProgress />
        </div>
        <span className="w-24" />
      </header>
      <StepTransition stepKey={step.id}>
        <StepBody />
      </StepTransition>
    </div>
  )
}
