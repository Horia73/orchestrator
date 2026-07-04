import type { ContextUsageSnapshot, Message } from "@/lib/types"
import { ALL_CAPABILITY_IDS } from "@/lib/integrations/exposure"
import { normalizeUsage } from "@/lib/observability/usage-mapper"

export {
  appendPromptContext,
  buildAttachmentContext,
  canProviderReadLocalUploads,
} from "@/lib/ai/attachment-context"

/** Format a path for display: relative to cwd when inside, basename for deep absolutes. */
function displayPath(p: string): string {
  if (!p) return ""
  const cwd = process.cwd()
  if (p === cwd) return "."
  if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1)
  return p
}

/** Build a human-readable title for a tool call from its name and args. */
export function buildToolTitle(
  toolName: string,
  args: Record<string, unknown> | undefined
): string {
  const rawPath =
    typeof args?.path === "string"
      ? args.path
      : typeof args?.file_path === "string"
        ? args.file_path
        : ""
  const shown = displayPath(rawPath)
  if (toolName === "read_file") return shown ? `Read ${shown}` : "Read file"
  if (toolName === "Read") return shown ? `Read ${shown}` : "Read file"
  if (toolName === "list_dir") return shown ? `List ${shown}` : "List directory"
  if (toolName === "Write") return shown ? `Write ${shown}` : "Write file"
  if (toolName === "Edit") return shown ? `Edit ${shown}` : "Edit file"
  if (toolName === "Bash" || toolName === "shell")
    return typeof args?.command === "string"
      ? `Run ${args.command.slice(0, 80)}`
      : "Run command"
  if (toolName === "Glob")
    return typeof args?.pattern === "string" ? `Glob ${args.pattern}` : "Glob"
  if (toolName === "Grep")
    return typeof args?.pattern === "string" ? `Grep ${args.pattern}` : "Grep"
  if (toolName === "WebFetch")
    return typeof args?.url === "string" ? `Fetch ${args.url}` : "Fetch URL"
  if (toolName === "ListEnvVars")
    return typeof args?.query === "string" && args.query.trim()
      ? `List env names matching ${args.query.trim()}`
      : "List env names"
  if (toolName === "SetEnv")
    return typeof args?.key === "string" ? `Set env ${args.key}` : "Set env"
  if (toolName === "web_search" || toolName === "WebSearch") {
    const queries = Array.isArray(args?.queries)
      ? args.queries.filter((q) => typeof q === "string")
      : []
    if (queries.length > 0) return `Search ${queries.join(", ").slice(0, 90)}`
    return typeof args?.query === "string"
      ? `Search ${args.query}`
      : "Search web"
  }
  if (toolName === "TodoWrite") return "Update todos"
  if (toolName === "delegate_to") {
    const agentId = typeof args?.agent_id === "string" ? args.agent_id : "agent"
    return `Delegate to ${agentId}`
  }
  if (toolName === "delegate_parallel") {
    const count = Array.isArray(args?.jobs) ? args.jobs.length : 0
    return count > 0
      ? `Delegate ${count} jobs in parallel`
      : "Delegate in parallel"
  }
  if (toolName === "RunActivatedIntegrationTool") {
    return typeof args?.tool_id === "string"
      ? `Run ${args.tool_id}`
      : "Run integration tool"
  }
  return toolName
}

export function dedupeTools<T extends { id: string }>(tools: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const tool of tools) {
    if (seen.has(tool.id)) continue
    seen.add(tool.id)
    out.push(tool)
  }
  return out
}

export function buildFinalContextUsageSnapshot(args: {
  provider: string
  model: string
  rawUsage: unknown
  contextWindow?: number | null
  requestId: string
  interactionId?: string | null
}): ContextUsageSnapshot | null {
  const usage = normalizeUsage(args.provider, args.rawUsage)
  if (
    usage.inputTokens === null &&
    usage.outputTokens === null &&
    usage.thinkingTokens === null &&
    usage.cachedTokens === null &&
    usage.totalTokens === null
  ) {
    return null
  }
  const visibleOutputTokens =
    args.provider === "openai" &&
    usage.outputTokens !== null &&
    usage.thinkingTokens !== null
      ? Math.max(0, usage.outputTokens - usage.thinkingTokens)
      : usage.outputTokens
  return {
    provider: args.provider,
    model: args.model,
    source: "provider-final",
    accuracy: "actual",
    updatedAt: Date.now(),
    requestId: args.requestId,
    interactionId: args.interactionId ?? undefined,
    contextWindow: args.contextWindow ?? null,
    contextTokens: sumNumbers(usage.inputTokens, visibleOutputTokens),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    thinkingTokens: usage.thinkingTokens,
    cachedTokens: usage.cachedTokens,
    totalTokens: usage.totalTokens,
  }
}

export function mergeContextUsage(
  previous: ContextUsageSnapshot | null,
  next: ContextUsageSnapshot
): ContextUsageSnapshot {
  const sameSource = Boolean(
    previous &&
      previous.provider === next.provider &&
      previous.model === next.model
  )
  return {
    ...(sameSource ? (previous ?? {}) : {}),
    ...next,
    last: next.last ?? (sameSource ? previous?.last : null) ?? null,
    total: next.total ?? (sameSource ? previous?.total : null) ?? null,
    threadTokens:
      next.threadTokens ?? (sameSource ? previous?.threadTokens : null) ?? null,
    lastCompactedAt:
      next.lastCompactedAt ??
      (sameSource ? previous?.lastCompactedAt : null) ??
      null,
    compactedCount:
      next.compactedCount ??
      (sameSource ? previous?.compactedCount : undefined),
  }
}

export function contextUsageKey(snapshot: ContextUsageSnapshot): string {
  return JSON.stringify({
    provider: snapshot.provider,
    model: snapshot.model,
    source: snapshot.source,
    requestId: snapshot.requestId ?? null,
    interactionId: snapshot.interactionId ?? null,
    threadId: snapshot.threadId ?? null,
    turnId: snapshot.turnId ?? null,
    contextWindow: snapshot.contextWindow ?? null,
    contextTokens: snapshot.contextTokens ?? null,
    inputTokens: snapshot.inputTokens ?? null,
    outputTokens: snapshot.outputTokens ?? null,
    thinkingTokens: snapshot.thinkingTokens ?? null,
    cachedTokens: snapshot.cachedTokens ?? null,
    totalTokens: snapshot.totalTokens ?? null,
    threadTokens: snapshot.threadTokens ?? null,
    lastCompactedAt: snapshot.lastCompactedAt ?? null,
    compactedCount: snapshot.compactedCount ?? null,
  })
}

function sumNumbers(
  ...values: Array<number | null | undefined>
): number | null {
  let total = 0
  let seen = false
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      continue
    total += value
    seen = true
  }
  return seen ? total : null
}

export function sanitizePromptContext(value: unknown): string {
  if (typeof value !== "string") return ""
  return value.trim().slice(0, 16_000)
}

export function sanitizePromptContextSource(value: unknown): string {
  if (typeof value !== "string") return "App surface UI"
  const clean = value.trim().replace(/[<>]/g, "").replace(/\s+/g, " ")
  return clean ? clean.slice(0, 80) : "App surface UI"
}

export function sanitizeCapabilityActivations(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const allowed = new Set(ALL_CAPABILITY_IDS)
  return Array.from(
    new Set(
      value.filter(
        (item): item is string => typeof item === "string" && allowed.has(item)
      )
    )
  )
}

export function sanitizePreferredFallbackIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null
  return value >= 1 && value <= 2 ? value : null
}

export function mergeMessagesForProvider(
  dbMessages: Message[],
  requestMessages: Message[]
): Message[] {
  const byId = new Map<string, Message>()
  for (const message of dbMessages) byId.set(message.id, message)
  for (const message of requestMessages) byId.set(message.id, message)
  return Array.from(byId.values()).sort((a, b) => {
    const timeDelta = a.timestamp - b.timestamp
    return timeDelta !== 0 ? timeDelta : a.id.localeCompare(b.id)
  })
}
