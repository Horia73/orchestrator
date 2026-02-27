// Shared utility functions used across multiple tool implementations.

export function normalizeBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    return fallback;
}

export function normalizeInteger(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.trunc(parsed);
}

export function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function globToRegex(globPattern, caseInsensitive = false) {
    const source = String(globPattern ?? '').trim();
    if (!source) return null;

    let regex = '';
    let index = 0;
    while (index < source.length) {
        const current = source[index];
        const next = source[index + 1];

        if (current === '*') {
            if (next === '*') {
                regex += '.*';
                index += 2;
                continue;
            }
            regex += '[^/]*';
            index += 1;
            continue;
        }

        if (current === '?') {
            regex += '.';
            index += 1;
            continue;
        }

        regex += escapeRegex(current);
        index += 1;
    }

    return new RegExp(`^${regex}$`, caseInsensitive ? 'i' : undefined);
}

export function normalizePathForGlob(pathValue) {
    return String(pathValue ?? '').replace(/\\/g, '/');
}

export function toArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    return [value];
}

export function truncateText(text, maxChars) {
    const raw = String(text ?? '');
    if (raw.length <= maxChars) return raw;
    const remaining = raw.length - maxChars;
    return `${raw.slice(0, maxChars)}... [truncated ${remaining} chars]`;
}

export function sleep(ms) {
    return new Promise((resolvePromise) => {
        setTimeout(resolvePromise, ms);
    });
}

export function clampInteger(value, fallback, min, max) {
    const parsed = normalizeInteger(value, fallback);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

export function toLogicalLines(text) {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n');
    if (normalized === '') return [];
    return normalized.split('\n');
}

export function countOccurrences(text, needle) {
    if (!needle) return 0;

    let count = 0;
    let index = 0;
    while (true) {
        const foundIndex = text.indexOf(needle, index);
        if (foundIndex === -1) break;
        count += 1;
        index = foundIndex + needle.length;
    }

    return count;
}

export function extractToolMediaParts(result) {
    if (!result || typeof result !== 'object') {
        return [];
    }

    const rawMediaParts = Array.isArray(result._mediaParts) ? result._mediaParts : [];
    const normalizedMediaParts = [];

    for (const rawPart of rawMediaParts) {
        const inlineData = rawPart?.inlineData;
        if (!inlineData || typeof inlineData !== 'object') {
            continue;
        }

        const mimeType = String(inlineData.mimeType ?? '').trim().toLowerCase();
        const data = String(inlineData.data ?? '').trim();
        if (!mimeType.startsWith('image/') || !data) {
            continue;
        }

        const displayName = String(inlineData.displayName ?? '').trim();
        normalizedMediaParts.push({
            inlineData: {
                mimeType,
                data,
                ...(displayName ? { displayName } : {}),
            },
        });
    }

    return normalizedMediaParts;
}

export function sanitizeToolResultForModel(result) {
    if (!result || typeof result !== 'object') {
        return result;
    }

    const sanitized = {};
    for (const [key, value] of Object.entries(result)) {
        if (key.startsWith('_')) {
            continue;
        }
        sanitized[key] = value;
    }

    return sanitized;
}
