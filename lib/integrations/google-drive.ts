import path from 'path'

import { PRIVATE_STATE_DIR } from '@/lib/config'
import {
    GOOGLE_ACCESS_TOKEN_REFRESH_SKEW_MS,
    type GoogleOAuthConfigInput,
    type GoogleOAuthProviderConfig,
    type GoogleOAuthTokenRecord,
    clearGoogleOAuthToken,
    exchangeGoogleOAuthCode,
    getGoogleOAuthConfig,
    missingGoogleScopes,
    parseScopeList,
    readGoogleOAuthToken,
    refreshGoogleOAuthToken,
    responseErrorText,
    revokeGoogleOAuthToken,
    saveGoogleOAuthClientConfig,
    startGoogleOAuth,
    writeGoogleOAuthToken,
} from './google-oauth'
import {
    assignOptional,
    buildDriveQuery,
    clampInt,
    cleanIds,
    cleanRequired,
    defaultExportMimeType,
    type DriveFile,
    type DrivePermission,
    type DriveUser,
    GOOGLE_DRIVE_DEFAULT_EXPORT_MIME_TYPE,
    type GoogleDriveFileSummary,
    type GoogleDriveGoogleFileType,
    type GoogleDriveListFilesOptions,
    type GoogleDrivePermissionSummary,
    type GoogleDriveUser,
    googleFileMimeType,
    isProbablyBinary,
    isTextMime,
    summarizeFile,
    summarizePermission,
    summarizeUser,
} from './google-drive-formatting'

export type {
    GoogleDriveFileSummary,
    GoogleDriveListFilesOptions,
    GoogleDrivePermissionSummary,
    GoogleDriveUser,
} from './google-drive-formatting'

const GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'
const GOOGLE_DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const GOOGLE_DRIVE_TOKEN_PATH = path.join(PRIVATE_STATE_DIR, 'auth', 'google-drive.json')
const DEFAULT_ORIGIN = 'http://localhost:3000'
const MAX_FILE_MAX_RESULTS = 1000
const DEFAULT_FILE_MAX_RESULTS = 50
const MAX_SHARED_DRIVE_MAX_RESULTS = 100
const DEFAULT_READ_MAX_BYTES = 5 * 1024 * 1024
const MAX_READ_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_READ_MAX_CHARS = 100_000

const GOOGLE_DRIVE_FILE_FIELDS = [
    'id',
    'name',
    'mimeType',
    'description',
    'starred',
    'trashed',
    'explicitlyTrashed',
    'parents',
    'spaces',
    'driveId',
    'webViewLink',
    'webContentLink',
    'iconLink',
    'thumbnailLink',
    'createdTime',
    'modifiedTime',
    'viewedByMeTime',
    'shared',
    'ownedByMe',
    'size',
    'md5Checksum',
    'fileExtension',
    'fullFileExtension',
    'originalFilename',
    'exportLinks',
    'shortcutDetails(targetId,targetMimeType)',
    'capabilities(canAddChildren,canComment,canCopy,canDelete,canDownload,canEdit,canListChildren,canModifyContent,canMoveChildrenOutOfDrive,canMoveItemIntoTeamDrive,canMoveItemOutOfDrive,canMoveItemWithinDrive,canReadRevisions,canRemoveChildren,canRename,canShare,canTrash,canUntrash)',
    'owners(displayName,emailAddress,permissionId,me)',
    'lastModifyingUser(displayName,emailAddress,permissionId,me)',
].join(',')

export const GOOGLE_DRIVE_PROVIDER: GoogleOAuthProviderConfig = {
    provider: 'googleDrive',
    label: 'Google Workspace',
    redirectPath: '/api/integrations/google/oauth/callback',
    tokenPath: GOOGLE_DRIVE_TOKEN_PATH,
    clientIdEnvKeys: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_DRIVE_OAUTH_CLIENT_ID', 'DRIVE_OAUTH_CLIENT_ID'],
    clientSecretEnvKeys: ['GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_DRIVE_OAUTH_CLIENT_SECRET', 'DRIVE_OAUTH_CLIENT_SECRET'],
    redirectUriEnvKeys: [
        'GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI',
        'GOOGLE_DRIVE_OAUTH_REDIRECT_URI',
        'DRIVE_OAUTH_REDIRECT_URI',
    ],
    writeRedirectUriKey: 'GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI',
}

export const GOOGLE_DRIVE_SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/contacts',
    'https://www.googleapis.com/auth/contacts.other.readonly',
] as const

export interface GoogleDriveIntegrationStatus {
    id: 'googleDrive'
    name: string
    description: string
    configured: boolean
    connected: boolean
    accountEmail: string | null
    accountName: string | null
    scopes: string[]
    requestedScopes: string[]
    missingConfig: string[]
    redirectUri: string
    expiresAt: number | null
    needsReconnect: boolean
    storageQuota: GoogleDriveStorageQuota | null
    maxUploadSize: string | null
    appInstalled: boolean | null
    capabilities: string[]
    error?: string
}

export interface GoogleDriveStorageQuota {
    limit: string | null
    usage: string | null
    usageInDrive: string | null
    usageInDriveTrash: string | null
}

export interface GoogleDriveAboutSummary {
    user: GoogleDriveUser | null
    storageQuota: GoogleDriveStorageQuota | null
    maxUploadSize: string | null
    appInstalled: boolean | null
    importFormats: Record<string, string[]>
    exportFormats: Record<string, string[]>
}

export interface GoogleDriveReadFileOptions {
    fileId: string
    exportMimeType?: string
    maxBytes?: number
    maxChars?: number
}

export interface GoogleDriveUploadBytesInput {
    name: string
    mimeType: string
    bytes: Buffer
    parents?: string[]
    description?: string
}

export interface GoogleDriveUpdateBytesInput {
    fileId: string
    name?: string
    mimeType?: string
    bytes: Buffer
    description?: string
}

export interface GoogleDriveGoogleFileInput {
    name: string
    type: GoogleDriveGoogleFileType
    parents?: string[]
    description?: string
}

export interface GoogleDriveMetadataPatch {
    name?: string
    description?: string
    starred?: boolean
    trashed?: boolean
    mimeType?: string
}

export interface GoogleDrivePermissionInput {
    fileId: string
    type: 'user' | 'group' | 'domain' | 'anyone'
    role: 'reader' | 'commenter' | 'writer' | 'fileOrganizer' | 'organizer' | 'owner'
    emailAddress?: string
    domain?: string
    allowFileDiscovery?: boolean
    expirationTime?: string
    sendNotificationEmail?: boolean
    emailMessage?: string
    transferOwnership?: boolean
}

export interface GoogleDriveReadResult {
    file: GoogleDriveFileSummary
    mimeType: string
    bytes: number
    text: string | null
    truncated: boolean
    exported: boolean
    binary: boolean
}

export interface GoogleDriveBytesResult {
    file: GoogleDriveFileSummary
    mimeType: string
    bytes: Buffer
    exported: boolean
}

interface DriveAboutResponse {
    user?: DriveUser
    storageQuota?: {
        limit?: string
        usage?: string
        usageInDrive?: string
        usageInDriveTrash?: string
    }
    maxUploadSize?: string
    appInstalled?: boolean
    importFormats?: Record<string, string[]>
    exportFormats?: Record<string, string[]>
}

interface DriveListResponse {
    nextPageToken?: string
    incompleteSearch?: boolean
    files?: DriveFile[]
}

interface DriveDrivesResponse {
    nextPageToken?: string
    drives?: Array<{ id?: string; name?: string; kind?: string; createdTime?: string; hidden?: boolean }>
}

interface DrivePermissionsResponse {
    permissions?: DrivePermission[]
    nextPageToken?: string
}

export async function getGoogleDriveIntegrationStatus(origin: string, refresh = true): Promise<GoogleDriveIntegrationStatus> {
    const config = getGoogleOAuthConfig(origin, GOOGLE_DRIVE_PROVIDER)
    let token = readDriveToken()
    let error: string | undefined
    let refreshFailed = false

    const shouldRefresh = token ? token.expiresAt <= Date.now() + GOOGLE_ACCESS_TOKEN_REFRESH_SKEW_MS : false
    if (refresh && shouldRefresh && token?.refreshToken && config.clientId && config.clientSecret) {
        try {
            token = await refreshGoogleOAuthToken(token, config, GOOGLE_DRIVE_TOKEN_PATH)
        } catch (err) {
            refreshFailed = true
            error = err instanceof Error ? err.message : 'Failed to refresh Google Workspace token'
        }
    }

    const scopes = token?.scope ?? []
    const missingScopes = missingGoogleScopes(scopes, GOOGLE_DRIVE_SCOPES)
    const expired = token ? token.expiresAt <= Date.now() + GOOGLE_ACCESS_TOKEN_REFRESH_SKEW_MS : false
    let about: GoogleDriveAboutSummary | null = null

    if (token && missingScopes.length === 0 && !expired) {
        try {
            about = await googleDriveGetAbout()
        } catch (err) {
            error = err instanceof Error ? err.message : 'Could not read Google Workspace profile.'
        }
    }

    return {
        id: 'googleDrive',
        name: 'Google Workspace',
        description: 'Read, search, export, download, upload, organize, and share Drive files, create/edit Docs, Sheets, and Slides, and manage Google Contacts when authorized.',
        configured: config.missing.length === 0,
        connected: Boolean(token?.accessToken || token?.refreshToken),
        accountEmail: token?.accountEmail || about?.user?.emailAddress || null,
        accountName: about?.user?.displayName ?? null,
        scopes,
        requestedScopes: [...GOOGLE_DRIVE_SCOPES],
        missingConfig: config.missing,
        redirectUri: config.redirectUri,
        expiresAt: token?.expiresAt ?? null,
        needsReconnect: Boolean(!token || refreshFailed || missingScopes.length > 0 || (expired && !token.refreshToken)),
        storageQuota: about?.storageQuota ?? null,
        maxUploadSize: about?.maxUploadSize ?? null,
        appInstalled: about?.appInstalled ?? null,
        capabilities: [
            'about',
            'list_files',
            'search_files',
            'get_file',
            'read_text_or_export',
            'download_binary',
            'export_workspace_file',
            'upload_file',
            'update_file_content',
            'create_folder',
            'create_google_file',
            'copy_file',
            'rename_or_update_metadata',
            'move_file',
            'trash_or_untrash_file',
            'permanent_delete_file',
            'list_permissions',
            'share_file',
            'update_permission',
            'delete_permission',
            'list_shared_drives',
            'docs_api',
            'sheets_api',
            'slides_api',
            'contacts_api',
            'other_contacts_read',
        ],
        error,
    }
}

export async function saveGoogleDriveOAuthConfig(origin: string, input: GoogleOAuthConfigInput): Promise<GoogleDriveIntegrationStatus> {
    saveGoogleOAuthClientConfig(origin, input, GOOGLE_DRIVE_PROVIDER)
    return getGoogleDriveIntegrationStatus(origin, false)
}

export function startGoogleDriveOAuth(origin: string) {
    return startGoogleOAuth({
        origin,
        provider: GOOGLE_DRIVE_PROVIDER,
        scopes: GOOGLE_DRIVE_SCOPES,
    })
}

export async function completeGoogleDriveOAuth(args: {
    origin: string
    state: string
    code: string
}): Promise<{ accountEmail: string | null }> {
    const config = getGoogleOAuthConfig(args.origin, GOOGLE_DRIVE_PROVIDER)
    if (!config.clientId || !config.clientSecret) {
        throw new Error(`Missing Google OAuth config: ${config.missing.join(', ')}`)
    }

    const token = await exchangeGoogleOAuthCode({
        origin: args.origin,
        provider: GOOGLE_DRIVE_PROVIDER,
        state: args.state,
        code: args.code,
    })
    const existing = readDriveToken()
    const refreshToken = token.refresh_token || existing?.refreshToken
    if (!token.access_token) throw new Error('Google did not return an access token.')
    if (!refreshToken) throw new Error('Google did not return a refresh token. Reconnect and approve offline access.')

    const grantedScopes = parseScopeList(token.scope)
    const missingScopes = missingGoogleScopes(grantedScopes, GOOGLE_DRIVE_SCOPES)
    if (missingScopes.length > 0) {
        throw new Error(`Google Workspace consent is missing required scopes: ${missingScopes.join(', ')}`)
    }

    const profile = await fetchDriveProfile(token.access_token)
    const now = Date.now()
    writeGoogleOAuthToken(GOOGLE_DRIVE_TOKEN_PATH, {
        version: 1,
        provider: GOOGLE_DRIVE_PROVIDER.provider,
        clientId: config.clientId,
        accountEmail: profile.accountEmail ?? undefined,
        accessToken: token.access_token,
        refreshToken,
        tokenType: token.token_type,
        scope: grantedScopes,
        scopesRequested: [...GOOGLE_DRIVE_SCOPES],
        expiresAt: now + Math.max(0, token.expires_in ?? 3600) * 1000,
        obtainedAt: existing?.obtainedAt ?? now,
        updatedAt: now,
    })

    return { accountEmail: profile.accountEmail }
}

export async function disconnectGoogleDrive(): Promise<GoogleDriveIntegrationStatus> {
    const token = readDriveToken()
    await revokeGoogleOAuthToken(token)
    clearGoogleOAuthToken(GOOGLE_DRIVE_TOKEN_PATH)
    return getGoogleDriveIntegrationStatus(DEFAULT_ORIGIN, false)
}

export async function googleDriveGetAbout(): Promise<GoogleDriveAboutSummary> {
    const about = await driveApi<DriveAboutResponse>(
        '/about?fields=user,storageQuota,maxUploadSize,appInstalled,importFormats,exportFormats'
    )
    return {
        user: summarizeUser(about.user),
        storageQuota: about.storageQuota ? {
            limit: about.storageQuota.limit ?? null,
            usage: about.storageQuota.usage ?? null,
            usageInDrive: about.storageQuota.usageInDrive ?? null,
            usageInDriveTrash: about.storageQuota.usageInDriveTrash ?? null,
        } : null,
        maxUploadSize: about.maxUploadSize ?? null,
        appInstalled: about.appInstalled ?? null,
        importFormats: about.importFormats ?? {},
        exportFormats: about.exportFormats ?? {},
    }
}

export async function googleDriveListSharedDrives(options: { maxResults?: number; pageToken?: string; query?: string } = {}) {
    const maxResults = clampInt(options.maxResults ?? MAX_SHARED_DRIVE_MAX_RESULTS, 1, MAX_SHARED_DRIVE_MAX_RESULTS)
    const params = new URLSearchParams({
        pageSize: String(maxResults),
        fields: 'nextPageToken,drives(id,name,kind,createdTime,hidden)',
    })
    if (options.pageToken) params.set('pageToken', options.pageToken.trim())
    if (options.query) params.set('q', options.query.trim())
    const result = await driveApi<DriveDrivesResponse>(`/drives?${params.toString()}`)
    return {
        nextPageToken: result.nextPageToken ?? null,
        drives: (result.drives ?? []).map(drive => ({
            id: drive.id ?? '',
            name: drive.name ?? '',
            kind: drive.kind ?? '',
            createdTime: drive.createdTime ?? null,
            hidden: drive.hidden === true,
        })),
    }
}

export async function googleDriveListFiles(options: GoogleDriveListFilesOptions = {}): Promise<{
    files: GoogleDriveFileSummary[]
    nextPageToken: string | null
    incompleteSearch: boolean
}> {
    const maxResults = clampInt(options.maxResults ?? DEFAULT_FILE_MAX_RESULTS, 1, MAX_FILE_MAX_RESULTS)
    const params = new URLSearchParams({
        pageSize: String(Math.min(maxResults, 1000)),
        fields: `nextPageToken,incompleteSearch,files(${GOOGLE_DRIVE_FILE_FIELDS})`,
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
    })
    const query = buildDriveQuery(options)
    if (query) params.set('q', query)
    if (options.spaces) params.set('spaces', options.spaces.trim())
    if (options.corpora) params.set('corpora', options.corpora)
    if (options.driveId) {
        params.set('driveId', options.driveId.trim())
        if (!options.corpora) params.set('corpora', 'drive')
    }
    if (options.orderBy) params.set('orderBy', options.orderBy.trim())
    if (options.pageToken) params.set('pageToken', options.pageToken.trim())

    const result = await driveApi<DriveListResponse>(`/files?${params.toString()}`)
    return {
        files: (result.files ?? []).map(summarizeFile),
        nextPageToken: result.nextPageToken ?? null,
        incompleteSearch: result.incompleteSearch === true,
    }
}

export async function googleDriveGetFile(fileId: string): Promise<GoogleDriveFileSummary> {
    const file = await driveApi<DriveFile>(
        `/files/${encodeURIComponent(cleanRequired(fileId, 'file_id'))}?${fileQueryParams().toString()}`
    )
    return summarizeFile(file)
}

export async function googleDriveReadFile(options: GoogleDriveReadFileOptions): Promise<GoogleDriveReadResult> {
    const maxBytes = clampInt(options.maxBytes ?? DEFAULT_READ_MAX_BYTES, 1, MAX_READ_MAX_BYTES)
    const maxChars = clampInt(options.maxChars ?? DEFAULT_READ_MAX_CHARS, 1_000, 500_000)
    const file = await googleDriveGetFile(options.fileId)
    if (file.isFolder) throw new Error('Google Drive folder content cannot be read as a file.')

    const bytesResult = file.isGoogleWorkspaceFile
        ? await googleDriveExportFile(options.fileId, options.exportMimeType || defaultExportMimeType(file.mimeType), maxBytes)
        : await googleDriveDownloadFile(options.fileId, maxBytes)
    const binary = isProbablyBinary(bytesResult.bytes)
    const textLike = isTextMime(bytesResult.mimeType) || !binary
    if (!textLike) {
        return {
            file,
            mimeType: bytesResult.mimeType,
            bytes: bytesResult.bytes.byteLength,
            text: null,
            truncated: false,
            exported: bytesResult.exported,
            binary: true,
        }
    }

    const decoded = bytesResult.bytes.toString('utf-8')
    const truncated = decoded.length > maxChars
    return {
        file,
        mimeType: bytesResult.mimeType,
        bytes: bytesResult.bytes.byteLength,
        text: truncated ? decoded.slice(0, maxChars) : decoded,
        truncated,
        exported: bytesResult.exported,
        binary: false,
    }
}

export async function googleDriveDownloadFile(fileId: string, maxBytes = DEFAULT_READ_MAX_BYTES): Promise<GoogleDriveBytesResult> {
    const file = await googleDriveGetFile(fileId)
    if (file.isGoogleWorkspaceFile) throw new Error('Google Workspace files must be exported, not downloaded. Use GoogleDriveExportFile or GoogleDriveReadFile.')
    if (file.isFolder) throw new Error('Folders cannot be downloaded as file bytes.')
    const params = new URLSearchParams({
        alt: 'media',
        supportsAllDrives: 'true',
    })
    const bytes = await driveBytes(`/files/${encodeURIComponent(file.id)}?${params.toString()}`, clampInt(maxBytes, 1, 100 * 1024 * 1024))
    return { file, mimeType: file.mimeType, bytes, exported: false }
}

export async function googleDriveExportFile(fileId: string, mimeType = GOOGLE_DRIVE_DEFAULT_EXPORT_MIME_TYPE, maxBytes = DEFAULT_READ_MAX_BYTES): Promise<GoogleDriveBytesResult> {
    const file = await googleDriveGetFile(fileId)
    if (!file.isGoogleWorkspaceFile) throw new Error('Only Google Workspace files can be exported. Use GoogleDriveDownloadFile for binary files.')
    if (file.isFolder) throw new Error('Folders cannot be exported.')
    const cleanMimeType = cleanRequired(mimeType, 'mime_type')
    const params = new URLSearchParams({ mimeType: cleanMimeType })
    const bytes = await driveBytes(`/files/${encodeURIComponent(file.id)}/export?${params.toString()}`, clampInt(maxBytes, 1, 50 * 1024 * 1024))
    return { file, mimeType: cleanMimeType, bytes, exported: true }
}

export async function googleDriveCreateFolder(input: { name: string; parentId?: string; description?: string }): Promise<GoogleDriveFileSummary> {
    const metadata: Record<string, unknown> = {
        name: cleanRequired(input.name, 'name'),
        mimeType: 'application/vnd.google-apps.folder',
    }
    if (input.parentId) metadata.parents = [cleanRequired(input.parentId, 'parent_id')]
    assignOptional(metadata, 'description', input.description)
    const file = await driveApi<DriveFile>(`/files?${metadataQueryParams().toString()}`, {
        method: 'POST',
        body: JSON.stringify(metadata),
    })
    return summarizeFile(file)
}

export async function googleDriveCreateGoogleFile(input: GoogleDriveGoogleFileInput): Promise<GoogleDriveFileSummary> {
    const metadata: Record<string, unknown> = {
        name: cleanRequired(input.name, 'name'),
        mimeType: googleFileMimeType(input.type),
    }
    const parents = cleanIds(input.parents ?? [], 'parents')
    if (parents.length > 0) metadata.parents = parents
    assignOptional(metadata, 'description', input.description)
    const file = await driveApi<DriveFile>(`/files?${metadataQueryParams().toString()}`, {
        method: 'POST',
        body: JSON.stringify(metadata),
    })
    return summarizeFile(file)
}

export async function googleDriveUploadBytes(input: GoogleDriveUploadBytesInput): Promise<GoogleDriveFileSummary> {
    const metadata: Record<string, unknown> = {
        name: cleanRequired(input.name, 'name'),
        mimeType: cleanRequired(input.mimeType, 'mime_type'),
    }
    const parents = cleanIds(input.parents ?? [], 'parents')
    if (parents.length > 0) metadata.parents = parents
    assignOptional(metadata, 'description', input.description)
    const file = await driveMultipart<DriveFile>(
        `/files?${metadataQueryParams().toString()}`,
        'POST',
        metadata,
        input.bytes,
        input.mimeType
    )
    return summarizeFile(file)
}

export async function googleDriveUpdateFileContent(input: GoogleDriveUpdateBytesInput): Promise<GoogleDriveFileSummary> {
    const metadata: Record<string, unknown> = {}
    assignOptional(metadata, 'name', input.name)
    assignOptional(metadata, 'description', input.description)
    if (input.mimeType) metadata.mimeType = cleanRequired(input.mimeType, 'mime_type')
    const file = await driveMultipart<DriveFile>(
        `/files/${encodeURIComponent(cleanRequired(input.fileId, 'file_id'))}?${metadataQueryParams().toString()}`,
        'PATCH',
        metadata,
        input.bytes,
        input.mimeType || 'application/octet-stream'
    )
    return summarizeFile(file)
}

export async function googleDriveUpdateMetadata(fileId: string, patch: GoogleDriveMetadataPatch): Promise<GoogleDriveFileSummary> {
    const metadata: Record<string, unknown> = {}
    assignOptional(metadata, 'name', patch.name)
    assignOptional(metadata, 'description', patch.description)
    assignOptional(metadata, 'mimeType', patch.mimeType)
    if (typeof patch.starred === 'boolean') metadata.starred = patch.starred
    if (typeof patch.trashed === 'boolean') metadata.trashed = patch.trashed
    if (Object.keys(metadata).length === 0) throw new Error('Provide at least one metadata field to update.')
    const file = await driveApi<DriveFile>(
        `/files/${encodeURIComponent(cleanRequired(fileId, 'file_id'))}?${metadataQueryParams().toString()}`,
        {
            method: 'PATCH',
            body: JSON.stringify(metadata),
        }
    )
    return summarizeFile(file)
}

export async function googleDriveMoveFile(fileId: string, destinationFolderId: string, removeParentIds?: string[]): Promise<GoogleDriveFileSummary> {
    const cleanFileId = cleanRequired(fileId, 'file_id')
    const destination = cleanRequired(destinationFolderId, 'destination_folder_id')
    const removeParents = removeParentIds?.length ? cleanIds(removeParentIds, 'remove_parent_ids') : (await googleDriveGetFile(cleanFileId)).parents
    const params = metadataQueryParams()
    params.set('addParents', destination)
    if (removeParents.length > 0) params.set('removeParents', removeParents.join(','))
    const file = await driveApi<DriveFile>(
        `/files/${encodeURIComponent(cleanFileId)}?${params.toString()}`,
        { method: 'PATCH', body: JSON.stringify({}) }
    )
    return summarizeFile(file)
}

export async function googleDriveCopyFile(fileId: string, input: { name?: string; parentIds?: string[]; description?: string } = {}): Promise<GoogleDriveFileSummary> {
    const metadata: Record<string, unknown> = {}
    assignOptional(metadata, 'name', input.name)
    assignOptional(metadata, 'description', input.description)
    const parents = cleanIds(input.parentIds ?? [], 'parent_ids')
    if (parents.length > 0) metadata.parents = parents
    const file = await driveApi<DriveFile>(
        `/files/${encodeURIComponent(cleanRequired(fileId, 'file_id'))}/copy?${metadataQueryParams().toString()}`,
        {
            method: 'POST',
            body: JSON.stringify(metadata),
        }
    )
    return summarizeFile(file)
}

export async function googleDriveTrashFile(fileId: string): Promise<GoogleDriveFileSummary> {
    return googleDriveUpdateMetadata(fileId, { trashed: true })
}

export async function googleDriveUntrashFile(fileId: string): Promise<GoogleDriveFileSummary> {
    return googleDriveUpdateMetadata(fileId, { trashed: false })
}

export async function googleDriveDeleteFile(fileId: string): Promise<{ fileId: string; deleted: true }> {
    const cleanFileId = cleanRequired(fileId, 'file_id')
    const params = new URLSearchParams({ supportsAllDrives: 'true' })
    await driveApi<unknown>(`/files/${encodeURIComponent(cleanFileId)}?${params.toString()}`, { method: 'DELETE' })
    return { fileId: cleanFileId, deleted: true }
}

export async function googleDriveListPermissions(fileId: string): Promise<{ permissions: GoogleDrivePermissionSummary[] }> {
    const params = new URLSearchParams({
        supportsAllDrives: 'true',
        fields: 'permissions(id,type,role,emailAddress,domain,displayName,deleted,allowFileDiscovery,expirationTime,pendingOwner),nextPageToken',
    })
    const permissions: GoogleDrivePermissionSummary[] = []
    let pageToken: string | undefined
    do {
        if (pageToken) params.set('pageToken', pageToken)
        const result = await driveApi<DrivePermissionsResponse>(
            `/files/${encodeURIComponent(cleanRequired(fileId, 'file_id'))}/permissions?${params.toString()}`
        )
        permissions.push(...(result.permissions ?? []).map(summarizePermission))
        pageToken = result.nextPageToken
    } while (pageToken)
    return { permissions }
}

export async function googleDriveCreatePermission(input: GoogleDrivePermissionInput): Promise<GoogleDrivePermissionSummary> {
    const permission: Record<string, unknown> = {
        type: input.type,
        role: input.role,
    }
    assignOptional(permission, 'emailAddress', input.emailAddress)
    assignOptional(permission, 'domain', input.domain)
    assignOptional(permission, 'expirationTime', input.expirationTime)
    if (typeof input.allowFileDiscovery === 'boolean') permission.allowFileDiscovery = input.allowFileDiscovery
    const params = new URLSearchParams({
        supportsAllDrives: 'true',
        fields: 'id,type,role,emailAddress,domain,displayName,deleted,allowFileDiscovery,expirationTime,pendingOwner',
    })
    if (typeof input.sendNotificationEmail === 'boolean') params.set('sendNotificationEmail', String(input.sendNotificationEmail))
    if (input.emailMessage) params.set('emailMessage', input.emailMessage.trim())
    if (input.transferOwnership) params.set('transferOwnership', 'true')
    const result = await driveApi<DrivePermission>(
        `/files/${encodeURIComponent(cleanRequired(input.fileId, 'file_id'))}/permissions?${params.toString()}`,
        {
            method: 'POST',
            body: JSON.stringify(permission),
        }
    )
    return summarizePermission(result)
}

export async function googleDriveUpdatePermission(
    fileId: string,
    permissionId: string,
    input: { role?: GoogleDrivePermissionInput['role']; expirationTime?: string | null; transferOwnership?: boolean }
): Promise<GoogleDrivePermissionSummary> {
    const patch: Record<string, unknown> = {}
    assignOptional(patch, 'role', input.role)
    if (input.expirationTime !== undefined) patch.expirationTime = input.expirationTime || null
    if (Object.keys(patch).length === 0) throw new Error('Provide at least one permission field to update.')
    const params = new URLSearchParams({
        supportsAllDrives: 'true',
        fields: 'id,type,role,emailAddress,domain,displayName,deleted,allowFileDiscovery,expirationTime,pendingOwner',
    })
    if (input.transferOwnership) params.set('transferOwnership', 'true')
    const result = await driveApi<DrivePermission>(
        `/files/${encodeURIComponent(cleanRequired(fileId, 'file_id'))}/permissions/${encodeURIComponent(cleanRequired(permissionId, 'permission_id'))}?${params.toString()}`,
        {
            method: 'PATCH',
            body: JSON.stringify(patch),
        }
    )
    return summarizePermission(result)
}

export async function googleDriveDeletePermission(fileId: string, permissionId: string): Promise<{ fileId: string; permissionId: string; deleted: true }> {
    const cleanFileId = cleanRequired(fileId, 'file_id')
    const cleanPermissionId = cleanRequired(permissionId, 'permission_id')
    const params = new URLSearchParams({ supportsAllDrives: 'true' })
    await driveApi<unknown>(
        `/files/${encodeURIComponent(cleanFileId)}/permissions/${encodeURIComponent(cleanPermissionId)}?${params.toString()}`,
        { method: 'DELETE' }
    )
    return { fileId: cleanFileId, permissionId: cleanPermissionId, deleted: true }
}

async function fetchDriveProfile(accessToken: string): Promise<{ accountEmail: string | null }> {
    const response = await fetch(`${GOOGLE_DRIVE_API_BASE}/about?fields=user`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
        },
    })
    if (!response.ok) {
        throw new Error(`Could not read Google Drive profile (${response.status}): ${await responseErrorText(response)}`)
    }
    const result = await response.json() as DriveAboutResponse
    return { accountEmail: result.user?.emailAddress ?? null }
}

async function driveApi<T>(pathAndQuery: string, init: RequestInit = {}, retry = true): Promise<T> {
    const token = await getValidDriveToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token.accessToken}`)
    headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

    const response = await fetch(`${GOOGLE_DRIVE_API_BASE}${pathAndQuery}`, {
        ...init,
        headers,
    })

    if (response.status === 401 && retry && token.refreshToken) {
        await refreshGoogleOAuthToken(token, getGoogleOAuthConfig(DEFAULT_ORIGIN, GOOGLE_DRIVE_PROVIDER), GOOGLE_DRIVE_TOKEN_PATH)
        return driveApi<T>(pathAndQuery, init, false)
    }

    if (!response.ok) {
        throw new Error(`Google Drive API failed (${response.status}): ${await responseErrorText(response)}`)
    }

    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
}

export async function googleWorkspaceJson<T>(
    baseUrl: string,
    pathAndQuery: string,
    init: RequestInit = {},
    retry = true
): Promise<T> {
    const token = await getValidDriveToken()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token.accessToken}`)
    headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

    const response = await fetch(`${baseUrl}${pathAndQuery}`, {
        ...init,
        headers,
    })

    if (response.status === 401 && retry && token.refreshToken) {
        await refreshGoogleOAuthToken(token, getGoogleOAuthConfig(DEFAULT_ORIGIN, GOOGLE_DRIVE_PROVIDER), GOOGLE_DRIVE_TOKEN_PATH)
        return googleWorkspaceJson<T>(baseUrl, pathAndQuery, init, false)
    }

    if (!response.ok) {
        throw new Error(`Google Workspace API failed (${response.status}): ${await responseErrorText(response)}`)
    }

    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
}

async function driveBytes(pathAndQuery: string, maxBytes: number, retry = true): Promise<Buffer> {
    const token = await getValidDriveToken()
    const response = await fetch(`${GOOGLE_DRIVE_API_BASE}${pathAndQuery}`, {
        headers: {
            Authorization: `Bearer ${token.accessToken}`,
            Accept: '*/*',
        },
    })

    if (response.status === 401 && retry && token.refreshToken) {
        await refreshGoogleOAuthToken(token, getGoogleOAuthConfig(DEFAULT_ORIGIN, GOOGLE_DRIVE_PROVIDER), GOOGLE_DRIVE_TOKEN_PATH)
        return driveBytes(pathAndQuery, maxBytes, false)
    }

    if (!response.ok) {
        throw new Error(`Google Drive download failed (${response.status}): ${await responseErrorText(response)}`)
    }
    const sizeHeader = response.headers.get('content-length')
    const declaredSize = sizeHeader ? Number(sizeHeader) : 0
    if (declaredSize > maxBytes) throw new Error(`Google Drive file is ${declaredSize} bytes, above max_bytes ${maxBytes}.`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error(`Google Drive file is ${bytes.byteLength} bytes, above max_bytes ${maxBytes}.`)
    return bytes
}

async function driveMultipart<T>(
    pathAndQuery: string,
    method: 'POST' | 'PATCH',
    metadata: Record<string, unknown>,
    bytes: Buffer,
    mimeType: string,
    retry = true
): Promise<T> {
    const token = await getValidDriveToken()
    const boundary = `orchestrator_${Math.random().toString(16).slice(2)}`
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const response = await fetch(`${GOOGLE_DRIVE_UPLOAD_BASE}${pathAndQuery}`, {
        method,
        headers: {
            Authorization: `Bearer ${token.accessToken}`,
            Accept: 'application/json',
            'Content-Type': `multipart/related; boundary=${boundary}`,
            'Content-Length': String(body.byteLength),
        },
        body,
    })

    if (response.status === 401 && retry && token.refreshToken) {
        await refreshGoogleOAuthToken(token, getGoogleOAuthConfig(DEFAULT_ORIGIN, GOOGLE_DRIVE_PROVIDER), GOOGLE_DRIVE_TOKEN_PATH)
        return driveMultipart<T>(pathAndQuery, method, metadata, bytes, mimeType, false)
    }

    if (!response.ok) {
        throw new Error(`Google Drive upload failed (${response.status}): ${await responseErrorText(response)}`)
    }

    const text = await response.text()
    return (text ? JSON.parse(text) : undefined) as T
}

async function getValidDriveToken(): Promise<GoogleOAuthTokenRecord> {
    const token = readDriveToken()
    if (!token) throw new Error('Google Workspace is not connected. Connect it from Settings > Auth.')
    if (token.expiresAt > Date.now() + GOOGLE_ACCESS_TOKEN_REFRESH_SKEW_MS) return token
    if (!token.refreshToken) throw new Error('Google Workspace session expired. Reconnect Google Workspace from Settings > Auth.')
    return refreshGoogleOAuthToken(token, getGoogleOAuthConfig(DEFAULT_ORIGIN, GOOGLE_DRIVE_PROVIDER), GOOGLE_DRIVE_TOKEN_PATH)
}

function readDriveToken(): GoogleOAuthTokenRecord | null {
    return readGoogleOAuthToken(GOOGLE_DRIVE_TOKEN_PATH, GOOGLE_DRIVE_PROVIDER.provider)
}

function fileQueryParams(): URLSearchParams {
    return new URLSearchParams({
        fields: GOOGLE_DRIVE_FILE_FIELDS,
        supportsAllDrives: 'true',
    })
}

function metadataQueryParams(): URLSearchParams {
    return new URLSearchParams({
        fields: GOOGLE_DRIVE_FILE_FIELDS,
        supportsAllDrives: 'true',
    })
}
