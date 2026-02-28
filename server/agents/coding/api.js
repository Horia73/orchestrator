import { getCodingAgentPrompt } from './prompt.js';

export function buildCodingChatConfig({ agentConfig, mapThinkingLevel, sharedTools }) {
    const thinkingLevel = mapThinkingLevel(agentConfig?.thinkingLevel);
    const config = {
        systemInstruction: getCodingAgentPrompt(),
    };

    if (thinkingLevel !== null) {
        config.thinkingConfig = {
            thinkingLevel,
            includeThoughts: true,
        };
    }

    if (Array.isArray(sharedTools) && sharedTools.length > 0) {
        config.tools = sharedTools;
    }

    return config;
}
