import { readModelCatalog } from '../services/modelCatalog.js';

const TOKEN_MILLION = 1_000_000;
const CONTEXT_WINDOW_THRESHOLD = 200_000;

function toFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function firstFiniteNumber(...values) {
    for (const value of values) {
        const parsed = toFiniteNumber(value);
        if (parsed !== undefined) {
            return parsed;
        }
    }

    return undefined;
}

function normalizeModelId(value) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return 'unknown-model';
    }

    if (raw.startsWith('models/')) {
        return raw.slice('models/'.length);
    }

    return raw;
}

function normalizePricingEntry(rawEntry = {}) {
    if (!rawEntry || typeof rawEntry !== 'object') {
        return {};
    }

    const normalized = {
        inputPrice200k: firstFiniteNumber(rawEntry.inputPrice200k, rawEntry.inputPrice),
        inputPriceOver200k: firstFiniteNumber(rawEntry.inputPriceOver200k),
        outputPrice200k: firstFiniteNumber(rawEntry.outputPrice200k, rawEntry.outputPrice),
        outputPriceOver200k: firstFiniteNumber(rawEntry.outputPriceOver200k),
        outputTextPrice200k: firstFiniteNumber(rawEntry.outputTextPrice200k, rawEntry.outputPriceText),
        outputImagePrice200k: firstFiniteNumber(rawEntry.outputImagePrice200k),
        outputImagePricePerImage: firstFiniteNumber(rawEntry.outputImagePricePerImage, rawEntry.outputPriceImage),
        outputImagePrice1K: firstFiniteNumber(rawEntry.outputImagePrice1K),
        outputImagePrice2K: firstFiniteNumber(rawEntry.outputImagePrice2K),
        outputImagePrice4K: firstFiniteNumber(rawEntry.outputImagePrice4K),
        outputAudioPrice: firstFiniteNumber(rawEntry.outputAudioPrice),
        outputPricePerSecond: firstFiniteNumber(rawEntry.outputPricePerSecond),
        pricePerQuery: firstFiniteNumber(rawEntry.pricePerQuery),
        groundingPricePer1k: firstFiniteNumber(rawEntry.groundingPricePer1k),
        defaultImageTokensPerOutput: firstFiniteNumber(rawEntry.defaultImageTokensPerOutput),
        contextWindow: firstFiniteNumber(rawEntry.contextWindow),
    };

    const name = String(rawEntry.name ?? rawEntry.displayName ?? '').trim();
    if (name) {
        normalized.displayName = name;
    }

    const note = String(rawEntry.note ?? '').trim();
    if (note) {
        normalized.note = note;
    }

    return Object.fromEntries(
        Object.entries(normalized).filter(([, value]) => value !== undefined && value !== ''),
    );
}

export function getModelPricing() {
    const catalog = readModelCatalog();
    const pricing = {};

    for (const [modelId, rawEntry] of Object.entries(catalog)) {
        const normalizedId = normalizeModelId(rawEntry?.id ?? modelId);
        if (!normalizedId || normalizedId === 'unknown-model') {
            continue;
        }

        pricing[normalizedId] = normalizePricingEntry(rawEntry);
    }

    return pricing;
}

function toTokenCount(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
    }

    return Math.trunc(parsed);
}

function toUsd(tokens, usdPerMillion) {
    if (!Number.isFinite(usdPerMillion) || tokens <= 0) {
        return 0;
    }

    return (tokens / TOKEN_MILLION) * usdPerMillion;
}

function toImageCount(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
    }

    return Math.trunc(parsed);
}

function normalizeModality(value) {
    return String(value ?? '').trim().toUpperCase();
}

function sumModalityTokens(details, allowedModalities = new Set()) {
    if (!Array.isArray(details) || allowedModalities.size === 0) {
        return 0;
    }

    return details.reduce((sum, item) => {
        const modality = normalizeModality(item?.modality);
        if (!allowedModalities.has(modality)) {
            return sum;
        }

        return sum + toTokenCount(item?.tokenCount);
    }, 0);
}

export function normalizeUsageMetadata(usageMetadata) {
    const promptTokenCount = toTokenCount(usageMetadata?.promptTokenCount);
    const toolUsePromptTokenCount = toTokenCount(usageMetadata?.toolUsePromptTokenCount);
    const candidatesTokenCount = toTokenCount(
        usageMetadata?.candidatesTokenCount ?? usageMetadata?.responseTokenCount,
    );
    const thoughtsTokenCount = toTokenCount(usageMetadata?.thoughtsTokenCount);
    const explicitImageOutputTokens = toTokenCount(
        usageMetadata?.imageOutputTokens ?? usageMetadata?.outputImageTokens,
    );
    const explicitTextOutputTokens = toTokenCount(
        usageMetadata?.textOutputTokens ?? usageMetadata?.outputTextTokens,
    );

    const candidatesTokensDetails = Array.isArray(usageMetadata?.candidatesTokensDetails)
        ? usageMetadata.candidatesTokensDetails
        : [];

    const imageOutputTokensFromDetails = sumModalityTokens(
        candidatesTokensDetails,
        new Set(['IMAGE']),
    );
    const imageOutputTokens = explicitImageOutputTokens > 0
        ? explicitImageOutputTokens
        : imageOutputTokensFromDetails;

    const textOutputTokensFromDetails = sumModalityTokens(
        candidatesTokensDetails,
        new Set(['TEXT']),
    );

    const textOutputTokens = explicitTextOutputTokens > 0
        ? explicitTextOutputTokens
        : (textOutputTokensFromDetails > 0
            ? textOutputTokensFromDetails
            : Math.max(0, candidatesTokenCount - imageOutputTokens));

    let imageOutputCount = toImageCount(
        usageMetadata?.candidatesImageCount
        ?? usageMetadata?.imageCount
        ?? usageMetadata?.outputImageCount,
    );

    if (!imageOutputCount && imageOutputTokens > 0) {
        // 2.5 Flash Image defaults to ~1290 output tokens per image.
        imageOutputCount = Math.max(1, Math.round(imageOutputTokens / 1290));
    }

    let totalTokenCount = toTokenCount(usageMetadata?.totalTokenCount);
    if (!totalTokenCount) {
        totalTokenCount = (
            promptTokenCount
            + toolUsePromptTokenCount
            + candidatesTokenCount
            + thoughtsTokenCount
        );
    }

    return {
        promptTokenCount,
        candidatesTokenCount,
        thoughtsTokenCount,
        toolUsePromptTokenCount,
        totalTokenCount,
        textOutputTokens,
        imageOutputTokens,
        imageOutputCount,
    };
}

function resolveRate(pricing, baseName, isOver200kContext) {
    const overName = baseName.endsWith('200k')
        ? baseName.replace(/200k$/, 'Over200k')
        : `${baseName}Over200k`;
    if (isOver200kContext && Number.isFinite(pricing?.[overName])) {
        return pricing[overName];
    }

    return pricing?.[baseName];
}

export function estimateUsageCost({ model, usageMetadata } = {}) {
    const modelId = normalizeModelId(model);
    const usage = normalizeUsageMetadata(usageMetadata);
    const inputTokens = usage.promptTokenCount + usage.toolUsePromptTokenCount;
    const outputTokens = usage.candidatesTokenCount;
    const billableOutputTextTokens = usage.textOutputTokens + usage.thoughtsTokenCount;

    const pricing = getModelPricing()[modelId];
    if (!pricing) {
        return {
            modelId,
            priced: false,
            inputTokens,
            outputTokens,
            thoughtsTokens: usage.thoughtsTokenCount,
            toolUsePromptTokens: usage.toolUsePromptTokenCount,
            totalTokens: usage.totalTokenCount,
            inputCostUsd: 0,
            outputCostUsd: 0,
            totalCostUsd: 0,
            outputImageTokens: usage.imageOutputTokens,
            outputImageCount: usage.imageOutputCount,
        };
    }

    const isOver200kContext = inputTokens > CONTEXT_WINDOW_THRESHOLD;
    const inputRate = resolveRate(pricing, 'inputPrice200k', isOver200kContext);

    let outputRate = resolveRate(pricing, 'outputPrice200k', isOver200kContext);
    if (!Number.isFinite(outputRate)) {
        outputRate = resolveRate(pricing, 'outputTextPrice200k', isOver200kContext);
    }

    const imageOutputRate = resolveRate(pricing, 'outputImagePrice200k', isOver200kContext);
    const imageOutputPricePerImage = pricing.outputImagePricePerImage;
    const hasExplicitImageTokens = usage.imageOutputTokens > 0;
    const inferredImageTokens = hasExplicitImageTokens
        ? usage.imageOutputTokens
        : (
            (Number.isFinite(imageOutputRate) || Number.isFinite(imageOutputPricePerImage))
                && outputTokens > 0
                ? outputTokens
                : 0
        );
    const outputTextTokensForPricing = hasExplicitImageTokens
        ? billableOutputTextTokens
        : Math.max(0, billableOutputTextTokens - inferredImageTokens);

    const inputCostUsd = toUsd(inputTokens, inputRate);
    const outputTextCostUsd = toUsd(outputTextTokensForPricing, outputRate);

    let outputImageCostUsd = 0;
    if (Number.isFinite(imageOutputPricePerImage)) {
        const detectedImageCount = usage.imageOutputCount > 0
            ? usage.imageOutputCount
            : (inferredImageTokens > 0 && Number.isFinite(pricing.defaultImageTokensPerOutput)
                ? Math.max(1, Math.round(inferredImageTokens / pricing.defaultImageTokensPerOutput))
                : 0);
        outputImageCostUsd = detectedImageCount * imageOutputPricePerImage;
    } else {
        outputImageCostUsd = toUsd(inferredImageTokens, imageOutputRate);
    }

    const outputCostUsd = outputTextCostUsd + outputImageCostUsd;

    return {
        modelId,
        priced: true,
        inputTokens,
        outputTokens,
        thoughtsTokens: usage.thoughtsTokenCount,
        toolUsePromptTokens: usage.toolUsePromptTokenCount,
        totalTokens: usage.totalTokenCount,
        inputCostUsd,
        outputCostUsd,
        totalCostUsd: inputCostUsd + outputCostUsd,
        inputRate,
        outputRate,
        outputImageRate: imageOutputRate,
        outputImagePricePerImage: imageOutputPricePerImage,
        outputImageTokens: inferredImageTokens,
        outputImageCount: usage.imageOutputCount,
        isOver200kContext,
    };
}
