import {
  executeProfileAdminGrantHomeAssistantAccess,
  executeProfileAdminListAccess,
  executeProfileAdminRevokeHomeAssistantAccess,
  executeProfileAdminSetHomeAssistantDefault,
} from "../profile-admin"
import type { ToolExecutor } from "./types"

export const profileAdminToolExecutors: Record<string, ToolExecutor> = {
  ProfileAdminListAccess: executeProfileAdminListAccess,
  ProfileAdminGrantHomeAssistantAccess:
    executeProfileAdminGrantHomeAssistantAccess,
  ProfileAdminRevokeHomeAssistantAccess:
    executeProfileAdminRevokeHomeAssistantAccess,
  ProfileAdminSetHomeAssistantDefault:
    executeProfileAdminSetHomeAssistantDefault,
}
