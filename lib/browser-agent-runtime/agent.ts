/**
 * Agent Controller
 * Smart automation loop with failure tracking and memory
 */

import { ActionTrace, BrowserDiagnosticsSnapshot, BrowserFetchResult, BrowserFrameSnapshot, BrowserPageSession, BrowserVideoRecording } from './browser';
import { VisionService, AgentAction, VisionConfig } from './vision';
import { ActionHistoryItem, IterationLimitReview } from './prompts';
import { initializeDefaultLearnings, addLearning } from './memory';
import { recordAgentNeed } from '@/lib/agent-needs';
import {
    changedDownloads,
    clampDownloadWaitMs,
    filenameMatches,
    formatAction,
    formatIterationLimitReview,
    summarizeDownloads,
    summarizeDownloadWait,
} from './agent-formatters';
import { formatBrowserAgentTextForLog, isLikelySensitiveBrowserText, redactBrowserAgentText } from './redaction';

export interface SetTaskOptions {
    preserveContext?: boolean;
}

export interface ResetContextOptions {
    clearConversationHistory?: boolean;
    clearActionHistory?: boolean;
    clearClipboard?: boolean;
    clearCurrentGoal?: boolean;
    clearInterruptFlag?: boolean;
}

export interface AgentControllerOptions {
    maxIterations?: number;
    maxConversationHistory?: number;
    stepDelayMs?: number;
    actionSettleDelayMs?: number;
    waitActionDelayMs?: number;
    advancedModel?: string;
    advancedThinkingLevel?: 'low' | 'medium' | 'high';
    advancedMediaResolution?: VisionConfig['mediaResolution'];
    maxEscalationIterations?: number;
    onEvidence?: (capture: BrowserEvidenceCapture) => void | Promise<void>;
}

export type BrowserEvidenceCapture =
    | {
        kind: 'screenshot';
        mimeType: 'image/jpeg';
        data: Buffer;
        filenameBase: string;
        timestamp: string;
        url: string;
        captureMode: BrowserFrameSnapshot['captureMode'];
        viewport: BrowserFrameSnapshot['viewport'];
        page: BrowserFrameSnapshot['page'];
    }
    | {
        kind: 'video';
        mimeType: string;
        data: Buffer;
        filenameBase: string;
        timestamp: string;
        url: string;
        durationMs: number;
        fps: number;
        frameCount: number;
        viewport: BrowserVideoRecording['viewport'];
        page: BrowserVideoRecording['page'];
    };

export interface AgentControllerStatus {
    running: boolean;
    paused: boolean;
    currentGoal: string | null;
    actionHistoryLength: number;
    conversationHistoryLength: number;
    lastTerminalAction: AgentTerminalAction | null;
}

export interface AgentController {
    setTask(goal: string, options?: SetTaskOptions): void;
    start(): Promise<void>;
    stop(): void;
    pause(): void;
    resume(): void;
    resetContext(options?: ResetContextOptions): void;
    getStatus(): AgentControllerStatus;
    isRunning(): boolean;
}

export type AgentTerminalAction =
    | {
        action: 'done' | 'ask' | 'error' | 'iteration_limit' | 'stopped';
        reasoning?: string;
        text?: string;
        timestamp: string;
    };

export function createAgentController(
    browser: BrowserPageSession,
    vision: VisionService,
    onStatusUpdate: (message: string) => void,
    options: AgentControllerOptions = {}
): AgentController {
    const maxIterations = options.maxIterations ?? 60;
    const maxConversationHistory = options.maxConversationHistory ?? 40;
    const liveActionHistoryLimit = 50;
    const stepDelayMs = options.stepDelayMs ?? 500;
    const actionSettleDelayMs = options.actionSettleDelayMs ?? 1000;
    const waitActionDelayMs = options.waitActionDelayMs ?? 3000;
    const advancedModel = options.advancedModel ?? 'gemini-3.1-pro-preview';
    const advancedThinkingLevel = options.advancedThinkingLevel ?? 'low';
    const advancedMediaResolution = options.advancedMediaResolution ?? 'medium';
    const maxEscalationIterations = options.maxEscalationIterations ?? 10;
    const onEvidence = options.onEvidence;

    let currentGoal: string | null = null;
    let running = false;
    let paused = false;
    let shouldStop = false;
    let isInterrupt = false;
    let actionHistory: ActionHistoryItem[] = [];
    let compactedActionCount = 0;
    let conversationHistory: string[] = [];
    let clipboard: string | null = null;
    let pendingTrace: ActionTrace | null = null;
    let pendingSupplementalFrames: BrowserFrameSnapshot[] = [];
    let lastTerminalAction: AgentTerminalAction | null = null;

    let escalationState: {
        active: boolean;
        previousGoal: string;
        subObjective: string;
        baseModel: string;
        baseThinkingLevel: VisionConfig['thinkingLevel'];
        baseMediaResolution: VisionConfig['mediaResolution'];
        iterations: number;
    } | null = null;

    initializeDefaultLearnings();

    const pushConversationHistory = (entry: string) => {
        conversationHistory.push(entry);
        if (conversationHistory.length > maxConversationHistory) {
            conversationHistory = conversationHistory.slice(-maxConversationHistory);
        }
    };

    const compactActionHistoryIfNeeded = async () => {
        const trimAlreadyCompactedHistory = () => {
            const overflowCount = actionHistory.length - liveActionHistoryLimit;
            if (overflowCount <= 0 || compactedActionCount < overflowCount) {
                return;
            }
            actionHistory = actionHistory.slice(overflowCount);
            compactedActionCount = Math.max(0, compactedActionCount - overflowCount);
        };

        const pendingActionCount = actionHistory.length - compactedActionCount;
        if (pendingActionCount < liveActionHistoryLimit) {
            trimAlreadyCompactedHistory();
            return;
        }

        const actionsToCompact = actionHistory.slice(
            compactedActionCount,
            compactedActionCount + liveActionHistoryLimit
        );
        const llmSummary = await vision.compactActionHistory(
            currentGoal || 'Current browser task',
            actionsToCompact,
            conversationHistory,
            liveActionHistoryLimit
        );
        const summary = llmSummary || fallbackActionHistorySummary(actionsToCompact);

        pushConversationHistory(
            `SYSTEM: Compacted browser action history before the latest ${liveActionHistoryLimit} actions:\n${summary}`
        );
        compactedActionCount += actionsToCompact.length;

        trimAlreadyCompactedHistory();

        onStatusUpdate(`🧠 Compacted ${actionsToCompact.length} action(s) with Gemini; keeping latest ${Math.min(actionHistory.length, liveActionHistoryLimit)} live.`);
    };

    const restoreBaseModel = () => {
        if (!escalationState) {
            return;
        }

        vision.updateConfig({
            model: escalationState.baseModel,
            thinkingLevel: escalationState.baseThinkingLevel,
            mediaResolution: escalationState.baseMediaResolution
        });
    };

    const yieldToBaseModel = (
        reason: string,
        options: { blockerResolved?: boolean } = {}
    ) => {
        if (!escalationState) {
            return false;
        }

        const previousGoal = escalationState.previousGoal;
        const blockerResolved = options.blockerResolved ?? true;
        restoreBaseModel();
        currentGoal = previousGoal;
        pushConversationHistory(
            blockerResolved
                ? `AGENT: ✅ Advanced AI resolved the blocker. ${reason}`
                : `AGENT: ⚠️ Advanced AI returned control without resolving the blocker. ${reason}`
        );
        escalationState = null;
        return true;
    };

    const controller: AgentController = {
        setTask(goal: string, taskOptions: SetTaskOptions = {}) {
            const trimmedGoal = goal.trim();
            if (!trimmedGoal) {
                onStatusUpdate('❌ Empty goal. Type your command first.');
                return;
            }

            const preserveContext = taskOptions.preserveContext ?? true;
            const wasRunning = running;

            if (preserveContext && currentGoal && actionHistory.length > 0) {
                const lastAction = actionHistory[actionHistory.length - 1];
                const previousContext = `[Previous Goal: "${currentGoal}" | Last Agent Action: "${lastAction.action}" - "${lastAction.reasoning || ''}"]`;

                pushConversationHistory(`AGENT: Last action was ${lastAction.action} ("${lastAction.reasoning}")`);

                currentGoal = `${trimmedGoal} ${previousContext}`;
            } else {
                if (preserveContext && currentGoal) {
                    pushConversationHistory(`SYSTEM: Previous browser goal was replaced before completion: ${currentGoal}`);
                }
                currentGoal = trimmedGoal;
            }

            actionHistory = [];
            compactedActionCount = 0;
            pendingTrace = null;
            pendingSupplementalFrames = [];
            lastTerminalAction = null;

            if (escalationState) {
                // Restore base model immediately if we were interrupted during escalation
                restoreBaseModel();
                escalationState = null;
            }

            if (wasRunning) {
                isInterrupt = true;
                onStatusUpdate(`⚡ Interrupting... New goal: "${trimmedGoal}"`);
            } else {
                onStatusUpdate(`🎯 New goal: "${trimmedGoal}"`);
            }
        },

        async start() {
            if (running) {
                return;
            }

            if (!currentGoal) {
                onStatusUpdate('❌ No goal set. Type your command first.');
                return;
            }

            running = true;
            shouldStop = false;

            onStatusUpdate('🔄 Starting automation loop...');

            try {
                let iterationCount = 0;
                let loopTerminatedByAction = false;

                while (!shouldStop && currentGoal && iterationCount < maxIterations) {
                    while (paused && !shouldStop) {
                        await sleep(250);
                    }
                    if (shouldStop) break;

                    iterationCount++;

                    onStatusUpdate('📸 Scanning page...');
                    const tabsBefore = await browser.getOpenTabCount();
                    const frame = await browser.captureAgentFrame();
                    const previousContextFrames = previousVisualContextFrames(browser, frame, actionHistory);
                    const supplementalFrames = [...previousContextFrames, ...pendingSupplementalFrames];
                    pendingSupplementalFrames = [];
                    const openTabs = await browser.listTabs();
                    const downloads = browser.getDownloads();
                    const isFinalIteration = iterationCount === maxIterations;

                    if (supplementalFrames.length > 0) {
                        onStatusUpdate(`🗺️ Using ${supplementalFrames.length} supplemental frame(s) for orientation.`);
                    }

                    if (isFinalIteration) {
                        onStatusUpdate(`⚠️ Final attempt ${iterationCount}/${maxIterations}. If the task still cannot be finished, explain the blocker instead of repeating the same move.`);
                    }

                    onStatusUpdate('🤖 AI deciding...');
                    let actions: AgentAction[] = [];

                    if (escalationState && escalationState.active) {
                        escalationState.iterations++;
                        if (escalationState.iterations > maxEscalationIterations) {
                            onStatusUpdate('🛑 Advanced AI timed out. Returning control to base model.');
                            const reasoning = 'Advanced model hit the escalation timeout; blocker may still be unresolved.';
                            const restored = yieldToBaseModel(reasoning, { blockerResolved: false });
                            actionHistory.push({
                                action: 'yield_control',
                                reasoning,
                                success: restored
                            });
                            pendingTrace = null;
                            continue;
                        }
                    }

                    if (actions.length === 0) {
                        const isAdvancedMode = escalationState?.active || false;
                        const augmentedConversationHistory = isFinalIteration
                            ? [
                                ...conversationHistory,
                                `SYSTEM: This is attempt ${iterationCount}/${maxIterations}, the final allowed automation turn for this task. If you can realistically finish now, do it. If not, do not bluff or repeat a failing action. Return ask with a concise explanation of the blocker, why you could not recover alone, whether a human would likely do better, what tools/capabilities are missing, and the best next step.`
                            ]
                            : conversationHistory;
                        actions = await vision.analyzeScreenshot(
                            frame,
                            currentGoal,
                            actionHistory,
                            augmentedConversationHistory,
                            pendingTrace,
                            supplementalFrames,
                            isInterrupt,
                            openTabs,
                            isAdvancedMode,
                            downloads
                        );
                    }
                    pendingTrace = null;

                    isInterrupt = false;

                    if (actions.length > 1) {
                        onStatusUpdate(`📦 Batch: ${actions.length} actions`);
                    }

                    let shouldBreak = false;
                    let shouldRestartLoop = false;

                    for (let i = 0; i < actions.length; i++) {
                        const action = actions[i];

                        if (action.action === 'done') {
                            if (escalationState?.active) {
                                onStatusUpdate(`✅ Advanced objective complete. Returning to base model.`);
                                const restored = yieldToBaseModel(action.reasoning || 'Advanced sub-objective completed.', {
                                    blockerResolved: true
                                });
                                actionHistory.push({
                                    action: 'yield_control',
                                    reasoning: action.reasoning || 'Advanced sub-objective completed.',
                                    success: restored
                                });
                                shouldRestartLoop = true;
                                break;
                            }

                            onStatusUpdate(`✅ Complete: ${action.reasoning}`);
                            pushConversationHistory(`AGENT: ✅ Completed goal "${currentGoal}". Reason: ${action.reasoning}`);
                            lastTerminalAction = {
                                action: 'done',
                                reasoning: action.reasoning,
                                timestamp: new Date().toISOString(),
                            };

                            currentGoal = null;
                            loopTerminatedByAction = true;
                            shouldBreak = true;
                            break;
                        }

                        if (action.action === 'ask') {
                            if (isFinalIteration) {
                                onStatusUpdate(`⚠️ Final-turn blocker: ${action.reasoning}`);
                                pushConversationHistory(`AGENT: Final-turn blocker before iteration limit review: ${action.reasoning}`);
                                lastTerminalAction = {
                                    action: 'ask',
                                    reasoning: action.reasoning,
                                    text: action.text,
                                    timestamp: new Date().toISOString(),
                                };
                                actionHistory.push({
                                    action: 'ask',
                                    coordinate: action.coordinate,
                                    text: action.text,
                                    reasoning: action.reasoning,
                                    success: true
                                });
                                shouldBreak = true;
                                break;
                            }

                            onStatusUpdate(`❓ QUESTION: ${action.reasoning}`);
                            lastTerminalAction = {
                                action: 'ask',
                                reasoning: action.reasoning,
                                text: action.text,
                                timestamp: new Date().toISOString(),
                            };
                            actionHistory.push({
                                action: 'ask',
                                coordinate: action.coordinate,
                                text: action.text,
                                reasoning: action.reasoning,
                                success: true
                            });
                            loopTerminatedByAction = true;
                            shouldBreak = true;
                            break;
                        }

                        if (action.action === 'error') {
                            onStatusUpdate(`🛑 ${action.reasoning}`);
                            pushConversationHistory(`AGENT: 🛑 Failed. Reason: ${action.reasoning}`);
                            lastTerminalAction = {
                                action: 'error',
                                reasoning: action.reasoning,
                                timestamp: new Date().toISOString(),
                            };
                            currentGoal = null;
                            loopTerminatedByAction = true;
                            shouldBreak = true;
                            break;
                        }

                        if (action.action === 'escalate') {
                            if (escalationState?.active) {
                                onStatusUpdate('⚠️ Ignoring nested escalation request while already in advanced mode.');
                                shouldRestartLoop = true;
                                break;
                            }

                            const subObj = action.sub_objective || 'Resolve complex situation';
                            onStatusUpdate(`🚨 ESCALATING TO ADVANCED MODEL: ${subObj}`);

                            const currentConfig = vision.getConfig();
                            escalationState = {
                                active: true,
                                previousGoal: currentGoal!,
                                subObjective: subObj,
                                baseModel: currentConfig.model,
                                baseThinkingLevel: currentConfig.thinkingLevel,
                                baseMediaResolution: currentConfig.mediaResolution,
                                iterations: 0
                            };

                            vision.updateConfig({
                                model: advancedModel,
                                thinkingLevel: advancedThinkingLevel,
                                mediaResolution: advancedMediaResolution
                            });

                            currentGoal = subObj;
                            actionHistory.push({
                                action: 'escalate',
                                sub_objective: subObj,
                                reasoning: action.reasoning,
                                success: true
                            });
                            shouldRestartLoop = true;
                            break;
                        }

                        if (action.action === 'yield_control') {
                            if (!escalationState?.active) {
                                onStatusUpdate('⚠️ Ignoring yield_control without an active escalation.');
                                shouldRestartLoop = true;
                                break;
                            }

                            onStatusUpdate(`🔙 YIELDING CONTROL TO BASE MODEL`);
                            const restored = yieldToBaseModel(action.reasoning || 'Control returned to base model.', {
                                blockerResolved: true
                            });
                            actionHistory.push({
                                action: 'yield_control',
                                reasoning: action.reasoning,
                                success: restored
                            });
                            shouldRestartLoop = true;
                            break;
                        }

                        const batchLabel = actions.length > 1 ? ` [${i + 1}/${actions.length}]` : '';
                        const desc = formatAction(action);
                        onStatusUpdate(`➡️ ${batchLabel} ${desc}`);

                        while (paused && !shouldStop) {
                            await sleep(250);
                        }
                        if (shouldStop) break;

                        const execution = await executeAction(browser, action, onStatusUpdate, {
                            get: () => clipboard,
                            set: (val: string | null) => {
                                clipboard = val;
                            }
                        }, {
                            actionSettleDelayMs,
                            waitActionDelayMs,
                            onEvidence,
                        });
                        const success = execution.success;
                        pendingTrace = execution.trace;
                        if (execution.supplementalFrames.length > 0) {
                            pendingSupplementalFrames = execution.supplementalFrames;
                        }

                        if (pendingTrace && pendingTrace.frames.length > 1) {
                            onStatusUpdate(`🧩 Captured ${pendingTrace.frames.length} trace frames from ${pendingTrace.action}`);
                        }
                        if (execution.supplementalFrames.length > 0) {
                            onStatusUpdate(`🗺️ Captured ${execution.supplementalFrames.length} overview frame(s). Re-evaluating...`);
                        }

                        if (success && action.memory) {
                            const currentUrl = browser.getPageUrl();
                            const stored = addLearning(action.memory, currentUrl || 'general');
                            onStatusUpdate(
                                stored
                                    ? `💡 Saving memory: "${action.memory}"`
                                    : `🧠 Skipping low-signal memory: "${action.memory}"`
                            );
                        }

                        actionHistory.push({
                            action: action.action,
                            coordinate: action.coordinate,
                            coordinateEnd: action.coordinateEnd,
                            text: shouldRedactActionText(action) ? '[redacted]' : action.text,
                            submit: action.submit,
                            clickCount: action.clickCount,
                            tabIndex: action.tabIndex,
                            scrollAmount: action.scrollAmount,
                            scrollDirection: action.scrollDirection,
                            key: action.key,
                            durationMs: action.durationMs,
                            url: action.url,
                            sub_objective: action.sub_objective,
                            expectedFilename: action.expectedFilename,
                            observation: execution.observation,
                            reasoning: action.reasoning,
                            success,
                        });

                        // If action failed, stop batch and let AI re-evaluate with a new screenshot
                        if (!success) {
                            if (actions.length > 1) {
                                onStatusUpdate(`⚠️ Batch stopped at action ${i + 1}/${actions.length} (failed). Re-evaluating...`);
                            }
                            break;
                        }

                        if (action.action === 'inspectPage' || action.action === 'findInPage') {
                            shouldRestartLoop = true;
                            break;
                        }
                    }

                    if (shouldBreak) break;
                    if (shouldRestartLoop) {
                        await compactActionHistoryIfNeeded();
                        pendingTrace = null;
                        continue;
                    }

                    // Detect new tabs opened by page actions (popups, target="_blank")
                    const tabsAfter = await browser.getOpenTabCount();
                    if (tabsAfter > tabsBefore) {
                        const newTabCount = tabsAfter - tabsBefore;
                        onStatusUpdate(`🔔 ${newTabCount} new tab(s) detected! Switching to newest tab.`);
                        // Auto-switch to the newest tab so AI sees the new content
                        await browser.switchTab(tabsAfter - 1);
                        // Record this in history so AI knows what happened
                        actionHistory.push({
                            action: 'switchTab',
                            tabIndex: tabsAfter - 1,
                            reasoning: `Auto-switched: ${newTabCount} new tab(s) opened by previous action`,
                            success: true,
                        });
                    }

                    await compactActionHistoryIfNeeded();

                    await sleep(stepDelayMs);
                }

                if (!loopTerminatedByAction && !shouldStop && currentGoal && iterationCount >= maxIterations) {
                    const reviewGoal = escalationState?.previousGoal || currentGoal;
                    if (escalationState?.active) {
                        yieldToBaseModel('Iteration limit reached during advanced intervention.', {
                            blockerResolved: false
                        });
                    }

                    onStatusUpdate(`🛑 Max iterations reached (${iterationCount}/${maxIterations})`);
                    pushConversationHistory(`AGENT: Reached the iteration limit before completing the goal "${reviewGoal}".`);
                    lastTerminalAction = {
                        action: 'iteration_limit',
                        reasoning: `Max iterations reached (${iterationCount}/${maxIterations})`,
                        timestamp: new Date().toISOString(),
                    };

                    try {
                        const reviewFrame = await browser.captureAgentFrame();
                        const reviewTabs = await browser.listTabs();
                        const reviewDownloads = browser.getDownloads();
                        const review = await vision.reflectOnIterationLimit(
                            reviewFrame,
                            reviewGoal,
                            actionHistory,
                            conversationHistory,
                            pendingTrace,
                            pendingSupplementalFrames,
                            reviewTabs,
                            reviewDownloads
                        );

                        if (review) {
                            onStatusUpdate(formatIterationLimitReview(review, iterationCount, maxIterations));
                            const agentNeedStatus = recordBrowserIterationLimitNeed(
                                review,
                                reviewGoal,
                                actionHistory,
                                reviewTabs.find(tab => tab.isActive)?.url || reviewTabs[0]?.url || ''
                            );
                            if (agentNeedStatus) onStatusUpdate(agentNeedStatus);

                            if (review.questionsForUser.length > 0) {
                                pushConversationHistory(
                                    `AGENT: Iteration-limit review questions for the user: ${review.questionsForUser.join(' | ')}`
                                );
                            }
                        } else {
                            onStatusUpdate('🧠 Iteration limit review unavailable. The agent ran out of attempts before producing a useful diagnosis.');
                        }
                    } catch (reviewError) {
                        onStatusUpdate(`⚠️ Iteration limit review failed: ${reviewError instanceof Error ? reviewError.message : 'Unknown error'}`);
                    }
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown';
                lastTerminalAction = {
                    action: 'error',
                    reasoning: message,
                    timestamp: new Date().toISOString(),
                };
                onStatusUpdate(`❌ Error: ${message}`);
            } finally {
                running = false;
            }
        },

        stop() {
            shouldStop = true;
            paused = false;
            currentGoal = null;
            pendingSupplementalFrames = [];
            lastTerminalAction = {
                action: 'stopped',
                reasoning: 'Browser task stopped.',
                timestamp: new Date().toISOString(),
            };
            if (escalationState) {
                restoreBaseModel();
                escalationState = null;
            }
            onStatusUpdate('🛑 Stopping...');
        },

        pause() {
            if (!running || paused) {
                return;
            }
            paused = true;
            onStatusUpdate('⏸️ Browser agent paused for human control.');
        },

        resume() {
            if (!paused) {
                return;
            }
            paused = false;
            onStatusUpdate('▶️ Browser agent resumed.');
        },

        resetContext(resetOptions: ResetContextOptions = {}) {
            const clearConversationHistory = resetOptions.clearConversationHistory ?? true;
            const clearActionHistory = resetOptions.clearActionHistory ?? true;
            const clearClipboard = resetOptions.clearClipboard ?? true;
            const clearCurrentGoal = resetOptions.clearCurrentGoal ?? true;
            const clearInterruptFlag = resetOptions.clearInterruptFlag ?? true;

            if (clearConversationHistory) {
                conversationHistory = [];
            }
            if (clearActionHistory) {
                actionHistory = [];
                compactedActionCount = 0;
            }
            if (clearClipboard) {
                clipboard = null;
            }
            pendingTrace = null;
            pendingSupplementalFrames = [];
            lastTerminalAction = null;
            if (clearCurrentGoal) {
                currentGoal = null;
            }
            if (clearInterruptFlag) {
                isInterrupt = false;
            }
            if (escalationState) {
                restoreBaseModel();
                escalationState = null;
            }

            onStatusUpdate('🧼 Context reset complete.');
        },

        getStatus(): AgentControllerStatus {
            return {
                running,
                paused,
                currentGoal,
                actionHistoryLength: actionHistory.length,
                conversationHistoryLength: conversationHistory.length,
                lastTerminalAction,
            };
        },

        isRunning() {
            return running;
        },
    };

    return controller;
}

function denormalize(coordinate: [number, number], width: number, height: number): [number, number] {
    const [x, y] = coordinate;
    const pixelX = Math.round((x / 1000) * width);
    const pixelY = Math.round((y / 1000) * height);
    return [pixelX, pixelY];
}

async function resolveCoordinate(browser: BrowserPageSession, coordinate: [number, number]): Promise<[number, number]> {
    if (browser.capabilities.coordinateSpace === 'absolute-display') {
        return [Math.round(coordinate[0]), Math.round(coordinate[1])];
    }
    const viewport = await browser.getViewport();
    return denormalize(coordinate, viewport.width, viewport.height);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordBrowserIterationLimitNeed(
    review: IterationLimitReview,
    goal: string,
    actionHistory: ActionHistoryItem[],
    currentUrl: string
): string | null {
    if (review.missingToolsOrCapabilities.length === 0) return null;

    const host = hostFromUrl(currentUrl);
    const missing = review.missingToolsOrCapabilities.join('; ');
    const future = review.futureStrategy.length > 0
        ? ` Suggested next steps: ${review.futureStrategy.join(' | ')}`
        : '';

    try {
        const result = recordAgentNeed({
            agent: 'browser_agent',
            severity: 'medium',
            category: 'missing_capability',
            summary: compactSentence(review.stuckPoint || review.whyNotFinished || `Browser agent could not finish task on ${host}.`, 180),
            attempted: [
                `Goal: ${goal}`,
                `Current URL: ${currentUrl || 'unknown'}`,
                `Iteration limit reached after ${actionHistory.length} recorded action(s).`,
                review.whyNotFinished ? `Why not finished: ${review.whyNotFinished}` : '',
                review.whySelfRecoveryFailed ? `Why self-recovery failed: ${review.whySelfRecoveryFailed}` : '',
                recentActionSummary(actionHistory),
            ].filter(Boolean).join('\n'),
            needed: `Missing tools/capabilities: ${missing}.${future}`,
            workaround: [
                review.humanAssessment ? `Human assessment: ${review.humanAssessment}` : '',
                review.questionsForUser.length > 0 ? `Questions for user: ${review.questionsForUser.join(' | ')}` : '',
            ].filter(Boolean).join('\n'),
            dedupeKey: `browser_agent:${host}:${missing}`,
            source: 'browser_iteration_limit_review',
        });

        return result.duplicate
            ? `📝 Browser blocker already logged in ${result.path} (${result.dedupeKey}).`
            : `📝 Logged browser blocker to ${result.path} (${result.dedupeKey}).`;
    } catch (error) {
        return `⚠️ Could not log browser blocker to AGENT_NEEDS.md: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}

function hostFromUrl(value: string): string {
    try {
        return new URL(value).hostname.replace(/^www\./, '') || 'general';
    } catch {
        return 'general';
    }
}

function recentActionSummary(actionHistory: ActionHistoryItem[]): string {
    const recent = actionHistory.slice(-8);
    if (recent.length === 0) return '';
    return `Recent actions: ${recent.map(action => {
        const detail = action.reasoning ? ` (${compactSentence(action.reasoning, 80)})` : '';
        return `${action.action}${action.success ? '' : ' failed'}${detail}`;
    }).join(' -> ')}`;
}

function compactSentence(value: string, maxChars: number): string {
    const clean = value.replace(/\s+/g, ' ').trim();
    return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1).trimEnd()}…`;
}

interface ActionExecutionResult {
    success: boolean;
    trace: ActionTrace | null;
    supplementalFrames: BrowserFrameSnapshot[];
    observation?: string;
}

function shouldRedactActionText(action: AgentAction): boolean {
    return action.action === 'type' && isLikelySensitiveBrowserText(action.text, action.reasoning);
}

const PASTE_TEXT_THRESHOLD = 120;
const MAX_DIAGNOSTIC_LINES = 10;
const MAX_FETCH_SNIPPET_CHARS = 1800;

function shouldPasteText(text: string): boolean {
    return text.length >= PASTE_TEXT_THRESHOLD || /[\r\n\t]/.test(text);
}

function shouldIncludePreviousFrameAfter(action: ActionHistoryItem | undefined): boolean {
    if (!action || !action.success) return false;
    return !['ask', 'done', 'error', 'escalate', 'yield_control'].includes(action.action);
}

function previousVisualContextFrames(
    browser: BrowserPageSession,
    currentFrame: BrowserFrameSnapshot,
    actionHistory: ActionHistoryItem[]
): BrowserFrameSnapshot[] {
    const lastAction = actionHistory[actionHistory.length - 1];
    if (!shouldIncludePreviousFrameAfter(lastAction)) return [];

    const recentFrames = browser.getAgentFrameHistory(2);
    const previous = recentFrames
        .filter(frame => frame.id !== currentFrame.id)
        .slice(-1)[0];
    if (!previous) return [];
    return [previous];
}

function formatObservationUrl(value: string): string {
    try {
        const url = new URL(value);
        for (const [key] of url.searchParams) {
            if (/(token|secret|key|code|auth|session|password)/i.test(key)) {
                url.searchParams.set(key, '[redacted]');
            }
        }
        return redactBrowserAgentText(`${url.origin}${url.pathname}${url.search}`);
    } catch {
        return redactBrowserAgentText(value);
    }
}

function trimObservation(value: string, maxChars: number): string {
    const clean = redactBrowserAgentText(value).replace(/\s+/g, ' ').trim();
    return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1).trimEnd()}…`;
}

function summarizeDiagnostics(diagnostics: BrowserDiagnosticsSnapshot): string {
    if (!diagnostics.supported) {
        return 'Browser diagnostics are unavailable on this backend.';
    }

    const lines = [
        `Current URL: ${formatObservationUrl(diagnostics.currentUrl) || '(unknown)'}`,
        `Captured: console=${diagnostics.consoleMessages.length}, pageErrors=${diagnostics.pageErrors.length}, failedRequests=${diagnostics.failedRequests.length}, httpErrors=${diagnostics.httpErrors.length}`,
    ];

    const httpErrors = diagnostics.httpErrors.slice(-MAX_DIAGNOSTIC_LINES);
    if (httpErrors.length > 0) {
        lines.push('HTTP errors:');
        for (const entry of httpErrors) {
            lines.push(`- ${entry.status || '?'} ${entry.method} ${formatObservationUrl(entry.url)} (${entry.resourceType}${entry.statusText ? `, ${entry.statusText}` : ''})`);
        }
    }

    const failedRequests = diagnostics.failedRequests.slice(-MAX_DIAGNOSTIC_LINES);
    if (failedRequests.length > 0) {
        lines.push('Failed requests:');
        for (const entry of failedRequests) {
            lines.push(`- ${entry.method} ${formatObservationUrl(entry.url)} (${entry.resourceType}): ${trimObservation(entry.failureText || 'failed', 160)}`);
        }
    }

    const pageErrors = diagnostics.pageErrors.slice(-MAX_DIAGNOSTIC_LINES);
    if (pageErrors.length > 0) {
        lines.push('Page errors:');
        for (const entry of pageErrors) {
            lines.push(`- ${formatObservationUrl(entry.url)}: ${trimObservation(entry.message, 240)}`);
        }
    }

    const consoleMessages = diagnostics.consoleMessages
        .filter(entry => ['error', 'warning', 'warn'].includes(entry.level.toLowerCase()))
        .slice(-MAX_DIAGNOSTIC_LINES);
    if (consoleMessages.length > 0) {
        lines.push('Console warnings/errors:');
        for (const entry of consoleMessages) {
            lines.push(`- ${entry.level} ${formatObservationUrl(entry.url)}: ${trimObservation(entry.text, 240)}`);
        }
    }

    if (lines.length === 2) {
        lines.push('No console warnings/errors, page errors, failed requests, or HTTP 4xx/5xx responses captured.');
    }

    return lines.join('\n');
}

function summarizeJsonShape(value: string): string {
    try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) {
            return `JSON array length=${parsed.length}`;
        }
        if (parsed && typeof parsed === 'object') {
            const record = parsed as Record<string, unknown>;
            const keys = Object.keys(record).slice(0, 12);
            const hints = keys.map((key) => {
                const item = record[key];
                if (Array.isArray(item)) return `${key}[${item.length}]`;
                if (item && typeof item === 'object') return `${key}{${Object.keys(item as Record<string, unknown>).slice(0, 5).join(',')}}`;
                return key;
            });
            return `JSON object keys=${hints.join(', ') || '(none)'}`;
        }
        return `JSON ${typeof parsed}`;
    } catch {
        return '';
    }
}

function summarizeFetchResult(result: BrowserFetchResult): string {
    if (!result.supported) {
        return result.error || 'Browser-context fetch is unavailable on this backend.';
    }

    const lines = [
        `Requested URL: ${formatObservationUrl(result.requestedUrl)}`,
        `Final URL: ${formatObservationUrl(result.finalUrl)}`,
        `Status: ${result.status} ${result.statusText || ''}`.trim(),
        `OK: ${result.ok ? 'yes' : 'no'}${result.redirected ? ' (redirected)' : ''}`,
        `Content-Type: ${result.contentType || '(unknown)'}`,
        `Body length: ${result.bodyLength}`,
    ];

    if (result.error) {
        lines.push(`Error: ${trimObservation(result.error, 300)}`);
        return lines.join('\n');
    }

    const shape = summarizeJsonShape(result.bodySnippet);
    if (shape) lines.push(shape);
    if (result.bodySnippet.trim()) {
        lines.push(`Body snippet: ${trimObservation(result.bodySnippet, MAX_FETCH_SNIPPET_CHARS)}`);
    } else {
        lines.push('Body snippet: (empty)');
    }

    return lines.join('\n');
}

function fallbackActionHistorySummary(actions: ActionHistoryItem[]): string {
    const lines = actions.slice(-20).map((action, index) => {
        const step = Math.max(1, actions.length - Math.min(actions.length, 20) + index + 1);
        const status = action.success ? 'ok' : 'failed';
        const text = action.text ? ` text="${formatBrowserAgentTextForLog(action.text, action.reasoning, 40)}"` : '';
        const reason = action.reasoning
            ? `; reason="${formatBrowserAgentTextForLog(action.reasoning, '', 120)}"`
            : '';
        const observation = action.observation
            ? `; result="${formatBrowserAgentTextForLog(action.observation, '', 160)}"`
            : '';
        return `Step ${step}: ${action.action}${text} ${status}${reason}${observation}`;
    });

    const omitted = Math.max(0, actions.length - lines.length);
    const prefix = omitted > 0
        ? `Deterministic fallback summary. ${actions.length} older actions compacted; first ${omitted} omitted.`
        : `Deterministic fallback summary. ${actions.length} older actions compacted.`;
    return `${prefix}\n${lines.join('\n')}`;
}

async function executeAction(
    browser: BrowserPageSession,
    action: AgentAction,
    onStatusUpdate: (message: string) => void,
    clipboardOps: { get: () => string | null; set: (val: string | null) => void },
    timing: {
        actionSettleDelayMs: number;
        waitActionDelayMs: number;
        onEvidence?: (capture: BrowserEvidenceCapture) => void | Promise<void>;
    }
): Promise<ActionExecutionResult> {
    try {
        switch (action.action) {
            case 'click':
                if (action.coordinate) {
                    const [x, y] = await resolveCoordinate(browser, action.coordinate);
                    const count = action.clickCount || 1;
                    const countStr = count > 1 ? ` (x${count})` : '';
                    onStatusUpdate(`🖱️  Clicking at [${x}, ${y}]${countStr} (from ${action.coordinate})`);
                    const result = await browser.clickCoordinate(x, y, count);
                    await sleep(timing.actionSettleDelayMs);
                    return { success: result, trace: null, supplementalFrames: [] };
                }
                return { success: false, trace: null, supplementalFrames: [] };

            case 'hover':
                if (action.coordinate) {
                    const [x, y] = await resolveCoordinate(browser, action.coordinate);
                    onStatusUpdate(`🖱️  Hovering at [${x}, ${y}]`);
                    await browser.hoverCoordinate(x, y);
                    await sleep(timing.actionSettleDelayMs);
                    return { success: true, trace: null, supplementalFrames: [] };
                }
                return { success: false, trace: null, supplementalFrames: [] };

            case 'inspectPage': {
                onStatusUpdate('🗺️  Capturing full-page overview...');
                const overviewFrame = await browser.captureOverviewFrame();
                return { success: true, trace: null, supplementalFrames: [overviewFrame] };
            }

            case 'findInPage': {
                const query = String(action.text || '').trim();
                if (!query) {
                    return { success: false, trace: null, supplementalFrames: [] };
                }
                onStatusUpdate(`🔎 Finding in page: "${query}"`);
                await browser.findInPage(query, Boolean(action.submit));
                await sleep(timing.actionSettleDelayMs);
                return { success: true, trace: null, supplementalFrames: [] };
            }

            case 'inspectDiagnostics': {
                onStatusUpdate('🧪 Inspecting browser diagnostics...');
                const diagnostics = browser.getDiagnostics();
                const observation = summarizeDiagnostics(diagnostics);
                onStatusUpdate(`🧪 Browser diagnostics:\n${observation}`);
                return {
                    success: diagnostics.supported,
                    trace: null,
                    supplementalFrames: [],
                    observation,
                };
            }

            case 'fetchUrl': {
                const targetUrl = String(action.url || action.text || '').trim();
                if (!targetUrl) {
                    return {
                        success: false,
                        trace: null,
                        supplementalFrames: [],
                        observation: 'No URL was provided for fetchUrl.',
                    };
                }
                onStatusUpdate(`🌐 Browser-context fetch: ${targetUrl}`);
                const result = await browser.fetchUrl(targetUrl);
                const observation = summarizeFetchResult(result);
                onStatusUpdate(`🌐 Fetch result:\n${observation}`);
                return {
                    success: result.supported && !result.error,
                    trace: null,
                    supplementalFrames: [],
                    observation,
                };
            }

            case 'screenshot': {
                onStatusUpdate('📸 Saving browser screenshot...');
                const frame = await browser.captureAgentFrame();
                if (timing.onEvidence) {
                    await timing.onEvidence({
                        kind: 'screenshot',
                        mimeType: 'image/jpeg',
                        data: Buffer.from(frame.imageBase64, 'base64'),
                        filenameBase: 'browser-screenshot',
                        timestamp: frame.timestamp,
                        url: frame.url,
                        captureMode: frame.captureMode,
                        viewport: frame.viewport,
                        page: frame.page,
                    });
                }
                return { success: true, trace: null, supplementalFrames: [] };
            }

            case 'recordVideo': {
                const durationMs = action.durationMs || 5000;
                onStatusUpdate(`🎥 Recording browser video for ${durationMs}ms...`);
                const recording = await browser.recordVideo(durationMs);
                if (timing.onEvidence) {
                    await timing.onEvidence({
                        kind: 'video',
                        mimeType: recording.mimeType,
                        data: Buffer.from(recording.videoBase64, 'base64'),
                        filenameBase: 'browser-recording',
                        timestamp: recording.timestamp,
                        url: recording.url,
                        durationMs: recording.durationMs,
                        fps: recording.fps,
                        frameCount: recording.frameCount,
                        viewport: recording.viewport,
                        page: recording.page,
                    });
                }
                return { success: true, trace: null, supplementalFrames: [] };
            }

            case 'hold':
                if (action.coordinate) {
                    const [x, y] = await resolveCoordinate(browser, action.coordinate);
                    const holdDuration = action.durationMs || 10000;
                    onStatusUpdate(`🖱️  Holding at [${x}, ${y}] for ${holdDuration}ms`);
                    const result = await browser.holdCoordinate(x, y, holdDuration);
                    await sleep(timing.actionSettleDelayMs);
                    return {
                        success: result.success,
                        trace: result.trace,
                        supplementalFrames: [],
                    };
                }
                return { success: false, trace: null, supplementalFrames: [] };

            case 'drag':
                if (action.coordinate && action.coordinateEnd) {
                    const [startX, startY] = await resolveCoordinate(browser, action.coordinate);
                    const [endX, endY] = await resolveCoordinate(browser, action.coordinateEnd);
                    const dragDuration = action.durationMs || 900;
                    onStatusUpdate(`🖱️  Dragging from [${startX}, ${startY}] to [${endX}, ${endY}] over ${dragDuration}ms`);
                    const result = await browser.dragCoordinate(startX, startY, endX, endY, dragDuration);
                    await sleep(timing.actionSettleDelayMs);
                    return {
                        success: result.success,
                        trace: result.trace,
                        supplementalFrames: [],
                    };
                }
                return { success: false, trace: null, supplementalFrames: [] };

            case 'clear':
                if (action.coordinate) {
                    const [x, y] = await resolveCoordinate(browser, action.coordinate);
                    onStatusUpdate(`🖱️  Clicking [${x}, ${y}] to focus before clearing`);
                    await browser.clickCoordinate(x, y);
                    await sleep(timing.actionSettleDelayMs);
                }
                onStatusUpdate('🧹 Clearing input...');
                await browser.clear();
                return { success: true, trace: null, supplementalFrames: [] };

            case 'type':
                if (action.text) {
                    if (action.coordinate) {
                        const [x, y] = await resolveCoordinate(browser, action.coordinate);
                        onStatusUpdate(`🖱️  Clicking [${x}, ${y}] to focus`);
                        await browser.clickCoordinate(x, y);
                        await sleep(timing.actionSettleDelayMs);
                    }

                    if (action.clearBefore) {
                        onStatusUpdate('🧹 Clearing input before typing...');
                        await browser.clear();
                        await sleep(timing.actionSettleDelayMs);
                    }

                    if (shouldPasteText(action.text)) {
                        onStatusUpdate(`📋 Pasting text (${action.text.length} chars): "${formatBrowserAgentTextForLog(action.text, action.reasoning)}"`);
                        await browser.paste(action.text);
                    } else {
                        onStatusUpdate(`⌨️  Typing: "${formatBrowserAgentTextForLog(action.text, action.reasoning)}"`);
                        await browser.type(action.text);
                    }

                    if (action.submit) {
                        onStatusUpdate('↵  Pressing Enter (Submit)');
                        await sleep(timing.actionSettleDelayMs);
                        await browser.pressKey('Enter');
                    }

                    await sleep(timing.actionSettleDelayMs);
                    return { success: true, trace: null, supplementalFrames: [] };
                }
                return { success: false, trace: null, supplementalFrames: [] };

            case 'key':
                if (action.key) {
                    onStatusUpdate(`⌨️  Pressing: ${action.key}`);
                    await browser.pressKey(action.key);
                    await sleep(timing.actionSettleDelayMs);
                    return { success: true, trace: null, supplementalFrames: [] };
                }
                return { success: false, trace: null, supplementalFrames: [] };

            case 'scroll': {
                const amountText = action.scrollAmount ? ` by ${action.scrollAmount}px` : '';
                onStatusUpdate(`📜 Scrolling ${action.scrollDirection || 'down'}${amountText}...`);
                await browser.scroll(action.scrollDirection || 'down', action.scrollAmount);
                return { success: true, trace: null, supplementalFrames: [] };
            }

            case 'scrollToBottom':
                onStatusUpdate('📜 Scrolling to bottom...');
                await browser.scrollToBottom();
                return { success: true, trace: null, supplementalFrames: [] };

            case 'undo':
                onStatusUpdate('↩️ Undoing last edit...');
                await browser.undo();
                return { success: true, trace: null, supplementalFrames: [] };

            case 'navigate':
                if (action.url) {
                    onStatusUpdate(`🌐 Navigating to: ${action.url}`);
                    await browser.navigate(action.url);
                    return { success: true, trace: null, supplementalFrames: [] };
                }
                return { success: false, trace: null, supplementalFrames: [] };

            case 'closeTab':
                onStatusUpdate(
                    action.tabIndex !== undefined
                        ? `🗑️ Closing tab ${action.tabIndex}...`
                        : '🗑️ Closing current tab...'
                );
                return {
                    success: await browser.closeTab(action.tabIndex),
                    trace: null,
                    supplementalFrames: [],
                };

            case 'refresh':
                onStatusUpdate('🔄 Refreshing page...');
                await browser.reloadPage();
                return { success: true, trace: null, supplementalFrames: [] };

            case 'wait': {
                const waitDuration = action.durationMs || timing.waitActionDelayMs;
                onStatusUpdate(`⏳ Waiting for ${waitDuration}ms...`);
                await sleep(waitDuration);
                return { success: true, trace: null, supplementalFrames: [] };
            }

            case 'goForward':
                onStatusUpdate('➡️ Going Forward...');
                await browser.goForward();
                return { success: true, trace: null, supplementalFrames: [] };

            case 'goBack':
                onStatusUpdate('⬅️ Going Back...');
                await browser.goBack();
                return { success: true, trace: null, supplementalFrames: [] };

            case 'listTabs': {
                onStatusUpdate('📑 Listing open tabs...');
                const tabs = await browser.listTabs();
                const tabSummary = tabs.map(t => `[${t.index}]${t.isActive ? ' ★' : ''} ${t.title} — ${t.url}`).join('\n');
                onStatusUpdate(`📑 Open tabs:\n${tabSummary}`);
                return { success: true, trace: null, supplementalFrames: [] };
            }

            case 'switchTab': {
                const targetIndex = action.tabIndex ?? -1;
                onStatusUpdate(`🔀 Switching to tab ${targetIndex}...`);
                const switched = await browser.switchTab(targetIndex);
                if (!switched) {
                    onStatusUpdate(`⚠️ Failed to switch to tab ${targetIndex}`);
                }
                return { success: switched, trace: null, supplementalFrames: [] };
            }

            case 'newTab': {
                const tabUrl = action.url || undefined;
                onStatusUpdate(`➕ Opening new tab${tabUrl ? `: ${tabUrl}` : ''}...`);
                const opened = await browser.newTab(tabUrl);
                if (!opened) {
                    onStatusUpdate('⚠️ Failed to open new tab');
                }
                return { success: opened, trace: null, supplementalFrames: [] };
            }

            case 'listDownloads': {
                onStatusUpdate('📥 Listing browser downloads...');
                const downloads = browser.getDownloads();
                const observation = summarizeDownloads(downloads);
                onStatusUpdate(`📥 Browser downloads:\n${observation}`);
                return { success: true, trace: null, supplementalFrames: [], observation };
            }

            case 'waitForDownloads': {
                const before = browser.getDownloads();
                const hasPendingBefore = before.some(download => download.state === 'pending');
                const waitDuration = clampDownloadWaitMs(action.durationMs);
                const expected = action.expectedFilename ? ` expecting "${action.expectedFilename}"` : '';
                onStatusUpdate(`📥 Waiting up to ${waitDuration}ms for a browser download${expected}...`);
                const after = await browser.waitForDownloads(waitDuration, {
                    waitForNew: !hasPendingBefore,
                    baselineCount: before.length,
                });
                const relevant = changedDownloads(before, after);
                const observation = summarizeDownloadWait(before, after, relevant, action.expectedFilename);
                const savedMatches = relevant.filter(download =>
                    download.state === 'saved' && filenameMatches(download, action.expectedFilename)
                );
                const success = savedMatches.length > 0;
                onStatusUpdate(`📥 Download verification ${success ? 'succeeded' : 'did not confirm a saved file'}:\n${observation}`);
                return { success, trace: null, supplementalFrames: [], observation };
            }

            case 'readClipboard': {
                onStatusUpdate('📋 Reading browser clipboard...');
                const content = await browser.readClipboard();
                if (content === null) {
                    const observation = 'Clipboard could not be read.';
                    onStatusUpdate(`⚠️ ${observation}`);
                    return { success: false, trace: null, supplementalFrames: [], observation };
                }

                clipboardOps.set(content);
                const observation = content.length > 0
                    ? `Clipboard: ${content}`
                    : 'Clipboard is empty.';
                onStatusUpdate(
                    content.length > 0
                        ? `📋 Clipboard read (${content.length} characters).`
                        : '📋 Clipboard is empty.'
                );
                return { success: true, trace: null, supplementalFrames: [], observation };
            }

            case 'getLink': {
                let linkToCopy: string | null = null;
                if (action.coordinate) {
                    const [x, y] = await resolveCoordinate(browser, action.coordinate);
                    linkToCopy = await browser.getHrefAt(x, y);
                    onStatusUpdate(`🔗 Checked link at [${x}, ${y}]`);
                }

                if (!linkToCopy) {
                    linkToCopy = browser.getPageUrl();
                    onStatusUpdate(`🔗 Copying Page URL: ${linkToCopy}`);
                } else {
                    onStatusUpdate(`🔗 Copying Found Link: ${linkToCopy}`);
                }

                if (linkToCopy) {
                    clipboardOps.set(linkToCopy);
                    return { success: true, trace: null, supplementalFrames: [] };
                }
                return { success: false, trace: null, supplementalFrames: [] };
            }

            case 'pasteLink': {
                let content = clipboardOps.get();
                if (!content) {
                    const browserClipboard = await browser.readClipboard();
                    if (browserClipboard) {
                        content = browserClipboard;
                        clipboardOps.set(content);
                        onStatusUpdate(`📋 Using browser clipboard (${content.length} characters).`);
                    }
                }
                if (!content) {
                    onStatusUpdate("⚠️ Clipboard is empty! Use 'getLink' first.");
                    return { success: false, trace: null, supplementalFrames: [] };
                }

                if (action.coordinate) {
                    const [x, y] = await resolveCoordinate(browser, action.coordinate);
                    onStatusUpdate(`🖱️ Clicking to focus for paste at [${x}, ${y}]`);
                    await browser.clickCoordinate(x, y);
                    await sleep(timing.actionSettleDelayMs);
                }

                if (action.clearBefore) {
                    onStatusUpdate('🧹 Clearing input before pasting...');
                    await browser.clear();
                    await sleep(timing.actionSettleDelayMs);
                }

                onStatusUpdate(`📋 Pasting link: "${content}"`);
                await browser.paste(content);
                return { success: true, trace: null, supplementalFrames: [] };
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onStatusUpdate(`⚠️ Action failed: ${message}`);
        return { success: false, trace: null, supplementalFrames: [] };
    }

    return { success: false, trace: null, supplementalFrames: [] };
}
