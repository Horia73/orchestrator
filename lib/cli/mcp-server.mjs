#!/usr/bin/env node
/**
 * Stdio MCP server that exposes the orchestrator's tools to Claude Code (and
 * any other MCP-capable CLI). Spawned as a child process by the CLI when we
 * launch it with `--mcp-config '{"orch-tools":{"type":"stdio","command":"node",
 * "args":["/path/to/mcp-server.mjs"],"env":{...}}}'`.
 *
 * We don't reimplement tool logic here — the CLI lives in a separate process,
 * so we proxy every call back over HTTP to /api/cli/mcp-exec on the
 * orchestrator. The auth token in MCP_AUTH_TOKEN identifies which conversation
 * and execution context the call belongs to.
 *
 * Protocol: JSON-RPC 2.0 over stdio, line-delimited. We implement the minimal
 * MCP surface — initialize, tools/list, tools/call — that Claude Code needs.
 */

const APP_URL = process.env.MCP_APP_URL || 'http://127.0.0.1:3000'
const TOKEN = process.env.MCP_AUTH_TOKEN
if (!TOKEN) {
    process.stderr.write('mcp-server: MCP_AUTH_TOKEN missing in env\n')
    process.exit(1)
}

const SERVER_NAME = process.env.MCP_SERVER_NAME || 'orch-tools'

let toolCache = null

async function fetchTools() {
    if (toolCache) return toolCache
    const r = await fetch(`${APP_URL}/api/cli/mcp-exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, action: 'list' }),
    })
    if (!r.ok) {
        process.stderr.write(`mcp-server: list HTTP ${r.status}\n`)
        return []
    }
    const data = await r.json().catch(() => ({}))
    toolCache = Array.isArray(data.tools) ? data.tools : []
    return toolCache
}

async function callTool(name, args) {
    let r
    try {
        r = await fetch(`${APP_URL}/api/cli/mcp-exec`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: TOKEN, action: 'call', tool: name, args: args ?? {} }),
        })
    } catch (e) {
        return {
            isError: true,
            content: [{ type: 'text', text: `MCP HTTP call failed: ${e?.message ?? 'unknown'}` }],
        }
    }
    if (!r.ok) {
        return {
            isError: true,
            content: [{ type: 'text', text: `MCP HTTP error ${r.status}` }],
        }
    }
    const data = await r.json().catch(() => ({}))
    const result = data?.result
    if (!result) {
        return {
            isError: true,
            content: [{ type: 'text', text: 'MCP server returned no result' }],
        }
    }
    if (!result.success) {
        return {
            isError: true,
            content: [{ type: 'text', text: result.error || 'Tool returned an error' }],
        }
    }
    // Tool result data can be string or object — MCP wants a content array of
    // typed blocks. Stringify objects so the model sees structured output.
    const data_ = result.data
    const text = typeof data_ === 'string' ? data_ : JSON.stringify(data_ ?? null, null, 2)
    return { content: [{ type: 'text', text }] }
}

function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handleMessage(msg) {
    const id = msg.id
    const method = msg.method

    if (method === 'initialize') {
        send({
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: SERVER_NAME, version: '0.1.0' },
            },
        })
        return
    }
    if (method === 'notifications/initialized' || method === 'initialized') {
        // Notification — no response.
        return
    }
    if (method === 'tools/list') {
        const tools = await fetchTools()
        send({ jsonrpc: '2.0', id, result: { tools } })
        return
    }
    if (method === 'tools/call') {
        const { name, arguments: args } = msg.params || {}
        const result = await callTool(name, args)
        send({ jsonrpc: '2.0', id, result })
        return
    }
    if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} })
        return
    }
    if (id !== undefined && id !== null) {
        send({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not implemented: ${method}` },
        })
    }
}

// Buffer line-delimited JSON from stdin. JSON-RPC frames are one per line.
let buf = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', chunk => {
    buf += chunk
    for (;;) {
        const nl = buf.indexOf('\n')
        if (nl < 0) break
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch (e) {
            process.stderr.write(`mcp-server: parse error: ${e?.message}\n`)
            continue
        }
        // Process asynchronously; don't block the input loop.
        handleMessage(msg).catch(err => {
            process.stderr.write(`mcp-server: handler error: ${err?.message ?? err}\n`)
        })
    }
})

process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
