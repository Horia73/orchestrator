/**
 * Runtime abstraction for CLI and orchestration integrations
 */

import { AgentController, ResetContextOptions, createAgentController } from './agent.js';
import { BrowserFrameSnapshot, BrowserManager, createBrowserManager } from './browser.js';
import { AgentConfig } from './config.js';
import { clearLearnings } from './memory.js';
import { VisionService, VisionUsage, createVisionService } from './vision.js';

export interface SubmitTaskOptions {
    cleanContext?: boolean;
    preserveContext?: boolean;
    model?: string;
    thinkingBudget?: number;
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
    status: 'running' | 'completed' | 'interrupted' | 'stopped' | 'error';
    model: string;
    thinkingBudget: number;
    totals: UsageTotals;
    byModel: Record<string, UsageTotals>;
}

export interface AgentRuntimeStatus {
    initialized: boolean;
    running: boolean;
    manualControlEnabled: boolean;
    currentGoal: string | null;
    actionHistoryLength: number;
    conversationHistoryLength: number;
    currentUrl: string;
    openTabs: number;
    lastStatusMessage: string | null;
    llm: {
        model: string;
        thinkingBudget: number;
        temperature: number;
    };
    usage: {
        session: UsageTotals;
        currentTask: TaskUsageSummary | null;
        lastTask: TaskUsageSummary | null;
    };
}

export type RuntimeControlAction =
    | { type: 'click'; x: number; y: number; count?: number }
    | { type: 'hover'; x: number; y: number }
    | { type: 'hold'; x: number; y: number; durationMs?: number }
    | { type: 'scroll'; direction: 'up' | 'down' }
    | { type: 'type'; text: string }
    | { type: 'pressKey'; key: string }
    | { type: 'navigate'; url: string }
    | { type: 'goBack' }
    | { type: 'goForward' }
    | { type: 'reload' }
    | { type: 'clear' };

export interface RuntimeControlResult {
    ok: boolean;
    error?: string;
    data?: {
        currentUrl: string;
        viewport: {
            width: number;
            height: number;
        };
    };
}

export interface AgentRuntime {
    start(): Promise<void>;
    submitTask(goal: string, options?: SubmitTaskOptions): Promise<void>;
    stopTask(): void;
    resetContext(options?: RuntimeResetOptions): Promise<void>;
    restart(): Promise<void>;
    getStatus(): Promise<AgentRuntimeStatus>;
    setManualControl(enabled: boolean): Promise<void>;
    getLatestFrame(options?: { live?: boolean }): Promise<BrowserFrameSnapshot | null>;
    getFrameHistory(limit?: number): Promise<BrowserFrameSnapshot[]>;
    performControl(action: RuntimeControlAction): Promise<RuntimeControlResult>;
    shutdown(): Promise<void>;
}

const TARGET_VIEWPORT = {
    width: 1980,
    height: 1080,
};

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
        thinkingBudget: source.thinkingBudget,
        totals: cloneTotals(source.totals),
        byModel,
    };
}

export function createAgentRuntime(
    config: AgentConfig,
    onStatusUpdate: (message: string) => void = (message) => console.log(message)
): AgentRuntime {
    let browser: BrowserManager | null = null;
    let vision: VisionService | null = null;
    let agent: AgentController | null = null;
    let initialized = false;
    let initializingPromise: Promise<void> | null = null;
    let lastStatusMessage: string | null = null;
    let manualControlEnabled = false;

    const sessionUsage = createEmptyTotals();
    let activeTaskUsage: TaskUsageSummary | null = null;
    let lastTaskUsage: TaskUsageSummary | null = null;

    const statusHandler = (message: string) => {
        lastStatusMessage = message;
        onStatusUpdate(message);
    };

    const finalizeActiveTask = (status: TaskUsageSummary['status']) => {
        if (!activeTaskUsage) {
            return;
        }

        activeTaskUsage.status = status;
        activeTaskUsage.finishedAt = new Date().toISOString();
        lastTaskUsage = activeTaskUsage;
        activeTaskUsage = null;
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
            browser = await createBrowserManager({
                userDataDir: config.browser.userDataDir,
                headless: config.browser.headless,
                launchArgs: config.browser.launchArgs,
                viewport: TARGET_VIEWPORT,
            });

            vision = createVisionService({
                model: config.llm.model,
                thinkingBudget: config.llm.thinkingBudget,
                temperature: config.llm.temperature,
            }, recordVisionUsage);

            agent = createAgentController(browser, vision, statusHandler, {
                maxIterations: config.runtime.maxIterations,
                maxConversationHistory: config.runtime.maxConversationHistory,
                stepDelayMs: config.runtime.stepDelayMs,
                actionSettleDelayMs: config.runtime.actionSettleDelayMs,
                waitActionDelayMs: config.runtime.waitActionDelayMs,
            });

            await browser.launch();
            if (config.browser.startupUrl) {
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

    const readControlMeta = async (): Promise<RuntimeControlResult['data']> => {
        if (!browser) {
            return undefined;
        }

        const viewport = await browser.getViewport();
        return {
            currentUrl: browser.getPageUrl(),
            viewport,
        };
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

            if (manualControlEnabled) {
                throw new Error('Manual control is active. Disable manual control before starting an AI task.');
            }

            if (activeTaskUsage) {
                finalizeActiveTask(agent.isRunning() ? 'interrupted' : 'completed');
            }

            if (typeof options.model === 'string' && options.model.trim()) {
                vision.updateConfig({ model: options.model.trim() });
            }
            if (Number.isFinite(options.thinkingBudget as number) && Number(options.thinkingBudget) >= 0) {
                vision.updateConfig({ thinkingBudget: Math.floor(Number(options.thinkingBudget)) });
            }

            const llmConfig = vision.getConfig();
            activeTaskUsage = {
                goal,
                startedAt: new Date().toISOString(),
                finishedAt: null,
                status: 'running',
                model: llmConfig.model,
                thinkingBudget: llmConfig.thinkingBudget,
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
                void agent.start().catch((error) => {
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
            if (!browser || !agent) {
                throw new Error('Runtime not initialized');
            }

            if (agent.isRunning()) {
                if (activeTaskUsage) {
                    finalizeActiveTask('interrupted');
                }
                agent.stop();
            }

            agent.resetContext();
            await browser.close();
            await browser.launch();

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
                    manualControlEnabled,
                    currentGoal: null,
                    actionHistoryLength: 0,
                    conversationHistoryLength: 0,
                    currentUrl: '',
                    openTabs: 0,
                    lastStatusMessage,
                    llm: {
                        model: config.llm.model,
                        thinkingBudget: config.llm.thinkingBudget,
                        temperature: config.llm.temperature,
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
                finalizeActiveTask('completed');
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
                manualControlEnabled,
                currentGoal: controllerStatus.currentGoal,
                actionHistoryLength: controllerStatus.actionHistoryLength,
                conversationHistoryLength: controllerStatus.conversationHistoryLength,
                currentUrl: browser.getPageUrl(),
                openTabs,
                lastStatusMessage,
                llm: {
                    model: llmConfig.model,
                    thinkingBudget: llmConfig.thinkingBudget,
                    temperature: llmConfig.temperature,
                },
                usage: {
                    session: cloneTotals(sessionUsage),
                    currentTask: cloneTaskUsage(activeTaskUsage),
                    lastTask: cloneTaskUsage(lastTaskUsage),
                },
            };
        },

        async setManualControl(enabled: boolean): Promise<void> {
            await ensureInitialized();
            if (!agent) {
                throw new Error('Runtime not initialized');
            }

            const next = Boolean(enabled);
            if (manualControlEnabled === next) {
                return;
            }

            manualControlEnabled = next;
            if (manualControlEnabled && agent.isRunning()) {
                if (activeTaskUsage) {
                    finalizeActiveTask('interrupted');
                }
                agent.stop();
            }

            statusHandler(manualControlEnabled
                ? '🕹️ Manual control enabled (AI actions paused).'
                : '🤖 Manual control disabled (AI can run tasks).');
        },

        async getLatestFrame(options: { live?: boolean } = {}): Promise<BrowserFrameSnapshot | null> {
            await ensureInitialized();
            if (!browser) {
                return null;
            }

            try {
                if (options.live) {
                    return await browser.captureLiveFrame();
                }

                const latestAgentFrame = browser.getLatestAgentFrame();
                if (latestAgentFrame) {
                    return latestAgentFrame;
                }

                return await browser.captureLiveFrame();
            } catch {
                return null;
            }
        },

        async getFrameHistory(limit: number = 120): Promise<BrowserFrameSnapshot[]> {
            await ensureInitialized();
            if (!browser) {
                return [];
            }

            return browser.getAgentFrameHistory(limit);
        },

        async performControl(action: RuntimeControlAction): Promise<RuntimeControlResult> {
            await ensureInitialized();
            if (!browser) {
                return { ok: false, error: 'Runtime not initialized.' };
            }

            if (!manualControlEnabled) {
                return { ok: false, error: 'Manual control is disabled.' };
            }

            try {
                switch (action.type) {
                    case 'click': {
                        const ok = await browser.clickCoordinate(action.x, action.y, action.count || 1);
                        if (!ok) {
                            return { ok: false, error: 'Click action failed.' };
                        }
                        break;
                    }
                    case 'hover': {
                        await browser.hoverCoordinate(action.x, action.y);
                        break;
                    }
                    case 'hold': {
                        const ok = await browser.holdCoordinate(action.x, action.y, action.durationMs);
                        if (!ok) {
                            return { ok: false, error: 'Hold action failed.' };
                        }
                        break;
                    }
                    case 'scroll': {
                        await browser.scroll(action.direction);
                        break;
                    }
                    case 'type': {
                        await browser.type(action.text);
                        break;
                    }
                    case 'pressKey': {
                        await browser.pressKey(action.key);
                        break;
                    }
                    case 'navigate': {
                        await browser.navigate(action.url);
                        break;
                    }
                    case 'goBack': {
                        await browser.goBack();
                        break;
                    }
                    case 'goForward': {
                        await browser.goForward();
                        break;
                    }
                    case 'reload': {
                        await browser.reloadPage();
                        break;
                    }
                    case 'clear': {
                        await browser.clear();
                        break;
                    }
                }

                return {
                    ok: true,
                    data: await readControlMeta(),
                };
            } catch (error) {
                return {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
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

            if (browser) {
                await browser.close();
            }

            initialized = false;
            manualControlEnabled = false;
            browser = null;
            vision = null;
            agent = null;
            lastStatusMessage = 'Runtime shut down.';
        },
    };

    return runtime;
}
