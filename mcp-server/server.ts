#!/usr/bin/env -S npx tsx
// Bootstrap MUST be the first import: it sets cwd, loads .env, and
// redirects console.* to stderr before any app/sdk code runs.
import './bootstrap.js'

import { randomUUID } from 'crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import type { ToolExecutionContext } from '@/lib/ai/agents/types'
import { delegateToTool } from '@/lib/ai/tools/delegate-to'
import { findPastUploadsTool, executeFindPastUploads } from '@/lib/ai/tools/find-past-uploads'
import {
    cancelTaskTool,
    executeCancelTask,
    executeListTasks,
    executeScheduleTask,
    listTasksTool,
    scheduleTaskTool,
} from '@/lib/ai/tools/schedule'
import { getAgent } from '@/lib/ai/agents/registry'
import { runTextSubAgent } from '@/lib/ai/agents/runner'

const SERVER_NAME = 'orchestrator'
const SERVER_VERSION = '0.1.0'

const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
)

const TOOL_DEFS = [delegateToTool, scheduleTaskTool, listTasksTool, cancelTaskTool, findPastUploadsTool]

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input_schema as unknown as Record<string, unknown>,
    })),
}))

function toolResultToContent(result: { success: boolean; data?: unknown; error?: string }) {
    if (!result.success) {
        return {
            content: [{ type: 'text' as const, text: result.error ?? 'Tool failed' }],
            isError: true,
        }
    }
    return {
        content: [{
            type: 'text' as const,
            text: typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2),
        }],
    }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name
    const toolArgs = (request.params.arguments ?? {}) as Record<string, unknown>

    if (toolName === scheduleTaskTool.name) {
        return toolResultToContent(await executeScheduleTask(toolArgs))
    }
    if (toolName === listTasksTool.name) {
        return toolResultToContent(await executeListTasks())
    }
    if (toolName === cancelTaskTool.name) {
        return toolResultToContent(await executeCancelTask(toolArgs))
    }
    if (toolName === findPastUploadsTool.name) {
        return toolResultToContent(executeFindPastUploads(toolArgs))
    }

    if (toolName !== delegateToTool.name) {
        return {
            content: [{ type: 'text' as const, text: `Unknown tool: ${toolName}` }],
            isError: true,
        }
    }

    const args = request.params.arguments as
        | { agent_id?: unknown; prompt?: unknown }
        | undefined
    const agentId = args?.agent_id
    const prompt = args?.prompt
    if (typeof agentId !== 'string' || typeof prompt !== 'string' || !prompt.trim()) {
        return {
            content: [
                {
                    type: 'text' as const,
                    text: 'delegate_to requires { agent_id: string, prompt: non-empty string }',
                },
            ],
            isError: true,
        }
    }

    const target = getAgent(agentId)
    if (!target) {
        return {
            content: [{ type: 'text' as const, text: `Unknown agent: ${agentId}` }],
            isError: true,
        }
    }
    if (target.kind !== 'text') {
        return {
            content: [
                {
                    type: 'text' as const,
                    text: `Delegation to ${target.kind}-kind agents is not implemented yet (agent ${agentId} is kind=${target.kind}).`,
                },
            ],
            isError: true,
        }
    }

    // Synthetic execution context. The MCP caller is an external root —
    // depth 0, no parent agent. We deliberately skip executeDelegateTo and
    // call runTextSubAgent directly so we bypass the canCallAgents check,
    // which is meant for intra-agent delegation policy. MCP gets full
    // access to anything in the registry.
    const ctx: ToolExecutionContext = {
        callerAgentId: '__mcp_external__',
        depth: 0,
        conversationId: `mcp_${randomUUID()}`,
        parentRequestId: `mcp_${randomUUID()}`,
    }

    try {
        const result = await runTextSubAgent({ target, prompt, parentCtx: ctx })
        if (!result.success) {
            return {
                content: [
                    { type: 'text' as const, text: result.error ?? 'Unknown delegation error' },
                ],
                isError: true,
            }
        }
        const data = result.data as { agentId: string; output: string }
        return {
            content: [{ type: 'text' as const, text: data.output }],
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
            content: [{ type: 'text' as const, text: `delegate_to failed: ${msg}` }],
            isError: true,
        }
    }
})

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write(`[mcp] ${SERVER_NAME}@${SERVER_VERSION} ready\n`)
