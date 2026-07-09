import { spawn } from 'child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

import type {
    AIProvider,
    ProviderCapabilities,
    ProviderBuiltin,
    ProviderSendOptions,
    StreamCallbacks,
    ToolDef,
} from '@/lib/ai/agents/types'
import type { ContextUsageSnapshot } from '@/lib/types'
import { CLI_SPECS } from '@/lib/cli/specs'
import { resolveBin, augmentedEnv } from '@/lib/cli/resolve-bin'
import { createBinding, clearBinding } from '@/lib/cli/mcp-bindings'
import { activeRuntimePaths } from '@/lib/runtime-paths'
import { normalizeUsage } from '@/lib/observability/usage-mapper'
import { attachBillingMetadata } from '@/lib/observability/billing-metadata'
import type { BillingUsageEntry } from '@/lib/observability/schema'
import { latestUserPromptWithPortableHistory } from './history'

// Our custom tools reach Claude Code through one stdio MCP server. Claude Code
// surfaces MCP tools to the model as `mcp__<server>__<tool>`, never the bare
// id — so this name drives both the MCP config below and the tool-name prefix
// the prompt advertises (capabilities.customToolNamePrefix). Keep them derived
// from this single const so the advertised name can never drift from the
// callable one.
const ORCH_TOOLS_MCP_SERVER_NAME = 'orch-tools'
const ORCH_TOOLS_TOOL_NAME_PREFIX = `mcp__${ORCH_TOOLS_MCP_SERVER_NAME}__`

/**
 * Claude Code CLI provider — wraps the `claude` binary, no API key required.
 *
 * Two operating modes depending on what the agent needs:
 *
 *   1. Plain coder mode (no custom tools, no buildPrompt) — for the `coder`
 *      agent we let Claude Code drive entirely on its own. No MCP server and
 *      no `--append-system-prompt-file`; it applies its built-in coding
 *      system prompt and uses its native filesystem/Bash/Edit tools, which
 *      we still gate via `--allowedTools` from AgentConfig.builtins so
 *      headless (`-p`) runs need no human tool-permission approval.
 *
 *   2. Orchestrated mode (with tools and/or system prompt) — when claude-code
 *      backs a non-coder agent (orchestrator, researcher, …) we:
 *        • inject our tools via a stdio MCP server (lib/cli/mcp-server.mjs)
 *          which proxies tool calls back to /api/cli/mcp-exec;
 *        • append our system prompt via `--append-system-prompt-file`;
 *        • expose only the native built-ins requested by AgentConfig.builtins;
 *        • expose only our `delegate_to` custom tool through MCP;
 *        • persist the session id and pass `--resume <id>` on follow-up
 *          turns so Claude Code keeps conversational state across messages.
 *
 * Streaming uses `--output-format stream-json --include-partial-messages
 * --verbose`. We parse content / thinking / tool_use / tool_result events
 * out of the resulting JSON-RPC-ish stream and fan them into the standard
 * StreamCallbacks the chat route consumes.
 */
export class ClaudeCodeProvider implements AIProvider {
    readonly id = 'claude-code'
    readonly name = 'Claude Code'
    readonly capabilities: ProviderCapabilities = {
        kinds: ['text'],
        nativeBuiltins: [
            'read',
            'write',
            'edit',
            'bash',
            'glob',
            'grep',
            'web_fetch',
            'web_search',
            'todo_write',
        ],
        // We persist the session id Claude Code returns in `result.session_id`
        // and pass it back via `--resume` on subsequent turns, so conversational
        // state survives across messages.
        statefulMode: true,
        promptCaching: 'auto',
        attachmentMode: 'none',
        thinkingSupport: true,
        requiresApiKey: false,
        // Custom tools are bridged via the orch-tools MCP server, so the model
        // sees them namespaced. The prompt renders names with this prefix so it
        // never tells the model to call a bare id Claude Code cannot resolve.
        customToolNamePrefix: ORCH_TOOLS_TOOL_NAME_PREFIX,
    }

    // No API key for CLI — we accept one for interface uniformity but ignore it.
    constructor(apiKey: string) {
        void apiKey
    }

    async stream(options: ProviderSendOptions, cb: StreamCallbacks): Promise<void> {
        // -p mode is single-turn: Claude Code receives ONE user message and
        // produces ONE assistant turn. When resuming, earlier turns live in the
        // resumed session; after a provider/model switch, we embed prior chat
        // history in this one prompt so the fresh session can continue.
        const rawPrompt = latestUserPromptWithPortableHistory(options.messages, Boolean(options.prevSession?.id))
        if (!rawPrompt.trim()) {
            cb.onError('claude-code: empty prompt')
            cb.onDone({})
            return
        }

        const cwd = options.cwd ?? activeRuntimePaths().agentWorkspaceDir
        const systemPrompt = options.systemPrompt
        const prompt = rawPrompt

        const spec = CLI_SPECS['claude-code']
        const args = [...spec.generationArgs(prompt)]
        // Orchestrator owns specialized workflows itself. Keep native Claude
        // Code skills and plugin-provided slash commands out of headless runs.
        args.push('--disable-slash-commands')

        // ── System prompt ────────────────────────────────────────────────
        // Append our agent prompt to Claude Code's default. Argv has a size
        // limit (~256KB on macOS) and our prompts can be ~10KB, so write to
        // a temp file and use the *-file variant. Cleaned up after the run.
        const cleanups: Array<() => void> = []
        if (systemPrompt && systemPrompt.trim()) {
            const dir = mkdtempSync(join(tmpdir(), 'orch-cc-prompt-'))
            const path = join(dir, 'system-prompt.txt')
            writeFileSync(path, systemPrompt, 'utf-8')
            args.push('--append-system-prompt-file', path)
            cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* fine */ } })
        }

        // ── Custom tools via MCP ─────────────────────────────────────────
        // Claude Code can't reach our in-process tools directly, so we spawn
        // a stdio MCP server (mcp-server.mjs) as its child. That server
        // proxies tool calls back to /api/cli/mcp-exec with the binding
        // token we issue here. Token resolves to (ToolDef[], ExecutionCtx),
        // so tool execution runs in the orchestrator's process with full
        // access to the registry, db, and delegation runner.
        const tools = customToolsForClaudeCode(options.tools ?? [])
        const nativeToolNames = claudeCodeToolNames(options.builtins ?? [])
        const hasMcpTools = tools.length > 0 && Boolean(options.toolContext)
        // Claude Code 2.x DEFERS MCP (custom) tool schemas: they are not placed
        // in the active tool list at launch — the model must load them on demand
        // via the ToolSearch built-in (e.g. `select:mcp__orch-tools__set_task_state`).
        // Only expose ToolSearch when we bridge custom tools. Do not expose Skill:
        // native Claude skills/slash commands are disabled above.
        const nativeToolsForRun = hasMcpTools && !nativeToolNames.includes('ToolSearch')
            ? [...nativeToolNames, 'ToolSearch']
            : nativeToolNames
        if (nativeToolsForRun.length > 0) {
            args.push('--tools', nativeToolsForRun.join(','))
        }

        if (hasMcpTools && options.toolContext) {
            const token = createBinding(options.toolContext, tools)
            cleanups.push(() => clearBinding(token))

            const serverScript = join(process.cwd(), 'lib', 'cli', 'mcp-server.mjs')
            const toolsDir = mkdtempSync(join(tmpdir(), 'orch-mcp-tools-'))
            const toolsPath = join(toolsDir, 'tools.json')
            writeFileSync(toolsPath, JSON.stringify({
                tools: tools.map(tool => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.input_schema,
                })),
            }), 'utf-8')
            cleanups.push(() => { try { rmSync(toolsDir, { recursive: true, force: true }) } catch { /* fine */ } })

            const port = process.env.PORT ?? '3000'
            const mcpConfig = {
                mcpServers: {
                    [ORCH_TOOLS_MCP_SERVER_NAME]: {
                        type: 'stdio' as const,
                        command: process.execPath,  // current node binary
                        args: [serverScript],
                        env: {
                            MCP_APP_URL: `http://127.0.0.1:${port}`,
                            MCP_AUTH_TOKEN: token,
                            MCP_SERVER_NAME: ORCH_TOOLS_MCP_SERVER_NAME,
                            // Bundle the launch-time tool schemas directly
                            // into the child MCP server. Tool calls still
                            // proxy through /api/cli/mcp-exec, but tools/list
                            // no longer depends on a localhost HTTP round-trip
                            // during Claude Code startup; that was enough to
                            // strand scheduled wakes in a toolless state.
                            MCP_TOOLS_FILE: toolsPath,
                        },
                    },
                },
            }
            args.push('--mcp-config', JSON.stringify(mcpConfig))
            // Lock the runtime to only our MCP servers — ignore user-level
            // and project-level .mcp.json. Otherwise stale entries from the
            // user's own dev environment leak into agent runs.
            args.push('--strict-mcp-config')
            args.push('--allowedTools', [...nativeToolsForRun, `mcp__${ORCH_TOOLS_MCP_SERVER_NAME}`].join(','))
            // No human in the loop — accept whatever tools we expose.
            args.push('--permission-mode', 'bypassPermissions')
        } else if (nativeToolsForRun.length > 0) {
            // Plain coder mode (no MCP bridge): expose only the native CLI
            // tools requested by AgentConfig.builtins. Orchestrator-owned
            // workflow skills are available only through our custom tool layer.
            args.push('--allowedTools', nativeToolsForRun.join(','))
            args.push('--permission-mode', 'bypassPermissions')
        }

        // ── Session continuity ───────────────────────────────────────────
        // First turn: mint a UUID, pass it via --session-id so we know it
        // upfront. Subsequent turns in the same conversation: use --resume.
        let sessionId: string | undefined
        if (options.prevSession?.id) {
            args.push('--resume', options.prevSession.id)
            sessionId = options.prevSession.id
        } else {
            sessionId = randomUUID()
            args.push('--session-id', sessionId)
        }

        // ── Model + effort ───────────────────────────────────────────────
        // Claude Code accepts aliases ("opus", "sonnet", "haiku") or full ids
        // ("claude-sonnet-4-6"). "default" is our placeholder meaning "let
        // Claude Code use its configured model" — pass nothing.
        if (options.model && options.model !== 'default') {
            args.push('--model', options.model)
        }

        if (options.thinkingLevel) {
            const effort = mapEffortForClaude(options.thinkingLevel)
            if (effort) args.push('--effort', effort)
        }

        return runClaudeStreamJson({
            bin: spec.bin,
            args,
            model: options.model,
            cwd,
            signal: options.signal,
            callbacks: cb,
            initialSessionId: sessionId,
            cleanup: () => { for (const fn of cleanups) try { fn() } catch { /* ignore */ } },
        })
    }
}

function customToolsForClaudeCode(tools: ToolDef[]): ToolDef[] {
    return tools.filter(tool => !CLAUDE_CODE_NATIVE_DUPLICATE_TOOL_IDS.has(tool.id))
}

const CLAUDE_CODE_NATIVE_DUPLICATE_TOOL_IDS = new Set([
    'list_dir',
    'read_file',
    'Read',
    'Write',
    'Edit',
    'Bash',
    'Glob',
    'Grep',
    'WebFetch',
    'TodoWrite',
])

function claudeCodeToolNames(builtins: ProviderBuiltin[]): string[] {
    const names = new Set<string>()
    for (const builtin of builtins) {
        const name = CLAUDE_CODE_BUILTIN_TOOL_NAMES[builtin]
        if (name) names.add(name)
    }
    return Array.from(names)
}

const CLAUDE_CODE_BUILTIN_TOOL_NAMES: Partial<Record<ProviderBuiltin, string>> = {
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    bash: 'Bash',
    glob: 'Glob',
    grep: 'Grep',
    web_fetch: 'WebFetch',
    web_search: 'WebSearch',
    todo_write: 'TodoWrite',
}

// ---------------------------------------------------------------------------
// stream-json parser
//
// Claude Code emits newline-delimited JSON when invoked with
//   -p --output-format stream-json --include-partial-messages --verbose
//
// Event shapes we care about (full schema is intentionally not exhaustive —
// we accept extra fields and only key off what we need):
//
//   { type: "system", subtype: "init", session_id, model, tools, ... }
//   { type: "stream_event", event: { type: "content_block_delta",
//                                    delta: { type: "text_delta", text } } }
//   { type: "stream_event", event: { type: "content_block_delta",
//                                    delta: { type: "thinking_delta", thinking } } }
//   { type: "stream_event", event: { type: "content_block_start",
//                                    content_block: { type: "tool_use", id, name } } }
//   { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }, ...] } }
//   { type: "user", message: { content: [{ type: "tool_result", tool_use_id, content, is_error }] } }
//   { type: "result", session_id, usage, total_cost_usd, duration_ms, is_error, result }
// ---------------------------------------------------------------------------

interface AnyObj { [k: string]: unknown }

interface RunClaudeArgs {
    bin: string
    args: string[]
    model: string
    cwd?: string
    signal?: AbortSignal
    callbacks: StreamCallbacks
    initialSessionId?: string
    cleanup?: () => void
}

async function runClaudeStreamJson({ bin, args, model, cwd, signal, callbacks, initialSessionId, cleanup }: RunClaudeArgs): Promise<void> {
    return new Promise<void>(resolve => {
        const finish = () => {
            try { cleanup?.() } catch { /* ignore */ }
            resolve()
        }

        const resolved = resolveBin(bin)
        let proc: ReturnType<typeof spawn>
        try {
            proc = spawn(resolved, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: augmentedEnv(),
                cwd: cwd ?? activeRuntimePaths().agentWorkspaceDir,
            })
        } catch (err) {
            callbacks.onError(`Failed to spawn ${bin}: ${err instanceof Error ? err.message : 'unknown error'}`)
            callbacks.onDone({})
            finish()
            return
        }

        let aborted = false
        const onAbort = () => {
            aborted = true
            try { proc.kill('SIGTERM') } catch { /* gone */ }
            setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, 1500)
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        // ── Final-envelope accumulators (handed to onDone) ─────────────────
        let finalUsage: unknown = undefined
        let finalSessionId: string | undefined = initialSessionId
        let finalDurationMs: number | undefined
        let finalCostUsd: number | undefined
        let finalModelUsage: unknown
        let latestActualModel = model
        let thinkingStartedAt: number | null = null
        let thinkingTotalMs = 0

        // Claude Code reports usage twice over a turn: once per internal API
        // call (`assistant` / `stream_event`, reflecting that single call's
        // context occupancy) and once in the final `result` envelope, which is
        // CUMULATIVE across every step of an agentic turn — it re-sums the
        // cache reads each step, so a 6-7 step turn over a ~116K thread reports
        // ~800K. That cumulative figure is correct for cost accounting (handed
        // to onDone via finalUsage) but must NOT drive the context-window ring,
        // which has to stay ≤ the model window (app/api/chat/route.ts relies on
        // the per-request snapshot here). So we split the two paths:
        //   • finalUsage → whatever arrives last (the cumulative result), for cost
        //   • onUsage    → per-call snapshots only, for the live context gauge
        const rememberFinalUsage = (usage: unknown) => {
            finalUsage = usage
        }
        const emitContextSnapshot = (usage: unknown) => {
            const snapshot = claudeCodeContextUsageSnapshot({
                raw: usage,
                model,
                sessionId: finalSessionId,
            })
            // Skip output-only partials (e.g. a message_delta carrying just
            // output_tokens): they hold no input/cache signal and would
            // momentarily collapse the ring. Keep the last input-bearing one.
            if (snapshot && (snapshot.inputTokens !== null || snapshot.cachedTokens !== null)) {
                callbacks.onUsage?.(snapshot)
            }
        }
        // Per-call usage feeds both the gauge and the cost fallback; the
        // cumulative `result` usage (handled below) overwrites finalUsage last.
        const rememberPerCallUsage = (usage: unknown) => {
            rememberFinalUsage(usage)
            emitContextSnapshot(usage)
        }

        // Track tool_use blocks we've already surfaced so the same id from
        // the partial → assistant duplication doesn't fire onToolCall twice.
        // Same for tool_result blocks — and we map id→name so the result
        // can carry the original tool name through to the UI/log.
        const seenToolCallIds = new Set<string>()
        const toolNameById = new Map<string, string>()

        const handleEnvelope = (env: AnyObj) => {
            const t = env.type as string | undefined
            // A top-level `usage` rides on the cumulative `result` envelope
            // (handled in its own branch below as final/cost usage). Any other
            // envelope shape carrying one is per-call → feeds the gauge too.
            if (t !== 'result' && env.usage && typeof env.usage === 'object') {
                rememberPerCallUsage(env.usage)
            }

            if (t === 'system' && (env.subtype === 'init')) {
                if (typeof env.session_id === 'string') finalSessionId = env.session_id
                return
            }

            if (t === 'stream_event') {
                const event = env.event as AnyObj | undefined
                if (!event) return
                if (event.usage && typeof event.usage === 'object') {
                    rememberPerCallUsage(event.usage)
                }
                const eventType = event.type as string | undefined
                if (eventType === 'content_block_start') {
                    const block = event.content_block as AnyObj | undefined
                    // Capture tool name early so onToolResult can resolve it
                    // even before the full assistant message arrives.
                    if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
                        toolNameById.set(block.id, block.name)
                    }
                    if (block?.type === 'thinking' && thinkingStartedAt === null) {
                        thinkingStartedAt = Date.now()
                    }
                    return
                }
                if (eventType === 'content_block_delta') {
                    const delta = event.delta as AnyObj | undefined
                    if (!delta) return
                    const dType = delta.type as string | undefined
                    if (dType === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
                        callbacks.onContent(delta.text)
                    } else if (dType === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
                        callbacks.onThinking(delta.thinking)
                    }
                    // input_json_delta is fragmentary JSON for tool inputs; we
                    // wait for the assembled `assistant` event to fire
                    // onToolCall so the args object is parseable.
                    return
                }
                if (eventType === 'content_block_stop') {
                    // Use this as the boundary to close out a thinking block.
                    // We don't strictly know which kind of block stopped, but
                    // tracking thinking duration loosely is good enough — if
                    // the *next* block was text, the delta already happened.
                    return
                }
                return
            }

            if (t === 'assistant') {
                const msg = env.message as AnyObj | undefined
                if (typeof msg?.model === 'string' && msg.model.trim()) {
                    latestActualModel = msg.model.trim()
                }
                if (msg?.usage && typeof msg.usage === 'object') {
                    rememberPerCallUsage(msg.usage)
                }
                const content = msg?.content as AnyObj[] | undefined
                if (!Array.isArray(content)) return
                for (const block of content) {
                    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
                        const id = block.id
                        if (seenToolCallIds.has(id)) continue
                        seenToolCallIds.add(id)
                        toolNameById.set(id, block.name)
                        const rawInput = (block.input ?? {}) as Record<string, unknown>
                        callbacks.onToolCall({ id, name: stripMcpPrefix(block.name), arguments: rawInput })
                    }
                }
                // Once we've seen content for this assistant turn, any open
                // thinking block is effectively over.
                if (thinkingStartedAt !== null) {
                    thinkingTotalMs += Date.now() - thinkingStartedAt
                    thinkingStartedAt = null
                    callbacks.onThinkingDone(thinkingTotalMs / 1000)
                }
                return
            }

            if (t === 'user') {
                const msg = env.message as AnyObj | undefined
                const content = msg?.content as AnyObj[] | undefined
                if (!Array.isArray(content)) return
                for (const block of content) {
                    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
                    const toolUseId = block.tool_use_id
                    const isError = block.is_error === true
                    const rawContent = block.content
                    const text = typeof rawContent === 'string'
                        ? rawContent
                        : Array.isArray(rawContent)
                            ? (rawContent as AnyObj[]).map(c => (typeof c.text === 'string' ? c.text : '')).join('')
                            : JSON.stringify(rawContent ?? null)
                    const name = stripMcpPrefix(toolNameById.get(toolUseId) ?? 'tool')
                    callbacks.onToolResult(toolUseId, name, {
                        success: !isError,
                        data: isError ? undefined : text,
                        error: isError ? text : undefined,
                    })
                }
                return
            }

            if (t === 'result') {
                if (typeof env.session_id === 'string') finalSessionId = env.session_id
                // Cumulative whole-turn usage — for cost/onDone only, never the gauge.
                if (env.usage) rememberFinalUsage(env.usage)
                const reportedCost = finiteNonNegative(env.total_cost_usd ?? env.totalCostUsd)
                if (reportedCost !== null) finalCostUsd = reportedCost
                finalModelUsage = env.model_usage ?? env.modelUsage ?? finalModelUsage
                if (typeof env.duration_ms === 'number') finalDurationMs = env.duration_ms
                if (env.is_error && typeof env.result === 'string') {
                    callbacks.onError(env.result)
                }
                return
            }
            // Other event types (rate_limit_event, system/status, etc.) are
            // observability-only; we ignore them.
        }

        // Buffer partial lines across data chunks so we never JSON.parse half
        // an event. Non-JSON lines are forwarded raw — defensive against
        // pre-stream banners or stderr text we mis-routed.
        let lineBuf = ''
        const consumeLines = (chunk: string) => {
            lineBuf += chunk
            for (;;) {
                const nl = lineBuf.indexOf('\n')
                if (nl < 0) break
                const line = lineBuf.slice(0, nl).trim()
                lineBuf = lineBuf.slice(nl + 1)
                if (!line) continue
                if (line[0] === '{') {
                    try {
                        handleEnvelope(JSON.parse(line) as AnyObj)
                        continue
                    } catch { /* fall through */ }
                }
                // Non-JSON or malformed JSON — surface as plain text so the
                // user sees something rather than a silent failure.
                callbacks.onContent(line + '\n')
            }
        }

        // setEncoding routes chunks through a StringDecoder so a multi-byte
        // UTF-8 character split across chunk boundaries never decodes to
        // replacement chars (which would corrupt stream-json lines).
        proc.stdout?.setEncoding('utf8')
        proc.stderr?.setEncoding('utf8')
        proc.stdout?.on('data', chunk => consumeLines(chunk.toString()))
        proc.stderr?.on('data', chunk => {
            // claude writes init banners and warnings here. Forward when
            // it looks like signal, route through onContent so the user can
            // at least see it; richer routing (onThinking) is overkill.
            const text = chunk.toString()
            if (text && text.trim().length > 0) {
                // Avoid spamming every keepalive; skip blank/whitespace.
                callbacks.onContent(text)
            }
        })
        proc.on('error', err => {
            callbacks.onError(err.message)
            callbacks.onDone({})
            signal?.removeEventListener('abort', onAbort)
            finish()
        })
        proc.on('exit', code => {
            signal?.removeEventListener('abort', onAbort)
            if (lineBuf.trim()) consumeLines('\n')
            if (aborted) {
                callbacks.onError('Aborted')
            } else if (code !== 0 && code !== null) {
                callbacks.onError(`${bin} exited with code ${code}`)
            }
            // Close any still-open thinking block.
            if (thinkingStartedAt !== null) {
                thinkingTotalMs += Date.now() - thinkingStartedAt
                thinkingStartedAt = null
                callbacks.onThinkingDone(thinkingTotalMs / 1000)
            }
            callbacks.onDone({
                sessionId: finalSessionId,
                usage: attachBillingMetadata(finalUsage, claudeCodeBillingEntries({
                    modelUsage: finalModelUsage,
                    totalCostUsd: finalCostUsd,
                    fallbackModel: latestActualModel,
                    fallbackUsage: finalUsage,
                })),
                thinkingDuration: finalDurationMs !== undefined
                    ? finalDurationMs / 1000
                    : (thinkingTotalMs > 0 ? thinkingTotalMs / 1000 : undefined),
            })
            finish()
        })
    })
}

export function claudeCodeBillingEntries(args: {
    modelUsage: unknown
    totalCostUsd?: number
    fallbackModel: string
    fallbackUsage: unknown
}): BillingUsageEntry[] {
    const modelUsage = objectRecord(args.modelUsage)
    const entries: BillingUsageEntry[] = []

    for (const [model, value] of Object.entries(modelUsage)) {
        const usage = objectRecord(value)
        const input = integerOrZero(usage.inputTokens)
        const output = integerOrZero(usage.outputTokens)
        const cacheRead = integerOrZero(usage.cacheReadInputTokens)
        const cacheCreate = integerOrZero(usage.cacheCreationInputTokens)
        const totalInput = input + cacheRead + cacheCreate
        const cost = finiteNonNegative(usage.costUSD)
        entries.push({
            provider: 'claude-code',
            model,
            requests: 1,
            inputTokens: totalInput,
            outputTokens: output,
            thinkingTokens: 0,
            cachedTokens: cacheRead + cacheCreate,
            toolUseTokens: 0,
            totalTokens: totalInput + output,
            ...(cost !== null ? {
                apiEquivalentCostUsd: cost,
                costSource: 'provider-estimate' as const,
                costAccuracy: 'provider' as const,
                pricingSource: 'https://code.claude.com/docs/en/agent-sdk/cost-tracking',
            } : {}),
        })
    }

    const totalCost = finiteNonNegative(args.totalCostUsd)
    if (entries.length > 0) {
        if (totalCost !== null) {
            const perModelTotal = entries.reduce((sum, entry) => sum + (entry.apiEquivalentCostUsd ?? 0), 0)
            entries[0].apiEquivalentCostUsd = Math.max(0, (entries[0].apiEquivalentCostUsd ?? 0) + totalCost - perModelTotal)
            entries[0].costSource = 'provider-estimate'
            entries[0].costAccuracy = 'provider'
            entries[0].pricingSource = 'https://code.claude.com/docs/en/agent-sdk/cost-tracking'
        }
        return entries
    }

    const usage = normalizeUsage('claude-code', args.fallbackUsage)
    const hasUsage = [usage.inputTokens, usage.outputTokens, usage.cachedTokens, usage.totalTokens]
        .some(value => typeof value === 'number')
    if (!hasUsage && totalCost === null) return []

    return [{
        provider: 'claude-code',
        model: args.fallbackModel.trim() || 'default',
        requests: 1,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        thinkingTokens: 0,
        cachedTokens: usage.cachedTokens ?? 0,
        toolUseTokens: 0,
        totalTokens: usage.totalTokens ?? 0,
        ...(totalCost !== null ? {
            apiEquivalentCostUsd: totalCost,
            costSource: 'provider-estimate' as const,
            costAccuracy: 'provider' as const,
            pricingSource: 'https://code.claude.com/docs/en/agent-sdk/cost-tracking',
        } : {}),
    }]
}

function objectRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {}
}

function finiteNonNegative(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function integerOrZero(value: unknown): number {
    const number = finiteNonNegative(value)
    return number === null ? 0 : Math.floor(number)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map our ThinkingLevel onto Claude Code's --effort. */
function mapEffortForClaude(level: string): string | null {
    switch (level) {
        case 'minimal': return 'low'    // Claude has no 'minimal' rung
        case 'low':
        case 'medium':
        case 'high':
        case 'xhigh':
        case 'max':
            return level
        default:
            return level
    }
}

/**
 * Strip the `mcp__<server>__` prefix Claude Code adds when surfacing MCP
 * tools, so log entries and the UI see our original tool names.
 */
function stripMcpPrefix(name: string): string {
    const m = /^mcp__[^_]+(?:__|_)+(.+)$/.exec(name)
    if (m) return m[1]
    // Fallback for the common shape: mcp__serverName__toolName
    if (name.startsWith('mcp__')) {
        const rest = name.slice('mcp__'.length)
        const idx = rest.indexOf('__')
        if (idx >= 0) return rest.slice(idx + 2)
    }
    return name
}

function claudeCodeContextUsageSnapshot(args: {
    raw: unknown
    model: string
    sessionId?: string
}): ContextUsageSnapshot | null {
    const usage = normalizeUsage('claude-code', args.raw)
    if (
        usage.inputTokens === null &&
        usage.outputTokens === null &&
        usage.thinkingTokens === null &&
        usage.cachedTokens === null &&
        usage.totalTokens === null
    ) {
        return null
    }

    return {
        provider: 'claude-code',
        model: args.model,
        source: 'provider-live',
        accuracy: 'live',
        updatedAt: Date.now(),
        interactionId: args.sessionId,
        contextTokens: sumUsageTokens(usage.inputTokens, usage.outputTokens),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        thinkingTokens: usage.thinkingTokens,
        cachedTokens: usage.cachedTokens,
        totalTokens: usage.totalTokens,
    }
}

function sumUsageTokens(...values: Array<number | null | undefined>): number | null {
    let total = 0
    let seen = false
    for (const value of values) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
        total += value
        seen = true
    }
    return seen ? total : null
}
