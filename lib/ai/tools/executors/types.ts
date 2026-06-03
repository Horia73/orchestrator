import type { ToolExecutionContext, ToolResult } from "@/lib/ai/agents/types"

/**
 * Executor signature: tools may be sync or async, and may consult an
 * execution context (delegation, signals, depth tracking).
 */
export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx?: ToolExecutionContext
) => ToolResult | Promise<ToolResult>
