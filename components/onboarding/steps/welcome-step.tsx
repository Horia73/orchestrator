"use client"

import * as React from "react"
import { Sparkles, User, Cpu, Plug, Globe } from "lucide-react"

import { OnboardingFooter, OnboardingStepShell } from "@/components/onboarding/onboarding-chrome"

const HIGHLIGHTS = [
  { icon: User, label: "Set up your profile" },
  { icon: Cpu, label: "Choose your AI models" },
  { icon: Globe, label: "Reach it from anywhere" },
  { icon: Plug, label: "Connect your tools" },
]

export function WelcomeStep() {
  return (
    <OnboardingStepShell
      icon={<Sparkles className="h-6 w-6" />}
      title="Welcome to Orchestrator"
      subtitle="A quick setup gets you a working assistant. It takes a few minutes — you can change any of this later in Settings."
      footer={<OnboardingFooter primaryLabel="Get started" hideBack />}
    >
      <ul className="grid grid-cols-2 gap-3">
        {HIGHLIGHTS.map(({ icon: Icon, label }) => (
          <li
            key={label}
            className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/40 px-3 py-3"
          >
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">{label}</span>
          </li>
        ))}
      </ul>
    </OnboardingStepShell>
  )
}
