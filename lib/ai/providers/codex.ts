import { spawn } from 'child_process'

import type {
    AIProvider,
    ImageGenOptions,
    ImageGenResult,
    ProviderCapabilities,
    ProviderBuiltin,
    ProviderSendOptions,
    MessageAttachment,
    StreamCallbacks,
    ToolDef,
} from '@/lib/ai/agents/types'
import { CLI_SPECS } from '@/lib/cli/specs'
import { resolveBin } from '@/lib/cli/resolve-bin'
import { codexCliEnv } from '@/lib/cli/codex-env'
import { executeTool } from '@/lib/ai/tools/executor'
import { getAgent } from '@/lib/ai/agents/registry'
import { getToolsForAgent } from '@/lib/ai/tools/registry'
import { operationalIntegrationFor } from '@/lib/integrations/manifest'
import { subsystemForGatedTool } from '@/lib/integrations/subsystem-manifest'
import { activeRuntimePaths } from '@/lib/runtime-paths'
import type { TokenUsageBreakdown } from '@/lib/types'
import { attachBillingMetadata } from '@/lib/observability/billing-metadata'
import type { BillingUsageEntry } from '@/lib/observability/schema'
import { estimateCodexApiEquivalentCall } from '@/lib/observability/api-equivalent'
import { latestUserPromptWithPortableHistory } from './history'
import { generateCodexImage } from './codex-image'
import {
    codexContextUsageSnapshot,
    codexUsageForBillingUpdate,
    codexUsageForCurrentTurn,
    codexWebArgs,
    contentItemsToText,
    customToolsForCodex,
    firstString,
    formatToolResult,
    formatUnknown,
    isWebToolName,
    normalizeRawWebArgs,
    parseJsonRecord,
    sanitizeArgs,
    toRecord,
    todosFromCodexPlan,
    type AnyObj,
} from './codex-helpers'

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
        kinds: ['text', 'image'],
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
        attachmentMode: 'local-path',
        thinkingSupport: true,
        requiresApiKey: false,
    }

    constructor(apiKey: string) {
        void apiKey
    }

    async stream(options: ProviderSendOptions, cb: StreamCallbacks): Promise<void> {
        const tools = customToolsForCodex(
            options.tools ?? [],
            options.builtins ?? [],
        )
        const isNativeCoderRun =
            options.toolContext?.callerAgentId === 'coder' &&
            tools.length === 0 &&
            !options.systemPrompt?.trim()
        const prevSession = decodeAppServerSessionId(options.prevSession?.id, isNativeCoderRun)
        const userPrompt = latestUserPromptWithPortableHistory(options.messages, Boolean(prevSession))
        const latestUserAttachments = [...options.messages]
            .reverse()
            .find(message => message.role === 'user')
            ?.attachments ?? []
        if (!userPrompt.trim()) {
            cb.onError('codex: empty prompt')
            cb.onDone({})
            return
        }

        return runCodexAppServer({
            bin: CLI_SPECS.codex.bin,
            prompt: userPrompt,
            attachments: latestUserAttachments,
            model: options.model,
            systemPrompt: options.systemPrompt,
            thinkingLevel: options.thinkingLevel,
            tools,
            builtins: options.builtins ?? [],
            toolContext: options.toolContext,
            prevSession,
            nativeCoderRun: isNativeCoderRun,
            cwd: options.cwd,
            signal: options.signal,
            callbacks: cb,
        })
    }

    async generateImage(options: ImageGenOptions): Promise<ImageGenResult> {
        return generateCodexImage(options)
    }
}

// ---------------------------------------------------------------------------
// App-server JSON-RPC runner
// ---------------------------------------------------------------------------

interface RunCodexAppServerArgs {
    bin: string
    prompt: string
    attachments?: MessageAttachment[]
    model: string
    systemPrompt?: string
    thinkingLevel?: string
    tools: ToolDef[]
    builtins: ProviderBuiltin[]
    toolContext?: ProviderSendOptions['toolContext']
    prevSession?: AppServerSession
    nativeCoderRun: boolean
    cwd?: string
    signal?: AbortSignal
    callbacks: StreamCallbacks
    /** Test-hook-only child env additions; production provider calls omit it. */
    spawnEnv?: Record<string, string | undefined>
}

const APP_SERVER_SESSION_PREFIX = 'appserver:'
// Managed Codex threads freeze developer instructions and multi-agent config at
// birth. Bump this generation when either policy must be re-applied; stale app
// sessions then start fresh and latestUserPromptWithPortableHistory carries the
// Orchestrator conversation across. Promptless native Coder sessions keep the
// generic prefix and remain resumable.
const MANAGED_APP_SERVER_SESSION_PREFIX = 'appserver:managed-policy-v8:'
const LEGACY_DIRECT_TOOL_SESSION_PREFIX = 'appserver:direct:'
const JSON_RPC_REQUEST_TIMEOUT_MS = 60_000
const CODEX_RECONNECTING_NOTICE_RE = /^Reconnecting(?:\.{3}|…)\s+\d+\/\d+$/i
const BLOCKING_DELEGATION_TOOLS = new Set(['delegate_to', 'delegate_parallel'])
const ORCHESTRATOR_TOOL_NAMESPACE = 'orchestrator'
const ORCHESTRATOR_TOOL_NAMESPACE_DESCRIPTION =
    'Tools provided by Orchestrator for managed workflows, integrations, and specialist delegation.'

interface AppServerSession {
    threadId: string
}

export function isTransientCodexAppServerError(message: string): boolean {
    return CODEX_RECONNECTING_NOTICE_RE.test(message.trim())
}

async function runCodexAppServer(args: RunCodexAppServerArgs): Promise<void> {
    const {
        bin,
        prompt,
        attachments,
        model,
        systemPrompt,
        thinkingLevel,
        tools,
        builtins,
        toolContext,
        prevSession,
        nativeCoderRun,
        cwd,
        signal,
        callbacks,
        spawnEnv,
    } = args

    return new Promise<void>(resolve => {
        const resolved = resolveBin(bin)
        const procArgs = buildAppServerArgs(nativeCoderRun, builtins)
        let proc: ReturnType<typeof spawn>

        try {
            proc = spawn(resolved, procArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: codexCliEnv(spawnEnv),
                cwd: cwd ?? activeRuntimePaths().agentWorkspaceDir,
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
        let turnUsageBaseline: TokenUsageBreakdown | null = null
        let billingPreviousTotal: TokenUsageBreakdown | null = null
        let activeBillingModel = model
        const billingByModel = new Map<string, BillingUsageEntry>()
        let providerError: string | null = null
        const diagnostics: string[] = []

        const pending = new Map<number, {
            method: string
            resolve: (value: unknown) => void
            reject: (err: Error) => void
            timer: ReturnType<typeof setTimeout>
        }>()

        const inflightTools = new Map<string, { name: string; arguments: Record<string, unknown> }>()
        const firedToolCalls = new Set<string>()
        const firedToolResults = new Set<string>()
        const firedCompactions = new Set<string>()
        const rawWebToolCalls = new Map<string, { name: string; args: Record<string, unknown> }>()
        // app-server can overlap multiple agentMessage items in one turn. Their
        // delta notifications are independently ordered per item, not globally;
        // forwarding every delta immediately splices words from two messages
        // together and persists unreadable output. Keep one ordered lane per
        // item and only advance to the next item after the previous completes.
        const agentMessageOrder: string[] = []
        const agentMessages = new Map<string, {
            text: string
            emittedChars: number
            completed: boolean
        }>()
        let nextAgentMessageIndex = 0
        const blockingDelegations = new Set<string>()
        const activeReasoningItems = new Set<string>()
        const delegationWaitReasoningItems = new Set<string>()
        let parentActivityViolation = false
        // A synchronous parent stays dormant by default. An explicit user
        // steer is the sole exception: it opens a temporary intervention
        // window so the root can inspect/cancel obsolete child work or do a
        // small course correction while the original delegate call remains
        // pending. Spontaneous provider activity still fails closed below.
        let parentInterventionAllowed = false
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

        // Mid-turn steering: once the turn is live, expose a delivery function
        // that appends user input to the in-flight turn via `turn/steer`
        // (codex >= 0.98; on older CLIs the request errors and the caller
        // falls back to the follow-up queue — no version probing needed).
        let steeringAnnounced = false
        const announceSteering = () => {
            if (steeringAnnounced || !callbacks.onSteeringAvailable) return
            if (!activeThreadId || !activeTurnId) return
            steeringAnnounced = true
            callbacks.onSteeringAvailable(async (text: string) => {
                const trimmed = text.trim()
                if (!trimmed || finished || aborted || !activeThreadId || !activeTurnId) return false
                const opensDelegationIntervention = blockingDelegations.size > 0
                    && !parentInterventionAllowed
                if (opensDelegationIntervention) {
                    parentInterventionAllowed = true
                    try {
                        // The synchronous executor released this parent's one
                        // global active permit while sleeping. Explicit user
                        // steering makes it active again, so admission must be
                        // reacquired before the provider is allowed to resume.
                        await toolContext?.permit?.reacquireForResume()
                    } catch (err) {
                        parentInterventionAllowed = false
                        rememberDiagnostic(`steering admission failed: ${err instanceof Error ? err.message : String(err)}`)
                        return false
                    }
                }
                const steeredText = blockingDelegations.size > 0
                    ? [
                        '<orchestrator_user_intervention>',
                        'A synchronous Orchestrator delegation is still running. This explicit user message temporarily wakes the root parent without changing the default synchronous behavior.',
                        'Decide whether the new instruction makes current child work obsolete. Use manage_delegations action="list" to inspect active_synchronous entries and action="cancel" with that batch_id only when work should stop. Otherwise do not duplicate it; perform only useful intervention work, then call manage_delegations action="sleep" to release your active slot and return to waiting for the original delegate result. Never claim the pending child has finished.',
                        '</orchestrator_user_intervention>',
                        '',
                        trimmed,
                    ].join('\n')
                    : trimmed
                try {
                    await request('turn/steer', {
                        threadId: activeThreadId,
                        input: [{ type: 'text', text: steeredText, text_elements: [] }],
                        expectedTurnId: activeTurnId,
                    })
                    return true
                } catch (err) {
                    if (opensDelegationIntervention) {
                        parentInterventionAllowed = false
                        if (blockingDelegations.size > 0) toolContext?.permit?.releaseForChildren()
                    }
                    rememberDiagnostic(`turn/steer failed: ${err instanceof Error ? err.message : String(err)}`)
                    return false
                }
            })
        }
        const retractSteering = () => {
            if (!steeringAnnounced) return
            steeringAnnounced = false
            callbacks.onSteeringAvailable?.(null)
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
            inflightTools.set(id, { name, arguments: callArgs })
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
            retractSteering()
            signal?.removeEventListener('abort', onAbort)
            for (const entry of pending.values()) clearTimeout(entry.timer)
            pending.clear()
            closeThinking()
            for (const [id, { name }] of inflightTools) {
                fireToolResult(id, name, false, 'No completion event received')
            }
            callbacks.onDone({
                sessionId: activeThreadId
                    ? encodeAppServerSessionId(activeThreadId, nativeCoderRun)
                    : undefined,
                usage: attachBillingMetadata(finalUsage, [...billingByModel.values()]),
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

        const stopParentActivityDuringDelegation = (activity: string): boolean => {
            if (parentActivityViolation) return true
            if (blockingDelegations.size === 0) return false
            if (parentInterventionAllowed) return false

            parentActivityViolation = true
            const message = [
                'Codex resumed the parent while a synchronous delegation was still running.',
                `Blocked parent activity: ${activity}.`,
            ].join(' ')
            rememberDiagnostic(message)
            fail(message)

            if (activeThreadId && activeTurnId) {
                void request('turn/interrupt', {
                    threadId: activeThreadId,
                    turnId: activeTurnId,
                }).catch(err => {
                    rememberDiagnostic(`turn/interrupt failed: ${err instanceof Error ? err.message : String(err)}`)
                    shutdown('SIGTERM')
                })
            } else {
                shutdown('SIGTERM')
            }
            return true
        }

        const ensureAgentMessage = (itemId: string) => {
            let message = agentMessages.get(itemId)
            if (!message) {
                message = { text: '', emittedChars: 0, completed: false }
                agentMessages.set(itemId, message)
                agentMessageOrder.push(itemId)
            }
            return message
        }

        const flushOrderedAgentMessages = () => {
            while (nextAgentMessageIndex < agentMessageOrder.length) {
                const itemId = agentMessageOrder[nextAgentMessageIndex]
                const message = agentMessages.get(itemId)
                if (!message) {
                    nextAgentMessageIndex += 1
                    continue
                }
                if (message.text.length > message.emittedChars) {
                    callbacks.onContent(message.text.slice(message.emittedChars))
                    message.emittedChars = message.text.length
                }
                if (!message.completed) return
                nextAgentMessageIndex += 1
            }
        }

        const appendAgentMessageDelta = (itemId: string, delta: string) => {
            const message = ensureAgentMessage(itemId)
            message.text += delta
            flushOrderedAgentMessages()
        }

        const completeAgentMessage = (itemId: string, completedText: string) => {
            const message = ensureAgentMessage(itemId)
            if (completedText) {
                if (message.emittedChars === 0) {
                    // A queued item has not reached the UI yet, so its canonical
                    // completed payload can safely replace any partial deltas.
                    message.text = completedText
                } else if (completedText.startsWith(message.text)) {
                    message.text = completedText
                } else if (!message.text.startsWith(completedText)) {
                    // Already-emitted text cannot be retracted. Fail closed on
                    // the divergent suffix rather than duplicating/corrupting it.
                    rememberDiagnostic(`agentMessage ${itemId} completed text diverged from streamed deltas`)
                }
            }
            message.completed = true
            flushOrderedAgentMessages()
        }

        const belongsToActiveTurn = (params?: AnyObj): boolean => {
            const eventTurnId = firstString(
                params?.turnId,
                (params?.turn as AnyObj | undefined)?.id,
                (params?.item as AnyObj | undefined)?.turnId,
            )
            return !eventTurnId || (Boolean(activeTurnId) && eventTurnId === activeTurnId)
        }

        signal?.addEventListener('abort', onAbort, { once: true })

        // setEncoding routes chunks through a StringDecoder so a multi-byte
        // UTF-8 character split across chunk boundaries never decodes to
        // replacement chars (which would corrupt JSON-RPC lines).
        proc.stdout?.setEncoding('utf8')
        proc.stderr?.setEncoding('utf8')
        // Writes can race the CLI dying; without a listener an EPIPE on stdin
        // becomes an uncaught stream error that takes down the whole server.
        proc.stdin?.on('error', err => rememberDiagnostic(`stdin write failed: ${err.message}`))

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
                handleMessage(msg).catch(err => {
                    rememberDiagnostic(`message handling failed: ${err instanceof Error ? err.message : String(err)}`)
                })
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
                try {
                    handleMessage(JSON.parse(stdoutBuf.trim()) as AnyObj).catch(() => rememberDiagnostic(stdoutBuf))
                } catch { rememberDiagnostic(stdoutBuf) }
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
            const namespace = typeof params?.namespace === 'string' ? params.namespace : ''
            const toolName = typeof params?.tool === 'string' ? params.tool : ''
            const callArgs = toRecord(params?.arguments)
            const acceptedNamespace = !namespace || namespace === ORCHESTRATOR_TOOL_NAMESPACE
            let tool = acceptedNamespace
                ? tools.find(t => t.name === toolName || t.id === toolName)
                : undefined
            if (!tool && acceptedNamespace && toolContext?.callerAgentId) {
                // Codex's dynamicTools list is fixed for the run, so a gated
                // capability tool the model wants mid-run (maps/weather/monitor/
                // schedule/watchlist/microscript/integration ops) isn't advertised
                // even after ActivateIntegrationTools. Resolve it from the caller's
                // own declared grant (gated capability tools only) and run it, so
                // the model doesn't dead-end on "Unknown tool".
                const agent = getAgent(toolContext.callerAgentId)
                if (agent) {
                    const candidate = getToolsForAgent(agent.tools).find(t => t.name === toolName || t.id === toolName)
                    if (candidate && (operationalIntegrationFor(candidate.id) || subsystemForGatedTool(candidate.id))) {
                        tool = candidate
                    }
                }
            }
            const surfacedName = tool?.name ?? (toolName || 'tool')
            const blocksParentOutput = BLOCKING_DELEGATION_TOOLS.has(tool?.id ?? toolName)

            if (!acceptedNamespace) {
                const qualifiedName = `${namespace}.${toolName || 'tool'}`
                if (stopParentActivityDuringDelegation(`dynamic tool ${qualifiedName}`)) {
                    respond(requestId, {
                        contentItems: [{ type: 'inputText', text: 'Parent activity blocked while delegation is running.' }],
                        success: false,
                    })
                    return
                }
                const error = `Unknown dynamic tool namespace: ${qualifiedName}`
                fireToolCall(callId, qualifiedName, callArgs)
                respond(requestId, {
                    contentItems: [{ type: 'inputText', text: error }],
                    success: false,
                })
                return
            }

            if (!blocksParentOutput && stopParentActivityDuringDelegation(`dynamic tool ${surfacedName}`)) {
                respond(requestId, {
                    contentItems: [{ type: 'inputText', text: 'Parent activity blocked while delegation is running.' }],
                    success: false,
                })
                return
            }

            // Mark the parent dormant before surfacing the card. A user can
            // steer immediately after seeing that event; the steering callback
            // must already know this is an intervention over synchronous work.
            if (blocksParentOutput && tool) blockingDelegations.add(callId)
            fireToolCall(callId, surfacedName, callArgs)

            if (!tool) {
                blockingDelegations.delete(callId)
                if (blockingDelegations.size === 0) parentInterventionAllowed = false
                const error = `Unknown tool: ${toolName}`
                respond(requestId, {
                    contentItems: [{ type: 'inputText', text: error }],
                    success: false,
                })
                return
            }

            try {
                const result = await executeTool(tool, callArgs, toolContext
                    ? { ...toolContext, currentToolCallId: callId }
                    : undefined)
                respond(requestId, {
                    contentItems: [{ type: 'inputText', text: formatToolResult(result.success, result.data, result.error) }],
                    success: result.success,
                })
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err)
                respond(requestId, {
                    contentItems: [{ type: 'inputText', text: error }],
                    success: false,
                })
            }
            // `item/completed` is the ordered protocol boundary that releases
            // the parent after a synchronous delegation response.
        }

        const handleNotification = (method: string, params?: AnyObj) => {
            switch (method) {
                case 'thread/started': {
                    const thread = params?.thread as AnyObj | undefined
                    if (typeof thread?.id === 'string') activeThreadId = thread.id
                    return
                }
                case 'thread/tokenUsage/updated': {
                    const eventTurnId = typeof params?.turnId === 'string' ? params.turnId : undefined
                    const belongsToCurrentTurn = eventTurnId
                        ? (!activeTurnId || eventTurnId === activeTurnId)
                        : Boolean(activeTurnId)
                    if (belongsToCurrentTurn) {
                        const billing = codexUsageForBillingUpdate(params?.tokenUsage, billingPreviousTotal)
                        billingPreviousTotal = billing.total ?? billingPreviousTotal
                        if (billing.usage) {
                            recordCodexBillingUsage(
                                billingByModel,
                                activeBillingModel,
                                billing.usage,
                                billing.contextInputTokens
                            )
                        }
                        // Codex reports `total` as a cumulative thread counter on
                        // resumed stateful threads. Request logs need the current
                        // turn only, so derive a per-turn delta from total - first
                        // observed baseline while still falling back to `last`.
                        const nextUsage = codexUsageForCurrentTurn(params?.tokenUsage, turnUsageBaseline)
                        turnUsageBaseline = nextUsage.baseline
                        finalUsage = nextUsage.usage ?? finalUsage
                    }
                    fireContextUsage(params)
                    return
                }
                case 'model/rerouted': {
                    const eventTurnId = typeof params?.turnId === 'string' ? params.turnId : undefined
                    if ((!eventTurnId || !activeTurnId || eventTurnId === activeTurnId) && typeof params?.toModel === 'string') {
                        activeBillingModel = params.toModel
                    }
                    return
                }
                case 'thread/compacted':
                    fireContextCompaction(params)
                    return
                case 'item/agentMessage/delta': {
                    const itemId = typeof params?.itemId === 'string' ? params.itemId : undefined
                    const delta = typeof params?.delta === 'string' ? params.delta : ''
                    if (!itemId || !delta || !belongsToActiveTurn(params)) return
                    if (stopParentActivityDuringDelegation('agent message')) return
                    closeThinking()
                    appendAgentMessageDelta(itemId, delta)
                    return
                }
                case 'item/reasoning/textDelta':
                case 'item/reasoning/summaryTextDelta': {
                    const delta = typeof params?.delta === 'string' ? params.delta : ''
                    if (!delta) return
                    const itemId = typeof params?.itemId === 'string' ? params.itemId : ''
                    if (delegationWaitReasoningItems.has(itemId)) return
                    const beganBeforeDelegation = itemId !== '' && activeReasoningItems.has(itemId)
                    if (!beganBeforeDelegation && blockingDelegations.size > 0) {
                        // Legacy Codex threads can retain their original flat
                        // dynamic-tool catalog because thread/resume cannot
                        // replace dynamicTools. A synchronous delegation then
                        // runs inside a Code Mode cell: after exec yields, Codex
                        // must briefly reason before issuing the native wait
                        // call for that live cell. Suppress that internal wait
                        // reasoning while the normal activity guard continues
                        // to block messages and every observable parent tool.
                        if (itemId) delegationWaitReasoningItems.add(itemId)
                        return
                    }
                    if (thinkingStartedAt === null) thinkingStartedAt = Date.now()
                    callbacks.onThinking(delta)
                    return
                }
                case 'item/commandExecution/outputDelta': {
                    const itemId = typeof params?.itemId === 'string' ? params.itemId : undefined
                    const delta = typeof params?.delta === 'string' ? params.delta : ''
                    if (stopParentActivityDuringDelegation('shell output')) return
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
                    if (belongsToActiveTurn(params)) {
                        handleItemStarted(params?.item as AnyObj | undefined)
                    }
                    return
                case 'item/completed':
                    if (belongsToActiveTurn(params)) {
                        handleItemCompleted(params?.item as AnyObj | undefined)
                    }
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
                    if (isTransientCodexAppServerError(message)) {
                        rememberDiagnostic(message)
                        return
                    }
                    fail(message)
                    return
                }
                case 'turn/completed': {
                    const turn = params?.turn as AnyObj | undefined
                    if (activeTurnId && typeof turn?.id === 'string' && turn.id !== activeTurnId) return
                    retractSteering()
                    // Defensive fallback for an app-server version that closes
                    // a turn without item/completed for its final message.
                    for (const message of agentMessages.values()) message.completed = true
                    flushOrderedAgentMessages()
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
                    announceSteering()
                    return
                }
                default:
                    return
            }
        }

        const handleItemStarted = (item?: AnyObj) => {
            if (!item || typeof item.id !== 'string') return
            const itemType = item.type as string | undefined
            if (itemType === 'collabAgentToolCall') {
                blockNativeCodexCollaboration(item)
                return
            }
            if (itemType === 'reasoning' && blockingDelegations.size > 0) {
                // Code Mode's exec -> wait control loop is safe parent-idle
                // machinery, not resumed user-visible work. The wait tool is
                // executed internally by Codex; any subsequent shell, file,
                // MCP, dynamic-tool, or message item still fails closed below.
                delegationWaitReasoningItems.add(item.id)
                return
            }
            if (itemType !== 'dynamicToolCall' && stopParentActivityDuringDelegation(itemType ?? 'tool')) {
                return
            }
            if (itemType === 'agentMessage') ensureAgentMessage(item.id)
            if (itemType === 'reasoning') activeReasoningItems.add(item.id)
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
                const blocksParentOutput = BLOCKING_DELEGATION_TOOLS.has(name)
                if (blocksParentOutput) blockingDelegations.add(item.id)
                if (!blocksParentOutput && stopParentActivityDuringDelegation(`dynamic tool ${name}`)) {
                    return
                }
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

            if (itemType === 'collabAgentToolCall') {
                blockNativeCodexCollaboration(item)
                return
            }

            if (itemType === 'agentMessage') {
                const text = typeof item.text === 'string' ? item.text : ''
                if (stopParentActivityDuringDelegation('agent message')) {
                    return
                }
                closeThinking()
                completeAgentMessage(item.id, text)
                return
            }

            if (itemType === 'reasoning') {
                if (delegationWaitReasoningItems.delete(item.id)) return
                const beganBeforeDelegation = activeReasoningItems.delete(item.id)
                if (!beganBeforeDelegation && stopParentActivityDuringDelegation('reasoning')) return
                closeThinking()
                return
            }

            if (itemType === 'commandExecution') {
                if (stopParentActivityDuringDelegation('shell command')) return
                const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
                const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null
                const status = typeof item.status === 'string' ? item.status : null
                const errorText = formatUnknown(item.error)
                if (!firedToolCalls.has(item.id)) {
                    fireToolCall(item.id, 'shell', { command: item.command })
                }
                const success = (status === null || status === 'completed') && exitCode === 0 && !item.error
                const resultText = output
                    || (errorText && errorText !== 'null' ? errorText : '')
                    || (exitCode !== null ? `(exit ${exitCode})` : '')
                    || (status ? `(status ${status})` : 'Command did not complete')
                fireToolResult(item.id, 'shell', success, resultText)
                return
            }

            if (itemType === 'mcpToolCall') {
                if (stopParentActivityDuringDelegation('MCP tool')) return
                const name = typeof item.tool === 'string' ? item.tool : 'mcp_tool'
                const ok = item.status === 'completed' && !item.error
                const text = ok ? formatUnknown(item.result) : formatUnknown(item.error ?? item.result)
                if (!firedToolCalls.has(item.id)) fireToolCall(item.id, name, toRecord(item.arguments))
                fireToolResult(item.id, name, ok, text)
                return
            }

            if (itemType === 'dynamicToolCall') {
                const name = typeof item.tool === 'string' ? item.tool : 'tool'
                if (!BLOCKING_DELEGATION_TOOLS.has(name) && stopParentActivityDuringDelegation(`dynamic tool ${name}`)) {
                    return
                }
                const callArgs = inflightTools.get(item.id)?.arguments ?? toRecord(item.arguments)
                const returnsToSynchronousWait = name === 'manage_delegations'
                    && callArgs.action === 'sleep'
                const ok = item.success !== false && item.status !== 'failed'
                const text = contentItemsToText(item.contentItems) || (ok ? '' : 'Tool call failed')
                if (!firedToolCalls.has(item.id)) fireToolCall(item.id, name, toRecord(item.arguments))
                fireToolResult(item.id, name, ok, text)
                if (ok && returnsToSynchronousWait && blockingDelegations.size > 0) {
                    parentInterventionAllowed = false
                }
                blockingDelegations.delete(item.id)
                if (blockingDelegations.size === 0) parentInterventionAllowed = false
                return
            }

            if (itemType === 'fileChange' || itemType === 'webSearch') {
                if (stopParentActivityDuringDelegation(itemType)) return
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

        let nativeCollaborationViolation = false
        const blockNativeCodexCollaboration = (item: AnyObj) => {
            if (nativeCollaborationViolation) return
            nativeCollaborationViolation = true
            const tool = firstString(item.tool, item.name) || 'unknown collaboration tool'
            const message = [
                'Blocked a Codex-native sub-agent operation in an Orchestrator-managed run.',
                `Native tool: ${tool}.`,
                'Specialists must be launched only through Orchestrator delegation tools.',
            ].join(' ')
            rememberDiagnostic(message)
            fail(message)
            if (activeThreadId && activeTurnId) {
                void request('turn/interrupt', {
                    threadId: activeThreadId,
                    turnId: activeTurnId,
                }).finally(() => shutdown('SIGTERM'))
            } else {
                shutdown('SIGTERM')
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

                const effectiveCwd = cwd ?? activeRuntimePaths().agentWorkspaceDir

                const threadParams = buildThreadParams({
                    model,
                    systemPrompt,
                    tools,
                    builtins,
                    nativeCoderRun,
                    cwd: effectiveCwd,
                })

                let threadResult: AnyObj
                if (prevSession) {
                    try {
                        // Codex 0.144.x accepts dynamicTools only on
                        // thread/start. A resumed thread retains the catalog it
                        // was born with, so do not pretend this field upgrades
                        // legacy flat catalogs. The delegation activity guard
                        // above supports their native exec -> wait lifecycle.
                        const resumeParams = { ...threadParams }
                        delete resumeParams.dynamicTools
                        threadResult = await request('thread/resume', {
                            threadId: prevSession.threadId,
                            ...resumeParams,
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
                if (typeof threadResult.model === 'string' && threadResult.model.trim()) {
                    activeBillingModel = threadResult.model.trim()
                }

                const turnParams: AnyObj = {
                    threadId: activeThreadId,
                    input: buildCodexTurnInput(prompt, attachments),
                }
                const effort = mapEffortForCodex(thinkingLevel)
                if (effort) turnParams.effort = effort
                if (model && model !== 'default') turnParams.model = model

                const turnResult = await request('turn/start', turnParams) as AnyObj
                const turn = turnResult.turn as AnyObj | undefined
                if (typeof turn?.id === 'string') activeTurnId = turn.id
                announceSteering()
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
    // Orchestrator owns workflow skills through its own tools. Keep Codex-native
    // skills disabled even for plain coder runs, otherwise Codex may probe
    // CODEX_HOME/.codex/skills paths that are intentionally absent.
    // Disable every Codex-native collaboration path at process birth. The
    // Orchestrator prompt + namespaced delegate_* tools own agent routing; do
    // not reuse Codex's multi-agent policy slot for standing authorization,
    // because 0.144.x can expose native collaboration tools from that slot
    // even when its nested `enabled` field says false.
    out.push('--disable', 'multi_agent')
    out.push('--disable', 'multi_agent_v2')
    out.push('--disable', 'enable_fanout')
    out.push('-c', 'features.apps=false')
    out.push('-c', 'features.plugins=false')
    out.push('-c', 'features.skills=false')
    if (!nativeCoderRun) {
        const allowWebSearch = builtins.includes('web_search')
        const allowShell = codexAllowsShell(builtins)
        // Model catalog entries may force code_mode_only even when its feature
        // flag is off. Keep Orchestrator's namespace direct at process level;
        // the same override is included in the thread config below.
        out.push('-c', `features.code_mode.direct_only_tool_namespaces=["${ORCHESTRATOR_TOOL_NAMESPACE}"]`)
        out.push('-c', `features.shell_tool=${allowShell ? 'true' : 'false'}`)
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
    cwd?: string
}): AnyObj {
    const params: AnyObj = {
        cwd: args.cwd ?? activeRuntimePaths().agentWorkspaceDir,
        serviceName: 'orchestrator',
        experimentalRawEvents: false,
        persistExtendedHistory: true,
    }

    if (args.model && args.model !== 'default') params.model = args.model
    if (args.systemPrompt?.trim()) params.developerInstructions = args.systemPrompt.trim()

    if (args.nativeCoderRun) {
        params.approvalPolicy = 'never'
        params.sandbox = 'danger-full-access'
        params.config = {
            features: {
                multi_agent: false,
                multi_agent_v2: false,
                enable_fanout: false,
                apps: false,
                plugins: false,
                skills: false,
            },
        }
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
                code_mode: {
                    direct_only_tool_namespaces: [ORCHESTRATOR_TOOL_NAMESPACE],
                },
                shell_tool: allowShell,
                multi_agent: false,
                multi_agent_v2: false,
                enable_fanout: false,
                apps: false,
                plugins: false,
                skills: false,
            },
            apps: {
                _default: { enabled: false },
            },
            web_search: allowWebSearch ? 'live' : 'disabled',
        }
    }

    if (args.tools.length > 0) {
        params.dynamicTools = [{
            type: 'namespace',
            name: ORCHESTRATOR_TOOL_NAMESPACE,
            description: ORCHESTRATOR_TOOL_NAMESPACE_DESCRIPTION,
            tools: args.tools.map(tool => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                inputSchema: tool.input_schema,
            })),
        }]
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

function buildCodexTurnInput(prompt: string, attachments: MessageAttachment[] = []): AnyObj[] {
    const input: AnyObj[] = [{ type: 'text', text: prompt, text_elements: [] }]
    for (const attachment of attachments) {
        const mimeType = attachment.mimeType.split(';')[0].trim().toLowerCase()
        if (!mimeType.startsWith('image/') || !attachment.filePath.trim()) continue
        input.push({ type: 'localImage', path: attachment.filePath })
    }
    return input
}

export const codexProviderTestHooks = {
    runCodexAppServer,
    buildAppServerArgs,
    buildThreadParams,
    buildCodexTurnInput,
    encodeAppServerSessionId,
    decodeAppServerSessionId,
}

function encodeAppServerSessionId(threadId: string, nativeCoderRun = false): string {
    const prefix = nativeCoderRun
        ? APP_SERVER_SESSION_PREFIX
        : MANAGED_APP_SERVER_SESSION_PREFIX
    return `${prefix}${threadId}`
}

function decodeAppServerSessionId(
    sessionId: string | undefined,
    nativeCoderRun = false
): AppServerSession | undefined {
    if (!sessionId) return undefined

    if (!nativeCoderRun) {
        if (!sessionId.startsWith(MANAGED_APP_SERVER_SESSION_PREFIX)) return undefined
        const threadId = sessionId.slice(MANAGED_APP_SERVER_SESSION_PREFIX.length)
        return threadId ? { threadId } : undefined
    }

    if (sessionId.startsWith(MANAGED_APP_SERVER_SESSION_PREFIX)) return undefined
    if (sessionId.startsWith(LEGACY_DIRECT_TOOL_SESSION_PREFIX)) {
        const threadId = sessionId.slice(LEGACY_DIRECT_TOOL_SESSION_PREFIX.length)
        return threadId ? { threadId } : undefined
    }
    if (!sessionId.startsWith(APP_SERVER_SESSION_PREFIX)) return undefined
    const threadId = sessionId.slice(APP_SERVER_SESSION_PREFIX.length)
    return threadId ? { threadId } : undefined
}

function recordCodexBillingUsage(
    byModel: Map<string, BillingUsageEntry>,
    model: string,
    usage: TokenUsageBreakdown,
    contextInputTokens: number | null
): void {
    const input = usage.inputTokens ?? 0
    const output = usage.outputTokens ?? 0
    const cached = usage.cachedInputTokens ?? 0
    const thinking = usage.reasoningOutputTokens ?? 0
    const total = usage.totalTokens ?? input + output
    if (input === 0 && output === 0 && cached === 0 && total === 0) return

    const cleanModel = model.trim() || 'default'
    const estimate = estimateCodexApiEquivalentCall(
        cleanModel,
        { inputTokens: input, outputTokens: output, cachedTokens: cached },
        contextInputTokens ?? input
    )
    const entry = byModel.get(cleanModel) ?? {
        provider: 'codex',
        model: cleanModel,
        requests: 1,
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cachedTokens: 0,
        toolUseTokens: 0,
        totalTokens: 0,
    }
    entry.inputTokens += input
    entry.outputTokens += output
    entry.thinkingTokens += thinking
    entry.cachedTokens += cached
    entry.totalTokens += total
    if (estimate) {
        entry.apiEquivalentCostUsd = (entry.apiEquivalentCostUsd ?? 0) + estimate.usd
        entry.costSource = estimate.costSource
        entry.costAccuracy = estimate.costAccuracy
        entry.pricingSource = estimate.pricingSource
        entry.pricingAsOf = estimate.pricingAsOf
    }
    byModel.set(cleanModel, entry)
}

export function mapEffortForCodex(level: string | undefined): string | null {
    switch (level) {
        case 'minimal': return 'low'
        case 'low':
        case 'medium':
        case 'high':
        case 'xhigh':
        case 'max':
        case 'ultra':
            return level
        default:
            return level ?? null
    }
}
