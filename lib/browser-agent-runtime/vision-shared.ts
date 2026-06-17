/**
 * Shared vision-service contract and model-agnostic helpers.
 *
 * Everything here is backend-neutral: action types, JSON schemas, request-part
 * building, JSON extraction/validation, and the parse-with-retries loop. The
 * Gemini- and Codex-specific clients live in vision-gemini.ts / vision-codex.ts.
 */

import { ActionTrace, BrowserDownloadFile, BrowserFrameSnapshot } from './browser';
import { ActionHistoryItem, TabInfo, IterationLimitReview } from './prompts';
import { redactBrowserAgentText } from './redaction';
import type { MediaResolutionLevel, ThinkingLevel, VisionProvider } from './config';

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
    provider: VisionProvider;
    model: string;
    thinkingLevel: ThinkingLevel;
    mediaResolution: MediaResolutionLevel;
}

export interface VisionUsage {
    model: string;
    promptTokens: number;
    outputTokens: number;
    thoughtsTokens: number;
    totalTokens: number;
}

/** Coordinate space the active backend prompts the model in. */
export type VisionCoordinateMode = 'normalized' | 'pixel';

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
    /** Coordinate space the model is prompted in ('normalized' 0-1000 vs viewport 'pixel'). */
    getCoordinateMode(): VisionCoordinateMode;
    /** Release backend resources (long-lived processes, temp files). */
    dispose?(): Promise<void>;
    /** Best-effort cancellation of any in-flight model call. */
    cancelActive?(): void;
}

export type VisionRequestPart = { text?: string; inlineData?: { mimeType: string; data: string } };
export type VisionGenerateResponse = { text?: string; usageMetadata?: unknown };

export const MAX_JSON_PARSE_RETRIES = 3;
const MAX_MODEL_RESPONSE_LOG_CHARS = 1000;

export const VALID_ACTIONS = ['click', 'type', 'key', 'scroll', 'scrollToBottom', 'undo', 'wait', 'navigate', 'hold', 'drag', 'hover', 'inspectPage', 'findInPage', 'inspectDiagnostics', 'fetchUrl', 'screenshot', 'recordVideo', 'closeTab', 'refresh', 'getLink', 'pasteLink', 'readClipboard', 'clear', 'done', 'ask', 'error', 'goBack', 'goForward', 'listTabs', 'switchTab', 'newTab', 'listDownloads', 'waitForDownloads', 'escalate', 'yield_control'] as const satisfies readonly AgentAction['action'][];
const VALID_ACTION_SET = new Set<string>(VALID_ACTIONS);

export const COORDINATE_JSON_SCHEMA = {
    type: 'array',
    items: { type: 'number' },
    minItems: 2,
    maxItems: 2,
} as const;

export const BROWSER_ACTION_JSON_SCHEMA = {
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

export const BROWSER_ACTION_RESPONSE_JSON_SCHEMA = {
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

export const STRING_ARRAY_JSON_SCHEMA = {
    type: 'array',
    items: { type: 'string' },
    maxItems: 5,
} as const;

export const ITERATION_LIMIT_REVIEW_JSON_SCHEMA = {
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

export class ModelOutputParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ModelOutputParseError';
    }
}

export function sanitizeThinkingLevel(value: unknown): VisionConfig['thinkingLevel'] | '' {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
        return normalized;
    }
    return '';
}

export function sanitizeMediaResolution(value: unknown): VisionConfig['mediaResolution'] | '' {
    const normalized = String(value || '').trim().toLowerCase().replace(/^media[_-]resolution[_-]/, '');
    if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
        return normalized;
    }
    return '';
}

export function buildVisionParts(
    leadingContext: string,
    historyContext: string,
    actionPrompt: string,
    frame: BrowserFrameSnapshot,
    recentTrace: ActionTrace | null | undefined,
    supplementalFrames: BrowserFrameSnapshot[] = [],
    coordinateSpaceLabel?: string,
): VisionRequestPart[] {
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

    if (orderedFrames.length > 1) {
        visualContextLines.push('- Each image is attached right after its `Frame N/M` text label, and the image file is named `frame-N.jpg` in the SAME oldest→newest order. If the images ever seem out of order, trust the number in `frame-N.jpg` / the `Frame N/M` label, not the order you happen to read them in.');
    }

    const traceContext = `${visualContextLines.join('\n')}\n`;

    const parts: VisionRequestPart[] = [
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
        const imageFileLabel = orderedFrames.length > 1 ? ` (image file: frame-${index + 1}.jpg)` : '';
        parts.push({
            text: `Frame ${index + 1}/${orderedFrames.length}${imageFileLabel}: ${label}\nURL: ${currentFrame.url}\nCapture: ${currentFrame.captureMode}\nCoordinate space: ${coordinateSpaceLabel ?? currentFrame.coordinateSpace ?? 'normalized-viewport'}\nViewport: ${currentFrame.viewport.width}x${currentFrame.viewport.height}\nPage: ${currentFrame.page.width}x${currentFrame.page.height}\nScroll: ${currentFrame.page.scrollX}, ${currentFrame.page.scrollY}\nTimestamp: ${currentFrame.timestamp}`,
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

export function parseJsonFromModelText(text: string): unknown {
    const jsonText = extractJsonText(text);
    try {
        return JSON.parse(jsonText) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown parse error';
        throw new ModelOutputParseError(`Invalid JSON: ${message}`);
    }
}

/**
 * Strict-schema backends (codex outputSchema) emit all-required objects where
 * optional fields come back as null. Drop nulls so downstream `field?: T`
 * handling stays identical across backends.
 */
function stripNullProperties(record: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
        if (value !== null) out[key] = value;
    }
    return out;
}

export function parseAgentActionsFromModelText(text: string): AgentAction[] {
    let parsed = parseJsonFromModelText(text);

    // Strict-schema backends wrap the batch as { "actions": [...] } because a
    // top-level anyOf(single|array) is not representable there.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const wrapped = (parsed as Record<string, unknown>).actions;
        if (Array.isArray(wrapped)) {
            parsed = wrapped;
        }
    }

    const rawActions = Array.isArray(parsed) ? parsed : [parsed];

    if (rawActions.length === 0) {
        throw new ModelOutputParseError('Browser action response must contain at least one action.');
    }

    const actions: Record<string, unknown>[] = [];
    for (const action of rawActions) {
        if (!action || typeof action !== 'object' || Array.isArray(action)) {
            throw new ModelOutputParseError('Browser action response must be an object or an array of objects.');
        }

        const record = stripNullProperties(action as Record<string, unknown>);
        if (typeof record.action !== 'string') {
            throw new ModelOutputParseError('Browser action is missing a string action field.');
        }
        if (!VALID_ACTION_SET.has(record.action)) {
            throw new ModelOutputParseError(`Invalid browser action: ${record.action}`);
        }
        if (typeof record.reasoning !== 'string') {
            throw new ModelOutputParseError('Browser action is missing a string reasoning field.');
        }
        actions.push(record);
    }

    return actions as unknown as AgentAction[];
}

export function parseIterationLimitReviewFromModelText(text: string): Partial<IterationLimitReview> {
    const parsed = parseJsonFromModelText(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ModelOutputParseError('Iteration-limit review response must be a JSON object.');
    }
    return stripNullProperties(parsed as Record<string, unknown>) as Partial<IterationLimitReview>;
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

export function extractGeminiUsage(rawUsage: unknown): Omit<VisionUsage, 'model'> {
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

export async function requestParsedJsonWithRetries<T>(args: {
    contextLabel: string;
    model: string;
    requestParts: VisionRequestPart[];
    systemInstruction?: string;
    maxRetries?: number;
    generate: (requestParts: VisionRequestPart[], systemInstruction?: string) => Promise<VisionGenerateResponse>;
    parse: (text: string) => T;
    /** Maps a backend response to token usage. Defaults to Gemini usageMetadata extraction. */
    extractUsage?: (response: VisionGenerateResponse) => Omit<VisionUsage, 'model'>;
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
        const usage = args.extractUsage
            ? args.extractUsage(response)
            : extractGeminiUsage(getUsageMetadata(response));
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
                `[browser-agent] Invalid ${args.contextLabel} JSON from ${args.model}; ${retryText}. ` +
                `${error instanceof Error ? error.message : 'Unknown parse error'}. ` +
                `Raw response: ${snippet || '(empty)'}`
            );
        }
    }

    const message = lastError instanceof Error ? lastError.message : 'Unknown parse error';
    throw new ModelOutputParseError(`Model returned invalid ${args.contextLabel} JSON after ${maxRetries + 1} attempts. Last error: ${message}`);
}

export function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 5);
}
