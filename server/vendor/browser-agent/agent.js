/**
 * Agent Controller
 * Smart automation loop with failure tracking and memory
 */
import { initializeDefaultLearnings, addLearning } from './memory.js';
export function createAgentController(browser, vision, onStatusUpdate, options = {}) {
    const maxIterations = options.maxIterations ?? 50;
    const maxConversationHistory = options.maxConversationHistory ?? 40;
    const stepDelayMs = options.stepDelayMs ?? 500;
    const actionSettleDelayMs = options.actionSettleDelayMs ?? 300;
    const waitActionDelayMs = options.waitActionDelayMs ?? 3000;
    let currentGoal = null;
    let running = false;
    let shouldStop = false;
    let isInterrupt = false;
    let actionHistory = [];
    let conversationHistory = [];
    let clipboard = null;
    initializeDefaultLearnings();
    const pushConversationHistory = (entry) => {
        conversationHistory.push(entry);
        if (conversationHistory.length > maxConversationHistory) {
            conversationHistory = conversationHistory.slice(-maxConversationHistory);
        }
    };
    const controller = {
        setTask(goal, taskOptions = {}) {
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
                pushConversationHistory(`USER: ${trimmedGoal} (Reply to previous context)`);
                currentGoal = `${trimmedGoal} ${previousContext}`;
            }
            else {
                if (preserveContext && currentGoal) {
                    pushConversationHistory(`USER: [Changed Goal] ${trimmedGoal}`);
                }
                else {
                    pushConversationHistory(`USER: ${trimmedGoal}`);
                }
                currentGoal = trimmedGoal;
            }
            actionHistory = [];
            if (wasRunning) {
                isInterrupt = true;
                onStatusUpdate(`⚡ Interrupting... New goal: "${trimmedGoal}"`);
            }
            else {
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
                while (!shouldStop && currentGoal && iterationCount < maxIterations) {
                    iterationCount++;
                    onStatusUpdate('📸 Scanning page...');
                    const screenshot = await browser.screenshot();
                    onStatusUpdate('🤖 AI deciding...');
                    const action = await vision.analyzeScreenshot(screenshot, currentGoal, actionHistory, conversationHistory, isInterrupt);
                    isInterrupt = false;
                    if (action.memory) {
                        onStatusUpdate(`💡 Saving memory: "${action.memory}"`);
                        const currentUrl = browser.getPageUrl();
                        addLearning(action.memory, currentUrl || 'general');
                    }
                    if (action.action === 'done') {
                        onStatusUpdate(`✅ Complete: ${action.reasoning}`);
                        pushConversationHistory(`AGENT: ✅ Completed goal "${currentGoal}". Reason: ${action.reasoning}`);
                        currentGoal = null;
                        break;
                    }
                    if (action.action === 'ask') {
                        onStatusUpdate(`❓ QUESTION: ${action.reasoning}`);
                        actionHistory.push({
                            action: 'ask',
                            coordinate: action.coordinate,
                            text: action.text,
                            reasoning: action.reasoning,
                            success: true
                        });
                        break;
                    }
                    if (action.action === 'error') {
                        onStatusUpdate(`🛑 ${action.reasoning}`);
                        pushConversationHistory(`AGENT: 🛑 Failed. Reason: ${action.reasoning}`);
                        currentGoal = null;
                        break;
                    }
                    const desc = formatAction(action);
                    onStatusUpdate(`➡️  ${desc}`);
                    const success = await executeAction(browser, action, onStatusUpdate, {
                        get: () => clipboard,
                        set: (val) => {
                            clipboard = val;
                        }
                    }, {
                        actionSettleDelayMs,
                        waitActionDelayMs
                    });
                    actionHistory.push({
                        action: action.action,
                        coordinate: action.coordinate,
                        text: action.text,
                        submit: action.submit,
                        clickCount: action.clickCount,
                        reasoning: action.reasoning,
                        success,
                    });
                    if (actionHistory.length > 25) {
                        actionHistory = actionHistory.slice(-20);
                    }
                    await sleep(stepDelayMs);
                }
                if (iterationCount >= maxIterations) {
                    onStatusUpdate('🛑 Max iterations reached');
                }
            }
            catch (error) {
                onStatusUpdate(`❌ Error: ${error instanceof Error ? error.message : 'Unknown'}`);
            }
            finally {
                running = false;
            }
        },
        stop() {
            shouldStop = true;
            currentGoal = null;
            onStatusUpdate('🛑 Stopping...');
        },
        resetContext(resetOptions = {}) {
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
            }
            if (clearClipboard) {
                clipboard = null;
            }
            if (clearCurrentGoal) {
                currentGoal = null;
            }
            if (clearInterruptFlag) {
                isInterrupt = false;
            }
            onStatusUpdate('🧼 Context reset complete.');
        },
        getStatus() {
            return {
                running,
                currentGoal,
                actionHistoryLength: actionHistory.length,
                conversationHistoryLength: conversationHistory.length,
            };
        },
        isRunning() {
            return running;
        },
    };
    return controller;
}
function formatAction(action) {
    switch (action.action) {
        case 'click': {
            const coords = action.coordinate ? `[${action.coordinate[0]}, ${action.coordinate[1]}]` : '[?]';
            const count = action.clickCount && action.clickCount > 1 ? ' (Double Click)' : '';
            return `Click ${coords}${count} - ${action.reasoning}`;
        }
        case 'hover': {
            const coords = action.coordinate ? `[${action.coordinate[0]}, ${action.coordinate[1]}]` : '[?]';
            return `Hover ${coords} - ${action.reasoning}`;
        }
        case 'hold': {
            const coords = action.coordinate ? `[${action.coordinate[0]}, ${action.coordinate[1]}]` : '[?]';
            return `Hold ${coords} - ${action.reasoning}`;
        }
        case 'type': {
            const coords = action.coordinate ? ` at [${action.coordinate[0]}, ${action.coordinate[1]}]` : '';
            const clear = action.clearBefore ? ' (Clear First)' : '';
            const enter = action.submit ? ' + Enter' : '';
            return `Type "${action.text?.substring(0, 20)}..."${coords}${clear}${enter} - ${action.reasoning}`;
        }
        case 'clear': {
            const coords = action.coordinate ? ` at [${action.coordinate[0]}, ${action.coordinate[1]}]` : '';
            return `Clear Input${coords} - ${action.reasoning}`;
        }
        case 'key':
            return `Press ${action.key} - ${action.reasoning}`;
        case 'scroll':
            return `Scroll ${action.scrollDirection} - ${action.reasoning}`;
        case 'wait':
            return `Wait - ${action.reasoning}`;
        case 'navigate':
            return `Navigate to ${action.url} - ${action.reasoning}`;
        case 'done':
            return `Done - ${action.reasoning}`;
        case 'ask':
            return `Ask User - ${action.reasoning}`;
        case 'goBack':
            return `Go Back - ${action.reasoning}`;
        case 'goForward':
            return `Go Forward - ${action.reasoning}`;
        default:
            return `${action.action} - ${action.reasoning}`;
    }
}
function denormalize(coordinate, width, height) {
    const [x, y] = coordinate;
    const pixelX = Math.round((x / 1000) * width);
    const pixelY = Math.round((y / 1000) * height);
    return [pixelX, pixelY];
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function executeAction(browser, action, onStatusUpdate, clipboardOps, timing) {
    try {
        switch (action.action) {
            case 'click':
                if (action.coordinate) {
                    const viewport = await browser.getViewport();
                    const [x, y] = denormalize(action.coordinate, viewport.width, viewport.height);
                    const count = action.clickCount || 1;
                    const countStr = count > 1 ? ` (x${count})` : '';
                    onStatusUpdate(`🖱️  Clicking at [${x}, ${y}]${countStr} (from ${action.coordinate})`);
                    const result = await browser.clickCoordinate(x, y, count);
                    await sleep(timing.actionSettleDelayMs);
                    return result;
                }
                return false;
            case 'hover':
                if (action.coordinate) {
                    const viewport = await browser.getViewport();
                    const [x, y] = denormalize(action.coordinate, viewport.width, viewport.height);
                    onStatusUpdate(`🖱️  Hovering at [${x}, ${y}]`);
                    await browser.hoverCoordinate(x, y);
                    await sleep(timing.actionSettleDelayMs);
                    return true;
                }
                return false;
            case 'hold':
                if (action.coordinate) {
                    const viewport = await browser.getViewport();
                    const [x, y] = denormalize(action.coordinate, viewport.width, viewport.height);
                    onStatusUpdate(`🖱️  Holding at [${x}, ${y}]`);
                    const result = await browser.holdCoordinate(x, y, 1200);
                    await sleep(timing.actionSettleDelayMs);
                    return result;
                }
                return false;
            case 'clear':
                if (action.coordinate) {
                    const viewport = await browser.getViewport();
                    const [x, y] = denormalize(action.coordinate, viewport.width, viewport.height);
                    onStatusUpdate(`🖱️  Clicking [${x}, ${y}] to focus before clearing`);
                    await browser.clickCoordinate(x, y);
                    await sleep(timing.actionSettleDelayMs);
                }
                onStatusUpdate('🧹 Clearing input...');
                await browser.clear();
                return true;
            case 'type':
                if (action.text) {
                    if (action.coordinate) {
                        const viewport = await browser.getViewport();
                        const [x, y] = denormalize(action.coordinate, viewport.width, viewport.height);
                        onStatusUpdate(`🖱️  Clicking [${x}, ${y}] to focus`);
                        await browser.clickCoordinate(x, y);
                        await sleep(timing.actionSettleDelayMs);
                    }
                    if (action.clearBefore) {
                        onStatusUpdate('🧹 Clearing input before typing...');
                        await browser.clear();
                        await sleep(timing.actionSettleDelayMs);
                    }
                    onStatusUpdate(`⌨️  Typing: "${action.text}"`);
                    await browser.type(action.text);
                    if (action.submit) {
                        onStatusUpdate('↵  Pressing Enter (Submit)');
                        await sleep(timing.actionSettleDelayMs);
                        await browser.pressKey('Enter');
                    }
                    await sleep(timing.actionSettleDelayMs);
                    return true;
                }
                return false;
            case 'key':
                if (action.key) {
                    onStatusUpdate(`⌨️  Pressing: ${action.key}`);
                    await browser.pressKey(action.key);
                    await sleep(timing.actionSettleDelayMs);
                    return true;
                }
                return false;
            case 'scroll':
                onStatusUpdate(`📜 Scrolling ${action.scrollDirection || 'down'}...`);
                await browser.scroll(action.scrollDirection || 'down');
                return true;
            case 'navigate':
                if (action.url) {
                    onStatusUpdate(`🌐 Navigating to: ${action.url}`);
                    await browser.navigate(action.url);
                    return true;
                }
                return false;
            case 'closeTab':
                onStatusUpdate('🗑️ Closing current tab...');
                await browser.closeCurrentTab();
                return true;
            case 'refresh':
                onStatusUpdate('🔄 Refreshing page...');
                await browser.reloadPage();
                return true;
            case 'wait':
                onStatusUpdate('⏳ Waiting...');
                await sleep(timing.waitActionDelayMs);
                return true;
            case 'goForward':
                onStatusUpdate('➡️ Going Forward...');
                await browser.goForward();
                return true;
            case 'goBack':
                onStatusUpdate('⬅️ Going Back...');
                await browser.goBack();
                return true;
            case 'getLink': {
                let linkToCopy = null;
                if (action.coordinate) {
                    const viewport = await browser.getViewport();
                    const [x, y] = denormalize(action.coordinate, viewport.width, viewport.height);
                    linkToCopy = await browser.getHrefAt(x, y);
                    onStatusUpdate(`🔗 Checked link at [${x}, ${y}]`);
                }
                if (!linkToCopy) {
                    linkToCopy = browser.getPageUrl();
                    onStatusUpdate(`🔗 Copying Page URL: ${linkToCopy}`);
                }
                else {
                    onStatusUpdate(`🔗 Copying Found Link: ${linkToCopy}`);
                }
                if (linkToCopy) {
                    clipboardOps.set(linkToCopy);
                    return true;
                }
                return false;
            }
            case 'pasteLink': {
                const content = clipboardOps.get();
                if (!content) {
                    onStatusUpdate("⚠️ Clipboard is empty! Use 'getLink' first.");
                    return false;
                }
                if (action.coordinate) {
                    const viewport = await browser.getViewport();
                    const [x, y] = denormalize(action.coordinate, viewport.width, viewport.height);
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
                await browser.type(content);
                return true;
            }
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onStatusUpdate(`⚠️ Action failed: ${message}`);
        return false;
    }
    return false;
}
