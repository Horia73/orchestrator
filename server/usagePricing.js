const TOKEN_MILLION = 1_000_000;
const CONTEXT_WINDOW_THRESHOLD = 200_000;

const MODEL_PRICING = {
    'gemini-3.1-pro-preview': {
        inputPrice200k: 2.00,
        inputPriceOver200k: 4.00,
        outputPrice200k: 12.00,
        outputPriceOver200k: 18.00,
    },
    'gemini-3-pro-preview': {
        inputPrice200k: 2.00,
        inputPriceOver200k: 4.00,
        outputPrice200k: 12.00,
        outputPriceOver200k: 18.00,
    },
    'gemini-3-flash-preview': {
        inputPrice200k: 0.50,
        outputPrice200k: 3.00,
    },
    'gemini-2.5-pro': {
        inputPrice200k: 1.25,
        inputPriceOver200k: 2.50,
        outputPrice200k: 10.00,
        outputPriceOver200k: 15.00,
    },
    'gemini-2.5-flash': {
        inputPrice200k: 0.30,
        outputPrice200k: 2.50,
    },
    'gemini-2.5-flash-lite': {
        inputPrice200k: 0.10,
        outputPrice200k: 0.40,
    },
    'gemini-2.0-flash': {
        inputPrice200k: 0.10,
        outputPrice200k: 0.40,
    },
    'gemini-2.0-flash-lite': {
        inputPrice200k: 0.075,
        outputPrice200k: 0.30,
    },
};

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

export function normalizeUsageMetadata(usageMetadata) {
    const promptTokenCount = toTokenCount(usageMetadata?.promptTokenCount);
    const toolUsePromptTokenCount = toTokenCount(usageMetadata?.toolUsePromptTokenCount);
    const candidatesTokenCount = toTokenCount(
        usageMetadata?.candidatesTokenCount ?? usageMetadata?.responseTokenCount,
    );
    const thoughtsTokenCount = toTokenCount(usageMetadata?.thoughtsTokenCount);

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
    };
}

export function estimateUsageCost({ model, usageMetadata } = {}) {
    const modelId = normalizeModelId(model);
    const usage = normalizeUsageMetadata(usageMetadata);
    const inputTokens = usage.promptTokenCount + usage.toolUsePromptTokenCount;
    const outputTokens = usage.candidatesTokenCount;
    const billableOutputTokens = outputTokens + usage.thoughtsTokenCount;

    const pricing = MODEL_PRICING[modelId];
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
        };
    }

    const isOver200kContext = inputTokens > CONTEXT_WINDOW_THRESHOLD;
    const inputRate = isOver200kContext && Number.isFinite(pricing.inputPriceOver200k)
        ? pricing.inputPriceOver200k
        : pricing.inputPrice200k;
    const outputRate = isOver200kContext && Number.isFinite(pricing.outputPriceOver200k)
        ? pricing.outputPriceOver200k
        : pricing.outputPrice200k;

    const inputCostUsd = toUsd(inputTokens, inputRate);
    const outputCostUsd = toUsd(billableOutputTokens, outputRate);

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
        isOver200kContext,
    };
}
