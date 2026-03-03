import { ALL_SHARED_TOOL_NAMES } from '../../tools/sharedToolNames.js';
import { buildMultipurposeChatConfig } from './api.js';

export const MULTIPURPOSE_AGENT_ID = 'multipurpose';
const VALID_THINKING_LEVELS = new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);

function normalizeDefaultThinkingLevel(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (VALID_THINKING_LEVELS.has(normalized)) {
        return normalized;
    }

    return 'HIGH';
}

export const MULTIPURPOSE_DEFAULT_MODEL = String(
    process.env.MULTIPURPOSE_MODEL
    ?? process.env.GEMINI_MULTIPURPOSE_MODEL
    ?? 'gemini-3.1-pro-preview',
).trim() || 'gemini-3.1-pro-preview';

export const MULTIPURPOSE_DEFAULT_THINKING_LEVEL = normalizeDefaultThinkingLevel(
    process.env.MULTIPURPOSE_THINKING_LEVEL
    ?? process.env.GEMINI_MULTIPURPOSE_THINKING_LEVEL
    ?? 'HIGH',
);

export const multipurposeAgent = {
    id: MULTIPURPOSE_AGENT_ID,
    name: 'Multipurpose Agent',
    description: 'All-purpose agent with full tool & skill access for complex, multi-step tasks.',
    icon: '🔧',
    supportsThinking: true,
    supportsGrounding: false,
    // All tools EXCEPT call_multipurpose_agent (prevent recursion)
    get toolAccess() { return ALL_SHARED_TOOL_NAMES.filter((name) => name !== 'call_multipurpose_agent'); },

    createDefaultConfig() {
        return {
            model: MULTIPURPOSE_DEFAULT_MODEL,
            thinkingLevel: MULTIPURPOSE_DEFAULT_THINKING_LEVEL,
        };
    },

    normalizeConfig(rawConfig, helpers) {
        const defaults = multipurposeAgent.createDefaultConfig(helpers);
        const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};

        return {
            model: helpers.normalizeModel(source.model, defaults.model),
            thinkingLevel: helpers.normalizeThinkingLevel(
                source.thinkingLevel,
                defaults.thinkingLevel,
            ),
        };
    },

    toClientDefinition() {
        return {
            id: multipurposeAgent.id,
            name: multipurposeAgent.name,
            description: multipurposeAgent.description,
            icon: multipurposeAgent.icon,
            supportsThinking: multipurposeAgent.supportsThinking,
            supportsGrounding: multipurposeAgent.supportsGrounding,
            defaultModel: MULTIPURPOSE_DEFAULT_MODEL,
            defaultThinkingLevel: MULTIPURPOSE_DEFAULT_THINKING_LEVEL,
        };
    },

    buildChatConfig({ agentConfig, mapThinkingLevel, sharedTools }) {
        return buildMultipurposeChatConfig({
            agentConfig,
            mapThinkingLevel,
            sharedTools,
        });
    },
};

export const agent = multipurposeAgent;
