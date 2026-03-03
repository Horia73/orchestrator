function extractErrorText(error) {
    if (typeof error === 'string') {
        return error;
    }

    if (error instanceof Error && error.message) {
        return error.message;
    }

    try {
        return JSON.stringify(error ?? '');
    } catch {
        return String(error ?? '');
    }
}

function extractWithPatterns(text, patterns) {
    const source = String(text ?? '');
    for (const pattern of patterns) {
        const match = source.match(pattern);
        if (match?.[1]) {
            return match[1];
        }
    }
    return '';
}

export function isRateLimitError(error) {
    const text = extractErrorText(error);
    const code = Number(error?.code ?? error?.status ?? error?.error?.code);
    return code === 429 || /RESOURCE_EXHAUSTED/i.test(text) || /\b429\b/.test(text);
}

export function extractRateLimitMetadata(error) {
    const text = extractErrorText(error);
    const retryDelaySeconds = Number.parseFloat(extractWithPatterns(text, [
        /retryDelay[^0-9]*([\d.]+)s/i,
        /Please retry in[^0-9]*([\d.]+)s/i,
        /retry in[^0-9]*([\d.]+)s/i,
    ]));
    const quotaMetric = extractWithPatterns(text, [
        /quotaMetric"\s*:\s*"([^"]+)"/i,
        /Quota exceeded for metric:\s*([^,\s]+)/i,
    ]);
    const quotaId = extractWithPatterns(text, [
        /quotaId"\s*:\s*"([^"]+)"/i,
    ]);
    const model = extractWithPatterns(text, [
        /"model"\s*:\s*"([^"]+)"/i,
        /model:\s*([A-Za-z0-9._-]+)/i,
    ]);
    const isMinuteQuota = /PerMinute|per minute|\/minute/i.test(text) || /retryDelay/i.test(text);
    const isTokenQuota = /token/i.test(quotaMetric) || /token/i.test(quotaId) || /token/i.test(text);

    return {
        text,
        retryDelayMs: Number.isFinite(retryDelaySeconds) ? Math.ceil(retryDelaySeconds * 1000) : null,
        quotaMetric: quotaMetric || '',
        quotaId: quotaId || '',
        model: model || '',
        isMinuteQuota,
        isTokenQuota,
    };
}

export function computeRateLimitDelayMs(error, attempt = 0) {
    const meta = extractRateLimitMetadata(error);
    const fallbackMs = Math.min(5000 * (2 ** attempt), 90000);
    let waitMs = meta.retryDelayMs ?? fallbackMs;

    if (meta.isTokenQuota) {
        waitMs = Math.max(waitMs + 5000, 15000);
    }

    if (meta.isMinuteQuota) {
        waitMs = Math.max(waitMs, 35000);
    }

    waitMs += Math.min(attempt * 2500, 10000);
    waitMs += Math.floor(Math.random() * 1000);

    return Math.min(waitMs, 120000);
}

function buildRateLimitError({ error, attempts, totalWaitMs }) {
    const meta = extractRateLimitMetadata(error);
    const retrySeconds = meta.retryDelayMs ? Math.ceil(meta.retryDelayMs / 1000) : null;
    const summary = [
        `Rate limit exceeded after ${attempts} attempt${attempts === 1 ? '' : 's'}.`,
        meta.quotaMetric ? `Quota: ${meta.quotaMetric}.` : '',
        meta.model ? `Model: ${meta.model}.` : '',
        retrySeconds ? `Suggested retry in about ${retrySeconds}s.` : 'Retry later.',
        totalWaitMs > 0 ? `Waited ${Math.ceil(totalWaitMs / 1000)}s before giving up.` : '',
    ].filter(Boolean).join(' ');

    const wrapped = new Error(summary);
    wrapped.code = 429;
    wrapped.status = 'RESOURCE_EXHAUSTED';
    wrapped.cause = error;
    wrapped.retryDelayMs = meta.retryDelayMs;
    wrapped.quotaMetric = meta.quotaMetric;
    wrapped.quotaId = meta.quotaId;
    wrapped.model = meta.model;
    return wrapped;
}

export async function retryOnRateLimit(fn, { maxRetries = 5, onWaiting } = {}) {
    let totalWaitMs = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            if (!isRateLimitError(error)) {
                throw error;
            }

            if (attempt === maxRetries) {
                throw buildRateLimitError({
                    error,
                    attempts: attempt + 1,
                    totalWaitMs,
                });
            }

            const waitMs = computeRateLimitDelayMs(error, attempt);
            totalWaitMs += waitMs;

            if (onWaiting) {
                await onWaiting(waitMs, extractRateLimitMetadata(error));
            }

            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
    }
}
