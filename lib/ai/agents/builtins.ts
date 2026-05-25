import type { ProviderBuiltin } from './types'

export const WORKSPACE_TOOL_IDS: string[] = [
    'Read',
    'Write',
    'Edit',
    'Bash',
    'Glob',
    'Grep',
    'WebFetch',
    'SetEnv',
    'TodoWrite',
    'ReportAgentNeed',
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

export const SCHEDULING_TOOL_IDS: string[] = [
    'schedule_task',
    'list_tasks',
    'cancel_task',
    'reschedule_task',
    'notify_inbox',
    'set_task_state',
]

export const OBSERVABILITY_TOOL_IDS: string[] = [
    'search_past_runs',
    'get_past_run',
    'search_agent_logs',
    'get_agent_log',
    'read_runtime_index',
]

export const WATCHLIST_TOOL_IDS: string[] = [
    'WatchlistAddFinancialInstrument',
    'WatchlistAddProduct',
    'WatchlistRemoveItem',
    'WatchlistListItems',
    'WatchlistRecordProductPrice',
]

// Smart Monitor — watch CRUD + capability discovery + the learning-loop
// feedback channel called at the end of every consolidated wake.
//
// The wake brief restricts the orchestrator to notify_inbox +
// monitor_wake_feedback only — the monitor_watch_* lifecycle tools are for
// the user-conversation context (set up, adjust, inspect), not for wakes.
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
