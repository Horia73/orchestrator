import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'

import { resolveOAuthRedirectUri } from '@/lib/app-origin'
import { getEnvValue } from '@/lib/config'
import { runIdBatch, type BatchItemResult, type BatchResult } from '@/lib/integrations/batch'
import { activeRuntimePaths } from '@/lib/runtime-paths'
import {
    base64UrlDecodeBuffer,
    base64UrlEncode,
    buildMimeMessage,
    cleanAddressList,
    cleanHeaderValue,
    cleanLabelIds,
    collectAttachments,
    extractMessageText,
    getHeader,
    limitThreadMessages,
    normalizeOutgoingAttachments,
    summarizeOutgoingAttachments,
    type GmailAttachmentInfo,
    type GmailAttachmentSummary,
    type GmailOutgoingAttachment,
    type GmailPayloadPart,
} from '@/lib/integrations/gmail-message-formatting'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1'
const GMAIL_FULL_ACCESS_SCOPE = 'https://mail.google.com/'
const STATE_TTL_MS = 10 * 60 * 1000
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000

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

function gmailTokenPath(): string {
    return path.join(activeRuntimePaths().privateStateDir, 'auth', 'gmail.json')
}

function gmailStatePath(): string {
    return path.join(activeRuntimePaths().privateStateDir, 'auth', 'gmail-oauth-states.json')
}

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
    /** Raw RFC 2369 List-Unsubscribe header value ('' when absent). Presence
     *  means the sender offers an unsubscribe mechanism — see gmailGetUnsubscribeInfo. */
    listUnsubscribe: string
    /** Raw RFC 8058 List-Unsubscribe-Post header value ('' when absent).
     *  "List-Unsubscribe=One-Click" here enables one-click HTTPS unsubscribe. */
    listUnsubscribePost: string
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
    listUnsubscribe: string
    listUnsubscribePost: string
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

export interface GmailAttachmentDownload {
    attachmentId: string
    bytes: Buffer
    size: number
}

export type { GmailAttachmentInfo, GmailAttachmentSummary, GmailOutgoingAttachment }

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
    let refreshFailed = false

    const shouldRefresh = token ? token.expiresAt <= Date.now() + ACCESS_TOKEN_REFRESH_SKEW_MS : false
    if (refresh && shouldRefresh && token?.refreshToken && config.clientId && config.clientSecret) {
        try {
            token = await refreshGmailToken(token, config)
        } catch (err) {
            refreshFailed = true
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
        needsReconnect: Boolean(!token || refreshFailed || missingScopes.length > 0 || (expired && !token.refreshToken)),
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
            listUnsubscribe: getHeader(headers, 'List-Unsubscribe'),
            listUnsubscribePost: getHeader(headers, 'List-Unsubscribe-Post'),
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

// Gmail's native bulk endpoint. messages.batchModify mutates up to 1000 message
// IDs per request and returns 204 (no body). There is NO threads.batchModify —
// thread targets fall back to a bounded-concurrency loop over the single modify.
const GMAIL_BATCH_MODIFY_MAX = 1000

export async function gmailBatchModifyLabels(
    targetType: GmailModifyTargetType,
    ids: string[],
    addLabelIds: string[],
    removeLabelIds: string[]
): Promise<BatchResult> {
    const cleanIds = ids.map(id => cleanHeaderValue(id)).filter((id): id is string => Boolean(id))
    if (cleanIds.length === 0) throw new Error('At least one Gmail target ID is required.')
    const addLabels = cleanLabelIds(addLabelIds)
    const removeLabels = cleanLabelIds(removeLabelIds)

    if (targetType !== 'message') {
        // Threads have no batch endpoint — loop per-thread.
        return runIdBatch(cleanIds, id => gmailModifyLabels('thread', id, addLabels, removeLabels), { concurrency: 6 })
    }

    const items: BatchItemResult[] = []
    for (let offset = 0; offset < cleanIds.length; offset += GMAIL_BATCH_MODIFY_MAX) {
        const chunk = cleanIds.slice(offset, offset + GMAIL_BATCH_MODIFY_MAX)
        try {
            await gmailApi<unknown>('/users/me/messages/batchModify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: chunk, addLabelIds: addLabels, removeLabelIds: removeLabels }),
            })
            for (const id of chunk) items.push({ id, ok: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            for (const id of chunk) items.push({ id, ok: false, error: message })
        }
    }
    const succeeded = items.reduce((n, item) => (item.ok ? n + 1 : n), 0)
    return { batch: true, total: cleanIds.length, succeeded, failed: cleanIds.length - succeeded, items }
}

export function gmailBatchArchive(targetType: GmailModifyTargetType, ids: string[]): Promise<BatchResult> {
    return gmailBatchModifyLabels(targetType, ids, [], ['INBOX'])
}

export function gmailBatchMarkRead(targetType: GmailModifyTargetType, ids: string[]): Promise<BatchResult> {
    return gmailBatchModifyLabels(targetType, ids, [], ['UNREAD'])
}

export function gmailBatchMarkUnread(targetType: GmailModifyTargetType, ids: string[]): Promise<BatchResult> {
    return gmailBatchModifyLabels(targetType, ids, ['UNREAD'], [])
}

export function gmailBatchTrash(targetType: GmailModifyTargetType, ids: string[]): Promise<BatchResult> {
    return runIdBatch(ids, id => gmailTrash(targetType, id), { concurrency: 6 })
}

export function gmailBatchUntrash(targetType: GmailModifyTargetType, ids: string[]): Promise<BatchResult> {
    return runIdBatch(ids, id => gmailUntrash(targetType, id), { concurrency: 6 })
}

export function gmailBatchDeletePermanently(targetType: GmailModifyTargetType, ids: string[]): Promise<BatchResult> {
    return runIdBatch(ids, id => gmailDeletePermanently(targetType, id), { concurrency: 4 })
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

// ---------------------------------------------------------------------------
// Unsubscribe — RFC 2369 (List-Unsubscribe) + RFC 8058 (one-click).
//
// The model can read List-Unsubscribe headers (surfaced on GmailSearch /
// GmailReadThread) but must NOT POST arbitrary URLs itself. These helpers do
// the parsing and the actual unsubscribe under guard:
//   - one_click → RFC 8058 HTTPS POST `List-Unsubscribe=One-Click`, behind an
//     HTTPS-only + private-address (SSRF) guard.
//   - mailto    → an unsubscribe email sent from the connected account via the
//     normal authenticated send path.
//   - link_only → a web link returned for the user to open (we never auto-GET
//     an unknown unsubscribe page; it may be a confirmation flow).
//   - none      → no mechanism; caller should fall back to auto-archive/filter.
// ---------------------------------------------------------------------------

export type GmailUnsubscribeMethod = 'one_click' | 'mailto' | 'link_only' | 'none'

export interface GmailUnsubscribeTarget {
    method: GmailUnsubscribeMethod
    httpsUrl: string | null
    mailto: { to: string; subject: string } | null
    oneClick: boolean
}

export interface GmailUnsubscribeInfo extends GmailUnsubscribeTarget {
    messageId: string
    from: string
    subject: string
    hasUnsubscribe: boolean
}

export interface GmailUnsubscribeResult {
    messageId: string
    from: string
    method: GmailUnsubscribeMethod
    performed: boolean
    httpStatus?: number
    mailtoSentMessageId?: string
    link?: string
    detail: string
}

/** HTTPS-only SSRF guard for the one-click unsubscribe POST. RFC 8058 mandates
 *  HTTPS; we additionally block localhost and literal private/link-local IPs so
 *  a crafted List-Unsubscribe header can't turn the connected account into an
 *  internal-network probe. Mirrors the web-source guard. */
export function isSafeUnsubscribeHttpsUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        return { ok: false, reason: 'invalid URL' }
    }
    if (url.protocol !== 'https:') return { ok: false, reason: `protocol ${url.protocol} not allowed (RFC 8058 one-click requires HTTPS)` }
    const host = url.hostname.toLowerCase()
    if (host === 'localhost' || host === '::1') return { ok: false, reason: 'localhost blocked' }
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (ipv4) {
        const [a, b] = ipv4.slice(1).map(Number)
        if (
            a === 10 ||
            a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            a === 0 ||
            a >= 224
        ) {
            return { ok: false, reason: 'private/link-local address blocked' }
        }
    }
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
        return { ok: false, reason: 'private/link-local address blocked' }
    }
    return { ok: true, url }
}

/** Parse RFC 2369 List-Unsubscribe (angle-bracketed, comma-separated) plus the
 *  RFC 8058 List-Unsubscribe-Post header into a structured target. Pure. */
export function parseListUnsubscribe(listUnsubscribe: string, listUnsubscribePost: string): GmailUnsubscribeTarget {
    const entries = [...(listUnsubscribe || '').matchAll(/<([^>]+)>/g)].map(m => m[1].trim()).filter(Boolean)
    let httpsUrl: string | null = null
    let mailto: { to: string; subject: string } | null = null
    for (const entry of entries) {
        if (/^https:\/\//i.test(entry)) {
            if (!httpsUrl) httpsUrl = entry
        } else if (/^mailto:/i.test(entry)) {
            if (!mailto) {
                try {
                    const u = new URL(entry)
                    const to = decodeURIComponent(u.pathname).trim()
                    const subject = u.searchParams.get('subject')?.trim() || 'unsubscribe'
                    if (to) mailto = { to, subject }
                } catch {
                    /* malformed mailto — ignore */
                }
            }
        }
    }
    // RFC 8058: presence of "List-Unsubscribe=One-Click" enables one-click POST.
    const oneClick = /one-?click/i.test(listUnsubscribePost || '')
    let method: GmailUnsubscribeMethod = 'none'
    if (httpsUrl && oneClick) method = 'one_click'
    else if (mailto) method = 'mailto'
    else if (httpsUrl) method = 'link_only'
    return { method, httpsUrl, mailto, oneClick }
}

async function gmailFetchUnsubscribeHeaders(messageId: string): Promise<{
    from: string
    subject: string
    listUnsubscribe: string
    listUnsubscribePost: string
}> {
    const params = new URLSearchParams({ format: 'metadata' })
    for (const header of ['From', 'Subject', 'List-Unsubscribe', 'List-Unsubscribe-Post']) {
        params.append('metadataHeaders', header)
    }
    const message = await gmailApi<GmailMessage>(`/users/me/messages/${encodeURIComponent(messageId)}?${params.toString()}`)
    const headers = message.payload?.headers ?? []
    return {
        from: getHeader(headers, 'From'),
        subject: getHeader(headers, 'Subject'),
        listUnsubscribe: getHeader(headers, 'List-Unsubscribe'),
        listUnsubscribePost: getHeader(headers, 'List-Unsubscribe-Post'),
    }
}

/** Read-only: report whether and how a sender can be unsubscribed from. */
export async function gmailGetUnsubscribeInfo(messageId: string): Promise<GmailUnsubscribeInfo> {
    const cleanId = cleanHeaderValue(messageId)
    if (!cleanId) throw new Error('Message ID is required.')
    const h = await gmailFetchUnsubscribeHeaders(cleanId)
    const target = parseListUnsubscribe(h.listUnsubscribe, h.listUnsubscribePost)
    return {
        messageId: cleanId,
        from: h.from,
        subject: h.subject,
        hasUnsubscribe: target.method !== 'none',
        ...target,
    }
}

/** Perform the unsubscribe. Call only after explicit user approval. */
export async function gmailUnsubscribe(messageId: string): Promise<GmailUnsubscribeResult> {
    const info = await gmailGetUnsubscribeInfo(messageId)

    if (info.method === 'one_click' && info.httpsUrl) {
        const safe = isSafeUnsubscribeHttpsUrl(info.httpsUrl)
        if (!safe.ok) throw new Error(`Refusing one-click unsubscribe: ${safe.reason}.`)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)
        try {
            const res = await fetch(safe.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'List-Unsubscribe=One-Click',
                redirect: 'follow',
                signal: controller.signal,
            })
            return {
                messageId: info.messageId,
                from: info.from,
                method: 'one_click',
                performed: res.ok,
                httpStatus: res.status,
                detail: res.ok
                    ? `One-click unsubscribe POST succeeded (HTTP ${res.status}).`
                    : `Unsubscribe endpoint returned HTTP ${res.status}; the sender may not have honored it.`,
            }
        } finally {
            clearTimeout(timer)
        }
    }

    if (info.method === 'mailto' && info.mailto) {
        const to = info.mailto.to.split(',').map(s => s.trim()).filter(Boolean)
        if (to.length === 0) throw new Error('Unsubscribe mailto had no usable recipient.')
        const sent = await gmailSendMessage({
            to,
            subject: info.mailto.subject || 'unsubscribe',
            body: 'Please unsubscribe this address from your mailing list.',
        })
        return {
            messageId: info.messageId,
            from: info.from,
            method: 'mailto',
            performed: true,
            mailtoSentMessageId: sent.messageId,
            detail: `Sent an unsubscribe email to ${to.join(', ')}.`,
        }
    }

    if (info.method === 'link_only' && info.httpsUrl) {
        return {
            messageId: info.messageId,
            from: info.from,
            method: 'link_only',
            performed: false,
            link: info.httpsUrl,
            detail: 'This sender only offers a web unsubscribe link (no one-click). Open the link to finish, or set up auto-archive instead.',
        }
    }

    return {
        messageId: info.messageId,
        from: info.from,
        method: 'none',
        performed: false,
        detail: 'No List-Unsubscribe mechanism on this message. Offer to auto-archive future mail from this sender, or create a Gmail filter, instead.',
    }
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
    for (const header of ['Subject', 'From', 'To', 'Date', 'List-Unsubscribe', 'List-Unsubscribe-Post']) {
        params.append('metadataHeaders', header)
    }

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
        listUnsubscribe: getHeader(headers, 'List-Unsubscribe'),
        listUnsubscribePost: getHeader(headers, 'List-Unsubscribe-Post'),
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
        if (!fs.existsSync(gmailTokenPath())) return null
        const parsed = JSON.parse(fs.readFileSync(gmailTokenPath(), 'utf-8')) as Partial<GmailTokenRecord>
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
    writePrivateJson(gmailTokenPath(), record)
}

function clearTokenRecord(): void {
    try {
        fs.unlinkSync(gmailTokenPath())
    } catch {
        // Already disconnected.
    }
}

function readOAuthStates(): OAuthStateRecord[] {
    try {
        if (!fs.existsSync(gmailStatePath())) return []
        const parsed = JSON.parse(fs.readFileSync(gmailStatePath(), 'utf-8')) as unknown
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
    writePrivateJson(gmailStatePath(), records)
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
    const workspaceEnvPath = activeRuntimePaths().workspaceEnvPath
    fs.mkdirSync(path.dirname(workspaceEnvPath), { recursive: true })
    const existing = fs.existsSync(workspaceEnvPath)
        ? fs.readFileSync(workspaceEnvPath, 'utf-8')
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
            if (!trimmed || trimmed.startsWith('#')) return false
            const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
            const idx = normalized.indexOf('=')
            if (idx <= 0) return true
            return !keysToReplace.has(normalized.slice(0, idx).trim())
        })

    while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
    if (kept.length > 0) kept.push('')
    for (const key of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GMAIL_OAUTH_REDIRECT_URI']) {
        const value = values[key]
        if (value) kept.push(`${key}=${formatEnvValue(value)}`)
    }

    fs.writeFileSync(workspaceEnvPath, `${kept.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 })
    try {
        fs.chmodSync(workspaceEnvPath, 0o600)
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
