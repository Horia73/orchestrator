import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY } from '../../core/config.js';
import { getAgentConfig } from '../../storage/settings.js';
import { buildImageChatConfig } from './api.js';
import { IMAGE_AGENT_ID } from './index.js';

const VALID_ASPECT_RATIOS = new Set([
    '1:1',
    '1:4',
    '1:8',
    '2:3',
    '3:2',
    '3:4',
    '4:1',
    '4:3',
    '4:5',
    '5:4',
    '8:1',
    '9:16',
    '16:9',
    '21:9',
]);

const VALID_IMAGE_SIZES = new Set(['512px', '1K', '2K', '4K']);

let cachedClient = null;

function getClient() {
    if (!GEMINI_API_KEY) {
        throw new Error('Missing GEMINI_API_KEY or VITE_GEMINI_API_KEY in environment.');
    }

    if (!cachedClient) {
        cachedClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    }

    return cachedClient;
}

function normalizeModelId(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    if (raw.startsWith('models/')) {
        return raw.slice('models/'.length);
    }
    return raw;
}

function normalizePrompt(value) {
    return String(value ?? '').trim();
}

function normalizeAspectRatio(value) {
    const normalized = String(value ?? '').trim();
    if (VALID_ASPECT_RATIOS.has(normalized)) {
        return normalized;
    }

    return '';
}

function normalizeImageSize(value) {
    const normalized = String(value ?? '').trim();
    if (VALID_IMAGE_SIZES.has(normalized)) {
        return normalized;
    }

    return '';
}

function getResponseParts(response) {
    const candidateParts = response?.candidates?.[0]?.content?.parts;
    if (Array.isArray(candidateParts) && candidateParts.length > 0) {
        return candidateParts;
    }

    if (Array.isArray(response?.parts) && response.parts.length > 0) {
        return response.parts;
    }

    return [];
}

function normalizeInlineDataPart(part, index) {
    const inlineData = part?.inlineData ?? part?.inline_data;
    if (!inlineData || typeof inlineData !== 'object') {
        return null;
    }

    const mimeType = String(inlineData.mimeType ?? inlineData.mime_type ?? '').trim().toLowerCase();
    const data = String(inlineData.data ?? '').trim();
    if (!mimeType.startsWith('image/') || !data) {
        return null;
    }

    const displayName = String(inlineData.displayName ?? inlineData.display_name ?? '').trim()
        || `image-${index + 1}.png`;

    return {
        inlineData: {
            mimeType,
            data,
            displayName,
        },
    };
}

function extractGroundingSummary(response) {
    const candidate = response?.candidates?.[0] ?? null;
    const metadata = candidate?.groundingMetadata ?? candidate?.grounding_metadata ?? {};
    const webSearchQueries = Array.isArray(metadata.webSearchQueries ?? metadata.web_search_queries)
        ? (metadata.webSearchQueries ?? metadata.web_search_queries)
        : [];
    const imageSearchQueries = Array.isArray(metadata.imageSearchQueries ?? metadata.image_search_queries)
        ? (metadata.imageSearchQueries ?? metadata.image_search_queries)
        : [];
    const rawChunks = Array.isArray(metadata.groundingChunks ?? metadata.grounding_chunks)
        ? (metadata.groundingChunks ?? metadata.grounding_chunks)
        : [];

    const citations = [];
    const seenUris = new Set();
    for (const chunk of rawChunks) {
        const web = chunk?.web ?? {};
        const image = chunk?.image ?? {};
        const uri = String(
            web?.uri
            ?? image?.uri
            ?? chunk?.uri
            ?? '',
        ).trim();
        if (!uri || seenUris.has(uri)) {
            continue;
        }

        seenUris.add(uri);
        citations.push({
            uri,
            title: String(web?.title ?? chunk?.title ?? uri).trim() || uri,
            imageUri: String(image?.imageUri ?? image?.image_uri ?? '').trim() || null,
        });
    }

    return {
        webSearchQueries,
        imageSearchQueries,
        citations,
        used: webSearchQueries.length > 0 || imageSearchQueries.length > 0 || citations.length > 0,
    };
}

function extractUsageMetadata(response) {
    const usageMetadata = response?.usageMetadata ?? response?.usage_metadata;
    if (!usageMetadata || typeof usageMetadata !== 'object') {
        return null;
    }

    return usageMetadata;
}

export async function generateImageWithAgent({
    prompt,
    model,
    aspectRatio,
    imageSize,
} = {}) {
    const normalizedPrompt = normalizePrompt(prompt);
    if (!normalizedPrompt) {
        throw new Error('prompt is required.');
    }

    const defaultAgentConfig = getAgentConfig(IMAGE_AGENT_ID);
    const resolvedModel = normalizeModelId(model) || normalizeModelId(defaultAgentConfig?.model);
    if (!resolvedModel) {
        throw new Error('Image agent model is not configured.');
    }

    const agentConfig = {
        ...defaultAgentConfig,
        model: resolvedModel,
    };
    const baseConfig = buildImageChatConfig({ agentConfig });
    const requestConfig = {
        ...(baseConfig ?? {}),
    };

    const normalizedAspectRatio = normalizeAspectRatio(aspectRatio);
    const normalizedImageSize = normalizeImageSize(imageSize);
    if (normalizedAspectRatio || normalizedImageSize) {
        requestConfig.imageConfig = {
            ...(requestConfig.imageConfig ?? {}),
            ...(normalizedAspectRatio ? { aspectRatio: normalizedAspectRatio } : {}),
            ...(normalizedImageSize ? { imageSize: normalizedImageSize } : {}),
        };
    }

    const requestPayload = {
        model: resolvedModel,
        contents: normalizedPrompt,
    };
    if (Object.keys(requestConfig).length > 0) {
        requestPayload.config = requestConfig;
    }

    const response = await getClient().models.generateContent(requestPayload);
    const responseParts = getResponseParts(response);

    const textParts = [];
    const thoughtParts = [];
    const mediaParts = [];
    for (let index = 0; index < responseParts.length; index += 1) {
        const part = responseParts[index];
        if (part?.thought === true) {
            if (typeof part?.text === 'string' && part.text.trim()) {
                thoughtParts.push(part.text);
            }
            continue;
        }

        if (typeof part?.text === 'string' && part.text.trim()) {
            textParts.push(part.text);
        }

        const mediaPart = normalizeInlineDataPart(part, index);
        if (mediaPart) {
            mediaParts.push(mediaPart);
        }
    }

    return {
        model: resolvedModel,
        text: textParts.join('').trim(),
        thought: thoughtParts.join('').trim(),
        mediaParts,
        imageCount: mediaParts.length,
        grounding: extractGroundingSummary(response),
        usageMetadata: extractUsageMetadata(response),
    };
}
