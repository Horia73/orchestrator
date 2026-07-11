import fs from "node:fs"

import type { ProviderBuiltin, ToolDef } from "@/lib/ai/agents/types"
import {
  estimateAttachmentTokens,
  estimateCharCountTokens,
  estimateTextTokens,
} from "@/lib/ai/context-token-estimate"
import { listSkills } from "@/lib/skills/registry"
import type {
  ContextUsageBreakdown,
  ContextUsageBreakdownEntry,
  ContextUsageCategoryId,
} from "@/lib/types"

interface BreakdownMessage {
  role: string
  content: string
}

interface BreakdownAttachment {
  mimeType?: string
  size?: number
  type?: string
}

const DEFAULT_DEFERRED_SKILL_MAX_CHARS = 60_000

export interface BuildContextUsageBreakdownInput {
  systemPrompt: string
  messages: BreakdownMessage[]
  tools: ToolDef[]
  exposedTools?: ToolDef[]
  declaredTools?: ToolDef[]
  builtins?: ProviderBuiltin[]
  availableAgentCount?: number
  attachments?: BreakdownAttachment[]
}

const LABELS: Record<ContextUsageCategoryId, string> = {
  messages: "Messages",
  skills: "Skills",
  tools: "Tools",
  system: "System prompt",
  memory: "Memory files",
  agents: "Agents",
  attachments: "Attachments",
  provider: "Provider & tool state",
}

export function buildContextUsageBreakdown(
  input: BuildContextUsageBreakdownInput
): ContextUsageBreakdown {
  const skills = safeListSkills()
  const promptParts = splitPrompt(input.systemPrompt)
  const messageParts = splitMessages(input.messages)
  const attachmentTokens = (input.attachments ?? []).reduce(
    (total, attachment) => total + estimateAttachmentTokens(attachment),
    0
  )
  const activeToolTokens = estimateTextTokens(serializeToolSchemas(input.tools))
  const activeToolIds = new Set(
    [...(input.exposedTools ?? input.tools), ...input.tools].map((tool) => tool.id)
  )
  const deferredTools = uniqueTools(input.declaredTools ?? []).filter(
    (tool) => !activeToolIds.has(tool.id)
  )
  const deferredToolTokens = estimateTextTokens(serializeToolSchemas(deferredTools))
  const deferredSkillTokens = skills.reduce((total, skill) => {
    try {
      return total + estimateCharCountTokens(
        Math.min(fs.statSync(skill.skillFile).size, DEFAULT_DEFERRED_SKILL_MAX_CHARS)
      )
    } catch {
      return total
    }
  }, 0)

  const categories = compactEntries([
    entry("messages", messageParts.messageTokens, input.messages.length),
    entry("skills", promptParts.skillTokens, Math.min(skills.length, 40)),
    entry(
      "tools",
      promptParts.toolTokens + activeToolTokens,
      uniqueTools(input.tools).length + new Set(input.builtins ?? []).size
    ),
    entry("system", promptParts.systemTokens),
    entry(
      "memory",
      promptParts.memoryTokens + messageParts.memoryTokens,
      promptParts.memoryFileCount + messageParts.memoryBlockCount
    ),
    entry("agents", promptParts.agentTokens, input.availableAgentCount),
    entry(
      "attachments",
      attachmentTokens + messageParts.attachmentTokens,
      input.attachments?.length ?? 0
    ),
  ])
  const deferred = compactEntries([
    entry("tools", deferredToolTokens, deferredTools.length),
    entry("skills", deferredSkillTokens, skills.length),
  ])

  return {
    categories,
    deferred,
    estimatedTokens: sumEntries(categories),
    accuracy: "estimated",
  }
}

export function reconcileContextUsageBreakdown(
  breakdown: ContextUsageBreakdown,
  occupiedTokens: number | null | undefined,
  outputTokens: number | null | undefined
): ContextUsageBreakdown {
  if (!finiteNonNegative(occupiedTokens)) return breakdown

  const categories = breakdown.categories.map((entry) => ({ ...entry }))
  if (finiteNonNegative(outputTokens) && outputTokens > 0) {
    addTokens(categories, "messages", outputTokens)
  }

  const measured = Math.round(occupiedTokens)
  const current = sumEntries(categories)
  if (current < measured) {
    addTokens(categories, "provider", measured - current)
  } else if (current > measured && current > 0) {
    const scaled = scaleEntries(categories, measured / current)
    categories.splice(0, categories.length, ...scaled)
  }

  return {
    ...breakdown,
    categories: compactEntries(categories),
    reconciledTokens: measured,
    accuracy: "reconciled",
  }
}

function splitPrompt(prompt: string): {
  skillTokens: number
  toolTokens: number
  memoryTokens: number
  memoryFileCount: number
  agentTokens: number
  systemTokens: number
} {
  let remaining = prompt
  const skills = consumeTag(remaining, "skills_index")
  remaining = skills.remaining
  const tools = consumeTag(remaining, "runtime_tools")
  remaining = tools.remaining
  const agents = consumeTag(remaining, "runtime_agents")
  remaining = agents.remaining
  const memory = consumeTag(remaining, "workspace_context_files")
  remaining = memory.remaining

  return {
    skillTokens: estimateTextTokens(skills.content),
    toolTokens: estimateTextTokens(tools.content),
    memoryTokens: estimateTextTokens(memory.content),
    memoryFileCount: (memory.content.match(/^--- BEGIN /gm) ?? []).length,
    agentTokens: estimateTextTokens(agents.content),
    systemTokens: estimateTextTokens(remaining),
  }
}

function splitMessages(messages: BreakdownMessage[]): {
  messageTokens: number
  memoryTokens: number
  memoryBlockCount: number
  attachmentTokens: number
} {
  let messageTokens = 0
  let memoryTokens = 0
  let memoryBlockCount = 0
  let attachmentTokens = 0

  for (const message of messages) {
    let remaining = `${message.role}\n${message.content}`
    const memory = consumeTag(remaining, "recalled_memory")
    remaining = memory.remaining
    if (memory.content) {
      memoryTokens += estimateTextTokens(memory.content)
      memoryBlockCount += memory.count
    }
    const similarFiles = consumeTag(remaining, "similar_files")
    remaining = similarFiles.remaining
    attachmentTokens += estimateTextTokens(similarFiles.content)
    messageTokens += estimateTextTokens(remaining)
  }

  return { messageTokens, memoryTokens, memoryBlockCount, attachmentTokens }
}

function consumeTag(
  value: string,
  tag: string
): { content: string; remaining: string; count: number } {
  const expression = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "g")
  const matches = value.match(expression) ?? []
  return {
    content: matches.join("\n\n"),
    remaining: value.replace(expression, ""),
    count: matches.length,
  }
}

function serializeToolSchemas(tools: ToolDef[]): string {
  if (tools.length === 0) return ""
  return JSON.stringify(
    uniqueTools(tools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }))
  )
}

function uniqueTools(tools: ToolDef[]): ToolDef[] {
  const seen = new Set<string>()
  return tools.filter((tool) => {
    if (seen.has(tool.id)) return false
    seen.add(tool.id)
    return true
  })
}

function safeListSkills(): ReturnType<typeof listSkills> {
  try {
    return listSkills()
  } catch {
    return []
  }
}

function entry(
  id: ContextUsageCategoryId,
  tokens: number,
  count?: number
): ContextUsageBreakdownEntry {
  return {
    id,
    label: LABELS[id],
    tokens: Math.max(0, Math.round(tokens)),
    ...(typeof count === "number" && count > 0 ? { count } : {}),
  }
}

function compactEntries(
  entries: ContextUsageBreakdownEntry[]
): ContextUsageBreakdownEntry[] {
  return entries.filter((item) => item.tokens > 0 || (item.count ?? 0) > 0)
}

function sumEntries(entries: ContextUsageBreakdownEntry[]): number {
  return entries.reduce((total, item) => total + item.tokens, 0)
}

function addTokens(
  entries: ContextUsageBreakdownEntry[],
  id: ContextUsageCategoryId,
  tokens: number
): void {
  const existing = entries.find((entry) => entry.id === id)
  if (existing) {
    existing.tokens += Math.round(tokens)
    return
  }
  entries.push(entry(id, tokens))
}

function scaleEntries(
  entries: ContextUsageBreakdownEntry[],
  scale: number
): ContextUsageBreakdownEntry[] {
  const scaled = entries.map((item) => ({
    ...item,
    tokens: Math.max(0, Math.floor(item.tokens * scale)),
  }))
  let remainder = Math.max(0, Math.round(sumEntries(entries) * scale) - sumEntries(scaled))
  const ranked = [...scaled].sort((a, b) => b.tokens - a.tokens)
  for (const item of ranked) {
    if (remainder <= 0) break
    item.tokens += 1
    remainder -= 1
  }
  return scaled
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}
