import { automationToolExecutors } from "./automation"
import { communicationToolExecutors } from "./communication"
import { coreToolExecutors } from "./core"
import { googleWorkspaceToolExecutors } from "./google-workspace"
import { homeAssistantToolExecutors } from "./home-assistant"
import { createRunActivatedIntegrationToolExecutor } from "./run-activated"
import type { ToolExecutor } from "./types"

export const toolExecutors: Record<string, ToolExecutor> = {
  ...coreToolExecutors,
  ...communicationToolExecutors,
  ...googleWorkspaceToolExecutors,
  ...homeAssistantToolExecutors,
  ...automationToolExecutors,
}

toolExecutors.RunActivatedIntegrationTool =
  createRunActivatedIntegrationToolExecutor((toolId) => toolExecutors[toolId])

export function getToolExecutor(toolId: string): ToolExecutor | undefined {
  return toolExecutors[toolId]
}
