import type {
  ToolDef,
  ToolExecutionContext,
  ToolResult,
} from "@/lib/ai/agents/types"
import { isOrchestratorClassAgent } from "@/lib/ai/agents/orchestrator-class"
import { getToolExecutor } from "./executors/registry"
import { ORCHESTRATOR_ONLY_TOOL_IDS } from "./executors/orchestrator-only"

const TOOL_ABORT_ERROR = "Tool execution aborted by stop request."

function toolAbortResult(): ToolResult {
  return { success: false, error: TOOL_ABORT_ERROR }
}

function normalizeToolError(err: unknown): ToolResult {
  return {
    success: false,
    error: err instanceof Error ? err.message : "Unknown error executing tool",
  }
}

async function runWithAbort(
  execution: Promise<ToolResult>,
  signal: AbortSignal
): Promise<ToolResult> {
  if (signal.aborted) return toolAbortResult()

  let cleanup: (() => void) | undefined
  const aborted = new Promise<ToolResult>((resolve) => {
    const onAbort = () => resolve(toolAbortResult())
    signal.addEventListener("abort", onAbort, { once: true })
    cleanup = () => signal.removeEventListener("abort", onAbort)
  })

  try {
    return await Promise.race([execution, aborted])
  } finally {
    cleanup?.()
  }
}

/**
 * Execute a tool. Always returns a ToolResult — never throws — so the
 * provider's tool-call loop can route errors back to the model uniformly.
 *
 * `ctx` is required when invoking delegation-aware tools; for the others
 * (read_file, list_dir) it's harmless to pass or omit.
 */
export async function executeTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx?: ToolExecutionContext
): Promise<ToolResult> {
  if (
    !isOrchestratorClassAgent(ctx?.callerAgentId) &&
    ORCHESTRATOR_ONLY_TOOL_IDS.has(tool.id)
  ) {
    return {
      success: false,
      error: `${tool.id} is orchestrator-only. Other agents must return structured data for the orchestrator to render.`,
    }
  }

  const executor = getToolExecutor(tool.id)
  if (!executor) {
    return {
      success: false,
      error: `No executor registered for tool: ${tool.id}`,
    }
  }

  if (ctx?.signal?.aborted) return toolAbortResult()

  const execution = Promise.resolve()
    .then(() => executor(args, ctx))
    .catch(normalizeToolError)

  return ctx?.signal ? runWithAbort(execution, ctx.signal) : execution
}
