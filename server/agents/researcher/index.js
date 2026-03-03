import { buildResearcherChatConfig } from './api.js';

export const RESEARCHER_AGENT_ID = 'researcher';
const VALID_THINKING_LEVELS = new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);

function normalizeDefaultThinkingLevel(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    return VALID_THINKING_LEVELS.has(normalized) ? normalized : 'HIGH';
}

export const RESEARCHER_DEFAULT_MODEL = String(
    process.env.RESEARCHER_MODEL
    ?? process.env.GEMINI_RESEARCHER_MODEL
    ?? 'gemini-3.1-pro-preview',
).trim() || 'gemini-3.1-pro-preview';

export const RESEARCHER_DEFAULT_THINKING_LEVEL = normalizeDefaultThinkingLevel(
    process.env.RESEARCHER_THINKING_LEVEL
    ?? process.env.GEMINI_RESEARCHER_THINKING_LEVEL
    ?? 'HIGH',
);

// Research-focused tools — no code editing, no agent-calling agent tools (prevent loops)
export const RESEARCHER_BASE_TOOLS = [
    // Web research core
    'search_web',
    'read_url_content',
    'view_content_chunk',

    // File operations (to save research reports, read context)
    'list_dir',
    'view_file',
    'view_file_outline',
    'write_to_file',

    // Shell for data processing (curl, jq, etc.)
    'run_command',
    'command_status',
    'send_command_input',
    'read_terminal',
];

export const RESEARCHER_SUBAGENT_TOOLS = [
    'spawn_subagent',
    'subagent_status',
];

export function getResearcherToolAccess({ allowSubagents = true } = {}) {
    return allowSubagents
        ? [...RESEARCHER_BASE_TOOLS, ...RESEARCHER_SUBAGENT_TOOLS]
        : [...RESEARCHER_BASE_TOOLS];
}

export const researcherAgent = {
    id: RESEARCHER_AGENT_ID,
    name: 'Researcher',
    description: 'Deep research agent: travel, flights, prices, medical literature, market analysis, and more.',
    icon: '🔬',
    supportsThinking: true,
    supportsGrounding: false,
    toolAccess: getResearcherToolAccess(),

    createDefaultConfig() {
        return {
            model: RESEARCHER_DEFAULT_MODEL,
            thinkingLevel: RESEARCHER_DEFAULT_THINKING_LEVEL,
        };
    },

    normalizeConfig(rawConfig, helpers) {
        const defaults = researcherAgent.createDefaultConfig(helpers);
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
            id: researcherAgent.id,
            name: researcherAgent.name,
            description: researcherAgent.description,
            icon: researcherAgent.icon,
            supportsThinking: researcherAgent.supportsThinking,
            supportsGrounding: researcherAgent.supportsGrounding,
            defaultModel: RESEARCHER_DEFAULT_MODEL,
            defaultThinkingLevel: RESEARCHER_DEFAULT_THINKING_LEVEL,
        };
    },

    buildChatConfig({ agentConfig, mapThinkingLevel, sharedTools }) {
        return buildResearcherChatConfig({
            agentConfig,
            mapThinkingLevel,
            sharedTools,
        });
    },
};

export const agent = researcherAgent;
