import type { ToolDef, ToolResult } from "@/lib/ai/agents/types"
import { searchLibrary } from "@/lib/memory/library"
import { isActiveModelMultimodal } from "@/lib/memory/embeddings"

// Cross-modal semantic search over the user's Library — finds IMAGES (PNG/JPEG)
// and PDFs by MEANING from a text query, not just filename. This is the
// content/visual search that find_past_uploads (keyword-only) points to.
// Requires a multimodal embedding model (Gemini Embedding 2); with a text-only
// model it returns a clear note instead of guessing.
export const librarySearchTool: ToolDef = {
  id: "library_search",
  name: "library_search",
  description: [
    "Find images (PNG/JPEG) and PDFs in the user's Library by MEANING — semantic, cross-modal search, not filename matching.",
    "Use it when the user refers to a visual/document by content: \"the whiteboard photo\", \"the diagram of the architecture\", \"that invoice PDF\", \"a picture with a red car\".",
    "For finding a file by NAME or recency, prefer find_past_uploads. For meaning/content, use this.",
    "Returns matches ranked by relevance, each with a local `path` you can open with Read, a relevance score, and the source conversation/message when the file came from a chat upload. Requires a multimodal embedding model; returns a note if one is not configured.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to find, described by content/meaning (e.g. 'whiteboard from the planning meeting', 'invoice with the blue logo').",
      },
      limit: {
        type: "integer",
        description: "Max results (default 8, max 25).",
      },
    },
    required: ["query"],
  },
  tags: ["read", "memory", "library"],
}

function clampLimit(raw: unknown): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return 8
  return Math.min(25, Math.max(1, n))
}

export async function executeLibrarySearch(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : ""
  if (!query) {
    return { success: false, error: "library_search requires a non-empty `query`." }
  }
  if (!isActiveModelMultimodal()) {
    return {
      success: true,
      data: {
        results: [],
        note: "Library semantic search needs a multimodal embedding model. Set Gemini Embedding 2 in Settings → Memory. (OpenAI embeddings are text-only.)",
      },
    }
  }
  try {
    const hits = await searchLibrary(query, clampLimit(args.limit))
    if (hits.length === 0) {
      return { success: true, data: { results: [], note: "No matching Library files found." } }
    }
    return {
      success: true,
      data: {
        results: hits.map((h) => ({
          path: h.path,
          name: h.displayPath,
          kind: h.kind,
          relevance: Number(h.score.toFixed(3)),
          conversation: h.conversationTitle,
          conversation_id: h.conversationId,
          message_id: h.messageId,
          uploaded_at:
            typeof h.messageTimestamp === "number"
              ? new Date(h.messageTimestamp).toISOString()
              : undefined,
        })),
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "library_search failed.",
    }
  }
}
