import { executeListDir } from "../list-dir"
import { executeReadFile } from "../read-file"
import { executeFindPastUploads } from "../find-past-uploads"
import { executeCreateBackup } from "../create-backup"
import { executeHostStatus } from "../host-status"
import { executeDelegateParallel, executeDelegateTo } from "../delegate-to"
import { executeRead } from "../read"
import { executeWrite } from "../write"
import { executeEdit } from "../edit"
import { executeGlob } from "../glob"
import { executeGrep } from "../grep"
import { executeWebFetch } from "../web"
import { executeTodoWrite } from "../todo-write"
import { executeReportAgentNeed } from "../agent-needs"
import { executeSetEnv } from "../set-env"
import { executeActivateIntegrationTools } from "../integrations"
import type { ToolExecutor } from "./types"

const executeBashLazy: ToolExecutor = async (args, ctx) => {
  const { executeBash } = await import("../bash")
  return executeBash(args, ctx)
}

export const coreToolExecutors: Record<string, ToolExecutor> = {
  list_dir: executeListDir,
  read_file: executeReadFile,
  find_past_uploads: executeFindPastUploads,
  create_backup: executeCreateBackup,
  host_status: executeHostStatus,
  delegate_to: executeDelegateTo,
  delegate_parallel: executeDelegateParallel,
  Read: executeRead,
  Write: executeWrite,
  Edit: executeEdit,
  Bash: executeBashLazy,
  Glob: executeGlob,
  Grep: executeGrep,
  WebFetch: executeWebFetch,
  TodoWrite: executeTodoWrite,
  ReportAgentNeed: executeReportAgentNeed,
  SetEnv: executeSetEnv,
  ActivateIntegrationTools: executeActivateIntegrationTools,
}
