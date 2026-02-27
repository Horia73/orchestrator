import { getCodingAgentPrompt } from './prompt.js';

export function buildCodingChatConfig({ agentConfig, mapThinkingLevel, sharedTools }) {
    const config = {
        systemInstruction: getCodingAgentPrompt(),
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
