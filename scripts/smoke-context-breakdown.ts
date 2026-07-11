import assert from "node:assert/strict"

import type { ToolDef } from "@/lib/ai/agents/types"
import { estimateAttachmentTokens } from "@/lib/ai/context-token-estimate"
import {
  buildContextUsageBreakdown,
  reconcileContextUsageBreakdown,
} from "@/lib/ai/context-usage-breakdown"

const tool = (id: string, description: string): ToolDef => ({
  id,
  name: id,
  description,
  tags: ["read"],
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
    },
  },
})

const activeTool = tool("ActiveTool", "An active tool with a real schema.")
const deferredTool = tool("DeferredTool", "A larger deferred tool schema.")
const prompt = [
  "Always follow the system policy.",
  "<skills_index>\n- pdf: PDF workflow\n</skills_index>",
  "<runtime_tools>\n- ActiveTool: active\n</runtime_tools>",
  "<runtime_agents>\n- worker: generalist\n</runtime_agents>",
  "<workspace_context_files>\n--- BEGIN USER.md (user) ---\nPrefers concise answers.\n--- END USER.md ---\n</workspace_context_files>",
].join("\n\n")

const breakdown = buildContextUsageBreakdown({
  systemPrompt: prompt,
  messages: [
    { role: "user", content: "Please continue." },
    {
      role: "assistant",
      content: "<recalled_memory>Older useful note.</recalled_memory>\nWorking on it.",
    },
  ],
  tools: [activeTool],
  exposedTools: [activeTool],
  declaredTools: [activeTool, deferredTool],
  builtins: ["web_search"],
  availableAgentCount: 1,
  attachments: [{ mimeType: "image/png", size: 50_000, type: "image" }],
})

const byId = new Map(breakdown.categories.map((entry) => [entry.id, entry]))
for (const id of ["messages", "skills", "tools", "system", "memory", "agents", "attachments"] as const) {
  assert.ok((byId.get(id)?.tokens ?? 0) > 0, `${id} should consume context`)
}
assert.equal(byId.get("memory")?.count, 2, "workspace file + recalled block are counted")
assert.equal(byId.get("tools")?.count, 2, "custom tool + native builtin are counted")
assert.equal(byId.get("attachments")?.tokens, 1200)
assert.equal(
  breakdown.estimatedTokens,
  breakdown.categories.reduce((total, entry) => total + entry.tokens, 0)
)
const deferred = breakdown.deferred?.find((entry) => entry.id === "tools")
assert.equal(deferred?.count, 1)
assert.ok((deferred?.tokens ?? 0) > 0)

const reconciled = reconcileContextUsageBreakdown(breakdown, 20_000, 250)
assert.equal(reconciled.accuracy, "reconciled")
assert.equal(reconciled.reconciledTokens, 20_000)
assert.equal(
  reconciled.categories.reduce((total, entry) => total + entry.tokens, 0),
  20_000,
  "visible categories must reconcile exactly to provider occupancy"
)
assert.ok(
  (reconciled.categories.find((entry) => entry.id === "provider")?.tokens ?? 0) > 0,
  "unobservable provider state should be explicit"
)

const compacted = reconcileContextUsageBreakdown(breakdown, 100, 0)
assert.equal(
  compacted.categories.reduce((total, entry) => total + entry.tokens, 0),
  100,
  "provider compaction should scale categories down to the new occupancy"
)
assert.equal(estimateAttachmentTokens({ mimeType: "audio/mpeg", size: 1_000_000 }), 0)
assert.equal(estimateAttachmentTokens({ mimeType: "image/jpeg", size: 1_000_000 }), 1200)

console.log("context usage breakdown smoke passed")
