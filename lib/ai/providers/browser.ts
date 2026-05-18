import path from 'path'

import type {
    AIProvider,
    GeneratedMediaAsset,
    ProviderCapabilities,
    ProviderSendOptions,
    StreamCallbacks,
} from '@/lib/ai/agents/types'
import { saveGeneratedAsset } from '@/lib/ai/media-assets'
import { getBrowserSessionManager } from '@/lib/ai/providers/browser-session-manager'
import { DEFAULT_AGENT_CONFIG, type AgentConfig as BrowserRuntimeConfig } from '@/lib/browser-agent-runtime/config'
import { PRIVATE_STATE_DIR, getApiKey, getConfig, type ThinkingLevel } from '@/lib/config'

const TASK_POLL_INTERVAL_MS = 500
const TASK_TIMEOUT_MS = 10 * 60 * 1000

type BrowserThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'
type BrowserAdvancedThinkingLevel = 'low' | 'medium' | 'high'

export class BrowserProvider implements AIProvider {
    readonly id = 'browser'
    readonly name = 'Browser agent'
    readonly capabilities: ProviderCapabilities = {
        kinds: ['text'],
        nativeBuiltins: [],
        statefulMode: true,
        promptCaching: 'none',
        attachmentMode: 'none',
        thinkingSupport: false,
        requiresApiKey: false,
    }

    constructor(apiKey: string) {
        void apiKey
    }

    async stream(options: ProviderSendOptions, callbacks: StreamCallbacks): Promise<void> {
        const goal = latestUserMessage(options).trim()
        if (!goal) {
            callbacks.onError('Browser agent requires a non-empty task prompt.')
            throw new Error('Browser agent requires a non-empty task prompt.')
        }

        const googleApiKey = getApiKey('google')
        if (!googleApiKey) {
            const message = 'Browser agent requires GEMINI_API_KEY because its vision loop currently uses Gemini.'
            callbacks.onError(message)
            throw new Error(message)
        }
        process.env.GEMINI_API_KEY = googleApiKey

        const startedAt = Date.now()
        let lastStatusMessage = ''
        const evidenceAssets: GeneratedMediaAsset[] = []
        const sessionManager = getBrowserSessionManager()
        const runtimeConfig = buildBrowserRuntimeConfig()
        const lease = await sessionManager.acquire({
            config: runtimeConfig,
            prevSession: options.prevSession,
            onStatus(message) {
                if (!message || message === lastStatusMessage) return
                lastStatusMessage = message
                callbacks.onThinking(`${message}\n`)
            },
            onEvidence(capture) {
                const asset = saveGeneratedAsset(capture.data, capture.mimeType, capture.filenameBase)
                evidenceAssets.push(asset)
                const label = capture.kind === 'video'
                    ? `Browser video (${Math.round(capture.durationMs / 1000)}s)`
                    : 'Browser screenshot'
                callbacks.onContent(`${label}: [${asset.attachment.filename}](${asset.url})\n`)
                callbacks.onThinking(`Saved ${label.toLowerCase()} (${asset.attachment.filename}).\n`)
            },
        })
        const runtime = lease.runtime

        if (options.prevSession && !lease.resumed) {
            callbacks.onThinking('Previous browser session is no longer available; started a fresh browser session for this thread.\n')
        } else if (lease.resumed) {
            callbacks.onThinking(`Resuming browser session ${lease.id}.\n`)
        }

        const abort = () => {
            runtime.stopTask()
        }
        options.signal?.addEventListener('abort', abort, { once: true })
        let statusMarked = false

        try {
            await runtime.start()
            await runtime.submitTask(goal, {
                cleanContext: !lease.resumed,
                preserveContext: lease.resumed,
                model: runtimeConfig.llm.model,
                thinkingLevel: runtimeConfig.llm.thinkingLevel,
            })

            let finalStatus = await runtime.getStatus()
            while (finalStatus.running || finalStatus.usage.currentTask) {
                if (options.signal?.aborted) {
                    runtime.stopTask()
                    callbacks.onError('Browser agent aborted.')
                    throw new Error('Browser agent aborted.')
                }
                if (Date.now() - startedAt > TASK_TIMEOUT_MS) {
                    runtime.stopTask()
                    callbacks.onError('Browser agent timed out.')
                    throw new Error('Browser agent timed out.')
                }
                await sleep(TASK_POLL_INTERVAL_MS)
                finalStatus = await runtime.getStatus()
            }

            const managedStatus = sessionManager.markFromRuntimeStatus(lease.id, finalStatus)
            statusMarked = true
            const finalMessage = formatFinalMessage(
                finalStatus.lastStatusMessage || lastStatusMessage,
                finalStatus.currentUrl,
                lease.id,
                managedStatus,
                finalStatus.lastTerminalAction,
            )
            callbacks.onContent(finalMessage)
            callbacks.onDone({
                sessionId: lease.id,
                usage: finalStatus.usage.lastTask ?? finalStatus.usage.session,
                thinkingDuration: Math.max(0, (Date.now() - startedAt) / 1000),
                attachments: evidenceAssets.map(asset => asset.attachment),
            })
        } catch (error) {
            if (!statusMarked) {
                sessionManager.markSessionStatus(lease.id, options.signal?.aborted ? 'stopped' : 'error')
            }
            throw error
        } finally {
            options.signal?.removeEventListener('abort', abort)
            lease.release()
        }
    }
}

function buildBrowserRuntimeConfig(): BrowserRuntimeConfig {
    const appConfig = getConfig()
    const light = appConfig.browserAgent.light
    const pro = appConfig.browserAgent.pro
    const liveView = parseBooleanEnv(process.env.BROWSER_AGENT_LIVE_VIEW, process.platform === 'linux')

    if (light.provider !== 'google' || pro.provider !== 'google') {
        throw new Error('Browser agent currently supports Google/Gemini models only.')
    }

    return {
        browser: {
            ...DEFAULT_AGENT_CONFIG.browser,
            userDataDir: path.join(PRIVATE_STATE_DIR, 'browser-agent', 'user-data-patchright'),
            liveView,
            headless: parseBooleanEnv(
                process.env.BROWSER_AGENT_HEADLESS,
                process.platform === 'darwin' ? false : !liveView,
            ),
        },
        runtime: {
            ...DEFAULT_AGENT_CONFIG.runtime,
            actionSettleDelayMs: 300,
        },
        llm: {
            model: light.model,
            thinkingLevel: mapThinkingLevel(light.thinkingLevel),
            advancedModel: pro.model,
            advancedThinkingLevel: mapAdvancedThinkingLevel(pro.thinkingLevel),
        },
    }
}

function latestUserMessage(options: ProviderSendOptions): string {
    for (let i = options.messages.length - 1; i >= 0; i--) {
        const message = options.messages[i]
        if (message.role === 'user' && typeof message.content === 'string') return message.content
    }
    return ''
}

function mapThinkingLevel(level: ThinkingLevel | undefined): BrowserThinkingLevel {
    if (level === 'minimal' || level === 'low' || level === 'medium' || level === 'high') return level
    return 'high'
}

function mapAdvancedThinkingLevel(level: ThinkingLevel | undefined): BrowserAdvancedThinkingLevel {
    if (level === 'low' || level === 'medium' || level === 'high') return level
    if (level === 'minimal') return 'low'
    return 'high'
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
    return fallback
}

function formatFinalMessage(
    lastStatusMessage: string,
    currentUrl: string,
    sessionId: string,
    status: string,
    terminalAction?: { action?: string; reasoning?: string; text?: string } | null,
): string {
    const lines = ['Browser agent finished.']
    lines.push(`Browser session: ${sessionId}`)
    lines.push(`Session status: ${status}`)
    if (status === 'awaiting_user') {
        lines.push('Browser is waiting for user input or confirmation. Continue this flow by calling browser_agent again with the same agent_thread_id/thread_id.')
    }
    if (terminalAction?.text) {
        lines.push(`Requested input: ${terminalAction.text}`)
    } else if (terminalAction?.reasoning && terminalAction.action === 'ask') {
        lines.push(`Requested input: ${terminalAction.reasoning}`)
    }
    if (lastStatusMessage) lines.push(`Status: ${lastStatusMessage}`)
    if (currentUrl) lines.push(`Current URL: ${currentUrl}`)
    return `${lines.join('\n')}\n`
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
