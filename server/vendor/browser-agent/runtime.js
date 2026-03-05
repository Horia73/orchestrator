/**
 * Runtime abstraction for CLI lifecycle management
 */
import { createAgentController } from './agent.js';
import { createBrowserManager } from './browser.js';
import { clearLearnings } from './memory.js';
import { DEFAULT_VIEWPORT } from './viewport.js';
import { createVisionService } from './vision.js';
function createEmptyTotals() {
    return {
        promptTokens: 0,
        outputTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 0,
        requests: 0,
    };
}
function mergeTotals(target, patch) {
    target.promptTokens += Number(patch.promptTokens) || 0;
    target.outputTokens += Number(patch.outputTokens) || 0;
    target.thoughtsTokens += Number(patch.thoughtsTokens) || 0;
    target.totalTokens += Number(patch.totalTokens) || 0;
    target.requests += Number(patch.requests) || 0;
}
function cloneTotals(source) {
    return {
        promptTokens: source.promptTokens,
        outputTokens: source.outputTokens,
        thoughtsTokens: source.thoughtsTokens,
        totalTokens: source.totalTokens,
        requests: source.requests,
    };
}
function cloneTaskUsage(source) {
    if (!source)
        return null;
    const byModel = {};
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
function formatTotals(totals) {
    return `prompt=${totals.promptTokens}, output=${totals.outputTokens}, thoughts=${totals.thoughtsTokens}, total=${totals.totalTokens}, requests=${totals.requests}`;
}
export function createAgentRuntime(config, onStatusUpdate = (message) => console.log(message)) {
    let browser = null;
    let vision = null;
    let agent = null;
    let initialized = false;
    let initializingPromise = null;
    let lastStatusMessage = null;
    const sessionUsage = createEmptyTotals();
    let activeTaskUsage = null;
    let lastTaskUsage = null;
    const statusHandler = (message) => {
        lastStatusMessage = message;
        onStatusUpdate(message);
    };
    const finalizeActiveTask = (status) => {
        if (!activeTaskUsage) {
            return;
        }
        activeTaskUsage.status = status;
        activeTaskUsage.finishedAt = new Date().toISOString();
        const completedTask = activeTaskUsage;
        lastTaskUsage = completedTask;
        activeTaskUsage = null;
        statusHandler(`📊 Usage (${status}): task[${formatTotals(completedTask.totals)}] | session[${formatTotals(sessionUsage)}] | model=${completedTask.model} | thinking=${completedTask.thinkingLevel}`);
    };
    const recordVisionUsage = (usage) => {
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
                env: config.browser.env,
                launchArgs: config.browser.launchArgs,
                viewport: DEFAULT_VIEWPORT,
                recordVideo: config.browser.recordVideo,
                onLog: statusHandler,
            });
            vision = createVisionService({
                model: config.llm.model,
                thinkingLevel: config.llm.thinkingLevel,
            }, recordVisionUsage);
            agent = createAgentController(browser, vision, statusHandler, {
                maxIterations: config.runtime.maxIterations,
                maxConversationHistory: config.runtime.maxConversationHistory,
                stepDelayMs: config.runtime.stepDelayMs,
                actionSettleDelayMs: config.runtime.actionSettleDelayMs,
                waitActionDelayMs: config.runtime.waitActionDelayMs,
                enableModelAutoEscalation: true,
                escalationModel: 'gemini-3.1-pro-preview',
                escalationThinkingLevel: 'medium',
                escalationFailureThreshold: 3,
                deescalationSuccessThreshold: 2,
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
        }
        finally {
            initializingPromise = null;
        }
    };
    const runtime = {
        async start() {
            await ensureInitialized();
        },
        async submitTask(goal, options = {}) {
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
            const llmConfig = vision.getConfig();
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
            agent.setTask(goal, {
                preserveContext,
                uploadFiles: Array.isArray(options.uploadFiles) ? options.uploadFiles : [],
            });
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
        async resetContext(options = {}) {
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
        async getStatus() {
            if (!initialized || !agent || !browser || !vision) {
                return {
                    initialized,
                    running: false,
                    currentGoal: null,
                    actionHistoryLength: 0,
                    conversationHistoryLength: 0,
                    currentUrl: '',
                    openTabs: 0,
                    lastStatusMessage,
                    llm: {
                        model: config.llm.model,
                        thinkingLevel: config.llm.thinkingLevel,
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
            }
            catch {
                openTabs = 0;
            }
            const llmConfig = vision.getConfig();
            return {
                initialized,
                running: controllerStatus.running,
                currentGoal: controllerStatus.currentGoal,
                actionHistoryLength: controllerStatus.actionHistoryLength,
                conversationHistoryLength: controllerStatus.conversationHistoryLength,
                currentUrl: browser.getPageUrl(),
                openTabs,
                lastStatusMessage,
                llm: {
                    model: llmConfig.model,
                    thinkingLevel: llmConfig.thinkingLevel,
                },
                usage: {
                    session: cloneTotals(sessionUsage),
                    currentTask: cloneTaskUsage(activeTaskUsage),
                    lastTask: cloneTaskUsage(lastTaskUsage),
                },
            };
        },
        async captureLiveFrame(options = {}) {
            await ensureInitialized();
            if (!browser) {
                throw new Error('Runtime not initialized');
            }
            return browser.captureLiveFrame(options);
        },
        async captureScreenshot(options = {}) {
            await ensureInitialized();
            if (!browser) {
                throw new Error('Runtime not initialized');
            }
            return browser.captureScreenshot(options);
        },
        async subscribeLiveFrames(onFrame) {
            await ensureInitialized();
            if (!browser) {
                throw new Error('Runtime not initialized');
            }
            return browser.subscribeLiveFrames(onFrame);
        },
        async getAgentRecording(limit) {
            await ensureInitialized();
            if (!browser) {
                return [];
            }
            return browser.getAgentFrameHistory(limit);
        },
        async getViewport() {
            await ensureInitialized();
            if (!browser) {
                return { ...DEFAULT_VIEWPORT };
            }
            return browser.getViewport();
        },
        async performLiveAction(action, payload = {}) {
            await ensureInitialized();
            if (!browser) {
                throw new Error('Runtime not initialized');
            }

            switch (String(action ?? '').trim()) {
                case 'click':
                    return browser.clickCoordinate(payload.x, payload.y, 1);
                case 'double_click':
                    return browser.clickCoordinate(payload.x, payload.y, 2);
                case 'hold':
                    return browser.holdCoordinate(payload.x, payload.y, payload.durationMs);
                case 'hover':
                    await browser.hoverCoordinate(payload.x, payload.y);
                    return true;
                case 'type':
                    await browser.type(String(payload.text ?? ''));
                    return true;
                case 'paste':
                    await browser.paste(String(payload.text ?? ''));
                    return true;
                case 'clear':
                    await browser.clear();
                    return true;
                case 'press_key':
                    await browser.pressKey(String(payload.key ?? ''));
                    return true;
                case 'scroll_up':
                    await browser.scroll('up');
                    return true;
                case 'scroll_down':
                    await browser.scroll('down');
                    return true;
                case 'navigate':
                    await browser.navigate(String(payload.url ?? ''));
                    return true;
                case 'go_back':
                    await browser.goBack();
                    return true;
                case 'go_forward':
                    await browser.goForward();
                    return true;
                case 'reload':
                    await browser.reloadPage();
                    return true;
                default:
                    throw new Error(`Unsupported live action: ${action}`);
            }
        },
        async shutdown() {
            const recordedVideoFiles = [];
            if (!initialized) {
                return { recordedVideoFiles };
            }
            if (agent?.isRunning()) {
                if (activeTaskUsage) {
                    finalizeActiveTask('stopped');
                }
                agent.stop();
            }
            if (browser) {
                await browser.close();
                const videos = browser.getSavedVideoFiles?.() ?? [];
                recordedVideoFiles.push(...videos);
            }
            initialized = false;
            browser = null;
            vision = null;
            agent = null;
            lastStatusMessage = 'Runtime shut down.';
            return {
                recordedVideoFiles,
            };
        },
    };
    return runtime;
}
