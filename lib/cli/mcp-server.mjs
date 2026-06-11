#!/usr/bin/env node
/**
 * Stdio MCP server that exposes the orchestrator's tools to MCP-capable CLIs.
 * Spawned as a child process by the CLI when we
 * launch it with `--mcp-config '{"orch-tools":{"type":"stdio","command":"node",
 * "args":["/path/to/mcp-server.mjs"],"env":{...}}}'`.
 *
 * We don't reimplement tool logic here — the CLI lives in a separate process,
 * so we proxy every call back over HTTP to /api/cli/mcp-exec on the
 * orchestrator. The auth token in MCP_AUTH_TOKEN identifies which conversation
 * and execution context the call belongs to.
 *
 * Protocol: JSON-RPC 2.0 over stdio, line-delimited. We implement the minimal
 * MCP surface: initialize, tools/list, and tools/call.
 */

const APP_URL = process.env.MCP_APP_URL || 'http://127.0.0.1:3000'
const TOKEN = process.env.MCP_AUTH_TOKEN
if (!TOKEN) {
    process.stderr.write('mcp-server: MCP_AUTH_TOKEN missing in env\n')
    process.exit(1)
}

const SERVER_NAME = process.env.MCP_SERVER_NAME || 'orch-tools'
const TOOLS_FILE = process.env.MCP_TOOLS_FILE

// tools/call has no deadline: a single tool (notably delegate_to → browser_agent)
// can legitimately run for many minutes. Node's global fetch (undici) otherwise
// aborts at its default 300s headersTimeout, surfacing "fetch failed" even when
// the tool actually SUCCEEDED — which made the orchestrator think delegation
// failed and re-delegate, spawning duplicate browser agents. Use a dispatcher
// with timeouts disabled (0 = no limit) for tool calls. tools/list keeps its own
// short AbortController budget below.
let callDispatcher
try {
    const { Agent } = await import('undici')
    callDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
} catch (e) {
    process.stderr.write(`mcp-server: undici dispatcher unavailable (${e?.message ?? e}); long tool calls may abort at 300s\n`)
}

let toolCache = null

async function readBundledTools() {
    if (!TOOLS_FILE) return null
    try {
        const { readFile } = await import('fs/promises')
        const raw = await readFile(TOOLS_FILE, 'utf-8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed?.tools) && parsed.tools.length > 0) {
            return parsed.tools
        }
    } catch (e) {
        process.stderr.write(`mcp-server: bundled tools unavailable (${e?.message ?? e}); falling back to HTTP list\n`)
    }
    return null
}

// Read-only retry budget for tools/list. Kept small so it stays well under
// Keep this well under typical MCP startup timeouts: a transient blip recovers
// on the first retry (localhost call), while a genuinely-down app fails in ~1.5s.
const LIST_MAX_ATTEMPTS = 4
const LIST_ATTEMPT_TIMEOUT_MS = 3000
const LIST_BACKOFF_MS = 200

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function postExec(payload, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(`${APP_URL}/api/cli/mcp-exec`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        })
    } finally {
        clearTimeout(timer)
    }
}

// tools/list is a pure read, so it's safe to retry. A single transient failure
// (connection refused, event-loop stall, 5xx) previously fell straight through
// to an empty list, which left a CLI run with no orchestrator tools. We retry
// instead, and throw on persistent failure so the caller surfaces a hard error
// rather than silently degrading to a toolless run.
async function fetchTools() {
    if (toolCache) return toolCache
    const bundled = await readBundledTools()
    if (bundled) {
        toolCache = bundled
        return bundled
    }
    let lastErr
    for (let attempt = 1; attempt <= LIST_MAX_ATTEMPTS; attempt++) {
        try {
            const r = await postExec({ token: TOKEN, action: 'list' }, LIST_ATTEMPT_TIMEOUT_MS)
            if (r.ok) {
                const data = await r.json().catch(() => ({}))
                const tools = Array.isArray(data.tools) ? data.tools : []
                if (tools.length > 0) toolCache = tools  // never cache an empty list
                return tools
            }
            lastErr = new Error(`list HTTP ${r.status}`)
            // 4xx (e.g. expired/unknown token) won't fix itself — fail fast.
            if (r.status >= 400 && r.status < 500) break
        } catch (e) {
            lastErr = e
        }
        if (attempt < LIST_MAX_ATTEMPTS) await delay(LIST_BACKOFF_MS * attempt)
    }
    throw lastErr ?? new Error('tools/list failed')
}

async function callTool(name, args) {
    let r
    try {
        r = await fetch(`${APP_URL}/api/cli/mcp-exec`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: TOKEN, action: 'call', tool: name, args: args ?? {} }),
            ...(callDispatcher ? { dispatcher: callDispatcher } : {}),
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
        try {
            const tools = await fetchTools()
            send({ jsonrpc: '2.0', id, result: { tools } })
        } catch (e) {
            // Always answer — a missing response makes the CLI hang until its
            // MCP init timeout and then run toolless. An explicit error lets it
            // fail fast (and the scheduler record the wake as failed) instead.
            process.stderr.write(`mcp-server: tools/list failed after retries: ${e?.message ?? e}\n`)
            send({
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: `tools/list failed: ${e?.message ?? 'unknown'}` },
            })
        }
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
