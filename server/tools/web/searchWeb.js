import { GEMINI_API_KEY, TOOLS_MODEL } from '../../core/config.js';
import { truncateText } from '../_utils.js';

const WEB_SEARCH_RESULT_LIMIT = 8;
const WEB_SEARCH_TEXT_MAX_CHARS = 12_000;

export const declaration = {
    name: 'search_web',
    description: 'Perform a grounded web search and return concise findings with citations.',
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

    if (!GEMINI_API_KEY) {
        return { error: 'Missing GEMINI_API_KEY in environment.' };
    }

    const domainHint = String(domain ?? '').trim();
    const model = String(TOOLS_MODEL ?? '').trim() || 'gemini-3-flash-preview';
    const prompt = domainHint
        ? `${queryText}\n\nPrioritize sources from this domain when relevant: ${domainHint}`
        : queryText;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    let payload;
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                tools: [{ google_search: {} }],
            }),
        });

        payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const errorMessage = String(
                payload?.error?.message ?? payload?.error ?? `Google search request failed with status ${response.status}.`,
            );
            return { error: errorMessage };
        }
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
    return {
        query: queryText,
        domain: domainHint || null,
        model,
        answer: truncateText(displayText, WEB_SEARCH_TEXT_MAX_CHARS),
        truncated: displayText.length > WEB_SEARCH_TEXT_MAX_CHARS,
        web_search_queries: webSearchQueries,
        citations,
        citation_count: citations.length,
    };
}
