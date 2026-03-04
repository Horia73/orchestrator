import { getResearcherAgentPrompt } from './prompt.js';

export function buildResearcherChatConfig({ agentConfig, mapThinkingLevel, sharedTools }) {
    const thinkingConfig = mapThinkingLevel(agentConfig?.thinkingLevel);
    const config = {
        systemInstruction: getResearcherAgentPrompt(),
    };

    if (thinkingConfig) {
        config.thinkingConfig = thinkingConfig;
    }

    if (Array.isArray(sharedTools) && sharedTools.length > 0) {
        config.tools = sharedTools;
    }

    return config;
}
