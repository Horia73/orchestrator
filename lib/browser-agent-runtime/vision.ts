/**
 * Gemini Vision Service
 * Uses smarter prompts with memory and history
 */

import { GoogleGenAI, MediaResolution, type GenerateContentConfig } from '@google/genai';
import { ActionTrace, BrowserDownloadFile, BrowserFrameSnapshot } from './browser';
import { buildSystemPrompt, buildMemoryContext, buildActionPrompt, buildInterruptPrompt, buildIterationLimitReviewPrompt, ActionHistoryItem, TabInfo, IterationLimitReview } from './prompts';
import { getMemories } from './memory';

export interface AgentAction {
    action: 'click' | 'type' | 'key' | 'scroll' | 'scrollToBottom' | 'undo' | 'wait' | 'navigate' | 'hold' | 'drag' | 'hover' | 'inspectPage' | 'findInPage' | 'inspectDiagnostics' | 'fetchUrl' | 'screenshot' | 'recordVideo' | 'closeTab' | 'refresh' | 'getLink' | 'pasteLink' | 'readClipboard' | 'clear' | 'done' | 'ask' | 'goBack' | 'goForward' | 'listTabs' | 'switchTab' | 'newTab' | 'listDownloads' | 'waitForDownloads' | 'error' | 'escalate' | 'yield_control';
    sub_objective?: string; // Goal string when escalating task to advanced reasoning model
    coordinate?: [number, number]; // [x, y]
    coordinateEnd?: [number, number]; // [x, y] — end point for drag action
    text?: string;
    submit?: boolean;
    clearBefore?: boolean; // If true, select all and delete before typing
    clickCount?: number; // Allowed to be any number, default 1
    key?: 'Enter' | 'Escape' | 'Tab' | 'Backspace';
    scrollDirection?: 'up' | 'down' | 'left' | 'right';
    scrollAmount?: number;
    url?: string;
    tabIndex?: number;
    reasoning: string;
    memory?: string; // What we learned from this step (e.g. "To clear input, click then Ctrl+A+Backspace")
    durationMs?: number; // Duration in milliseconds for wait, hold, drag, and recordVideo actions
    expectedFilename?: string; // Optional filename substring for download verification
}

export interface VisionConfig {
    model: string;
    thinkingLevel: 'minimal' | 'low' | 'medium' | 'high';
    mediaResolution: 'low' | 'medium' | 'high';
}

export interface VisionUsage {
    model: string;
    promptTokens: number;
    outputTokens: number;
    thoughtsTokens: number;
    totalTokens: number;
}

export interface VisionService {
    analyzeScreenshot(
        frame: BrowserFrameSnapshot,
        goal: string,
        actionHistory: ActionHistoryItem[],
        conversationHistory: string[],
        recentTrace?: ActionTrace | null,
        supplementalFrames?: BrowserFrameSnapshot[],
        isInterrupt?: boolean,
        openTabs?: TabInfo[],
        isAdvancedMode?: boolean,
        downloads?: BrowserDownloadFile[],
        escalationEnabled?: boolean
    ): Promise<AgentAction[]>;
    reflectOnIterationLimit(
        frame: BrowserFrameSnapshot,
        goal: string,
        actionHistory: ActionHistoryItem[],
        conversationHistory: string[],
        recentTrace?: ActionTrace | null,
        supplementalFrames?: BrowserFrameSnapshot[],
        openTabs?: TabInfo[],
        downloads?: BrowserDownloadFile[]
    ): Promise<IterationLimitReview | null>;
    updateConfig(patch: Partial<VisionConfig>): void;
    getConfig(): VisionConfig;
}

function sanitizeThinkingLevel(value: unknown): VisionConfig['thinkingLevel'] | '' {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
        return normalized;
    }
    return '';
}

function buildThinkingConfig(explicitLevel?: unknown): { thinkingLevel: VisionConfig['thinkingLevel'] } {
    const thinkingLevel = sanitizeThinkingLevel(explicitLevel);
    return {
        thinkingLevel: thinkingLevel || 'minimal',
    };
}

function sanitizeMediaResolution(value: unknown): VisionConfig['mediaResolution'] | '' {
    const normalized = String(value || '').trim().toLowerCase().replace(/^media[_-]resolution[_-]/, '');
    if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
        return normalized;
    }
    return '';
}

function toGeminiMediaResolution(level: VisionConfig['mediaResolution']): MediaResolution {
    switch (level) {
        case 'low':
            return MediaResolution.MEDIA_RESOLUTION_LOW;
        case 'high':
            return MediaResolution.MEDIA_RESOLUTION_HIGH;
        case 'medium':
        default:
            return MediaResolution.MEDIA_RESOLUTION_MEDIUM;
    }
}

function isThinkingCompatError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /thinking/i.test(message) && /(not supported|invalid)/i.test(message);
}

function isMediaResolutionCompatError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /media[_\s-]?resolution/i.test(message) && /(not supported|invalid|unknown|unrecognized)/i.test(message);
}

function buildRequestConfig(state: VisionConfig, systemInstruction?: string): GenerateContentConfig {
    return {
        thinkingConfig: buildThinkingConfig(state.thinkingLevel),
        mediaResolution: toGeminiMediaResolution(state.mediaResolution),
        // The static system prompt is sent as a separate systemInstruction so it
        // forms a byte-stable, cacheable prefix across the ~50 calls of a segment
        // (implicit context caching), instead of being concatenated with the
        // dynamic per-step content where it could never be cached.
        ...(systemInstruction ? { systemInstruction } : {}),
    } as unknown as GenerateContentConfig;
}

async function generateContentWithFallback(
    ai: GoogleGenAI,
    model: string,
    state: VisionConfig,
    requestParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>,
    systemInstruction?: string,
) {
    const request = (config: GenerateContentConfig) => ai.models.generateContent({
        model,
        config,
        contents: [
            {
                role: 'user',
                parts: requestParts,
            },
        ],
    });

    const initialConfig = buildRequestConfig(state, systemInstruction);

    try {
        return await request(initialConfig);
    } catch (error) {
        if (!isThinkingCompatError(error) && !isMediaResolutionCompatError(error)) {
            throw error;
        }

        const fallbackConfig: Partial<GenerateContentConfig> = { ...initialConfig };
        if (isThinkingCompatError(error)) {
            delete fallbackConfig.thinkingConfig;
        }
        if (isMediaResolutionCompatError(error)) {
            delete fallbackConfig.mediaResolution;
        }

        try {
            return await request(fallbackConfig as GenerateContentConfig);
        } catch (fallbackError) {
            const retryConfig: Partial<GenerateContentConfig> = { ...fallbackConfig };
            let shouldRetry = false;
            if (retryConfig.thinkingConfig && isThinkingCompatError(fallbackError)) {
                delete retryConfig.thinkingConfig;
                shouldRetry = true;
            }
            if (retryConfig.mediaResolution && isMediaResolutionCompatError(fallbackError)) {
                delete retryConfig.mediaResolution;
                shouldRetry = true;
            }
            if (shouldRetry) {
                return request(retryConfig as GenerateContentConfig);
            }
            throw fallbackError;
        }
    }
}

function extractUsage(rawUsage: unknown): Omit<VisionUsage, 'model'> {
    const usage = rawUsage && typeof rawUsage === 'object'
        ? rawUsage as Record<string, unknown>
        : {};
    const promptTokens = Number(usage.promptTokenCount) || 0;
    const outputTokens = Number(usage.candidatesTokenCount) || 0;
    const thoughtsTokens = Number(usage.thoughtsTokenCount) || 0;
    const totalTokens = Number(usage.totalTokenCount) || (promptTokens + outputTokens + thoughtsTokens);
    return {
        promptTokens,
        outputTokens,
        thoughtsTokens,
        totalTokens,
    };
}

function getUsageMetadata(response: unknown): unknown {
    if (!response || typeof response !== 'object') return undefined;
    return (response as { usageMetadata?: unknown }).usageMetadata;
}

function buildVisionParts(
    leadingContext: string,
    historyContext: string,
    actionPrompt: string,
    frame: BrowserFrameSnapshot,
    recentTrace: ActionTrace | null | undefined,
    supplementalFrames: BrowserFrameSnapshot[] = [],
): Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> {
    const orderedFrames = recentTrace?.frames?.length
        ? [...recentTrace.frames, ...supplementalFrames, frame]
        : [...supplementalFrames, frame];
    const hasOverviewFrame = orderedFrames.some((candidate) => candidate.captureMode === 'overview');

    const visualContextLines = recentTrace?.frames?.length
        ? [
            '\n## 🎞️ VISUAL INPUT',
            `You are receiving ${orderedFrames.length} frames ordered oldest to newest.`,
            `- Frames 1-${recentTrace.frames.length} show the recent ${recentTrace.action} sampled roughly every ${recentTrace.intervalMs}ms.`,
            '- Later frames may include supplemental overview captures for orientation.',
            '- The final frame is always the current viewport and is the ONLY frame you may use for output coordinates.',
            '- Use earlier frames to understand motion, page layout, transient UI changes, loaders, progress, or where content sits on the full page.',
        ]
        : [
            '\n## 🖼️ VISUAL INPUT',
            orderedFrames.length > 1
                ? `You are receiving ${orderedFrames.length} frames ordered oldest to newest.`
                : 'You are receiving one current frame of the page.',
            '- The final frame is always the current viewport and is the ONLY frame you may use for output coordinates.',
        ];

    if (!recentTrace?.frames?.length && orderedFrames.length > 1) {
        visualContextLines.push('- Earlier frames may show the previous viewport before the latest tab/navigation context change. Use them as visual memory, not for coordinates.');
    }

    if (hasOverviewFrame) {
        visualContextLines.push('- Frames marked `Capture: overview` show the full page for orientation only. Use them to decide where to scroll, not where to click.');
    }

    const traceContext = `${visualContextLines.join('\n')}\n`;

    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
        { text: leadingContext + historyContext + traceContext },
    ];

    orderedFrames.forEach((currentFrame, index) => {
        const label = 'label' in currentFrame
            ? currentFrame.label
            : index === orderedFrames.length - 1 && orderedFrames.length > 1
                ? 'current-frame'
                : currentFrame.captureMode === 'overview'
                    ? 'overview-frame'
                    : orderedFrames.length > 1
                        ? 'previous-frame'
                        : 'page-frame';
        parts.push({
            text: `Frame ${index + 1}/${orderedFrames.length}: ${label}\nURL: ${currentFrame.url}\nCapture: ${currentFrame.captureMode}\nCoordinate space: ${currentFrame.coordinateSpace ?? 'normalized-viewport'}\nViewport: ${currentFrame.viewport.width}x${currentFrame.viewport.height}\nPage: ${currentFrame.page.width}x${currentFrame.page.height}\nScroll: ${currentFrame.page.scrollX}, ${currentFrame.page.scrollY}\nTimestamp: ${currentFrame.timestamp}`,
        });
        parts.push({
            inlineData: {
                mimeType: 'image/jpeg',
                data: currentFrame.imageBase64,
            },
        });
    });

    parts.push({ text: actionPrompt });
    return parts;
}

function extractFirstBalancedJson(text: string): string | null {
    const firstBracket = text.indexOf('[');
    const firstBrace = text.indexOf('{');
    let start = -1;

    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
        start = firstBracket;
    } else if (firstBrace !== -1) {
        start = firstBrace;
    }

    if (start < 0) return null;

    const stack: string[] = [];
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index++) {
        const char = text[index];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }

        if (char === '{') {
            stack.push('}');
            continue;
        }

        if (char === '[') {
            stack.push(']');
            continue;
        }

        if (char === '}' || char === ']') {
            const expected = stack.pop();
            if (expected !== char) return null;
            if (stack.length === 0) {
                return text.slice(start, index + 1).trim();
            }
        }
    }

    return null;
}

function extractJsonText(text: string): string {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (jsonMatch) {
        const fenced = jsonMatch[1].trim();
        return extractFirstBalancedJson(fenced) || fenced;
    }

    return extractFirstBalancedJson(text) || text.trim();
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 5);
}

export function createVisionService(
    initialConfig: Partial<VisionConfig> = {},
    onUsage?: (usage: VisionUsage) => void
): VisionService {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        throw new Error(
            'GEMINI_API_KEY environment variable is required.\n' +
            'Get your key from: https://aistudio.google.com/apikey'
        );
    }

    const ai = new GoogleGenAI({ apiKey });
    const state: VisionConfig = {
        model: initialConfig.model || 'gemini-3-flash-preview',
        thinkingLevel: sanitizeThinkingLevel(initialConfig.thinkingLevel) || 'minimal',
        mediaResolution: sanitizeMediaResolution(initialConfig.mediaResolution) || 'medium',
    };

    const service: VisionService = {
        updateConfig(patch: Partial<VisionConfig>) {
            if (!patch || typeof patch !== 'object') return;

            if (typeof patch.model === 'string' && patch.model.trim()) {
                state.model = patch.model.trim();
            }
            if (typeof patch.thinkingLevel === 'string' && patch.thinkingLevel.trim()) {
                state.thinkingLevel = sanitizeThinkingLevel(patch.thinkingLevel) || state.thinkingLevel;
            }
            if (typeof patch.mediaResolution === 'string' && patch.mediaResolution.trim()) {
                state.mediaResolution = sanitizeMediaResolution(patch.mediaResolution) || state.mediaResolution;
            }
        },

        getConfig(): VisionConfig {
            return {
                model: state.model,
                thinkingLevel: state.thinkingLevel,
                mediaResolution: state.mediaResolution,
            };
        },

        async analyzeScreenshot(
            frame: BrowserFrameSnapshot,
            goal: string,
            actionHistory: ActionHistoryItem[],
            conversationHistory: string[] = [],
            recentTrace: ActionTrace | null = null,
            supplementalFrames: BrowserFrameSnapshot[] = [],
            isInterrupt = false,
            openTabs: TabInfo[] = [],
            isAdvancedMode: boolean = false,
            downloads: BrowserDownloadFile[] = [],
            escalationEnabled: boolean = true
        ): Promise<AgentAction[]> {
            // Static instructions → cacheable systemInstruction (stable across the segment).
            const systemPrompt = buildSystemPrompt(isAdvancedMode, frame.coordinateSpace, escalationEnabled);
            // Dynamic per-session memories (semantic + procedural) → user content.
            const memoryContext = buildMemoryContext(getMemories(frame.url, goal));

            const actionPrompt = isInterrupt
                ? buildInterruptPrompt(goal)
                : buildActionPrompt(goal, actionHistory, openTabs, downloads, escalationEnabled);

            try {
                // Add conversation history context
                const historyContext = conversationHistory.length > 0
                    ? `\n## 📜 CONVERSATION HISTORY (Context):\n${conversationHistory.join('\n')}\n`
                    : '';
                const requestParts = buildVisionParts(memoryContext, historyContext, actionPrompt, frame, recentTrace, supplementalFrames);

                const response = await generateContentWithFallback(ai, state.model, state, requestParts, systemPrompt);

                const usage = extractUsage(getUsageMetadata(response));
                if (typeof onUsage === 'function') {
                    onUsage({
                        model: state.model,
                        ...usage,
                    });
                }

                const text = response.text?.trim() || '';
                const jsonText = extractJsonText(text);

                const validActions = ['click', 'type', 'key', 'scroll', 'scrollToBottom', 'undo', 'wait', 'navigate', 'hold', 'drag', 'hover', 'inspectPage', 'findInPage', 'inspectDiagnostics', 'fetchUrl', 'screenshot', 'recordVideo', 'closeTab', 'refresh', 'getLink', 'pasteLink', 'readClipboard', 'clear', 'done', 'ask', 'error', 'goBack', 'goForward', 'listTabs', 'switchTab', 'newTab', 'listDownloads', 'waitForDownloads', 'escalate', 'yield_control'];

                const parsed = JSON.parse(jsonText);
                const actions: AgentAction[] = Array.isArray(parsed) ? parsed : [parsed];

                // Validate all actions
                for (const action of actions) {
                    if (!action.action) {
                        throw new Error('Missing action field');
                    }
                    if (!validActions.includes(action.action)) {
                        throw new Error(`Invalid action: ${action.action}`);
                    }
                }

                return actions;
            } catch (error) {
                console.error('Vision API error:', error);
                return [{
                    action: 'error',
                    reasoning: `API Error: ${error instanceof Error ? error.message : 'Unknown'}`,
                }];
            }
        },

        async reflectOnIterationLimit(
            frame: BrowserFrameSnapshot,
            goal: string,
            actionHistory: ActionHistoryItem[],
            conversationHistory: string[] = [],
            recentTrace: ActionTrace | null = null,
            supplementalFrames: BrowserFrameSnapshot[] = [],
            openTabs: TabInfo[] = [],
            downloads: BrowserDownloadFile[] = []
        ): Promise<IterationLimitReview | null> {
            try {
                const reviewPrompt = buildIterationLimitReviewPrompt(goal, actionHistory, openTabs, downloads);
                const historyContext = conversationHistory.length > 0
                    ? `\n## 📜 CONVERSATION HISTORY (Context):\n${conversationHistory.join('\n')}\n`
                    : '';
                const requestParts = buildVisionParts('', historyContext, reviewPrompt, frame, recentTrace, supplementalFrames);

                const response = await generateContentWithFallback(ai, state.model, state, requestParts);

                const usage = extractUsage(getUsageMetadata(response));
                if (typeof onUsage === 'function') {
                    onUsage({
                        model: state.model,
                        ...usage,
                    });
                }

                const text = response.text?.trim() || '';
                const jsonText = extractJsonText(text);
                const parsed = JSON.parse(jsonText) as Partial<IterationLimitReview>;

                return {
                    whyNotFinished: String(parsed.whyNotFinished || '').trim(),
                    stuckPoint: String(parsed.stuckPoint || '').trim(),
                    whySelfRecoveryFailed: String(parsed.whySelfRecoveryFailed || '').trim(),
                    humanAssessment: String(parsed.humanAssessment || '').trim(),
                    missingToolsOrCapabilities: normalizeStringArray(parsed.missingToolsOrCapabilities),
                    hardParts: normalizeStringArray(parsed.hardParts),
                    easyParts: normalizeStringArray(parsed.easyParts),
                    futureStrategy: normalizeStringArray(parsed.futureStrategy),
                    questionsForUser: normalizeStringArray(parsed.questionsForUser),
                };
            } catch (error) {
                console.error('Vision iteration-limit reflection error:', error);
                return null;
            }
        },
    };

    return service;
}
