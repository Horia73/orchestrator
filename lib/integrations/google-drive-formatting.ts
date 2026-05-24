export interface GoogleDriveListFilesOptions {
    query?: string
    textQuery?: string
    nameContains?: string
    parentId?: string
    mimeTypes?: string[]
    spaces?: string
    corpora?: 'user' | 'drive' | 'allDrives' | 'domain'
    driveId?: string
    includeTrashed?: boolean
    starred?: boolean
    sharedWithMe?: boolean
    ownedByMe?: boolean
    modifiedAfter?: string
    modifiedBefore?: string
    createdAfter?: string
    createdBefore?: string
    orderBy?: string
    pageToken?: string
    maxResults?: number
}

export type GoogleDriveGoogleFileType = 'document' | 'spreadsheet' | 'presentation' | 'drawing' | 'form'

export interface GoogleDriveFileSummary {
    id: string
    name: string
    mimeType: string
    description: string
    parents: string[]
    spaces: string[]
    driveId: string | null
    webViewLink: string
    webContentLink: string
    iconLink: string
    thumbnailLink: string
    createdTime: string | null
    modifiedTime: string | null
    viewedByMeTime: string | null
    shared: boolean
    ownedByMe: boolean
    starred: boolean
    trashed: boolean
    explicitlyTrashed: boolean
    size: number | null
    md5Checksum: string | null
    fileExtension: string | null
    fullFileExtension: string | null
    originalFilename: string | null
    owners: GoogleDriveUser[]
    lastModifyingUser: GoogleDriveUser | null
    capabilities: Record<string, boolean>
    exportLinks: Record<string, string>
    shortcut: { targetId: string; targetMimeType: string } | null
    isFolder: boolean
    isGoogleWorkspaceFile: boolean
}

export interface GoogleDrivePermissionSummary {
    id: string
    type: string
    role: string
    emailAddress: string | null
    domain: string | null
    displayName: string | null
    deleted: boolean
    allowFileDiscovery: boolean | null
    expirationTime: string | null
    pendingOwner: boolean
}

export interface GoogleDriveUser {
    displayName: string
    emailAddress: string
    permissionId: string
    me: boolean
}

export interface DriveFile {
    id?: string
    name?: string
    mimeType?: string
    description?: string
    starred?: boolean
    trashed?: boolean
    explicitlyTrashed?: boolean
    parents?: string[]
    spaces?: string[]
    driveId?: string
    webViewLink?: string
    webContentLink?: string
    iconLink?: string
    thumbnailLink?: string
    createdTime?: string
    modifiedTime?: string
    viewedByMeTime?: string
    shared?: boolean
    ownedByMe?: boolean
    size?: string
    md5Checksum?: string
    fileExtension?: string
    fullFileExtension?: string
    originalFilename?: string
    owners?: DriveUser[]
    lastModifyingUser?: DriveUser
    capabilities?: Record<string, boolean>
    exportLinks?: Record<string, string>
    shortcutDetails?: {
        targetId?: string
        targetMimeType?: string
    }
}

export interface DriveUser {
    displayName?: string
    emailAddress?: string
    permissionId?: string
    me?: boolean
}

export interface DrivePermission {
    id?: string
    type?: string
    role?: string
    emailAddress?: string
    domain?: string
    displayName?: string
    deleted?: boolean
    allowFileDiscovery?: boolean
    expirationTime?: string
    pendingOwner?: boolean
}

export const GOOGLE_DRIVE_DEFAULT_EXPORT_MIME_TYPE = 'text/plain'

export function buildDriveQuery(options: GoogleDriveListFilesOptions): string {
    const parts: string[] = []
    if (options.query) parts.push(`(${options.query.trim()})`)
    if (!options.includeTrashed) parts.push('trashed = false')
    if (options.textQuery) {
        const value = driveQueryString(options.textQuery)
        parts.push(`(name contains '${value}' or fullText contains '${value}')`)
    }
    if (options.nameContains) parts.push(`name contains '${driveQueryString(options.nameContains)}'`)
    if (options.parentId) parts.push(`'${driveQueryString(options.parentId)}' in parents`)
    const mimeTypes = (options.mimeTypes ?? []).map(item => item.trim()).filter(Boolean)
    if (mimeTypes.length > 0) {
        parts.push(`(${mimeTypes.map(mimeType => `mimeType = '${driveQueryString(mimeType)}'`).join(' or ')})`)
    }
    if (typeof options.starred === 'boolean') parts.push(`starred = ${options.starred ? 'true' : 'false'}`)
    if (options.sharedWithMe) parts.push('sharedWithMe')
    if (typeof options.ownedByMe === 'boolean') parts.push(options.ownedByMe ? `'me' in owners` : `not 'me' in owners`)
    if (options.modifiedAfter) parts.push(`modifiedTime > '${normalizeRfc3339(options.modifiedAfter, 'modified_after')}'`)
    if (options.modifiedBefore) parts.push(`modifiedTime < '${normalizeRfc3339(options.modifiedBefore, 'modified_before')}'`)
    if (options.createdAfter) parts.push(`createdTime > '${normalizeRfc3339(options.createdAfter, 'created_after')}'`)
    if (options.createdBefore) parts.push(`createdTime < '${normalizeRfc3339(options.createdBefore, 'created_before')}'`)
    return parts.join(' and ')
}

export function summarizeFile(file: DriveFile): GoogleDriveFileSummary {
    const mimeType = file.mimeType ?? ''
    return {
        id: file.id ?? '',
        name: file.name ?? file.id ?? '',
        mimeType,
        description: file.description ?? '',
        parents: file.parents ?? [],
        spaces: file.spaces ?? [],
        driveId: file.driveId ?? null,
        webViewLink: file.webViewLink ?? '',
        webContentLink: file.webContentLink ?? '',
        iconLink: file.iconLink ?? '',
        thumbnailLink: file.thumbnailLink ?? '',
        createdTime: file.createdTime ?? null,
        modifiedTime: file.modifiedTime ?? null,
        viewedByMeTime: file.viewedByMeTime ?? null,
        shared: file.shared === true,
        ownedByMe: file.ownedByMe === true,
        starred: file.starred === true,
        trashed: file.trashed === true,
        explicitlyTrashed: file.explicitlyTrashed === true,
        size: file.size ? Number(file.size) : null,
        md5Checksum: file.md5Checksum ?? null,
        fileExtension: file.fileExtension ?? null,
        fullFileExtension: file.fullFileExtension ?? null,
        originalFilename: file.originalFilename ?? null,
        owners: (file.owners ?? []).map(summarizeUser).filter((user): user is GoogleDriveUser => user !== null),
        lastModifyingUser: summarizeUser(file.lastModifyingUser),
        capabilities: file.capabilities ?? {},
        exportLinks: file.exportLinks ?? {},
        shortcut: file.shortcutDetails ? {
            targetId: file.shortcutDetails.targetId ?? '',
            targetMimeType: file.shortcutDetails.targetMimeType ?? '',
        } : null,
        isFolder: mimeType === 'application/vnd.google-apps.folder',
        isGoogleWorkspaceFile: mimeType.startsWith('application/vnd.google-apps.'),
    }
}

export function summarizeUser(user: DriveUser | undefined): GoogleDriveUser | null {
    if (!user?.displayName && !user?.emailAddress && !user?.permissionId) return null
    return {
        displayName: user.displayName ?? '',
        emailAddress: user.emailAddress ?? '',
        permissionId: user.permissionId ?? '',
        me: user.me === true,
    }
}

export function summarizePermission(permission: DrivePermission): GoogleDrivePermissionSummary {
    return {
        id: permission.id ?? '',
        type: permission.type ?? '',
        role: permission.role ?? '',
        emailAddress: permission.emailAddress ?? null,
        domain: permission.domain ?? null,
        displayName: permission.displayName ?? null,
        deleted: permission.deleted === true,
        allowFileDiscovery: typeof permission.allowFileDiscovery === 'boolean' ? permission.allowFileDiscovery : null,
        expirationTime: permission.expirationTime ?? null,
        pendingOwner: permission.pendingOwner === true,
    }
}

export function defaultExportMimeType(mimeType: string): string {
    if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'text/csv'
    if (mimeType === 'application/vnd.google-apps.drawing') return 'image/png'
    return GOOGLE_DRIVE_DEFAULT_EXPORT_MIME_TYPE
}

export function googleFileMimeType(type: GoogleDriveGoogleFileType): string {
    switch (type) {
        case 'document':
            return 'application/vnd.google-apps.document'
        case 'spreadsheet':
            return 'application/vnd.google-apps.spreadsheet'
        case 'presentation':
            return 'application/vnd.google-apps.presentation'
        case 'drawing':
            return 'application/vnd.google-apps.drawing'
        case 'form':
            return 'application/vnd.google-apps.form'
    }
}

export function isTextMime(mimeType: string): boolean {
    return mimeType.startsWith('text/')
        || mimeType.includes('json')
        || mimeType.includes('xml')
        || mimeType.includes('csv')
        || mimeType.includes('javascript')
        || mimeType.includes('yaml')
        || mimeType === 'application/rtf'
}

export function isProbablyBinary(buffer: Buffer): boolean {
    const len = Math.min(buffer.length, 8000)
    for (let i = 0; i < len; i += 1) {
        if (buffer[i] === 0) return true
    }
    return false
}

export function cleanRequired(value: string | undefined, name: string): string {
    const clean = cleanOptional(value)
    if (!clean) throw new Error(`Missing required parameter: ${name}`)
    return clean
}

export function cleanIds(values: string[], name: string): string[] {
    const out = values.map(value => cleanRequired(value, name)).filter(Boolean)
    return [...new Set(out)]
}

export function assignOptional(target: Record<string, unknown>, key: string, value: string | undefined): void {
    const clean = cleanOptional(value)
    if (clean) target[key] = clean
}

export function clampInt(value: number, min: number, max: number): number {
    const parsed = Number.isFinite(value) ? Math.floor(value) : min
    return Math.min(max, Math.max(min, parsed))
}

function cleanOptional(value: string | undefined): string {
    return (value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

function driveQueryString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").trim()
}

function normalizeRfc3339(value: string, name: string): string {
    const clean = cleanRequired(value, name)
    const ms = Date.parse(clean)
    if (!Number.isFinite(ms)) throw new Error(`${name} must be an RFC3339/ISO date-time.`)
    return new Date(ms).toISOString()
}
