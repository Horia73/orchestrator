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
    const enableModelAutoEscalation = options.enableModelAutoEscalation ?? true;
    const escalationModel = String(options.escalationModel ?? 'gemini-3.1-pro-preview').trim() || 'gemini-3.1-pro-preview';
    const escalationThinkingLevel = String(options.escalationThinkingLevel ?? 'medium').trim() || 'medium';
    const escalationFailureThreshold = Number.isFinite(Number(options.escalationFailureThreshold))
        ? Math.max(1, Math.trunc(Number(options.escalationFailureThreshold)))
        : 3;
    const deescalationSuccessThreshold = Number.isFinite(Number(options.deescalationSuccessThreshold))
        ? Math.max(1, Math.trunc(Number(options.deescalationSuccessThreshold)))
        : 2;
    let currentGoal = null;
    let running = false;
    let shouldStop = false;
    let isInterrupt = false;
    let actionHistory = [];
    let conversationHistory = [];
    let clipboard = null;
    let availableUploads = [];
    let baseVisionModel = '';
    let baseVisionThinkingLevel = '';
    let modelEscalated = false;
    let consecutiveActionFailures = 0;
    let boostedSuccessStreak = 0;
    let consecutiveVisionErrors = 0;
    initializeDefaultLearnings();
    const normalizeUploadDescriptors = (uploadFiles = []) => (Array.isArray(uploadFiles) ? uploadFiles : [])
        .map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
            return null;
        }
        const absolutePath = String(entry.absolutePath ?? '').trim();
        if (!absolutePath) {
            return null;
        }
        const uploadId = String(entry.uploadId ?? entry.id ?? '').trim() || `upload-${index + 1}`;
        const name = String(entry.name ?? '').trim() || absolutePath.split('/').pop() || uploadId;
        const mimeType = String(entry.mimeType ?? '').trim() || 'application/octet-stream';
        return {
            uploadId,
            name,
            mimeType,
            absolutePath,
        };
    })
        .filter(Boolean);
    const resolveUploadPathsFromAction = (action) => {
        const requestedRefs = [];
        if (Array.isArray(action?.files)) {
            for (const rawRef of action.files) {
                const normalized = String(rawRef ?? '').trim();
                if (normalized) {
                    requestedRefs.push(normalized);
                }
            }
        }
        if (Array.isArray(action?.filePaths)) {
            for (const rawRef of action.filePaths) {
                const normalized = String(rawRef ?? '').trim();
                if (normalized) {
                    requestedRefs.push(normalized);
                }
            }
        }
        const uniqueRequested = [...new Set(requestedRefs.map((ref) => ref.toLowerCase()))];
        if (uniqueRequested.length === 0) {
            if (availableUploads.length === 1) {
                return [availableUploads[0].absolutePath];
            }
            return [];
        }
        const resolvedPaths = [];
        for (const upload of availableUploads) {
            const candidates = [
                upload.uploadId,
                upload.name,
                upload.absolutePath,
            ]
                .map((value) => String(value ?? '').trim().toLowerCase())
                .filter(Boolean);
            if (candidates.some((candidate) => uniqueRequested.includes(candidate))) {
                resolvedPaths.push(upload.absolutePath);
            }
        }
        return [...new Set(resolvedPaths)];
    };
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
            availableUploads = normalizeUploadDescriptors(taskOptions.uploadFiles);
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
                const currentVisionConfig = vision.getConfig?.() ?? {};
                baseVisionModel = String(currentVisionConfig.model ?? '').trim();
                baseVisionThinkingLevel = String(currentVisionConfig.thinkingLevel ?? '').trim();
            }
            catch {
                baseVisionModel = '';
                baseVisionThinkingLevel = '';
            }
            modelEscalated = false;
            consecutiveActionFailures = 0;
            boostedSuccessStreak = 0;
            consecutiveVisionErrors = 0;
            const getOpenTabCountSafe = async () => {
                try {
                    return await browser.getOpenTabCount();
                }
                catch {
                    return 0;
                }
            };
            const tryEscalateModel = () => {
                if (!enableModelAutoEscalation || modelEscalated || consecutiveActionFailures < escalationFailureThreshold) {
                    return;
                }

                try {
                    const currentVisionConfig = vision.getConfig?.() ?? {};
                    const currentModel = String(currentVisionConfig.model ?? '').trim();
                    if (currentModel === escalationModel) {
                        modelEscalated = true;
                        boostedSuccessStreak = 0;
                        onStatusUpdate(`⬆️ Browser AI escalation active on ${escalationModel}.`);
                        return;
                    }

                    onStatusUpdate(`⬆️ Repeated failures detected. Escalating to ${escalationModel} temporarily.`);
                    vision.updateConfig({
                        model: escalationModel,
                        thinkingLevel: escalationThinkingLevel,
                    });
                    modelEscalated = true;
                    boostedSuccessStreak = 0;
                }
                catch {
                    // Ignore escalation issues and continue with current model.
                }
            };
            const restoreBaseModel = (reasonMessage = '') => {
                if (!modelEscalated) {
                    return;
                }

                try {
                    if (baseVisionModel || baseVisionThinkingLevel) {
                        const patch = {};
                        if (baseVisionModel) {
                            patch.model = baseVisionModel;
                        }
                        if (baseVisionThinkingLevel) {
                            patch.thinkingLevel = baseVisionThinkingLevel;
                        }
                        vision.updateConfig(patch);
                    }
                }
                catch {
                    // Best effort only.
                }

                modelEscalated = false;
                consecutiveActionFailures = 0;
                boostedSuccessStreak = 0;
                consecutiveVisionErrors = 0;
                if (reasonMessage) {
                    onStatusUpdate(reasonMessage);
                }
            };
            const tryDeescalateModel = () => {
                if (!modelEscalated || boostedSuccessStreak < deescalationSuccessThreshold) {
                    return;
                }

                restoreBaseModel(`⬇️ Browser AI stabilized. Restoring default model${baseVisionModel ? ` (${baseVisionModel})` : ''}.`);
            };
            try {
                let iterationCount = 0;
                while (!shouldStop && currentGoal && iterationCount < maxIterations) {
                    iterationCount++;
                    const preActionUrl = browser.getPageUrl();
                    const preActionOpenTabs = await getOpenTabCountSafe();
                    onStatusUpdate('📸 Scanning page...');
                    const screenshot = await browser.screenshot();
                    onStatusUpdate('🤖 AI deciding...');
                    const action = await vision.analyzeScreenshot(
                        screenshot,
                        currentGoal,
                        actionHistory,
                        conversationHistory,
                        isInterrupt,
                        {
                            currentUrl: preActionUrl,
                            openTabs: preActionOpenTabs,
                            availableUploads: availableUploads.map((upload) => ({
                                id: upload.uploadId,
                                name: upload.name,
                                mimeType: upload.mimeType,
                            })),
                        },
                    );
                    isInterrupt = false;
                    if (action.memory) {
                        onStatusUpdate(`💡 Saving memory: "${action.memory}"`);
                        const currentUrl = browser.getPageUrl();
                        addLearning(action.memory, currentUrl || 'general');
                    }
                    if (action.action === 'done') {
                        restoreBaseModel();
                        onStatusUpdate(`✅ Complete: ${action.reasoning}`);
                        pushConversationHistory(`AGENT: ✅ Completed goal "${currentGoal}". Reason: ${action.reasoning}`);
                        currentGoal = null;
                        break;
                    }
                    if (action.action === 'ask') {
                        restoreBaseModel();
                        onStatusUpdate(`❓ QUESTION: ${action.reasoning}`);
                        const askAfterUrl = browser.getPageUrl();
                        const askAfterTabs = await getOpenTabCountSafe();
                        actionHistory.push({
                            action: 'ask',
                            coordinate: action.coordinate,
                            text: action.text,
                            reasoning: action.reasoning,
                            success: true,
                            beforeUrl: preActionUrl,
                            afterUrl: askAfterUrl,
                            beforeTabs: preActionOpenTabs,
                            afterTabs: askAfterTabs,
                            tabDelta: askAfterTabs - preActionOpenTabs,
                            urlChanged: preActionUrl !== askAfterUrl,
                        });
                        break;
                    }
                    if (action.action === 'error') {
                        consecutiveVisionErrors += 1;
                        consecutiveActionFailures += 1;
                        boostedSuccessStreak = 0;
                        tryEscalateModel();

                        if (modelEscalated && consecutiveVisionErrors <= 2) {
                            onStatusUpdate(`⚠️ Vision step failed. Retrying with escalated model (${escalationModel})...`);
                            await sleep(stepDelayMs);
                            continue;
                        }

                        restoreBaseModel();
                        onStatusUpdate(`🛑 ${action.reasoning}`);
                        pushConversationHistory(`AGENT: 🛑 Failed. Reason: ${action.reasoning}`);
                        currentGoal = null;
                        break;
                    }
                    consecutiveVisionErrors = 0;
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
                    }, {
                        availableUploads,
                        resolveUploadPathsFromAction,
                    });
                    const postActionUrl = browser.getPageUrl();
                    const postActionOpenTabs = await getOpenTabCountSafe();
                    actionHistory.push({
                        action: action.action,
                        coordinate: action.coordinate,
                        text: action.text,
                        submit: action.submit,
                        clickCount: action.clickCount,
                        reasoning: action.reasoning,
                        success,
                        beforeUrl: preActionUrl,
                        afterUrl: postActionUrl,
                        beforeTabs: preActionOpenTabs,
                        afterTabs: postActionOpenTabs,
                        tabDelta: postActionOpenTabs - preActionOpenTabs,
                        urlChanged: preActionUrl !== postActionUrl,
                        files: Array.isArray(action?.files) ? action.files : undefined,
                    });
                    if (success) {
                        consecutiveActionFailures = 0;
                        if (modelEscalated) {
                            boostedSuccessStreak += 1;
                            tryDeescalateModel();
                        }
                    }
                    else {
                        consecutiveActionFailures += 1;
                        boostedSuccessStreak = 0;
                        tryEscalateModel();
                    }
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
                if (modelEscalated) {
                    try {
                        const patch = {};
                        if (baseVisionModel) {
                            patch.model = baseVisionModel;
                        }
                        if (baseVisionThinkingLevel) {
                            patch.thinkingLevel = baseVisionThinkingLevel;
                        }
                        if (Object.keys(patch).length > 0) {
                            vision.updateConfig(patch);
                        }
                    }
                    catch {
                        // ignore restore errors at shutdown
                    }
                    modelEscalated = false;
                }
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
            if (clearCurrentGoal) {
                availableUploads = [];
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
        case 'upload': {
            const files = Array.isArray(action.files) ? action.files.join(', ') : '';
            const coords = action.coordinate ? ` at [${action.coordinate[0]}, ${action.coordinate[1]}]` : '';
            return `Upload${coords}${files ? ` files: ${files}` : ''} - ${action.reasoning}`;
        }
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
async function executeAction(browser, action, onStatusUpdate, clipboardOps, timing, extras = {}) {
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
            case 'upload': {
                const resolver = typeof extras.resolveUploadPathsFromAction === 'function'
                    ? extras.resolveUploadPathsFromAction
                    : () => [];
                const resolvedPaths = resolver(action);
                if (resolvedPaths.length === 0) {
                    const available = Array.isArray(extras.availableUploads) ? extras.availableUploads : [];
                    const availableHint = available.length > 0
                        ? available.map((item) => item.name).join(', ')
                        : '(none)';
                    onStatusUpdate(`⚠️ Upload failed: no matching files found. Available uploads: ${availableHint}`);
                    return false;
                }

                onStatusUpdate(`📤 Uploading ${resolvedPaths.length} file(s)...`);
                if (action.coordinate) {
                    const viewport = await browser.getViewport();
                    const [x, y] = denormalize(action.coordinate, viewport.width, viewport.height);
                    const successAtPoint = await browser.setFilesAtCoordinate(x, y, resolvedPaths);
                    if (successAtPoint) {
                        await sleep(timing.actionSettleDelayMs);
                        return true;
                    }
                }

                const successFallback = await browser.setFilesOnFirstInput(resolvedPaths);
                if (successFallback) {
                    await sleep(timing.actionSettleDelayMs);
                }
                return successFallback;
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
