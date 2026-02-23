/**
 * Gemini Vision Service
 * Uses smarter prompts with memory and history
 */

import { GoogleGenAI } from '@google/genai';
import { buildSystemPrompt, buildActionPrompt, buildInterruptPrompt, ActionHistoryItem } from './prompts.js';
import { getLearnings } from './memory.js';

export interface AgentAction {
    action: 'click' | 'type' | 'key' | 'scroll' | 'wait' | 'navigate' | 'hold' | 'hover' | 'closeTab' | 'refresh' | 'getLink' | 'pasteLink' | 'clear' | 'done' | 'ask' | 'goBack' | 'goForward' | 'error';
    coordinate?: [number, number]; // [x, y]
    text?: string;
    submit?: boolean;
    clearBefore?: boolean; // If true, select all and delete before typing
    clickCount?: number; // 1 or 2
    key?: 'Enter' | 'Escape' | 'Tab' | 'Backspace';
    scrollDirection?: 'up' | 'down';
    url?: string;
    reasoning: string;
    memory?: string; // What we learned from this step (e.g. "To clear input, click then Ctrl+A+Backspace")
}

export interface VisionConfig {
    model: string;
    thinkingBudget: number;
    temperature: number;
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
        screenshot: string,
        goal: string,
        actionHistory: ActionHistoryItem[],
        conversationHistory: string[],
        isInterrupt?: boolean
    ): Promise<AgentAction>;
    updateConfig(patch: Partial<VisionConfig>): void;
    getConfig(): VisionConfig;
}

function isThinkingCompatError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /thinking/i.test(message) && /(not supported|invalid)/i.test(message);
}

function extractUsage(rawUsage: any): Omit<VisionUsage, 'model'> {
    const promptTokens = Number(rawUsage?.promptTokenCount) || 0;
    const outputTokens = Number(rawUsage?.candidatesTokenCount) || 0;
    const thoughtsTokens = Number(rawUsage?.thoughtsTokenCount) || 0;
    const totalTokens = Number(rawUsage?.totalTokenCount) || (promptTokens + outputTokens + thoughtsTokens);
    return {
        promptTokens,
        outputTokens,
        thoughtsTokens,
        totalTokens,
    };
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
        model: initialConfig.model || 'gemini-2.0-flash',
        thinkingBudget: Number.isFinite(initialConfig.thinkingBudget as number)
            ? Math.max(0, Math.floor(initialConfig.thinkingBudget as number))
            : 0,
        temperature: Number.isFinite(initialConfig.temperature as number)
            ? Math.max(0, Math.min(2, Number(initialConfig.temperature)))
            : 0,
    };

    const service: VisionService = {
        updateConfig(patch: Partial<VisionConfig>) {
            if (!patch || typeof patch !== 'object') return;

            if (typeof patch.model === 'string' && patch.model.trim()) {
                state.model = patch.model.trim();
            }
            if (Number.isFinite(patch.thinkingBudget as number) && Number(patch.thinkingBudget) >= 0) {
                state.thinkingBudget = Math.floor(Number(patch.thinkingBudget));
            }
            if (Number.isFinite(patch.temperature as number)) {
                state.temperature = Math.max(0, Math.min(2, Number(patch.temperature)));
            }
        },

        getConfig(): VisionConfig {
            return {
                model: state.model,
                thinkingBudget: state.thinkingBudget,
                temperature: state.temperature,
            };
        },

        async analyzeScreenshot(
            screenshot: string,
            goal: string,
            actionHistory: ActionHistoryItem[],
            conversationHistory: string[] = [],
            isInterrupt = false
        ): Promise<AgentAction> {
            // Get learnings from memory
            const learnings = getLearnings();
            const systemPrompt = buildSystemPrompt(learnings);

            const actionPrompt = isInterrupt
                ? buildInterruptPrompt(goal)
                : buildActionPrompt(goal, actionHistory);

            try {
                // Add conversation history context
                const historyContext = conversationHistory.length > 0
                    ? `\n## 📜 CONVERSATION HISTORY (Context):\n${conversationHistory.join('\n')}\n`
                    : '';

                const requestConfig: any = {
                    temperature: state.temperature,
                    thinkingConfig: {
                        thinkingBudget: state.thinkingBudget,
                    },
                };

                let response;
                try {
                    response = await ai.models.generateContent({
                        model: state.model,
                        config: requestConfig,
                        contents: [
                            {
                                role: 'user',
                                parts: [
                                    { text: systemPrompt + historyContext },
                                    {
                                        inlineData: {
                                            mimeType: 'image/jpeg',
                                            data: screenshot,
                                        },
                                    },
                                    { text: actionPrompt },
                                ],
                            },
                        ],
                    });
                } catch (error) {
                    if (!isThinkingCompatError(error)) {
                        throw error;
                    }

                    const fallbackConfig: any = {
                        temperature: requestConfig.temperature,
                    };

                    response = await ai.models.generateContent({
                        model: state.model,
                        config: fallbackConfig,
                        contents: [
                            {
                                role: 'user',
                                parts: [
                                    { text: systemPrompt + historyContext },
                                    {
                                        inlineData: {
                                            mimeType: 'image/jpeg',
                                            data: screenshot,
                                        },
                                    },
                                    { text: actionPrompt },
                                ],
                            },
                        ],
                    });
                }

                const usage = extractUsage((response as any)?.usageMetadata || {});
                if (typeof onUsage === 'function') {
                    onUsage({
                        model: state.model,
                        ...usage,
                    });
                }

                const text = response.text?.trim() || '';

                // Extract JSON - handle cases with ```json block or just plain {}
                let jsonText = text;
                const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (jsonMatch) {
                    jsonText = jsonMatch[1].trim();
                } else {
                    const lastOpenBrace = text.lastIndexOf('{');
                    const lastCloseBrace = text.lastIndexOf('}');
                    if (lastOpenBrace !== -1 && lastCloseBrace !== -1 && lastCloseBrace > lastOpenBrace) {
                        jsonText = text.substring(lastOpenBrace, lastCloseBrace + 1);
                    }
                }

                let action: AgentAction;
                try {
                    action = JSON.parse(jsonText) as AgentAction;
                } catch (e) {
                    const cleanJson = jsonText.replace(/^[^{]*({[\s\S]*})[^}]*$/, '$1');
                    action = JSON.parse(cleanJson) as AgentAction;
                }

                if (!action.action) {
                    throw new Error('Missing action field');
                }

                const validActions = ['click', 'type', 'key', 'scroll', 'wait', 'navigate', 'hold', 'hover', 'closeTab', 'refresh', 'getLink', 'pasteLink', 'clear', 'done', 'ask', 'goBack', 'goForward'];
                if (!validActions.includes(action.action)) {
                    throw new Error(`Invalid action: ${action.action}`);
                }

                return action;
            } catch (error) {
                console.error('Vision API error:', error);
                return {
                    action: 'error',
                    reasoning: `API Error: ${error instanceof Error ? error.message : 'Unknown'}`,
                };
            }
        },
    };

    return service;
}
