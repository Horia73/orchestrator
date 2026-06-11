/**
 * Runtime abstraction for CLI lifecycle management
 */

import { AgentController, ResetContextOptions, createAgentController } from './agent';
import type { AgentTerminalAction, BrowserEvidenceCapture } from './agent';
import { BrowserManager, BrowserPageSession, createBrowserManager } from './browser';
import { AgentConfig, type MediaResolutionLevel } from './config';
import { clearLearnings } from './memory';
import { DEFAULT_VIEWPORT } from './viewport';
import { VisionService, VisionUsage, createVisionService } from './vision';

export interface SubmitTaskOptions {
    cleanContext?: boolean;
    preserveContext?: boolean;
    model?: string;
    thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
    mediaResolution?: MediaResolutionLevel;
}

export interface RuntimeResetOptions extends ResetContextOptions {
    stopRunningTask?: boolean;
    clearMemory?: boolean;
    clearFrameHistory?: boolean;
    navigateToStartup?: boolean;
}

export interface UsageTotals {
    promptTokens: number;
    outputTokens: number;
    thoughtsTokens: number;
    totalTokens: number;
    requests: number;
}

export interface TaskUsageSummary {
    goal: string;
    startedAt: string;
    finishedAt: string | null;
    status: 'running' | 'completed' | 'awaiting_user' | 'interrupted' | 'stopped' | 'error';
    model: string;
    thinkingLevel: 'minimal' | 'low' | 'medium' | 'high';
    totals: UsageTotals;
    byModel: Record<string, UsageTotals>;
}

export interface AgentRuntimeStatus {
    initialized: boolean;
    running: boolean;
    paused: boolean;
    currentGoal: string | null;
    actionHistoryLength: number;
    conversationHistoryLength: number;
    currentUrl: string;
    openTabs: number;
    lastStatusMessage: string | null;
    lastTerminalAction: AgentTerminalAction | null;
    llm: {
        model: string;
        thinkingLevel: 'minimal' | 'low' | 'medium' | 'high';
        mediaResolution: MediaResolutionLevel;
    };
    usage: {
        session: UsageTotals;
        currentTask: TaskUsageSummary | null;
        lastTask: TaskUsageSummary | null;
    };
}

export interface AgentRuntime {
    start(): Promise<void>;
    submitTask(goal: string, options?: SubmitTaskOptions): Promise<void>;
    stopTask(): void;
    pauseTask(): void;
    resumeTask(): void;
    resetContext(options?: RuntimeResetOptions): Promise<void>;
    restart(): Promise<void>;
    getStatus(): Promise<AgentRuntimeStatus>;
    shutdown(): Promise<void>;
}

export interface AgentRuntimeOptions {
    onEvidence?: (capture: BrowserEvidenceCapture) => void | Promise<void>;
    browserManager?: BrowserManager;
    browserSession?: BrowserPageSession;
    closeBrowserOnShutdown?: boolean;
}

function createEmptyTotals(): UsageTotals {
    return {
        promptTokens: 0,
        outputTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 0,
        requests: 0,
    };
}

function mergeTotals(target: UsageTotals, patch: Partial<UsageTotals>) {
    target.promptTokens += Number(patch.promptTokens) || 0;
    target.outputTokens += Number(patch.outputTokens) || 0;
    target.thoughtsTokens += Number(patch.thoughtsTokens) || 0;
    target.totalTokens += Number(patch.totalTokens) || 0;
    target.requests += Number(patch.requests) || 0;
}

function cloneTotals(source: UsageTotals): UsageTotals {
    return {
        promptTokens: source.promptTokens,
        outputTokens: source.outputTokens,
        thoughtsTokens: source.thoughtsTokens,
        totalTokens: source.totalTokens,
        requests: source.requests,
    };
}

function cloneTaskUsage(source: TaskUsageSummary | null): TaskUsageSummary | null {
    if (!source) return null;

    const byModel: Record<string, UsageTotals> = {};
    Object.entries(source.byModel).forEach(([model, totals]) => {
        byModel[model] = cloneTotals(totals);
    });

    return {
        goal: source.goal,
        startedAt: source.startedAt,
        finishedAt: source.finishedAt,
        status: source.status,
        model: source.model,
        thinkingLevel: source.thinkingLevel,
        totals: cloneTotals(source.totals),
        byModel,
    };
}

function formatTotals(totals: UsageTotals): string {
    return `prompt=${totals.promptTokens}, output=${totals.outputTokens}, thoughts=${totals.thoughtsTokens}, total=${totals.totalTokens}, requests=${totals.requests}`;
}

export function createAgentRuntime(
    config: AgentConfig,
    onStatusUpdate: (message: string) => void = (message) => console.log(message),
    options: AgentRuntimeOptions = {},
): AgentRuntime {
    let browserManager: BrowserManager | null = options.browserManager ?? null;
    let browser: BrowserPageSession | null = options.browserSession ?? null;
    let vision: VisionService | null = null;
    let agent: AgentController | null = null;
    let initialized = false;
    let initializingPromise: Promise<void> | null = null;
    let lastStatusMessage: string | null = null;
    let lastTerminalAction: AgentTerminalAction | null = null;
    const closeBrowserOnShutdown = options.closeBrowserOnShutdown ?? !options.browserManager;

    const sessionUsage = createEmptyTotals();
    let activeTaskUsage: TaskUsageSummary | null = null;
    let lastTaskUsage: TaskUsageSummary | null = null;

    const statusHandler = (message: string, options: { remember?: boolean } = {}) => {
        if (options.remember !== false) {
            lastStatusMessage = message;
        }
        onStatusUpdate(message);
    };

    const finalizeActiveTask = (status: TaskUsageSummary['status']) => {
        if (!activeTaskUsage) {
            return;
        }

        activeTaskUsage.status = status;
        activeTaskUsage.finishedAt = new Date().toISOString();
        const completedTask = activeTaskUsage;
        lastTaskUsage = completedTask;
        activeTaskUsage = null;

        statusHandler(
            `📊 Usage (${status}): task[${formatTotals(completedTask.totals)}] | session[${formatTotals(sessionUsage)}] | model=${completedTask.model} | thinking=${completedTask.thinkingLevel}`,
            { remember: false }
        );
    };

    const statusFromTerminalAction = (terminal: AgentTerminalAction | null): TaskUsageSummary['status'] => {
        if (!terminal) return 'completed';
        // 'checkpoint' (action budget reached) is a continuable pause, not a failure:
        // treat it like 'awaiting_user' so the session is retained for re-delegation.
        if (terminal.action === 'ask' || terminal.action === 'checkpoint') return 'awaiting_user';
        if (terminal.action === 'error') return 'error';
        if (terminal.action === 'stopped') return 'stopped';
        return 'completed';
    };

    const recordVisionUsage = (usage: VisionUsage) => {
        mergeTotals(sessionUsage, {
            promptTokens: usage.promptTokens,
            outputTokens: usage.outputTokens,
            thoughtsTokens: usage.thoughtsTokens,
            totalTokens: usage.totalTokens,
            requests: 1,
        });

        if (!activeTaskUsage) {
            return;
        }

        mergeTotals(activeTaskUsage.totals, {
            promptTokens: usage.promptTokens,
            outputTokens: usage.outputTokens,
            thoughtsTokens: usage.thoughtsTokens,
            totalTokens: usage.totalTokens,
            requests: 1,
        });

        const modelKey = usage.model || 'unknown';
        if (!activeTaskUsage.byModel[modelKey]) {
            activeTaskUsage.byModel[modelKey] = createEmptyTotals();
        }

        mergeTotals(activeTaskUsage.byModel[modelKey], {
            promptTokens: usage.promptTokens,
            outputTokens: usage.outputTokens,
            thoughtsTokens: usage.thoughtsTokens,
            totalTokens: usage.totalTokens,
            requests: 1,
        });
    };

    const ensureInitialized = async () => {
        if (initialized) {
            return;
        }

        if (initializingPromise) {
            await initializingPromise;
            return;
        }

        initializingPromise = (async () => {
            if (!browserManager) {
                browserManager = await createBrowserManager({
                    backend: config.browser.backend,
                    userDataDir: config.browser.userDataDir,
                    headless: config.browser.headless,
                    liveView: config.browser.liveView,
                    launchArgs: config.browser.launchArgs,
                    viewport: config.browser.headless ? DEFAULT_VIEWPORT : null,
                    onLog: statusHandler,
                });
            }

            vision = createVisionService({
                model: config.llm.model,
                thinkingLevel: config.llm.thinkingLevel,
                mediaResolution: config.llm.mediaResolution,
            }, recordVisionUsage);

            await browserManager.launch();
            browser = browser ?? browserManager;

            agent = createAgentController(browser, vision, statusHandler, {
                maxIterations: config.runtime.maxIterations,
                maxConversationHistory: config.runtime.maxConversationHistory,
                stepDelayMs: config.runtime.stepDelayMs,
                actionSettleDelayMs: config.runtime.actionSettleDelayMs,
                waitActionDelayMs: config.runtime.waitActionDelayMs,
                advancedModel: config.llm.advancedModel,
                advancedThinkingLevel: config.llm.advancedThinkingLevel,
                advancedMediaResolution: config.llm.advancedMediaResolution,
                escalationEnabled: config.llm.escalationEnabled,
                onEvidence: options.onEvidence,
            });

            if (config.browser.startupUrl && !options.browserSession) {
                statusHandler(`🌐 Navigating to ${config.browser.startupUrl}...`);
                await browser.navigate(config.browser.startupUrl);
            }

            initialized = true;
        })();

        try {
            await initializingPromise;
        } finally {
            initializingPromise = null;
        }
    };

    const runtime: AgentRuntime = {
        async start() {
            await ensureInitialized();
        },

        async submitTask(goal: string, options: SubmitTaskOptions = {}) {
            await ensureInitialized();
            if (!agent || !vision) {
                throw new Error('Runtime not initialized');
            }

            if (activeTaskUsage) {
                finalizeActiveTask(agent.isRunning() ? 'interrupted' : 'completed');
            }

            if (typeof options.model === 'string' && options.model.trim()) {
                vision.updateConfig({ model: options.model.trim() });
            }
            if (typeof options.thinkingLevel === 'string' && options.thinkingLevel.trim()) {
                vision.updateConfig({ thinkingLevel: options.thinkingLevel });
            }
            if (typeof options.mediaResolution === 'string' && options.mediaResolution.trim()) {
                vision.updateConfig({ mediaResolution: options.mediaResolution });
            }

            const llmConfig = vision.getConfig();
            lastTerminalAction = null;
            activeTaskUsage = {
                goal,
                startedAt: new Date().toISOString(),
                finishedAt: null,
                status: 'running',
                model: llmConfig.model,
                thinkingLevel: llmConfig.thinkingLevel,
                totals: createEmptyTotals(),
                byModel: {},
            };

            const cleanContext = options.cleanContext ?? config.runtime.cleanContextBeforeTask;
            if (cleanContext) {
                agent.resetContext();
            }

            const preserveContext = options.preserveContext ?? !cleanContext;
            agent.setTask(goal, { preserveContext });

            if (!agent.isRunning()) {
                void agent.start()
                    .then(() => {
                        if (activeTaskUsage) {
                            finalizeActiveTask('completed');
                        }
                    })
                    .catch((error) => {
                        const message = error instanceof Error ? error.message : String(error);
                        statusHandler(`❌ Runtime task failed: ${message}`);
                        finalizeActiveTask('error');
                    });
            }
        },

        stopTask() {
            if (activeTaskUsage) {
                finalizeActiveTask('stopped');
            }
            agent?.stop();
        },

        pauseTask() {
            agent?.pause();
        },

        resumeTask() {
            agent?.resume();
        },

        async resetContext(options: RuntimeResetOptions = {}) {
            await ensureInitialized();

            if (!agent) {
                return;
            }

            const stopRunningTask = options.stopRunningTask ?? true;
            if (stopRunningTask && agent.isRunning()) {
                if (activeTaskUsage) {
                    finalizeActiveTask('stopped');
                }
                agent.stop();
            }

            agent.resetContext({
                clearConversationHistory: options.clearConversationHistory,
                clearActionHistory: options.clearActionHistory,
                clearClipboard: options.clearClipboard,
                clearCurrentGoal: options.clearCurrentGoal,
                clearInterruptFlag: options.clearInterruptFlag,
            });

            if (options.clearMemory) {
                clearLearnings();
                statusHandler('🧠 Persistent memory cleared.');
            }

            if (options.clearFrameHistory && browser) {
                browser.clearAgentFrameHistory();
            }

            if (options.navigateToStartup && browser && config.browser.startupUrl) {
                await browser.navigate(config.browser.startupUrl);
                statusHandler(`🌐 Returned to startup URL: ${config.browser.startupUrl}`);
            }
        },

        async restart() {
            await ensureInitialized();
            if (!browser || !browserManager || !agent) {
                throw new Error('Runtime not initialized');
            }

            if (agent.isRunning()) {
                if (activeTaskUsage) {
                    finalizeActiveTask('interrupted');
                }
                agent.stop();
            }

            agent.resetContext();
            if (closeBrowserOnShutdown) {
                await browserManager.close();
                await browserManager.launch();
                browser = browserManager;
            } else {
                await browser.closeOwnedPages();
            }

            if (config.browser.startupUrl) {
                await browser.navigate(config.browser.startupUrl);
            }

            statusHandler('🔁 Runtime restarted (browser session relaunched).');
        },

        async getStatus(): Promise<AgentRuntimeStatus> {
            if (!initialized || !agent || !browser || !vision) {
                return {
                    initialized,
                    running: false,
                    paused: false,
                    currentGoal: null,
                    actionHistoryLength: 0,
                    conversationHistoryLength: 0,
                    currentUrl: '',
                    openTabs: 0,
                    lastStatusMessage,
                    lastTerminalAction,
                    llm: {
                        model: config.llm.model,
                        thinkingLevel: config.llm.thinkingLevel,
                        mediaResolution: config.llm.mediaResolution,
                    },
                    usage: {
                        session: cloneTotals(sessionUsage),
                        currentTask: cloneTaskUsage(activeTaskUsage),
                        lastTask: cloneTaskUsage(lastTaskUsage),
                    },
                };
            }

            const controllerStatus = agent.getStatus();
            if (!controllerStatus.running && activeTaskUsage) {
                lastTerminalAction = controllerStatus.lastTerminalAction;
                finalizeActiveTask(statusFromTerminalAction(lastTerminalAction));
            } else {
                lastTerminalAction = controllerStatus.lastTerminalAction;
            }

            let openTabs = 0;
            try {
                openTabs = await browser.getOpenTabCount();
            } catch {
                openTabs = 0;
            }

            const llmConfig = vision.getConfig();
            return {
                initialized,
                running: controllerStatus.running,
                paused: controllerStatus.paused,
                currentGoal: controllerStatus.currentGoal,
                actionHistoryLength: controllerStatus.actionHistoryLength,
                conversationHistoryLength: controllerStatus.conversationHistoryLength,
                currentUrl: browser.getPageUrl(),
                openTabs,
                lastStatusMessage,
                lastTerminalAction,
                llm: {
                    model: llmConfig.model,
                    thinkingLevel: llmConfig.thinkingLevel,
                    mediaResolution: llmConfig.mediaResolution,
                },
                usage: {
                    session: cloneTotals(sessionUsage),
                    currentTask: cloneTaskUsage(activeTaskUsage),
                    lastTask: cloneTaskUsage(lastTaskUsage),
                },
            };
        },

        async shutdown() {
            if (!initialized) {
                return;
            }

            if (agent?.isRunning()) {
                if (activeTaskUsage) {
                    finalizeActiveTask('stopped');
                }
                agent.stop();
            }

            if (browserManager && closeBrowserOnShutdown) {
                await browserManager.close();
            }

            initialized = false;
            if (closeBrowserOnShutdown) {
                browserManager = null;
                browser = null;
            }
            vision = null;
            agent = null;
            lastStatusMessage = 'Runtime shut down.';
        },
    };

    return runtime;
}
