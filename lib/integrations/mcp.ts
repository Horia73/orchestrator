import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { auth, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import { resolveOAuthRedirectUri } from '@/lib/app-origin'
import { activeRuntimePaths } from '@/lib/runtime-paths'

const MCP_DIR = 'mcp'
const SERVERS_FILE = 'servers.json'
const OAUTH_DIR = 'oauth'
const STATES_FILE = 'oauth-states.json'
const STATE_TTL_MS = 10 * 60_000
const DEFAULT_TIMEOUT_MS = 15_000
const CALLBACK_PATH = '/api/integrations/mcp/oauth/callback'

export type RemoteMcpAuthType = 'none' | 'oauth'

export interface RemoteMcpServerRecord {
    id: string
    label: string
    url: string
    transport: 'streamable-http'
    authType: RemoteMcpAuthType
    enabled: boolean
    notes?: string
    createdAt: number
    updatedAt: number
    lastCheckedAt?: number
    lastToolCount?: number
    lastError?: string
}

export interface RemoteMcpServerStatus {
    id: string
    label: string
    url: string
    transport: 'streamable-http'
    authType: RemoteMcpAuthType
    enabled: boolean
    configured: boolean
    connected: boolean
    needsReconnect: boolean
    toolCount: number | null
    toolsPreview: string[]
    lastCheckedAt: number | null
    error?: string
    notes?: string
}

export interface RemoteMcpIntegrationStatus {
    id: 'mcp'
    name: string
    description: string
    configured: boolean
    connected: boolean
    needsReconnect: boolean
    missingConfig: string[]
    serverCount: number
    connectedServerCount: number
    servers: RemoteMcpServerStatus[]
    capabilities: string[]
    setupPrompt: string
}

interface RemoteMcpServerStore {
    version: 1
    servers: RemoteMcpServerRecord[]
}

interface OAuthStateRecord {
    state: string
    serverId: string
    redirectUri: string
    origin: string
    createdAt: number
    expiresAt: number
}

interface OAuthStateStore {
    version: 1
    states: OAuthStateRecord[]
}

interface FileOAuthState {
    version: 1
    clientInformation?: OAuthClientInformationMixed
    tokens?: OAuthTokens
    codeVerifier?: string
    discoveryState?: OAuthDiscoveryState
}

export function listRemoteMcpServers(): RemoteMcpServerRecord[] {
    return readServerStore().servers
}

export function getRemoteMcpServer(serverId: string): RemoteMcpServerRecord | null {
    const id = cleanId(serverId)
    return listRemoteMcpServers().find(server => server.id === id) ?? null
}

export function saveRemoteMcpServer(input: {
    id?: unknown
    label?: unknown
    url?: unknown
    authType?: unknown
    enabled?: unknown
    notes?: unknown
}): RemoteMcpServerRecord {
    const url = normalizeMcpUrl(input.url)
    const label = typeof input.label === 'string' && input.label.trim()
        ? input.label.trim().slice(0, 80)
        : defaultLabelForUrl(url)
    const requestedId = typeof input.id === 'string' && input.id.trim()
        ? slugify(input.id)
        : slugify(label)
    const authType = input.authType === 'none' ? 'none' : 'oauth'
    const enabled = typeof input.enabled === 'boolean' ? input.enabled : true
    const notes = typeof input.notes === 'string' && input.notes.trim()
        ? input.notes.trim().slice(0, 500)
        : undefined

    const store = readServerStore()
    const now = Date.now()
    const existingIndex = store.servers.findIndex(server => server.id === requestedId)
    const id = existingIndex >= 0 ? requestedId : uniqueServerId(store.servers, requestedId)
    const previous = store.servers.find(server => server.id === id)
    const record: RemoteMcpServerRecord = {
        id,
        label,
        url,
        transport: 'streamable-http',
        authType,
        enabled,
        notes,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        lastCheckedAt: previous?.lastCheckedAt,
        lastToolCount: previous?.lastToolCount,
        lastError: previous?.lastError,
    }

    const nextServers = previous
        ? store.servers.map(server => server.id === id ? record : server)
        : [...store.servers, record]
    writeServerStore({ version: 1, servers: nextServers })
    return record
}

export function removeRemoteMcpServer(serverId: string): boolean {
    const id = cleanId(serverId)
    const store = readServerStore()
    const next = store.servers.filter(server => server.id !== id)
    if (next.length === store.servers.length) return false
    writeServerStore({ version: 1, servers: next })
    removeOAuthFile(id)
    return true
}

export function disconnectRemoteMcpServer(serverId: string): boolean {
    const id = cleanId(serverId)
    if (!getRemoteMcpServer(id)) return false
    removeOAuthFile(id)
    return true
}

export async function getRemoteMcpIntegrationStatus(
    origin: string,
    probe = true
): Promise<RemoteMcpIntegrationStatus> {
    void origin
    const servers = listRemoteMcpServers()
    const statuses = await Promise.all(servers.map(server => statusForServer(server, probe)))
    const connectedServerCount = statuses.filter(item => item.connected).length
    return {
        id: 'mcp',
        name: 'Remote MCP servers',
        description: 'Custom remote Model Context Protocol servers connected over Streamable HTTP. OAuth tokens are stored locally per profile.',
        configured: servers.length > 0,
        connected: connectedServerCount > 0,
        needsReconnect: statuses.some(item => item.needsReconnect),
        missingConfig: servers.length > 0 ? [] : ['Add at least one remote MCP endpoint.'],
        serverCount: servers.length,
        connectedServerCount,
        servers: statuses,
        capabilities: [
            'Save any remote Streamable HTTP MCP endpoint.',
            'Complete MCP OAuth in the browser when the server requires it.',
            'List server tools and call them through a guarded generic wrapper.',
        ],
        setupPrompt: 'Add a remote MCP server to Orchestrator. Ask me for the MCP endpoint URL, a short label, whether it uses OAuth, then configure it and start OAuth if needed.',
    }
}

export async function startRemoteMcpOAuth(args: {
    serverId: string
    origin: string
}): Promise<{ authUrl?: string; redirectUri: string; server: RemoteMcpServerRecord; alreadyAuthorized: boolean }> {
    const server = requireServer(args.serverId)
    if (server.authType !== 'oauth') {
        throw new Error(`${server.label} is configured without OAuth.`)
    }
    const redirectUri = mcpRedirectUri(args.origin)
    const state = randomBytes(32).toString('base64url')
    writeOAuthStates([
        ...readOAuthStates().filter(item => item.expiresAt > Date.now()),
        {
            state,
            serverId: server.id,
            redirectUri,
            origin: args.origin,
            createdAt: Date.now(),
            expiresAt: Date.now() + STATE_TTL_MS,
        },
    ])

    const provider = new FileOAuthProvider(server, redirectUri, state)
    const result = await auth(provider, {
        serverUrl: server.url,
        fetchFn: timeoutFetch(DEFAULT_TIMEOUT_MS),
    })
    if (result === 'AUTHORIZED') {
        return { redirectUri, server, alreadyAuthorized: true }
    }
    const authUrl = provider.authorizationUrl
    if (!authUrl) throw new Error('MCP server did not return an OAuth authorization URL.')
    return { authUrl, redirectUri, server, alreadyAuthorized: false }
}

export async function completeRemoteMcpOAuth(args: {
    origin: string
    code: string
    state: string
}): Promise<{ server: RemoteMcpServerRecord; toolCount: number | null }> {
    const state = consumeOAuthState(args.state)
    if (!state) throw new Error('OAuth state is missing or expired. Start MCP login again.')
    const server = requireServer(state.serverId)
    const redirectUri = mcpRedirectUri(args.origin)
    if (state.redirectUri !== redirectUri) {
        throw new Error('OAuth redirect URI changed while login was in progress. Start MCP login again.')
    }
    const provider = new FileOAuthProvider(server, redirectUri)
    await auth(provider, {
        serverUrl: server.url,
        authorizationCode: args.code,
        fetchFn: timeoutFetch(DEFAULT_TIMEOUT_MS),
    })

    let toolCount: number | null = null
    try {
        const tools = await listRemoteMcpTools(server.id)
        toolCount = tools.tools.length
    } catch {
        toolCount = null
    }
    return { server, toolCount }
}

export async function listRemoteMcpTools(serverId: string): Promise<{
    server: Pick<RemoteMcpServerRecord, 'id' | 'label' | 'url'>
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>
}> {
    const server = requireServer(serverId)
    const result = await withConnectedMcpClient(server, async client => {
        const listed = await client.listTools({}, { timeout: DEFAULT_TIMEOUT_MS })
        return listed.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        }))
    })
    updateServerProbe(server.id, {
        lastCheckedAt: Date.now(),
        lastToolCount: result.length,
        lastError: undefined,
    })
    return {
        server: { id: server.id, label: server.label, url: server.url },
        tools: result,
    }
}

export async function callRemoteMcpTool(args: {
    serverId: string
    toolName: string
    toolArgs?: Record<string, unknown>
    confirmedByUser?: boolean
}): Promise<unknown> {
    const server = requireServer(args.serverId)
    const toolName = args.toolName.trim()
    if (!toolName) throw new Error('Missing MCP tool name.')
    if (requiresConfirmation(toolName) && args.confirmedByUser !== true) {
        throw new Error(`${toolName} looks like a mutating, outreach, enrichment, or credit-consuming MCP action. Get explicit user approval, then call again with confirmed_by_user=true.`)
    }
    return withConnectedMcpClient(server, async client => {
        return client.callTool(
            { name: toolName, arguments: args.toolArgs ?? {} },
            undefined,
            { timeout: DEFAULT_TIMEOUT_MS }
        )
    })
}

function requiresConfirmation(toolName: string): boolean {
    return /(^|[_\-\s])(create|update|delete|remove|send|enrich|enrichment|enroll|add|write|post|publish|trash|archive|unsubscribe|sequence|call|charge|purchase|buy)([_\-\s]|$)/i.test(toolName)
}

async function statusForServer(
    server: RemoteMcpServerRecord,
    probe: boolean
): Promise<RemoteMcpServerStatus> {
    if (!server.enabled) {
        return baseServerStatus(server, {
            connected: false,
            needsReconnect: false,
            error: 'Disabled',
        })
    }
    if (server.authType === 'oauth' && !oauthTokensExist(server.id)) {
        return baseServerStatus(server, {
            connected: false,
            needsReconnect: false,
            error: 'OAuth not connected',
        })
    }
    if (!probe) {
        return baseServerStatus(server, {
            connected: false,
            needsReconnect: false,
        })
    }
    try {
        const listed = await listRemoteMcpTools(server.id)
        return baseServerStatus(server, {
            connected: true,
            needsReconnect: false,
            toolCount: listed.tools.length,
            toolsPreview: listed.tools.slice(0, 8).map(tool => tool.name),
            error: undefined,
        })
    } catch (err) {
        const message = err instanceof Error ? err.message : 'MCP probe failed'
        updateServerProbe(server.id, {
            lastCheckedAt: Date.now(),
            lastError: message,
        })
        return baseServerStatus(server, {
            connected: false,
            needsReconnect: server.authType === 'oauth',
            error: message,
        })
    }
}

function baseServerStatus(
    server: RemoteMcpServerRecord,
    patch: Partial<RemoteMcpServerStatus>
): RemoteMcpServerStatus {
    return {
        id: server.id,
        label: server.label,
        url: server.url,
        transport: server.transport,
        authType: server.authType,
        enabled: server.enabled,
        configured: true,
        connected: false,
        needsReconnect: false,
        toolCount: server.lastToolCount ?? null,
        toolsPreview: [],
        lastCheckedAt: server.lastCheckedAt ?? null,
        error: server.lastError,
        notes: server.notes,
        ...patch,
    }
}

async function withConnectedMcpClient<T>(
    server: RemoteMcpServerRecord,
    fn: (client: Client, transport: StreamableHTTPClientTransport) => Promise<T>
): Promise<T> {
    if (!server.enabled) throw new Error(`${server.label} is disabled.`)
    const provider = server.authType === 'oauth'
        ? new FileOAuthProvider(server, mcpRedirectUri('http://localhost:3000'))
        : undefined
    if (server.authType === 'oauth' && !oauthTokensExist(server.id)) {
        throw new Error(`${server.label} needs OAuth. Start MCP OAuth first.`)
    }
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        authProvider: provider,
        fetch: timeoutFetch(DEFAULT_TIMEOUT_MS),
    })
    const client = new Client({ name: 'orchestrator', version: '0.1.0' })
    try {
        await client.connect(transport, { timeout: DEFAULT_TIMEOUT_MS })
        return await fn(client, transport)
    } catch (err) {
        if (err instanceof UnauthorizedError) {
            throw new Error(`${server.label} OAuth is not authorized or has expired. Start MCP OAuth again.`)
        }
        throw err
    } finally {
        try {
            await client.close()
        } catch {
            try { await transport.close() } catch { /* ignore close failures */ }
        }
    }
}

function normalizeMcpUrl(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('MCP server URL is required.')
    let parsed: URL
    try {
        parsed = new URL(raw.trim())
    } catch {
        throw new Error('MCP server URL must be a valid URL.')
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('MCP server URL must use http or https.')
    }
    if (parsed.protocol === 'http:' && !isLocalHttpHost(parsed.hostname)) {
        throw new Error('Plain HTTP MCP endpoints are allowed only for localhost/private testing. Use HTTPS for remote servers.')
    }
    return parsed.toString()
}

function isLocalHttpHost(hostname: string): boolean {
    return hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname.endsWith('.local')
}

function defaultLabelForUrl(url: string): string {
    try {
        return new URL(url).hostname.replace(/^mcp\./, '') || 'MCP server'
    } catch {
        return 'MCP server'
    }
}

function slugify(value: string): string {
    const clean = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50)
    return clean || 'mcp-server'
}

function cleanId(value: string): string {
    return slugify(value)
}

function uniqueServerId(servers: RemoteMcpServerRecord[], base: string): string {
    const used = new Set(servers.map(server => server.id))
    if (!used.has(base)) return base
    for (let i = 2; i < 1000; i++) {
        const candidate = `${base}-${i}`
        if (!used.has(candidate)) return candidate
    }
    return `${base}-${randomBytes(4).toString('hex')}`
}

function requireServer(serverId: string): RemoteMcpServerRecord {
    const server = getRemoteMcpServer(serverId)
    if (!server) throw new Error(`Unknown MCP server: ${serverId}`)
    return server
}

function updateServerProbe(
    serverId: string,
    patch: Pick<RemoteMcpServerRecord, 'lastCheckedAt'> & Partial<Pick<RemoteMcpServerRecord, 'lastToolCount' | 'lastError'>>
): void {
    const store = readServerStore()
    const next = store.servers.map(server => server.id === serverId
        ? {
            ...server,
            lastCheckedAt: patch.lastCheckedAt,
            lastToolCount: patch.lastToolCount ?? server.lastToolCount,
            lastError: Object.prototype.hasOwnProperty.call(patch, 'lastError') ? patch.lastError : server.lastError,
        }
        : server)
    writeServerStore({ version: 1, servers: next })
}

function readServerStore(): RemoteMcpServerStore {
    const parsed = readJson(serverStorePath())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { version: 1, servers: [] }
    }
    const raw = parsed as Partial<RemoteMcpServerStore>
    const servers = Array.isArray(raw.servers)
        ? raw.servers.filter(isServerRecord)
        : []
    return { version: 1, servers }
}

function writeServerStore(store: RemoteMcpServerStore): void {
    writeJson(serverStorePath(), store)
}

function isServerRecord(value: unknown): value is RemoteMcpServerRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const raw = value as Partial<RemoteMcpServerRecord>
    return typeof raw.id === 'string' &&
        typeof raw.label === 'string' &&
        typeof raw.url === 'string' &&
        raw.transport === 'streamable-http' &&
        (raw.authType === 'oauth' || raw.authType === 'none') &&
        typeof raw.enabled === 'boolean' &&
        typeof raw.createdAt === 'number' &&
        typeof raw.updatedAt === 'number'
}

function readOAuthStates(): OAuthStateRecord[] {
    const parsed = readJson(oauthStatesPath())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const raw = parsed as Partial<OAuthStateStore>
    return Array.isArray(raw.states)
        ? raw.states.filter(isOAuthStateRecord)
        : []
}

function writeOAuthStates(states: OAuthStateRecord[]): void {
    writeJson(oauthStatesPath(), { version: 1, states })
}

function consumeOAuthState(state: string): OAuthStateRecord | null {
    const now = Date.now()
    let found: OAuthStateRecord | null = null
    const remaining = readOAuthStates().filter(item => {
        if (item.expiresAt <= now) return false
        if (item.state === state) {
            found = item
            return false
        }
        return true
    })
    writeOAuthStates(remaining)
    return found
}

function isOAuthStateRecord(value: unknown): value is OAuthStateRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const raw = value as Partial<OAuthStateRecord>
    return typeof raw.state === 'string' &&
        typeof raw.serverId === 'string' &&
        typeof raw.redirectUri === 'string' &&
        typeof raw.origin === 'string' &&
        typeof raw.createdAt === 'number' &&
        typeof raw.expiresAt === 'number'
}

class FileOAuthProvider implements OAuthClientProvider {
    authorizationUrl?: string

    constructor(
        private readonly server: RemoteMcpServerRecord,
        private readonly redirect: string,
        private readonly oauthState?: string
    ) {}

    get redirectUrl(): string {
        return this.redirect
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            redirect_uris: [this.redirect],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            client_name: `Orchestrator MCP (${this.server.label})`,
        }
    }

    state(): string {
        return this.oauthState ?? ''
    }

    clientInformation(): OAuthClientInformationMixed | undefined {
        return this.read().clientInformation
    }

    saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
        this.write({ ...this.read(), clientInformation })
    }

    tokens(): OAuthTokens | undefined {
        return this.read().tokens
    }

    saveTokens(tokens: OAuthTokens): void {
        this.write({ ...this.read(), tokens })
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        this.authorizationUrl = authorizationUrl.toString()
    }

    saveCodeVerifier(codeVerifier: string): void {
        this.write({ ...this.read(), codeVerifier })
    }

    codeVerifier(): string {
        const verifier = this.read().codeVerifier
        if (!verifier) throw new Error('No MCP OAuth code verifier saved. Start MCP OAuth again.')
        return verifier
    }

    saveDiscoveryState(state: OAuthDiscoveryState): void {
        this.write({ ...this.read(), discoveryState: state })
    }

    discoveryState(): OAuthDiscoveryState | undefined {
        return this.read().discoveryState
    }

    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
        const current = this.read()
        if (scope === 'all') {
            this.write({ version: 1 })
            return
        }
        const next = { ...current }
        if (scope === 'client') delete next.clientInformation
        if (scope === 'tokens') delete next.tokens
        if (scope === 'verifier') delete next.codeVerifier
        if (scope === 'discovery') delete next.discoveryState
        this.write(next)
    }

    private read(): FileOAuthState {
        const parsed = readJson(oauthPath(this.server.id))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { version: 1 }
        }
        return { version: 1, ...(parsed as Partial<FileOAuthState>) }
    }

    private write(state: FileOAuthState): void {
        writeJson(oauthPath(this.server.id), { ...state, version: 1 })
    }
}

function oauthTokensExist(serverId: string): boolean {
    const parsed = readJson(oauthPath(serverId))
    return Boolean(
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (parsed as Partial<FileOAuthState>).tokens?.access_token
    )
}

function removeOAuthFile(serverId: string): void {
    try {
        fs.unlinkSync(oauthPath(serverId))
    } catch {
        // Already gone.
    }
}

function mcpRedirectUri(origin: string): string {
    return resolveOAuthRedirectUri(null, origin, CALLBACK_PATH)
}

function timeoutFetch(timeoutMs: number): typeof fetch {
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
            return await fetch(input, { ...init, signal: init?.signal ?? controller.signal })
        } finally {
            clearTimeout(timer)
        }
    }) as typeof fetch
}

function readJson(filePath: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    } catch {
        return null
    }
}

function writeJson(filePath: string, data: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
    })
}

function mcpDir(): string {
    return path.join(activeRuntimePaths().privateStateDir, MCP_DIR)
}

function serverStorePath(): string {
    return path.join(mcpDir(), SERVERS_FILE)
}

function oauthStatesPath(): string {
    return path.join(mcpDir(), STATES_FILE)
}

function oauthPath(serverId: string): string {
    return path.join(mcpDir(), OAUTH_DIR, `${cleanId(serverId)}.json`)
}
