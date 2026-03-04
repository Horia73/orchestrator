const VALID_THINKING_LEVELS = new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);

export const BROWSER_AGENT_ID = 'browser';

function normalizeDefaultThinkingLevel(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (VALID_THINKING_LEVELS.has(normalized)) {
        return normalized;
    }

    return 'MINIMAL';
}

export const BROWSER_AGENT_DEFAULT_MODEL = String(
    process.env.BROWSER_AGENT_MODEL
    ?? process.env.GEMINI_BROWSER_MODEL
    ?? 'gemini-3-flash-preview',
).trim() || 'gemini-3-flash-preview';

export const BROWSER_AGENT_DEFAULT_THINKING_LEVEL = normalizeDefaultThinkingLevel(
    process.env.BROWSER_AGENT_THINKING_LEVEL
    ?? process.env.GEMINI_BROWSER_THINKING_LEVEL
    ?? 'MINIMAL',
);

export const browserAgent = {
    id: BROWSER_AGENT_ID,
    name: 'Browser Agent',
    description: 'Physical browser operator for live websites, authenticated flows, and real UI interactions.',
    icon: '🌐',
    supportsThinking: true,
    supportsGrounding: false,
    chatSelectable: false,
    toolAccess: [],

    createDefaultConfig() {
        return {
            model: BROWSER_AGENT_DEFAULT_MODEL,
            thinkingLevel: BROWSER_AGENT_DEFAULT_THINKING_LEVEL,
        };
    },

    normalizeConfig(rawConfig, helpers) {
        const defaults = browserAgent.createDefaultConfig(helpers);
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
            id: browserAgent.id,
            name: browserAgent.name,
            description: browserAgent.description,
            icon: browserAgent.icon,
            supportsThinking: browserAgent.supportsThinking,
            supportsGrounding: browserAgent.supportsGrounding,
            defaultModel: BROWSER_AGENT_DEFAULT_MODEL,
            defaultThinkingLevel: BROWSER_AGENT_DEFAULT_THINKING_LEVEL,
            chatSelectable: false,
        };
    },
};

export const agent = browserAgent;
