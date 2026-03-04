import { getMultipurposeAgentPrompt } from './prompt.js';

export function buildMultipurposeChatConfig({ agentConfig, mapThinkingLevel, sharedTools }) {
    const thinkingConfig = mapThinkingLevel(agentConfig?.thinkingLevel);
    const config = {
        systemInstruction: getMultipurposeAgentPrompt(),
    };

    if (thinkingConfig) {
        config.thinkingConfig = thinkingConfig;
    }

    if (Array.isArray(sharedTools) && sharedTools.length > 0) {
        config.tools = sharedTools;
    }

    return config;
}
