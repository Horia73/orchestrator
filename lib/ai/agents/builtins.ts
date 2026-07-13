import type { ProviderBuiltin } from './types'

export const WORKSPACE_TOOL_IDS: string[] = [
    'Read',
    'Write',
    'Edit',
    'Bash',
    'remote_sudo',
    // Tracked background jobs: survive the end of the turn and wake the
    // conversation on completion. Critical for CLI-backed runtimes whose
    // native Bash background tasks die when the headless turn ends.
    'start_background_job',
    'manage_background_jobs',
    'Glob',
    'Grep',
    'WebFetch',
    'ListEnvVars',
    'SetEnv',
    'TodoWrite',
    'ReportAgentNeed',
    'ResolveAgentNeed',
]

export const LEGACY_WORKSPACE_TOOL_IDS: string[] = [
    'list_dir',
    'read_file',
]

export const DELEGATE_TOOL_IDS: string[] = [
    'delegate_to',
    'delegate_parallel',
]

// Always-on control tool. Operational integration tool schemas are loaded on
// demand via this tool (see lib/integrations/exposure.ts); it must stay
// exposed for every agent that holds any integration tools.
export const INTEGRATION_CONTROL_TOOL_IDS: string[] = [
    'ActivateIntegrationTools',
    'RunActivatedIntegrationTool',
]

export const GMAIL_TOOL_IDS: string[] = [
    'GmailSearch',
    'GmailReadThread',
    'GmailCreateDraft',
    'GmailSendDraft',
    'GmailSendEmail',
    'GmailModifyLabels',
    'GmailArchive',
    'GmailMarkRead',
    'GmailMarkUnread',
    'GmailTrash',
    'GmailUntrash',
    'GmailDeletePermanently',
    'GmailUnsubscribeInfo',
    'GmailUnsubscribe',
    'GmailListLabels',
    'GmailCreateLabel',
    'GmailDownloadAttachment',
]

export const GOOGLE_CALENDAR_TOOL_IDS: string[] = [
    'GoogleCalendarStatus',
    'GoogleCalendarConfigure',
    'GoogleCalendarStartOAuth',
    'GoogleCalendarListCalendars',
    'GoogleCalendarListEvents',
    'GoogleCalendarGetEvent',
    'GoogleCalendarSearchEvents',
    'GoogleCalendarFreeBusy',
    'GoogleCalendarFindAvailability',
    'GoogleCalendarCreateEvent',
    'GoogleCalendarUpdateEvent',
    'GoogleCalendarDeleteEvent',
    'GoogleCalendarRespondToEvent',
    'GoogleCalendarMoveEvent',
]

export const GOOGLE_DRIVE_TOOL_IDS: string[] = [
    'GoogleDriveStatus',
    'GoogleDriveConfigure',
    'GoogleDriveStartOAuth',
    'GoogleDriveAbout',
    'GoogleDriveListSharedDrives',
    'GoogleDriveListFiles',
    'GoogleDriveGetFile',
    'GoogleDriveReadFile',
    'GoogleDriveDownloadFile',
    'GoogleDriveExportFile',
    'GoogleDriveUploadFile',
    'GoogleDriveUpdateFileContent',
    'GoogleDriveCreateFolder',
    'GoogleDriveCreateGoogleFile',
    'GoogleDriveUpdateMetadata',
    'GoogleDriveMoveFile',
    'GoogleDriveCopyFile',
    'GoogleDriveTrashFile',
    'GoogleDriveUntrashFile',
    'GoogleDriveDeleteFile',
    'GoogleDriveListPermissions',
    'GoogleDriveShareFile',
    'GoogleDriveUpdatePermission',
    'GoogleDriveDeletePermission',
]

export const GOOGLE_DOCS_TOOL_IDS: string[] = [
    'GoogleDocsCreateDocument',
    'GoogleDocsGetDocument',
    'GoogleDocsInsertText',
    'GoogleDocsReplaceAllText',
    'GoogleDocsApplyTextStyle',
    'GoogleDocsApplyParagraphStyle',
    'GoogleDocsInsertTable',
    'GoogleDocsBatchUpdate',
]

export const GOOGLE_CONTACTS_TOOL_IDS: string[] = [
    'GoogleContactsListConnections',
    'GoogleContactsSearchContacts',
    'GoogleContactsGetPerson',
    'GoogleContactsBatchGetPeople',
    'GoogleContactsCreateContact',
    'GoogleContactsBatchCreateContacts',
    'GoogleContactsUpdateContact',
    'GoogleContactsBatchUpdateContacts',
    'GoogleContactsDeleteContact',
    'GoogleContactsBatchDeleteContacts',
    'GoogleContactsListContactGroups',
    'GoogleContactsGetContactGroup',
    'GoogleContactsCreateContactGroup',
    'GoogleContactsUpdateContactGroup',
    'GoogleContactsDeleteContactGroup',
    'GoogleContactsModifyContactGroupMembers',
    'GoogleContactsListOtherContacts',
    'GoogleContactsSearchOtherContacts',
    'GoogleContactsCopyOtherContactToMyContacts',
]

export const GOOGLE_SHEETS_TOOL_IDS: string[] = [
    'GoogleSheetsCreateSpreadsheet',
    'GoogleSheetsGetSpreadsheet',
    'GoogleSheetsGetValues',
    'GoogleSheetsBatchGetValues',
    'GoogleSheetsUpdateValues',
    'GoogleSheetsAppendValues',
    'GoogleSheetsClearValues',
    'GoogleSheetsBatchUpdate',
]

export const GOOGLE_SLIDES_TOOL_IDS: string[] = [
    'GoogleSlidesCreatePresentation',
    'GoogleSlidesGetPresentation',
    'GoogleSlidesGetPage',
    'GoogleSlidesGetThumbnail',
    'GoogleSlidesCreateSlide',
    'GoogleSlidesInsertTextBox',
    'GoogleSlidesReplaceAllText',
    'GoogleSlidesBatchUpdate',
]

export const WHATSAPP_TOOL_IDS: string[] = [
    'WhatsAppStatus',
    'WhatsAppConnect',
    'WhatsAppListChats',
    'WhatsAppUnreadSummary',
    'WhatsAppReadChat',
    'WhatsAppSearchMessages',
    'WhatsAppFindMessages',
    'WhatsAppDownloadMedia',
    'WhatsAppSendMessage',
    'WhatsAppSendMedia',
    'WhatsAppDeleteMessageForEveryone',
]

export const HOME_ASSISTANT_TOOL_IDS: string[] = [
    'HomeAssistantStatus',
    'HomeAssistantConfigure',
    'HomeAssistantApiInfo',
    'HomeAssistantGetConfig',
    'HomeAssistantListStates',
    'HomeAssistantGetState',
    'HomeAssistantSearchEntities',
    'HomeAssistantListServices',
    'HomeAssistantListEvents',
    'HomeAssistantHistory',
    'HomeAssistantLogbook',
    'HomeAssistantErrorLog',
    'HomeAssistantListCalendars',
    'HomeAssistantReadCalendar',
    'HomeAssistantCameraSnapshot',
    'HomeAssistantRenderTemplate',
    'HomeAssistantCheckConfig',
    'HomeAssistantWebSocketRead',
    'HomeAssistantListRegistries',
    'HomeAssistantListAutomations',
    'HomeAssistantListScripts',
    'HomeAssistantListScenes',
    'HomeAssistantAutomationActivity',
    'HomeAssistantReadAutomationConfig',
    'HomeAssistantListAutomationConfigs',
    'HomeAssistantPreviewAction',
    'HomeAssistantCallService',
    'HomeAssistantSetLight',
    'HomeAssistantSetCover',
    'HomeAssistantSetClimate',
    'HomeAssistantNotify',
    'HomeAssistantReadActionAudit',
]

export const REMOTE_MCP_TOOL_IDS: string[] = [
    'RemoteMcpStatus',
    'RemoteMcpConfigure',
    'RemoteMcpStartOAuth',
    'RemoteMcpDisconnect',
    'RemoteMcpRemove',
    'RemoteMcpListTools',
    'RemoteMcpCallTool',
]

// Structured user questions. Orchestrator-only by design: the orchestrator is
// the user-facing agent, so it is the one that pauses to ask a decision
// question with tappable options (`ask_user`). Delegated agents surface a
// blocker to the orchestrator instead (see <sub_agent_collaboration>).
export const QUESTION_TOOL_IDS: string[] = [
    'ask_user',
]

export const SCHEDULING_TOOL_IDS: string[] = [
    'schedule_task',
    'list_tasks',
    'cancel_task',
    'reschedule_task',
    'notify_inbox',
    'set_task_state',
]

// In-app self-update. The prompt's <pending_update> runtime block shows for
// the orchestrator class (orchestrator + the inbox/smart-monitor aliases, see
// orchestrator-class.ts), which all inherit this tool via the orchestrator
// grant. Other sub-agents inherit neither the block nor a reason to apply it.
export const UPDATE_TOOL_IDS: string[] = [
    'apply_update',
]

export const REMOTE_ACCESS_TOOL_IDS: string[] = [
    'remote_access_status',
    'remote_access_enable_webhook_funnel',
    'remote_access_disable_webhook_funnel',
    'remote_access_install_tailscale',
    'remote_access_setup_https',
]

export const OBSERVABILITY_TOOL_IDS: string[] = [
    'search_past_runs',
    'get_past_run',
    'search_agent_logs',
    'get_agent_log',
    'read_runtime_index',
]

// Deliberate semantic lookup over the user's long-term memory (durable files,
// full daily-memory history, and prior conversation messages). Complements the
// automatic per-turn <recalled_memory> hint injected by the chat route.
// memory_recent_activity is the chronological companion to memory_search: the
// nightly Memory reflection prompt tells the agent to call it (~14d) to spot
// repeated workflows for playbook synthesis, so it MUST be granted here — being
// registered in the tool catalog is not enough to surface it to a run.
export const MEMORY_TOOL_IDS: string[] = [
    'memory_search',
    'memory_recent_activity',
    'library_search',
]

// Uploaded-file handling. find_past_uploads is the cross-conversation lookup
// for files the user uploaded in the past (the per-message attachment context
// only surfaces the CURRENT message's files). copy_upload_to_workspace stages
// an upload's bytes inside the agent workspace — uploads live outside the
// sandbox, so any edit/convert/extract work must happen on a workspace copy.
// Held by orchestrator + worker + researcher so a sub-agent handed an
// attachment can stage and process it without delegating back.
export const UPLOADS_TOOL_IDS: string[] = [
    'find_past_uploads',
    'copy_upload_to_workspace',
]

// On-demand audio transcription. Always-on (no connection/OAuth — just needs a
// Google API key, which the tool self-checks with a graceful error). Transcript
// mode uses the separate Audio Transcript Agent so report/summary instructions
// from the pre-pass cannot bleed into verbatim output. Held by orchestrator +
// worker + researcher so a sub-agent that runs into audio can transcribe without
// delegating back.
export const TRANSCRIPTION_TOOL_IDS: string[] = [
    'TranscribeAudio',
]

// Self-service backup. Always-on single tool that creates the same portable
// archive the user can download from Settings → Updates → Danger zone and saves
// it into the Library so the agent can deliver it on request. Restore and
// factory reset stay user-only (no tool); the app_guide doctrine explains them.
// Orchestrator-only at execution (executor.ts) — a backup is a credential dump.
export const BACKUP_TOOL_IDS: string[] = [
    'create_backup',
]

// App & host guide subsystem tools — gated behind ActivateIntegrationTools
// ('app_guide'). host_status is a live machine snapshot (disk/mem/uptime); the
// doctrine that activates alongside it documents the app's UI + data management.
export const APP_GUIDE_TOOL_IDS: string[] = [
    'host_status',
]

export const SKILL_TOOL_IDS: string[] = [
    'SkillSearch',
    'ActivateSkill',
    'ReadSkillFile',
]

export const PROFILE_ADMIN_TOOL_IDS: string[] = [
    'ProfileAdminListAccess',
    'ProfileAdminGrantHomeAssistantAccess',
    'ProfileAdminRevokeHomeAssistantAccess',
    'ProfileAdminSetHomeAssistantDefault',
]

export const WATCHLIST_TOOL_IDS: string[] = [
    'WatchlistAddFinancialInstrument',
    'WatchlistAddProduct',
    'WatchlistRemoveItem',
    'WatchlistListItems',
    'WatchlistRecordProductPrice',
]

export const WORKOUT_HISTORY_TOOL_IDS: string[] = [
    'GetExerciseHistory',
    'ListExerciseHistory',
    'GetRecentWorkouts',
]

// Internal apps — reusable mini-apps (html/react artifacts + per-app data
// store). Registry CRUD, data read/write, and the launch-card emitter.
export const APPS_TOOL_IDS: string[] = [
    'AppsList',
    'AppGet',
    'AppSave',
    'AppDelete',
    'AppDataGet',
    'AppDataSet',
    'AppShow',
]

// Smart Monitor — watch CRUD + capability discovery + the learning-loop
// feedback channel called at the end of every consolidated wake.
//
// The monitor_watch_* lifecycle tools are for the user-conversation context
// (set up, adjust, inspect), not for scheduled wakes. Wakes still get
// notify_inbox/monitor_wake_feedback and per-source connector tools through
// run-scoped capability warmup.
export const MONITORING_TOOL_IDS: string[] = [
    'monitor_describe_sources',
    'monitor_watch_list',
    'monitor_watch_get',
    'monitor_watch_add',
    'monitor_watch_update',
    'monitor_watch_remove',
    'monitor_wake_feedback',
]

export const MICROSCRIPT_TOOL_IDS: string[] = [
    'webhook_describe_capabilities',
    'webhook_list',
    'webhook_create',
    'webhook_update',
    'webhook_delete',
    'webhook_subscription_create',
    'microscript_describe_capabilities',
    'microscript_create',
    'microscript_list',
    'microscript_get',
    'microscript_update',
    'microscript_pause',
    'microscript_resume',
    'microscript_delete',
    'microscript_run_now',
    'microscript_get_run',
]

// Map artifact authoring — orchestrator-only by design. Other agents that
// want a map shown delegate back through the orchestrator. The tool
// validates a MapArtifact payload and returns the canonical JSON body the
// orchestrator drops inside an <artifact type="application/vnd.ant.map">.
export const MAPS_TOOL_IDS: string[] = [
    'MapsStatus',
    'MapsCurrentLocation',
    'MapsListLocationSources',
    'MapsSetLocationSource',
    'MapsGeocode',
    'MapsReverseGeocode',
    'MapsPlaces',
    'MapsOptimizeStops',
    'MapsDirections',
    'MapRender',
]

// Weather artifact authoring — orchestrator-only by design. Other agents
// that want a weather card delegate back. `WeatherShow` is end-to-end
// (geocode + fetch + transform + validate), so it sits on the orchestrator
// with the rest of the composition tools.
export const WEATHER_TOOL_IDS: string[] = [
    'WeatherStatus',
    'WeatherShow',
    'WeatherSetOutfit',
    'WeatherSetWhy',
    'WeatherSetCalendarContext',
]

export const DELEGATING_WORKSPACE_TOOLS: string[] = [
    ...LEGACY_WORKSPACE_TOOL_IDS,
    ...WORKSPACE_TOOL_IDS,
    ...DELEGATE_TOOL_IDS,
]

export const CLI_WORKSPACE_BUILTINS: ProviderBuiltin[] = [
    'read',
    'write',
    'edit',
    'bash',
    'glob',
    'grep',
    'web_fetch',
    'web_search',
    'todo_write',
]
