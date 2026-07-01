import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import {
    callRemoteMcpTool,
    disconnectRemoteMcpServer,
    getRemoteMcpIntegrationStatus,
    listRemoteMcpTools,
    removeRemoteMcpServer,
    saveRemoteMcpServer,
    startRemoteMcpOAuth,
} from '@/lib/integrations/mcp'

function toolOrigin(ctx?: ToolExecutionContext): string {
    return ctx?.appOrigin ?? process.env.ORCHESTRATOR_PUBLIC_URL ?? 'http://localhost:3000'
}

export const remoteMcpStatusTool: ToolDef = {
    id: 'RemoteMcpStatus',
    name: 'RemoteMcpStatus',
    description: 'Lists configured remote MCP servers and verifies which ones are connected. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            probe: {
                type: 'boolean',
                description: 'Whether to connect to each configured server and list tools. Defaults to true.',
            },
        },
    },
    tags: ['read', 'mcp', 'setup'],
}

export const remoteMcpConfigureTool: ToolDef = {
    id: 'RemoteMcpConfigure',
    name: 'RemoteMcpConfigure',
    description: [
        'Adds or updates one remote MCP server in Orchestrator.',
        'Use for Streamable HTTP MCP endpoints only (for example https://example.com/mcp).',
        'Choose auth_type="oauth" when the server uses browser OAuth; choose "none" only for a trusted no-auth/local endpoint.',
        'Before connecting a third-party MCP, confirm with the user that the endpoint is trusted and that their AI/client data-retention settings fit the service policy.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            id: {
                type: 'string',
                description: 'Optional stable slug. If omitted, Orchestrator derives one from label.',
            },
            label: {
                type: 'string',
                description: 'Short display name shown in Settings -> Integrations.',
            },
            url: {
                type: 'string',
                description: 'Remote MCP endpoint URL. Must be HTTPS unless it is a localhost/.local test endpoint.',
            },
            auth_type: {
                type: 'string',
                enum: ['oauth', 'none'],
                description: 'Authentication mode. Defaults to oauth.',
            },
            enabled: {
                type: 'boolean',
                description: 'Whether the server should be usable. Defaults to true.',
            },
            notes: {
                type: 'string',
                description: 'Optional non-secret note about provider limits, credit policy, or intended use.',
            },
        },
        required: ['url'],
    },
    tags: ['write', 'mcp', 'setup'],
}

export const remoteMcpStartOAuthTool: ToolDef = {
    id: 'RemoteMcpStartOAuth',
    name: 'RemoteMcpStartOAuth',
    description: 'Starts browser OAuth for one configured remote MCP server and returns the consent URL. Do not claim connection succeeded until RemoteMcpStatus confirms it.',
    input_schema: {
        type: 'object',
        properties: {
            server_id: {
                type: 'string',
                description: 'Configured MCP server id.',
            },
        },
        required: ['server_id'],
    },
    tags: ['write', 'mcp', 'setup'],
}

export const remoteMcpDisconnectTool: ToolDef = {
    id: 'RemoteMcpDisconnect',
    name: 'RemoteMcpDisconnect',
    description: 'Removes stored OAuth tokens for one remote MCP server without deleting the server config.',
    input_schema: {
        type: 'object',
        properties: {
            server_id: { type: 'string', description: 'Configured MCP server id.' },
        },
        required: ['server_id'],
    },
    tags: ['write', 'mcp', 'setup'],
}

export const remoteMcpRemoveTool: ToolDef = {
    id: 'RemoteMcpRemove',
    name: 'RemoteMcpRemove',
    description: 'Deletes one remote MCP server config and any locally stored OAuth tokens. Confirm with the user first.',
    input_schema: {
        type: 'object',
        properties: {
            server_id: { type: 'string', description: 'Configured MCP server id.' },
            confirmed_by_user: {
                type: 'boolean',
                description: 'Must be true after explicit user confirmation.',
            },
        },
        required: ['server_id', 'confirmed_by_user'],
    },
    tags: ['write', 'mcp', 'setup'],
}

export const remoteMcpListToolsTool: ToolDef = {
    id: 'RemoteMcpListTools',
    name: 'RemoteMcpListTools',
    description: 'Lists the live tool names, descriptions, and input schemas exposed by one connected remote MCP server. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            server_id: { type: 'string', description: 'Configured MCP server id.' },
        },
        required: ['server_id'],
    },
    tags: ['read', 'mcp'],
}

export const remoteMcpCallTool: ToolDef = {
    id: 'RemoteMcpCallTool',
    name: 'RemoteMcpCallTool',
    description: [
        'Calls one tool on one connected remote MCP server.',
        'First call RemoteMcpListTools and match the returned input schema exactly.',
        'For any tool that mutates provider state, sends outreach, enrolls contacts, enriches data, purchases/charges, or may consume provider credits, get explicit user approval and set confirmed_by_user=true.',
        'The executor blocks obviously risky tool names until confirmed_by_user=true.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            server_id: { type: 'string', description: 'Configured MCP server id.' },
            tool_name: { type: 'string', description: 'Exact remote MCP tool name.' },
            arguments: {
                type: 'object',
                description: 'Arguments object matching the remote MCP tool input schema.',
                additionalProperties: true,
            },
            confirmed_by_user: {
                type: 'boolean',
                description: 'True only after explicit user approval for mutating, outreach, enrichment, or credit-consuming calls.',
            },
        },
        required: ['server_id', 'tool_name', 'arguments'],
    },
    tags: ['write', 'mcp'],
}

export const remoteMcpTools: ToolDef[] = [
    remoteMcpStatusTool,
    remoteMcpConfigureTool,
    remoteMcpStartOAuthTool,
    remoteMcpDisconnectTool,
    remoteMcpRemoveTool,
    remoteMcpListToolsTool,
    remoteMcpCallTool,
]

export async function executeRemoteMcpStatus(
    args?: Record<string, unknown>,
    ctx?: ToolExecutionContext
): Promise<ToolResult> {
    const probe = args?.probe !== false
    return {
        success: true,
        data: await getRemoteMcpIntegrationStatus(toolOrigin(ctx), probe),
    }
}

export async function executeRemoteMcpConfigure(args: Record<string, unknown>): Promise<ToolResult> {
    try {
        const server = saveRemoteMcpServer({
            id: args.id ?? args.server_id,
            label: args.label,
            url: args.url,
            authType: args.auth_type ?? args.authType,
            enabled: args.enabled,
            notes: args.notes,
        })
        return {
            success: true,
            data: {
                server,
                next: server.authType === 'oauth'
                    ? `Call RemoteMcpStartOAuth with server_id="${server.id}".`
                    : `Call RemoteMcpListTools with server_id="${server.id}" to verify available tools.`,
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Could not save MCP server.' }
    }
}

export async function executeRemoteMcpStartOAuth(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext
): Promise<ToolResult> {
    const serverId = typeof args.server_id === 'string'
        ? args.server_id
        : typeof args.serverId === 'string'
            ? args.serverId
            : ''
    if (!serverId) return { success: false, error: 'server_id is required.' }
    try {
        return {
            success: true,
            data: await startRemoteMcpOAuth({ serverId, origin: toolOrigin(ctx) }),
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Could not start MCP OAuth.' }
    }
}

export async function executeRemoteMcpDisconnect(args: Record<string, unknown>): Promise<ToolResult> {
    const serverId = typeof args.server_id === 'string'
        ? args.server_id
        : typeof args.serverId === 'string'
            ? args.serverId
            : ''
    if (!serverId) return { success: false, error: 'server_id is required.' }
    return { success: true, data: { disconnected: disconnectRemoteMcpServer(serverId) } }
}

export async function executeRemoteMcpRemove(args: Record<string, unknown>): Promise<ToolResult> {
    const serverId = typeof args.server_id === 'string'
        ? args.server_id
        : typeof args.serverId === 'string'
            ? args.serverId
            : ''
    if (!serverId) return { success: false, error: 'server_id is required.' }
    if (args.confirmed_by_user !== true && args.confirmedByUser !== true) {
        return { success: false, error: 'Get explicit user confirmation, then call again with confirmed_by_user=true.' }
    }
    return { success: true, data: { removed: removeRemoteMcpServer(serverId) } }
}

export async function executeRemoteMcpListTools(args: Record<string, unknown>): Promise<ToolResult> {
    const serverId = typeof args.server_id === 'string'
        ? args.server_id
        : typeof args.serverId === 'string'
            ? args.serverId
            : ''
    if (!serverId) return { success: false, error: 'server_id is required.' }
    try {
        return { success: true, data: await listRemoteMcpTools(serverId) }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Could not list MCP tools.' }
    }
}

export async function executeRemoteMcpCallTool(args: Record<string, unknown>): Promise<ToolResult> {
    const serverId = typeof args.server_id === 'string'
        ? args.server_id
        : typeof args.serverId === 'string'
            ? args.serverId
            : ''
    const toolName = typeof args.tool_name === 'string'
        ? args.tool_name
        : typeof args.toolName === 'string'
            ? args.toolName
            : ''
    const toolArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
        ? args.arguments as Record<string, unknown>
        : {}
    if (!serverId) return { success: false, error: 'server_id is required.' }
    if (!toolName) return { success: false, error: 'tool_name is required.' }
    try {
        const result = await callRemoteMcpTool({
            serverId,
            toolName,
            toolArgs,
            confirmedByUser: args.confirmed_by_user === true || args.confirmedByUser === true,
        })
        return { success: true, data: result }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Could not call MCP tool.' }
    }
}
