import type {
  AgentInfo,
  SettingsBootstrap,
} from "@/components/settings/use-settings"
import type { CurrentModelResearchStatus } from "@/components/settings/research-progress-panel"
import type { ProviderDef } from "@/lib/config"
import type { UsageReport } from "@/lib/observability/schema"

type ProviderStatusMap = SettingsBootstrap["providerStatus"]

const CONTEXT_THINKING_LABELS: Record<string, string> = {
  none: "Off",
  minimal: "Off",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
}

export function orderAgentsByConfig(
  agents: AgentInfo[],
  agentOrder: string[]
): AgentInfo[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const seen = new Set<string>()
  const ordered: AgentInfo[] = []

  for (const id of agentOrder) {
    const agent = byId.get(id)
    if (!agent || seen.has(id)) continue
    seen.add(id)
    ordered.push(agent)
  }

  for (const agent of agents) {
    if (seen.has(agent.id)) continue
    ordered.push(agent)
  }

  return ordered
}

export function moveIdAround(
  ids: string[],
  draggedId: string,
  targetId: string,
  afterTarget: boolean
): string[] {
  if (draggedId === targetId) return ids
  const draggedIndex = ids.indexOf(draggedId)
  const targetIndex = ids.indexOf(targetId)
  if (draggedIndex < 0 || targetIndex < 0) return ids

  const next = ids.filter((id) => id !== draggedId)
  const targetAfterRemoval = next.indexOf(targetId)
  if (targetAfterRemoval < 0) return ids
  const insertIndex = afterTarget ? targetAfterRemoval + 1 : targetAfterRemoval
  next.splice(insertIndex, 0, draggedId)

  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== next[i]) return next
  }
  return ids
}

export function moveIdToEnd(ids: string[], draggedId: string): string[] {
  const draggedIndex = ids.indexOf(draggedId)
  if (draggedIndex < 0 || draggedIndex === ids.length - 1) return ids

  const next = ids.filter((id) => id !== draggedId)
  next.push(draggedId)
  return next
}

export function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function formatAgentSidebarSummary(
  agent: AgentInfo,
  data: SettingsBootstrap
): string {
  if (agent.id === "browser_agent") {
    const light = formatProviderModel(
      data,
      data.config.browserAgent.light.provider,
      data.config.browserAgent.light.model
    ).model
    if (!data.config.browserAgent.proEnabled) {
      return light
    }
    const pro = formatProviderModel(
      data,
      data.config.browserAgent.pro.provider,
      data.config.browserAgent.pro.model
    ).model
    return light === pro ? light : `${light} / ${pro}`
  }

  const override = data.config.agentOverrides[agent.id]
  const providerId =
    override?.provider ?? agent.defaultProvider ?? data.config.activeProvider
  const modelId =
    override?.model ?? agent.defaultModel ?? data.config.activeModel
  const { provider, model } = formatProviderModel(data, providerId, modelId)
  return `${provider} · ${model}`
}

export function formatProviderModel(
  data: SettingsBootstrap,
  providerId: string,
  modelId: string
): { provider: string; model: string } {
  const providerDef = data.providers[providerId]
  return {
    provider: providerDef?.name ?? providerId,
    model: providerDef?.models[modelId]?.name ?? modelId,
  }
}

export function buildAgentActivity(
  agent: AgentInfo,
  usageReport: UsageReport | null
): Array<{ label: string; value: string; tone?: "default" | "danger" }> | null {
  const usage = usageReport?.byAgent.find((item) => item.agentId === agent.id)
  if (!usage || usage.requests === 0) return null

  return [
    { label: "Runs", value: formatCompactNumber(usage.requests) },
    {
      label: "Errors",
      value: formatCompactNumber(usage.errors),
      tone: usage.errors > 0 ? "danger" : "default",
    },
    {
      label: "Tokens",
      value: formatCompactNumber(
        usage.inputTokens + usage.outputTokens + usage.thinkingTokens
      ),
    },
    { label: "Cost", value: formatUsd(usage.estimatedCostUsd) },
  ]
}

export function buildAgentContextDetails(
  agent: AgentInfo,
  data: SettingsBootstrap
): Array<{ label: string; value: string }> {
  const status = agent.status === "planned" ? "Planned" : "Active"

  if (agent.id === "browser_agent") {
    const light = formatProviderModel(
      data,
      data.config.browserAgent.light.provider,
      data.config.browserAgent.light.model
    )
    const pro = formatProviderModel(
      data,
      data.config.browserAgent.pro.provider,
      data.config.browserAgent.pro.model
    )
    const proEnabled = data.config.browserAgent.proEnabled
    return [
      { label: "Status", value: status },
      { label: "Kind", value: agent.kind },
      {
        label: "Mode",
        value: proEnabled ? "Multi (light + pro)" : "Single (light only)",
      },
      { label: "Light", value: `${light.provider} · ${light.model}` },
      ...(proEnabled
        ? [{ label: "Pro", value: `${pro.provider} · ${pro.model}` }]
        : []),
    ]
  }

  const override = data.config.agentOverrides[agent.id]
  const providerId =
    override?.provider ?? agent.defaultProvider ?? data.config.activeProvider
  const modelId =
    override?.model ?? agent.defaultModel ?? data.config.activeModel
  const thinking =
    override?.thinkingLevel ??
    agent.defaultThinkingLevel ??
    data.config.thinkingLevel
  const source = override
    ? "Override"
    : agent.defaultProvider || agent.defaultModel
      ? "Agent default"
      : "Global default"
  const model = formatProviderModel(data, providerId, modelId)

  return [
    { label: "Status", value: status },
    { label: "Kind", value: agent.kind },
    { label: "Provider", value: model.provider },
    { label: "Model", value: model.model },
    { label: "Thinking", value: formatContextThinking(thinking) },
    { label: "Source", value: source },
  ]
}

export function formatContextThinking(value: string): string {
  return CONTEXT_THINKING_LABELS[value] ?? value
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(Math.round(value))
}

export function formatUsd(value: number): string {
  if (value <= 0) return "$0"
  if (value < 0.01) return "<$0.01"
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 2 : 0,
  }).format(value)
}

export function agentHasProviderWarning(
  agent: AgentInfo,
  data: SettingsBootstrap
): boolean {
  if (agent.id === "browser_agent") {
    return [
      data.config.browserAgent.light.provider,
      ...(data.config.browserAgent.proEnabled
        ? [data.config.browserAgent.pro.provider]
        : []),
    ].some(
      (providerId) => !(data.providerStatus[providerId]?.available ?? false)
    )
  }

  const override = data.config.agentOverrides[agent.id]
  const providerId =
    override?.provider ?? agent.defaultProvider ?? data.config.activeProvider
  return !(data.providerStatus[providerId]?.available ?? false)
}

export function hasUsableModelProvider(data: SettingsBootstrap): boolean {
  return Object.entries(data.providerStatus).some(
    ([providerId, status]) => providerId !== "browser" && status.available
  )
}

export function getResearcherProviderId(data: SettingsBootstrap): string {
  return (
    data.config.agentOverrides?.researcher?.provider ??
    data.agents.find((agent) => agent.id === "researcher")?.defaultProvider ??
    data.config.activeProvider
  )
}

export function isResearcherProviderReady(data: SettingsBootstrap): boolean {
  return data.providerStatus[getResearcherProviderId(data)]?.available ?? false
}

export function getResearchUnavailableReason(
  data: SettingsBootstrap
): string | null {
  if (!hasUsableModelProvider(data)) {
    return "No usable model provider is connected. Add an API key or log in to a CLI provider first."
  }
  const providerId = getResearcherProviderId(data)
  const status = data.providerStatus[providerId]
  if (!status?.available) {
    return (
      status?.chatMessage ??
      status?.unavailableReason ??
      `Researcher provider ${providerId} is not ready.`
    )
  }
  return null
}

export function isProviderUsable(
  providerId: string,
  providerStatus: ProviderStatusMap
): boolean {
  return (
    providerId !== "browser" && (providerStatus[providerId]?.available ?? false)
  )
}

export function countResearchableModels(
  providers: Record<string, ProviderDef>,
  providerStatus: ProviderStatusMap
): number {
  let count = 0
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isProviderUsable(providerId, providerStatus)) continue
    for (const model of Object.values(provider.models)) {
      if (!model.archived && model.dataCompleteness === "incomplete") count += 1
    }
  }
  return count
}

export function formatResearchButtonLabel(
  count: number,
  available: boolean
): string {
  if (!available) return "Research unavailable"
  return `Research model details (${count})`
}

export function buildModelResearchStatuses(
  providers: Record<string, ProviderDef>,
  providerStatus: ProviderStatusMap
): CurrentModelResearchStatus[] {
  const rows: CurrentModelResearchStatus[] = []
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isProviderUsable(providerId, providerStatus)) continue
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (model.archived) continue
      const missing = model.missingFields ?? []
      // Mirror registry completeness: pure media models have no context window.
      const isPureMedia =
        model.kinds.length > 0 && model.kinds.every((k) => k !== "text")
      const needsContext =
        !isPureMedia &&
        (model.kinds.includes("text") || model.capabilities.includes("text"))
      const hasThinkingMetadata = model.thinkingLevels !== undefined
      const thinking = model.thinkingLevels?.length
        ? model.thinkingLevels.join(", ")
        : hasThinkingMetadata
          ? "Not adjustable"
          : "Missing"
      rows.push({
        key: `${providerId}:${modelId}`,
        providerId,
        modelId,
        name: model.name,
        status: missing.length > 0 ? "incomplete" : "complete",
        missing,
        lastResearchedAt: model.curatedResearchedAt,
        fields: [
          {
            label: "Pricing",
            value: formatPricingStatus(model.pricing, model.pricingNotes),
            tone: model.pricing === null ? "missing" : "ok",
          },
          {
            label: "Max input",
            value:
              model.contextWindow > 0
                ? formatTokenCount(model.contextWindow)
                : needsContext
                  ? "Missing"
                  : "Not tracked",
            tone:
              model.contextWindow > 0
                ? "ok"
                : needsContext
                  ? "missing"
                  : "muted",
          },
          {
            label: "Max output",
            value:
              model.maxOutputTokens > 0
                ? formatTokenCount(model.maxOutputTokens)
                : "Unknown",
            tone: model.maxOutputTokens > 0 ? "ok" : "muted",
          },
          {
            label: "Knowledge",
            value: model.knowledgeCutoff ?? "Unknown",
            tone: model.knowledgeCutoff ? "ok" : "muted",
          },
          {
            label: "Thinking",
            value: thinking,
            tone: hasThinkingMetadata
              ? model.thinkingLevels?.length
                ? "ok"
                : "muted"
              : "missing",
          },
          {
            label: "Features",
            value:
              model.features.length > 0
                ? model.features.map((feature) => feature.label).join(", ")
                : "None",
            tone: model.features.length > 0 ? "ok" : "muted",
          },
          {
            label: "Custom",
            value:
              model.customMetadata.length > 0
                ? model.customMetadata.map(formatCustomMetadata).join(", ")
                : "None",
            tone: model.customMetadata.length > 0 ? "ok" : "muted",
          },
          {
            label: "Kinds",
            value: model.kinds.length > 0 ? model.kinds.join(", ") : "Unknown",
            tone: model.kinds.length > 0 ? "ok" : "muted",
          },
          {
            label: "Capabilities",
            value:
              model.capabilities.length > 0
                ? model.capabilities.join(", ")
                : "Unknown",
            tone: model.capabilities.length > 0 ? "ok" : "muted",
          },
          {
            label: "Sources",
            value: model.researchSources?.length
              ? `${model.researchSources.length} official source${model.researchSources.length === 1 ? "" : "s"}`
              : "No research sources",
            tone: model.researchSources?.length ? "ok" : "muted",
          },
          {
            label: "Last research",
            value: model.curatedResearchedAt
              ? formatDateTime(model.curatedResearchedAt)
              : "Never",
            tone: model.curatedResearchedAt ? "ok" : "muted",
          },
        ],
      })
    }
  }
  return rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === "incomplete" ? -1 : 1
    return (
      a.providerId.localeCompare(b.providerId) || a.name.localeCompare(b.name)
    )
  })
}

export function formatPricingStatus(
  pricing: ProviderDef["models"][string]["pricing"],
  notes?: string
): string {
  if (pricing === null) return "Missing"
  if (pricing.kind === "subscription") {
    if (typeof pricing.equivalentInputPerMillion === "number" && typeof pricing.equivalentOutputPerMillion === "number") {
      return `Included (≈ $${formatPrice(pricing.equivalentInputPerMillion)}/$${formatPrice(pricing.equivalentOutputPerMillion)} per M)`
    }
    return "Subscription"
  }
  if (pricing.kind === "unit") {
    const currency = pricing.currency ?? "$"
    if (typeof pricing.pricePerUnit === "number")
      return `${currency}${formatPrice(pricing.pricePerUnit)}/${pricing.unit}`
    if (pricing.tiers?.length) return `${pricing.tiers.length} pricing tiers`
    return notes ?? pricing.notes ?? "Unit pricing"
  }
  const large =
    pricing.inputPerMillionLarge !== undefined ||
    pricing.outputPerMillionLarge !== undefined ||
    pricing.tiers?.length
      ? " · tiered"
      : ""
  return `$${formatPrice(pricing.inputPerMillion)}/$${formatPrice(pricing.outputPerMillion)} per M${large}`
}

export function formatCustomMetadata(
  item: ProviderDef["models"][string]["customMetadata"][number]
): string {
  const value =
    typeof item.value === "boolean"
      ? item.value
        ? "yes"
        : "no"
      : String(item.value)
  return `${item.label}: ${value}${item.unit ? ` ${item.unit}` : ""}`
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M tokens`
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K tokens`
  return `${tokens} tokens`
}

export function formatPrice(n: number): string {
  return n < 1
    ? n.toFixed(2).replace(/\.?0+$/, "") || "0"
    : n.toFixed(2).replace(/\.?0+$/, "")
}

export function formatDateTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms))
}
