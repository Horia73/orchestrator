/**
 * Gemini vision backend.
 * Uses normalized 0-1000 coordinates and Gemini structured output (responseJsonSchema).
 */

import { GoogleGenAI, MediaResolution, type GenerateContentConfig } from '@google/genai';
import { ActionTrace, BrowserDownloadFile, BrowserFrameSnapshot } from './browser';
import { buildSystemPrompt, buildMemoryContext, buildActionPrompt, buildInterruptPrompt, buildIterationLimitReviewPrompt, ActionHistoryItem, TabInfo, IterationLimitReview } from './prompts';
import { getMemories } from './memory';
import {
    AgentAction,
    BROWSER_ACTION_RESPONSE_JSON_SCHEMA,
    ITERATION_LIMIT_REVIEW_JSON_SCHEMA,
    ModelOutputParseError,
    VisionConfig,
    VisionGenerateResponse,
    VisionRequestPart,
    VisionService,
    VisionUsage,
    buildVisionParts,
    normalizeStringArray,
    parseAgentActionsFromModelText,
    parseIterationLimitReviewFromModelText,
    requestParsedJsonWithRetries,
    sanitizeMediaResolution,
    sanitizeThinkingLevel,
} from './vision-shared';

type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

function toGeminiThinkingLevel(level: VisionConfig['thinkingLevel']): GeminiThinkingLevel {
    // Gemini has no xhigh; degrade gracefully instead of dropping the setting.
    return level === 'xhigh' ? 'high' : level;
}

function buildThinkingConfig(explicitLevel?: unknown): { thinkingLevel: GeminiThinkingLevel } {
    const thinkingLevel = sanitizeThinkingLevel(explicitLevel);
    return {
        thinkingLevel: thinkingLevel ? toGeminiThinkingLevel(thinkingLevel) : 'minimal',
    };
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

export function createGeminiVisionService(
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
        provider: 'google',
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
                provider: 'google',
                model: state.model,
                thinkingLevel: state.thinkingLevel,
                mediaResolution: state.mediaResolution,
            };
        },

        getCoordinateMode() {
            return 'normalized' as const;
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

export const geminiVisionTestHooks = {
    buildRequestConfig,
};
