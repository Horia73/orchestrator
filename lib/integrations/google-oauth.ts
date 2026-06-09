import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'

import { resolveOAuthRedirectUri } from '@/lib/app-origin'
import { getEnvValue } from '@/lib/config'
import { activeRuntimePaths } from '@/lib/runtime-paths'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const STATE_TTL_MS = 10 * 60 * 1000

export const GOOGLE_ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000

function googleStatePath(): string {
    return path.join(activeRuntimePaths().privateStateDir, 'auth', 'google-oauth-states.json')
}

export interface GoogleOAuthConfigInput {
    clientId?: string
    clientSecret?: string
    redirectUri?: string
    rawEnv?: string
}

export interface GoogleOAuthEnvConfig {
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

export interface GoogleOAuthProviderConfig {
    provider: string
    label: string
    redirectPath: string
    tokenPath: string
    clientIdEnvKeys?: string[]
    clientSecretEnvKeys?: string[]
    redirectUriEnvKeys?: string[]
    writeRedirectUriKey?: string
}

export interface GoogleOAuthTokenRecord {
    version: 1
    provider: string
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

export interface GoogleOAuthStartResult {
    authUrl: string
    redirectUri: string
    scopes: string[]
}

export interface GoogleOAuthTokenResponse {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    token_type?: string
    scope?: string
    error?: string
    error_description?: string
}

interface EnvLookup {
    value: string | null
    key: string | null
}

interface OAuthStateRecord {
    state: string
    provider: string
    redirectUri: string
    origin: string
    createdAt: number
    expiresAt: number
}

export function getGoogleOAuthConfig(origin: string, provider: GoogleOAuthProviderConfig): GoogleOAuthEnvConfig {
    const clientIdKeys = provider.clientIdEnvKeys ?? ['GOOGLE_OAUTH_CLIENT_ID']
    const clientSecretKeys = provider.clientSecretEnvKeys ?? ['GOOGLE_OAUTH_CLIENT_SECRET']
    const redirectUriKeys = provider.redirectUriEnvKeys ?? ['GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI']
    const clientId = firstEnv(clientIdKeys)
    const clientSecret = firstEnv(clientSecretKeys)
    const redirectUri = firstEnv(redirectUriKeys)
    const missing: string[] = []

    if (!clientId.value) missing.push(formatEnvChoice(clientIdKeys))
    if (!clientSecret.value) missing.push(formatEnvChoice(clientSecretKeys))

    return {
        clientId: clientId.value,
        clientSecret: clientSecret.value,
        redirectUri: resolveOAuthRedirectUri(redirectUri.value, origin, provider.redirectPath),
        missing,
        envKeys: {
            clientId: clientId.key,
            clientSecret: clientSecret.key,
            redirectUri: redirectUri.key,
        },
    }
}

export function saveGoogleOAuthClientConfig(
    origin: string,
    input: GoogleOAuthConfigInput,
    provider: GoogleOAuthProviderConfig
): GoogleOAuthEnvConfig {
    const clientIdKeys = provider.clientIdEnvKeys ?? ['GOOGLE_OAUTH_CLIENT_ID']
    const clientSecretKeys = provider.clientSecretEnvKeys ?? ['GOOGLE_OAUTH_CLIENT_SECRET']
    const redirectUriKeys = provider.redirectUriEnvKeys ?? ['GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI']
    const writeRedirectUriKey = provider.writeRedirectUriKey ?? redirectUriKeys[0] ?? 'GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI'
    const acceptedKeys = [...clientIdKeys, ...clientSecretKeys, ...redirectUriKeys, writeRedirectUriKey]
    const pasted = parseEnvAssignments(input.rawEnv ?? '', acceptedKeys)
    const googleJson = parseGoogleOAuthClientJson(input.rawEnv ?? '')
    const clientId = cleanConfigValue(input.clientId)
        || firstDefinedEnvValue(pasted, clientIdKeys)
        || googleJson.clientId
    const clientSecret = cleanConfigValue(input.clientSecret)
        || firstDefinedEnvValue(pasted, clientSecretKeys)
        || googleJson.clientSecret
    const redirectUri = cleanConfigValue(input.redirectUri)
        || firstDefinedEnvValue(pasted, redirectUriKeys)
        || googleJson.redirectUri

    const values: Record<string, string> = {}
    if (clientId) values.GOOGLE_OAUTH_CLIENT_ID = clientId
    if (clientSecret) values.GOOGLE_OAUTH_CLIENT_SECRET = clientSecret
    if (redirectUri) values[writeRedirectUriKey] = redirectUri

    if (Object.keys(values).length === 0) {
        throw new Error('Paste Google OAuth env lines or fill at least one field.')
    }

    patchWorkspaceEnv(values, {
        keysToReplace: acceptedKeys,
    })
    for (const [key, value] of Object.entries(values)) process.env[key] = value

    return getGoogleOAuthConfig(origin, provider)
}

export function startGoogleOAuth(args: {
    origin: string
    provider: GoogleOAuthProviderConfig
    scopes: readonly string[]
}): GoogleOAuthStartResult {
    const config = getGoogleOAuthConfig(args.origin, args.provider)
    if (!config.clientId || !config.clientSecret) {
        throw new Error(`Missing Google OAuth config: ${config.missing.join(', ')}`)
    }

    const state = randomBytes(32).toString('base64url')
    const now = Date.now()
    writeOAuthStates([
        ...readOAuthStates().filter(item => item.expiresAt > now),
        {
            state,
            provider: args.provider.provider,
            redirectUri: config.redirectUri,
            origin: args.origin,
            createdAt: now,
            expiresAt: now + STATE_TTL_MS,
        },
    ])

    const params = new URLSearchParams({
        client_id: config.clientId,
        response_type: 'code',
        redirect_uri: config.redirectUri,
        scope: args.scopes.join(' '),
        state,
        access_type: 'offline',
        include_granted_scopes: 'true',
        prompt: 'consent',
    })

    return {
        authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}`,
        redirectUri: config.redirectUri,
        scopes: [...args.scopes],
    }
}

export async function exchangeGoogleOAuthCode(args: {
    origin: string
    provider: GoogleOAuthProviderConfig
    state: string
    code: string
}): Promise<GoogleOAuthTokenResponse> {
    const state = consumeOAuthState(args.state)
    if (!state || state.provider !== args.provider.provider) {
        throw new Error('OAuth state is missing or expired. Start Google login again.')
    }

    const config = getGoogleOAuthConfig(args.origin, args.provider)
    if (!config.clientId || !config.clientSecret) {
        throw new Error(`Missing Google OAuth config: ${config.missing.join(', ')}`)
    }
    if (state.redirectUri !== config.redirectUri) {
        throw new Error('OAuth redirect URI changed while login was in progress. Start Google login again.')
    }

    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code: args.code,
            grant_type: 'authorization_code',
            redirect_uri: config.redirectUri,
        }),
    })
    const json = await response.json().catch(() => ({})) as GoogleOAuthTokenResponse
    if (!response.ok || json.error || !json.access_token) {
        throw new Error(json.error_description || json.error || `Token exchange failed (${response.status})`)
    }
    return json
}

export async function refreshGoogleOAuthToken(
    token: GoogleOAuthTokenRecord,
    config: GoogleOAuthEnvConfig,
    tokenPath: string
): Promise<GoogleOAuthTokenRecord> {
    if (!token.refreshToken) throw new Error(`No ${token.provider} refresh token is available.`)
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

    const json = await response.json().catch(() => ({})) as GoogleOAuthTokenResponse
    if (!response.ok || json.error || !json.access_token) {
        throw new Error(json.error_description || json.error || `Token refresh failed (${response.status})`)
    }

    const parsedScopes = parseScopeList(json.scope)
    const now = Date.now()
    const updated: GoogleOAuthTokenRecord = {
        ...token,
        accessToken: json.access_token,
        tokenType: json.token_type ?? token.tokenType,
        scope: parsedScopes.length > 0 ? parsedScopes : token.scope,
        expiresAt: now + Math.max(0, json.expires_in ?? 3600) * 1000,
        updatedAt: now,
    }
    writeGoogleOAuthToken(tokenPath, updated)
    return updated
}

export async function revokeGoogleOAuthToken(token: GoogleOAuthTokenRecord | null): Promise<void> {
    const revokeToken = token?.refreshToken || token?.accessToken
    if (!revokeToken) return
    await fetch(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: revokeToken }),
    }).catch(() => undefined)
}

export function readGoogleOAuthToken(tokenPath: string, provider: string): GoogleOAuthTokenRecord | null {
    try {
        if (!fs.existsSync(tokenPath)) return null
        const parsed = JSON.parse(fs.readFileSync(tokenPath, 'utf-8')) as Partial<GoogleOAuthTokenRecord>
        if (parsed.provider !== provider || typeof parsed.accessToken !== 'string') return null
        return {
            version: 1,
            provider,
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

export function writeGoogleOAuthToken(tokenPath: string, record: GoogleOAuthTokenRecord): void {
    writePrivateJson(tokenPath, record)
}

export function clearGoogleOAuthToken(tokenPath: string): void {
    try {
        fs.unlinkSync(tokenPath)
    } catch {
        // Already disconnected.
    }
}

export async function googleJson<T>(
    url: string,
    accessToken: string,
    init: RequestInit = {}
): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${accessToken}`)
    headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

    const response = await fetch(url, { ...init, headers })
    if (!response.ok) {
        throw new Error(`Google API failed (${response.status}): ${await responseErrorText(response)}`)
    }

    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
}

export async function responseErrorText(response: Response): Promise<string> {
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

export function parseScopeList(scope: string | undefined): string[] {
    return scope?.split(/\s+/).map(s => s.trim()).filter(Boolean) ?? []
}

export function hasGoogleScope(scopes: string[], requiredScope: string): boolean {
    if (scopes.includes(requiredScope)) return true
    if (requiredScope.startsWith('https://www.googleapis.com/auth/calendar.')) {
        return scopes.includes('https://www.googleapis.com/auth/calendar')
    }
    return false
}

export function missingGoogleScopes(scopes: string[], requiredScopes: readonly string[]): string[] {
    return requiredScopes.filter(scope => !hasGoogleScope(scopes, scope))
}

export function cleanGoogleConfigValue(value: string | undefined): string {
    return cleanConfigValue(value)
}

export function parseGoogleOAuthClientJson(raw: string): { clientId: string; clientSecret: string; redirectUri: string } {
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

export function getGoogleOAuthStateProvider(state: string): string | null {
    const clean = state.trim()
    if (!clean) return null
    return readOAuthStates().find(item => item.state === clean)?.provider ?? null
}

function readOAuthStates(): OAuthStateRecord[] {
    try {
        const statePath = googleStatePath()
        if (!fs.existsSync(statePath)) return []
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as unknown
        if (!Array.isArray(parsed)) return []
        const now = Date.now()
        return parsed
            .filter((item): item is OAuthStateRecord => {
                if (!item || typeof item !== 'object') return false
                const candidate = item as Partial<OAuthStateRecord>
                return typeof candidate.provider === 'string'
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
    writePrivateJson(googleStatePath(), records)
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

function parseEnvAssignments(raw: string, acceptedKeys: string[]): Record<string, string> {
    const accepted = new Set(acceptedKeys)
    const out: Record<string, string> = {}
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
        const idx = normalized.indexOf('=')
        if (idx <= 0) continue
        const key = normalized.slice(0, idx).trim()
        const value = stripEnvQuotes(normalized.slice(idx + 1).trim())
        if (accepted.has(key)) out[key] = value
    }
    return out
}

function patchWorkspaceEnv(args: {
    [key: string]: string
}, options: { keysToReplace: string[] }): void {
    const workspaceEnvPath = activeRuntimePaths().workspaceEnvPath
    fs.mkdirSync(path.dirname(workspaceEnvPath), { recursive: true })
    const existing = fs.existsSync(workspaceEnvPath)
        ? fs.readFileSync(workspaceEnvPath, 'utf-8')
        : ''
    const keysToReplace = new Set([...options.keysToReplace, ...Object.keys(args)])
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
    for (const [key, value] of Object.entries(args)) kept.push(`${key}=${formatEnvValue(value)}`)

    fs.writeFileSync(workspaceEnvPath, `${kept.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 })
    try {
        fs.chmodSync(workspaceEnvPath, 0o600)
    } catch {
        // Best effort; some filesystems ignore chmod.
    }
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

function isString(value: unknown): value is string {
    return typeof value === 'string'
}
