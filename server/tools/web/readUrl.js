import { truncateText } from '../_utils.js';
import { URL_CONTENT_MAX_CHARS, URL_CONTENT_CHUNK_SIZE, createUrlDocumentId, cacheUrlContentDocument, splitTextIntoChunks } from './_cache.js';
import { stripHtmlToText, fetchUrlWithCurl } from './_fetch.js';

export const declaration = {
    name: 'read_url_content',
    description: 'Fetch the content of a URL via HTTP request.',
    parameters: {
        type: 'OBJECT',
        properties: {
            Url: {
                type: 'STRING',
                description: 'HTTP or HTTPS URL to fetch.',
            },
            waitForPreviousTools: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
        },
        required: ['Url'],
    },
};

export async function execute({ Url }) {
    const url = String(Url ?? '').trim();
    if (!url) {
        return { error: 'Url is required.' };
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch {
        return { error: `Invalid URL: ${url}` };
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return { error: `Unsupported URL protocol: ${parsedUrl.protocol}` };
    }

    function buildResult({ finalUrl, status, ok, contentType, title, content, transport }) {
        const normalizedContent = String(content ?? '');
        const normalizedFinalUrl = String(finalUrl ?? parsedUrl.toString()) || parsedUrl.toString();
        const documentId = createUrlDocumentId(normalizedFinalUrl, normalizedContent);
        const chunks = splitTextIntoChunks(normalizedContent, URL_CONTENT_CHUNK_SIZE);

        cacheUrlContentDocument(documentId, {
            url: parsedUrl.toString(),
            finalUrl: normalizedFinalUrl,
            contentType: contentType || null,
            title: title || null,
            chunks,
        });

        return {
            url: parsedUrl.toString(),
            finalUrl: normalizedFinalUrl,
            status: Number(status) || null,
            ok: Boolean(ok),
            contentType: contentType || null,
            title: title || null,
            content: truncateText(normalizedContent, URL_CONTENT_MAX_CHARS),
            truncated: normalizedContent.length > URL_CONTENT_MAX_CHARS,
            document_id: documentId,
            total_chunks: chunks.length,
            chunk_size_chars: URL_CONTENT_CHUNK_SIZE,
            transport: transport || 'fetch',
        };
    }

    try {
        const response = await fetch(parsedUrl.toString(), { method: 'GET', redirect: 'follow' });

        const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
        const rawBody = await response.text();
        const content = contentType.includes('text/html') ? stripHtmlToText(rawBody) : rawBody;
        const titleMatch = contentType.includes('text/html')
            ? rawBody.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
            : null;
        const title = titleMatch ? stripHtmlToText(titleMatch[1]) : '';

        return buildResult({
            finalUrl: response.url || parsedUrl.toString(),
            status: response.status,
            ok: response.ok,
            contentType,
            title,
            content,
            transport: 'fetch',
        });
    } catch (error) {
        // Fallback for environments where undici/fetch networking is restricted.
        try {
            const curlResponse = await fetchUrlWithCurl(parsedUrl.toString());
            const contentType = String(curlResponse.contentType ?? '').toLowerCase();
            const rawBody = String(curlResponse.body ?? '');
            const content = contentType.includes('text/html') ? stripHtmlToText(rawBody) : rawBody;
            const titleMatch = contentType.includes('text/html')
                ? rawBody.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
                : null;
            const title = titleMatch ? stripHtmlToText(titleMatch[1]) : '';
            const status = Number(curlResponse.status) || 0;

            return buildResult({
                finalUrl: curlResponse.finalUrl || parsedUrl.toString(),
                status: status || null,
                ok: status >= 200 && status < 300,
                contentType,
                title,
                content,
                transport: 'curl',
            });
        } catch (curlError) {
            return {
                error: `Failed to fetch URL ${parsedUrl.toString()}: ${error.message}; curl fallback failed: ${curlError.message}`,
            };
        }
    }
}
