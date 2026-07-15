import { executeListDir } from "../list-dir"
import { executeReadFile } from "../read-file"
import { executeFindPastUploads } from "../find-past-uploads"
import { executeCopyUploadToWorkspace } from "../copy-upload"
import { executeTranscribeAudio } from "../transcribe-audio"
import { executeCreateBackup } from "../create-backup"
import { executeHostStatus } from "../host-status"
import { executeDelegateParallel, executeDelegateTo } from "../delegate-to"
import {
  executeCompleteOwnerAgentHelp,
  executeRequestOwnerAgentHelp,
} from "../owner-agent-help"
import { executeRead } from "../read"
import { executeWrite } from "../write"
import { executeEdit } from "../edit"
import { executeGlob } from "../glob"
import { executeGrep } from "../grep"
import { executeWebFetch } from "../web"
import { executeTodoWrite } from "../todo-write"
import { executeReportAgentNeed, executeResolveAgentNeed } from "../agent-needs"
import { executeSetEnv } from "../set-env"
import { executeListEnvVars } from "../env-vars"
import { executeActivateIntegrationTools } from "../integrations"
import {
  executeActivateSkill,
  executeReadSkillFile,
  executeSkillSearch,
} from "../skills"
import type { ToolExecutor } from "./types"

const executeBashLazy: ToolExecutor = async (args, ctx) => {
  const { executeBash } = await import("../bash")
  return executeBash(args, ctx)
}

const executeRemoteSudoLazy: ToolExecutor = async (args, ctx) => {
  const { executeRemoteSudo } = await import("../remote-sudo")
  return executeRemoteSudo(args, ctx)
}

const executeStartBackgroundJobLazy: ToolExecutor = async (args, ctx) => {
  const { executeStartBackgroundJob } = await import("../background-jobs-tools")
  return executeStartBackgroundJob(args, ctx)
}

const executeManageBackgroundJobsLazy: ToolExecutor = async (args, ctx) => {
  const { executeManageBackgroundJobs } = await import("../background-jobs-tools")
  return executeManageBackgroundJobs(args, ctx)
}

export const coreToolExecutors: Record<string, ToolExecutor> = {
  list_dir: executeListDir,
  read_file: executeReadFile,
  find_past_uploads: executeFindPastUploads,
  copy_upload_to_workspace: executeCopyUploadToWorkspace,
  TranscribeAudio: executeTranscribeAudio,
  create_backup: executeCreateBackup,
  host_status: executeHostStatus,
  delegate_to: executeDelegateTo,
  delegate_parallel: executeDelegateParallel,
  request_owner_agent_help: executeRequestOwnerAgentHelp,
  complete_owner_agent_help: executeCompleteOwnerAgentHelp,
  Read: executeRead,
  Write: executeWrite,
  Edit: executeEdit,
  Bash: executeBashLazy,
  remote_sudo: executeRemoteSudoLazy,
  start_background_job: executeStartBackgroundJobLazy,
  manage_background_jobs: executeManageBackgroundJobsLazy,
  Glob: executeGlob,
  Grep: executeGrep,
  WebFetch: executeWebFetch,
  TodoWrite: executeTodoWrite,
  ReportAgentNeed: executeReportAgentNeed,
  ResolveAgentNeed: executeResolveAgentNeed,
  ListEnvVars: executeListEnvVars,
  SetEnv: executeSetEnv,
  ActivateIntegrationTools: executeActivateIntegrationTools,
  SkillSearch: executeSkillSearch,
  ActivateSkill: executeActivateSkill,
  ReadSkillFile: executeReadSkillFile,
}
