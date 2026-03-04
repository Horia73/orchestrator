import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { reloadConfigJson, updateConfigSection } from '../core/config.js';
import { truncateText } from '../tools/_utils.js';

const MCP_SECTION_NAME = 'mcp';
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const TOOL_CACHE_TTL_MS = 60_000;
const STDERR_BUFFER_MAX_CHARS = 8_000;
const TOOL_TEXT_MAX_CHARS = 8_000;
const RESOURCE_TEXT_MAX_CHARS = 8_000;

function normalizeTransport(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'sse') {
        return 'sse';
    }

    if (
        normalized === 'http'
        || normalized === 'streamable-http'
        || normalized === 'streamable_http'
        || normalized === 'streamable'
    ) {
        return 'streamable-http';
    }

    return 'stdio';
}

function normalizeTimeoutMs(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_REQUEST_TIMEOUT_MS;
    }

    return Math.min(300_000, Math.max(1_000, Math.trunc(parsed)));
}

function sanitizeStringList(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item ?? '').trim())
            .filter(Boolean);
    }

    if (typeof value === 'string') {
        return value
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return [];
}

function sanitizeStringMap(value) {
    const result = {};

    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [rawKey, rawValue] of Object.entries(value)) {
            const key = String(rawKey ?? '').trim();
            if (!key) {
                continue;
            }

            const normalizedValue = String(rawValue ?? '');
            result[key] = normalizedValue;
        }
    }

    return result;
}

function hasPersistableMcpFields(server) {
    if (!server || typeof server !== 'object') {
        return false;
    }

    return Boolean(
        String(server.name ?? '').trim()
        || String(server.toolPrefix ?? '').trim()
        || String(server.command ?? '').trim()
        || String(server.cwd ?? '').trim()
        || String(server.url ?? '').trim()
        || (Array.isArray(server.args) && server.args.length > 0)
        || Object.keys(server.env ?? {}).length > 0
        || Object.keys(server.headers ?? {}).length > 0
    );
}

function slugifySegment(value, fallback = 'mcp') {
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

    return normalized || fallback;
}

function sanitizeToolNameSegment(value, fallback = 'tool') {
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');

    return normalized || fallback;
}

function sanitizeMcpServer(rawServer) {
    const source = rawServer && typeof rawServer === 'object' ? rawServer : {};
    const transport = normalizeTransport(source.transport);
    const id = String(source.id ?? '').trim() || `mcp-${randomUUID().slice(0, 8)}`;
    const name = String(source.name ?? '').trim();
    const toolPrefix = String(source.toolPrefix ?? '').trim();
    const enabled = source.enabled !== false;
    const timeoutMs = normalizeTimeoutMs(source.timeoutMs);

    const base = {
        id,
        name,
        toolPrefix,
        enabled,
        transport,
        timeoutMs,
    };

    if (transport === 'stdio') {
        return {
            ...base,
            command: String(source.command ?? '').trim(),
            args: sanitizeStringList(source.args),
            cwd: String(source.cwd ?? '').trim(),
            env: sanitizeStringMap(source.env),
        };
    }

    return {
        ...base,
        url: String(source.url ?? '').trim(),
        headers: sanitizeStringMap(source.headers),
    };
}

function buildValidationErrors(server) {
    const errors = [];

    if (!String(server.name ?? '').trim()) {
        errors.push('Name is required.');
    }

    if (server.transport === 'stdio') {
        if (!String(server.command ?? '').trim()) {
            errors.push('Command is required for stdio servers.');
        }
    } else {
        const url = String(server.url ?? '').trim();
        if (!url) {
            errors.push('URL is required for remote MCP servers.');
        } else {
            try {
                new URL(url);
            } catch {
                errors.push('URL must be valid.');
            }
        }
    }

    return errors;
}

function getServerFingerprint(server) {
    return JSON.stringify({
        id: server.id,
        name: server.name,
        toolPrefix: server.toolPrefix,
        enabled: server.enabled,
        transport: server.transport,
        timeoutMs: server.timeoutMs,
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        env: server.env,
        url: server.url,
        headers: server.headers,
    });
}

function readMcpSection() {
    const config = reloadConfigJson();
    const section = config?.[MCP_SECTION_NAME];
    if (!section || typeof section !== 'object') {
        return {};
    }

    return section;
}

export function readMcpServers() {
    const section = readMcpSection();
    const rawServers = Array.isArray(section.servers) ? section.servers : [];
    return rawServers
        .map(sanitizeMcpServer)
        .filter(hasPersistableMcpFields);
}

export function writeMcpServers(rawServers) {
    const currentSection = readMcpSection();
    const servers = Array.isArray(rawServers)
        ? rawServers.map(sanitizeMcpServer).filter(hasPersistableMcpFields)
        : [];
    updateConfigSection(MCP_SECTION_NAME, {
        ...currentSection,
        servers,
    });
    return servers;
}

function computeEffectivePrefixes(servers) {
    const effectivePrefixes = new Map();
    const used = new Set();

    for (const server of servers) {
        const preferred = slugifySegment(server.toolPrefix || server.name || server.id, 'mcp');
        let candidate = preferred;
        let suffix = 2;

        while (used.has(candidate)) {
            candidate = `${preferred}_${suffix}`;
            suffix += 1;
        }

        used.add(candidate);
        effectivePrefixes.set(server.id, candidate);
    }

    return effectivePrefixes;
}

function appendStderrBuffer(entry, chunk) {
    const nextChunk = String(chunk ?? '');
    if (!nextChunk) {
        return;
    }

    const combined = `${entry.stderrBuffer || ''}${nextChunk}`;
    if (combined.length <= STDERR_BUFFER_MAX_CHARS) {
        entry.stderrBuffer = combined;
        return;
    }

    entry.stderrBuffer = combined.slice(combined.length - STDERR_BUFFER_MAX_CHARS);
}

function formatEntryError(entry, error) {
    const message = String(error?.message ?? error ?? 'Unknown MCP error').trim() || 'Unknown MCP error';
    const stderr = String(entry?.stderrBuffer ?? '').trim();
    if (!stderr) {
        return message;
    }

    return `${message}\n\n[stderr]\n${truncateText(stderr, 2_000)}`;
}

function simplifyResource(resource) {
    const uri = String(resource?.uri ?? '').trim();
    const mimeType = String(resource?.mimeType ?? '').trim();

    if (typeof resource?.text === 'string') {
        return {
            uri,
            mimeType: mimeType || 'text/plain',
            text: truncateText(resource.text, RESOURCE_TEXT_MAX_CHARS),
        };
    }

    const blob = String(resource?.blob ?? '').trim();
    return {
        uri,
        mimeType: mimeType || 'application/octet-stream',
        blobBytesApprox: blob ? Math.floor((blob.length * 3) / 4) : 0,
    };
}

function convertMcpResultToToolResult(result, { serverName, toolName } = {}) {
    const content = Array.isArray(result?.content) ? result.content : [];
    const simplifiedContent = [];
    const mediaParts = [];

    for (const item of content) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        if (item.type === 'text') {
            simplifiedContent.push({
                type: 'text',
                text: truncateText(item.text, TOOL_TEXT_MAX_CHARS),
            });
            continue;
        }

        if (item.type === 'image') {
            const mimeType = String(item.mimeType ?? '').trim();
            const data = String(item.data ?? '').trim();
            if (mimeType.startsWith('image/') && data) {
                mediaParts.push({
                    inlineData: {
                        mimeType,
                        data,
                    },
                });
            }

            simplifiedContent.push({
                type: 'image',
                mimeType,
                bytesApprox: data ? Math.floor((data.length * 3) / 4) : 0,
            });
            continue;
        }

        if (item.type === 'audio') {
            const mimeType = String(item.mimeType ?? '').trim();
            const data = String(item.data ?? '').trim();
            simplifiedContent.push({
                type: 'audio',
                mimeType,
                bytesApprox: data ? Math.floor((data.length * 3) / 4) : 0,
            });
            continue;
        }

        if (item.type === 'resource') {
            simplifiedContent.push({
                type: 'resource',
                resource: simplifyResource(item.resource),
            });
            continue;
        }

        if (item.type === 'resource_link') {
            simplifiedContent.push({
                type: 'resource_link',
                uri: String(item.uri ?? '').trim(),
                name: String(item.name ?? '').trim(),
                title: String(item.title ?? '').trim(),
                description: String(item.description ?? '').trim(),
                mimeType: String(item.mimeType ?? '').trim(),
            });
        }
    }

    const toolResult = {
        server: serverName || '',
        tool: toolName || '',
        isError: result?.isError === true,
    };

    if (result && typeof result === 'object' && 'structuredContent' in result) {
        toolResult.structuredContent = result.structuredContent ?? null;
    }

    if (result && typeof result === 'object' && 'toolResult' in result) {
        toolResult.toolResult = result.toolResult ?? null;
    }

    if (simplifiedContent.length > 0) {
        toolResult.content = simplifiedContent;
    }

    if (mediaParts.length > 0) {
        toolResult._mediaParts = mediaParts;
    }

    return toolResult;
}

function buildToolDescription(server, mcpTool) {
    const serverName = String(server.name ?? '').trim() || server.id;
    const baseDescription = String(mcpTool.description ?? '').trim();
    if (!baseDescription) {
        return `Tool from MCP server "${serverName}".`;
    }

    return `MCP server "${serverName}": ${baseDescription}`;
}

function buildToolAlias(prefix, originalName, aliasCounts) {
    const safePrefix = sanitizeToolNameSegment(prefix, 'mcp');
    const safeOriginalName = sanitizeToolNameSegment(originalName, 'tool');
    const baseAlias = `${safePrefix}__${safeOriginalName}`;
    const existing = aliasCounts.get(baseAlias) ?? 0;
    aliasCounts.set(baseAlias, existing + 1);

    if (existing === 0) {
        return baseAlias;
    }

    return `${baseAlias}_${existing + 1}`;
}

class McpService {
    constructor() {
        this.entries = new Map();
    }

    async syncConfig(servers = readMcpServers()) {
        const fingerprints = new Map(servers.map((server) => [server.id, getServerFingerprint(server)]));
        const staleIds = [];

        for (const [serverId, entry] of this.entries.entries()) {
            const nextFingerprint = fingerprints.get(serverId);
            if (!nextFingerprint || nextFingerprint !== entry.fingerprint) {
                staleIds.push(serverId);
            }
        }

        await Promise.all(staleIds.map((serverId) => this.disposeEntry(serverId)));
    }

    async disposeEntry(serverId) {
        const entry = this.entries.get(serverId);
        if (!entry) {
            return;
        }

        this.entries.delete(serverId);

        try {
            if (entry.client && typeof entry.client.close === 'function') {
                await entry.client.close();
                return;
            }
        } catch {
            // Ignore close failures.
        }

        try {
            if (entry.transport && typeof entry.transport.close === 'function') {
                await entry.transport.close();
            }
        } catch {
            // Ignore close failures.
        }
    }

    createTransport(server, entry) {
        if (server.transport === 'stdio') {
            const transport = new StdioClientTransport({
                command: server.command,
                args: Array.isArray(server.args) ? server.args : [],
                cwd: server.cwd || undefined,
                env: Object.keys(server.env ?? {}).length > 0 ? server.env : undefined,
                stderr: 'pipe',
            });

            if (transport.stderr) {
                transport.stderr.on('data', (chunk) => {
                    appendStderrBuffer(entry, chunk);
                });
            }

            return transport;
        }

        const url = new URL(server.url);
        const hasHeaders = Object.keys(server.headers ?? {}).length > 0;
        const requestInit = hasHeaders
            ? { headers: server.headers }
            : undefined;

        if (server.transport === 'sse') {
            const eventSourceInit = hasHeaders
                ? {
                    fetch: (targetUrl, init) => fetch(targetUrl, {
                        ...init,
                        headers: {
                            ...init.headers,
                            ...server.headers,
                        },
                    }),
                }
                : undefined;

            return new SSEClientTransport(url, {
                requestInit,
                eventSourceInit,
            });
        }

        return new StreamableHTTPClientTransport(url, { requestInit });
    }

    async ensureEntry(server) {
        const fingerprint = getServerFingerprint(server);
        let entry = this.entries.get(server.id);

        if (entry && entry.fingerprint !== fingerprint) {
            await this.disposeEntry(server.id);
            entry = null;
        }

        if (entry?.client) {
            return entry;
        }

        if (entry?.connectPromise) {
            await entry.connectPromise;
            return this.entries.get(server.id);
        }

        entry = {
            serverId: server.id,
            fingerprint,
            client: null,
            transport: null,
            connectPromise: null,
            tools: [],
            toolsLoadedAt: 0,
            lastError: '',
            stderrBuffer: '',
        };
        this.entries.set(server.id, entry);

        entry.connectPromise = (async () => {
            try {
                const client = new Client(
                    { name: 'orchestrator', version: '1.0.0' },
                    { capabilities: {} },
                );
                const transport = this.createTransport(server, entry);
                entry.client = client;
                entry.transport = transport;
                await client.connect(transport, { timeout: server.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS });
                entry.lastError = '';
            } catch (error) {
                entry.lastError = formatEntryError(entry, error);
                await this.disposeEntry(server.id);
                throw new Error(entry.lastError);
            } finally {
                if (this.entries.has(server.id)) {
                    const nextEntry = this.entries.get(server.id);
                    if (nextEntry) {
                        nextEntry.connectPromise = null;
                    }
                }
            }
        })();

        await entry.connectPromise;
        return this.entries.get(server.id);
    }

    async listServerTools(server, { forceRefresh = false } = {}) {
        const entry = await this.ensureEntry(server);
        if (
            !forceRefresh
            && Array.isArray(entry.tools)
            && entry.tools.length > 0
            && (Date.now() - entry.toolsLoadedAt) < TOOL_CACHE_TTL_MS
        ) {
            return entry.tools;
        }

        try {
            const response = await entry.client.listTools(undefined, {
                timeout: server.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS,
            });
            entry.tools = Array.isArray(response?.tools) ? response.tools : [];
            entry.toolsLoadedAt = Date.now();
            entry.lastError = '';
            return entry.tools;
        } catch (error) {
            entry.lastError = formatEntryError(entry, error);
            throw new Error(entry.lastError);
        }
    }

    async getActiveToolCatalog() {
        const servers = readMcpServers();
        await this.syncConfig(servers);

        const enabledServers = servers.filter((server) => server.enabled);
        const effectivePrefixes = computeEffectivePrefixes(enabledServers);
        const aliasCounts = new Map();
        const declarations = [];
        const bindings = new Map();
        const errors = [];

        for (const server of enabledServers) {
            const validationErrors = buildValidationErrors(server);
            if (validationErrors.length > 0) {
                errors.push({
                    serverId: server.id,
                    serverName: server.name,
                    message: validationErrors.join(' '),
                });
                continue;
            }

            try {
                const tools = await this.listServerTools(server);
                const effectivePrefix = effectivePrefixes.get(server.id) || slugifySegment(server.name || server.id);

                for (const tool of tools) {
                    const originalName = String(tool?.name ?? '').trim();
                    if (!originalName) {
                        continue;
                    }

                    const alias = buildToolAlias(effectivePrefix, originalName, aliasCounts);
                    const declaration = {
                        name: alias,
                        description: buildToolDescription(server, tool),
                        parametersJsonSchema: tool.inputSchema,
                    };

                    if (tool.outputSchema) {
                        declaration.responseJsonSchema = tool.outputSchema;
                    }

                    declarations.push(declaration);
                    bindings.set(alias, {
                        alias,
                        originalName,
                        serverId: server.id,
                        serverName: server.name,
                    });
                }
            } catch (error) {
                errors.push({
                    serverId: server.id,
                    serverName: server.name,
                    message: String(error?.message ?? error ?? 'Failed to load MCP tools.'),
                });
            }
        }

        return {
            declarations,
            bindings,
            errors,
        };
    }

    async callToolByAlias(alias, args) {
        const catalog = await this.getActiveToolCatalog();
        const binding = catalog.bindings.get(alias);
        if (!binding) {
            return { error: `MCP tool ${alias} was not found.` };
        }

        const server = readMcpServers().find((candidate) => candidate.id === binding.serverId);
        if (!server || server.enabled !== true) {
            return { error: `MCP server for tool ${alias} is not available.` };
        }

        const validationErrors = buildValidationErrors(server);
        if (validationErrors.length > 0) {
            return { error: validationErrors.join(' ') };
        }

        try {
            const entry = await this.ensureEntry(server);
            const result = await entry.client.callTool(
                {
                    name: binding.originalName,
                    arguments: args && typeof args === 'object' ? args : {},
                },
                undefined,
                { timeout: server.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS },
            );
            entry.lastError = '';
            return convertMcpResultToToolResult(result, {
                serverName: binding.serverName,
                toolName: binding.originalName,
            });
        } catch (error) {
            const entry = this.entries.get(server.id);
            const message = entry ? formatEntryError(entry, error) : String(error?.message ?? error ?? 'MCP tool failed.');
            return {
                error: `MCP tool ${alias} failed: ${message}`,
            };
        }
    }

    async getServersSnapshot({ includeTools = false } = {}) {
        const servers = readMcpServers();
        await this.syncConfig(servers);

        const effectivePrefixes = computeEffectivePrefixes(servers);
        const descriptors = [];

        for (const server of servers) {
            const validationErrors = buildValidationErrors(server);
            const descriptor = {
                ...server,
                effectiveToolPrefix: effectivePrefixes.get(server.id) || slugifySegment(server.name || server.id),
                validationErrors,
                connectionStatus: server.enabled ? (validationErrors.length > 0 ? 'invalid' : 'idle') : 'disabled',
                lastError: '',
                tools: [],
                toolCount: 0,
            };

            if (!includeTools || descriptor.connectionStatus !== 'idle') {
                descriptors.push(descriptor);
                continue;
            }

            try {
                const tools = await this.listServerTools(server, { forceRefresh: true });
                const aliasCounts = new Map();
                descriptor.tools = tools.map((tool) => {
                    const originalName = String(tool?.name ?? '').trim();
                    const alias = buildToolAlias(descriptor.effectiveToolPrefix, originalName, aliasCounts);
                    return {
                        alias,
                        name: originalName,
                        description: String(tool?.description ?? '').trim(),
                    };
                });
                descriptor.toolCount = descriptor.tools.length;
                descriptor.connectionStatus = 'connected';
            } catch (error) {
                descriptor.connectionStatus = 'error';
                descriptor.lastError = String(error?.message ?? error ?? 'Failed to connect to MCP server.');
            }

            descriptors.push(descriptor);
        }

        return descriptors;
    }

    async getServerSnapshot(serverId, { includeTools = false, forceRefresh = false } = {}) {
        const normalizedServerId = String(serverId ?? '').trim();
        const servers = readMcpServers();
        await this.syncConfig(servers);

        const server = servers.find((candidate) => candidate.id === normalizedServerId);
        if (!server) {
            const error = new Error('MCP server was not found.');
            error.code = 'MCP_SERVER_NOT_FOUND';
            throw error;
        }

        const effectivePrefixes = computeEffectivePrefixes(servers);
        const validationErrors = buildValidationErrors(server);
        const descriptor = {
            ...server,
            effectiveToolPrefix: effectivePrefixes.get(server.id) || slugifySegment(server.name || server.id),
            validationErrors,
            connectionStatus: server.enabled ? (validationErrors.length > 0 ? 'invalid' : 'idle') : 'disabled',
            lastError: '',
            tools: [],
            toolCount: 0,
        };

        if (!includeTools || descriptor.connectionStatus !== 'idle') {
            return descriptor;
        }

        try {
            const tools = await this.listServerTools(server, { forceRefresh });
            const aliasCounts = new Map();
            descriptor.tools = tools.map((tool) => {
                const originalName = String(tool?.name ?? '').trim();
                const alias = buildToolAlias(descriptor.effectiveToolPrefix, originalName, aliasCounts);
                return {
                    alias,
                    name: originalName,
                    description: String(tool?.description ?? '').trim(),
                };
            });
            descriptor.toolCount = descriptor.tools.length;
            descriptor.connectionStatus = 'connected';
        } catch (error) {
            descriptor.connectionStatus = 'error';
            descriptor.lastError = String(error?.message ?? error ?? 'Failed to connect to MCP server.');
        }

        return descriptor;
    }
}

export const mcpService = new McpService();
