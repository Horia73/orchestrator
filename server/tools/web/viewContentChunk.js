import { normalizeInteger } from '../_utils.js';
import { urlContentChunkCache } from './_cache.js';

export const declaration = {
    name: 'view_content_chunk',
    description: 'View a specific chunk from a previously fetched URL document.',
    parameters: {
        type: 'OBJECT',
        properties: {
            document_id: {
                type: 'STRING',
                description: 'Document ID returned by read_url_content.',
            },
            position: {
                type: 'INTEGER',
                description: '0-indexed chunk position to view.',
            },
            waitForPreviousTools: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
        },
        required: ['document_id', 'position'],
    },
};

export async function execute({ document_id, position }) {
    const documentId = String(document_id ?? '').trim();
    if (!documentId) {
        return { error: 'document_id is required.' };
    }

    const chunkPosition = normalizeInteger(position, NaN);
    if (!Number.isInteger(chunkPosition) || chunkPosition < 0) {
        return { error: 'position must be an integer greater than or equal to 0.' };
    }

    const cachedDocument = urlContentChunkCache.get(documentId);
    if (!cachedDocument) {
        return { error: `Unknown document_id: ${documentId}. Call read_url_content first.` };
    }

    const chunks = Array.isArray(cachedDocument.chunks) ? cachedDocument.chunks : [];
    if (chunkPosition >= chunks.length) {
        return {
            error: `position ${chunkPosition} is out of range. Valid range: 0-${Math.max(0, chunks.length - 1)}.`,
        };
    }

    return {
        document_id: documentId,
        position: chunkPosition,
        total_chunks: chunks.length,
        previous_position: chunkPosition > 0 ? chunkPosition - 1 : null,
        next_position: chunkPosition < chunks.length - 1 ? chunkPosition + 1 : null,
        url: cachedDocument.url ?? null,
        finalUrl: cachedDocument.finalUrl ?? null,
        contentType: cachedDocument.contentType ?? null,
        title: cachedDocument.title ?? null,
        content: String(chunks[chunkPosition] ?? ''),
    };
}
