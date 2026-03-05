export function decodeUploadHeaderValue(value) {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
        return '';
    }

    try {
        return decodeURIComponent(normalized);
    } catch {
        return normalized;
    }
}
