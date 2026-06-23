"use client"

import * as React from "react"
import { Cpu, Loader2, CheckCircle2, ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { appApiPath } from "@/lib/app-path"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { SettingsProvider, useSettings } from "@/components/settings/use-settings"
import { ModelPicker } from "@/components/settings/model-picker"
import { CliAccountsSection } from "@/components/settings/cli-accounts"
import { OnboardingFooter, OnboardingStepShell } from "@/components/onboarding/onboarding-chrome"
import { useOnboarding } from "@/components/onboarding/onboarding-context"

export function ModelsStep() {
  return (
    <SettingsProvider>
      <ModelsStepInner />
    </SettingsProvider>
  )
}

function ApiKeyProviderRow({
  name,
  envKey,
  configured,
  masked,
  onSaved,
}: {
  name: string
  envKey: string
  configured: boolean
  masked: string | null
  onSaved: () => void
}) {
  const [value, setValue] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const save = React.useCallback(async () => {
    if (!value.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(appApiPath("/api/onboarding/env"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: envKey, value: value.trim() }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        throw new Error(json?.error ?? "Couldn't save the key.")
      }
      setValue("")
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the key.")
    } finally {
      setSaving(false)
    }
  }, [value, envKey, onSaved])

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{name}</span>
        {configured ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> {masked ?? "Configured"}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Add {envKey}</span>
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={configured ? "Replace key…" : "Paste API key…"}
          type="password"
          className="h-8 flex-1 text-[13px]"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => void save()}
          disabled={saving || !value.trim()}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>
      {error ? <p className="mt-1.5 text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

function ModelsStepInner() {
  const onb = useOnboarding()
  const { data, setAgentOverride, refreshModels, refreshing } = useSettings()

  const existingOrchestrator = readAgentOverrideKey(data?.config, "orchestrator")
  const [selected, setSelected] = React.useState<string | null>(
    onb.data.orchestratorModel ?? existingOrchestrator,
  )
  const [showAgents, setShowAgents] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Pick up an existing orchestrator override once bootstrap resolves.
  React.useEffect(() => {
    if (!selected && existingOrchestrator) setSelected(existingOrchestrator)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingOrchestrator])

  const apiKeyProviders = data
    ? Object.entries(data.providerStatus)
        .filter(([id, s]) => id !== "browser" && s.authKind === "api-key")
        .map(([id, s]) => ({ id, status: s, def: data.providers[id] }))
    : []

  const hasUsableProvider = data
    ? Object.entries(data.providerStatus).some(([id, s]) => id !== "browser" && s.available)
    : false

  const primaryTextAgents = data
    ? data.agents.filter(
        (a) => a.tier === "primary" && a.status === "active" && a.kind === "text" && a.id !== "orchestrator",
      )
    : []

  const canContinue = hasUsableProvider && !!selected

  const handleContinue = React.useCallback(async () => {
    if (!selected) return
    const [provider, model] = splitKey(selected)
    setSaving(true)
    setError(null)
    try {
      await setAgentOverride("orchestrator", { provider, model })
      onb.setData({ orchestratorModel: selected })
      onb.next()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't assign that model.")
    } finally {
      setSaving(false)
    }
  }, [selected, setAgentOverride, onb])

  return (
    <OnboardingStepShell
      icon={<Cpu className="h-6 w-6" />}
      title="Choose your models"
      subtitle="Orchestrator runs on the model providers you connect — sign in to Claude or Codex, or add an API key. Then pick which model your main assistant uses."
      footer={
        <OnboardingFooter
          primaryLabel="Continue"
          onPrimary={handleContinue}
          primaryDisabled={!canContinue}
          busy={saving}
        />
      }
      wide
    >
      {!data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your providers…
        </div>
      ) : (
        <div className="space-y-7">
          {/* CLI providers (Claude Code / Codex) — full polished login UI. */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">Sign in to a provider</h2>
              <button
                type="button"
                onClick={() => void refreshModels()}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Refresh
              </button>
            </div>
            <CliAccountsSection />
          </section>

          {/* API-key providers — paste a key inline. */}
          {apiKeyProviders.length > 0 ? (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-foreground">…or add an API key</h2>
              <div className="space-y-2">
                {apiKeyProviders.map(({ id, status, def }) => (
                  <ApiKeyProviderRow
                    key={id}
                    name={def?.name ?? id}
                    envKey={def?.apiKeyEnv ?? `${id.toUpperCase()}_API_KEY`}
                    configured={status.apiKeyConfigured}
                    masked={status.apiKeyMasked}
                    onSaved={() => void refreshModels()}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {/* Main assistant model — the one forced choice. */}
          <section className={cn("space-y-2", !hasUsableProvider && "pointer-events-none opacity-50")}>
            <label className="text-sm font-semibold text-foreground">Main assistant model</label>
            <ModelPicker value={selected} onChange={({ providerId, modelId }) => setSelected(`${providerId}:${modelId}`)} />
            {!hasUsableProvider ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Sign in to a provider or add an API key above to choose a model.
              </p>
            ) : null}
          </section>

          {/* Optional per-agent assignment. */}
          {primaryTextAgents.length > 0 ? (
            <section className="space-y-2">
              <button
                type="button"
                onClick={() => setShowAgents((v) => !v)}
                className="flex items-center gap-1.5 text-sm font-semibold text-foreground"
              >
                <ChevronDown
                  className={cn("h-4 w-4 transition-transform", showAgents && "rotate-180")}
                />
                Customize each agent
                <span className="font-normal text-muted-foreground">(optional)</span>
              </button>
              {showAgents ? (
                <div className="space-y-2 pt-1">
                  {primaryTextAgents.map((agent) => (
                    <AgentRow key={agent.id} agentId={agent.id} name={agent.name} />
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      )}
    </OnboardingStepShell>
  )
}

function AgentRow({ agentId, name }: { agentId: string; name: string }) {
  const { data, setAgentOverride } = useSettings()
  const current = readAgentOverrideKey(data?.config, agentId)
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/40 px-3 py-2">
      <span className="truncate text-sm font-medium text-foreground">{name}</span>
      <div className="w-56 shrink-0">
        <ModelPicker
          value={current}
          noneLabel="Use default"
          onNone={() => void 0}
          onChange={({ providerId, modelId }) =>
            void setAgentOverride(agentId, { provider: providerId, model: modelId })
          }
        />
      </div>
    </div>
  )
}

function splitKey(key: string): [string, string] {
  const idx = key.indexOf(":")
  if (idx < 0) return [key, ""]
  return [key.slice(0, idx), key.slice(idx + 1)]
}

/** Read an agent's persisted override as a "provider:model" key, if any. */
function readAgentOverrideKey(
  config: { agentOverrides?: Record<string, { provider?: string; model?: string }> } | undefined,
  agentId: string,
): string | null {
  const ov = config?.agentOverrides?.[agentId]
  if (ov?.provider && ov?.model) return `${ov.provider}:${ov.model}`
  return null
}
