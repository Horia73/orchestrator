import type { ProviderBuiltin, ToolDef } from "@/lib/ai/agents/types"
import { listDirTool } from "./list-dir"
import { readFileTool } from "./read-file"
import { delegateParallelTool, delegateToTool } from "./delegate-to"
import { readTool } from "./read"
import { writeTool } from "./write"
import { editTool } from "./edit"
import { bashTool } from "./bash-def"
import { globTool } from "./glob"
import { grepTool } from "./grep"
import { webFetchTool } from "./web"
import { todoWriteTool } from "./todo-write"
import { reportAgentNeedTool } from "./agent-needs"
import { setEnvTool } from "./set-env"
import {
  activateIntegrationToolsTool,
  runActivatedIntegrationTool,
} from "./integrations"
import { gmailTools } from "./gmail"
import { googleCalendarTools } from "./google-calendar"
import { googleContactsTools } from "./google-contacts"
import { googleDocsTools } from "./google-docs"
import { googleDriveTools } from "./google-drive"
import { googleSheetsTools } from "./google-sheets"
import { googleSlidesTools } from "./google-slides"
import { homeAssistantTools } from "./home-assistant"
import { whatsappTools } from "./whatsapp"
import { scheduleTools } from "./schedule"
import { observabilityTools } from "./observability"
import { notifyInboxTool } from "./notify"
import { inboxActionHistoryTool } from "./inbox-history"
import { setTaskStateTool } from "./task-state"
import { watchlistTools } from "./watchlist"
import { monitorWakeFeedbackTool } from "./smart-monitor-feedback"
import { smartMonitorManageTools } from "./smart-monitor-manage"
import { microscriptTools } from "./microscripts"
import {
  mapRenderTool,
  mapsCurrentLocationTool,
  mapsDirectionsTool,
  mapsGeocodeTool,
  mapsListLocationSourcesTool,
  mapsOptimizeStopsTool,
  mapsPlacesTool,
  mapsReverseGeocodeTool,
  mapsSetLocationSourceTool,
  mapsStatusTool,
} from "./maps"
import {
  weatherSetCalendarContextTool,
  weatherSetOutfitTool,
  weatherSetWhyTool,
  weatherShowTool,
  weatherStatusTool,
} from "./weather"
import {
  getExerciseHistoryTool,
  getRecentWorkoutsTool,
  listExerciseHistoryTool,
} from "./workout-history"
import { applyUpdateTool } from "./update-app"
import { memorySearchTool } from "./memory-search"
import { librarySearchTool } from "./library-search"
import { findPastUploadsTool } from "./find-past-uploads"
import { createBackupTool } from "./create-backup"
import { hostStatusTool } from "./host-status"

export const ALL_TOOL_DEFS: ToolDef[] = [
  listDirTool,
  readFileTool,
  delegateToTool,
  delegateParallelTool,
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
  webFetchTool,
  todoWriteTool,
  reportAgentNeedTool,
  setEnvTool,
  activateIntegrationToolsTool,
  runActivatedIntegrationTool,
  ...gmailTools,
  ...googleCalendarTools,
  ...googleDriveTools,
  ...googleContactsTools,
  ...googleDocsTools,
  ...googleSheetsTools,
  ...googleSlidesTools,
  ...whatsappTools,
  ...homeAssistantTools,
  ...scheduleTools,
  ...observabilityTools,
  notifyInboxTool,
  inboxActionHistoryTool,
  setTaskStateTool,
  ...watchlistTools,
  monitorWakeFeedbackTool,
  ...smartMonitorManageTools,
  ...microscriptTools,
  mapsStatusTool,
  mapsCurrentLocationTool,
  mapsListLocationSourcesTool,
  mapsSetLocationSourceTool,
  mapsGeocodeTool,
  mapsReverseGeocodeTool,
  mapsPlacesTool,
  mapsOptimizeStopsTool,
  mapsDirectionsTool,
  mapRenderTool,
  weatherStatusTool,
  weatherShowTool,
  weatherSetOutfitTool,
  weatherSetWhyTool,
  weatherSetCalendarContextTool,
  getExerciseHistoryTool,
  listExerciseHistoryTool,
  getRecentWorkoutsTool,
  applyUpdateTool,
  memorySearchTool,
  librarySearchTool,
  findPastUploadsTool,
  createBackupTool,
  hostStatusTool,
]

export const BUILTIN_TOOL_IDS: Partial<Record<ProviderBuiltin, string[]>> = {
  read: ["Read"],
  write: ["Write"],
  edit: ["Edit"],
  bash: ["Bash"],
  glob: ["Glob"],
  grep: ["Grep"],
  web_fetch: ["WebFetch"],
  url_context: ["WebFetch"],
  todo_write: ["TodoWrite"],
}

export const NATIVE_BUILTIN_DUPLICATE_TOOL_IDS: Partial<
  Record<ProviderBuiltin, string[]>
> = {
  read: ["list_dir", "read_file", "Read"],
  write: ["Write"],
  edit: ["Edit"],
  bash: ["Bash"],
  glob: ["Glob"],
  grep: ["Grep"],
  web_fetch: ["WebFetch"],
  url_context: ["WebFetch"],
  todo_write: ["TodoWrite"],
}
