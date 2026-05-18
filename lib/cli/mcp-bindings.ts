import { randomUUID } from 'crypto'

import type { ToolDef, ToolExecutionContext } from '@/lib/ai/agents/types'

/**
 * In-memory token → execution context store for the MCP stdio proxy.
 *
 * When a CLI provider (claude-code, codex) is invoked, we spawn a stdio MCP
 * server as a child of the CLI process. That MCP server lives in a separate
 * process and can't share JS state with us, so it talks back via HTTP to
 * /api/cli/mcp-exec. Each invocation gets a short-lived token here; the
 * endpoint resolves the token to the original tool list + execution context.
 *
 * `globalThis` carries the map across Next.js dev hot reloads — same trick
 * `chat-streams.ts` uses — so a pending CLI run survives an edit-save cycle.
 */

interface Binding {
    ctx: ToolExecutionContext
    toolDefs: ToolDef[]
    createdAt: number
}

const globalForBindings = globalThis as unknown as {
    __orchestratorMcpBindings?: Map<string, Binding>
}

const bindings = globalForBindings.__orchestratorMcpBindings ?? new Map<string, Binding>()
if (!globalForBindings.__orchestratorMcpBindings) {
    globalForBindings.__orchestratorMcpBindings = bindings
}

/** Stale-binding sweep: drop entries older than this. */
const BINDING_TTL_MS = 30 * 60_000  // 30 minutes — well past any normal CLI turn

function sweep() {
    const cutoff = Date.now() - BINDING_TTL_MS
    for (const [token, b] of bindings) {
        if (b.createdAt < cutoff) bindings.delete(token)
    }
}

export function createBinding(ctx: ToolExecutionContext, toolDefs: ToolDef[]): string {
    sweep()
    const token = randomUUID()
    bindings.set(token, { ctx, toolDefs, createdAt: Date.now() })
    return token
}

export function getBinding(token: string): Binding | undefined {
    return bindings.get(token)
}

export function clearBinding(token: string): void {
    bindings.delete(token)
}
