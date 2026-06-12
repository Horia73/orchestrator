import type { ToolDef, ToolResult } from "@/lib/ai/agents/types"
import {
  listRecentConversationActivity,
  searchMemoryForTool,
} from "@/lib/memory/recall"

// Explicit semantic search over the user's long-term memory (durable files,
// the full daily-memory history, and indexed conversation messages).
// Complements the automatic per-turn recall: the silent pass only surfaces older
// memories not already in context, whereas this tool is the agent's deliberate
// "have we dealt with something like this before?" lookup across everything.
// Fail-open like the rest of recall.
export const memorySearchTool: ToolDef = {
  id: "memory_search",
  name: "memory_search",
  description: [
    "Search your own long-term memory by meaning (semantic similarity), across durable memory files, daily-memory history, and prior conversation messages — including context far older than the few days already in your prompt.",
    "Use it when the current request feels like it might have a precedent: a similar problem, decision, preference, person, or task you may have recorded weeks or months ago. The automatic <recalled_memory> hint already covers obvious matches; call this when you want to dig deliberately.",
    "Returns the most relevant memory snippets with their source, relevance score, and conversation/message ids when the hit came from chat history. Treat results as possibly-stale hints — verify before relying. Returns nothing when there is no good match.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to look for, in natural language. Describe the situation/topic; you do not need exact keywords.",
      },
      limit: {
        type: "integer",
        description: "Max results to return (default 8, max 25).",
      },
    },
    required: ["query"],
  },
  tags: ["read", "memory"],
}

// Chronological "what was actually asked lately" — the complement of semantic
// search. Returns each recent conversation with the first user message of
// every exchange, so repetition is visible at a glance. Primary consumer is
// the nightly memory reflection's playbook synthesis; also useful for "what
// did I ask you last week?" questions.
export const memoryRecentActivityTool: ToolDef = {
  id: "memory_recent_activity",
  name: "memory_recent_activity",
  description: [
    "List recent conversation activity chronologically: every conversation in the window with the first user message of each exchange (what was asked, not how it was answered). No embeddings — this is enumeration, not similarity search.",
    "Use it to spot REPETITION that semantic search cannot surface without knowing what to query: the same multi-step request recurring across days (a playbook candidate), recurring topics, or simply \"what did the user ask me lately\".",
    "Returns conversations newest-first with title, last-activity time, exchange count, and the compacted user requests.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      days: {
        type: "integer",
        description: "How many days back to look (default 14, max 60).",
      },
      max_conversations: {
        type: "integer",
        description: "Max conversations to return, newest first (default 60, max 200).",
      },
    },
  },
  tags: ["read", "memory"],
}

export async function executeMemoryRecentActivity(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const daysRaw = Math.floor(Number(args.days))
  const days = Number.isFinite(daysRaw) ? Math.min(60, Math.max(1, daysRaw)) : 14
  const maxRaw = Math.floor(Number(args.max_conversations))
  const maxConversations = Number.isFinite(maxRaw)
    ? Math.min(200, Math.max(1, maxRaw))
    : 60

  try {
    const sinceMs = Date.now() - days * 86_400_000
    const activity = listRecentConversationActivity({ sinceMs, maxConversations })
    return {
      success: true,
      data: {
        days,
        since: new Date(sinceMs).toISOString(),
        conversation_count: activity.length,
        conversations: activity.map((c) => ({
          conversation_id: c.conversationId,
          title: c.title,
          last_at: new Date(c.lastTimestamp).toISOString(),
          exchange_count: c.exchangeCount,
          user_requests: c.userRequests,
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "memory_recent_activity failed.",
    }
  }
}

function clampLimit(raw: unknown): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return 8
  return Math.min(25, Math.max(1, n))
}

function conversationSourceParts(source: string): {
  conversation_id: string
  message_id: string
} | null {
  const match = /^conversation:([^:]+):(.+)$/.exec(source)
  if (!match) return null
  return { conversation_id: match[1], message_id: match[2] }
}

export async function executeMemorySearch(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : ""
  if (!query) {
    return { success: false, error: "memory_search requires a non-empty `query`." }
  }
  const limit = clampLimit(args.limit)

  try {
    const { hits, semanticUsed } = await searchMemoryForTool(query, limit)
    if (hits.length === 0) {
      return {
        success: true,
        data: {
          results: [],
          note: semanticUsed
            ? "No matching memories found."
            : "Semantic memory is unavailable (no embedding API key configured); keyword fallback found nothing.",
        },
      }
    }
    return {
      success: true,
      data: {
        results: hits.map((h) => {
          const conversation = conversationSourceParts(h.source)
          return {
            source: h.source,
            title: h.title,
            text: h.text,
            relevance: Number(h.score.toFixed(3)),
            ...(conversation ?? {}),
          }
        }),
        searchMode: semanticUsed ? "semantic" : "keyword-fallback",
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "memory_search failed.",
    }
  }
}
