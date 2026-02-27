import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { normalizeBoolean, normalizeInteger, toArray, globToRegex, normalizePathForGlob } from '../_utils.js';

const FIND_RESULTS_LIMIT = 50;

export const declaration = {
    name: 'find_by_name',
    description: 'Search for files and subdirectories within a specified directory using a glob pattern.',
    parameters: {
        type: 'OBJECT',
        properties: {
            SearchDirectory: {
                type: 'STRING',
                description: 'The absolute directory path to search within.',
            },
            Pattern: {
                type: 'STRING',
                description: 'Glob pattern to match against file or directory names.',
            },
            Type: {
                type: 'STRING',
                description: 'Optional type filter: file, directory, or any.',
            },
            Extensions: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: 'Optional list of file extensions to include (without leading dot).',
            },
            Excludes: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: 'Optional list of glob patterns to exclude.',
            },
            FullPath: {
                type: 'BOOLEAN',
                description: 'If true, match Pattern against full absolute path instead of only filename.',
            },
            MaxDepth: {
                type: 'INTEGER',
                description: 'Optional maximum recursion depth.',
            },
            waitForPreviousTools: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
        },
        required: ['SearchDirectory', 'Pattern'],
    },
};

function getPathDepth(basePath, targetPath) {
    const rel = relative(basePath, targetPath);
    if (!rel || rel === '.') return 0;
    return rel.split(/[\\/]/).filter(Boolean).length;
}

export async function execute({
    SearchDirectory,
    Pattern,
    Type = 'any',
    Extensions,
    Excludes,
    FullPath = false,
    MaxDepth,
}) {
    const basePath = String(SearchDirectory ?? '').trim();
    if (!basePath) {
        return { error: 'SearchDirectory is required.' };
    }

    if (!isAbsolute(basePath)) {
        return { error: `SearchDirectory must be an absolute path: ${basePath}` };
    }

    const pattern = String(Pattern ?? '').trim();
    if (!pattern) {
        return { error: 'Pattern is required.' };
    }

    const type = String(Type ?? 'any').trim().toLowerCase();
    if (!['file', 'directory', 'any'].includes(type)) {
        return { error: 'Type must be one of: file, directory, any.' };
    }

    const maxDepth = normalizeInteger(MaxDepth, undefined);
    if (maxDepth !== undefined && maxDepth < 0) {
        return { error: 'MaxDepth must be greater than or equal to 0.' };
    }

    const extensionList = toArray(Extensions)
        .map((value) => String(value ?? '').trim().toLowerCase().replace(/^\./, ''))
        .filter(Boolean);
    const hasExtensionFilter = extensionList.length > 0;

    const fullPathMode = normalizeBoolean(FullPath, false);
    const patternRegex = globToRegex(pattern, true);
    if (!patternRegex) {
        return { error: 'Pattern is invalid.' };
    }

    const excludeRegexes = toArray(Excludes)
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .map((exclude) => globToRegex(exclude, true))
        .filter(Boolean);

    const matches = [];
    const directoriesToVisit = [basePath];
    const visited = new Set();

    function shouldExclude(absPath) {
        if (excludeRegexes.length === 0) return false;
        const relativePath = normalizePathForGlob(relative(basePath, absPath));
        const fullPathStr = normalizePathForGlob(absPath);
        return excludeRegexes.some((regex) => regex.test(relativePath) || regex.test(fullPathStr));
    }

    function matchesType(isDirectory) {
        if (type === 'any') return true;
        return type === 'directory' ? isDirectory : !isDirectory;
    }

    function matchesPattern(absPath, name) {
        const candidate = fullPathMode
            ? normalizePathForGlob(absPath)
            : String(name ?? '');
        return patternRegex.test(candidate);
    }

    function matchesExtensions(name, isDirectory) {
        if (!hasExtensionFilter || isDirectory) return true;
        const ext = String(name ?? '').split('.').slice(1).join('.').toLowerCase();
        if (!ext) return false;
        return extensionList.includes(ext);
    }

    try {
        const rootStat = await stat(basePath);
        if (!rootStat.isDirectory()) {
            return { error: `SearchDirectory is not a directory: ${basePath}` };
        }

        while (directoriesToVisit.length > 0 && matches.length < FIND_RESULTS_LIMIT) {
            const currentDir = directoriesToVisit.shift();
            if (!currentDir || visited.has(currentDir)) continue;
            visited.add(currentDir);

            const currentDepth = getPathDepth(basePath, currentDir);
            if (maxDepth !== undefined && currentDepth > maxDepth) {
                continue;
            }

            let entries;
            try {
                entries = await readdir(currentDir, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                if (matches.length >= FIND_RESULTS_LIMIT) break;

                const absPath = join(currentDir, entry.name);
                const relPath = relative(basePath, absPath);
                const normalizedRelPath = normalizePathForGlob(relPath);
                const entryDepth = getPathDepth(basePath, absPath);
                const isDirectory = entry.isDirectory();

                if (shouldExclude(absPath)) continue;

                if (isDirectory && (maxDepth === undefined || entryDepth <= maxDepth)) {
                    directoriesToVisit.push(absPath);
                }

                if (maxDepth !== undefined && entryDepth > maxDepth) continue;
                if (!matchesType(isDirectory)) continue;
                if (!matchesExtensions(entry.name, isDirectory)) continue;
                if (!matchesPattern(absPath, entry.name)) continue;

                const entryStat = await stat(absPath).catch(() => null);
                matches.push({
                    path: normalizedRelPath,
                    absolutePath: absPath,
                    type: isDirectory ? 'directory' : 'file',
                    size: isDirectory ? undefined : (entryStat?.size ?? null),
                    modifiedAt: entryStat?.mtime?.toISOString?.() ?? null,
                });
            }
        }

        return {
            searchDirectory: basePath,
            pattern,
            type,
            matchCount: matches.length,
            truncated: matches.length >= FIND_RESULTS_LIMIT,
            matches,
        };
    } catch (error) {
        return { error: `Failed to search directory ${basePath}: ${error.message}` };
    }
}
