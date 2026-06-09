import fs from 'fs'
import path from 'path'

import { resolveAppOrigin } from '@/lib/app-origin'
import type { ToolDef, ToolExecutionContext, ToolParameter, ToolResult } from '@/lib/ai/agents/types'
import {
    type GoogleDriveGoogleFileInput,
    type GoogleDriveListFilesOptions,
    type GoogleDrivePermissionInput,
    getGoogleDriveIntegrationStatus,
    googleDriveCopyFile,
    googleDriveCreateFolder,
    googleDriveCreateGoogleFile,
    googleDriveCreatePermission,
    googleDriveDeleteFile,
    googleDriveDeletePermission,
    googleDriveDownloadFile,
    googleDriveExportFile,
    googleDriveGetAbout,
    googleDriveGetFile,
    googleDriveListFiles,
    googleDriveListPermissions,
    googleDriveListSharedDrives,
    googleDriveMoveFile,
    googleDriveReadFile,
    googleDriveTrashFile,
    googleDriveUntrashFile,
    googleDriveUpdateFileContent,
    googleDriveUpdateMetadata,
    googleDriveUpdatePermission,
    googleDriveUploadBytes,
    saveGoogleDriveOAuthConfig,
    startGoogleDriveOAuth,
} from '@/lib/integrations/google-drive'
import { runIdBatch } from '@/lib/integrations/batch'
import { clamp, collectIds, ensureParentDir, numberArg, stringArg } from './helpers'
import { displayPath, resolveSandboxed, resolveSandboxedWritable } from './sandbox'

const DEFAULT_ORIGIN = 'http://localhost:3000'
const MAX_LOCAL_UPLOAD_BYTES = 100 * 1024 * 1024
const MAX_LOCAL_DOWNLOAD_BYTES = 100 * 1024 * 1024

export const googleDriveStatusTool: ToolDef = {
    id: 'GoogleDriveStatus',
    name: 'GoogleDriveStatus',
    description: 'Checks Google Drive integration status, connected account, granted scopes, storage quota, and available capabilities.',
    input_schema: { type: 'object', properties: {} },
    tags: ['read', 'google-drive', 'setup'],
}

export const googleDriveConfigureTool: ToolDef = {
    id: 'GoogleDriveConfigure',
    name: 'GoogleDriveConfigure',
    description: [
        'Saves reusable Google Workspace OAuth client config for Google Drive, Calendar, and future Docs integrations.',
        'Use when the user provides Google OAuth client JSON, env lines, client ID, or client secret.',
        'Never echo client secrets back to the user.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            client_id: { type: 'string', description: 'Google OAuth client ID.' },
            client_secret: { type: 'string', description: 'Google OAuth client secret. Treat as secret.' },
            redirect_uri: { type: 'string', description: 'Optional redirect URI. Defaults to the shared Google OAuth callback.' },
            raw_env: { type: 'string', description: 'Pasted env lines or Google OAuth client JSON.' },
        },
    },
    tags: ['read', 'google-drive', 'setup'],
}

export const googleDriveStartOAuthTool: ToolDef = {
    id: 'GoogleDriveStartOAuth',
    name: 'GoogleDriveStartOAuth',
    description: 'Starts Google Drive OAuth and returns the consent URL the user must open. Do not claim connection succeeded until status confirms it.',
    input_schema: { type: 'object', properties: {} },
    tags: ['read', 'google-drive', 'setup', 'external_action'],
}

export const googleDriveAboutTool: ToolDef = {
    id: 'GoogleDriveAbout',
    name: 'GoogleDriveAbout',
    description: 'Reads Google Drive account metadata, user profile, storage quota, and import/export formats.',
    input_schema: { type: 'object', properties: {} },
    tags: ['read', 'google-drive'],
}

export const googleDriveListSharedDrivesTool: ToolDef = {
    id: 'GoogleDriveListSharedDrives',
    name: 'GoogleDriveListSharedDrives',
    description: 'Lists shared drives visible to the connected Google account.',
    input_schema: {
        type: 'object',
        properties: {
            max_results: { type: 'integer', description: 'Maximum shared drives to return. Defaults to 100 and is capped at 100.' },
            query: { type: 'string', description: 'Optional Drive shared-drive query.' },
            page_token: { type: 'string', description: 'Optional pagination token.' },
        },
    },
    tags: ['read', 'google-drive', 'shared-drive'],
}

export const googleDriveListFilesTool: ToolDef = {
    id: 'GoogleDriveListFiles',
    name: 'GoogleDriveListFiles',
    description: 'Lists/searches Google Drive files with Drive query filters. Prefer bounded filters and max_results for privacy.',
    input_schema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Advanced Drive q expression. Combined with other filters.' },
            text_query: { type: 'string', description: 'Searches name or full text.' },
            name_contains: { type: 'string', description: 'Filters by file name substring.' },
            parent_id: { type: 'string', description: 'Folder ID to list.' },
            mime_types: { type: 'array', items: { type: 'string' }, description: 'One or more MIME types to include.' },
            spaces: { type: 'string', description: 'Drive spaces, e.g. drive or appDataFolder.' },
            corpora: { type: 'string', enum: ['user', 'drive', 'allDrives', 'domain'], description: 'Search corpus.' },
            drive_id: { type: 'string', description: 'Shared drive ID. Sets corpora=drive by default.' },
            include_trashed: { type: 'boolean', description: 'Include trashed files. Defaults to false.' },
            starred: { type: 'boolean', description: 'Filter by starred state.' },
            shared_with_me: { type: 'boolean', description: 'Only files shared with me.' },
            owned_by_me: { type: 'boolean', description: 'Filter by current account ownership.' },
            modified_after: { type: 'string', description: 'RFC3339 lower bound for modifiedTime.' },
            modified_before: { type: 'string', description: 'RFC3339 upper bound for modifiedTime.' },
            created_after: { type: 'string', description: 'RFC3339 lower bound for createdTime.' },
            created_before: { type: 'string', description: 'RFC3339 upper bound for createdTime.' },
            order_by: { type: 'string', description: 'Drive orderBy, e.g. modifiedTime desc,name.' },
            page_token: { type: 'string', description: 'Optional pagination token.' },
            max_results: { type: 'integer', description: 'Defaults to 50 and is capped at 1000.' },
        },
    },
    tags: ['read', 'google-drive', 'file'],
}

export const googleDriveGetFileTool: ToolDef = {
    id: 'GoogleDriveGetFile',
    name: 'GoogleDriveGetFile',
    description: 'Gets Google Drive file metadata by file_id.',
    input_schema: {
        type: 'object',
        properties: {
            file_id: fileIdSchema(),
        },
        required: ['file_id'],
    },
    tags: ['read', 'google-drive', 'file'],
}

export const googleDriveReadFileTool: ToolDef = {
    id: 'GoogleDriveReadFile',
    name: 'GoogleDriveReadFile',
    description: 'Reads text-like Google Drive file content. Google Workspace files are exported first; binary files return metadata and binary=true.',
    input_schema: {
        type: 'object',
        properties: {
            file_id: fileIdSchema(),
            export_mime_type: { type: 'string', description: 'Export MIME type for Google Workspace files. Defaults to text/plain or text/csv for Sheets.' },
            max_bytes: { type: 'integer', description: 'Maximum bytes to retrieve. Defaults to 5MB and is capped at 20MB.' },
            max_chars: { type: 'integer', description: 'Maximum text chars returned. Defaults to 100000 and is capped at 500000.' },
        },
        required: ['file_id'],
    },
    tags: ['read', 'google-drive', 'file'],
}

export const googleDriveDownloadFileTool: ToolDef = {
    id: 'GoogleDriveDownloadFile',
    name: 'GoogleDriveDownloadFile',
    description: 'Downloads a non-Google-Workspace Drive file into the agent workspace. Use ExportFile for Docs/Sheets/Slides.',
    input_schema: {
        type: 'object',
        properties: {
            file_id: fileIdSchema(),
            save_path: { type: 'string', description: 'Workspace path to save. Defaults to /google-drive-downloads/<filename>.' },
            max_bytes: { type: 'integer', description: 'Maximum bytes to save. Defaults to 50MB and is capped at 100MB.' },
        },
        required: ['file_id'],
    },
    tags: ['read', 'google-drive', 'file', 'filesystem'],
}

export const googleDriveExportFileTool: ToolDef = {
    id: 'GoogleDriveExportFile',
    name: 'GoogleDriveExportFile',
    description: 'Exports a Google Docs/Sheets/Slides/Drawings file into the agent workspace.',
    input_schema: {
        type: 'object',
        properties: {
            file_id: fileIdSchema(),
            mime_type: { type: 'string', description: 'Export MIME type, e.g. text/plain, text/csv, application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document.' },
            save_path: { type: 'string', description: 'Workspace path to save. Defaults to /google-drive-exports/<filename>.<extension>.' },
            max_bytes: { type: 'integer', description: 'Maximum bytes to save. Defaults to 20MB and is capped at 50MB.' },
        },
        required: ['file_id'],
    },
    tags: ['read', 'google-drive', 'file', 'filesystem'],
}

export const googleDriveUploadFileTool: ToolDef = {
    id: 'GoogleDriveUploadFile',
    name: 'GoogleDriveUploadFile',
    description: 'Uploads a local workspace file to Google Drive. Only use after explicit approval because local content leaves this machine.',
    input_schema: {
        type: 'object',
        properties: {
            source_path: { type: 'string', description: 'Workspace file path to upload.' },
            name: { type: 'string', description: 'Optional Drive file name. Defaults to source filename.' },
            mime_type: { type: 'string', description: 'Optional MIME type. Defaults from extension or application/octet-stream.' },
            parent_ids: { type: 'array', items: { type: 'string' }, description: 'Optional destination folder IDs.' },
            description: { type: 'string', description: 'Optional Drive file description.' },
            max_bytes: { type: 'integer', description: 'Maximum local file bytes. Defaults to 100MB and is capped at 100MB.' },
            confirmed_by_user: confirmationSchema('Must be true only after the user approves uploading this exact local file to Drive.'),
        },
        required: ['source_path', 'confirmed_by_user'],
    },
    tags: ['write', 'google-drive', 'file', 'filesystem', 'external_action'],
}

export const googleDriveUpdateFileContentTool: ToolDef = {
    id: 'GoogleDriveUpdateFileContent',
    name: 'GoogleDriveUpdateFileContent',
    description: 'Replaces a Drive file content with a local workspace file. Only use after explicit approval.',
    input_schema: {
        type: 'object',
        properties: {
            file_id: fileIdSchema(),
            source_path: { type: 'string', description: 'Workspace file path used as replacement content.' },
            name: { type: 'string', description: 'Optional new Drive file name.' },
            mime_type: { type: 'string', description: 'Optional MIME type.' },
            description: { type: 'string', description: 'Optional Drive file description.' },
            max_bytes: { type: 'integer', description: 'Maximum local file bytes. Defaults to 100MB and is capped at 100MB.' },
            confirmed_by_user: confirmationSchema('Must be true only after explicit approval to replace this exact Drive file content.'),
        },
        required: ['file_id', 'source_path', 'confirmed_by_user'],
    },
    tags: ['write', 'google-drive', 'file', 'filesystem', 'external_action'],
}

export const googleDriveCreateFolderTool = driveWriteTool('GoogleDriveCreateFolder', 'GoogleDriveCreateFolder', 'Creates a Google Drive folder after explicit approval.', {
    name: { type: 'string', description: 'Folder name.' },
    parent_id: { type: 'string', description: 'Optional parent folder ID.' },
    description: { type: 'string', description: 'Optional description.' },
}, ['name', 'confirmed_by_user'])

export const googleDriveCreateGoogleFileTool = driveWriteTool('GoogleDriveCreateGoogleFile', 'GoogleDriveCreateGoogleFile', 'Creates a blank Google Docs/Sheets/Slides/Drawings/Form file after explicit approval.', {
    name: { type: 'string', description: 'File name.' },
    type: { type: 'string', enum: ['document', 'spreadsheet', 'presentation', 'drawing', 'form'], description: 'Google file type.' },
    parent_ids: { type: 'array', items: { type: 'string' }, description: 'Optional parent folder IDs.' },
    description: { type: 'string', description: 'Optional description.' },
}, ['name', 'type', 'confirmed_by_user'])

export const googleDriveUpdateMetadataTool = driveWriteTool('GoogleDriveUpdateMetadata', 'GoogleDriveUpdateMetadata', 'Updates Drive file metadata such as name, description, starred, or trashed after explicit approval.', {
    file_id: fileIdSchema(),
    name: { type: 'string', description: 'Optional new file name.' },
    description: { type: 'string', description: 'Optional new description.' },
    starred: { type: 'boolean', description: 'Optional starred state.' },
    trashed: { type: 'boolean', description: 'Optional trashed state.' },
}, ['file_id', 'confirmed_by_user'])

export const googleDriveMoveFileTool = driveWriteTool('GoogleDriveMoveFile', 'GoogleDriveMoveFile', 'Moves a Drive file to another folder after explicit approval. To move several files to the same destination in one call, pass file_ids (array).', {
    file_id: fileIdSchema(),
    file_ids: fileIdsSchema('move to the same destination folder'),
    destination_folder_id: { type: 'string', description: 'Destination folder ID.' },
    remove_parent_ids: { type: 'array', items: { type: 'string' }, description: 'Optional parent IDs to remove. Defaults to current parents.' },
}, ['destination_folder_id', 'confirmed_by_user'])

export const googleDriveCopyFileTool = driveWriteTool('GoogleDriveCopyFile', 'GoogleDriveCopyFile', 'Copies a Drive file after explicit approval.', {
    file_id: fileIdSchema(),
    name: { type: 'string', description: 'Optional copied file name.' },
    parent_ids: { type: 'array', items: { type: 'string' }, description: 'Optional destination folder IDs.' },
    description: { type: 'string', description: 'Optional copied file description.' },
}, ['file_id', 'confirmed_by_user'])

export const googleDriveTrashFileTool = driveWriteTool('GoogleDriveTrashFile', 'GoogleDriveTrashFile', 'Moves a Drive file to Trash after explicit approval. To trash several files in one call, pass file_ids (array).', {
    file_id: fileIdSchema(),
    file_ids: fileIdsSchema('move to Trash'),
}, ['confirmed_by_user'])

export const googleDriveUntrashFileTool = driveWriteTool('GoogleDriveUntrashFile', 'GoogleDriveUntrashFile', 'Restores a Drive file from Trash after explicit approval. To restore several files in one call, pass file_ids (array).', {
    file_id: fileIdSchema(),
    file_ids: fileIdsSchema('restore from Trash'),
}, ['confirmed_by_user'])

export const googleDriveDeleteFileTool = driveWriteTool('GoogleDriveDeleteFile', 'GoogleDriveDeleteFile', 'Permanently deletes a Drive file. This cannot be undone and requires explicit approval. To delete several files in one call, pass file_ids (array); the single confirmation covers the whole batch.', {
    file_id: fileIdSchema(),
    file_ids: fileIdsSchema('permanently delete'),
    confirm_permanent_delete: { type: 'boolean', description: 'Must be true only after explicit approval for permanent deletion. Covers every id in the batch.' },
}, ['confirmed_by_user', 'confirm_permanent_delete'])

export const googleDriveListPermissionsTool: ToolDef = {
    id: 'GoogleDriveListPermissions',
    name: 'GoogleDriveListPermissions',
    description: 'Lists sharing permissions on a Google Drive file.',
    input_schema: {
        type: 'object',
        properties: { file_id: fileIdSchema() },
        required: ['file_id'],
    },
    tags: ['read', 'google-drive', 'permissions'],
}

export const googleDriveShareFileTool = driveWriteTool('GoogleDriveShareFile', 'GoogleDriveShareFile', 'Creates a Google Drive sharing permission. Requires explicit approval, especially for external or anyone/domain sharing.', {
    file_id: fileIdSchema(),
    type: { type: 'string', enum: ['user', 'group', 'domain', 'anyone'], description: 'Permission principal type.' },
    role: { type: 'string', enum: ['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner'], description: 'Permission role.' },
    email_address: { type: 'string', description: 'Required for user/group permissions.' },
    domain: { type: 'string', description: 'Required for domain permissions.' },
    allow_file_discovery: { type: 'boolean', description: 'Whether domain/anyone links are discoverable.' },
    expiration_time: { type: 'string', description: 'Optional RFC3339 expiration time.' },
    send_notification_email: { type: 'boolean', description: 'Whether Google sends a notification email.' },
    email_message: { type: 'string', description: 'Optional notification email message.' },
    transfer_ownership: { type: 'boolean', description: 'Required true when role=owner.' },
}, ['file_id', 'type', 'role', 'confirmed_by_user'])

export const googleDriveUpdatePermissionTool = driveWriteTool('GoogleDriveUpdatePermission', 'GoogleDriveUpdatePermission', 'Updates an existing Drive permission after explicit approval.', {
    file_id: fileIdSchema(),
    permission_id: { type: 'string', description: 'Permission ID.' },
    role: { type: 'string', enum: ['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner'], description: 'Optional new permission role.' },
    expiration_time: { type: 'string', description: 'Optional RFC3339 expiration time. Empty string clears expiration.' },
    transfer_ownership: { type: 'boolean', description: 'Required true when role=owner.' },
}, ['file_id', 'permission_id', 'confirmed_by_user'])

export const googleDriveDeletePermissionTool = driveWriteTool('GoogleDriveDeletePermission', 'GoogleDriveDeletePermission', 'Deletes a Drive sharing permission after explicit approval.', {
    file_id: fileIdSchema(),
    permission_id: { type: 'string', description: 'Permission ID.' },
}, ['file_id', 'permission_id', 'confirmed_by_user'])

export const googleDriveTools: ToolDef[] = [
    googleDriveStatusTool,
    googleDriveConfigureTool,
    googleDriveStartOAuthTool,
    googleDriveAboutTool,
    googleDriveListSharedDrivesTool,
    googleDriveListFilesTool,
    googleDriveGetFileTool,
    googleDriveReadFileTool,
    googleDriveDownloadFileTool,
    googleDriveExportFileTool,
    googleDriveUploadFileTool,
    googleDriveUpdateFileContentTool,
    googleDriveCreateFolderTool,
    googleDriveCreateGoogleFileTool,
    googleDriveUpdateMetadataTool,
    googleDriveMoveFileTool,
    googleDriveCopyFileTool,
    googleDriveTrashFileTool,
    googleDriveUntrashFileTool,
    googleDriveDeleteFileTool,
    googleDriveListPermissionsTool,
    googleDriveShareFileTool,
    googleDriveUpdatePermissionTool,
    googleDriveDeletePermissionTool,
]

export async function executeGoogleDriveStatus(_args?: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<ToolResult> {
    return { success: true, data: await getGoogleDriveIntegrationStatus(toolOrigin(ctx), true) }
}

export async function executeGoogleDriveConfigure(args: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<ToolResult> {
    const data = await saveGoogleDriveOAuthConfig(toolOrigin(ctx), {
        clientId: stringArg(args, ['client_id', 'clientId']),
        clientSecret: stringArg(args, ['client_secret', 'clientSecret']),
        redirectUri: stringArg(args, ['redirect_uri', 'redirectUri']),
        rawEnv: stringArg(args, ['raw_env', 'rawEnv']),
    })
    return { success: true, data }
}

export async function executeGoogleDriveStartOAuth(_args?: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<ToolResult> {
    return { success: true, data: startGoogleDriveOAuth(toolOrigin(ctx)) }
}

function toolOrigin(ctx?: ToolExecutionContext): string {
    return resolveAppOrigin(ctx?.appOrigin ?? DEFAULT_ORIGIN)
}

export async function executeGoogleDriveAbout(): Promise<ToolResult> {
    return { success: true, data: await googleDriveGetAbout() }
}

export async function executeGoogleDriveListSharedDrives(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await googleDriveListSharedDrives({
            maxResults: clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 100)), 1, 100),
            query: stringArg(args, ['query', 'q']),
            pageToken: stringArg(args, ['page_token', 'pageToken']),
        }),
    }
}

export async function executeGoogleDriveListFiles(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await googleDriveListFiles(parseListOptions(args)),
    }
}

export async function executeGoogleDriveGetFile(args: Record<string, unknown>): Promise<ToolResult> {
    const fileId = stringArg(args, ['file_id', 'fileId'])
    if (!fileId) return missing('file_id')
    return { success: true, data: await googleDriveGetFile(fileId) }
}

export async function executeGoogleDriveReadFile(args: Record<string, unknown>): Promise<ToolResult> {
    const fileId = stringArg(args, ['file_id', 'fileId'])
    if (!fileId) return missing('file_id')
    return {
        success: true,
        data: await googleDriveReadFile({
            fileId,
            exportMimeType: stringArg(args, ['export_mime_type', 'exportMimeType', 'mime_type']),
            maxBytes: clamp(Math.floor(numberArg(args, ['max_bytes', 'maxBytes'], 5 * 1024 * 1024)), 1, 20 * 1024 * 1024),
            maxChars: clamp(Math.floor(numberArg(args, ['max_chars', 'maxChars'], 100_000)), 1_000, 500_000),
        }),
    }
}

export async function executeGoogleDriveDownloadFile(args: Record<string, unknown>): Promise<ToolResult> {
    const fileId = stringArg(args, ['file_id', 'fileId'])
    if (!fileId) return missing('file_id')
    const maxBytes = clamp(Math.floor(numberArg(args, ['max_bytes', 'maxBytes'], 50 * 1024 * 1024)), 1, MAX_LOCAL_DOWNLOAD_BYTES)
    const result = await googleDriveDownloadFile(fileId, maxBytes)
    const savePath = resolveDriveSavePath(args, result.file.name, 'google-drive-downloads')
    if (!savePath.ok) return { success: false, error: savePath.error }
    ensureParentDir(savePath.resolved)
    fs.writeFileSync(savePath.resolved, result.bytes)
    return {
        success: true,
        data: {
            file: result.file,
            mime_type: result.mimeType,
            path: displayPath(savePath.resolved),
            bytes: result.bytes.byteLength,
        },
    }
}

export async function executeGoogleDriveExportFile(args: Record<string, unknown>): Promise<ToolResult> {
    const fileId = stringArg(args, ['file_id', 'fileId'])
    if (!fileId) return missing('file_id')
    const mimeType = stringArg(args, ['mime_type', 'mimeType']) || 'text/plain'
    const maxBytes = clamp(Math.floor(numberArg(args, ['max_bytes', 'maxBytes'], 20 * 1024 * 1024)), 1, 50 * 1024 * 1024)
    const result = await googleDriveExportFile(fileId, mimeType, maxBytes)
    const defaultName = `${stripExtension(result.file.name)}.${extensionForMime(mimeType)}`
    const savePath = resolveDriveSavePath(args, defaultName, 'google-drive-exports')
    if (!savePath.ok) return { success: false, error: savePath.error }
    ensureParentDir(savePath.resolved)
    fs.writeFileSync(savePath.resolved, result.bytes)
    return {
        success: true,
        data: {
            file: result.file,
            mime_type: result.mimeType,
            path: displayPath(savePath.resolved),
            bytes: result.bytes.byteLength,
        },
    }
}

export async function executeGoogleDriveUploadFile(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return confirmationError('uploading a local file to Google Drive')
    const parsed = readLocalFileInput(args)
    if (!parsed.ok) return parsed.error
    const name = stringArg(args, ['name']) || path.basename(parsed.resolved)
    const data = await googleDriveUploadBytes({
        name,
        mimeType: stringArg(args, ['mime_type', 'mimeType', 'content_type']) || mimeTypeFromPath(name),
        bytes: parsed.bytes,
        parents: stringArrayArg(args, ['parent_ids', 'parentIds', 'parents']),
        description: stringArg(args, ['description']),
    })
    return { success: true, data }
}

export async function executeGoogleDriveUpdateFileContent(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return confirmationError('replacing Drive file content')
    const fileId = stringArg(args, ['file_id', 'fileId'])
    if (!fileId) return missing('file_id')
    const parsed = readLocalFileInput(args)
    if (!parsed.ok) return parsed.error
    const name = stringArg(args, ['name'])
    const data = await googleDriveUpdateFileContent({
        fileId,
        name,
        mimeType: stringArg(args, ['mime_type', 'mimeType', 'content_type']) || (name ? mimeTypeFromPath(name) : mimeTypeFromPath(parsed.resolved)),
        bytes: parsed.bytes,
        description: stringArg(args, ['description']),
    })
    return { success: true, data }
}

export async function executeGoogleDriveCreateFolder(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return confirmationError('creating a Drive folder')
    const name = stringArg(args, ['name'])
    if (!name) return missing('name')
    return {
        success: true,
        data: await googleDriveCreateFolder({
            name,
            parentId: stringArg(args, ['parent_id', 'parentId']),
            description: stringArg(args, ['description']),
        }),
    }
}

export async function executeGoogleDriveCreateGoogleFile(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return confirmationError('creating a Google Drive file')
    const name = stringArg(args, ['name'])
    const type = enumArg(args, ['type'], ['document', 'spreadsheet', 'presentation', 'drawing', 'form'])
    if (!name) return missing('name')
    if (!type) return { success: false, error: 'type must be document, spreadsheet, presentation, drawing, or form.' }
    const input: GoogleDriveGoogleFileInput = {
        name,
        type,
        parents: stringArrayArg(args, ['parent_ids', 'parentIds', 'parents']),
        description: stringArg(args, ['description']),
    }
    return { success: true, data: await googleDriveCreateGoogleFile(input) }
}

export async function executeGoogleDriveUpdateMetadata(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return confirmationError('updating Drive file metadata')
    const fileId = stringArg(args, ['file_id', 'fileId'])
    if (!fileId) return missing('file_id')
    return {
        success: true,
        data: await googleDriveUpdateMetadata(fileId, {
            name: stringArg(args, ['name']),
            description: stringArg(args, ['description']),
            starred: optionalBooleanArg(args, ['starred']),
            trashed: optionalBooleanArg(args, ['trashed']),
        }),
    }
}

export async function executeGoogleDriveMoveFile(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return confirmationError('moving a Drive file')
    const fileIds = collectIds(args, ['file_ids', 'file_id', 'fileId', 'ids', 'id'])
    const destinationFolderId = stringArg(args, ['destination_folder_id', 'destinationFolderId'])
    if (fileIds.length === 0) return missing('file_id')
    if (!destinationFolderId) return missing('destination_folder_id')
    const removeParentIds = stringArrayArg(args, ['remove_parent_ids', 'removeParentIds'])
    if (fileIds.length === 1) {
        return { success: true, data: await googleDriveMoveFile(fileIds[0], destinationFolderId, removeParentIds) }
    }
    return { success: true, data: await runIdBatch(fileIds, id => googleDriveMoveFile(id, destinationFolderId, removeParentIds), { concurrency: 5 }) }
}

export async function executeGoogleDriveCopyFile(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return confirmationError('copying a Drive file')
    const fileId = stringArg(args, ['file_id', 'fileId'])
    if (!fileId) return missing('file_id')
    return {
        success: true,
        data: await googleDriveCopyFile(fileId, {
            name: stringArg(args, ['name']),
            parentIds: stringArrayArg(args, ['parent_ids', 'parentIds']),
            description: stringArg(args, ['description']),
        }),
    }
}

export async function executeGoogleDriveTrashFile(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return confirmationError('trashing a Drive file')
    const fileIds = collectIds(args, ['file_ids', 'file_id', 'fileId', 'ids', 'id'])
    if (fileIds.length === 0) return missing('file_id')
    if (fileIds.length === 1) return { success: true, data: await googleDriveTrashFile(fileIds[0]) }
    return { success: true, data: await runIdBatch(fileIds, id => googleDriveTrashFile(id), { concurrency: 5 }) }
}

export async function executeGoogleDriveUntrashFile(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return confirmationError('restoring a Drive file from Trash')
    const fileIds = collectIds(args, ['file_ids', 'file_id', 'fileId', 'ids', 'id'])
    if (fileIds.length === 0) return missing('file_id')
    if (fileIds.length === 1) return { success: true, data: await googleDriveUntrashFile(fileIds[0]) }
    return { success: true, data: await runIdBatch(fileIds, id => googleDriveUntrashFile(id), { concurrency: 5 }) }
}

export async function executeGoogleDriveDeleteFile(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true || args.confirm_permanent_delete !== true) {
        return { success: false, error: 'confirmed_by_user and confirm_permanent_delete must both be true before permanent Drive deletion.' }
    }
    const fileIds = collectIds(args, ['file_ids', 'file_id', 'fileId', 'ids', 'id'])
    if (fileIds.length === 0) return missing('file_id')
    if (fileIds.length === 1) return { success: true, data: await googleDriveDeleteFile(fileIds[0]) }
    return { success: true, data: await runIdBatch(fileIds, id => googleDriveDeleteFile(id), { concurrency: 4 }) }
}

export async function executeGoogleDriveListPermissions(args: Record<string, unknown>): Promise<ToolResult> {
    const fileId = stringArg(args, ['file_id', 'fileId'])
    if (!fileId) return missing('file_id')
    return { success: true, data: await googleDriveListPermissions(fileId) }
}

export async function executeGoogleDriveShareFile(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return confirmationError('sharing a Drive file')
    const input = parsePermissionInput(args)
    if (!input.ok) return input.error
    return { success: true, data: await googleDriveCreatePermission(input.value) }
}

export async function executeGoogleDriveUpdatePermission(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return confirmationError('updating a Drive sharing permission')
    const fileId = stringArg(args, ['file_id', 'fileId'])
    const permissionId = stringArg(args, ['permission_id', 'permissionId'])
    if (!fileId) return missing('file_id')
    if (!permissionId) return missing('permission_id')
    const role = enumArg(args, ['role'], ['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner'])
    if (role === 'owner' && args.transfer_ownership !== true) {
        return { success: false, error: 'transfer_ownership must be true before changing a permission to owner.' }
    }
    return {
        success: true,
        data: await googleDriveUpdatePermission(fileId, permissionId, {
            role,
            expirationTime: stringArg(args, ['expiration_time', 'expirationTime']),
            transferOwnership: args.transfer_ownership === true,
        }),
    }
}

export async function executeGoogleDriveDeletePermission(args: Record<string, unknown>): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) return confirmationError('deleting a Drive sharing permission')
    const fileId = stringArg(args, ['file_id', 'fileId'])
    const permissionId = stringArg(args, ['permission_id', 'permissionId'])
    if (!fileId) return missing('file_id')
    if (!permissionId) return missing('permission_id')
    return { success: true, data: await googleDriveDeletePermission(fileId, permissionId) }
}

function parseListOptions(args: Record<string, unknown>): GoogleDriveListFilesOptions {
    return {
        query: stringArg(args, ['query', 'q']),
        textQuery: stringArg(args, ['text_query', 'textQuery']),
        nameContains: stringArg(args, ['name_contains', 'nameContains']),
        parentId: stringArg(args, ['parent_id', 'parentId']),
        mimeTypes: stringArrayArg(args, ['mime_types', 'mimeTypes']),
        spaces: stringArg(args, ['spaces']),
        corpora: enumArg(args, ['corpora'], ['user', 'drive', 'allDrives', 'domain']),
        driveId: stringArg(args, ['drive_id', 'driveId']),
        includeTrashed: booleanArg(args, ['include_trashed', 'includeTrashed']),
        starred: optionalBooleanArg(args, ['starred']),
        sharedWithMe: booleanArg(args, ['shared_with_me', 'sharedWithMe']),
        ownedByMe: optionalBooleanArg(args, ['owned_by_me', 'ownedByMe']),
        modifiedAfter: stringArg(args, ['modified_after', 'modifiedAfter']),
        modifiedBefore: stringArg(args, ['modified_before', 'modifiedBefore']),
        createdAfter: stringArg(args, ['created_after', 'createdAfter']),
        createdBefore: stringArg(args, ['created_before', 'createdBefore']),
        orderBy: stringArg(args, ['order_by', 'orderBy']),
        pageToken: stringArg(args, ['page_token', 'pageToken']),
        maxResults: clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 50)), 1, 1000),
    }
}

function parsePermissionInput(args: Record<string, unknown>):
    | { ok: true; value: GoogleDrivePermissionInput }
    | { ok: false; error: ToolResult } {
    const fileId = stringArg(args, ['file_id', 'fileId'])
    const type = enumArg(args, ['type'], ['user', 'group', 'domain', 'anyone'])
    const role = enumArg(args, ['role'], ['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner'])
    if (!fileId) return { ok: false, error: missing('file_id') }
    if (!type) return { ok: false, error: { success: false, error: 'type must be user, group, domain, or anyone.' } }
    if (!role) return { ok: false, error: { success: false, error: 'role must be reader, commenter, writer, fileOrganizer, organizer, or owner.' } }
    const emailAddress = stringArg(args, ['email_address', 'emailAddress'])
    const domain = stringArg(args, ['domain'])
    if ((type === 'user' || type === 'group') && !emailAddress) return { ok: false, error: missing('email_address') }
    if (type === 'domain' && !domain) return { ok: false, error: missing('domain') }
    if (role === 'owner' && args.transfer_ownership !== true) {
        return { ok: false, error: { success: false, error: 'transfer_ownership must be true before creating an owner permission.' } }
    }
    return {
        ok: true,
        value: {
            fileId,
            type,
            role,
            emailAddress,
            domain,
            allowFileDiscovery: optionalBooleanArg(args, ['allow_file_discovery', 'allowFileDiscovery']),
            expirationTime: stringArg(args, ['expiration_time', 'expirationTime']),
            sendNotificationEmail: optionalBooleanArg(args, ['send_notification_email', 'sendNotificationEmail']),
            emailMessage: stringArg(args, ['email_message', 'emailMessage']),
            transferOwnership: args.transfer_ownership === true,
        },
    }
}

function readLocalFileInput(args: Record<string, unknown>):
    | { ok: true; resolved: string; bytes: Buffer }
    | { ok: false; error: ToolResult } {
    const sourcePath = stringArg(args, ['source_path', 'sourcePath', 'path'])
    if (!sourcePath) return { ok: false, error: missing('source_path') }
    const resolved = resolveSandboxed(sourcePath)
    if (!resolved.ok) return { ok: false, error: { success: false, error: resolved.error } }
    let stat: fs.Stats
    try {
        stat = fs.statSync(resolved.resolved)
    } catch {
        return { ok: false, error: { success: false, error: `File not found: ${sourcePath}` } }
    }
    if (!stat.isFile()) return { ok: false, error: { success: false, error: `Not a file: ${sourcePath}` } }
    const maxBytes = clamp(Math.floor(numberArg(args, ['max_bytes', 'maxBytes'], MAX_LOCAL_UPLOAD_BYTES)), 1, MAX_LOCAL_UPLOAD_BYTES)
    if (stat.size > maxBytes) return { ok: false, error: { success: false, error: `File is ${stat.size} bytes, above max_bytes ${maxBytes}.` } }
    return { ok: true, resolved: resolved.resolved, bytes: fs.readFileSync(resolved.resolved) }
}

function resolveDriveSavePath(args: Record<string, unknown>, filename: string, defaultDir: string) {
    const safe = safeFilename(filename || 'drive-file')
    const rawSavePath = stringArg(args, ['save_path', 'savePath', 'path']) || path.posix.join(defaultDir, safe)
    const savePath = rawSavePath.endsWith('/') ? path.posix.join(rawSavePath, safe) : rawSavePath
    return resolveSandboxedWritable(savePath)
}

function stringArrayArg(args: Record<string, unknown>, keys: string[]): string[] {
    for (const key of keys) {
        const value = args[key]
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean)
    }
    return []
}

function booleanArg(args: Record<string, unknown>, keys: string[], fallback = false): boolean {
    for (const key of keys) {
        const value = args[key]
        if (typeof value === 'boolean') return value
        if (typeof value === 'string') {
            if (value.toLowerCase() === 'true') return true
            if (value.toLowerCase() === 'false') return false
        }
    }
    return fallback
}

function optionalBooleanArg(args: Record<string, unknown>, keys: string[]): boolean | undefined {
    for (const key of keys) {
        const value = args[key]
        if (typeof value === 'boolean') return value
        if (typeof value === 'string') {
            if (value.toLowerCase() === 'true') return true
            if (value.toLowerCase() === 'false') return false
        }
    }
    return undefined
}

function enumArg<T extends string>(args: Record<string, unknown>, keys: string[], allowed: readonly T[]): T | undefined {
    const value = stringArg(args, keys)
    if (!value) return undefined
    return allowed.includes(value as T) ? value as T : undefined
}

function fileIdSchema(description = 'A single Google Drive file ID. Use file_ids to act on multiple.'): ToolParameter {
    return { type: 'string', description }
}

function fileIdsSchema(action: string): ToolParameter {
    return {
        type: 'array',
        items: { type: 'string' },
        description: `Multiple Google Drive file IDs to ${action} in ONE batch call. Preferred over repeated single-id calls. Returns a per-item summary.`,
    }
}

function confirmationSchema(description: string): ToolParameter {
    return { type: 'boolean', description }
}

function driveWriteTool(id: string, name: string, description: string, properties: Record<string, ToolParameter>, required: string[]): ToolDef {
    return {
        id,
        name,
        description,
        input_schema: {
            type: 'object',
            properties: {
                ...properties,
                confirmed_by_user: confirmationSchema('Must be true only after explicit approval for this Drive write action.'),
            },
            required,
        },
        tags: ['write', 'google-drive', 'file', 'external_action'],
    }
}

function missing(name: string): ToolResult {
    return { success: false, error: `Missing required parameter: ${name}` }
}

function confirmationError(action: string): ToolResult {
    return { success: false, error: `confirmed_by_user must be true before ${action}.` }
}

function safeFilename(value: string): string {
    const cleaned = value.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim()
    return cleaned || 'drive-file'
}

function stripExtension(value: string): string {
    const parsed = path.posix.parse(value.replace(/\\/g, '/'))
    return parsed.name || value || 'drive-file'
}

function extensionForMime(mimeType: string): string {
    const map: Record<string, string> = {
        'text/plain': 'txt',
        'text/csv': 'csv',
        'text/html': 'html',
        'application/pdf': 'pdf',
        'application/json': 'json',
        'application/rtf': 'rtf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
        'application/zip': 'zip',
        'image/png': 'png',
        'image/jpeg': 'jpg',
    }
    return map[mimeType] ?? 'bin'
}

function mimeTypeFromPath(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    const map: Record<string, string> = {
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.csv': 'text/csv',
        '.json': 'application/json',
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.zip': 'application/zip',
    }
    return map[ext] ?? 'application/octet-stream'
}
