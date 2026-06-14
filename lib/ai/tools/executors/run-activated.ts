import type { ToolExecutionContext, ToolResult } from "@/lib/ai/agents/types"
import { activateIntegrations } from "@/lib/integrations/activation-store"
import {
  getIntegrationManifest,
  operationalIntegrationFor,
} from "@/lib/integrations/manifest"
import { subsystemForGatedTool } from "@/lib/integrations/subsystem-manifest"
import {
  getIntegrationStatusSnapshot,
  refreshIntegrationStatusSnapshot,
} from "@/lib/integrations/status-snapshot"
import type { ToolDef } from "@/lib/ai/agents/types"
import { compactToolSchema } from "./tool-schema-compact"
import {
  isReadOnlyWakeToolAllowed,
  readOnlyWakeToolError,
} from "@/lib/ai/tools/read-only-policy"
import type { ToolExecutor } from "./types"
import { deniedToolReason } from "@/lib/profiles/permissions"

export function createRunActivatedIntegrationToolExecutor(
  resolveExecutor: (toolId: string) => ToolExecutor | undefined,
  resolveTool?: (toolId: string) => ToolDef | undefined
): ToolExecutor {
  return async function executeRunActivatedIntegrationTool(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext
  ): Promise<ToolResult> {
    const conversationId = ctx?.conversationId
    if (!conversationId) {
      return {
        success: false,
        error:
          "No conversation context — cannot run activated integration tools.",
      }
    }

    const toolId =
      typeof args.tool_id === "string"
        ? args.tool_id.trim()
        : typeof args.toolId === "string"
          ? args.toolId.trim()
          : ""
    if (!toolId) return { success: false, error: "Missing tool_id." }

    const targetArgs = args.arguments
    if (
      !targetArgs ||
      typeof targetArgs !== "object" ||
      Array.isArray(targetArgs)
    ) {
      return { success: false, error: "arguments must be an object." }
    }

    // Resolve the capability this gated tool belongs to — an integration
    // (maps/weather/gmail/…) or a native subsystem (monitoring/scheduling/
    // watchlist/microscripts). Gated subsystem tools must be reachable through
    // this fallback because CLI-backed providers freeze their tool list.
    const integrationId = operationalIntegrationFor(toolId)
    const subsystemId = integrationId
      ? undefined
      : subsystemForGatedTool(toolId)
    if (!integrationId && !subsystemId) {
      return {
        success: false,
        error: `${toolId} is not a gated capability tool — it is always available, so call it directly instead of via RunActivatedIntegrationTool.`,
      }
    }
    const capabilityId = (integrationId ?? subsystemId)!
    const toolDef = resolveTool?.(toolId)
    if (toolDef) {
      const denied = deniedToolReason(toolDef)
      if (denied) return { success: false, error: denied }
    }
    if (ctx?.toolSurfaceMode === "read-only") {
      if (!toolDef) {
        return {
          success: false,
          error: `${toolId} is not available in this read-only wake because its tool definition could not be resolved.`,
        }
      }
      if (!isReadOnlyWakeToolAllowed(toolDef)) {
        return { success: false, error: readOnlyWakeToolError(toolDef) }
      }
    }

    // Connection-bearing integrations must actually be connected. activationOnly
    // integrations (maps, weather — keyless/local) and native subsystems have no
    // connection handshake; missing config surfaces as a per-call tool error.
    const entry = integrationId
      ? getIntegrationManifest(integrationId)
      : undefined
    if (integrationId && !entry) {
      return {
        success: false,
        error: `Unknown integration for tool: ${toolId}`,
      }
    }
    if (entry && !entry.activationOnly) {
      let state = getIntegrationStatusSnapshot(ctx.appOrigin)[entry.statusKind]
        ?.state
      if (state !== "connected") {
        state = (await refreshIntegrationStatusSnapshot(ctx.appOrigin))[
          entry.statusKind
        ]?.state
      }
      if (state !== "connected") {
        return {
          success: false,
          error: `${entry.label} is not connected; current state is ${state ?? "unknown"}. Connect it first via its setup runbook.`,
        }
      }
    }

    // Auto-activate the capability for this conversation. RunActivatedIntegrationTool
    // is the explicit "run this gated tool now" request, so a separate prior
    // ActivateIntegrationTools call must never be a precondition.
    activateIntegrations(conversationId, [capabilityId])

    const executor = resolveExecutor(toolId)
    if (
      !executor ||
      toolId === "RunActivatedIntegrationTool" ||
      toolId === "ActivateIntegrationTools"
    ) {
      return {
        success: false,
        error: `No operational executor registered for tool: ${toolId}`,
      }
    }

    const result = await executor(targetArgs as Record<string, unknown>, ctx)
    if (!result.success && result.error && toolDef) {
      return {
        ...result,
        error: `${result.error}\nExpected ${toolId} arguments schema: ${compactToolSchema(toolDef)}`,
      }
    }
    return result
  }
}
