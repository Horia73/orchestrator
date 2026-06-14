import type { ToolDef } from "@/lib/ai/agents/types"

/**
 * Compact JSON rendering of a gated tool's call contract — its description plus
 * the authoritative `input_schema`. Used both on the RunActivatedIntegrationTool
 * failure path (echo the schema after a bad call) and, more importantly, in the
 * ActivateIntegrationTools result so the model receives the real schema in the
 * SAME turn it activates a capability — doctrines only load from the next turn
 * onward, which is too late for activate-then-call-in-one-turn flows (the common
 * case on CLI-backed providers that freeze the live tool list at launch).
 */
export function compactToolSchema(tool: ToolDef, max = 4000): string {
  const payload = {
    description: tool.description,
    input_schema: tool.input_schema,
  }
  const text = JSON.stringify(payload)
  return text.length > max ? `${text.slice(0, max)}...` : text
}
