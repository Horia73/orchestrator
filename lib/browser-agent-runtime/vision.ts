/**
 * Gemini Vision Service
 * Uses smarter prompts with memory and history
 */

import { GoogleGenAI, MediaResolution, type GenerateContentConfig } from '@google/genai';
import { ActionTrace, BrowserDownloadFile, BrowserFrameSnapshot } from './browser';
import { buildSystemPrompt, buildMemoryContext, buildActionPrompt, buildInterruptPrompt, buildIterationLimitReviewPrompt, ActionHistoryItem, TabInfo, IterationLimitReview } from './prompts';
import { getMemories } from './memory';
import { redactBrowserAgentText } from './redaction';

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

type VisionRequestPart = { text?: string; inlineData?: { mimeType: string; data: string } };
type VisionGenerateResponse = { text?: string; usageMetadata?: unknown };

const MAX_JSON_PARSE_RETRIES = 3;
const MAX_MODEL_RESPONSE_LOG_CHARS = 1000;

const VALID_ACTIONS = ['click', 'type', 'key', 'scroll', 'scrollToBottom', 'undo', 'wait', 'navigate', 'hold', 'drag', 'hover', 'inspectPage', 'findInPage', 'inspectDiagnostics', 'fetchUrl', 'screenshot', 'recordVideo', 'closeTab', 'refresh', 'getLink', 'pasteLink', 'readClipboard', 'clear', 'done', 'ask', 'error', 'goBack', 'goForward', 'listTabs', 'switchTab', 'newTab', 'listDownloads', 'waitForDownloads', 'escalate', 'yield_control'] as const satisfies readonly AgentAction['action'][];
const VALID_ACTION_SET = new Set<string>(VALID_ACTIONS);

const COORDINATE_JSON_SCHEMA = {
    type: 'array',
    items: { type: 'number' },
    minItems: 2,
    maxItems: 2,
} as const;

const BROWSER_ACTION_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        action: { type: 'string', enum: [...VALID_ACTIONS] },
        sub_objective: { type: 'string' },
        coordinate: COORDINATE_JSON_SCHEMA,
        coordinateEnd: COORDINATE_JSON_SCHEMA,
        text: { type: 'string' },
        submit: { type: 'boolean' },
        clearBefore: { type: 'boolean' },
        clickCount: { type: 'integer', minimum: 1 },
        key: { type: 'string', enum: ['Enter', 'Escape', 'Tab', 'Backspace'] },
        scrollDirection: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scrollAmount: { type: 'integer', minimum: 1 },
        url: { type: 'string' },
        tabIndex: { type: 'integer', minimum: 0 },
        reasoning: { type: 'string' },
        memory: { type: 'string' },
        durationMs: { type: 'integer', minimum: 1 },
        expectedFilename: { type: 'string' },
    },
    required: ['action', 'reasoning'],
    propertyOrdering: ['action', 'coordinate', 'coordinateEnd', 'clickCount', 'text', 'submit', 'clearBefore', 'key', 'scrollDirection', 'scrollAmount', 'url', 'tabIndex', 'durationMs', 'expectedFilename', 'sub_objective', 'reasoning', 'memory'],
} as const;

const BROWSER_ACTION_RESPONSE_JSON_SCHEMA = {
    anyOf: [
        BROWSER_ACTION_JSON_SCHEMA,
        {
            type: 'array',
            items: BROWSER_ACTION_JSON_SCHEMA,
            minItems: 1,
            maxItems: 8,
        },
    ],
} as const;

const STRING_ARRAY_JSON_SCHEMA = {
    type: 'array',
    items: { type: 'string' },
    maxItems: 5,
} as const;

const ITERATION_LIMIT_REVIEW_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        whyNotFinished: { type: 'string' },
        stuckPoint: { type: 'string' },
        whySelfRecoveryFailed: { type: 'string' },
        humanAssessment: { type: 'string' },
        missingToolsOrCapabilities: STRING_ARRAY_JSON_SCHEMA,
        hardParts: STRING_ARRAY_JSON_SCHEMA,
        easyParts: STRING_ARRAY_JSON_SCHEMA,
        futureStrategy: STRING_ARRAY_JSON_SCHEMA,
        questionsForUser: STRING_ARRAY_JSON_SCHEMA,
    },
    required: [
        'whyNotFinished',
        'stuckPoint',
        'whySelfRecoveryFailed',
        'humanAssessment',
        'missingToolsOrCapabilities',
        'hardParts',
        'easyParts',
        'futureStrategy',
        'questionsForUser',
    ],
    propertyOrdering: [
        'whyNotFinished',
        'stuckPoint',
        'whySelfRecoveryFailed',
        'humanAssessment',
        'missingToolsOrCapabilities',
        'hardParts',
        'easyParts',
        'futureStrategy',
        'questionsForUser',
    ],
} as const;

class ModelOutputParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ModelOutputParseError';
    }
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

function isStructuredOutputCompatError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /(response[_\s-]?(mime|schema|json)|responseMimeType|responseJsonSchema|application\/json|structured output)/i.test(message)
        && /(not supported|unsupported|invalid|unknown|unrecognized|must|expected|schema)/i.test(message);
}

function stripIncompatibleConfig(config: GenerateContentConfig, error: unknown): { config: GenerateContentConfig; changed: boolean } {
    const next: Partial<GenerateContentConfig> = { ...config };
    let changed = false;

    if (next.thinkingConfig && isThinkingCompatError(error)) {
        delete next.thinkingConfig;
        changed = true;
    }
    if (next.mediaResolution && isMediaResolutionCompatError(error)) {
        delete next.mediaResolution;
        changed = true;
    }
    if ((next.responseMimeType || next.responseSchema || next.responseJsonSchema) && isStructuredOutputCompatError(error)) {
        delete next.responseMimeType;
        delete next.responseSchema;
        delete next.responseJsonSchema;
        changed = true;
    }

    return { config: next as GenerateContentConfig, changed };
}

interface GenerateContentOptions {
    systemInstruction?: string;
    responseJsonSchema?: unknown;
}

function buildRequestConfig(state: VisionConfig, options: GenerateContentOptions = {}): GenerateContentConfig {
    return {
        thinkingConfig: buildThinkingConfig(state.thinkingLevel),
        mediaResolution: toGeminiMediaResolution(state.mediaResolution),
        ...(options.responseJsonSchema ? {
            responseMimeType: 'application/json',
            responseJsonSchema: options.responseJsonSchema,
        } : {}),
        // The static system prompt is sent as a separate systemInstruction so it
        // forms a byte-stable, cacheable prefix across the ~50 calls of a segment
        // (implicit context caching), instead of being concatenated with the
        // dynamic per-step content where it could never be cached.
        ...(options.systemInstruction ? { systemInstruction: options.systemInstruction } : {}),
    } as unknown as GenerateContentConfig;
}

async function generateContentWithFallback(
    ai: GoogleGenAI,
    model: string,
    state: VisionConfig,
    requestParts: VisionRequestPart[],
    options: GenerateContentOptions = {},
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

    let config = buildRequestConfig(state, options);
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            return await request(config);
        } catch (error) {
            const fallback = stripIncompatibleConfig(config, error);
            if (!fallback.changed) {
                throw error;
            }
            lastError = error;
            config = fallback.config;
        }
    }

    throw lastError instanceof Error ? lastError : new Error('Gemini request failed after config compatibility fallbacks.');
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

function parseJsonFromModelText(text: string): unknown {
    const jsonText = extractJsonText(text);
    try {
        return JSON.parse(jsonText) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown parse error';
        throw new ModelOutputParseError(`Invalid JSON: ${message}`);
    }
}

function parseAgentActionsFromModelText(text: string): AgentAction[] {
    const parsed = parseJsonFromModelText(text);
    const actions = Array.isArray(parsed) ? parsed : [parsed];

    if (actions.length === 0) {
        throw new ModelOutputParseError('Browser action response must contain at least one action.');
    }

    for (const action of actions) {
        if (!action || typeof action !== 'object' || Array.isArray(action)) {
            throw new ModelOutputParseError('Browser action response must be an object or an array of objects.');
        }

        const record = action as Record<string, unknown>;
        if (typeof record.action !== 'string') {
            throw new ModelOutputParseError('Browser action is missing a string action field.');
        }
        if (!VALID_ACTION_SET.has(record.action)) {
            throw new ModelOutputParseError(`Invalid browser action: ${record.action}`);
        }
        if (typeof record.reasoning !== 'string') {
            throw new ModelOutputParseError('Browser action is missing a string reasoning field.');
        }
    }

    return actions as AgentAction[];
}

function parseIterationLimitReviewFromModelText(text: string): Partial<IterationLimitReview> {
    const parsed = parseJsonFromModelText(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ModelOutputParseError('Iteration-limit review response must be a JSON object.');
    }
    return parsed as Partial<IterationLimitReview>;
}

function safeModelResponseSnippet(text: string): string {
    const clean = redactBrowserAgentText(text).replace(/\s+/g, ' ').trim();
    return clean.length <= MAX_MODEL_RESPONSE_LOG_CHARS
        ? clean
        : `${clean.slice(0, MAX_MODEL_RESPONSE_LOG_CHARS - 1).trimEnd()}...`;
}

function buildJsonRetryInstruction(contextLabel: string, error: unknown, retryNumber: number, maxRetries: number): string {
    const message = error instanceof Error ? error.message : String(error);
    return [
        `\n## JSON OUTPUT RETRY ${retryNumber}/${maxRetries}`,
        `Your previous ${contextLabel} response could not be parsed by the browser runtime: ${message}`,
        'Return ONLY valid JSON matching the required response schema.',
        'Use double quotes for all object keys and strings. Do not include Markdown fences, comments, trailing commas, or explanatory prose.',
    ].join('\n');
}

async function requestParsedJsonWithRetries<T>(args: {
    contextLabel: string;
    model: string;
    requestParts: VisionRequestPart[];
    systemInstruction?: string;
    maxRetries?: number;
    generate: (requestParts: VisionRequestPart[], systemInstruction?: string) => Promise<VisionGenerateResponse>;
    parse: (text: string) => T;
    onUsage?: (usage: VisionUsage) => void;
}): Promise<T> {
    const maxRetries = args.maxRetries ?? MAX_JSON_PARSE_RETRIES;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const requestParts = attempt === 0
            ? args.requestParts
            : [
                ...args.requestParts,
                { text: buildJsonRetryInstruction(args.contextLabel, lastError, attempt, maxRetries) },
            ];

        const response = await args.generate(requestParts, args.systemInstruction);
        const usage = extractUsage(getUsageMetadata(response));
        args.onUsage?.({
            model: args.model,
            ...usage,
        });

        const text = response.text?.trim() || '';
        try {
            return args.parse(text);
        } catch (error) {
            lastError = error;
            const snippet = safeModelResponseSnippet(text);
            const retryText = attempt < maxRetries ? `retrying ${attempt + 1}/${maxRetries}` : 'no retries left';
            console.warn(
                `[browser-agent] Invalid Gemini JSON for ${args.contextLabel}; ${retryText}. ` +
                `${error instanceof Error ? error.message : 'Unknown parse error'}. ` +
                `Raw response: ${snippet || '(empty)'}`
            );
        }
    }

    const message = lastError instanceof Error ? lastError.message : 'Unknown parse error';
    throw new ModelOutputParseError(`Model returned invalid ${args.contextLabel} JSON after ${maxRetries + 1} attempts. Last error: ${message}`);
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

                return await requestParsedJsonWithRetries({
                    contextLabel: 'browser action',
                    model: state.model,
                    requestParts,
                    systemInstruction: systemPrompt,
                    generate: (parts, systemInstruction) => generateContentWithFallback(ai, state.model, state, parts, {
                        systemInstruction,
                        responseJsonSchema: BROWSER_ACTION_RESPONSE_JSON_SCHEMA,
                    }) as Promise<VisionGenerateResponse>,
                    parse: parseAgentActionsFromModelText,
                    onUsage,
                });
            } catch (error) {
                console.error('Vision action error:', error);
                const prefix = error instanceof ModelOutputParseError ? 'Model Output Error' : 'API Error';
                return [{
                    action: 'error',
                    reasoning: `${prefix}: ${error instanceof Error ? error.message : 'Unknown'}`,
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

                const parsed = await requestParsedJsonWithRetries({
                    contextLabel: 'iteration-limit review',
                    model: state.model,
                    requestParts,
                    generate: (parts, systemInstruction) => generateContentWithFallback(ai, state.model, state, parts, {
                        systemInstruction,
                        responseJsonSchema: ITERATION_LIMIT_REVIEW_JSON_SCHEMA,
                    }) as Promise<VisionGenerateResponse>,
                    parse: parseIterationLimitReviewFromModelText,
                    onUsage,
                });

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

export const browserVisionTestHooks = {
    buildRequestConfig,
    parseAgentActionsFromModelText,
    parseIterationLimitReviewFromModelText,
    requestParsedJsonWithRetries,
};
