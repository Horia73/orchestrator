export class ReadUrlToolClient {
    constructor(config = {}, { onLog } = {}) {
        this.config = config;
        this.onLog = typeof onLog === 'function' ? onLog : null;
    }

    async runTask({ goal, signal }) {
        const url = String(goal || '').trim();
        if (!url || !url.startsWith('http')) {
            return {
                ok: false,
                agent: 'read_url',
                goal: url,
                error: 'Invalid or missing URL. Must start with http:// or https://',
                summary: 'Invalid URL provided.'
            };
        }

        this.onLog?.({
            level: 'info',
            component: 'read-url-tool',
            event: 'agent_task_started',
            message: `Fetching URL: ${url}`,
        });

        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; AgentStack/1.0)',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                signal,
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const html = await response.text();

            // Simple HTML to Markdown conversion (strip scripts, styles, get text)
            // For more robust conversion, we'd use a library like turndown,
            // but a basic regex-based fallback works for essential readable text.
            const markdown = this._basicHtmlToMarkdown(html);

            this.onLog?.({
                level: 'info',
                component: 'read-url-tool',
                event: 'agent_task_completed',
                message: `Successfully fetched and parsed URL: ${url}`,
            });

            return {
                ok: true,
                agent: 'read_url',
                goal: url,
                summary: `Read ${markdown.length} characters from ${url}`,
                text: markdown,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            this.onLog?.({
                level: 'error',
                component: 'read-url-tool',
                event: 'agent_task_failed',
                message: errorMessage,
            });

            return {
                ok: false,
                agent: 'read_url',
                goal: url,
                error: errorMessage,
                summary: `Failed to fetch URL: ${errorMessage}`,
            };
        }
    }

    _basicHtmlToMarkdown(html) {
        if (!html) return '';

        // Extract title
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? `# ${titleMatch[1].trim()}\n\n` : '';

        // Extract body content (ignore head completely)
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        let content = bodyMatch ? bodyMatch[1] : html;

        // Remove scripts and styles
        content = content.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');

        // Replace headings
        content = content.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => {
            return `\n\n${'#'.repeat(Number(level))} ${text.trim()}\n\n`;
        });

        // Replace paragraphs and breaks
        content = content.replace(/<\/?(p|div)[^>]*>/gi, '\n\n');
        content = content.replace(/<br[^>]*>/gi, '\n');

        // Replace links
        content = content.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

        // Replace lists
        content = content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
        content = content.replace(/<\/?(ul|ol)[^>]*>/gi, '\n\n');

        // Remove all remaining HTML tags
        content = content.replace(/<[^>]+>/g, ' ');

        // Cleanup whitespace (multiple blank lines to double blank line, clean tabs/spaces)
        content = content
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/[ \t]+/g, ' ')
            .replace(/\n\s+\n/g, '\n\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        return title + content;
    }
}
