import { NextResponse } from 'next/server'

import { getBinding } from '@/lib/cli/mcp-bindings'
import { executeTool } from '@/lib/ai/tools/executor'

/**
 * MCP-server proxy endpoint.
 *
 * Our stdio MCP server (lib/cli/mcp-server.mjs) is a separate child process
 * spawned by Claude Code; it doesn't share JS state with us. To bridge the
 * gap it POSTs here with an opaque token (issued at CLI launch time) plus the
 * tool request. We look up the binding, execute the tool with the right
 * `ToolExecutionContext`, and hand the result back.
 *
 * Two actions:
 *   action=list → return tool defs in MCP shape (name/description/inputSchema)
 *   action=call → run the tool, return its `ToolResult`
 */

interface ListBody { token: string; action: 'list' }
interface CallBody {
    token: string
    action: 'call'
    tool: string
    args?: Record<string, unknown>
}
type Body = ListBody | CallBody

export async function POST(req: Request) {
    let body: Body
    try {
        body = await req.json()
    } catch {
        return NextResponse.json({ error: 'invalid json' }, { status: 400 })
    }

    if (!body?.token || typeof body.token !== 'string') {
        return NextResponse.json({ error: 'missing token' }, { status: 400 })
    }
    const binding = getBinding(body.token)
    if (!binding) {
        return NextResponse.json({ error: 'unknown or expired token' }, { status: 401 })
    }

    if (body.action === 'list') {
        // Map our ToolDef shape onto MCP's tool descriptor shape. Names go
        // through as-is; Claude Code prefixes them with `mcp__<server>__` when
        // surfacing tool_use blocks, but the model sees the bare name.
        const tools = binding.toolDefs.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.input_schema,
        }))
        return NextResponse.json({ tools })
    }

    if (body.action === 'call') {
        if (!body.tool || typeof body.tool !== 'string') {
            return NextResponse.json({ error: 'missing tool name' }, { status: 400 })
        }
        const tool = binding.toolDefs.find(t => t.name === body.tool || t.id === body.tool)
        if (!tool) {
            return NextResponse.json(
                { error: `unknown tool: ${body.tool}` },
                { status: 404 }
            )
        }
        const args = (body.args && typeof body.args === 'object') ? body.args : {}
        const result = await executeTool(tool, args, binding.ctx)
        return NextResponse.json({ result })
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
