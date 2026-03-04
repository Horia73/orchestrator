import { getOrchestratorPrompt } from './prompt.js';

export function buildOrchestratorChatConfig({ agentConfig, mapThinkingLevel, sharedTools }) {
    const thinkingConfig = mapThinkingLevel(agentConfig?.thinkingLevel);
    const config = {
        systemInstruction: getOrchestratorPrompt(),
    };

    if (thinkingConfig) {
        config.thinkingConfig = thinkingConfig;
    }

    if (Array.isArray(sharedTools) && sharedTools.length > 0) {
        config.tools = sharedTools;
    }

    return config;
}
