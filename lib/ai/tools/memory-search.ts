import type { ToolDef, ToolResult } from "@/lib/ai/agents/types"
import { searchMemoryForTool } from "@/lib/memory/recall"

// Explicit semantic search over the user's long-term memory (durable files +
// the full daily-memory history). Complements the automatic per-turn recall:
// the silent pass only surfaces older memories not already in context, whereas
// this tool is the agent's deliberate "have we dealt with something like this
// before?" lookup across everything. Fail-open like the rest of recall.
export const memorySearchTool: ToolDef = {
  id: "memory_search",
  name: "memory_search",
  description: [
    "Search your own long-term memory by meaning (semantic similarity), across the durable memory files and the entire daily-memory history — including notes far older than the few days already in your context.",
    "Use it when the current request feels like it might have a precedent: a similar problem, decision, preference, person, or task you may have recorded weeks or months ago. The automatic <recalled_memory> hint already covers obvious matches; call this when you want to dig deliberately.",
    "Returns the most relevant memory snippets with their source file and a relevance score. Treat results as possibly-stale hints — verify before relying. Returns nothing when there is no good match.",
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

function clampLimit(raw: unknown): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return 8
  return Math.min(25, Math.max(1, n))
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
        results: hits.map((h) => ({
          source: h.source,
          title: h.title,
          text: h.text,
          relevance: Number(h.score.toFixed(3)),
        })),
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
