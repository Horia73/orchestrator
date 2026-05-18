import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { executeListDir } from './list-dir'
import { executeReadFile } from './read-file'
import { executeDelegateParallel, executeDelegateTo } from './delegate-to'
import { executeRead } from './read'
import { executeWrite } from './write'
import { executeEdit } from './edit'
import { executeBash } from './bash'
import { executeGlob } from './glob'
import { executeGrep } from './grep'
import { executeWebFetch } from './web'
import { executeTodoWrite } from './todo-write'
import { executeSetEnv } from './set-env'
import { getActivatedIntegrations } from '@/lib/integrations/activation-store'
import { getIntegrationManifest, operationalIntegrationFor } from '@/lib/integrations/manifest'
import { getIntegrationStatusSnapshot, refreshIntegrationStatusSnapshot } from '@/lib/integrations/status-snapshot'
import { executeActivateIntegrationTools } from './integrations'
import {
    executeGmailArchive,
    executeGmailCreateDraft,
    executeGmailCreateLabel,
    executeGmailDeletePermanently,
    executeGmailDownloadAttachment,
    executeGmailListLabels,
    executeGmailMarkRead,
    executeGmailMarkUnread,
    executeGmailModifyLabels,
    executeGmailReadThread,
    executeGmailSearch,
    executeGmailSendDraft,
    executeGmailSendEmail,
    executeGmailTrash,
    executeGmailUntrash,
} from './gmail'
import {
    executeGoogleCalendarConfigure,
    executeGoogleCalendarCreateEvent,
    executeGoogleCalendarDeleteEvent,
    executeGoogleCalendarFindAvailability,
    executeGoogleCalendarFreeBusy,
    executeGoogleCalendarGetEvent,
    executeGoogleCalendarListCalendars,
    executeGoogleCalendarListEvents,
    executeGoogleCalendarMoveEvent,
    executeGoogleCalendarRespondToEvent,
    executeGoogleCalendarSearchEvents,
    executeGoogleCalendarStartOAuth,
    executeGoogleCalendarStatus,
    executeGoogleCalendarUpdateEvent,
} from './google-calendar'
import {
    executeGoogleContactsBatchCreateContacts,
    executeGoogleContactsBatchDeleteContacts,
    executeGoogleContactsBatchGetPeople,
    executeGoogleContactsBatchUpdateContacts,
    executeGoogleContactsCopyOtherContactToMyContacts,
    executeGoogleContactsCreateContact,
    executeGoogleContactsCreateContactGroup,
    executeGoogleContactsDeleteContact,
    executeGoogleContactsDeleteContactGroup,
    executeGoogleContactsGetContactGroup,
    executeGoogleContactsGetPerson,
    executeGoogleContactsListConnections,
    executeGoogleContactsListContactGroups,
    executeGoogleContactsListOtherContacts,
    executeGoogleContactsModifyContactGroupMembers,
    executeGoogleContactsSearchContacts,
    executeGoogleContactsSearchOtherContacts,
    executeGoogleContactsUpdateContact,
    executeGoogleContactsUpdateContactGroup,
} from './google-contacts'
import {
    executeGoogleDriveAbout,
    executeGoogleDriveConfigure,
    executeGoogleDriveCopyFile,
    executeGoogleDriveCreateFolder,
    executeGoogleDriveCreateGoogleFile,
    executeGoogleDriveDeleteFile,
    executeGoogleDriveDeletePermission,
    executeGoogleDriveDownloadFile,
    executeGoogleDriveExportFile,
    executeGoogleDriveGetFile,
    executeGoogleDriveListFiles,
    executeGoogleDriveListPermissions,
    executeGoogleDriveListSharedDrives,
    executeGoogleDriveMoveFile,
    executeGoogleDriveReadFile,
    executeGoogleDriveShareFile,
    executeGoogleDriveStartOAuth,
    executeGoogleDriveStatus,
    executeGoogleDriveTrashFile,
    executeGoogleDriveUntrashFile,
    executeGoogleDriveUpdateFileContent,
    executeGoogleDriveUpdateMetadata,
    executeGoogleDriveUpdatePermission,
    executeGoogleDriveUploadFile,
} from './google-drive'
import {
    executeGoogleDocsApplyParagraphStyle,
    executeGoogleDocsApplyTextStyle,
    executeGoogleDocsBatchUpdate,
    executeGoogleDocsCreateDocument,
    executeGoogleDocsGetDocument,
    executeGoogleDocsInsertTable,
    executeGoogleDocsInsertText,
    executeGoogleDocsReplaceAllText,
} from './google-docs'
import {
    executeGoogleSheetsAppendValues,
    executeGoogleSheetsBatchGetValues,
    executeGoogleSheetsBatchUpdate,
    executeGoogleSheetsClearValues,
    executeGoogleSheetsCreateSpreadsheet,
    executeGoogleSheetsGetSpreadsheet,
    executeGoogleSheetsGetValues,
    executeGoogleSheetsUpdateValues,
} from './google-sheets'
import {
    executeGoogleSlidesBatchUpdate,
    executeGoogleSlidesCreatePresentation,
    executeGoogleSlidesCreateSlide,
    executeGoogleSlidesGetPage,
    executeGoogleSlidesGetPresentation,
    executeGoogleSlidesGetThumbnail,
    executeGoogleSlidesInsertTextBox,
    executeGoogleSlidesReplaceAllText,
} from './google-slides'
import {
    executeHomeAssistantApiInfo,
    executeHomeAssistantAutomationActivity,
    executeHomeAssistantCallService,
    executeHomeAssistantCameraSnapshot,
    executeHomeAssistantCheckConfig,
    executeHomeAssistantConfigure,
    executeHomeAssistantErrorLog,
    executeHomeAssistantGetConfig,
    executeHomeAssistantGetState,
    executeHomeAssistantHistory,
    executeHomeAssistantListAutomations,
    executeHomeAssistantListAutomationConfigs,
    executeHomeAssistantListCalendars,
    executeHomeAssistantListEvents,
    executeHomeAssistantListRegistries,
    executeHomeAssistantListScenes,
    executeHomeAssistantListScripts,
    executeHomeAssistantListServices,
    executeHomeAssistantListStates,
    executeHomeAssistantLogbook,
    executeHomeAssistantNotify,
    executeHomeAssistantPreviewAction,
    executeHomeAssistantReadActionAudit,
    executeHomeAssistantReadAutomationConfig,
    executeHomeAssistantReadCalendar,
    executeHomeAssistantRenderTemplate,
    executeHomeAssistantSearchEntities,
    executeHomeAssistantSetClimate,
    executeHomeAssistantSetCover,
    executeHomeAssistantSetLight,
    executeHomeAssistantStatus,
    executeHomeAssistantWebSocketRead,
} from './home-assistant'
import {
    executeWhatsAppConnect,
    executeWhatsAppListChats,
    executeWhatsAppReadChat,
    executeWhatsAppSearchMessages,
    executeWhatsAppStatus,
    executeWhatsAppUnreadSummary,
} from './whatsapp'
import {
    executeCancelTask,
    executeListTasks,
    executeRescheduleTask,
    executeScheduleTask,
} from './schedule'
import { executeNotifyInbox } from './notify'
import { executeSetTaskState } from './task-state'
import {
    executeWatchlistAddFinancialInstrument,
    executeWatchlistListItems,
    executeWatchlistRemoveItem,
} from './watchlist'

/**
 * Executor signature: tools may be sync or async, and may consult an
 * execution context (delegation, signals, depth tracking).
 */
type ToolExecutor = (
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext
) => ToolResult | Promise<ToolResult>

const executors: Record<string, ToolExecutor> = {
    list_dir: executeListDir,
    read_file: executeReadFile,
    delegate_to: executeDelegateTo,
    delegate_parallel: executeDelegateParallel,
    Read: executeRead,
    Write: executeWrite,
    Edit: executeEdit,
    Bash: executeBash,
    Glob: executeGlob,
    Grep: executeGrep,
    WebFetch: executeWebFetch,
    TodoWrite: executeTodoWrite,
    SetEnv: executeSetEnv,
    ActivateIntegrationTools: executeActivateIntegrationTools,
    RunActivatedIntegrationTool: executeRunActivatedIntegrationTool,
    GmailSearch: executeGmailSearch,
    GmailReadThread: executeGmailReadThread,
    GmailCreateDraft: executeGmailCreateDraft,
    GmailSendDraft: executeGmailSendDraft,
    GmailSendEmail: executeGmailSendEmail,
    GmailModifyLabels: executeGmailModifyLabels,
    GmailArchive: executeGmailArchive,
    GmailMarkRead: executeGmailMarkRead,
    GmailMarkUnread: executeGmailMarkUnread,
    GmailTrash: executeGmailTrash,
    GmailUntrash: executeGmailUntrash,
    GmailDeletePermanently: executeGmailDeletePermanently,
    GmailListLabels: executeGmailListLabels,
    GmailCreateLabel: executeGmailCreateLabel,
    GmailDownloadAttachment: executeGmailDownloadAttachment,
    GoogleCalendarStatus: executeGoogleCalendarStatus,
    GoogleCalendarConfigure: executeGoogleCalendarConfigure,
    GoogleCalendarStartOAuth: executeGoogleCalendarStartOAuth,
    GoogleCalendarListCalendars: executeGoogleCalendarListCalendars,
    GoogleCalendarListEvents: executeGoogleCalendarListEvents,
    GoogleCalendarGetEvent: executeGoogleCalendarGetEvent,
    GoogleCalendarSearchEvents: executeGoogleCalendarSearchEvents,
    GoogleCalendarFreeBusy: executeGoogleCalendarFreeBusy,
    GoogleCalendarFindAvailability: executeGoogleCalendarFindAvailability,
    GoogleCalendarCreateEvent: executeGoogleCalendarCreateEvent,
    GoogleCalendarUpdateEvent: executeGoogleCalendarUpdateEvent,
    GoogleCalendarDeleteEvent: executeGoogleCalendarDeleteEvent,
    GoogleCalendarRespondToEvent: executeGoogleCalendarRespondToEvent,
    GoogleCalendarMoveEvent: executeGoogleCalendarMoveEvent,
    GoogleContactsListConnections: executeGoogleContactsListConnections,
    GoogleContactsSearchContacts: executeGoogleContactsSearchContacts,
    GoogleContactsGetPerson: executeGoogleContactsGetPerson,
    GoogleContactsBatchGetPeople: executeGoogleContactsBatchGetPeople,
    GoogleContactsCreateContact: executeGoogleContactsCreateContact,
    GoogleContactsBatchCreateContacts: executeGoogleContactsBatchCreateContacts,
    GoogleContactsUpdateContact: executeGoogleContactsUpdateContact,
    GoogleContactsBatchUpdateContacts: executeGoogleContactsBatchUpdateContacts,
    GoogleContactsDeleteContact: executeGoogleContactsDeleteContact,
    GoogleContactsBatchDeleteContacts: executeGoogleContactsBatchDeleteContacts,
    GoogleContactsListContactGroups: executeGoogleContactsListContactGroups,
    GoogleContactsGetContactGroup: executeGoogleContactsGetContactGroup,
    GoogleContactsCreateContactGroup: executeGoogleContactsCreateContactGroup,
    GoogleContactsUpdateContactGroup: executeGoogleContactsUpdateContactGroup,
    GoogleContactsDeleteContactGroup: executeGoogleContactsDeleteContactGroup,
    GoogleContactsModifyContactGroupMembers: executeGoogleContactsModifyContactGroupMembers,
    GoogleContactsListOtherContacts: executeGoogleContactsListOtherContacts,
    GoogleContactsSearchOtherContacts: executeGoogleContactsSearchOtherContacts,
    GoogleContactsCopyOtherContactToMyContacts: executeGoogleContactsCopyOtherContactToMyContacts,
    GoogleDriveStatus: executeGoogleDriveStatus,
    GoogleDriveConfigure: executeGoogleDriveConfigure,
    GoogleDriveStartOAuth: executeGoogleDriveStartOAuth,
    GoogleDriveAbout: executeGoogleDriveAbout,
    GoogleDriveListSharedDrives: executeGoogleDriveListSharedDrives,
    GoogleDriveListFiles: executeGoogleDriveListFiles,
    GoogleDriveGetFile: executeGoogleDriveGetFile,
    GoogleDriveReadFile: executeGoogleDriveReadFile,
    GoogleDriveDownloadFile: executeGoogleDriveDownloadFile,
    GoogleDriveExportFile: executeGoogleDriveExportFile,
    GoogleDriveUploadFile: executeGoogleDriveUploadFile,
    GoogleDriveUpdateFileContent: executeGoogleDriveUpdateFileContent,
    GoogleDriveCreateFolder: executeGoogleDriveCreateFolder,
    GoogleDriveCreateGoogleFile: executeGoogleDriveCreateGoogleFile,
    GoogleDriveUpdateMetadata: executeGoogleDriveUpdateMetadata,
    GoogleDriveMoveFile: executeGoogleDriveMoveFile,
    GoogleDriveCopyFile: executeGoogleDriveCopyFile,
    GoogleDriveTrashFile: executeGoogleDriveTrashFile,
    GoogleDriveUntrashFile: executeGoogleDriveUntrashFile,
    GoogleDriveDeleteFile: executeGoogleDriveDeleteFile,
    GoogleDriveListPermissions: executeGoogleDriveListPermissions,
    GoogleDriveShareFile: executeGoogleDriveShareFile,
    GoogleDriveUpdatePermission: executeGoogleDriveUpdatePermission,
    GoogleDriveDeletePermission: executeGoogleDriveDeletePermission,
    GoogleDocsCreateDocument: executeGoogleDocsCreateDocument,
    GoogleDocsGetDocument: executeGoogleDocsGetDocument,
    GoogleDocsInsertText: executeGoogleDocsInsertText,
    GoogleDocsReplaceAllText: executeGoogleDocsReplaceAllText,
    GoogleDocsApplyTextStyle: executeGoogleDocsApplyTextStyle,
    GoogleDocsApplyParagraphStyle: executeGoogleDocsApplyParagraphStyle,
    GoogleDocsInsertTable: executeGoogleDocsInsertTable,
    GoogleDocsBatchUpdate: executeGoogleDocsBatchUpdate,
    GoogleSheetsCreateSpreadsheet: executeGoogleSheetsCreateSpreadsheet,
    GoogleSheetsGetSpreadsheet: executeGoogleSheetsGetSpreadsheet,
    GoogleSheetsGetValues: executeGoogleSheetsGetValues,
    GoogleSheetsBatchGetValues: executeGoogleSheetsBatchGetValues,
    GoogleSheetsUpdateValues: executeGoogleSheetsUpdateValues,
    GoogleSheetsAppendValues: executeGoogleSheetsAppendValues,
    GoogleSheetsClearValues: executeGoogleSheetsClearValues,
    GoogleSheetsBatchUpdate: executeGoogleSheetsBatchUpdate,
    GoogleSlidesCreatePresentation: executeGoogleSlidesCreatePresentation,
    GoogleSlidesGetPresentation: executeGoogleSlidesGetPresentation,
    GoogleSlidesGetPage: executeGoogleSlidesGetPage,
    GoogleSlidesGetThumbnail: executeGoogleSlidesGetThumbnail,
    GoogleSlidesCreateSlide: executeGoogleSlidesCreateSlide,
    GoogleSlidesInsertTextBox: executeGoogleSlidesInsertTextBox,
    GoogleSlidesReplaceAllText: executeGoogleSlidesReplaceAllText,
    GoogleSlidesBatchUpdate: executeGoogleSlidesBatchUpdate,
    HomeAssistantStatus: executeHomeAssistantStatus,
    HomeAssistantConfigure: executeHomeAssistantConfigure,
    HomeAssistantApiInfo: executeHomeAssistantApiInfo,
    HomeAssistantGetConfig: executeHomeAssistantGetConfig,
    HomeAssistantListStates: executeHomeAssistantListStates,
    HomeAssistantGetState: executeHomeAssistantGetState,
    HomeAssistantSearchEntities: executeHomeAssistantSearchEntities,
    HomeAssistantListServices: executeHomeAssistantListServices,
    HomeAssistantListEvents: executeHomeAssistantListEvents,
    HomeAssistantHistory: executeHomeAssistantHistory,
    HomeAssistantLogbook: executeHomeAssistantLogbook,
    HomeAssistantErrorLog: executeHomeAssistantErrorLog,
    HomeAssistantListCalendars: executeHomeAssistantListCalendars,
    HomeAssistantReadCalendar: executeHomeAssistantReadCalendar,
    HomeAssistantCameraSnapshot: executeHomeAssistantCameraSnapshot,
    HomeAssistantRenderTemplate: executeHomeAssistantRenderTemplate,
    HomeAssistantCheckConfig: executeHomeAssistantCheckConfig,
    HomeAssistantWebSocketRead: executeHomeAssistantWebSocketRead,
    HomeAssistantListRegistries: executeHomeAssistantListRegistries,
    HomeAssistantListAutomations: executeHomeAssistantListAutomations,
    HomeAssistantListScripts: executeHomeAssistantListScripts,
    HomeAssistantListScenes: executeHomeAssistantListScenes,
    HomeAssistantAutomationActivity: executeHomeAssistantAutomationActivity,
    HomeAssistantReadAutomationConfig: executeHomeAssistantReadAutomationConfig,
    HomeAssistantListAutomationConfigs: executeHomeAssistantListAutomationConfigs,
    HomeAssistantPreviewAction: executeHomeAssistantPreviewAction,
    HomeAssistantCallService: executeHomeAssistantCallService,
    HomeAssistantSetLight: executeHomeAssistantSetLight,
    HomeAssistantSetCover: executeHomeAssistantSetCover,
    HomeAssistantSetClimate: executeHomeAssistantSetClimate,
    HomeAssistantNotify: executeHomeAssistantNotify,
    HomeAssistantReadActionAudit: executeHomeAssistantReadActionAudit,
    WhatsAppStatus: executeWhatsAppStatus,
    WhatsAppConnect: executeWhatsAppConnect,
    WhatsAppListChats: executeWhatsAppListChats,
    WhatsAppUnreadSummary: executeWhatsAppUnreadSummary,
    WhatsAppReadChat: executeWhatsAppReadChat,
    WhatsAppSearchMessages: executeWhatsAppSearchMessages,
    schedule_task: executeScheduleTask,
    list_tasks: executeListTasks,
    cancel_task: executeCancelTask,
    reschedule_task: executeRescheduleTask,
    notify_inbox: executeNotifyInbox,
    set_task_state: executeSetTaskState,
    WatchlistAddFinancialInstrument: executeWatchlistAddFinancialInstrument,
    WatchlistRemoveItem: executeWatchlistRemoveItem,
    WatchlistListItems: executeWatchlistListItems,
}

async function executeRunActivatedIntegrationTool(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext
): Promise<ToolResult> {
    const conversationId = ctx?.conversationId
    if (!conversationId) {
        return { success: false, error: 'No conversation context — cannot run activated integration tools.' }
    }

    const toolId = typeof args.tool_id === 'string'
        ? args.tool_id.trim()
        : typeof args.toolId === 'string'
            ? args.toolId.trim()
            : ''
    if (!toolId) return { success: false, error: 'Missing tool_id.' }

    const targetArgs = args.arguments
    if (!targetArgs || typeof targetArgs !== 'object' || Array.isArray(targetArgs)) {
        return { success: false, error: 'arguments must be an object.' }
    }

    const integrationId = operationalIntegrationFor(toolId)
    if (!integrationId) {
        return { success: false, error: `${toolId} is not an operational integration tool.` }
    }

    const entry = getIntegrationManifest(integrationId)
    if (!entry) {
        return { success: false, error: `Unknown integration for tool: ${toolId}` }
    }

    let state = getIntegrationStatusSnapshot(ctx.appOrigin)[entry.statusKind]?.state
    if (state !== 'connected') {
        state = (await refreshIntegrationStatusSnapshot(ctx.appOrigin))[entry.statusKind]?.state
    }
    if (state !== 'connected') {
        return { success: false, error: `${entry.label} is not connected; current state is ${state ?? 'unknown'}.` }
    }

    const activated = getActivatedIntegrations(conversationId)
    if (!activated.has(integrationId)) {
        return {
            success: false,
            error: `${entry.label} tools are not active for this conversation. Call ActivateIntegrationTools with "${integrationId}" first.`,
        }
    }

    const executor = executors[toolId]
    if (!executor || toolId === 'RunActivatedIntegrationTool' || toolId === 'ActivateIntegrationTools') {
        return { success: false, error: `No operational executor registered for tool: ${toolId}` }
    }

    return executor(targetArgs as Record<string, unknown>, ctx)
}

/**
 * Execute a tool. Always returns a ToolResult — never throws — so the
 * provider's tool-call loop can route errors back to the model uniformly.
 *
 * `ctx` is required when invoking delegation-aware tools; for the others
 * (read_file, list_dir) it's harmless to pass or omit.
 */
export async function executeTool(
    tool: ToolDef,
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext
): Promise<ToolResult> {
    const executor = executors[tool.id]
    if (!executor) {
        return { success: false, error: `No executor registered for tool: ${tool.id}` }
    }

    try {
        return await executor(args, ctx)
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error executing tool',
        }
    }
}
