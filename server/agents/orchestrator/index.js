import { ALL_SHARED_TOOL_NAMES } from '../../tools/catalog.js';
import { buildOrchestratorChatConfig } from './api.js';

export const ORCHESTRATOR_AGENT_ID = 'orchestrator';
const VALID_THINKING_LEVELS = new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);

function normalizeDefaultThinkingLevel(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (VALID_THINKING_LEVELS.has(normalized)) {
        return normalized;
    }

    return 'MINIMAL';
}

export const ORCHESTRATOR_DEFAULT_MODEL = String(
    process.env.ORCHESTRATOR_MODEL ?? process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview',
).trim() || 'gemini-3-flash-preview';

export const ORCHESTRATOR_DEFAULT_THINKING_LEVEL = normalizeDefaultThinkingLevel(
    process.env.ORCHESTRATOR_THINKING_LEVEL ?? process.env.GEMINI_THINKING_LEVEL ?? 'MINIMAL',
);

export const orchestratorAgent = {
    id: ORCHESTRATOR_AGENT_ID,
    name: 'Orchestrator',
    description: 'General-purpose assistant with tools; routes specialized coding/image requests when needed.',
    icon: '🧠',
    supportsThinking: true,
    supportsGrounding: false,
    toolAccess: ALL_SHARED_TOOL_NAMES,

    createDefaultConfig() {
        return {
            model: ORCHESTRATOR_DEFAULT_MODEL,
            thinkingLevel: ORCHESTRATOR_DEFAULT_THINKING_LEVEL,
        };
    },

    normalizeConfig(rawConfig, helpers) {
        const defaults = orchestratorAgent.createDefaultConfig(helpers);
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
            id: orchestratorAgent.id,
            name: orchestratorAgent.name,
            description: orchestratorAgent.description,
            icon: orchestratorAgent.icon,
            supportsThinking: orchestratorAgent.supportsThinking,
            supportsGrounding: orchestratorAgent.supportsGrounding,
            defaultModel: ORCHESTRATOR_DEFAULT_MODEL,
            defaultThinkingLevel: ORCHESTRATOR_DEFAULT_THINKING_LEVEL,
        };
    },

    buildChatConfig({ agentConfig, mapThinkingLevel, sharedTools }) {
        return buildOrchestratorChatConfig({
            agentConfig,
            mapThinkingLevel,
            sharedTools,
        });
    },
};
