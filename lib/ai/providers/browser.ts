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
import type { BrowserEvidenceCapture } from '@/lib/browser-agent-runtime/agent'
import type { BrowserDownloadFile } from '@/lib/browser-agent-runtime/browser'
import { DEFAULT_AGENT_CONFIG, type AgentConfig as BrowserRuntimeConfig, type MediaResolutionLevel } from '@/lib/browser-agent-runtime/config'
import { PRIVATE_STATE_DIR, getApiKey, getConfig, type ModelFeatureValue, type ThinkingLevel } from '@/lib/config'
import { latestUserPromptWithPortableHistory } from './history'
import { BROWSER_CAPABILITIES } from './browser-capabilities'

const TASK_POLL_INTERVAL_MS = 500
const TASK_TIMEOUT_MS = 10 * 60 * 1000

type BrowserThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'
type BrowserAdvancedThinkingLevel = 'low' | 'medium' | 'high'

export class BrowserProvider implements AIProvider {
    readonly id = 'browser'
    readonly name = 'Browser agent'
    readonly capabilities: ProviderCapabilities = BROWSER_CAPABILITIES

    constructor(apiKey: string) {
        void apiKey
    }

    async stream(options: ProviderSendOptions, callbacks: StreamCallbacks): Promise<void> {
        const goal = latestUserPromptWithPortableHistory(options.messages, Boolean(options.prevSession?.id)).trim()
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
        const statusTranscript: string[] = []
        const recordStatus = (message: string) => {
            const trimmed = message.trim()
            if (!trimmed || statusTranscript[statusTranscript.length - 1] === trimmed) return false
            statusTranscript.push(trimmed)
            return true
        }
        const evidenceAssets: GeneratedMediaAsset[] = []
        const saveEvidenceCapture = (capture: BrowserEvidenceCapture, labelOverride?: string) => {
            const asset = saveGeneratedAsset(capture.data, capture.mimeType, capture.filenameBase)
            evidenceAssets.push(asset)
            const label = labelOverride ?? (
                capture.kind === 'video'
                    ? `Browser video (${Math.round(capture.durationMs / 1000)}s)`
                    : 'Browser screenshot'
            )
            callbacks.onContent(`${label}: [${asset.attachment.filename}](${asset.url})\n`)
            const message = `Saved ${label.toLowerCase()} (${asset.attachment.filename}).`
            recordStatus(message)
            callbacks.onThinking(`${message}\n`)
            return asset
        }
        const sessionManager = getBrowserSessionManager()
        const runtimeConfig = buildBrowserRuntimeConfig()
        const lease = await sessionManager.acquire({
            config: runtimeConfig,
            prevSession: options.prevSession,
            onStatus(message) {
                if (!recordStatus(message)) return
                lastStatusMessage = message
                callbacks.onThinking(`${message}\n`)
            },
            onEvidence(capture) {
                saveEvidenceCapture(capture)
            },
        })
        const runtime = lease.runtime

        if (options.prevSession && !lease.resumed) {
            const message = 'Previous browser session is no longer available; started a fresh browser session for this thread.'
            recordStatus(message)
            callbacks.onThinking(`${message}\n`)
        } else if (lease.resumed) {
            const message = `Resuming browser session ${lease.id}.`
            recordStatus(message)
            callbacks.onThinking(`${message}\n`)
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
                mediaResolution: runtimeConfig.llm.mediaResolution,
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
            const finalCapture = await sessionManager.captureSessionScreenshot(lease.id)
                .catch(() => null)
            if (finalCapture) {
                saveEvidenceCapture(finalCapture, 'Browser final screen')
            }
            const downloads = await sessionManager.collectSessionDownloads(lease.id)
                .catch(() => [] as BrowserDownloadFile[])
            const finalMessage = formatBrowserRunOutput(
                finalStatus.lastStatusMessage || lastStatusMessage,
                finalStatus.currentUrl,
                lease.id,
                managedStatus,
                finalStatus.lastTerminalAction,
                statusTranscript,
                downloads,
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
    const legacyBrowserOptions = appConfig.agentOverrides.browser_agent?.modelOptions
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
            mediaResolution: mapMediaResolution(light.modelOptions?.media_resolution ?? legacyBrowserOptions?.media_resolution),
            advancedModel: pro.model,
            advancedThinkingLevel: mapAdvancedThinkingLevel(pro.thinkingLevel),
            advancedMediaResolution: mapMediaResolution(pro.modelOptions?.media_resolution ?? legacyBrowserOptions?.media_resolution),
        },
    }
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

function mapMediaResolution(value: ModelFeatureValue | undefined): MediaResolutionLevel {
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/^media[_-]resolution[_-]/, '')
    if (normalized === 'low' || normalized === 'medium' || normalized === 'high') return normalized
    if (normalized === 'ultra_high' || normalized === 'ultrahigh') return 'high'
    return 'medium'
}

function formatBrowserRunOutput(
    lastStatusMessage: string,
    currentUrl: string,
    sessionId: string,
    status: string,
    terminalAction?: { action?: string; reasoning?: string; text?: string } | null,
    statusTranscript: string[] = [],
    downloads: BrowserDownloadFile[] = [],
): string {
    const lines = ['Browser agent finished.']
    lines.push(`Browser session: ${sessionId}`)
    lines.push(`Session status: ${status}`)
    if (status === 'awaiting_user') {
        lines.push('Browser is waiting for user input or confirmation. Continue this flow by calling browser_agent again with the same agent_thread_id/thread_id.')
    }
    if (terminalAction?.action) {
        lines.push(`Final action: ${terminalAction.action}`)
    }
    if (terminalAction?.text) {
        lines.push(`Final message: ${terminalAction.text}`)
    } else if (terminalAction?.reasoning) {
        lines.push(`Final message: ${terminalAction.reasoning}`)
    }
    if (lastStatusMessage) lines.push(`Status: ${lastStatusMessage}`)
    if (currentUrl) lines.push(`Current URL: ${currentUrl}`)
    if (downloads.length > 0) {
        lines.push('')
        lines.push('Downloaded files:')
        for (const download of downloads) {
            if (download.state === 'saved' && download.savedPath) {
                lines.push(`- [${escapeMarkdownLabel(download.suggestedFilename)}](${download.savedPath})`)
            } else {
                const reason = download.error ? `: ${download.error}` : ''
                lines.push(`- ${download.suggestedFilename} (${download.state}${reason})`)
            }
        }
    }
    if (statusTranscript.length > 0) {
        lines.push('')
        lines.push('Terminal output:')
        lines.push('```text')
        lines.push(escapeFence(statusTranscript.join('\n')))
        lines.push('```')
    }
    return `${lines.join('\n')}\n`
}

function escapeFence(value: string): string {
    return value.replace(/```/g, '`\u200b``')
}

function escapeMarkdownLabel(value: string): string {
    return value.replace(/([\\\]])/g, '\\$1')
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
