import { automationToolExecutors } from "./automation"
import { communicationToolExecutors } from "./communication"
import { coreToolExecutors } from "./core"
import { googleWorkspaceToolExecutors } from "./google-workspace"
import { homeAssistantToolExecutors } from "./home-assistant"
import { createRunActivatedIntegrationToolExecutor } from "./run-activated"
import { ALL_TOOL_DEFS } from "../tool-catalog"
import type { ToolExecutor } from "./types"

const toolDefs = new Map(ALL_TOOL_DEFS.map((tool) => [tool.id, tool]))

export const toolExecutors: Record<string, ToolExecutor> = {
  ...coreToolExecutors,
  ...communicationToolExecutors,
  ...googleWorkspaceToolExecutors,
  ...homeAssistantToolExecutors,
  ...automationToolExecutors,
}

toolExecutors.RunActivatedIntegrationTool =
  createRunActivatedIntegrationToolExecutor(
    (toolId) => toolExecutors[toolId],
    (toolId) => toolDefs.get(toolId)
  )

export function getToolExecutor(toolId: string): ToolExecutor | undefined {
  return toolExecutors[toolId]
}
