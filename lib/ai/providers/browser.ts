import path from 'path'

import type {
    AIProvider,
    GeneratedMediaAsset,
    ProviderCapabilities,
    ProviderSendOptions,
    StreamCallbacks,
} from '@/lib/ai/agents/types'
import { formatAssetReference, saveGeneratedAsset } from '@/lib/ai/media-assets'
import { getBrowserSessionManager } from '@/lib/ai/providers/browser-session-manager'
import type { BrowserEvidenceCapture } from '@/lib/browser-agent-runtime/agent'
import type { BrowserDownloadFile } from '@/lib/browser-agent-runtime/browser'
import { DEFAULT_AGENT_CONFIG, type AgentConfig as BrowserRuntimeConfig, type BrowserProfileMode, type MediaResolutionLevel } from '@/lib/browser-agent-runtime/config'
import { resolveBrowserBackend } from '@/lib/browser-agent-backend'
import { redactBrowserAgentText } from '@/lib/browser-agent-runtime/redaction'
import { getApiKey, getConfig, type ModelFeatureValue, type ThinkingLevel } from '@/lib/config'
import { activeRuntimePaths } from '@/lib/runtime-paths'
import { latestUserPromptWithPortableHistory } from './history'
import { BROWSER_CAPABILITIES } from './browser-capabilities'

const TASK_POLL_INTERVAL_MS = 500
const TASK_TIMEOUT_MS = parseOptionalTaskTimeoutMs(process.env.BROWSER_AGENT_TASK_TIMEOUT_MS)

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
            const trimmed = redactBrowserAgentText(message).trim()
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
            callbacks.onContent(`${label}: ${formatAssetReference(asset)}\n`)
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
                const safeMessage = redactBrowserAgentText(message)
                lastStatusMessage = safeMessage
                callbacks.onThinking(`${safeMessage}\n`)
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
                if (TASK_TIMEOUT_MS !== null && Date.now() - startedAt > TASK_TIMEOUT_MS) {
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
    const backend = resolveBrowserBackend({
        settingsValue: appConfig.browserAgent.backend,
        chromeExecutablePath: process.env.BROWSER_AGENT_CHROME_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE_PATH || DEFAULT_AGENT_CONFIG.browser.chromeExecutablePath,
    }).effective
    const userDataDirName = backend === 'official-display'
        ? 'user-data-official-display'
        : 'user-data-patchright'

    if (light.provider !== 'google' || pro.provider !== 'google') {
        throw new Error('Browser agent currently supports Google/Gemini models only.')
    }

    return {
        browser: {
            ...DEFAULT_AGENT_CONFIG.browser,
            backend,
            userDataDir: path.join(activeRuntimePaths().privateStateDir, 'browser-agent', userDataDirName),
            profileMode: parseBrowserProfileModeEnv(process.env.BROWSER_AGENT_PROFILE_MODE, DEFAULT_AGENT_CONFIG.browser.profileMode),
            baseProfileDir: process.env.BROWSER_AGENT_BASE_PROFILE_DIR || DEFAULT_AGENT_CONFIG.browser.baseProfileDir,
            chromeExecutablePath: process.env.BROWSER_AGENT_CHROME_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE_PATH || DEFAULT_AGENT_CONFIG.browser.chromeExecutablePath,
            maxConcurrent: parsePositiveIntegerEnv(process.env.BROWSER_AGENT_MAX_CONCURRENT, DEFAULT_AGENT_CONFIG.browser.maxConcurrent),
            launchArgs: backend === 'official-display' ? [] : DEFAULT_AGENT_CONFIG.browser.launchArgs,
            liveView,
            headless: parseBooleanEnv(
                process.env.BROWSER_AGENT_HEADLESS,
                process.platform === 'darwin' ? false : !liveView,
            ),
        },
        runtime: {
            ...DEFAULT_AGENT_CONFIG.runtime,
            actionSettleDelayMs: 1000,
        },
        llm: {
            model: light.model,
            thinkingLevel: mapThinkingLevel(light.thinkingLevel),
            mediaResolution: mapMediaResolution(light.modelOptions?.media_resolution ?? legacyBrowserOptions?.media_resolution),
            advancedModel: pro.model,
            advancedThinkingLevel: mapAdvancedThinkingLevel(pro.thinkingLevel),
            advancedMediaResolution: mapMediaResolution(pro.modelOptions?.media_resolution ?? legacyBrowserOptions?.media_resolution),
            escalationEnabled: appConfig.browserAgent.proEnabled,
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

function parseBrowserProfileModeEnv(value: string | undefined, fallback: BrowserProfileMode): BrowserProfileMode {
    const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-')
    if (normalized === 'isolated' || normalized === 'clone-base' || normalized === 'shared-serial') return normalized
    return fallback
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function parseOptionalTaskTimeoutMs(value: string | undefined): number | null {
    if (value === undefined || value.trim() === '') return null
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    return Math.floor(parsed)
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
    const isCheckpoint = terminalAction?.action === 'checkpoint'
    if (isCheckpoint) {
        lines.push('Action budget reached — this is a CHECKPOINT, not a failure and not a question for the end user.')
        lines.push('The browser session is paused and preserved. Review the full action log under "Terminal output" below, then choose ONE:')
        lines.push('- FINALIZE: the gathered evidence already answers the goal — synthesize the result yourself and do not call the browser again.')
        lines.push('- CONTINUE: call browser_agent again with the SAME thread_id and a corrected, focused instruction. State what is already done (so it does not repeat), the single next sub-goal, and any strategy fix if the log shows it was looping.')
        lines.push('- ABORT: progress is stuck/looping or hard-blocked — stop and report the blocker to the user.')
        lines.push('Do NOT simply re-send the same goal if the log shows repetition without progress. Cap continuations at ~3 segments for one browser task; after that, finalize or abort.')
    } else if (status === 'awaiting_user') {
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
                lines.push(`- [${escapeMarkdownLabel(download.suggestedFilename)}](${download.savedPath}) (${formatDownloadSize(download.size)})`)
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

function formatDownloadSize(size: number | undefined): string {
    if (typeof size !== 'number' || !Number.isFinite(size)) return 'unknown size'
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function escapeMarkdownLabel(value: string): string {
    return value.replace(/([\\\]])/g, '\\$1')
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
