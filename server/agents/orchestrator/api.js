import { getOrchestratorPrompt } from './prompt.js';

export function buildOrchestratorChatConfig({ agentConfig, mapThinkingLevel, sharedTools }) {
    const config = {
        systemInstruction: getOrchestratorPrompt(),
        thinkingConfig: {
            thinkingLevel: mapThinkingLevel(agentConfig?.thinkingLevel),
            includeThoughts: true,
        },
    };

    if (Array.isArray(sharedTools) && sharedTools.length > 0) {
        config.tools = sharedTools;
    }

    return config;
}
