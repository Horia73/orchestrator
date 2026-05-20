import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'

import { resolveOAuthRedirectUri } from '@/lib/app-origin'
import { getEnvValue, PRIVATE_STATE_DIR, WORKSPACE_ENV_PATH } from '@/lib/config'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1'
const GMAIL_FULL_ACCESS_SCOPE = 'https://mail.google.com/'
const STATE_TTL_MS = 10 * 60 * 1000
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000
const GMAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const GMAIL_MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024

const CLIENT_ID_ENV_KEYS = ['GOOGLE_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_ID']
const CLIENT_SECRET_ENV_KEYS = ['GOOGLE_OAUTH_CLIENT_SECRET', 'GMAIL_OAUTH_CLIENT_SECRET']
const REDIRECT_URI_ENV_KEYS = ['GMAIL_OAUTH_REDIRECT_URI', 'GOOGLE_OAUTH_REDIRECT_URI']

export const GMAIL_SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.send',
    GMAIL_FULL_ACCESS_SCOPE,
] as const

const AUTH_DIR = path.join(PRIVATE_STATE_DIR, 'auth')
const GMAIL_TOKEN_PATH = path.join(AUTH_DIR, 'gmail.json')
const GMAIL_STATE_PATH = path.join(AUTH_DIR, 'gmail-oauth-states.json')

interface EnvLookup {
    value: string | null
    key: string | null
}

interface OAuthConfig {
    clientId: string | null
    clientSecret: string | null
    redirectUri: string
    missing: string[]
    envKeys: {
        clientId: string | null
        clientSecret: string | null
        redirectUri: string | null
    }
}

interface GmailTokenRecord {
    version: 1
    provider: 'gmail'
    clientId: string
    accountEmail?: string
    accessToken: string
    refreshToken?: string
    tokenType?: string
    scope: string[]
    scopesRequested: string[]
    expiresAt: number
    obtainedAt: number
    updatedAt: number
}

interface OAuthStateRecord {
    state: string
    provider: 'gmail'
    redirectUri: string
    origin: string
    createdAt: number
    expiresAt: number
}

interface OAuthTokenResponse {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    token_type?: string
    scope?: string
    error?: string
    error_description?: string
}

interface GmailProfile {
    emailAddress?: string
    messagesTotal?: number
    threadsTotal?: number
}

interface GmailHeader {
    name: string
    value: string
}

interface GmailPayloadPart {
    partId?: string
    mimeType?: string
    filename?: string
    headers?: GmailHeader[]
    body?: {
        data?: string
        size?: number
        attachmentId?: string
    }
    parts?: GmailPayloadPart[]
}

interface GmailMessage {
    id: string
    threadId: string
    labelIds?: string[]
    snippet?: string
    internalDate?: string
    payload?: GmailPayloadPart
}

interface GmailThread {
    id: string
    messages?: GmailMessage[]
}

interface GmailDraft {
    id: string
    message?: GmailMessage
}

interface GmailListResponse {
    messages?: Array<{ id: string; threadId: string }>
    resultSizeEstimate?: number
    nextPageToken?: string
}

export interface GmailIntegrationStatus {
    id: 'gmail'
    name: string
    description: string
    configured: boolean
    connected: boolean
    accountEmail: string | null
    scopes: string[]
    requestedScopes: string[]
    missingConfig: string[]
    redirectUri: string
    expiresAt: number | null
    needsReconnect: boolean
    error?: string
}

export interface GmailSearchResult {
    id: string
    threadId: string
    labelIds: string[]
    subject: string
    from: string
    to: string
    date: string
    snippet: string
}

export interface GmailThreadMessage {
    id: string
    threadId: string
    labelIds: string[]
    from: string
    to: string
    cc: string
    date: string
    subject: string
    snippet: string
    body: string
    attachments: GmailAttachmentInfo[]
}

export interface GmailCreateDraftInput {
    to: string[]
    cc?: string[]
    bcc?: string[]
    subject: string
    body: string
    threadId?: string
    attachments?: GmailOutgoingAttachment[]
}

export interface GmailDraftResult {
    id: string
    messageId: string | null
    threadId: string | null
    to: string[]
    cc: string[]
    bcc: string[]
    subject: string
    attachments: GmailAttachmentSummary[]
}

export interface GmailSendResult {
    messageId: string
    threadId: string
    labelIds: string[]
    attachments: GmailAttachmentSummary[]
}

export interface GmailAttachmentInfo {
    messageId: string
    partId: string
    attachmentId: string
    filename: string
    mimeType: string
    size: number
}

export interface GmailAttachmentDownload {
    attachmentId: string
    bytes: Buffer
    size: number
}

export interface GmailOutgoingAttachment {
    filename: string
    mimeType: string
    bytes: Buffer
}

export interface GmailAttachmentSummary {
    filename: string
    mimeType: string
    size: number
}

export interface GmailLabel {
    id: string
    name: string
    type?: string
    messageListVisibility?: string
    labelListVisibility?: string
}

export type GmailModifyTargetType = 'message' | 'thread'

export interface GmailOAuthConfigInput {
    clientId?: string
    clientSecret?: string
    redirectUri?: string
    rawEnv?: string
}

export function getGmailOAuthConfig(origin: string): OAuthConfig {
    const clientId = firstEnv(CLIENT_ID_ENV_KEYS)
    const clientSecret = firstEnv(CLIENT_SECRET_ENV_KEYS)
    const redirectUri = firstEnv(REDIRECT_URI_ENV_KEYS)
    const missing: string[] = []

    if (!clientId.value) missing.push(formatEnvChoice(CLIENT_ID_ENV_KEYS))
    if (!clientSecret.value) missing.push(formatEnvChoice(CLIENT_SECRET_ENV_KEYS))

    return {
        clientId: clientId.value,
        clientSecret: clientSecret.value,
        redirectUri: resolveOAuthRedirectUri(redirectUri.value, origin, '/api/integrations/gmail/oauth/callback'),
        missing,
        envKeys: {
            clientId: clientId.key,
            clientSecret: clientSecret.key,
            redirectUri: redirectUri.key,
        },
    }
}

export async function getGmailIntegrationStatus(origin: string, refresh = false): Promise<GmailIntegrationStatus> {
    const config = getGmailOAuthConfig(origin)
    let token = readTokenRecord()
    let error: string | undefined

    const shouldRefresh = token ? token.expiresAt <= Date.now() + ACCESS_TOKEN_REFRESH_SKEW_MS : false
    if (refresh && shouldRefresh && token?.refreshToken && config.clientId && config.clientSecret) {
        try {
            token = await refreshGmailToken(token, config)
        } catch (err) {
            error = err instanceof Error ? err.message : 'Failed to refresh Gmail token'
        }
    }

    const scopes = token?.scope ?? []
    const missingScopes = missingRequiredGmailScopes(scopes)
    const expired = token ? token.expiresAt <= Date.now() + ACCESS_TOKEN_REFRESH_SKEW_MS : false

    return {
        id: 'gmail',
        name: 'Gmail',
        description: 'Read, draft, send, label, archive, trash, permanently delete, and send/download attachments from Gmail when authorized.',
        configured: config.missing.length === 0,
        connected: Boolean(token?.accessToken || token?.refreshToken),
        accountEmail: token?.accountEmail ?? null,
        scopes,
        requestedScopes: [...GMAIL_SCOPES],
        missingConfig: config.missing,
        redirectUri: config.redirectUri,
        expiresAt: token?.expiresAt ?? null,
        needsReconnect: Boolean(!token || missingScopes.length > 0 || (expired && !token.refreshToken)),
        error,
    }
}

export async function saveGmailOAuthConfig(origin: string, input: GmailOAuthConfigInput): Promise<GmailIntegrationStatus> {
    const pasted = parseEnvAssignments(input.rawEnv ?? '')
    const googleJson = parseGoogleOAuthClientJson(input.rawEnv ?? '')
    const clientId = cleanConfigValue(input.clientId) || firstDefinedEnvValue(pasted, CLIENT_ID_ENV_KEYS) || googleJson.clientId
    const clientSecret = cleanConfigValue(input.clientSecret) || firstDefinedEnvValue(pasted, CLIENT_SECRET_ENV_KEYS) || googleJson.clientSecret
    const redirectUri = cleanConfigValue(input.redirectUri) || firstDefinedEnvValue(pasted, REDIRECT_URI_ENV_KEYS) || googleJson.redirectUri

    const values: Record<string, string> = {}
    if (clientId) values.GOOGLE_OAUTH_CLIENT_ID = clientId
    if (clientSecret) values.GOOGLE_OAUTH_CLIENT_SECRET = clientSecret
    if (redirectUri) values.GMAIL_OAUTH_REDIRECT_URI = redirectUri

    if (Object.keys(values).length === 0) {
        throw new Error('Paste Google OAuth env lines or fill at least one field.')
    }

    patchWorkspaceEnv(values)
    for (const [key, value] of Object.entries(values)) process.env[key] = value

    return getGmailIntegrationStatus(origin, false)
}

export function startGmailOAuth(origin: string): { authUrl: string; redirectUri: string; scopes: string[] } {
    const config = getGmailOAuthConfig(origin)
    if (!config.clientId || !config.clientSecret) {
        throw new Error(`Missing Google OAuth config: ${config.missing.join(', ')}`)
    }

    const state = randomBytes(32).toString('base64url')
    const now = Date.now()
    writeOAuthStates([
        ...readOAuthStates().filter(item => item.expiresAt > now),
        {
            state,
            provider: 'gmail',
            redirectUri: config.redirectUri,
            origin,
            createdAt: now,
            expiresAt: now + STATE_TTL_MS,
        },
    ])

    const params = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        redirect_uri: config.redirectUri,
        scope: GMAIL_SCOPES.join(' '),
        state,
        access_type: 'offline',
        include_granted_scopes: 'true',
        prompt: 'consent',
    })

    return {
        authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`,
        redirectUri: config.redirectUri,
        scopes: [...GMAIL_SCOPES],
    }
}

export async function completeGmailOAuth(args: {
    origin: string
    state: string
    code: string
}): Promise<{ accountEmail: string | null }> {
    const state = consumeOAuthState(args.state)
    if (!state || state.provider !== 'gmail') {
        throw new Error('OAuth state is missing or expired. Start Gmail login again.')
    }

    const config = getGmailOAuthConfig(args.origin)
    if (!config.clientId || !config.clientSecret) {
        throw new Error(`Missing Google OAuth config: ${config.missing.join(', ')}`)
    }
    if (state.redirectUri !== config.redirectUri) {
        throw new Error('OAuth redirect URI changed while login was in progress. Start Gmail login again.')
    }

    const token = await exchangeAuthorizationCode(args.code, config)
    const existing = readTokenRecord()
    const refreshToken = token.refresh_token || existing?.refreshToken
    if (!token.access_token) throw new Error('Google did not return an access token.')
    if (!refreshToken) throw new Error('Google did not return a refresh token. Reconnect and approve offline access.')

    const grantedScopes = parseScopeList(token.scope)
    const missingScopes = missingRequiredGmailScopes(grantedScopes)
    if (missingScopes.length > 0) {
        throw new Error(`Gmail consent is missing required scopes: ${missingScopes.join(', ')}`)
    }

    const profile = await fetchGmailProfile(token.access_token)
    const now = Date.now()
    writeTokenRecord({
        version: 1,
        provider: 'gmail',
        clientId: config.clientId,
        accountEmail: profile.emailAddress,
        accessToken: token.access_token,
        refreshToken,
        tokenType: token.token_type,
        scope: grantedScopes,
        scopesRequested: [...GMAIL_SCOPES],
        expiresAt: now + Math.max(0, token.expires_in ?? 3600) * 1000,
        obtainedAt: existing?.obtainedAt ?? now,
        updatedAt: now,
    })

    return { accountEmail: profile.emailAddress ?? null }
}

export async function disconnectGmail(origin: string): Promise<void> {
    const token = readTokenRecord()
    if (!token) return

    const config = getGmailOAuthConfig(origin)
    const revokeToken = token.refreshToken || token.accessToken
    if (revokeToken && config.clientId && config.clientSecret) {
        await fetch(GOOGLE_REVOKE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: revokeToken }),
        }).catch(() => undefined)
    }

    clearTokenRecord()
}

export async function gmailSearchMessages(query: string, maxResults: number): Promise<{
    results: GmailSearchResult[]
    resultSizeEstimate: number
}> {
    const params = new URLSearchParams()
    params.set('q', query)
    params.set('maxResults', String(Math.max(1, Math.min(25, Math.floor(maxResults)))))

    const list = await gmailApi<GmailListResponse>(`/users/me/messages?${params.toString()}`)
    const refs = list.messages ?? []
    const results = await Promise.all(refs.map(ref => gmailGetMessageMetadata(ref.id)))
    return {
        results,
        resultSizeEstimate: list.resultSizeEstimate ?? results.length,
    }
}

export async function gmailReadThread(threadId: string, maxChars: number): Promise<{
    threadId: string
    messages: GmailThreadMessage[]
    truncated: boolean
}> {
    const thread = await gmailApi<GmailThread>(`/users/me/threads/${encodeURIComponent(threadId)}?format=full`)
    const messages = (thread.messages ?? []).map(message => {
        const headers = message.payload?.headers ?? []
        return {
            id: message.id,
            threadId: message.threadId,
            labelIds: message.labelIds ?? [],
            from: getHeader(headers, 'From'),
            to: getHeader(headers, 'To'),
            cc: getHeader(headers, 'Cc'),
            date: getHeader(headers, 'Date'),
            subject: getHeader(headers, 'Subject'),
            snippet: message.snippet ?? '',
            body: extractMessageText(message.payload),
            attachments: collectAttachments(message.payload, message.id),
        }
    })

    const limited = limitThreadMessages(messages, maxChars)
    return { threadId: thread.id, messages: limited.messages, truncated: limited.truncated }
}

export async function gmailCreateDraft(input: GmailCreateDraftInput): Promise<GmailDraftResult> {
    const token = await getValidTokenRecord()
    const to = cleanAddressList(input.to)
    const cc = cleanAddressList(input.cc ?? [])
    const bcc = cleanAddressList(input.bcc ?? [])
    const subject = cleanHeaderValue(input.subject)
    const body = input.body.trimEnd()
    const attachments = normalizeOutgoingAttachments(input.attachments)

    if (to.length === 0) throw new Error('At least one recipient is required.')
    if (!subject) throw new Error('Subject is required.')

    const replyHeaders = input.threadId ? await getReplyHeaders(input.threadId) : null
    const from = token.accountEmail || 'me'
    const mime = buildMimeMessage({
        from,
        to,
        cc,
        bcc,
        subject,
        body,
        attachments,
        inReplyTo: replyHeaders?.inReplyTo,
        references: replyHeaders?.references,
    })

    const message: Record<string, unknown> = {
        raw: base64UrlEncode(Buffer.from(mime, 'utf-8')),
    }
    if (input.threadId) message.threadId = input.threadId

    const draft = await gmailApi<GmailDraft>('/users/me/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
    })

    return {
        id: draft.id,
        messageId: draft.message?.id ?? null,
        threadId: draft.message?.threadId ?? input.threadId ?? null,
        to,
        cc,
        bcc,
        subject,
        attachments: summarizeOutgoingAttachments(attachments),
    }
}

export async function gmailSendDraft(draftId: string): Promise<GmailSendResult> {
    const cleanDraftId = cleanHeaderValue(draftId)
    if (!cleanDraftId) throw new Error('Draft ID is required.')
    const message = await gmailApi<GmailMessage>('/users/me/drafts/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: cleanDraftId }),
    })
    return {
        messageId: message.id,
        threadId: message.threadId,
        labelIds: message.labelIds ?? [],
        attachments: [],
    }
}

export async function gmailSendMessage(input: GmailCreateDraftInput): Promise<GmailSendResult> {
    const token = await getValidTokenRecord()
    const to = cleanAddressList(input.to)
    const cc = cleanAddressList(input.cc ?? [])
    const bcc = cleanAddressList(input.bcc ?? [])
    const subject = cleanHeaderValue(input.subject)
    const body = input.body.trimEnd()
    const attachments = normalizeOutgoingAttachments(input.attachments)

    if (to.length === 0) throw new Error('At least one recipient is required.')
    if (!subject) throw new Error('Subject is required.')

    const replyHeaders = input.threadId ? await getReplyHeaders(input.threadId) : null
    const mime = buildMimeMessage({
        from: token.accountEmail || 'me',
        to,
        cc,
        bcc,
        subject,
        body,
        attachments,
        inReplyTo: replyHeaders?.inReplyTo,
        references: replyHeaders?.references,
    })
    const message: Record<string, unknown> = {
        raw: base64UrlEncode(Buffer.from(mime, 'utf-8')),
    }
    if (input.threadId) message.threadId = input.threadId

    const sent = await gmailApi<GmailMessage>('/users/me/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
    })
    return {
        messageId: sent.id,
        threadId: sent.threadId,
        labelIds: sent.labelIds ?? [],
        attachments: summarizeOutgoingAttachments(attachments),
    }
}

export async function gmailModifyLabels(
    targetType: GmailModifyTargetType,
    id: string,
    addLabelIds: string[],
    removeLabelIds: string[]
): Promise<{ targetType: GmailModifyTargetType; id: string; labelIds: string[] }> {
    const target = gmailTargetPath(targetType)
    const cleanId = cleanHeaderValue(id)
    if (!cleanId) throw new Error('Gmail target ID is required.')
    const body = {
        addLabelIds: cleanLabelIds(addLabelIds),
        removeLabelIds: cleanLabelIds(removeLabelIds),
    }
    const result = await gmailApi<GmailMessage | GmailThread>(`/users/me/${target}/${encodeURIComponent(cleanId)}/modify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    const labelIds = 'labelIds' in result && Array.isArray(result.labelIds) ? result.labelIds : []
    return { targetType, id: cleanId, labelIds }
}

export async function gmailArchive(targetType: GmailModifyTargetType, id: string) {
    return gmailModifyLabels(targetType, id, [], ['INBOX'])
}

export async function gmailMarkRead(targetType: GmailModifyTargetType, id: string) {
    return gmailModifyLabels(targetType, id, [], ['UNREAD'])
}

export async function gmailMarkUnread(targetType: GmailModifyTargetType, id: string) {
    return gmailModifyLabels(targetType, id, ['UNREAD'], [])
}

export async function gmailTrash(targetType: GmailModifyTargetType, id: string): Promise<{ targetType: GmailModifyTargetType; id: string; action: 'trash' }> {
    await gmailStateAction(targetType, id, 'trash')
    return { targetType, id, action: 'trash' }
}

export async function gmailUntrash(targetType: GmailModifyTargetType, id: string): Promise<{ targetType: GmailModifyTargetType; id: string; action: 'untrash' }> {
    await gmailStateAction(targetType, id, 'untrash')
    return { targetType, id, action: 'untrash' }
}

export async function gmailDeletePermanently(targetType: GmailModifyTargetType, id: string): Promise<{ targetType: GmailModifyTargetType; id: string; action: 'delete_permanent' }> {
    const target = gmailTargetPath(targetType)
    const cleanId = cleanHeaderValue(id)
    if (!cleanId) throw new Error('Gmail target ID is required.')
    await gmailApi<unknown>(`/users/me/${target}/${encodeURIComponent(cleanId)}`, { method: 'DELETE' })
    return { targetType, id: cleanId, action: 'delete_permanent' }
}

export async function gmailListLabels(): Promise<{ labels: GmailLabel[] }> {
    const result = await gmailApi<{ labels?: GmailLabel[] }>('/users/me/labels')
    return { labels: result.labels ?? [] }
}

export async function gmailCreateLabel(name: string): Promise<GmailLabel> {
    const cleanName = cleanHeaderValue(name)
    if (!cleanName) throw new Error('Label name is required.')
    return gmailApi<GmailLabel>('/users/me/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: cleanName,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show',
        }),
    })
}

export async function gmailDownloadAttachment(messageId: string, attachmentId: string): Promise<GmailAttachmentDownload> {
    const cleanMessageId = cleanHeaderValue(messageId)
    const cleanAttachmentId = cleanHeaderValue(attachmentId)
    if (!cleanMessageId) throw new Error('Message ID is required.')
    if (!cleanAttachmentId) throw new Error('Attachment ID is required.')
    const result = await gmailApi<{ data?: string; size?: number }>(
        `/users/me/messages/${encodeURIComponent(cleanMessageId)}/attachments/${encodeURIComponent(cleanAttachmentId)}`
    )
    if (!result.data) throw new Error('Gmail attachment response did not include data.')
    const bytes = base64UrlDecodeBuffer(result.data)
    return {
        attachmentId: cleanAttachmentId,
        bytes,
        size: typeof result.size === 'number' ? result.size : bytes.byteLength,
    }
}

async function gmailGetMessageMetadata(id: string): Promise<GmailSearchResult> {
    const params = new URLSearchParams({ format: 'metadata' })
    for (const header of ['Subject', 'From', 'To', 'Date']) params.append('metadataHeaders', header)

    const message = await gmailApi<GmailMessage>(`/users/me/messages/${encodeURIComponent(id)}?${params.toString()}`)
    const headers = message.payload?.headers ?? []
    return {
        id: message.id,
        threadId: message.threadId,
        labelIds: message.labelIds ?? [],
        subject: getHeader(headers, 'Subject'),
        from: getHeader(headers, 'From'),
        to: getHeader(headers, 'To'),
        date: getHeader(headers, 'Date'),
        snippet: message.snippet ?? '',
    }
}

async function getReplyHeaders(threadId: string): Promise<{ inReplyTo?: string; references?: string } | null> {
    const params = new URLSearchParams({ format: 'metadata' })
    for (const header of ['Message-ID', 'References']) params.append('metadataHeaders', header)
    const thread = await gmailApi<GmailThread>(`/users/me/threads/${encodeURIComponent(threadId)}?${params.toString()}`)
    const messages = thread.messages ?? []
    const last = messages[messages.length - 1]
    if (!last?.payload?.headers) return null

    const messageId = getHeader(last.payload.headers, 'Message-ID')
    const references = getHeader(last.payload.headers, 'References')
    return {
        inReplyTo: messageId || undefined,
        references: [references, messageId].filter(Boolean).join(' ') || undefined,
    }
}

async function gmailApi<T>(pathAndQuery: string, init: RequestInit = {}, retry = true): Promise<T> {
    const token = await getValidTokenRecord()
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token.accessToken}`)
    headers.set('Accept', 'application/json')

    const response = await fetch(`${GMAIL_API_BASE}${pathAndQuery}`, {
        ...init,
        headers,
    })

    if (response.status === 401 && retry && token.refreshToken) {
        await refreshGmailToken(token, getGmailOAuthConfig('http://localhost:3000'))
        return gmailApi<T>(pathAndQuery, init, false)
    }

    if (!response.ok) {
        throw new Error(`Gmail API failed (${response.status}): ${await responseErrorText(response)}`)
    }

    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
}

async function getValidTokenRecord(): Promise<GmailTokenRecord> {
    const token = readTokenRecord()
    if (!token) throw new Error('Gmail is not connected. Connect it from Settings > Auth.')
    if (token.expiresAt > Date.now() + ACCESS_TOKEN_REFRESH_SKEW_MS) return token
    if (!token.refreshToken) throw new Error('Gmail session expired. Reconnect Gmail from Settings > Auth.')

    const refreshed = await refreshGmailToken(token, getGmailOAuthConfig('http://localhost:3000'))
    return refreshed
}

async function exchangeAuthorizationCode(code: string, config: OAuthConfig): Promise<OAuthTokenResponse> {
    if (!config.clientId || !config.clientSecret) throw new Error('Google OAuth is not configured.')

    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: config.redirectUri,
        }),
    })
    const json = await response.json().catch(() => ({})) as OAuthTokenResponse
    if (!response.ok || json.error) {
        throw new Error(json.error_description || json.error || `Token exchange failed (${response.status})`)
    }
    return json
}

async function refreshGmailToken(token: GmailTokenRecord, config: OAuthConfig): Promise<GmailTokenRecord> {
    if (!token.refreshToken) throw new Error('No Gmail refresh token is available.')
    if (!config.clientId || !config.clientSecret) {
        throw new Error(`Missing Google OAuth config: ${config.missing.join(', ')}`)
    }

    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: token.refreshToken,
            grant_type: 'refresh_token',
        }),
    })

    const json = await response.json().catch(() => ({})) as OAuthTokenResponse
    if (!response.ok || json.error || !json.access_token) {
        throw new Error(json.error_description || json.error || `Token refresh failed (${response.status})`)
    }

    const now = Date.now()
    const updated: GmailTokenRecord = {
        ...token,
        accessToken: json.access_token,
        tokenType: json.token_type ?? token.tokenType,
        scope: parseScopeList(json.scope).length > 0 ? parseScopeList(json.scope) : token.scope,
        expiresAt: now + Math.max(0, json.expires_in ?? 3600) * 1000,
        updatedAt: now,
    }
    writeTokenRecord(updated)
    return updated
}

async function fetchGmailProfile(accessToken: string): Promise<GmailProfile> {
    const response = await fetch(`${GMAIL_API_BASE}/users/me/profile`, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
        },
    })
    if (!response.ok) {
        throw new Error(`Could not read Gmail profile (${response.status}): ${await responseErrorText(response)}`)
    }
    return await response.json() as GmailProfile
}

async function responseErrorText(response: Response): Promise<string> {
    const text = await response.text().catch(() => '')
    if (!text) return response.statusText || 'unknown error'
    try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string; error_description?: string }
        if (typeof parsed.error === 'object' && parsed.error?.message) return parsed.error.message
        if (typeof parsed.error === 'string') return parsed.error_description || parsed.error
    } catch {
        // Use raw text below.
    }
    return text.slice(0, 1000)
}

function readTokenRecord(): GmailTokenRecord | null {
    try {
        if (!fs.existsSync(GMAIL_TOKEN_PATH)) return null
        const parsed = JSON.parse(fs.readFileSync(GMAIL_TOKEN_PATH, 'utf-8')) as Partial<GmailTokenRecord>
        if (parsed.provider !== 'gmail' || typeof parsed.accessToken !== 'string') return null
        return {
            version: 1,
            provider: 'gmail',
            clientId: String(parsed.clientId ?? ''),
            accountEmail: typeof parsed.accountEmail === 'string' ? parsed.accountEmail : undefined,
            accessToken: parsed.accessToken,
            refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
            tokenType: typeof parsed.tokenType === 'string' ? parsed.tokenType : undefined,
            scope: Array.isArray(parsed.scope) ? parsed.scope.filter(isString) : [],
            scopesRequested: Array.isArray(parsed.scopesRequested) ? parsed.scopesRequested.filter(isString) : [],
            expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
            obtainedAt: typeof parsed.obtainedAt === 'number' ? parsed.obtainedAt : 0,
            updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        }
    } catch {
        return null
    }
}

function writeTokenRecord(record: GmailTokenRecord): void {
    writePrivateJson(GMAIL_TOKEN_PATH, record)
}

function clearTokenRecord(): void {
    try {
        fs.unlinkSync(GMAIL_TOKEN_PATH)
    } catch {
        // Already disconnected.
    }
}

function readOAuthStates(): OAuthStateRecord[] {
    try {
        if (!fs.existsSync(GMAIL_STATE_PATH)) return []
        const parsed = JSON.parse(fs.readFileSync(GMAIL_STATE_PATH, 'utf-8')) as unknown
        if (!Array.isArray(parsed)) return []
        const now = Date.now()
        return parsed
            .filter((item): item is OAuthStateRecord => {
                if (!item || typeof item !== 'object') return false
                const candidate = item as Partial<OAuthStateRecord>
                return candidate.provider === 'gmail'
                    && typeof candidate.state === 'string'
                    && typeof candidate.redirectUri === 'string'
                    && typeof candidate.origin === 'string'
                    && typeof candidate.createdAt === 'number'
                    && typeof candidate.expiresAt === 'number'
            })
            .filter(item => item.expiresAt > now)
    } catch {
        return []
    }
}

function writeOAuthStates(records: OAuthStateRecord[]): void {
    writePrivateJson(GMAIL_STATE_PATH, records)
}

function consumeOAuthState(state: string): OAuthStateRecord | null {
    const records = readOAuthStates()
    const match = records.find(item => item.state === state) ?? null
    writeOAuthStates(records.filter(item => item.state !== state))
    return match
}

function writePrivateJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    try {
        fs.chmodSync(path.dirname(filePath), 0o700)
    } catch {
        // Best effort on platforms that support chmod.
    }
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
    try {
        fs.chmodSync(tmp, 0o600)
    } catch {
        // Best effort.
    }
    fs.renameSync(tmp, filePath)
}

function firstEnv(keys: string[]): EnvLookup {
    for (const key of keys) {
        const value = getEnvValue(key)
        if (value) return { value, key }
    }
    return { value: null, key: null }
}

function firstDefinedEnvValue(values: Record<string, string>, keys: string[]): string {
    for (const key of keys) {
        const value = cleanConfigValue(values[key])
        if (value) return value
    }
    return ''
}

function parseEnvAssignments(raw: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
        const idx = normalized.indexOf('=')
        if (idx <= 0) continue
        const key = normalized.slice(0, idx).trim()
        const value = stripEnvQuotes(normalized.slice(idx + 1).trim())
        if (isAcceptedOAuthEnvKey(key)) out[key] = value
    }
    return out
}

function parseGoogleOAuthClientJson(raw: string): { clientId: string; clientSecret: string; redirectUri: string } {
    if (!raw.trim().startsWith('{')) return { clientId: '', clientSecret: '', redirectUri: '' }
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const block = getOAuthClientBlock(parsed)
        return {
            clientId: cleanConfigValue(stringField(block, 'client_id')),
            clientSecret: cleanConfigValue(stringField(block, 'client_secret')),
            redirectUri: cleanConfigValue(firstStringArrayItem(block, 'redirect_uris')),
        }
    } catch {
        return { clientId: '', clientSecret: '', redirectUri: '' }
    }
}

function getOAuthClientBlock(parsed: Record<string, unknown>): Record<string, unknown> {
    const web = parsed.web
    if (web && typeof web === 'object' && !Array.isArray(web)) return web as Record<string, unknown>
    const installed = parsed.installed
    if (installed && typeof installed === 'object' && !Array.isArray(installed)) return installed as Record<string, unknown>
    return parsed
}

function stringField(record: Record<string, unknown>, key: string): string {
    const value = record[key]
    return typeof value === 'string' ? value : ''
}

function firstStringArrayItem(record: Record<string, unknown>, key: string): string {
    const value = record[key]
    if (!Array.isArray(value)) return ''
    const first = value.find(item => typeof item === 'string')
    return typeof first === 'string' ? first : ''
}

function patchWorkspaceEnv(values: Record<string, string>): void {
    fs.mkdirSync(path.dirname(WORKSPACE_ENV_PATH), { recursive: true })
    const existing = fs.existsSync(WORKSPACE_ENV_PATH)
        ? fs.readFileSync(WORKSPACE_ENV_PATH, 'utf-8')
        : ''
    const keysToReplace = new Set([
        ...CLIENT_ID_ENV_KEYS,
        ...CLIENT_SECRET_ENV_KEYS,
        ...REDIRECT_URI_ENV_KEYS,
    ])
    const kept = existing
        .split(/\r?\n/)
        .filter(line => {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) return true
            const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
            const idx = normalized.indexOf('=')
            if (idx <= 0) return true
            return !keysToReplace.has(normalized.slice(0, idx).trim())
        })

    while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
    if (kept.length > 0) kept.push('')
    kept.push('# Google OAuth for Gmail')
    for (const key of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GMAIL_OAUTH_REDIRECT_URI']) {
        const value = values[key]
        if (value) kept.push(`${key}=${formatEnvValue(value)}`)
    }

    fs.writeFileSync(WORKSPACE_ENV_PATH, `${kept.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 })
    try {
        fs.chmodSync(WORKSPACE_ENV_PATH, 0o600)
    } catch {
        // Best effort; some filesystems ignore chmod.
    }
}

function isAcceptedOAuthEnvKey(key: string): boolean {
    return CLIENT_ID_ENV_KEYS.includes(key)
        || CLIENT_SECRET_ENV_KEYS.includes(key)
        || REDIRECT_URI_ENV_KEYS.includes(key)
}

function cleanConfigValue(value: string | undefined): string {
    return stripEnvQuotes((value ?? '').replace(/[\r\n]/g, '').trim())
}

function stripEnvQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1)
    }
    return value
}

function formatEnvValue(value: string): string {
    if (value === '') return '""'
    if (/^[A-Za-z0-9_./:@%+=,\-]+$/.test(value)) return value
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function formatEnvChoice(keys: string[]): string {
    return keys.length === 1 ? keys[0] : `${keys[0]} (or ${keys.slice(1).join(', ')})`
}

function parseScopeList(scope: string | undefined): string[] {
    return scope?.split(/\s+/).map(s => s.trim()).filter(Boolean) ?? []
}

function missingRequiredGmailScopes(scopes: string[]): string[] {
    if (scopes.includes(GMAIL_FULL_ACCESS_SCOPE)) return []
    return GMAIL_SCOPES.filter(scope => !scopes.includes(scope))
}

function isString(value: unknown): value is string {
    return typeof value === 'string'
}

function getHeader(headers: GmailHeader[], name: string): string {
    const lower = name.toLowerCase()
    return headers.find(header => header.name.toLowerCase() === lower)?.value ?? ''
}

function extractMessageText(payload: GmailPayloadPart | undefined): string {
    if (!payload) return ''
    const plain = collectPayloadText(payload, 'text/plain')
    if (plain.length > 0) return plain.join('\n\n').trim()
    const html = collectPayloadText(payload, 'text/html')
    return html.map(htmlToText).join('\n\n').trim()
}

function collectPayloadText(part: GmailPayloadPart, mimeType: string): string[] {
    const out: string[] = []
    if (part.mimeType === mimeType && part.body?.data) out.push(base64UrlDecode(part.body.data))
    for (const child of part.parts ?? []) out.push(...collectPayloadText(child, mimeType))
    return out
}

function collectAttachments(part: GmailPayloadPart | undefined, messageId: string): GmailAttachmentInfo[] {
    if (!part) return []
    const current = part.filename && part.body?.attachmentId
        ? [{
            messageId,
            partId: part.partId ?? '',
            attachmentId: part.body.attachmentId,
            filename: part.filename,
            mimeType: part.mimeType ?? 'application/octet-stream',
            size: part.body.size ?? 0,
        }]
        : []
    for (const child of part.parts ?? []) current.push(...collectAttachments(child, messageId))
    return current
}

function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(p|div|section|article|header|footer|main|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function limitThreadMessages(messages: GmailThreadMessage[], maxChars: number): { messages: GmailThreadMessage[]; truncated: boolean } {
    const limit = Math.max(2000, Math.min(100_000, Math.floor(maxChars)))
    let used = 0
    let truncated = false
    const limited: GmailThreadMessage[] = []
    for (const message of messages) {
        const bodyBudget = Math.max(0, limit - used)
        if (bodyBudget <= 0) {
            truncated = true
            break
        }
        const body = message.body.length > bodyBudget
            ? `${message.body.slice(0, bodyBudget)}\n\n...[truncated]...`
            : message.body
        truncated ||= body.length !== message.body.length
        used += body.length + message.subject.length + message.from.length + message.to.length + 200
        limited.push({ ...message, body })
    }
    return { messages: limited, truncated }
}

function cleanAddressList(values: string[]): string[] {
    return values
        .map(value => cleanHeaderValue(value))
        .filter(Boolean)
}

function cleanHeaderValue(value: string): string {
    return value.replace(/[\r\n]+/g, ' ').trim()
}

function cleanLabelIds(values: string[]): string[] {
    return values.map(cleanHeaderValue).filter(Boolean)
}

function normalizeOutgoingAttachments(attachments: GmailOutgoingAttachment[] | undefined): GmailOutgoingAttachment[] {
    const clean: GmailOutgoingAttachment[] = []
    let totalBytes = 0

    for (const attachment of attachments ?? []) {
        const filename = cleanAttachmentFilename(attachment.filename)
        const bytes = Buffer.isBuffer(attachment.bytes) ? attachment.bytes : Buffer.from(attachment.bytes)
        const mimeType = cleanMimeType(attachment.mimeType)

        if (!filename) throw new Error('Attachment filename is required.')
        if (bytes.byteLength === 0) throw new Error(`Attachment ${filename} is empty.`)
        if (bytes.byteLength > GMAIL_MAX_ATTACHMENT_BYTES) {
            throw new Error(`Attachment ${filename} is too large. Gmail attachment limit is 25MB per file.`)
        }

        totalBytes += bytes.byteLength
        if (totalBytes > GMAIL_MAX_TOTAL_ATTACHMENT_BYTES) {
            throw new Error('Gmail attachments are too large. Total attachment size is capped at 25MB.')
        }

        clean.push({ filename, mimeType, bytes })
    }

    return clean
}

function summarizeOutgoingAttachments(attachments: GmailOutgoingAttachment[]): GmailAttachmentSummary[] {
    return attachments.map(attachment => ({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.bytes.byteLength,
    }))
}

function cleanAttachmentFilename(value: string): string {
    return cleanHeaderValue(value).replace(/[\\/]/g, '_').trim()
}

function cleanMimeType(value: string): string {
    const base = cleanHeaderValue(value).split(';')[0].trim().toLowerCase()
    return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base)
        ? base
        : 'application/octet-stream'
}

function gmailTargetPath(targetType: GmailModifyTargetType): 'messages' | 'threads' {
    if (targetType === 'message') return 'messages'
    if (targetType === 'thread') return 'threads'
    throw new Error(`Invalid Gmail target type: ${targetType}`)
}

async function gmailStateAction(
    targetType: GmailModifyTargetType,
    id: string,
    action: 'trash' | 'untrash'
): Promise<void> {
    const target = gmailTargetPath(targetType)
    const cleanId = cleanHeaderValue(id)
    if (!cleanId) throw new Error('Gmail target ID is required.')
    await gmailApi<unknown>(`/users/me/${target}/${encodeURIComponent(cleanId)}/${action}`, { method: 'POST' })
}

function buildMimeMessage(args: {
    from: string
    to: string[]
    cc: string[]
    bcc: string[]
    subject: string
    body: string
    attachments?: GmailOutgoingAttachment[]
    inReplyTo?: string
    references?: string
}): string {
    const headers = [
        `From: ${cleanHeaderValue(args.from)}`,
        `To: ${args.to.join(', ')}`,
        args.cc.length ? `Cc: ${args.cc.join(', ')}` : null,
        args.bcc.length ? `Bcc: ${args.bcc.join(', ')}` : null,
        `Subject: ${encodeMimeHeader(args.subject)}`,
        args.inReplyTo ? `In-Reply-To: ${cleanHeaderValue(args.inReplyTo)}` : null,
        args.references ? `References: ${cleanHeaderValue(args.references)}` : null,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
    ].filter((line): line is string => line !== null)

    if (!args.attachments?.length) {
        return [
            ...headers,
            'Content-Type: text/plain; charset="UTF-8"',
            'Content-Transfer-Encoding: 8bit',
            '',
            args.body,
        ].join('\r\n')
    }

    const boundary = `orchestrator-gmail-${randomBytes(12).toString('hex')}`
    const lines = [
        ...headers,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        args.body,
        ...args.attachments.flatMap(attachment => attachmentMimePart(boundary, attachment)),
        `--${boundary}--`,
        '',
    ]
    return lines.join('\r\n')
}

function attachmentMimePart(boundary: string, attachment: GmailOutgoingAttachment): string[] {
    return [
        `--${boundary}`,
        `Content-Type: ${cleanMimeType(attachment.mimeType)}; ${mimeFilenameParameter('name', attachment.filename)}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; ${mimeFilenameParameter('filename', attachment.filename)}`,
        '',
        wrapBase64(attachment.bytes.toString('base64')),
    ]
}

function encodeMimeHeader(value: string): string {
    const clean = cleanHeaderValue(value)
    if (/^[\x20-\x7e]*$/.test(clean)) return clean
    return `=?UTF-8?B?${Buffer.from(clean, 'utf-8').toString('base64')}?=`
}

function mimeFilenameParameter(name: string, filename: string): string {
    const clean = cleanAttachmentFilename(filename) || 'attachment.bin'
    const quoted = `"${clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    if (/^[\x20-\x7e]*$/.test(clean)) return `${name}=${quoted}`
    return `${name}=${quoted}; ${name}*=UTF-8''${encodeURIComponent(clean)}`
}

function wrapBase64(value: string): string {
    return value.replace(/.{1,76}/g, '$&\r\n').trimEnd()
}

function base64UrlEncode(buffer: Buffer): string {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string): string {
    return base64UrlDecodeBuffer(value).toString('utf-8')
}

function base64UrlDecodeBuffer(value: string): Buffer {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), '=')
    return Buffer.from(padded, 'base64')
}
