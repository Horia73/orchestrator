"use client"

import * as React from "react"
import { KeyRound, Loader2, CheckCircle2 } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { appApiPath } from "@/lib/app-path"
import { OnboardingFooter, OnboardingStepShell } from "@/components/onboarding/onboarding-chrome"

interface KeyService {
  envKey: string
  title: string
  description: string
  placeholder: string
}

const SERVICES: KeyService[] = [
  {
    envKey: "GOOGLE_MAPS_API_KEY",
    title: "Google Maps",
    description: "Unlocks Maps and Weather (they share this key).",
    placeholder: "AIza…",
  },
  {
    envKey: "TWELVE_DATA_API_KEY",
    title: "Market data",
    description: "Stock & crypto quotes, search and history for the Watchlist.",
    placeholder: "Twelve Data API key",
  },
]

function KeyCard({ service }: { service: KeyService }) {
  const [value, setValue] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [saved, setSaved] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const save = React.useCallback(async () => {
    if (!value.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(appApiPath("/api/onboarding/env"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: service.envKey, value: value.trim() }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        throw new Error(json?.error ?? "Couldn't save the key.")
      }
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the key.")
    } finally {
      setSaving(false)
    }
  }, [value, service.envKey])

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-foreground">{service.title}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{service.description}</p>
        </div>
        {saved ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> Saved
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex gap-2">
        <Input
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setSaved(false)
          }}
          placeholder={service.placeholder}
          type="password"
          className="flex-1"
        />
        <Button variant="outline" onClick={() => void save()} disabled={saving || !value.trim()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
        </Button>
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

/**
 * Optional service keys. Model-provider keys live in the Models step; this is for
 * the extras (maps/weather, market data). Fully optional — Continue advances.
 */
export function ApiKeysStep() {
  return (
    <OnboardingStepShell
      icon={<KeyRound className="h-6 w-6" />}
      title="Optional service keys"
      subtitle="Add keys for the extras you want now. You can skip any of these — the assistant can help you set them up later."
      footer={<OnboardingFooter primaryLabel="Continue" />}
    >
      <div className="space-y-3">
        {SERVICES.map((s) => (
          <KeyCard key={s.envKey} service={s} />
        ))}
      </div>
    </OnboardingStepShell>
  )
}
