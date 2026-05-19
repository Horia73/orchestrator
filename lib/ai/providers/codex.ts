import { spawn } from 'child_process'

import type {
    AIProvider,
    ProviderCapabilities,
    ProviderBuiltin,
    ProviderSendOptions,
    StreamCallbacks,
    ToolDef,
} from '@/lib/ai/agents/types'
import type { ContextUsageSnapshot, TokenUsageBreakdown } from '@/lib/types'
import { CLI_SPECS } from '@/lib/cli/specs'
import { resolveBin } from '@/lib/cli/resolve-bin'
import { codexCliEnv } from '@/lib/cli/codex-env'
import { executeTool } from '@/lib/ai/tools/executor'
import { AGENT_WORKSPACE_DIR } from '@/lib/config'
import { latestUserPromptWithPortableHistory } from './history'

/**
 * Codex provider backed by `codex app-server`.
 *
 * `codex exec --json` is useful for scripts, but it only exposes coarse JSONL
 * task events. The app-server protocol is the richer client API: thread
 * lifecycle, token deltas, reasoning deltas, tool-call events, and client-run
 * dynamic tools over JSON-RPC on stdio.
 */
export class CodexProvider implements AIProvider {
    readonly id = 'codex'
    readonly name = 'Codex CLI'
    readonly capabilities: ProviderCapabilities = {
        kinds: ['text'],
        nativeBuiltins: [
            'read',
            'write',
            'edit',
            'bash',
            'glob',
            'grep',
            'web_search',
            'todo_write',
        ],
        statefulMode: true,
        promptCaching: 'auto',
        attachmentMode: 'none',
        thinkingSupport: true,
        requiresApiKey: false,
    }

    constructor(apiKey: string) {
        void apiKey
    }

    async stream(options: ProviderSendOptions, cb: StreamCallbacks): Promise<void> {
        const prevSessionId = decodeAppServerSessionId(options.prevSession?.id)
        const userPrompt = latestUserPromptWithPortableHistory(options.messages, Boolean(prevSessionId))
        if (!userPrompt.trim()) {
            cb.onError('codex: empty prompt')
            cb.onDone({})
            return
        }

        const tools = customToolsForCodex(options.tools ?? [])
        const isNativeCoderRun =
            options.toolContext?.callerAgentId === 'coder' &&
            tools.length === 0 &&
            !options.systemPrompt?.trim()

        return runCodexAppServer({
            bin: CLI_SPECS.codex.bin,
            prompt: userPrompt,
            model: options.model,
            systemPrompt: options.systemPrompt,
            thinkingLevel: options.thinkingLevel,
            tools,
            builtins: options.builtins ?? [],
            toolContext: options.toolContext,
            prevSessionId,
            nativeCoderRun: isNativeCoderRun,
            signal: options.signal,
            callbacks: cb,
        })
    }
}

function customToolsForCodex(tools: ToolDef[]): ToolDef[] {
    return tools.filter(tool => !CODEX_NATIVE_DUPLICATE_TOOL_IDS.has(tool.id))
}

const CODEX_NATIVE_DUPLICATE_TOOL_IDS = new Set([
    'list_dir',
    'read_file',
    'Read',
    'Write',
    'Edit',
    'Bash',
    'Glob',
    'Grep',
    'TodoWrite',
])

// ---------------------------------------------------------------------------
// App-server JSON-RPC runner
// ---------------------------------------------------------------------------

interface AnyObj { [k: string]: unknown }

interface RunCodexAppServerArgs {
    bin: string
    prompt: string
    model: string
    systemPrompt?: string
    thinkingLevel?: string
    tools: ToolDef[]
    builtins: ProviderBuiltin[]
    toolContext?: ProviderSendOptions['toolContext']
    prevSessionId?: string
    nativeCoderRun: boolean
    signal?: AbortSignal
    callbacks: StreamCallbacks
}

const APP_SERVER_SESSION_PREFIX = 'appserver:'
const JSON_RPC_REQUEST_TIMEOUT_MS = 60_000

async function runCodexAppServer(args: RunCodexAppServerArgs): Promise<void> {
    const {
        bin,
        prompt,
        model,
        systemPrompt,
        thinkingLevel,
        tools,
        builtins,
        toolContext,
        prevSessionId,
        nativeCoderRun,
        signal,
        callbacks,
    } = args

    return new Promise<void>(resolve => {
        const resolved = resolveBin(bin)
        const procArgs = buildAppServerArgs(nativeCoderRun, builtins)
        let proc: ReturnType<typeof spawn>

        try {
            proc = spawn(resolved, procArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: codexCliEnv(),
                cwd: AGENT_WORKSPACE_DIR,
            })
        } catch (err) {
            callbacks.onError(`Failed to spawn ${bin}: ${err instanceof Error ? err.message : 'unknown error'}`)
            callbacks.onDone({})
            resolve()
            return
        }

        let nextRequestId = 1
        let stdoutBuf = ''
        let stderrBuf = ''
        let finished = false
        let aborted = false
        let activeThreadId: string | undefined
        let activeTurnId: string | undefined
        let finalUsage: unknown
        let finalDurationMs: number | undefined
        let providerError: string | null = null
        const diagnostics: string[] = []

        const pending = new Map<number, {
            method: string
            resolve: (value: unknown) => void
            reject: (err: Error) => void
            timer: ReturnType<typeof setTimeout>
        }>()

        const inflightTools = new Map<string, { name: string }>()
        const firedToolCalls = new Set<string>()
        const firedToolResults = new Set<string>()
        const firedCompactions = new Set<string>()
        const rawWebToolCalls = new Map<string, { name: string; args: Record<string, unknown> }>()
        const messageTextByItem = new Map<string, string>()
        let thinkingStartedAt: number | null = null
        let thinkingTotalMs = 0
        let syntheticRawWebCallCount = 0
        let syntheticPlanUpdateCount = 0

        const rememberDiagnostic = (text: string) => {
            const trimmed = text.trim()
            if (!trimmed) return
            diagnostics.push(trimmed)
            if (diagnostics.length > 20) diagnostics.shift()
        }

        const send = (msg: Record<string, unknown>) => {
            if (!proc.stdin || proc.stdin.destroyed) return
            proc.stdin.write(`${JSON.stringify(msg)}\n`)
        }

        const request = (method: string, params: unknown, timeoutMs = JSON_RPC_REQUEST_TIMEOUT_MS) => {
            const id = nextRequestId++
            send({ method, id, params })
            return new Promise<unknown>((res, rej) => {
                const timer = setTimeout(() => {
                    pending.delete(id)
                    rej(new Error(`${method} timed out after ${timeoutMs}ms`))
                }, timeoutMs)
                pending.set(id, { method, resolve: res, reject: rej, timer })
            })
        }

        const respond = (id: unknown, result: unknown) => {
            if (typeof id !== 'number') return
            send({ id, result })
        }

        const respondError = (id: unknown, message: string, code = -32603) => {
            if (typeof id !== 'number') return
            send({ id, error: { code, message } })
        }

        const fireToolCall = (id: string, name: string, callArgs: Record<string, unknown>) => {
            if (firedToolCalls.has(id)) return
            firedToolCalls.add(id)
            inflightTools.set(id, { name })
            callbacks.onToolCall({ id, name, arguments: callArgs })
        }

        const fireToolResult = (id: string, name: string, success: boolean, text: string) => {
            if (firedToolResults.has(id)) return
            firedToolResults.add(id)
            inflightTools.delete(id)
            callbacks.onToolResult(id, name, {
                success,
                data: success ? text : undefined,
                error: success ? undefined : text,
            })
        }

        const firePlanUpdate = (params?: AnyObj) => {
            const todos = todosFromCodexPlan(params)
            if (!todos.length) return

            // Surface Codex's native plan stream through the existing TodoBar path.
            const id = `codex_plan_${activeTurnId ?? activeThreadId ?? 'turn'}_${++syntheticPlanUpdateCount}`
            fireToolCall(id, 'TodoWrite', { todos })
            firedToolResults.add(id)
            inflightTools.delete(id)
            callbacks.onToolResult(id, 'TodoWrite', {
                success: true,
                data: {
                    source: 'codex_plan',
                    todos,
                    count: todos.length,
                },
            })
        }

        const fireContextUsage = (params?: AnyObj) => {
            const snapshot = codexContextUsageSnapshot({
                raw: toRecord(params?.tokenUsage),
                model,
                threadId: typeof params?.threadId === 'string' ? params.threadId : activeThreadId,
                turnId: typeof params?.turnId === 'string' ? params.turnId : activeTurnId,
            })
            if (snapshot) callbacks.onUsage?.(snapshot)
        }

        const fireContextCompaction = (params?: AnyObj, itemId?: string) => {
            const key = itemId
                || firstString(params?.itemId, params?.turnId, params?.threadId)
                || `compaction_${firedCompactions.size + 1}`
            if (firedCompactions.has(key)) return
            firedCompactions.add(key)
            callbacks.onContextCompaction?.({
                threadId: typeof params?.threadId === 'string' ? params.threadId : activeThreadId,
                turnId: typeof params?.turnId === 'string' ? params.turnId : activeTurnId,
                itemId: key,
                at: Date.now(),
            })
        }

        const closeThinking = () => {
            if (thinkingStartedAt === null) return
            thinkingTotalMs += Date.now() - thinkingStartedAt
            thinkingStartedAt = null
            callbacks.onThinkingDone(thinkingTotalMs / 1000)
        }

        const onAbort = () => {
            aborted = true
            shutdown('SIGTERM')
            setTimeout(() => shutdown('SIGKILL'), 1500)
        }

        const shutdown = (sig: NodeJS.Signals) => {
            try { proc.kill(sig) } catch { /* already gone */ }
        }

        const finish = () => {
            if (finished) return
            finished = true
            signal?.removeEventListener('abort', onAbort)
            for (const entry of pending.values()) clearTimeout(entry.timer)
            pending.clear()
            closeThinking()
            for (const [id, { name }] of inflightTools) {
                fireToolResult(id, name, false, 'No completion event received')
            }
            callbacks.onDone({
                sessionId: activeThreadId ? encodeAppServerSessionId(activeThreadId) : undefined,
                usage: finalUsage,
                thinkingDuration: finalDurationMs !== undefined
                    ? finalDurationMs / 1000
                    : (thinkingTotalMs > 0 ? thinkingTotalMs / 1000 : undefined),
            })
            resolve()
        }

        const fail = (message: string) => {
            if (!providerError) {
                providerError = message
                callbacks.onError(message)
            }
        }

        signal?.addEventListener('abort', onAbort, { once: true })

        proc.stdout?.on('data', chunk => {
            stdoutBuf += chunk.toString()
            for (;;) {
                const idx = stdoutBuf.indexOf('\n')
                if (idx < 0) break
                const line = stdoutBuf.slice(0, idx).trim()
                stdoutBuf = stdoutBuf.slice(idx + 1)
                if (!line) continue
                let msg: AnyObj
                try {
                    msg = JSON.parse(line) as AnyObj
                } catch {
                    rememberDiagnostic(line)
                    continue
                }
                void handleMessage(msg)
            }
        })

        proc.stderr?.on('data', chunk => {
            stderrBuf += chunk.toString()
            for (;;) {
                const idx = stderrBuf.indexOf('\n')
                if (idx < 0) break
                const line = stderrBuf.slice(0, idx).trim()
                stderrBuf = stderrBuf.slice(idx + 1)
                if (!line) continue
                rememberDiagnostic(line)
            }
        })

        proc.on('error', err => {
            fail(err.message)
            finish()
        })

        proc.on('exit', code => {
            if (stdoutBuf.trim()) {
                try { void handleMessage(JSON.parse(stdoutBuf.trim()) as AnyObj) } catch { rememberDiagnostic(stdoutBuf) }
            }
            if (stderrBuf.trim()) rememberDiagnostic(stderrBuf)
            if (aborted) {
                fail('Aborted')
            } else if (!finished && code !== 0 && code !== null) {
                const suffix = diagnostics.length ? `: ${diagnostics.slice(-3).join('\n')}` : ''
                fail(`${bin} app-server exited with code ${code}${suffix}`)
            }
            finish()
        })

        const handleMessage = async (msg: AnyObj) => {
            if (typeof msg.id === 'number' && !msg.method) {
                const pendingRequest = pending.get(msg.id)
                if (!pendingRequest) return
                pending.delete(msg.id)
                clearTimeout(pendingRequest.timer)
                if (msg.error) {
                    const errObj = msg.error as AnyObj
                    const message = typeof errObj.message === 'string'
                        ? errObj.message
                        : JSON.stringify(msg.error)
                    pendingRequest.reject(new Error(message))
                } else {
                    pendingRequest.resolve(msg.result)
                }
                return
            }

            if (typeof msg.id === 'number' && typeof msg.method === 'string') {
                await handleServerRequest(msg)
                return
            }

            if (typeof msg.method === 'string') {
                handleNotification(msg.method, msg.params as AnyObj | undefined)
            }
        }

        const handleServerRequest = async (msg: AnyObj) => {
            if (msg.method === 'item/tool/call') {
                await handleDynamicToolCall(msg.id, msg.params as AnyObj | undefined)
                return
            }

            if (msg.method === 'item/commandExecution/requestApproval') {
                respond(msg.id, { decision: 'decline' })
                return
            }
            if (msg.method === 'item/fileChange/requestApproval') {
                respond(msg.id, { decision: 'decline' })
                return
            }

            respondError(msg.id, `Unsupported codex app-server request: ${msg.method}`, -32601)
        }

        const handleDynamicToolCall = async (requestId: unknown, params: AnyObj | undefined) => {
            const callId = typeof params?.callId === 'string' ? params.callId : `codex_tool_${requestId}`
            const toolName = typeof params?.tool === 'string' ? params.tool : ''
            const callArgs = toRecord(params?.arguments)
            const tool = tools.find(t => t.name === toolName || t.id === toolName)
            const surfacedName = tool?.name ?? (toolName || 'tool')

            fireToolCall(callId, surfacedName, callArgs)

            if (!tool) {
                const error = `Unknown tool: ${toolName}`
                respond(requestId, {
                    contentItems: [{ type: 'inputText', text: error }],
                    success: false,
                })
                return
            }

            const result = await executeTool(tool, callArgs, toolContext
                ? { ...toolContext, currentToolCallId: callId }
                : undefined)
            respond(requestId, {
                contentItems: [{ type: 'inputText', text: formatToolResult(result.success, result.data, result.error) }],
                success: result.success,
            })
        }

        const handleNotification = (method: string, params?: AnyObj) => {
            switch (method) {
                case 'thread/started': {
                    const thread = params?.thread as AnyObj | undefined
                    if (typeof thread?.id === 'string') activeThreadId = thread.id
                    return
                }
                case 'thread/tokenUsage/updated': {
                    if (!activeTurnId || params?.turnId === activeTurnId) {
                        finalUsage = (params?.tokenUsage as AnyObj | undefined)?.last ?? params?.tokenUsage
                    }
                    fireContextUsage(params)
                    return
                }
                case 'thread/compacted':
                    fireContextCompaction(params)
                    return
                case 'item/agentMessage/delta': {
                    const itemId = typeof params?.itemId === 'string' ? params.itemId : undefined
                    const delta = typeof params?.delta === 'string' ? params.delta : ''
                    if (!delta) return
                    if (itemId) messageTextByItem.set(itemId, (messageTextByItem.get(itemId) ?? '') + delta)
                    closeThinking()
                    callbacks.onContent(delta)
                    return
                }
                case 'item/reasoning/textDelta':
                case 'item/reasoning/summaryTextDelta': {
                    const delta = typeof params?.delta === 'string' ? params.delta : ''
                    if (!delta) return
                    if (thinkingStartedAt === null) thinkingStartedAt = Date.now()
                    callbacks.onThinking(delta)
                    return
                }
                case 'item/commandExecution/outputDelta': {
                    const itemId = typeof params?.itemId === 'string' ? params.itemId : undefined
                    const delta = typeof params?.delta === 'string' ? params.delta : ''
                    if (itemId && delta) {
                        if (!firedToolCalls.has(itemId)) fireToolCall(itemId, 'shell', {})
                        callbacks.onToolDelta?.(itemId, 'shell', {
                            stream: 'pty',
                            text: delta,
                            timestamp: Date.now(),
                        })
                    }
                    return
                }
                case 'item/mcpToolCall/progress':
                case 'mcpServer/startupStatus/updated':
                case 'account/rateLimits/updated':
                case 'warning':
                case 'configWarning':
                case 'guardianWarning':
                case 'deprecationNotice':
                    return
                case 'turn/plan/updated':
                    firePlanUpdate(params)
                    return
                case 'item/started':
                    handleItemStarted(params?.item as AnyObj | undefined)
                    return
                case 'item/completed':
                    handleItemCompleted(params?.item as AnyObj | undefined)
                    return
                case 'rawResponseItem/completed':
                    handleRawResponseItemCompleted(params?.item as AnyObj | undefined)
                    return
                case 'error': {
                    const error = params?.error as AnyObj | undefined
                    const message = typeof error?.message === 'string'
                        ? error.message
                        : typeof params?.message === 'string'
                            ? params.message
                            : 'codex app-server error'
                    fail(message)
                    return
                }
                case 'turn/completed': {
                    const turn = params?.turn as AnyObj | undefined
                    if (typeof turn?.durationMs === 'number') finalDurationMs = turn.durationMs
                    if (turn?.status === 'failed') {
                        const err = turn.error as AnyObj | undefined
                        const message = typeof err?.message === 'string' ? err.message : 'codex turn failed'
                        fail(message)
                    }
                    setTimeout(() => shutdown('SIGTERM'), 50)
                    setTimeout(() => shutdown('SIGKILL'), 1550)
                    return
                }
                case 'turn/started': {
                    const turn = params?.turn as AnyObj | undefined
                    if (typeof turn?.id === 'string') activeTurnId = turn.id
                    return
                }
                default:
                    return
            }
        }

        const handleItemStarted = (item?: AnyObj) => {
            if (!item || typeof item.id !== 'string') return
            const itemType = item.type as string | undefined
            if (itemType === 'commandExecution') {
                fireToolCall(item.id, 'shell', {
                    command: typeof item.command === 'string' ? item.command : '',
                    cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
                })
            } else if (itemType === 'mcpToolCall') {
                const name = typeof item.tool === 'string' ? item.tool : 'mcp_tool'
                fireToolCall(item.id, name, toRecord(item.arguments))
            } else if (itemType === 'dynamicToolCall') {
                const name = typeof item.tool === 'string' ? item.tool : 'tool'
                fireToolCall(item.id, name, toRecord(item.arguments))
            } else if (itemType === 'fileChange') {
                fireToolCall(item.id, 'file_change', { status: item.status })
            } else if (itemType === 'webSearch') {
                fireToolCall(item.id, 'web_search', codexWebArgs(item))
            } else if (itemType === 'contextCompaction') {
                fireContextCompaction(undefined, item.id)
            }
        }

        const handleItemCompleted = (item?: AnyObj) => {
            if (!item || typeof item.id !== 'string') return
            const itemType = item.type as string | undefined

            if (itemType === 'agentMessage') {
                const text = typeof item.text === 'string' ? item.text : ''
                const seen = messageTextByItem.get(item.id) ?? ''
                if (text && text.length > seen.length && text.startsWith(seen)) {
                    callbacks.onContent(text.slice(seen.length))
                } else if (text && !seen) {
                    callbacks.onContent(text)
                }
                closeThinking()
                return
            }

            if (itemType === 'reasoning') {
                closeThinking()
                return
            }

            if (itemType === 'commandExecution') {
                const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
                const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null
                if (!firedToolCalls.has(item.id)) {
                    fireToolCall(item.id, 'shell', { command: item.command })
                }
                const success = exitCode === 0 || exitCode === null
                fireToolResult(item.id, 'shell', success, output || (exitCode !== null ? `(exit ${exitCode})` : ''))
                return
            }

            if (itemType === 'mcpToolCall') {
                const name = typeof item.tool === 'string' ? item.tool : 'mcp_tool'
                const ok = item.status === 'completed' && !item.error
                const text = ok ? formatUnknown(item.result) : formatUnknown(item.error ?? item.result)
                if (!firedToolCalls.has(item.id)) fireToolCall(item.id, name, toRecord(item.arguments))
                fireToolResult(item.id, name, ok, text)
                return
            }

            if (itemType === 'dynamicToolCall') {
                const name = typeof item.tool === 'string' ? item.tool : 'tool'
                const ok = item.success !== false && item.status !== 'failed'
                const text = contentItemsToText(item.contentItems) || (ok ? '' : 'Tool call failed')
                if (!firedToolCalls.has(item.id)) fireToolCall(item.id, name, toRecord(item.arguments))
                fireToolResult(item.id, name, ok, text)
                return
            }

            if (itemType === 'fileChange' || itemType === 'webSearch') {
                const name = itemType === 'fileChange' ? 'file_change' : 'web_search'
                if (!firedToolCalls.has(item.id)) {
                    fireToolCall(item.id, name, itemType === 'webSearch' ? codexWebArgs(item) : sanitizeArgs(item))
                }
                fireToolResult(item.id, name, true, formatUnknown(item))
                return
            }

            if (itemType === 'contextCompaction') {
                fireContextCompaction(undefined, item.id)
            }
        }

        const handleRawResponseItemCompleted = (item?: AnyObj) => {
            if (!item) return
            const itemType = item.type as string | undefined

            if (itemType === 'function_call') {
                const namespace = typeof item.namespace === 'string' ? item.namespace : ''
                const name = typeof item.name === 'string' ? item.name : ''
                if (namespace !== 'web' && !isWebToolName(name)) return

                const callId = firstString(item.call_id, item.id) || `codex_raw_web_${++syntheticRawWebCallCount}`
                const callArgs = normalizeRawWebArgs(name, parseJsonRecord(item.arguments))
                rawWebToolCalls.set(callId, { name, args: callArgs })
                fireToolCall(callId, 'web_search', callArgs)
                return
            }

            if (itemType === 'function_call_output') {
                const callId = firstString(item.call_id, item.id)
                if (!callId) return
                const remembered = rawWebToolCalls.get(callId)
                if (!remembered) return
                rawWebToolCalls.delete(callId)
                fireToolResult(callId, 'web_search', true, formatUnknown({
                    type: 'web',
                    name: remembered.name,
                    arguments: remembered.args,
                    output: item.output,
                }))
            }
        }

        void (async () => {
            try {
                await request('initialize', {
                    clientInfo: { name: 'orchestrator', title: 'Orchestrator', version: '0.0.1' },
                    capabilities: { experimentalApi: true },
                })

                const threadParams = buildThreadParams({
                    model,
                    systemPrompt,
                    tools,
                    builtins,
                    nativeCoderRun,
                })

                let threadResult: AnyObj
                if (prevSessionId) {
                    try {
                        threadResult = await request('thread/resume', {
                            threadId: prevSessionId,
                            ...threadParams,
                        }) as AnyObj
                    } catch (err) {
                        rememberDiagnostic(`resume failed: ${err instanceof Error ? err.message : String(err)}`)
                        threadResult = await request('thread/start', threadParams) as AnyObj
                    }
                } else {
                    threadResult = await request('thread/start', threadParams) as AnyObj
                }

                const thread = threadResult.thread as AnyObj | undefined
                if (!thread || typeof thread.id !== 'string') {
                    throw new Error('codex app-server did not return a thread id')
                }
                activeThreadId = thread.id

                const turnParams: AnyObj = {
                    threadId: activeThreadId,
                    input: [{ type: 'text', text: prompt, text_elements: [] }],
                }
                const effort = mapEffortForCodex(thinkingLevel)
                if (effort) turnParams.effort = effort
                if (model && model !== 'default') turnParams.model = model

                const turnResult = await request('turn/start', turnParams) as AnyObj
                const turn = turnResult.turn as AnyObj | undefined
                if (typeof turn?.id === 'string') activeTurnId = turn.id
            } catch (err) {
                fail(err instanceof Error ? err.message : 'codex app-server failed')
                shutdown('SIGTERM')
                setTimeout(() => shutdown('SIGKILL'), 1500)
            }
        })()
    })
}

function buildAppServerArgs(nativeCoderRun: boolean, builtins: ProviderBuiltin[]): string[] {
    const out = ['app-server', '--listen', 'stdio://']
    if (!nativeCoderRun) {
        const allowWebSearch = builtins.includes('web_search')
        const allowShell = codexAllowsShell(builtins)
        out.push('-c', `features.shell_tool=${allowShell ? 'true' : 'false'}`)
        out.push('-c', 'features.multi_agent=false')
        out.push('-c', 'features.apps=false')
        out.push('-c', 'apps._default.enabled=false')
        out.push('-c', allowWebSearch ? 'web_search="live"' : 'web_search="disabled"')
    }
    return out
}

function buildThreadParams(args: {
    model: string
    systemPrompt?: string
    tools: ToolDef[]
    builtins: ProviderBuiltin[]
    nativeCoderRun: boolean
}): AnyObj {
    const params: AnyObj = {
        cwd: AGENT_WORKSPACE_DIR,
        serviceName: 'orchestrator',
        experimentalRawEvents: false,
        persistExtendedHistory: true,
    }

    if (args.model && args.model !== 'default') params.model = args.model
    if (args.systemPrompt?.trim()) params.developerInstructions = args.systemPrompt.trim()

    if (args.nativeCoderRun) {
        params.approvalPolicy = 'never'
        params.sandbox = 'danger-full-access'
    } else {
        const allowWebSearch = args.builtins.includes('web_search')
        const allowShell = codexAllowsShell(args.builtins)
        params.approvalPolicy = 'never'
        // Keep the agent born in the Orchestrator workspace via `cwd`, but do
        // not let Codex's filesystem sandbox block legitimate local operations
        // such as inspecting/killing stuck browser processes for integrations.
        params.sandbox = 'danger-full-access'
        params.config = {
            features: {
                shell_tool: allowShell,
                multi_agent: false,
                apps: false,
            },
            apps: {
                _default: { enabled: false },
            },
            web_search: allowWebSearch ? 'live' : 'disabled',
        }
    }

    if (args.tools.length > 0) {
        params.dynamicTools = args.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.input_schema,
        }))
    }

    return params
}

function codexAllowsShell(builtins: ProviderBuiltin[]): boolean {
    return builtins.some(builtin => (
        builtin === 'bash' ||
        builtin === 'glob' ||
        builtin === 'grep'
    ))
}

function encodeAppServerSessionId(threadId: string): string {
    return `${APP_SERVER_SESSION_PREFIX}${threadId}`
}

function decodeAppServerSessionId(sessionId: string | undefined): string | undefined {
    if (!sessionId?.startsWith(APP_SERVER_SESSION_PREFIX)) return undefined
    return sessionId.slice(APP_SERVER_SESSION_PREFIX.length) || undefined
}

function mapEffortForCodex(level: string | undefined): string | null {
    switch (level) {
        case 'minimal': return 'low'
        case 'low':
        case 'medium':
        case 'high':
        case 'xhigh':
            return level
        case 'max': return 'xhigh'
        default:
            return level ?? null
    }
}

function toRecord(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v)
        ? v as Record<string, unknown>
        : {}
}

function formatToolResult(success: boolean, data: unknown, error: unknown): string {
    if (!success) return typeof error === 'string' ? error : formatUnknown(error ?? 'Tool call failed')
    return formatUnknown(data)
}

function formatUnknown(value: unknown): string {
    if (typeof value === 'string') return value
    if (value === undefined) return ''
    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}

interface SyntheticTodo {
    id: string
    content: string
    status: 'pending' | 'in_progress' | 'completed'
}

function todosFromCodexPlan(params?: AnyObj): SyntheticTodo[] {
    const plan = Array.isArray(params?.plan)
        ? params.plan
        : Array.isArray(toRecord(params?.turn).plan)
            ? toRecord(params?.turn).plan as unknown[]
            : []

    return plan.flatMap((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const record = item as Record<string, unknown>
        const content = firstString(record.step, record.content, record.text, record.title, record.description)
        if (!content) return []
        return [{
            id: firstString(record.id, record.key) || `codex_plan_${index + 1}`,
            content,
            status: normalizePlanStatus(record.status),
        }]
    })
}

function firstString(...values: unknown[]): string {
    for (const value of values) {
        if (typeof value !== 'string') continue
        const trimmed = value.trim()
        if (trimmed) return trimmed
    }
    return ''
}

function normalizePlanStatus(value: unknown): SyntheticTodo['status'] {
    if (typeof value !== 'string') return 'pending'
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
    if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') return 'completed'
    if (normalized === 'in_progress' || normalized === 'inprogress' || normalized === 'running' || normalized === 'active') return 'in_progress'
    return 'pending'
}

function contentItemsToText(value: unknown): string {
    if (!Array.isArray(value)) return ''
    return value.map(item => {
        if (!item || typeof item !== 'object') return ''
        const record = item as Record<string, unknown>
        return typeof record.text === 'string' ? record.text : ''
    }).filter(Boolean).join('\n')
}

function sanitizeArgs(item: AnyObj): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key of ['command', 'tool', 'query', 'path', 'file', 'url', 'status']) {
        const v = item[key]
        if (typeof v === 'string') out[key] = v
    }
    return out
}

const CODEX_WEB_ARG_KEYS = [
    'search_query',
    'searchQuery',
    'image_query',
    'imageQuery',
    'open',
    'click',
    'find',
    'screenshot',
    'sports',
    'finance',
    'weather',
    'time',
]

function codexWebArgs(item: AnyObj): Record<string, unknown> {
    const action = toRecord(item.action)
    const out: Record<string, unknown> = {}
    const query = firstString(item.query, action.query)
    const queries = stringArray(action.queries)

    if (query) out.query = query
    if (queries.length) out.queries = queries

    for (const key of CODEX_WEB_ARG_KEYS) {
        const direct = item[key]
        const fromAction = action[key]
        const value = direct !== undefined ? direct : fromAction
        if (value !== undefined) out[key] = value
    }

    if (Object.keys(action).length > 0) out.action = action
    return out
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : []
}

const RAW_WEB_TOOL_NAMES = new Set([
    'run',
    'search_query',
    'image_query',
    'open',
    'click',
    'find',
    'screenshot',
    'sports',
    'finance',
    'weather',
    'time',
])

function isWebToolName(name: string): boolean {
    return RAW_WEB_TOOL_NAMES.has(name.trim())
}

function normalizeRawWebArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const normalized = name.trim()
    if (!normalized || normalized === 'run') return args
    if (args[normalized] !== undefined) return args

    if (normalized === 'search_query' || normalized === 'image_query') {
        return { ...args, [normalized]: Array.isArray(args[normalized]) ? args[normalized] : [args] }
    }

    if (RAW_WEB_TOOL_NAMES.has(normalized)) {
        return {
            ...args,
            [normalized]: Array.isArray(args[normalized]) ? args[normalized] : [args],
            action: { type: normalized, ...args },
        }
    }

    return args
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    if (typeof value !== 'string' || !value.trim()) return {}
    try {
        const parsed = JSON.parse(value) as unknown
        return toRecord(parsed)
    } catch {
        return {}
    }
}

function codexContextUsageSnapshot(args: {
    raw: Record<string, unknown>
    model: string
    threadId?: string
    turnId?: string
}): ContextUsageSnapshot | null {
    const last = tokenUsageBreakdown(args.raw.last)
    const total = tokenUsageBreakdown(args.raw.total)
    const contextWindow = numberOrNull(args.raw.modelContextWindow)

    const inputTokens = last?.inputTokens ?? null
    const outputTokens = last?.outputTokens ?? null
    const thinkingTokens = last?.reasoningOutputTokens ?? null
    const cachedTokens = last?.cachedInputTokens ?? null
    const totalTokens = last?.totalTokens ?? null
    const contextTokens = sumTokens(inputTokens, outputTokens)

    if (
        contextWindow === null &&
        inputTokens === null &&
        outputTokens === null &&
        thinkingTokens === null &&
        cachedTokens === null &&
        totalTokens === null &&
        !total
    ) {
        return null
    }

    return {
        provider: 'codex',
        model: args.model,
        source: 'provider-live',
        accuracy: 'live',
        updatedAt: Date.now(),
        threadId: args.threadId,
        turnId: args.turnId,
        contextWindow,
        contextTokens,
        inputTokens,
        outputTokens,
        thinkingTokens,
        cachedTokens,
        totalTokens,
        threadTokens: total?.totalTokens ?? null,
        last,
        total,
    }
}

function tokenUsageBreakdown(value: unknown): TokenUsageBreakdown | null {
    const raw = toRecord(value)
    const totalTokens = numberOrNull(raw.totalTokens)
    const inputTokens = numberOrNull(raw.inputTokens)
    const cachedInputTokens = numberOrNull(raw.cachedInputTokens)
    const outputTokens = numberOrNull(raw.outputTokens)
    const reasoningOutputTokens = numberOrNull(raw.reasoningOutputTokens)
    if (
        totalTokens === null &&
        inputTokens === null &&
        cachedInputTokens === null &&
        outputTokens === null &&
        reasoningOutputTokens === null
    ) {
        return null
    }
    return {
        totalTokens,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
    }
}

function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function sumTokens(...values: Array<number | null | undefined>): number | null {
    let total = 0
    let seen = false
    for (const value of values) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
        total += value
        seen = true
    }
    return seen ? total : null
}
