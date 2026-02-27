import { createHash } from 'node:crypto';

export const URL_CONTENT_CHUNK_SIZE = 4000;
export const URL_CONTENT_MAX_CHARS = 120_000;
const URL_CONTENT_CHUNK_CACHE_LIMIT = 80;

export const urlContentChunkCache = new Map();

export function createUrlDocumentId(url, content) {
    const hash = createHash('sha1')
        .update(String(url ?? ''))
        .update('\n')
        .update(String(content ?? ''))
        .digest('hex')
        .slice(0, 16);
    return `doc_${hash}`;
}

export function cacheUrlContentDocument(documentId, payload) {
    if (!documentId) return;
    if (urlContentChunkCache.has(documentId)) {
        urlContentChunkCache.delete(documentId);
    }
    urlContentChunkCache.set(documentId, {
        ...payload,
        createdAt: Date.now(),
    });

    while (urlContentChunkCache.size > URL_CONTENT_CHUNK_CACHE_LIMIT) {
        const oldestKey = urlContentChunkCache.keys().next().value;
        if (!oldestKey) break;
        urlContentChunkCache.delete(oldestKey);
    }
}

export function splitTextIntoChunks(text, maxChars = URL_CONTENT_CHUNK_SIZE) {
    const source = String(text ?? '');
    if (!source) return [''];
    if (source.length <= maxChars) return [source];

    const chunks = [];
    let cursor = 0;
    while (cursor < source.length) {
        const nextCursor = Math.min(source.length, cursor + maxChars);
        chunks.push(source.slice(cursor, nextCursor));
        cursor = nextCursor;
    }
    return chunks;
}
