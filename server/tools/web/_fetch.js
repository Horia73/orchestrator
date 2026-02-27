import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
