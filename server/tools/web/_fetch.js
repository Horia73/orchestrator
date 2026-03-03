import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function decodeHtmlEntities(value) {
    return String(value ?? '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'');
}

export function stripHtmlToText(html) {
    const withoutScripts = html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');

    const withLineBreaks = withoutScripts
        .replace(/<\/(p|div|h\d|li|tr|section|article|header|footer)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n');

    const withoutTags = withLineBreaks.replace(/<[^>]+>/g, ' ');

    return withoutTags
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, '\'')
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function toAbsoluteUrl(candidate, baseUrl) {
    const raw = String(candidate ?? '').trim();
    if (!raw) return '';

    try {
        return new URL(raw, baseUrl).toString();
    } catch {
        return '';
    }
}

function sanitizeImageCandidate({ url, alt = '', source = '' } = {}) {
    const normalizedUrl = String(url ?? '').trim();
    if (!normalizedUrl) return null;

    return {
        url: normalizedUrl,
        alt: decodeHtmlEntities(String(alt ?? '').trim()),
        source: String(source ?? '').trim() || 'page',
    };
}

function extractMetaContents(html, attrPattern) {
    const regex = new RegExp(
        `<meta[^>]+${attrPattern}[^>]+content=["']([^"']+)["'][^>]*>`,
        'gi',
    );
    const values = [];
    let match = regex.exec(html);
    while (match) {
        values.push(decodeHtmlEntities(match[1]));
        match = regex.exec(html);
    }
    return values;
}

function extractLinkHrefs(html, relPattern) {
    const regex = new RegExp(
        `<link[^>]+rel=["'][^"']*${relPattern}[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>`,
        'gi',
    );
    const values = [];
    let match = regex.exec(html);
    while (match) {
        values.push(decodeHtmlEntities(match[1]));
        match = regex.exec(html);
    }
    return values;
}

function extractImgTags(html) {
    const regex = /<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
    const images = [];
    let match = regex.exec(html);
    while (match) {
        const tag = match[0];
        const src = decodeHtmlEntities(match[1]);
        const altMatch = tag.match(/\balt=["']([^"']*)["']/i);
        images.push({
            src,
            alt: altMatch ? decodeHtmlEntities(altMatch[1]) : '',
        });
        match = regex.exec(html);
    }
    return images;
}

function extractJsonLdImages(html) {
    const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
    const images = [];

    function collectImageValue(value) {
        if (!value) return;

        if (typeof value === 'string') {
            images.push({ url: decodeHtmlEntities(value), alt: '', source: 'json-ld' });
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) collectImageValue(item);
            return;
        }

        if (typeof value === 'object') {
            const directUrl = String(
                value.url
                ?? value.contentUrl
                ?? value.contentURL
                ?? '',
            ).trim();
            if (directUrl) {
                images.push({
                    url: decodeHtmlEntities(directUrl),
                    alt: decodeHtmlEntities(String(value.caption ?? value.name ?? '').trim()),
                    source: 'json-ld',
                });
            }
        }
    }

    function walk(node) {
        if (!node || typeof node !== 'object') return;

        if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
        }

        if ('image' in node) {
            collectImageValue(node.image);
        }
        if ('thumbnailUrl' in node) {
            collectImageValue(node.thumbnailUrl);
        }
        if ('thumbnailURL' in node) {
            collectImageValue(node.thumbnailURL);
        }

        for (const value of Object.values(node)) {
            if (value && typeof value === 'object') {
                walk(value);
            }
        }
    }

    for (const script of scripts) {
        const jsonText = script
            .replace(/^<script[^>]*>/i, '')
            .replace(/<\/script>$/i, '')
            .trim();

        if (!jsonText) continue;

        try {
            walk(JSON.parse(jsonText));
        } catch {
            // ignore malformed JSON-LD
        }
    }

    return images;
}

export function extractFeaturedImagesFromHtml(html, baseUrl) {
    const source = String(html ?? '');
    const base = String(baseUrl ?? '').trim();
    if (!source || !base) {
        return {
            featuredImageUrl: '',
            featuredImageAlt: '',
            imageCandidates: [],
        };
    }

    const ogImageAlt = extractMetaContents(source, `(?:property|name)=["']og:image:alt["']`)[0] ?? '';
    const twitterImageAlt = extractMetaContents(source, `(?:property|name)=["']twitter:image:alt["']`)[0] ?? '';

    const rawCandidates = [
        ...extractMetaContents(source, `(?:property|name)=["']og:image(?::url)?["']`).map((url) => ({
            url,
            alt: ogImageAlt,
            source: 'og:image',
        })),
        ...extractMetaContents(source, `(?:property|name)=["']twitter:image(?::src)?["']`).map((url) => ({
            url,
            alt: twitterImageAlt,
            source: 'twitter:image',
        })),
        ...extractLinkHrefs(source, 'image_src').map((url) => ({
            url,
            alt: '',
            source: 'link:image_src',
        })),
        ...extractJsonLdImages(source),
        ...extractImgTags(source).slice(0, 6).map((image) => ({
            url: image.src,
            alt: image.alt,
            source: 'img',
        })),
    ];

    const imageCandidates = [];
    const seen = new Set();
    for (const candidate of rawCandidates) {
        const absoluteUrl = toAbsoluteUrl(candidate.url, base);
        const sanitized = sanitizeImageCandidate({
            url: absoluteUrl,
            alt: candidate.alt,
            source: candidate.source,
        });
        if (!sanitized) continue;

        const key = sanitized.url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        imageCandidates.push(sanitized);
        if (imageCandidates.length >= 8) {
            break;
        }
    }

    return {
        featuredImageUrl: imageCandidates[0]?.url ?? '',
        featuredImageAlt: imageCandidates[0]?.alt ?? '',
        imageCandidates,
    };
}

export async function fetchUrlWithCurl(url) {
    const marker = '__ORCH_CURL_META__';
    const args = [
        '-L',
        '-sS',
        '--max-time', '20',
        '-w', `\n${marker}%{http_code}|%{content_type}|%{url_effective}`,
        url,
    ];

    const { stdout } = await execFileAsync('curl', args, {
        maxBuffer: 15 * 1024 * 1024,
    });

    const output = String(stdout ?? '');
    const markerIndex = output.lastIndexOf(`\n${marker}`);
    if (markerIndex === -1) {
        return {
            status: null,
            contentType: '',
            finalUrl: url,
            body: output,
        };
    }

    const body = output.slice(0, markerIndex);
    const metaRaw = output.slice(markerIndex + 1 + marker.length).trim();
    const [statusRaw, contentTypeRaw, finalUrlRaw] = metaRaw.split('|');

    return {
        status: Number(statusRaw) || null,
        contentType: String(contentTypeRaw ?? ''),
        finalUrl: String(finalUrlRaw ?? url) || url,
        body,
    };
}
