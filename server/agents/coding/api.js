import { getCodingAgentPrompt } from './prompt.js';

export function buildCodingChatConfig({ agentConfig, mapThinkingLevel, sharedTools }) {
    const thinkingConfig = mapThinkingLevel(agentConfig?.thinkingLevel);
    const config = {
        systemInstruction: getCodingAgentPrompt(),
    };

    if (thinkingConfig) {
        config.thinkingConfig = thinkingConfig;
    }

    if (Array.isArray(sharedTools) && sharedTools.length > 0) {
        config.tools = sharedTools;
    }

    return config;
}
