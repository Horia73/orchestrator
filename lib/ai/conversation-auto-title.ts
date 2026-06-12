import { randomUUID } from "crypto"

import { runTextSubAgent } from "@/lib/ai/agents/runner"
import { conversationNamer } from "@/lib/ai/agents/conversation-namer"
import type { ToolExecutionContext } from "@/lib/ai/agents/types"
import { getConversation, setConversationTitle } from "@/lib/db"
import type { Conversation, Message } from "@/lib/types"
import { generateTitle } from "@/lib/utils-chat"

const NAME_TIMEOUT_MS = 15_000
const MAX_INPUT_CHARS = 4_000

export interface ConversationTitleSeed {
  userText?: string
  assistantText?: string
  attachmentNames?: string[]
}

export interface AttachmentOnlyAutoNameSeed {
  currentTitle: string
  userText: string
  assistantText: string
  attachmentNames: string[]
}

function clip(value: string, max: number): string {
  const trimmed = (value ?? "").trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

// Models occasionally wrap titles in quotes, prefix them with "Title:", or end
// with punctuation. Strip that decoration down to a bare phrase.
export function sanitizeGeneratedConversationTitle(raw: string): string {
  let title = (raw ?? "").replace(/\r?\n/g, " ").trim()
  title = title.replace(/^["'`*_]+/, "").replace(/["'`*_]+$/, "").trim()
  title = title.replace(/^(title|titlu)\s*[:\-–]\s*/i, "").trim()
  title = title.replace(/^["'`*_]+/, "").replace(/["'`*_]+$/, "").trim()
  title = title.replace(/\s+/g, " ").replace(/[\s.,;:!?]+$/, "").trim()
  return title.slice(0, 120)
}

function cleanAttachmentNames(names: string[] | undefined): string[] {
  return (names ?? [])
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 10)
}

export function buildConversationTitlePrompt(
  seed: ConversationTitleSeed
): string | null {
  const userText = clip(seed.userText ?? "", MAX_INPUT_CHARS)
  const assistantText = clip(seed.assistantText ?? "", MAX_INPUT_CHARS)
  const attachmentNames = cleanAttachmentNames(seed.attachmentNames)

  const sections: string[] = []
  if (userText) {
    sections.push(`First user message:\n${userText}`)
  }
  if (assistantText) {
    const label = userText
      ? "Assistant reply"
      : "Assistant reply (primary source for the title)"
    sections.push(`${label}:\n${assistantText}`)
  }
  if (attachmentNames.length) {
    const label =
      !userText && assistantText
        ? "Attached file names (context only; do not title the chat after these names)"
        : "Attached files"
    sections.push(`${label}: ${attachmentNames.join(", ")}`)
  }
  if (sections.length === 0) return null

  return [
    "Generate a title for this conversation.",
    "",
    sections.join("\n\n"),
    "",
    "Return ONLY the title.",
  ].join("\n")
}

export async function generateConversationTitleFromSeed(args: {
  conversationId: string
  seed: ConversationTitleSeed
}): Promise<string | null> {
  const prompt = buildConversationTitlePrompt(args.seed)
  if (!prompt) return null

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), NAME_TIMEOUT_MS)
  const parentCtx: ToolExecutionContext = {
    callerAgentId: "system",
    depth: 0,
    conversationId: args.conversationId,
    parentRequestId: `title_${randomUUID()}`,
    signal: abort.signal,
  }

  try {
    const result = await runTextSubAgent({
      target: conversationNamer,
      prompt,
      parentCtx,
    })
    if (!result?.success) {
      throw new Error(result?.error ?? "unknown error")
    }

    const data = result.data as { output?: unknown } | undefined
    const rawOutput =
      typeof data?.output === "string"
        ? data.output
        : typeof result.data === "string"
          ? result.data
          : ""
    return sanitizeGeneratedConversationTitle(rawOutput) || null
  } finally {
    clearTimeout(timer)
  }
}

function firstRoleMessage(messages: Message[], role: Message["role"]) {
  return messages.find((message) => message.role === role)
}

export function attachmentOnlyAutoNameSeed(
  conversation: Conversation,
  options: {
    assistantMessageId?: string
    assistantText?: string
  } = {}
): AttachmentOnlyAutoNameSeed | null {
  const firstUser = firstRoleMessage(conversation.messages, "user")
  if (!firstUser) return null
  if (firstUser.content.trim()) return null

  const attachments = firstUser.attachments ?? []
  if (attachments.length === 0) return null

  const firstAssistant = firstRoleMessage(conversation.messages, "assistant")
  if (!firstAssistant) return null
  if (
    options.assistantMessageId &&
    firstAssistant.id !== options.assistantMessageId
  ) {
    return null
  }
  if (firstAssistant.status && firstAssistant.status !== "ok") return null

  const assistantText = (
    options.assistantText?.trim() || firstAssistant.content.trim()
  ).trim()
  if (!assistantText) return null

  const seedTitle = generateTitle(firstUser.content, attachments)
  if (conversation.title !== seedTitle) return null

  const attachmentNames = attachments
    .map((attachment) => attachment.filename)
    .filter((name): name is string => Boolean(name && name.trim()))

  return {
    currentTitle: conversation.title,
    userText: firstUser.content,
    assistantText,
    attachmentNames,
  }
}

export async function maybeAutoNameAttachmentOnlyConversation(args: {
  conversationId: string
  assistantMessageId?: string
  assistantText?: string
}): Promise<string | null> {
  const conversation = getConversation(args.conversationId)
  if (!conversation) return null

  const seed = attachmentOnlyAutoNameSeed(conversation, {
    assistantMessageId: args.assistantMessageId,
    assistantText: args.assistantText,
  })
  if (!seed) return null

  const title = await generateConversationTitleFromSeed({
    conversationId: args.conversationId,
    seed,
  })
  if (!title || title === seed.currentTitle) return null

  const stored = setConversationTitle(
    args.conversationId,
    title,
    seed.currentTitle
  )
  return stored === title ? title : null
}
