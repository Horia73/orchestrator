import { getGeminiApiKey, getToolsModel } from '../../core/config.js';
import { retryOnRateLimit } from '../../core/rateLimit.js';
import { truncateText } from '../_utils.js';
import { extractFeaturedImagesFromHtml, fetchUrlWithCurl } from './_fetch.js';

const WEB_SEARCH_RESULT_LIMIT = 8;
const WEB_SEARCH_TEXT_MAX_CHARS = 12_000;
const CITATION_METADATA_ENRICH_LIMIT = 5;

function parseHtmlTitle(html) {
    const titleMatch = String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleMatch) {
        return '';
    }

    return String(titleMatch[1] ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function enrichCitation(citation) {
    const uri = String(citation?.uri ?? '').trim();
    if (!uri) {
        return citation;
    }

    try {
        const response = await fetchUrlWithCurl(uri);
        const contentType = String(response?.contentType ?? '').toLowerCase();
        const finalUrl = String(response?.finalUrl ?? uri).trim() || uri;
        if (!contentType.includes('text/html')) {
            return {
                ...citation,
                final_url: finalUrl,
                featured_image_url: null,
                featured_image_alt: null,
                image_candidates: [],
            };
        }

        const rawBody = String(response?.body ?? '');
        const imageInfo = extractFeaturedImagesFromHtml(rawBody, finalUrl);
        const pageTitle = parseHtmlTitle(rawBody);

        return {
            ...citation,
            title: pageTitle || citation.title,
            final_url: finalUrl,
            featured_image_url: imageInfo.featuredImageUrl || null,
            featured_image_alt: imageInfo.featuredImageAlt || null,
            image_candidates: Array.isArray(imageInfo.imageCandidates) ? imageInfo.imageCandidates : [],
        };
    } catch {
        return citation;
    }
}

export const declaration = {
    name: 'search_web',
    description: 'Perform a grounded web search and return concise findings with citations. For top cited HTML pages, also attempts to return exact-page image metadata in the same tool call.',
    parameters: {
        type: 'OBJECT',
        properties: {
            query: {
                type: 'STRING',
                description: 'Search query to run on the web.',
            },
            domain: {
                type: 'STRING',
                description: 'Optional domain hint to prioritize (e.g. docs.example.com).',
            },
            waitForPreviousTools: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
        },
        required: ['query'],
    },
};

export async function execute({ query, domain }) {
    const queryText = String(query ?? '').trim();
    if (!queryText) {
        return { error: 'query is required.' };
    }

    const apiKey = getGeminiApiKey();
    if (!apiKey) {
        return { error: 'Missing GEMINI_API_KEY in environment or config.' };
    }

    const domainHint = String(domain ?? '').trim();
    const model = String(getToolsModel() ?? '').trim() || 'gemini-3-flash-preview';
    const prompt = domainHint
        ? `${queryText}\n\nPrioritize sources from this domain when relevant: ${domainHint}`
        : queryText;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let payload;
    try {
        payload = await retryOnRateLimit(async () => {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    tools: [{ google_search: {} }],
                }),
            });

            const nextPayload = await response.json().catch(() => ({}));
            if (!response.ok) {
                const errorMessage = String(
                    nextPayload?.error?.message ?? nextPayload?.error ?? `Google search request failed with status ${response.status}.`,
                );
                const failure = new Error(errorMessage);
                failure.code = response.status;
                failure.status = response.status;
                throw failure;
            }

            return nextPayload;
        });
    } catch (error) {
        return { error: `Failed to call grounded search: ${error.message}` };
    }

    const candidate = payload?.candidates?.[0] ?? {};
    const responseParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const answerText = responseParts
        .filter((part) => typeof part?.text === 'string' && part.thought !== true)
        .map((part) => part.text)
        .join('')
        .trim();

    const groundingMetadata = candidate?.groundingMetadata ?? candidate?.grounding_metadata ?? {};
    const webSearchQueries = Array.isArray(groundingMetadata?.webSearchQueries ?? groundingMetadata?.web_search_queries)
        ? (groundingMetadata.webSearchQueries ?? groundingMetadata.web_search_queries)
        : [];
    const rawChunks = Array.isArray(groundingMetadata?.groundingChunks ?? groundingMetadata?.grounding_chunks)
        ? (groundingMetadata.groundingChunks ?? groundingMetadata.grounding_chunks)
        : [];

    const citations = [];
    const seenUris = new Set();
    for (const chunk of rawChunks) {
        const web = chunk?.web ?? {};
        const uri = String(web?.uri ?? '').trim();
        if (!uri || seenUris.has(uri)) continue;
        seenUris.add(uri);
        citations.push({ title: String(web?.title ?? '').trim() || uri, uri });
        if (citations.length >= WEB_SEARCH_RESULT_LIMIT) break;
    }

    const displayText = answerText || 'No grounded answer text returned.';
    const enrichedCitations = await Promise.all(
        citations.map((citation, index) => (
            index < CITATION_METADATA_ENRICH_LIMIT
                ? enrichCitation(citation)
                : Promise.resolve(citation)
        )),
    );
    const usageMetadata = payload?.usageMetadata && typeof payload.usageMetadata === 'object'
        ? payload.usageMetadata
        : null;

    return {
        query: queryText,
        domain: domainHint || null,
        model,
        answer: truncateText(displayText, WEB_SEARCH_TEXT_MAX_CHARS),
        truncated: displayText.length > WEB_SEARCH_TEXT_MAX_CHARS,
        web_search_queries: webSearchQueries,
        citations: enrichedCitations,
        citation_count: enrichedCitations.length,
        _usage: {
            source: 'model',
            model,
            inputText: queryText,
            outputText: truncateText(displayText, 4000),
            usageMetadata,
        },
    };
}
