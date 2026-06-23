"use client"

import * as React from "react"
import { Globe } from "lucide-react"

import { OnboardingFooter, OnboardingStepShell } from "@/components/onboarding/onboarding-chrome"
import { useOnboarding } from "@/components/onboarding/onboarding-context"
import { RemoteAccessPanel, isPublicHttps } from "@/components/remote-access/remote-access-panel"

export function RemoteAccessStep() {
  const { setData, next } = useOnboarding()
  const [hasHttps, setHasHttps] = React.useState(false)

  return (
    <OnboardingStepShell
      icon={<Globe className="h-6 w-6" />}
      title="Secure access & HTTPS"
      subtitle="Reach Orchestrator fast on your network, set up HTTPS for sign-ins and notifications, and optionally expose a public webhook endpoint — without opening your router."
      footer={
        <OnboardingFooter
          primaryLabel="Continue"
          onPrimary={() => {
            setData({ httpsConfigured: hasHttps })
            next()
          }}
        />
      }
      wide
    >
      <RemoteAccessPanel onStatus={(s) => setHasHttps(isPublicHttps(s.access.publicUrl))} />
    </OnboardingStepShell>
  )
}
