"use client"

import * as React from "react"
import { AlertCircle, Check, CheckCircle2, ChevronDown, FlaskConical, KeyRound } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { AgentFallback, BrowserAgentModelSettings, BrowserAgentModelSlot, BrowserAgentSettings, ModelDef, ModelFeatureValue, ModelPricing, ThinkingLevel } from "@/lib/config"
import { useSettings, type AgentInfo, type ProviderStatus, type SettingsBootstrap } from "./use-settings"
import { ModelPicker, type ModelPickerOption } from "./model-picker"

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string }

type ModelFeature = NonNullable<import("@/lib/config").ModelDef["features"]>[number]
type EnumModelFeature = Extract<ModelFeature, { type: "enum" }>
const AUDIO_CONTEXT_AGENT_ID = "audio_context_agent"

const KNOWN_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const

const THINKING_LABELS: Record<string, string> = {
  none: "Off",
  minimal: "Off",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
}

const NON_SELECTABLE_THINKING_LEVELS = new Set(["off", "auto", "enabled", "disabled", "reasoning", "thinking"])

export function AgentCard({
  agentId,
  className,
}: {
  agentId: string
  className?: string
}) {
  const { data, setAgentOverride, setBrowserAgentModel, setBrowserAgentBackend, setBrowserAgentProEnabled } = useSettings()
  const [status, setStatus] = React.useState<SaveStatus>({ kind: "idle" })
  const [fallbacksOpen, setFallbacksOpen] = React.useState(false)

  // Auto-clear "saved" badge after a couple seconds
  React.useEffect(() => {
    if (status.kind !== "saved") return
    const t = setTimeout(() => setStatus({ kind: "idle" }), 2200)
    return () => clearTimeout(t)
  }, [status])

  if (!data) return null

  const agent = data.agents.find(a => a.id === agentId)
  if (!agent) {
    return (
      <Card className={className}>
        <CardContent className="pt-5">
          <p className="text-[14px] text-foreground/60">Agent <code>{agentId}</code> not found.</p>
        </CardContent>
      </Card>
    )
  }

  if (agent.id === "browser_agent") {
    return (
      <BrowserAgentCard
        agent={agent}
        data={data}
        setBrowserAgentModel={setBrowserAgentModel}
        setBrowserAgentBackend={setBrowserAgentBackend}
        setBrowserAgentProEnabled={setBrowserAgentProEnabled}
        className={className}
      />
    )
  }

  // Resolve effective settings: override wins, otherwise the agent default,
  // then global. This matters for media agents: changing Image Generator from
  // Google to OpenAI in Settings should route that agent directly, not through
  // a fallback or the global chat model.
  const override = data.config.agentOverrides[agentId]
  const effectiveProvider = override?.provider ?? agent.defaultProvider ?? data.config.activeProvider
  const effectiveModel = override?.model ?? agent.defaultModel ?? data.config.activeModel
  const effectiveThinkingLevel: ThinkingLevel =
    override?.thinkingLevel ?? agent.defaultThinkingLevel ?? data.config.thinkingLevel

  const providerDef = data.providers[effectiveProvider]
  const modelDef = providerDef?.models[effectiveModel]
  const providerStatus = data.providerStatus?.[effectiveProvider]
  const providerReady = providerStatus?.available ?? false

  // Thinking is a model capability, not an agent-kind capability. Planned
  // execution agents still expose it when their selected model supports it.
  const availableThinkingLevels = availableThinkingLevelsForModel(modelDef)
  const selectedThinkingLevel = normalizeThinkingLevelForModel(modelDef, effectiveThinkingLevel)
  const hasThinkingSettings = availableThinkingLevels.length > 0
  const visibleFeatures = visibleModelFeatures(modelDef?.features ?? [], hasThinkingSettings)
  const effectiveModelOptions = {
    ...defaultModelOptions(visibleFeatures),
    ...modelOptionsForFeatures(visibleFeatures, override?.modelOptions),
  }
  const effectiveFallbacks = normalizeUiFallbacks(override?.fallbacks)
  const fallbackCapable = supportsAgentFallbacks(agent)
  const modelFilter =
    agent.id === AUDIO_CONTEXT_AGENT_ID ? isAudioContextCompatibleModel : undefined

  const save = async (next: { provider: string; model: string; thinkingLevel: ThinkingLevel; modelOptions?: Record<string, ModelFeatureValue>; fallbacks?: AgentFallback[] }) => {
    setStatus({ kind: "saving" })
    try {
      // Strip fallbacks before spreading: the server rejects any fallbacks field
      // — even an empty array — for non-text agents, so a model/feature change on
      // a media agent (image/video/speech/music) would otherwise 400. Only re-add
      // when the agent actually supports fallbacks.
      const { fallbacks, ...rest } = next
      await setAgentOverride(agentId, {
        ...rest,
        ...(fallbackCapable && fallbacks && fallbacks.length > 0
          ? { fallbacks }
          : {}),
      })
      setStatus({ kind: "saved", at: Date.now() })
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Save failed" })
    }
  }

  const handleModelChange = ({ providerId, modelId }: { providerId: string; modelId: string }) => {
    const newProviderDef = data.providers[providerId]
    const newModelDef = newProviderDef?.models[modelId]
    // If new model doesn't support current thinking level, fall back to its default.
    const nextThinkingLevel = normalizeThinkingLevelForModel(newModelDef, selectedThinkingLevel)
    const nextHasThinkingSettings = availableThinkingLevelsForModel(newModelDef).length > 0
    const nextVisibleFeatures = visibleModelFeatures(newModelDef?.features ?? [], nextHasThinkingSettings)
    save({
      provider: providerId,
      model: modelId,
      thinkingLevel: nextThinkingLevel,
      modelOptions: defaultModelOptions(nextVisibleFeatures),
      fallbacks: effectiveFallbacks,
    })
  }

  const handleThinkingChange = (level: ThinkingLevel) => {
    if (level === selectedThinkingLevel) return
    save({ provider: effectiveProvider, model: effectiveModel, thinkingLevel: level, modelOptions: effectiveModelOptions, fallbacks: effectiveFallbacks })
  }

  const handleFeatureChange = (featureId: string, value: ModelFeatureValue) => {
    save({
      provider: effectiveProvider,
      model: effectiveModel,
      thinkingLevel: selectedThinkingLevel,
      modelOptions: { ...effectiveModelOptions, [featureId]: value },
      fallbacks: effectiveFallbacks,
    })
  }

  const handleFallbackChange = (slot: 0 | 1, value: AgentFallback | null) => {
    const nextFallbacks = effectiveFallbacks.slice()
    if (value === null) {
      if (slot === 0) nextFallbacks.splice(0)
      else nextFallbacks.splice(1)
    } else {
      nextFallbacks[slot] = value
    }
    save({
      provider: effectiveProvider,
      model: effectiveModel,
      thinkingLevel: selectedThinkingLevel,
      modelOptions: effectiveModelOptions,
      fallbacks: nextFallbacks.filter(isAgentFallback).slice(0, 2),
    })
  }

  return (
    <Card className={cn("relative", className)}>
      {/* Save badge — absolutely positioned so it doesn't reflow the title */}
      <div className="pointer-events-none absolute top-3.5 right-3.5 z-10">
        <SaveBadge status={status} />
      </div>

      <CardHeader className="pr-20">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <CardTitle>{agent.name}</CardTitle>
          {agent.kind !== "text" && <KindBadge kind={agent.kind} />}
          {agent.status === "planned" && <StatusBadge />}
        </div>
        <CardDescription className="mt-1 line-clamp-2" title={agent.description}>
          {agent.description}
        </CardDescription>
      </CardHeader>

      <CardContent>
        {/* Browser agent gets the same picker as every other text agent —
            user chooses which LLM drives the browser-automation script. */}
        <Field label="Model" hint={modelDef ? formatModelHint(modelDef) : undefined}>
          <ModelPicker
            value={`${effectiveProvider}:${effectiveModel}`}
            onChange={handleModelChange}
            filterModel={modelFilter}
          />
        </Field>

        {/* Thinking is rendered from the selected model's metadata, not from
            the agent kind. */}
        {hasThinkingSettings && (
          <Field label="Thinking">
            {availableThinkingLevels.length > 1 ? (
              <SegmentedThinking
                value={selectedThinkingLevel}
                available={availableThinkingLevels}
                onChange={handleThinkingChange}
              />
            ) : (
              <div className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-muted/40 text-[12.5px] text-foreground/50">
                Not adjustable for this model
              </div>
            )}
          </Field>
        )}

        {visibleFeatures.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="flex w-full items-center gap-2">
              <span className="text-[12px] font-medium uppercase tracking-wider text-foreground/55">
                Features
              </span>
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-foreground/55">
                {visibleFeatures.length}
              </span>
            </div>
            <FeatureControls
              features={visibleFeatures}
              values={effectiveModelOptions}
              onChange={handleFeatureChange}
            />
          </div>
        )}

        {fallbackCapable && (
          <FallbackSection
            open={fallbacksOpen}
            onOpenChange={setFallbacksOpen}
            fallbacks={effectiveFallbacks}
            data={data}
            onChange={handleFallbackChange}
          />
        )}

        {/* Warnings rendered AFTER picker + thinking so the controls line up
            across cards regardless of how many warnings are active. */}
        {!providerReady && providerDef && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[12px] text-amber-700 dark:text-amber-400">
            <KeyRound className="mt-0.5 size-3.5 shrink-0" />
            <p>{formatProviderUnavailable(providerStatus, providerDef.apiKeyEnv)}</p>
          </div>
        )}

        {modelDef?.dataCompleteness === "incomplete" && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[12px] text-amber-700 dark:text-amber-400">
            <FlaskConical className="mt-0.5 size-3.5 shrink-0" />
            <p>
              Data incomplete: {formatMissingFields(modelDef.missingFields)}. Use Research model details to fill from official docs.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function FallbackSection({
  open,
  onOpenChange,
  fallbacks,
  data,
  onChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  fallbacks: AgentFallback[]
  data: SettingsBootstrap
  onChange: (slot: 0 | 1, value: AgentFallback | null) => void
}) {
  const activeCount = fallbacks.length

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/20 p-2.5">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex min-h-8 w-full items-center justify-between gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-[12px] font-medium uppercase tracking-wider text-foreground/55">
            Fallbacks
          </span>
          <span className="rounded-full bg-background px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-foreground/50 ring-1 ring-border/60">
            {activeCount}/2
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-foreground/45 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div className="flex flex-col gap-3 pt-1">
          <FallbackSlotControls
            title="Fallback 1"
            value={fallbacks[0] ?? null}
            data={data}
            onChange={(value) => onChange(0, value)}
          />
          {fallbacks[0] && (
            <FallbackSlotControls
              title="Fallback 2"
              value={fallbacks[1] ?? null}
              data={data}
              onChange={(value) => onChange(1, value)}
            />
          )}
        </div>
      )}
    </div>
  )
}

function FallbackSlotControls({
  title,
  value,
  data,
  onChange,
}: {
  title: string
  value: AgentFallback | null
  data: SettingsBootstrap
  onChange: (value: AgentFallback | null) => void
}) {
  const modelDef = value ? data.providers[value.provider]?.models[value.model] : undefined
  const availableThinkingLevels = availableThinkingLevelsForModel(modelDef)
  const effectiveThinkingLevel =
    value && availableThinkingLevels.length > 0
      ? normalizeThinkingLevelForModel(modelDef, value.thinkingLevel ?? modelDef?.defaultThinkingLevel ?? availableThinkingLevels[0])
      : value?.thinkingLevel

  const handleModelChange = ({ providerId, modelId }: { providerId: string; modelId: string }) => {
    const nextModelDef = data.providers[providerId]?.models[modelId]
    const nextThinkingLevel = normalizeThinkingLevelForModel(
      nextModelDef,
      effectiveThinkingLevel ?? nextModelDef?.defaultThinkingLevel ?? "medium"
    )
    onChange({
      provider: providerId,
      model: modelId,
      thinkingLevel: nextThinkingLevel,
    })
  }

  const handleThinkingChange = (thinkingLevel: ThinkingLevel) => {
    if (!value) return
    onChange({ ...value, thinkingLevel })
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Field label={title} hint={modelDef ? formatModelHint(modelDef) : undefined}>
        <ModelPicker
          value={value ? `${value.provider}:${value.model}` : null}
          noneLabel="None"
          onNone={() => onChange(null)}
          onChange={handleModelChange}
          filterModel={isTextCompatibleModel}
        />
      </Field>

      {value && availableThinkingLevels.length > 0 && effectiveThinkingLevel && (
        <Field label="Thinking">
          {availableThinkingLevels.length > 1 ? (
            <SegmentedThinking
              value={effectiveThinkingLevel}
              available={availableThinkingLevels}
              onChange={handleThinkingChange}
            />
          ) : (
            <div className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-background/70 text-[12.5px] text-foreground/50 ring-1 ring-border/50">
              Not adjustable for this model
            </div>
          )}
        </Field>
      )}
    </div>
  )
}

function BrowserAgentCard({
  agent,
  data,
  setBrowserAgentModel,
  setBrowserAgentBackend,
  setBrowserAgentProEnabled,
  className,
}: {
  agent: AgentInfo
  data: SettingsBootstrap
  setBrowserAgentModel: (slot: BrowserAgentModelSlot, override: BrowserAgentModelSettings) => Promise<void>
  setBrowserAgentBackend: (backend: BrowserAgentSettings["backend"]) => Promise<void>
  setBrowserAgentProEnabled: (proEnabled: boolean) => Promise<void>
  className?: string
}) {
  const [status, setStatus] = React.useState<SaveStatus>({ kind: "idle" })

  React.useEffect(() => {
    if (status.kind !== "saved") return
    const t = setTimeout(() => setStatus({ kind: "idle" }), 2200)
    return () => clearTimeout(t)
  }, [status])

  const save = async (slot: BrowserAgentModelSlot, next: BrowserAgentModelSettings) => {
    setStatus({ kind: "saving" })
    try {
      await setBrowserAgentModel(slot, next)
      setStatus({ kind: "saved", at: Date.now() })
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Save failed" })
    }
  }

  const saveBackend = async (backend: BrowserAgentSettings["backend"]) => {
    if (backend === data.config.browserAgent.backend) return
    setStatus({ kind: "saving" })
    try {
      await setBrowserAgentBackend(backend)
      setStatus({ kind: "saved", at: Date.now() })
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Save failed" })
    }
  }

  const saveProEnabled = async (proEnabled: boolean) => {
    if (proEnabled === data.config.browserAgent.proEnabled) return
    setStatus({ kind: "saving" })
    try {
      await setBrowserAgentProEnabled(proEnabled)
      setStatus({ kind: "saved", at: Date.now() })
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : "Save failed" })
    }
  }

  const proEnabled = data.config.browserAgent.proEnabled
  const selectedProviders = new Set([
    data.config.browserAgent.light.provider,
    ...(proEnabled ? [data.config.browserAgent.pro.provider] : []),
  ])
  const missingProvider = [...selectedProviders].find(providerId => {
    const provider = data.providers[providerId]
    if (!provider) return false
    return !(data.providerStatus?.[providerId]?.available ?? false)
  })
  const missingProviderDef = missingProvider ? data.providers[missingProvider] : undefined

  return (
    <Card className={cn("relative", className)}>
      <div className="pointer-events-none absolute top-3.5 right-3.5 z-10">
        <SaveBadge status={status} />
      </div>

      <CardHeader className="pr-20">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <CardTitle>{agent.name}</CardTitle>
        </div>
        <CardDescription className="mt-1 line-clamp-2" title={agent.description}>
          {agent.description}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="flex flex-col gap-4">
          <BrowserBackendControls
            value={data.config.browserAgent.backend}
            status={data.config.browserAgentBackend}
            onChange={saveBackend}
          />
          <BrowserModelSlotControls
            title="Light model"
            slot="light"
            value={data.config.browserAgent.light}
            data={data}
            onChange={save}
          />

          <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-background px-2.5 py-2">
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-foreground">Enable Pro model</p>
              <p className="mt-0.5 text-[12px] text-foreground/60">
                {proEnabled
                  ? "Multi mode: the light model escalates to the pro model on hard blockers."
                  : "Single mode: the light model runs solo, with no escalation."}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={proEnabled}
              aria-label="Enable Pro model"
              onClick={() => saveProEnabled(!proEnabled)}
              className={cn(
                "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                proEnabled ? "bg-emerald-500" : "bg-muted-foreground/25"
              )}
            >
              <span
                className={cn(
                  "absolute left-0.5 top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform",
                  proEnabled ? "translate-x-4" : "translate-x-0"
                )}
              />
            </button>
          </div>

          {proEnabled && (
            <BrowserModelSlotControls
              title="Pro model"
              slot="pro"
              value={data.config.browserAgent.pro}
              data={data}
              onChange={save}
            />
          )}
        </div>

        {missingProviderDef && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[12px] text-amber-700 dark:text-amber-400">
            <KeyRound className="mt-0.5 size-3.5 shrink-0" />
            <p>
              {formatProviderUnavailable(data.providerStatus?.[missingProvider!], missingProviderDef.apiKeyEnv)}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const BROWSER_BACKEND_OPTIONS: Array<{ value: BrowserAgentSettings["backend"]; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "patchright", label: "Patchright" },
  { value: "official-display", label: "Chromium" },
]

function BrowserBackendControls({
  value,
  status,
  onChange,
}: {
  value: BrowserAgentSettings["backend"]
  status: SettingsBootstrap["config"]["browserAgentBackend"]
  onChange: (backend: BrowserAgentSettings["backend"]) => void
}) {
  const envLocked = status.envOverride !== null
  const effectiveLabel = status.effective === "official-display" ? "Chromium display" : "Patchright"
  const statusText = backendStatusText(status, envLocked)
  const showUnavailable = !status.officialDisplay.supported && (
    value === "official-display" ||
    (value === "auto" && status.platform === "linux")
  )
  const showStatusLine = envLocked || showUnavailable

  return (
    <Field label="Browser backend" hint={`Effective: ${effectiveLabel}`}>
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5" title={statusText}>
          {BROWSER_BACKEND_OPTIONS.map(option => {
            const selected = value === option.value
            return (
              <button
                key={option.value}
                type="button"
                disabled={envLocked}
                onClick={() => onChange(option.value)}
                aria-pressed={selected}
                className={cn(
                  "inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
                  selected
                    ? "bg-background text-foreground shadow-sm"
                    : "text-foreground/55 hover:bg-background/55 hover:text-foreground"
                )}
              >
                <Check className={cn("size-3 shrink-0", selected ? "opacity-100" : "opacity-0")} />
                <span className="min-w-0 truncate">{option.label}</span>
              </button>
            )
          })}
        </div>

        {showStatusLine && (
          <p className="truncate text-[11.5px] text-foreground/50" title={statusText}>
            {statusText}
          </p>
        )}

        {showUnavailable && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[12px] text-amber-700 dark:text-amber-400">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <p className="min-w-0">{status.reason}</p>
          </div>
        )}
      </div>
    </Field>
  )
}

function backendStatusText(
  status: SettingsBootstrap["config"]["browserAgentBackend"],
  envLocked: boolean
): string {
  if (envLocked) return `Set by BROWSER_AGENT_BACKEND=${status.envOverride}`
  if (status.configured === "auto") return status.reason
  return "Managed in Settings"
}

function BrowserModelSlotControls({
  title,
  slot,
  value,
  data,
  onChange,
}: {
  title: string
  slot: BrowserAgentModelSlot
  value: BrowserAgentModelSettings
  data: SettingsBootstrap
  onChange: (slot: BrowserAgentModelSlot, next: BrowserAgentModelSettings) => void
}) {
  const providerDef = data.providers[value.provider]
  const modelDef = providerDef?.models[value.model]
  const availableThinkingLevels = availableBrowserThinkingLevelsForModel(modelDef)
  const hasThinkingSettings = availableThinkingLevels.length > 0
  const visibleFeatures = browserVisibleFeatures(modelDef?.features ?? [], hasThinkingSettings)
  const effectiveModelOptions = {
    ...defaultBrowserModelOptions(visibleFeatures),
    ...modelOptionsForFeatures(visibleFeatures, value.modelOptions),
  }
  const effectiveThinkingLevel = availableThinkingLevels.includes(value.thinkingLevel)
    ? value.thinkingLevel
    : browserThinkingFallback(availableThinkingLevels)

  const handleModelChange = ({ providerId, modelId }: { providerId: string; modelId: string }) => {
    const nextModelDef = data.providers[providerId]?.models[modelId]
    const nextThinkingLevels = availableBrowserThinkingLevelsForModel(nextModelDef)
    const supportsCurrent = nextThinkingLevels.includes(effectiveThinkingLevel)
    const nextThinkingLevel: ThinkingLevel = supportsCurrent
      ? effectiveThinkingLevel
      : browserThinkingFallback(nextThinkingLevels)
    const nextHasThinkingSettings = nextThinkingLevels.length > 0
    const nextVisibleFeatures = browserVisibleFeatures(nextModelDef?.features ?? [], nextHasThinkingSettings)
    onChange(slot, {
      provider: providerId,
      model: modelId,
      thinkingLevel: nextThinkingLevel,
      modelOptions: defaultBrowserModelOptions(nextVisibleFeatures),
    })
  }

  const handleThinkingChange = (thinkingLevel: ThinkingLevel) => {
    if (thinkingLevel === value.thinkingLevel) return
    onChange(slot, { ...value, thinkingLevel, modelOptions: effectiveModelOptions })
  }

  const handleFeatureChange = (featureId: string, featureValue: ModelFeatureValue) => {
    onChange(slot, {
      ...value,
      thinkingLevel: effectiveThinkingLevel,
      modelOptions: { ...effectiveModelOptions, [featureId]: featureValue },
    })
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Field label={title} hint={modelDef ? formatModelHint(modelDef) : undefined}>
        <ModelPicker
          value={`${value.provider}:${value.model}`}
          onChange={handleModelChange}
          filterModel={isBrowserCompatibleModel}
        />
      </Field>

      {availableThinkingLevels.length > 0 && (
        <Field label="Thinking">
          {availableThinkingLevels.length > 1 ? (
            <SegmentedThinking
              value={effectiveThinkingLevel}
              available={availableThinkingLevels}
              onChange={handleThinkingChange}
            />
          ) : (
            <div className="inline-flex h-9 w-full items-center justify-center rounded-lg bg-muted/40 text-[12.5px] text-foreground/50">
              Not adjustable for this model
            </div>
          )}
        </Field>
      )}

      {visibleFeatures.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex w-full items-center gap-2">
            <span className="text-[12px] font-medium uppercase tracking-wider text-foreground/55">
              Features
            </span>
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-foreground/55">
              {visibleFeatures.length}
            </span>
          </div>
          <FeatureControls
            features={visibleFeatures}
            values={effectiveModelOptions}
            onChange={handleFeatureChange}
          />
        </div>
      )}
    </div>
  )
}

function isBrowserCompatibleModel(option: ModelPickerOption): boolean {
  return option.providerId === "google" && (option.model.kinds.includes("text") || option.model.capabilities.includes("text"))
}

function isAudioContextCompatibleModel(option: ModelPickerOption): boolean {
  return option.providerId === "google" && isTextCompatibleModel(option)
}

function isTextCompatibleModel(option: ModelPickerOption): boolean {
  return option.model.kinds.includes("text") || option.model.capabilities.includes("text")
}

function supportsAgentFallbacks(agent: AgentInfo): boolean {
  return (
    (agent.kind === "text" || agent.kind === "concierge") &&
    agent.id !== "browser_agent" &&
    agent.id !== AUDIO_CONTEXT_AGENT_ID &&
    agent.id !== "phone_agent" &&
    agent.id !== "android_agent"
  )
}

function normalizeUiFallbacks(value: AgentFallback[] | undefined): AgentFallback[] {
  if (!Array.isArray(value)) return []
  return value.filter(isAgentFallback).slice(0, 2)
}

function isAgentFallback(value: unknown): value is AgentFallback {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<AgentFallback>
  return typeof candidate.provider === "string" && typeof candidate.model === "string"
}

function formatProviderUnavailable(status: ProviderStatus | undefined, apiKeyEnv: string): React.ReactNode {
  if (status?.authKind === "cli") {
    return status.cliInstalled === false
      ? `${status.cliName ?? "CLI"} is not installed. Install it in Settings > Auth.`
      : `${status.cliName ?? "CLI"} is not logged in. Log in from Settings > Auth.`
  }
  if (status?.authKind === "api-key" || !apiKeyEnv.includes("NO_API_KEY")) {
    return (
      <>
        Missing <code className="rounded bg-amber-500/10 px-1 py-0.5 text-[11px]">{apiKeyEnv}</code> in environment.
      </>
    )
  }
  if (status?.unavailableReason) return status.unavailableReason
  return (
    <>
      Missing <code className="rounded bg-amber-500/10 px-1 py-0.5 text-[11px]">{apiKeyEnv}</code> in environment.
    </>
  )
}

function availableBrowserThinkingLevelsForModel(modelDef: ModelDef | undefined): ThinkingLevel[] {
  return availableThinkingLevelsForModel(modelDef).filter(isBrowserRuntimeThinkingLevel)
}

function isBrowserRuntimeThinkingLevel(level: ThinkingLevel): boolean {
  return level === "minimal" || level === "low" || level === "medium" || level === "high"
}

function browserThinkingFallback(levels: ThinkingLevel[]): ThinkingLevel {
  if (levels.includes("high")) return "high"
  if (levels.includes("low")) return "low"
  return levels[0] ?? "high"
}

function defaultBrowserModelOptions(features: NonNullable<ModelDef["features"]>): Record<string, ModelFeatureValue> {
  const out = defaultModelOptions(features)
  const mediaFeature = features.find(feature => feature.id === "media_resolution")
  const hasExplicitMediaDefault = mediaFeature && "defaultValue" in mediaFeature && mediaFeature.defaultValue !== undefined
  if (mediaFeature && !hasExplicitMediaDefault && (!out.media_resolution || out.media_resolution === "media_resolution_low")) {
    out.media_resolution = "media_resolution_medium"
  }
  return out
}

function browserVisibleFeatures(
  features: NonNullable<ModelDef["features"]>,
  hasThinkingSettings: boolean
): NonNullable<ModelDef["features"]> {
  return visibleModelFeatures(features, hasThinkingSettings)
    .map(feature => {
      if (feature.id !== "media_resolution" || feature.type !== "enum") return feature
      return {
        ...feature,
        options: feature.options.filter(option => option.value !== "media_resolution_ultra_high"),
      }
    })
    .filter(feature => feature.type !== "enum" || feature.options.length > 0)
}

function KindBadge({ kind }: { kind: AgentInfo["kind"] }) {
  // Distinct hue per non-text kind so cards are scannable at a glance.
  const styles =
    kind === "image" ? "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400"
    : kind === "video" ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400"
    : kind === "speech" ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400"
    : kind === "music" ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
    : kind === "concierge" ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400"
    : kind === "phone" ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400"
    : kind === "android" ? "border-lime-500/30 bg-lime-500/10 text-lime-700 dark:text-lime-400"
    : "border-foreground/20 bg-muted text-foreground/65"
  return (
    <span className={cn("inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium", styles)}>
      {kind}
    </span>
  )
}

function StatusBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
      planned
    </span>
  )
}

function FeatureControls({
  features,
  values,
  onChange,
}: {
  features: NonNullable<import("@/lib/config").ModelDef["features"]>
  values: Record<string, ModelFeatureValue>
  onChange: (featureId: string, value: ModelFeatureValue) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {features.map(feature => {
        const value = values[feature.id] ?? featureDefaultValue(feature)
        if (feature.type === "boolean") {
          const checked = Boolean(value)
          return (
            <div key={feature.id} className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-background px-2.5 py-2">
              <FeatureLabel label={feature.label} description={feature.description} />
              <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={feature.label}
                onClick={() => onChange(feature.id, !checked)}
                className={cn(
                  "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  checked ? "bg-emerald-500" : "bg-muted-foreground/25"
                )}
              >
                <span
                  className={cn(
                    "absolute left-0.5 top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform",
                    checked ? "translate-x-4" : "translate-x-0"
                  )}
                />
              </button>
            </div>
          )
        }

        if (feature.type === "enum") {
          return (
            <div key={feature.id} className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-background px-2.5 py-2">
              <FeatureLabel label={feature.label} description={feature.description} />
              <FeatureEnumDropdown
                feature={feature}
                value={String(value ?? feature.options[0]?.value ?? "")}
                onChange={next => onChange(feature.id, next)}
              />
            </div>
          )
        }

        if (feature.type === "number") {
          return (
            <div key={feature.id} className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-background px-2.5 py-2">
              <FeatureLabel label={feature.label} description={feature.description} />
              <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
                <input
                  type="number"
                  value={typeof value === "number" ? value : feature.defaultValue ?? ""}
                  min={feature.min}
                  max={feature.max}
                  step={feature.step}
                  onChange={e => {
                    const n = Number(e.target.value)
                    if (Number.isFinite(n)) onChange(feature.id, n)
                  }}
                  className="h-7 w-20 rounded-md border border-border bg-background px-2 text-right text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                />
                {feature.unit && <span className="text-[11.5px] text-foreground/45">{feature.unit}</span>}
              </div>
            </div>
          )
        }

        return (
          <div key={feature.id} className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-background px-2.5 py-2">
            <FeatureLabel label={feature.label} description={feature.description} />
            <input
              value={String(value ?? feature.defaultValue ?? "")}
              placeholder={feature.placeholder}
              onChange={e => onChange(feature.id, e.target.value)}
              className="mt-0.5 h-7 min-w-0 max-w-36 shrink-0 rounded-md border border-border bg-background px-2 text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
        )
      })}
    </div>
  )
}

function FeatureEnumDropdown({
  feature,
  value,
  onChange,
}: {
  feature: EnumModelFeature
  value: string
  onChange: (value: string) => void
}) {
  const selected = feature.options.find(option => option.value === value) ?? feature.options[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 min-w-28 max-w-40 shrink-0 items-center justify-between gap-2 rounded-md border border-border bg-background px-2 text-left text-[12.5px] text-foreground outline-none transition-colors",
            "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50"
          )}
          aria-label={feature.label}
        >
          <span className="min-w-0 truncate">{selected?.label ?? value}</span>
          <ChevronDown className="size-3.5 shrink-0 text-foreground/45" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {feature.options.map(option => {
          const active = option.value === value
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onChange(option.value)}
              className="items-start gap-2 py-1.5"
            >
              <Check className={cn("mt-0.5 size-3.5 shrink-0", active ? "opacity-100" : "opacity-0")} />
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-medium">{option.label}</span>
                {option.description && (
                  <span className="mt-0.5 block line-clamp-2 text-[11px] leading-snug text-foreground/45">
                    {option.description}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function FeatureLabel({ label, description }: { label: string; description?: string }) {
  const [expanded, setExpanded] = React.useState(false)
  const collapsible = (description?.length ?? 0) > 120

  return (
    <div className="min-w-0 flex-1">
      <p className="break-words text-[12.5px] font-medium leading-snug text-foreground/75">{label}</p>
      {description && (
        <>
          <p className={cn("mt-0.5 break-words text-[11.5px] leading-snug text-foreground/50", collapsible && !expanded && "line-clamp-3")}>
            {description}
          </p>
          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded(value => !value)}
              className="mt-1 text-[11px] font-medium text-foreground/45 transition-colors hover:text-foreground"
            >
              {expanded ? "Less" : "More"}
            </button>
          )}
        </>
      )}
    </div>
  )
}

function defaultModelOptions(features: NonNullable<import("@/lib/config").ModelDef["features"]>): Record<string, ModelFeatureValue> {
  const out: Record<string, ModelFeatureValue> = {}
  for (const feature of features) {
    const value = featureDefaultValue(feature)
    if (value !== undefined) out[feature.id] = value
  }
  return out
}

function modelOptionsForFeatures(
  features: NonNullable<ModelDef["features"]>,
  values: Record<string, ModelFeatureValue> | undefined
): Record<string, ModelFeatureValue> {
  if (!values) return {}
  const allowed = new Set(features.map(feature => feature.id))
  const out: Record<string, ModelFeatureValue> = {}
  for (const [key, value] of Object.entries(values)) {
    if (allowed.has(key)) out[key] = value
  }
  return out
}

function availableThinkingLevelsForModel(modelDef: ModelDef | undefined): ThinkingLevel[] {
  return sanitizeThinkingLevels(modelDef?.thinkingLevels ?? [])
}

function normalizeThinkingLevelForModel(modelDef: ModelDef | undefined, current: ThinkingLevel): ThinkingLevel {
  const available = availableThinkingLevelsForModel(modelDef)
  if (available.length === 0) return current
  if (available.includes(current)) return current
  const fallback = modelDef?.defaultThinkingLevel
  return fallback && available.includes(fallback) ? fallback : available[0]
}

function sanitizeThinkingLevels(levels: ThinkingLevel[]): ThinkingLevel[] {
  const seen = new Set<string>()
  return levels.filter(level => {
    const normalized = normalizeFeatureToken(level)
    if (!normalized || NON_SELECTABLE_THINKING_LEVELS.has(normalized) || seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

function visibleModelFeatures(features: NonNullable<ModelDef["features"]>, hasThinkingSettings: boolean): NonNullable<ModelDef["features"]> {
  const nonInternalFeatures = features.filter(feature => !isInternalReasoningFeature(feature))
  if (!hasThinkingSettings) return nonInternalFeatures
  return nonInternalFeatures.filter(feature => !isFirstClassThinkingFeature(feature))
}

function isFirstClassThinkingFeature(feature: NonNullable<ModelDef["features"]>[number]): boolean {
  const tokens = [
    normalizeFeatureToken(feature.id),
    normalizeFeatureToken(feature.label),
    normalizeFeatureToken(feature.providerParam),
  ]
  return tokens.some(token =>
    token === "thinkinglevel"
    || token === "thinkingeffort"
    || token === "reasoningeffort"
    || token === "reasoningeffortlevel"
  )
}

function isInternalReasoningFeature(feature: NonNullable<ModelDef["features"]>[number]): boolean {
  const tokens = [
    normalizeFeatureToken(feature.id),
    normalizeFeatureToken(feature.label),
    normalizeFeatureToken(feature.providerParam),
    normalizeFeatureToken(feature.category),
  ]
  return tokens.some(token =>
    token === "thinking"
    || token === "reasoning"
    || token === "thoughtsummaries"
    || token === "thinkingsummaries"
    || token === "includethoughts"
    || token.includes("thinkingconfig")
    || token.includes("thought")
  )
}

function normalizeFeatureToken(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

function featureDefaultValue(feature: NonNullable<import("@/lib/config").ModelDef["features"]>[number]): ModelFeatureValue | undefined {
  if (feature.type === "boolean") return feature.defaultValue ?? false
  if (feature.type === "enum") return feature.defaultValue ?? feature.options[0]?.value
  // Never leave a control blank when the model author didn't supply a default —
  // an empty number/string input reads as a broken "black" feature. Fall back
  // to the declared minimum / 0 for numbers and an empty string for text.
  if (feature.type === "number") return feature.defaultValue ?? feature.min ?? 0
  return feature.defaultValue ?? ""
}

// ---------- Subcomponents ----------

function SegmentedThinking({
  value,
  available,
  onChange,
}: {
  value: ThinkingLevel
  available: ThinkingLevel[]
  onChange: (level: ThinkingLevel) => void
}) {
  const displayLevels = orderThinkingLevels(available)
  const compact = displayLevels.length > 4

  return (
    <div
      role="radiogroup"
      aria-label="Thinking level"
      className={cn(
        "w-full items-center gap-0.5 rounded-lg bg-muted/60 p-0.5",
        compact
          ? "grid h-9"
          : "flex min-h-9 flex-wrap"
      )}
      style={compact ? { gridTemplateColumns: `repeat(${displayLevels.length}, minmax(0, 1fr))` } : undefined}
    >
      {displayLevels.map(level => {
        const active = level === value
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(level)}
            title={formatThinkingLabel(level)}
            className={cn(
              "inline-flex h-8 items-center justify-center rounded-md font-medium outline-none transition-all",
              "focus-visible:ring-2 focus-visible:ring-ring/50",
              compact ? "min-w-0 px-1 text-[11.5px]" : "min-w-16 flex-1 px-2.5 text-[12.5px]",
              active && "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-border/60",
              !active && "text-foreground/55 hover:text-foreground/85"
            )}
          >
            <span className="min-w-0 truncate">{formatThinkingLabel(level)}</span>
          </button>
        )
      })}
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-[12px] font-medium uppercase tracking-wider text-foreground/55">
          {label}
        </label>
        {hint && <span className="text-[12px] tabular-nums text-foreground/45">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function SaveBadge({ status }: { status: SaveStatus }) {
  if (status.kind === "idle") return null

  if (status.kind === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-medium text-foreground/55">
        <span className="size-1.5 animate-pulse rounded-full bg-foreground/45" />
        Saving…
      </span>
    )
  }

  if (status.kind === "saved") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11.5px] font-medium text-emerald-700 dark:text-emerald-400 animate-in fade-in-0 duration-150">
        <CheckCircle2 className="size-3" />
        Saved
      </span>
    )
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-[11.5px] font-medium text-destructive"
      title={status.message}
    >
      <AlertCircle className="size-3" />
      Failed
    </span>
  )
}

// ---------- Helpers ----------

function formatModelHint(model: { contextWindow: number; pricing: ModelPricing | null; pricingNotes?: string; kinds?: string[] }): string {
  // Image/video/speech/music models don't have a meaningful context window — skip it.
  const isText = !model.kinds || model.kinds.includes("text")
  const ctxK = !isText
    ? null
    : model.contextWindow >= 1_000_000
      ? `${(model.contextWindow / 1_000_000).toFixed(model.contextWindow % 1_000_000 === 0 ? 0 : 1)}M`
      : model.contextWindow > 0
        ? `${Math.round(model.contextWindow / 1000)}K`
        : null

  const ctxPart = ctxK ? `${ctxK} ctx · ` : ""

  if (model.pricing === null) return `${ctxPart}pricing TBD`
  if (model.pricing.kind === "subscription") return `${ctxPart}subscription`
  if (model.pricing.kind === "unit") {
    const currency = model.pricing.currency ?? "$"
    if (typeof model.pricing.pricePerUnit === "number") return `${ctxPart}${currency}${formatPrice(model.pricing.pricePerUnit)}/${model.pricing.unit}`
    if (model.pricing.tiers?.length) return `${ctxPart}${model.pricing.tiers.length} pricing tiers`
    return `${ctxPart}${model.pricingNotes ?? "unit pricing"}`
  }

  const inP = formatPrice(model.pricing.inputPerMillion)
  const outP = formatPrice(model.pricing.outputPerMillion)
  const large = model.pricing.inputPerMillionLarge !== undefined || model.pricing.outputPerMillionLarge !== undefined || model.pricing.tiers?.length ? " · tiered" : ""
  return `${ctxPart}$${inP}/$${outP} per M${large}`
}

function formatPrice(n: number): string {
  return n < 1 ? n.toFixed(2).replace(/\.?0+$/, "") || "0" : n.toFixed(2).replace(/\.?0+$/, "")
}

function formatMissingFields(fields: string[] | undefined): string {
  if (!fields || fields.length === 0) return "unknown fields"
  const labels: Record<string, string> = {
    pricing: "pricing",
    contextWindow: "context size",
    maxOutputTokens: "max output",
    knowledgeCutoff: "knowledge cutoff",
    thinkingLevels: "thinking levels",
    defaultThinkingLevel: "default thinking",
  }
  return fields.map(field => labels[field] ?? field).join(", ")
}

function orderThinkingLevels(available: ThinkingLevel[]): ThinkingLevel[] {
  const seen = new Set<ThinkingLevel>()
  for (const level of available) seen.add(level)

  const ordered: ThinkingLevel[] = []
  for (const level of KNOWN_THINKING_LEVELS) {
    if (seen.delete(level)) ordered.push(level)
  }
  for (const level of seen) ordered.push(level)
  return ordered
}

function formatThinkingLabel(level: ThinkingLevel): string {
  return THINKING_LABELS[level] ?? formatStableIdLabel(level)
}

function formatStableIdLabel(id: string): string {
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase())
}
