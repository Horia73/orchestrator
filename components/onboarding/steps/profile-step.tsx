"use client"

import * as React from "react"
import { UserRound } from "lucide-react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { appApiPath } from "@/lib/app-path"
import { OnboardingFooter, OnboardingStepShell } from "@/components/onboarding/onboarding-chrome"
import { useOnboarding } from "@/components/onboarding/onboarding-context"

const COLORS = ["#2f6f73", "#3b6fb6", "#8a5cf6", "#c2410c", "#b91c5c", "#15803d", "#a16207", "#475569"]

export function ProfileStep() {
  const { data, setData, next } = useOnboarding()
  const [profileId, setProfileId] = React.useState<string | null>(data.profileId)
  const [name, setName] = React.useState(data.userName)
  const [color, setColor] = React.useState(COLORS[0])
  const [pin, setPin] = React.useState("")
  const [pinConfirm, setPinConfirm] = React.useState("")
  const [loaded, setLoaded] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(appApiPath("/api/profiles/current"), { cache: "no-store" })
        const json = await res.json().catch(() => null)
        const p = json?.profile
        if (!cancelled && p) {
          setProfileId(p.id)
          if (!data.userName) setName(p.name ?? "")
          if (p.color) setColor(p.color)
        }
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const trimmedName = name.trim()
  const pinValid = pin.length === 0 || (pin.length >= 4 && pin === pinConfirm)
  const canContinue = loaded && trimmedName.length > 0 && pinValid

  const handleContinue = React.useCallback(async () => {
    if (!profileId || !canContinue) return
    setSaving(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { name: trimmedName, color }
      if (pin.length >= 4) body.password = pin
      const res = await fetch(appApiPath(`/api/profiles/${encodeURIComponent(profileId)}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        throw new Error(json?.error ?? "Couldn't save your profile.")
      }
      setData({ profileId, userName: trimmedName })
      next()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save your profile.")
    } finally {
      setSaving(false)
    }
  }, [profileId, canContinue, trimmedName, color, pin, setData, next])

  return (
    <OnboardingStepShell
      icon={<UserRound className="h-6 w-6" />}
      title="Set up your profile"
      subtitle="This is how you'll appear in Orchestrator. A PIN is optional — add one if others can reach this device."
      footer={
        <OnboardingFooter
          primaryLabel="Continue"
          onPrimary={handleContinue}
          primaryDisabled={!canContinue}
          busy={saving}
        />
      }
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Your name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoFocus
            maxLength={40}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">Color</label>
          <div className="flex flex-wrap gap-2">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Pick color ${c}`}
                className={cn(
                  "h-8 w-8 rounded-full ring-offset-2 ring-offset-background transition",
                  color === c ? "ring-2 ring-foreground" : "ring-0 hover:scale-110",
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              PIN <span className="text-muted-foreground">(optional)</span>
            </label>
            <Input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
              placeholder="••••"
              inputMode="numeric"
              type="password"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Confirm PIN</label>
            <Input
              value={pinConfirm}
              onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, "").slice(0, 8))}
              placeholder="••••"
              inputMode="numeric"
              type="password"
              disabled={pin.length === 0}
            />
          </div>
        </div>
        {pin.length > 0 && pin.length < 4 ? (
          <p className="text-xs text-muted-foreground">PIN must be at least 4 digits.</p>
        ) : null}
        {pin.length >= 4 && pinConfirm.length > 0 && pin !== pinConfirm ? (
          <p className="text-xs text-destructive">PINs don&apos;t match.</p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </OnboardingStepShell>
  )
}
