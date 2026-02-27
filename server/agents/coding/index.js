import { ALL_SHARED_TOOL_NAMES } from '../../tools/index.js';
import { buildCodingChatConfig } from './api.js';

export const CODING_AGENT_ID = 'coding';
const VALID_THINKING_LEVELS = new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);

function normalizeDefaultThinkingLevel(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (VALID_THINKING_LEVELS.has(normalized)) {
        return normalized;
    }

    return 'MEDIUM';
}

export const CODING_AGENT_DEFAULT_MODEL = String(
    process.env.CODING_AGENT_MODEL
    ?? process.env.GEMINI_CODING_MODEL
    ?? 'gemini-3.1-pro-preview',
).trim() || 'gemini-3.1-pro-preview';

export const CODING_AGENT_DEFAULT_THINKING_LEVEL = normalizeDefaultThinkingLevel(
    process.env.CODING_AGENT_THINKING_LEVEL
    ?? process.env.GEMINI_CODING_THINKING_LEVEL
    ?? 'MEDIUM',
);

export const codingAgent = {
    id: CODING_AGENT_ID,
    name: 'Coding Agent',
    description: 'Specialized agent for coding, debugging, refactors, and implementation tasks.',
    icon: '💻',
    supportsThinking: true,
    supportsGrounding: false,
    get toolAccess() { return ALL_SHARED_TOOL_NAMES.filter((name) => name !== 'call_coding_agent'); },

    createDefaultConfig() {
        return {
            model: CODING_AGENT_DEFAULT_MODEL,
            thinkingLevel: CODING_AGENT_DEFAULT_THINKING_LEVEL,
        };
    },

    normalizeConfig(rawConfig, helpers) {
        const defaults = codingAgent.createDefaultConfig(helpers);
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
            id: codingAgent.id,
            name: codingAgent.name,
            description: codingAgent.description,
            icon: codingAgent.icon,
            supportsThinking: codingAgent.supportsThinking,
            supportsGrounding: codingAgent.supportsGrounding,
            defaultModel: CODING_AGENT_DEFAULT_MODEL,
            defaultThinkingLevel: CODING_AGENT_DEFAULT_THINKING_LEVEL,
        };
    },

    buildChatConfig({ agentConfig, mapThinkingLevel, sharedTools }) {
        return buildCodingChatConfig({
            agentConfig,
            mapThinkingLevel,
            sharedTools,
        });
    },
};

export const agent = codingAgent;
