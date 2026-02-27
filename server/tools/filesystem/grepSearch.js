import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeBoolean, toArray } from '../_utils.js';

const execFileAsync = promisify(execFile);
const GREP_RESULTS_LIMIT = 50;

export const declaration = {
    name: 'grep_search',
    description: 'Search text inside files using ripgrep.',
    parameters: {
        type: 'OBJECT',
        properties: {
            Query: {
                type: 'STRING',
                description: 'The search text or regex pattern.',
            },
            SearchPath: {
                type: 'STRING',
                description: 'Absolute path to a file or directory to search.',
            },
            Includes: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: 'Optional glob filters for file paths.',
            },
            IsRegex: {
                type: 'BOOLEAN',
                description: 'If true, treat Query as regex. If false, literal search.',
            },
            MatchPerLine: {
                type: 'BOOLEAN',
                description: 'If true, return line-level matches. If false, return only file names.',
            },
            CaseInsensitive: {
                type: 'BOOLEAN',
                description: 'If true, search is case-insensitive.',
            },
            waitForPreviousTools: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
        },
        required: ['Query', 'SearchPath'],
    },
};

export async function execute({
    Query,
    SearchPath,
    Includes,
    IsRegex = false,
    MatchPerLine = false,
    CaseInsensitive = false,
}) {
    const query = String(Query ?? '').trim();
    const searchPath = String(SearchPath ?? '').trim();

    if (!query) {
        return { error: 'Query is required.' };
    }

    if (!searchPath) {
        return { error: 'SearchPath is required.' };
    }

    const includes = toArray(Includes)
        .map((value) => String(value ?? '').trim())
        .filter(Boolean);

    const matchPerLine = normalizeBoolean(MatchPerLine, false);
    const isRegex = normalizeBoolean(IsRegex, false);
    const caseInsensitive = normalizeBoolean(CaseInsensitive, false);

    const rgArgs = [];
    if (caseInsensitive) rgArgs.push('-i');
    if (!isRegex) rgArgs.push('-F');

    if (matchPerLine) {
        rgArgs.push('-n', '--json');
    } else {
        rgArgs.push('-l');
    }

    for (const include of includes) {
        rgArgs.push('-g', include);
    }

    rgArgs.push(query, searchPath);

    try {
        const { stdout } = await execFileAsync('rg', rgArgs, {
            maxBuffer: 10 * 1024 * 1024,
        });

        if (!matchPerLine) {
            const files = String(stdout ?? '')
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .slice(0, GREP_RESULTS_LIMIT);

            return {
                query,
                searchPath,
                mode: 'files',
                matchCount: files.length,
                truncated: files.length >= GREP_RESULTS_LIMIT,
                matches: files.map((file) => ({ file })),
            };
        }

        const lines = String(stdout ?? '').split('\n').filter(Boolean);
        const matches = [];
        for (const line of lines) {
            if (matches.length >= GREP_RESULTS_LIMIT) break;

            let event;
            try {
                event = JSON.parse(line);
            } catch {
                continue;
            }

            if (event?.type !== 'match') continue;

            const data = event.data ?? {};
            matches.push({
                file: data.path?.text ?? '',
                lineNumber: Number(data.line_number ?? 0) || null,
                lineContent: (data.lines?.text ?? '').trimEnd(),
            });
        }

        return {
            query,
            searchPath,
            mode: 'lines',
            matchCount: matches.length,
            truncated: matches.length >= GREP_RESULTS_LIMIT,
            matches,
        };
    } catch (error) {
        const stderrText = String(error?.stderr ?? '').trim();
        const stdoutText = String(error?.stdout ?? '').trim();
        const details = stderrText || stdoutText || error.message;

        if (error?.code === 1) {
            return {
                query,
                searchPath,
                mode: matchPerLine ? 'lines' : 'files',
                matchCount: 0,
                truncated: false,
                matches: [],
            };
        }

        if (error?.code === 'ENOENT') {
            return { error: 'ripgrep (rg) is not installed on the server.' };
        }

        return { error: `Failed to run grep_search: ${details}` };
    }
}
