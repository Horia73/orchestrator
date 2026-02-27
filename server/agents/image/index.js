import { buildImageChatConfig } from './api.js';

export const IMAGE_AGENT_ID = 'image';
const VALID_THINKING_LEVELS = new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);

function normalizeDefaultThinkingLevel(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (VALID_THINKING_LEVELS.has(normalized)) {
        return normalized;
    }

    return 'MINIMAL';
}

export const IMAGE_AGENT_DEFAULT_MODEL = String(
    process.env.IMAGE_AGENT_MODEL
    ?? process.env.GEMINI_IMAGE_MODEL
    ?? 'gemini-3.1-flash-image-preview',
).trim() || 'gemini-3.1-flash-image-preview';

export const IMAGE_AGENT_DEFAULT_THINKING_LEVEL = normalizeDefaultThinkingLevel(
    process.env.IMAGE_AGENT_THINKING_LEVEL
    ?? process.env.GEMINI_IMAGE_THINKING_LEVEL
    ?? 'MINIMAL',
);

export const imageAgent = {
    id: IMAGE_AGENT_ID,
    name: 'Image Agent',
    description: 'Generates and edits images with Gemini image models.',
    icon: '🖼️',
    supportsThinking: true,
    supportsGrounding: true,
    toolAccess: [],

    createDefaultConfig() {
        return {
            model: IMAGE_AGENT_DEFAULT_MODEL,
            thinkingLevel: IMAGE_AGENT_DEFAULT_THINKING_LEVEL,
            grounding: {
                webSearch: true,
                imageSearch: true,
            },
        };
    },

    normalizeConfig(rawConfig, helpers) {
        const defaults = imageAgent.createDefaultConfig(helpers);
        const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};

        return {
            model: helpers.normalizeModel(source.model, defaults.model),
            thinkingLevel: helpers.normalizeThinkingLevel(
                source.thinkingLevel,
                defaults.thinkingLevel,
            ),
            grounding: helpers.normalizeGrounding(source.grounding, defaults.grounding),
        };
    },

    toClientDefinition() {
        return {
            id: imageAgent.id,
            name: imageAgent.name,
            description: imageAgent.description,
            icon: imageAgent.icon,
            supportsThinking: imageAgent.supportsThinking,
            supportsGrounding: imageAgent.supportsGrounding,
            defaultModel: IMAGE_AGENT_DEFAULT_MODEL,
            defaultThinkingLevel: IMAGE_AGENT_DEFAULT_THINKING_LEVEL,
            defaultGrounding: {
                webSearch: true,
                imageSearch: true,
            },
        };
    },

    buildChatConfig({ agentConfig, mapThinkingLevel }) {
        return buildImageChatConfig({ agentConfig, mapThinkingLevel });
    },
};

export const agent = imageAgent;
