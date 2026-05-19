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

export const WATCHLIST_TOOL_IDS: string[] = [
    'WatchlistAddFinancialInstrument',
    'WatchlistRemoveItem',
    'WatchlistListItems',
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
