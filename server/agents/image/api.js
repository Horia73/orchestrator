import { getImageAgentPrompt } from './prompt.js';

const IMAGE_SEARCH_SUPPORTED_MODEL = 'gemini-3.1-flash-image-preview';
const IMAGE_WEB_GROUNDING_SUPPORTED_MODELS = new Set([
    'gemini-3.1-flash-image-preview',
    'gemini-3-pro-image-preview',
]);

function normalizeModelId(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    if (raw.startsWith('models/')) {
        return raw.slice('models/'.length);
    }
    return raw;
}

function isImageGenerationModel(modelId) {
    return String(modelId ?? '').toLowerCase().includes('-image');
}

function supportsImageSearchGrounding(modelId) {
    return normalizeModelId(modelId) === IMAGE_SEARCH_SUPPORTED_MODEL;
}

function supportsWebSearchGrounding(modelId) {
    const normalized = normalizeModelId(modelId);
    if (!normalized) return false;
    if (IMAGE_WEB_GROUNDING_SUPPORTED_MODELS.has(normalized)) {
        return true;
    }

    // Text-capable models generally support googleSearch tooling.
    if (!isImageGenerationModel(normalized)) {
        return true;
    }

    return false;
}

function buildImageGroundingTools(modelId, grounding) {
    const webSearchEnabled = grounding?.webSearch !== false;
    const imageSearchEnabled = grounding?.imageSearch !== false;

    if (!webSearchEnabled && !imageSearchEnabled) {
        return undefined;
    }

    if (imageSearchEnabled && supportsImageSearchGrounding(modelId)) {
        return [
            {
                googleSearch: {
                    searchTypes: {
                        ...(webSearchEnabled ? { webSearch: {} } : {}),
                        imageSearch: {},
                    },
                },
            },
        ];
    }

    if (webSearchEnabled && supportsWebSearchGrounding(modelId)) {
        return [{ googleSearch: {} }];
    }

    return undefined;
}

export function buildImageChatConfig({ agentConfig, mapThinkingLevel }) {
    const modelId = normalizeModelId(agentConfig?.model);
    const config = {
        systemInstruction: getImageAgentPrompt(),
    };

    if (isImageGenerationModel(modelId)) {
        config.responseModalities = ['TEXT', 'IMAGE'];
    }

    if (typeof mapThinkingLevel === 'function') {
        const thinkingLevel = mapThinkingLevel(agentConfig?.thinkingLevel);
        if (thinkingLevel !== null) {
            config.thinkingConfig = {
                thinkingLevel,
                includeThoughts: true,
            };
        }
    }

    const imageGroundingTools = buildImageGroundingTools(modelId, agentConfig?.grounding);
    if (imageGroundingTools && imageGroundingTools.length > 0) {
        config.tools = imageGroundingTools;
    }

    return config;
}
