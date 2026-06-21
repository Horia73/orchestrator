import { automationToolExecutors } from "./automation"
import { communicationToolExecutors } from "./communication"
import { coreToolExecutors } from "./core"
import { googleWorkspaceToolExecutors } from "./google-workspace"
import { homeAssistantToolExecutors } from "./home-assistant"
import { remoteMcpToolExecutors } from "./mcp"
import { profileAdminToolExecutors } from "./profile-admin"
import { createRunActivatedIntegrationToolExecutor } from "./run-activated"
import { createActivateIntegrationToolsExecutor } from "../integrations"
import { ALL_TOOL_DEFS } from "../tool-catalog"
import type { ToolExecutor } from "./types"

const toolDefs = new Map(ALL_TOOL_DEFS.map((tool) => [tool.id, tool]))

export const toolExecutors: Record<string, ToolExecutor> = {
  ...coreToolExecutors,
  ...communicationToolExecutors,
  ...googleWorkspaceToolExecutors,
  ...homeAssistantToolExecutors,
  ...remoteMcpToolExecutors,
  ...automationToolExecutors,
  ...profileAdminToolExecutors,
}

toolExecutors.RunActivatedIntegrationTool =
  createRunActivatedIntegrationToolExecutor(
    (toolId) => toolExecutors[toolId],
    (toolId) => toolDefs.get(toolId)
  )

// Wire the live tool catalog into activation so the result message carries each
// gated tool's real input_schema in the same turn it is activated (see
// lib/ai/tools/integrations.ts). The bare executor from coreToolExecutors had no
// resolver; this overrides it with one.
toolExecutors.ActivateIntegrationTools = createActivateIntegrationToolsExecutor(
  (toolId) => toolDefs.get(toolId)
)

export function getToolExecutor(toolId: string): ToolExecutor | undefined {
  return toolExecutors[toolId]
}
