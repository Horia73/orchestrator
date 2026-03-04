/**
 * Gemini Vision Service
 * Uses smarter prompts with memory and history
 */
import { GoogleGenAI } from '@google/genai';
import { getGeminiApiKey } from '../../core/config.js';
import { buildSystemPrompt, buildActionPrompt, buildInterruptPrompt } from './prompts.js';
import { getLearnings } from './memory.js';
function sanitizeThinkingLevel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'minimal' || normalized === 'low' || normalized === 'medium' || normalized === 'high') {
        return normalized;
    }
    return '';
}
function buildThinkingConfig(explicitLevel) {
    const thinkingLevel = sanitizeThinkingLevel(explicitLevel);
    return {
        thinkingLevel: thinkingLevel || 'minimal',
    };
}
function isThinkingCompatError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /thinking/i.test(message) && /(not supported|invalid)/i.test(message);
}
function extractUsage(rawUsage) {
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
export function createVisionService(initialConfig = {}, onUsage) {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
        throw new Error('Missing GEMINI_API_KEY in environment, secret store, or config.');
    }
    const ai = new GoogleGenAI({ apiKey });
    const state = {
        model: initialConfig.model || 'gemini-3-flash-preview',
        thinkingLevel: sanitizeThinkingLevel(initialConfig.thinkingLevel) || 'minimal',
    };
    const service = {
        updateConfig(patch) {
            if (!patch || typeof patch !== 'object')
                return;
            if (typeof patch.model === 'string' && patch.model.trim()) {
                state.model = patch.model.trim();
            }
            if (typeof patch.thinkingLevel === 'string' && patch.thinkingLevel.trim()) {
                state.thinkingLevel = sanitizeThinkingLevel(patch.thinkingLevel) || state.thinkingLevel;
            }
        },
        getConfig() {
            return {
                model: state.model,
                thinkingLevel: state.thinkingLevel,
            };
        },
        async analyzeScreenshot(screenshot, goal, actionHistory, conversationHistory = [], isInterrupt = false) {
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
                const requestConfig = { thinkingConfig: buildThinkingConfig(state.thinkingLevel) };
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
                }
                catch (error) {
                    if (!isThinkingCompatError(error)) {
                        throw error;
                    }
                    const fallbackConfig = {};
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
                const usage = extractUsage(response?.usageMetadata || {});
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
                }
                else {
                    const lastOpenBrace = text.lastIndexOf('{');
                    const lastCloseBrace = text.lastIndexOf('}');
                    if (lastOpenBrace !== -1 && lastCloseBrace !== -1 && lastCloseBrace > lastOpenBrace) {
                        jsonText = text.substring(lastOpenBrace, lastCloseBrace + 1);
                    }
                }
                let action;
                try {
                    action = JSON.parse(jsonText);
                }
                catch {
                    const cleanJson = jsonText.replace(/^[^{]*({[\s\S]*})[^}]*$/, '$1');
                    action = JSON.parse(cleanJson);
                }
                if (!action.action) {
                    throw new Error('Missing action field');
                }
                const validActions = ['click', 'type', 'key', 'scroll', 'wait', 'navigate', 'hold', 'hover', 'closeTab', 'refresh', 'getLink', 'pasteLink', 'clear', 'done', 'ask', 'goBack', 'goForward'];
                if (!validActions.includes(action.action)) {
                    throw new Error(`Invalid action: ${action.action}`);
                }
                return action;
            }
            catch (error) {
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
