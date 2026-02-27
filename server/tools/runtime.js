import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { GEMINI_API_KEY, TOOLS_MODEL } from '../core/config.js';
import { IMAGE_AGENT_ID } from '../agents/image/index.js';
import { generateImageWithAgent } from '../agents/image/service.js';
import { CODING_AGENT_ID } from '../agents/coding/index.js';
import { generateCodingExpertAdvice } from '../agents/coding/service.js';

const execFileAsync = promisify(execFile);
const FIND_RESULTS_LIMIT = 50;
const GREP_RESULTS_LIMIT = 50;
const URL_CONTENT_MAX_CHARS = 120_000;
const URL_CONTENT_CHUNK_SIZE = 4000;
const URL_CONTENT_CHUNK_CACHE_LIMIT = 80;
const urlContentChunkCache = new Map();
const WEB_SEARCH_RESULT_LIMIT = 8;
const WEB_SEARCH_TEXT_MAX_CHARS = 12_000;
const COMMAND_SESSIONS_MAX = 80;
const COMMAND_OUTPUT_MAX_CHARS = 240_000;
const COMMAND_OUTPUT_DEFAULT_CHARS = 12_000;
const COMMAND_DEFAULT_WAIT_BEFORE_ASYNC_MS = 600;
const COMMAND_MAX_WAIT_BEFORE_ASYNC_MS = 15_000;
const COMMAND_MAX_WAIT_STATUS_SECONDS = 30;
const COMMAND_STATUS_POLL_MS = 120;
const commandSessions = new Map();

function normalizeBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    return fallback;
}

function normalizeInteger(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.trunc(parsed);
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(globPattern, caseInsensitive = false) {
    const source = String(globPattern ?? '').trim();
    if (!source) return null;

    let regex = '';
    let index = 0;
    while (index < source.length) {
        const current = source[index];
        const next = source[index + 1];

        if (current === '*') {
            if (next === '*') {
                regex += '.*';
                index += 2;
                continue;
            }
            regex += '[^/]*';
            index += 1;
            continue;
        }

        if (current === '?') {
            regex += '.';
            index += 1;
            continue;
        }

        regex += escapeRegex(current);
        index += 1;
    }

    return new RegExp(`^${regex}$`, caseInsensitive ? 'i' : undefined);
}

function normalizePathForGlob(pathValue) {
    return String(pathValue ?? '').replace(/\\/g, '/');
}

function toArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    return [value];
}

function truncateText(text, maxChars) {
    const raw = String(text ?? '');
    if (raw.length <= maxChars) return raw;
    const remaining = raw.length - maxChars;
    return `${raw.slice(0, maxChars)}... [truncated ${remaining} chars]`;
}

function extractToolMediaParts(result) {
    if (!result || typeof result !== 'object') {
        return [];
    }

    const rawMediaParts = Array.isArray(result._mediaParts) ? result._mediaParts : [];
    const normalizedMediaParts = [];

    for (const rawPart of rawMediaParts) {
        const inlineData = rawPart?.inlineData;
        if (!inlineData || typeof inlineData !== 'object') {
            continue;
        }

        const mimeType = String(inlineData.mimeType ?? '').trim().toLowerCase();
        const data = String(inlineData.data ?? '').trim();
        if (!mimeType.startsWith('image/') || !data) {
            continue;
        }

        const displayName = String(inlineData.displayName ?? '').trim();
        normalizedMediaParts.push({
            inlineData: {
                mimeType,
                data,
                ...(displayName ? { displayName } : {}),
            },
        });
    }

    return normalizedMediaParts;
}

function sanitizeToolResultForModel(result) {
    if (!result || typeof result !== 'object') {
        return result;
    }

    const sanitized = {};
    for (const [key, value] of Object.entries(result)) {
        if (key.startsWith('_')) {
            continue;
        }
        sanitized[key] = value;
    }

    return sanitized;
}

function splitTextIntoChunks(text, maxChars = URL_CONTENT_CHUNK_SIZE) {
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

function sleep(ms) {
    return new Promise((resolvePromise) => {
        setTimeout(resolvePromise, ms);
    });
}

function clampInteger(value, fallback, min, max) {
    const parsed = normalizeInteger(value, fallback);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function resolveCommandWorkingDirectory(cwdValue) {
    const raw = String(cwdValue ?? '').trim();
    if (!raw) return process.cwd();
    if (isAbsolute(raw)) return raw;
    return resolve(process.cwd(), raw);
}

function normalizeOutputCharacterCount(value) {
    return clampInteger(value, COMMAND_OUTPUT_DEFAULT_CHARS, 0, COMMAND_OUTPUT_MAX_CHARS);
}

function normalizeWaitDurationSeconds(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.min(COMMAND_MAX_WAIT_STATUS_SECONDS, Math.max(0, parsed));
}

function trimOutputTail(value, maxChars = COMMAND_OUTPUT_DEFAULT_CHARS) {
    const text = String(value ?? '');
    if (maxChars <= 0) return '';
    if (text.length <= maxChars) return text;
    return text.slice(text.length - maxChars);
}

function appendCommandOutput(session, chunk) {
    if (!session) return;
    const text = Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk ?? '');
    if (!text) return;

    session.output += text;
    session.outputCharsTotal += text.length;
    session.lastOutputAt = Date.now();

    if (session.output.length > COMMAND_OUTPUT_MAX_CHARS) {
        const trimChars = session.output.length - COMMAND_OUTPUT_MAX_CHARS;
        session.output = session.output.slice(trimChars);
        session.outputTruncated = true;
    }
}

function markCommandFinished(session, { status, code = null, signal = null, errorMessage = null }) {
    if (!session || session.status !== 'running') return;

    session.status = status;
    session.exitCode = Number.isInteger(code) ? code : null;
    session.signal = typeof signal === 'string' && signal ? signal : null;
    session.endedAt = Date.now();
    session.endedAtIso = new Date(session.endedAt).toISOString();
    session.process = null;

    if (errorMessage) {
        appendCommandOutput(session, `\n[error] ${errorMessage}\n`);
    }
}

function pruneCommandSessions() {
    if (commandSessions.size <= COMMAND_SESSIONS_MAX) return;

    const candidates = [...commandSessions.values()]
        .sort((a, b) => a.createdAt - b.createdAt);

    for (const session of candidates) {
        if (commandSessions.size <= COMMAND_SESSIONS_MAX) break;
        if (session.status === 'running') continue;
        commandSessions.delete(session.id);
    }

    if (commandSessions.size <= COMMAND_SESSIONS_MAX) return;

    for (const session of candidates) {
        if (commandSessions.size <= COMMAND_SESSIONS_MAX) break;
        if (session.status === 'running') continue;
        commandSessions.delete(session.id);
    }
}

function createCommandSnapshot(session, { outputCharacterCount = COMMAND_OUTPUT_DEFAULT_CHARS } = {}) {
    if (!session) {
        return { error: 'Unknown command session.' };
    }

    const outputLimit = normalizeOutputCharacterCount(outputCharacterCount);
    const now = Date.now();
    const endTime = session.endedAt ?? now;
    const durationMs = Math.max(0, endTime - session.startedAt);

    return {
        commandId: session.id,
        name: session.name,
        command: session.command,
        cwd: session.cwd,
        pid: session.pid,
        status: session.status,
        running: session.status === 'running',
        startedAt: session.startedAtIso,
        endedAt: session.endedAtIso,
        durationMs,
        durationSeconds: Math.floor(durationMs / 1000),
        exitCode: session.exitCode,
        signal: session.signal,
        output: trimOutputTail(session.output, outputLimit),
        outputCharsVisible: Math.min(outputLimit, session.output.length),
        outputCharsTotal: session.outputCharsTotal,
        outputTruncated: session.outputTruncated,
    };
}

function getSessionByNameOrPid({ Name, ProcessID }) {
    const processId = normalizeInteger(ProcessID, NaN);
    if (Number.isInteger(processId) && processId > 0) {
        for (const session of commandSessions.values()) {
            if (session.pid === processId) return session;
        }
    }

    const requestedName = String(Name ?? '').trim().toLowerCase();
    if (requestedName) {
        const matches = [...commandSessions.values()]
            .filter((session) => session.name.toLowerCase().includes(requestedName))
            .sort((a, b) => b.startedAt - a.startedAt);
        if (matches.length > 0) return matches[0];
    }

    return null;
}

async function waitForCommandChange(session, waitDurationSeconds, previousOutputCharsTotal) {
    const maxWaitMs = Math.floor(normalizeWaitDurationSeconds(waitDurationSeconds) * 1000);
    if (!session || maxWaitMs <= 0) return;

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        if (session.status !== 'running') return;
        if (session.outputCharsTotal !== previousOutputCharsTotal) return;
        await sleep(COMMAND_STATUS_POLL_MS);
    }
}

function createCommandName(commandLine) {
    const text = String(commandLine ?? '').trim();
    if (!text) return 'command';

    const firstToken = text.split(/\s+/)[0];
    if (!firstToken) return 'command';

    return firstToken;
}

function startCommandSession(commandLine, cwd) {
    const now = Date.now();
    const commandId = `cmd_${randomUUID()}`;
    const name = createCommandName(commandLine);
    const child = spawn('/bin/zsh', ['-lc', commandLine], {
        cwd,
        env: {
            ...process.env,
            TERM: process.env.TERM || 'xterm-256color',
            PAGER: 'cat',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    const session = {
        id: commandId,
        name,
        command: commandLine,
        cwd,
        pid: child.pid ?? null,
        status: 'running',
        startedAt: now,
        startedAtIso: new Date(now).toISOString(),
        endedAt: null,
        endedAtIso: null,
        exitCode: null,
        signal: null,
        output: '',
        outputCharsTotal: 0,
        outputTruncated: false,
        lastOutputAt: now,
        process: child,
        donePromise: null,
    };

    commandSessions.set(commandId, session);
    pruneCommandSessions();

    if (child.stdout) {
        child.stdout.on('data', (chunk) => {
            appendCommandOutput(session, chunk);
        });
    }
    if (child.stderr) {
        child.stderr.on('data', (chunk) => {
            appendCommandOutput(session, chunk);
        });
    }

    session.donePromise = new Promise((resolvePromise) => {
        child.once('error', (error) => {
            markCommandFinished(session, {
                status: 'failed',
                errorMessage: error?.message || 'Unknown process error.',
            });
            resolvePromise();
        });

        child.once('close', (code, signal) => {
            if (session.status === 'running') {
                const status = signal
                    ? 'terminated'
                    : (code === 0 ? 'completed' : 'failed');
                markCommandFinished(session, { status, code, signal });
            }
            resolvePromise();
        });
    });

    return session;
}

function createUrlDocumentId(url, content) {
    const hash = createHash('sha1')
        .update(String(url ?? ''))
        .update('\n')
        .update(String(content ?? ''))
        .digest('hex')
        .slice(0, 16);
    return `doc_${hash}`;
}

function cacheUrlContentDocument(documentId, payload) {
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

function countOccurrences(text, needle) {
    if (!needle) return 0;

    let count = 0;
    let index = 0;
    while (true) {
        const foundIndex = text.indexOf(needle, index);
        if (foundIndex === -1) break;
        count += 1;
        index = foundIndex + needle.length;
    }

    return count;
}

function toLogicalLines(text) {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n');
    if (normalized === '') return [];
    return normalized.split('\n');
}

function findBlockEndLine(lines, startIndex) {
    let depth = 0;
    let sawOpeningBrace = false;

    for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        for (let i = 0; i < line.length; i += 1) {
            const char = line[i];
            if (char === '{') {
                depth += 1;
                sawOpeningBrace = true;
            } else if (char === '}') {
                depth -= 1;
                if (sawOpeningBrace && depth <= 0) {
                    return lineIndex + 1;
                }
            }
        }
    }

    return startIndex + 1;
}

function parseOutlineItems(lines) {
    const items = [];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const trimmed = line.trim();
        if (!trimmed) continue;

        const classMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b/);
        if (classMatch) {
            items.push({
                nodePath: classMatch[1],
                signature: trimmed,
                startLine: lineIndex + 1,
                endLine: findBlockEndLine(lines, lineIndex),
                kind: 'class',
            });
            continue;
        }

        const functionMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
        if (functionMatch) {
            items.push({
                nodePath: functionMatch[1],
                signature: trimmed,
                startLine: lineIndex + 1,
                endLine: findBlockEndLine(lines, lineIndex),
                kind: 'function',
            });
            continue;
        }

        const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/);
        if (arrowMatch && trimmed.includes('=>')) {
            items.push({
                nodePath: arrowMatch[1],
                signature: trimmed,
                startLine: lineIndex + 1,
                endLine: trimmed.includes('{') ? findBlockEndLine(lines, lineIndex) : lineIndex + 1,
                kind: 'function',
            });
        }
    }

    return items;
}

function findOutlineItemForNodePath(outlineItems, requestedNodePath) {
    const requested = String(requestedNodePath ?? '').trim();
    if (!requested) return null;

    const exact = outlineItems.find((item) => item.nodePath === requested);
    if (exact) return exact;

    const leaf = requested.split('.').filter(Boolean).pop();
    if (!leaf) return null;

    return outlineItems.find((item) => item.nodePath === leaf) ?? null;
}

function findFallbackCodeItem(lines, nodePath) {
    const requested = String(nodePath ?? '').trim();
    if (!requested) return null;

    const leaf = requested.split('.').filter(Boolean).pop();
    if (!leaf) return null;

    const escapedLeaf = escapeRegex(leaf);
    const patterns = [
        new RegExp(`\\bclass\\s+${escapedLeaf}\\b`),
        new RegExp(`\\bfunction\\s+${escapedLeaf}\\s*\\(`),
        new RegExp(`\\b(?:const|let|var)\\s+${escapedLeaf}\\s*=`),
        new RegExp(`\\b${escapedLeaf}\\s*\\(`),
    ];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (patterns.some((pattern) => pattern.test(trimmed))) {
            return {
                nodePath: leaf,
                signature: trimmed,
                startLine: lineIndex + 1,
                endLine: findBlockEndLine(lines, lineIndex),
                kind: 'unknown',
            };
        }
    }

    return null;
}

function stripHtmlToText(html) {
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

async function fetchUrlWithCurl(url) {
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

function getPathDepth(basePath, targetPath) {
    const rel = relative(basePath, targetPath);
    if (!rel || rel === '.') return 0;
    return rel.split(/[\\/]/).filter(Boolean).length;
}

/**
 * Implementation of the list_dir tool.
 * Lists the contents of a directory.
 */
export async function list_dir({ DirectoryPath }) {
    try {
        const files = await readdir(DirectoryPath);
        const result = [];

        for (const file of files) {
            const fullPath = join(DirectoryPath, file);
            const s = await stat(fullPath);

            if (s.isDirectory()) {
                result.push({
                    name: file,
                    type: 'directory',
                    path: relative(process.cwd(), fullPath)
                });
            } else {
                result.push({
                    name: file,
                    type: 'file',
                    size: s.size,
                    path: relative(process.cwd(), fullPath)
                });
            }
        }

        return {
            directory: DirectoryPath,
            contents: result
        };
    } catch (error) {
        return {
            error: `Failed to list directory ${DirectoryPath}: ${error.message}`
        };
    }
}

/**
 * Implementation of find_by_name tool.
 */
export async function find_by_name({
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

    const excludePatterns = toArray(Excludes)
        .map((value) => String(value ?? '').trim())
        .filter(Boolean);
    const excludeRegexes = excludePatterns
        .map((exclude) => globToRegex(exclude, true))
        .filter(Boolean);

    const matches = [];
    const directoriesToVisit = [basePath];
    const visited = new Set();

    function shouldExclude(absPath) {
        if (excludeRegexes.length === 0) return false;
        const relativePath = normalizePathForGlob(relative(basePath, absPath));
        const fullPath = normalizePathForGlob(absPath);
        return excludeRegexes.some((regex) => (
            regex.test(relativePath)
            || regex.test(fullPath)
        ));
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

                if (shouldExclude(absPath)) {
                    continue;
                }

                if (isDirectory && (maxDepth === undefined || entryDepth <= maxDepth)) {
                    directoriesToVisit.push(absPath);
                }

                if (maxDepth !== undefined && entryDepth > maxDepth) {
                    continue;
                }

                if (!matchesType(isDirectory)) {
                    continue;
                }

                if (!matchesExtensions(entry.name, isDirectory)) {
                    continue;
                }

                if (!matchesPattern(absPath, entry.name)) {
                    continue;
                }

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
        return {
            error: `Failed to search directory ${basePath}: ${error.message}`,
        };
    }
}

/**
 * Implementation of the view_file tool.
 * Reads a file and optionally returns a line range.
 */
export async function view_file({ AbsolutePath, StartLine, EndLine }) {
    const targetPath = String(AbsolutePath ?? '').trim();
    if (!targetPath) {
        return {
            error: 'AbsolutePath is required.',
        };
    }

    if (!isAbsolute(targetPath)) {
        return {
            error: `AbsolutePath must be an absolute path: ${targetPath}`,
        };
    }

    const hasStart = StartLine !== undefined && StartLine !== null;
    const hasEnd = EndLine !== undefined && EndLine !== null;
    const parsedStart = hasStart ? Number(StartLine) : 1;
    const parsedEnd = hasEnd ? Number(EndLine) : undefined;

    if (!Number.isInteger(parsedStart) || parsedStart < 1) {
        return {
            error: 'StartLine must be an integer greater than or equal to 1.',
        };
    }

    if (parsedEnd !== undefined && (!Number.isInteger(parsedEnd) || parsedEnd < parsedStart)) {
        return {
            error: 'EndLine must be an integer greater than or equal to StartLine.',
        };
    }

    try {
        const fileStats = await stat(targetPath);
        if (!fileStats.isFile()) {
            return {
                error: `Path is not a file: ${targetPath}`,
            };
        }

        const fileContent = await readFile(targetPath, 'utf8');
        const lines = fileContent.split(/\r?\n/);

        const effectiveEnd = parsedEnd === undefined ? lines.length : Math.min(parsedEnd, lines.length);
        const contentSlice = lines.slice(parsedStart - 1, effectiveEnd);

        return {
            path: targetPath,
            relativePath: relative(process.cwd(), targetPath),
            totalLines: lines.length,
            startLine: parsedStart,
            endLine: effectiveEnd,
            content: contentSlice.join('\n'),
        };
    } catch (error) {
        return {
            error: `Failed to view file ${targetPath}: ${error.message}`,
        };
    }
}

/**
 * Implementation of view_file_outline tool.
 * Returns a lightweight outline of classes/functions with line ranges.
 */
export async function view_file_outline({ AbsolutePath, ItemOffset }) {
    const targetPath = String(AbsolutePath ?? '').trim();
    if (!targetPath) {
        return { error: 'AbsolutePath is required.' };
    }

    if (!isAbsolute(targetPath)) {
        return { error: `AbsolutePath must be an absolute path: ${targetPath}` };
    }

    const itemOffset = normalizeInteger(ItemOffset, 0);
    if (itemOffset < 0) {
        return { error: 'ItemOffset must be greater than or equal to 0.' };
    }

    const PAGE_SIZE = 100;
    const PREVIEW_MAX_LINES = 800;

    try {
        const fileStats = await stat(targetPath);
        if (!fileStats.isFile()) {
            return { error: `Path is not a file: ${targetPath}` };
        }

        const fileContent = await readFile(targetPath, 'utf8');
        const lines = fileContent.split(/\r?\n/);
        const outlineItems = parseOutlineItems(lines);
        const paginatedItems = outlineItems.slice(itemOffset, itemOffset + PAGE_SIZE);

        return {
            path: targetPath,
            relativePath: relative(process.cwd(), targetPath),
            totalLines: lines.length,
            totalItems: outlineItems.length,
            itemOffset,
            items: paginatedItems,
            contentPreview: itemOffset === 0
                ? lines.slice(0, PREVIEW_MAX_LINES).join('\n')
                : undefined,
            previewStartLine: itemOffset === 0 ? 1 : undefined,
            previewEndLine: itemOffset === 0 ? Math.min(lines.length, PREVIEW_MAX_LINES) : undefined,
        };
    } catch (error) {
        return {
            error: `Failed to view outline for ${targetPath}: ${error.message}`,
        };
    }
}

/**
 * Implementation of write_to_file tool.
 */
export async function write_to_file({
    TargetFile,
    CodeContent,
    Overwrite = false,
    EmptyFile = false,
}) {
    const targetPath = String(TargetFile ?? '').trim();
    if (!targetPath) {
        return { error: 'TargetFile is required.' };
    }

    if (!isAbsolute(targetPath)) {
        return { error: `TargetFile must be an absolute path: ${targetPath}` };
    }

    const overwrite = normalizeBoolean(Overwrite, false);
    const emptyFile = normalizeBoolean(EmptyFile, false);
    const content = emptyFile ? '' : String(CodeContent ?? '');

    try {
        await mkdir(dirname(targetPath), { recursive: true });

        let existed = false;
        let previousContent = '';
        try {
            const existingStats = await stat(targetPath);
            if (!existingStats.isFile()) {
                return { error: `TargetFile exists but is not a regular file: ${targetPath}` };
            }
            existed = true;
            previousContent = await readFile(targetPath, 'utf8');
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }

        if (existed && !overwrite) {
            return {
                error: `TargetFile already exists and Overwrite is false: ${targetPath}`,
            };
        }

        await writeFile(targetPath, content, 'utf8');

        const oldLines = toLogicalLines(previousContent);
        const newLines = toLogicalLines(content);
        const removedLines = existed ? oldLines.length : 0;
        const addedLines = newLines.length;
        const previewLines = [];
        const PREVIEW_LIMIT = 200;

        if (existed) {
            for (let i = 0; i < oldLines.length && previewLines.length < PREVIEW_LIMIT; i += 1) {
                previewLines.push({
                    type: 'removed',
                    oldLineNumber: i + 1,
                    text: oldLines[i],
                });
            }
        }

        for (let i = 0; i < newLines.length && previewLines.length < PREVIEW_LIMIT; i += 1) {
            previewLines.push({
                type: 'added',
                newLineNumber: i + 1,
                text: newLines[i],
            });
        }

        if ((oldLines.length + newLines.length) > PREVIEW_LIMIT) {
            previewLines.push({
                type: 'context',
                lineNumber: null,
                text: '... diff preview truncated ...',
            });
        }

        return {
            path: targetPath,
            relativePath: relative(process.cwd(), targetPath),
            created: !existed,
            overwritten: existed,
            bytesWritten: Buffer.byteLength(content, 'utf8'),
            addedLines,
            removedLines,
            diffPreview: {
                lines: previewLines,
            },
        };
    } catch (error) {
        return {
            error: `Failed to write file ${targetPath}: ${error.message}`,
        };
    }
}

/**
 * Implementation of replace_file_content tool.
 * Replaces target content within a specified line range.
 */
export async function replace_file_content({
    TargetFile,
    StartLine,
    EndLine,
    TargetContent,
    ReplacementContent,
    AllowMultiple = false,
}) {
    const targetPath = String(TargetFile ?? '').trim();
    if (!targetPath) {
        return { error: 'TargetFile is required.' };
    }

    if (!isAbsolute(targetPath)) {
        return { error: `TargetFile must be an absolute path: ${targetPath}` };
    }

    const startLine = normalizeInteger(StartLine, NaN);
    const endLine = normalizeInteger(EndLine, NaN);
    if (!Number.isInteger(startLine) || startLine < 1) {
        return { error: 'StartLine must be an integer greater than or equal to 1.' };
    }
    if (!Number.isInteger(endLine) || endLine < startLine) {
        return { error: 'EndLine must be an integer greater than or equal to StartLine.' };
    }

    const targetContent = String(TargetContent ?? '').replace(/\r\n/g, '\n');
    const replacementContent = String(ReplacementContent ?? '').replace(/\r\n/g, '\n');
    if (!targetContent) {
        return { error: 'TargetContent is required.' };
    }

    const allowMultiple = normalizeBoolean(AllowMultiple, false);

    try {
        const existingContent = await readFile(targetPath, 'utf8');
        const lineEnding = existingContent.includes('\r\n') ? '\r\n' : '\n';
        const lines = existingContent.split(/\r?\n/);

        if (endLine > lines.length) {
            return {
                error: `EndLine (${endLine}) is out of bounds for file with ${lines.length} lines.`,
            };
        }

        const rangeStartIndex = startLine - 1;
        const rangeEndIndex = endLine;
        const originalRangeText = lines.slice(rangeStartIndex, rangeEndIndex).join('\n');

        const occurrences = countOccurrences(originalRangeText, targetContent);
        if (occurrences === 0) {
            return {
                error: 'TargetContent was not found in the provided line range.',
            };
        }

        if (!allowMultiple && occurrences > 1) {
            return {
                error: 'TargetContent appears multiple times in range. Set AllowMultiple=true or narrow range.',
            };
        }

        const replacedRangeText = allowMultiple
            ? originalRangeText.split(targetContent).join(replacementContent)
            : originalRangeText.replace(targetContent, replacementContent);

        const originalRangeLines = originalRangeText.split(/\r?\n/);
        const replacedRangeLines = replacedRangeText.split(/\r?\n/);
        const updatedLines = [
            ...lines.slice(0, rangeStartIndex),
            ...replacedRangeLines,
            ...lines.slice(rangeEndIndex),
        ];

        const updatedContent = updatedLines.join(lineEnding);
        await writeFile(targetPath, updatedContent, 'utf8');

        const previewLines = [];
        if (startLine > 1) {
            previewLines.push({
                type: 'context',
                lineNumber: startLine - 1,
                text: lines[startLine - 2],
            });
        }

        for (let i = 0; i < originalRangeLines.length; i += 1) {
            previewLines.push({
                type: 'removed',
                oldLineNumber: startLine + i,
                text: originalRangeLines[i],
            });
        }

        for (let i = 0; i < replacedRangeLines.length; i += 1) {
            previewLines.push({
                type: 'added',
                newLineNumber: startLine + i,
                text: replacedRangeLines[i],
            });
        }

        if (endLine < lines.length) {
            previewLines.push({
                type: 'context',
                lineNumber: endLine + 1,
                text: lines[endLine],
            });
        }

        return {
            path: targetPath,
            relativePath: relative(process.cwd(), targetPath),
            startLine,
            endLine,
            replacedOccurrences: allowMultiple ? occurrences : 1,
            allowMultiple,
            resultingLineCount: updatedLines.length,
            addedLines: replacedRangeLines.length,
            removedLines: originalRangeLines.length,
            diffPreview: {
                lines: previewLines.slice(0, 200),
            },
        };
    } catch (error) {
        return {
            error: `Failed to replace content in ${targetPath}: ${error.message}`,
        };
    }
}

/**
 * Implementation of multi_replace_file_content tool.
 * Applies multiple replacement chunks in one request.
 */
export async function multi_replace_file_content({
    TargetFile,
    ReplacementChunks,
}) {
    const targetPath = String(TargetFile ?? '').trim();
    if (!targetPath) {
        return { error: 'TargetFile is required.' };
    }

    if (!isAbsolute(targetPath)) {
        return { error: `TargetFile must be an absolute path: ${targetPath}` };
    }

    const chunksInput = Array.isArray(ReplacementChunks)
        ? ReplacementChunks
        : [];
    if (chunksInput.length === 0) {
        return { error: 'ReplacementChunks must contain at least one chunk.' };
    }

    const preparedChunks = [];
    for (let index = 0; index < chunksInput.length; index += 1) {
        const chunk = chunksInput[index] ?? {};
        const startLine = normalizeInteger(chunk.StartLine, NaN);
        const endLine = normalizeInteger(chunk.EndLine, NaN);
        const targetContent = String(chunk.TargetContent ?? '').replace(/\r\n/g, '\n');
        const replacementContent = String(chunk.ReplacementContent ?? '').replace(/\r\n/g, '\n');
        const allowMultiple = normalizeBoolean(chunk.AllowMultiple, false);

        if (!Number.isInteger(startLine) || startLine < 1) {
            return { error: `Replacement chunk ${index + 1}: StartLine must be an integer >= 1.` };
        }
        if (!Number.isInteger(endLine) || endLine < startLine) {
            return { error: `Replacement chunk ${index + 1}: EndLine must be an integer >= StartLine.` };
        }
        if (!targetContent) {
            return { error: `Replacement chunk ${index + 1}: TargetContent is required.` };
        }

        preparedChunks.push({
            index,
            startLine,
            endLine,
            targetContent,
            replacementContent,
            allowMultiple,
        });
    }

    // Process from bottom to top so line offsets above remain stable.
    const sortedChunks = [...preparedChunks].sort((a, b) => (
        b.startLine - a.startLine || b.endLine - a.endLine || b.index - a.index
    ));

    try {
        const existingContent = await readFile(targetPath, 'utf8');
        const lineEnding = existingContent.includes('\r\n') ? '\r\n' : '\n';
        let workingLines = existingContent.split(/\r?\n/);

        let totalAddedLines = 0;
        let totalRemovedLines = 0;
        let totalReplacedOccurrences = 0;
        const previewLines = [];
        const PREVIEW_LIMIT = 220;

        for (const chunk of sortedChunks) {
            const {
                startLine,
                endLine,
                targetContent,
                replacementContent,
                allowMultiple,
                index,
            } = chunk;

            if (endLine > workingLines.length) {
                return {
                    error: `Replacement chunk ${index + 1}: EndLine (${endLine}) is out of bounds for file with ${workingLines.length} lines.`,
                };
            }

            const beforeLines = workingLines;
            const rangeStartIndex = startLine - 1;
            const rangeEndIndex = endLine;
            const originalRangeText = beforeLines.slice(rangeStartIndex, rangeEndIndex).join('\n');

            const occurrences = countOccurrences(originalRangeText, targetContent);
            if (occurrences === 0) {
                return {
                    error: `Replacement chunk ${index + 1}: TargetContent was not found in the provided line range.`,
                };
            }

            if (!allowMultiple && occurrences > 1) {
                return {
                    error: `Replacement chunk ${index + 1}: TargetContent appears multiple times in range. Set AllowMultiple=true or narrow range.`,
                };
            }

            const replacedRangeText = allowMultiple
                ? originalRangeText.split(targetContent).join(replacementContent)
                : originalRangeText.replace(targetContent, replacementContent);

            const originalRangeLines = originalRangeText.split(/\r?\n/);
            const replacedRangeLines = replacedRangeText.split(/\r?\n/);

            workingLines = [
                ...beforeLines.slice(0, rangeStartIndex),
                ...replacedRangeLines,
                ...beforeLines.slice(rangeEndIndex),
            ];

            totalRemovedLines += originalRangeLines.length;
            totalAddedLines += replacedRangeLines.length;
            totalReplacedOccurrences += allowMultiple ? occurrences : 1;

            if (previewLines.length < PREVIEW_LIMIT) {
                previewLines.push({
                    type: 'context',
                    lineNumber: null,
                    text: `@@ chunk ${index + 1} (${startLine}-${endLine}) @@`,
                });
            }

            if (startLine > 1 && previewLines.length < PREVIEW_LIMIT) {
                previewLines.push({
                    type: 'context',
                    lineNumber: startLine - 1,
                    text: beforeLines[startLine - 2],
                });
            }

            for (let i = 0; i < originalRangeLines.length && previewLines.length < PREVIEW_LIMIT; i += 1) {
                previewLines.push({
                    type: 'removed',
                    oldLineNumber: startLine + i,
                    text: originalRangeLines[i],
                });
            }

            for (let i = 0; i < replacedRangeLines.length && previewLines.length < PREVIEW_LIMIT; i += 1) {
                previewLines.push({
                    type: 'added',
                    newLineNumber: startLine + i,
                    text: replacedRangeLines[i],
                });
            }

            if (endLine < beforeLines.length && previewLines.length < PREVIEW_LIMIT) {
                previewLines.push({
                    type: 'context',
                    lineNumber: endLine + 1,
                    text: beforeLines[endLine],
                });
            }
        }

        if (previewLines.length >= PREVIEW_LIMIT) {
            previewLines.push({
                type: 'context',
                lineNumber: null,
                text: '... diff preview truncated ...',
            });
        }

        const updatedContent = workingLines.join(lineEnding);
        await writeFile(targetPath, updatedContent, 'utf8');

        return {
            path: targetPath,
            relativePath: relative(process.cwd(), targetPath),
            chunkCount: preparedChunks.length,
            replacedOccurrences: totalReplacedOccurrences,
            resultingLineCount: workingLines.length,
            addedLines: totalAddedLines,
            removedLines: totalRemovedLines,
            diffPreview: {
                lines: previewLines.slice(0, PREVIEW_LIMIT),
            },
        };
    } catch (error) {
        return {
            error: `Failed to apply multi_replace_file_content in ${targetPath}: ${error.message}`,
        };
    }
}

/**
 * Implementation of grep_search tool.
 */
export async function grep_search({
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
            const filePath = data.path?.text ?? '';
            const lineNumber = Number(data.line_number ?? 0) || null;
            const lineText = data.lines?.text ?? '';

            matches.push({
                file: filePath,
                lineNumber,
                lineContent: lineText.trimEnd(),
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

        // ripgrep returns exit code 1 when no matches are found.
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
            return {
                error: 'ripgrep (rg) is not installed on the server.',
            };
        }

        return {
            error: `Failed to run grep_search: ${details}`,
        };
    }
}

/**
 * Implementation of view_code_item tool.
 * Returns code blocks for requested node paths from a file.
 */
export async function view_code_item({ File, NodePaths }) {
    const targetPath = String(File ?? '').trim();
    if (!targetPath) {
        return { error: 'File is required.' };
    }

    if (!isAbsolute(targetPath)) {
        return { error: `File must be an absolute path: ${targetPath}` };
    }

    const nodePaths = Array.isArray(NodePaths)
        ? NodePaths
            .map((value) => String(value ?? '').trim())
            .filter(Boolean)
        : [];

    if (nodePaths.length === 0) {
        return { error: 'NodePaths must contain at least one node path.' };
    }

    const MAX_NODE_PATHS = 5;
    const limitedNodePaths = nodePaths.slice(0, MAX_NODE_PATHS);

    try {
        const fileStats = await stat(targetPath);
        if (!fileStats.isFile()) {
            return { error: `Path is not a file: ${targetPath}` };
        }

        const fileContent = await readFile(targetPath, 'utf8');
        const lines = fileContent.split(/\r?\n/);
        const outlineItems = parseOutlineItems(lines);
        const items = [];

        for (const requestedNodePath of limitedNodePaths) {
            const foundOutlineItem = findOutlineItemForNodePath(outlineItems, requestedNodePath);
            const resolvedItem = foundOutlineItem ?? findFallbackCodeItem(lines, requestedNodePath);

            if (!resolvedItem) {
                items.push({
                    requestedNodePath,
                    found: false,
                    content: '',
                });
                continue;
            }

            const startLine = Math.max(1, Number(resolvedItem.startLine ?? 1));
            const endLine = Math.max(startLine, Number(resolvedItem.endLine ?? startLine));
            const boundedEndLine = Math.min(endLine, lines.length);
            const content = lines.slice(startLine - 1, boundedEndLine).join('\n');

            items.push({
                requestedNodePath,
                found: true,
                nodePath: resolvedItem.nodePath,
                signature: resolvedItem.signature,
                startLine,
                endLine: boundedEndLine,
                content,
            });
        }

        const matchCount = items.filter((item) => item.found === true).length;
        return {
            path: targetPath,
            relativePath: relative(process.cwd(), targetPath),
            totalLines: lines.length,
            requestedCount: nodePaths.length,
            returnedCount: items.length,
            truncated: nodePaths.length > limitedNodePaths.length,
            matchCount,
            items,
        };
    } catch (error) {
        return {
            error: `Failed to view code item(s) in ${targetPath}: ${error.message}`,
        };
    }
}

/**
 * Implementation of read_url_content tool.
 */
export async function read_url_content({ Url }) {
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

    function buildReadUrlResult({
        finalUrl,
        status,
        ok,
        contentType,
        title,
        content,
        transport,
    }) {
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
        const response = await fetch(parsedUrl.toString(), {
            method: 'GET',
            redirect: 'follow',
        });

        const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
        const rawBody = await response.text();
        const content = contentType.includes('text/html')
            ? stripHtmlToText(rawBody)
            : rawBody;
        const titleMatch = contentType.includes('text/html')
            ? rawBody.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
            : null;
        const title = titleMatch ? stripHtmlToText(titleMatch[1]) : '';

        return buildReadUrlResult({
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
            const content = contentType.includes('text/html')
                ? stripHtmlToText(rawBody)
                : rawBody;
            const titleMatch = contentType.includes('text/html')
                ? rawBody.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
                : null;
            const title = titleMatch ? stripHtmlToText(titleMatch[1]) : '';
            const status = Number(curlResponse.status) || 0;

            return buildReadUrlResult({
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

/**
 * Implementation of view_content_chunk tool.
 * Returns a specific chunk from content previously fetched by read_url_content.
 */
export async function view_content_chunk({ document_id, position }) {
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

/**
 * Implementation of search_web tool.
 * Uses Gemini grounding with Google Search and returns concise text plus citations.
 */
export async function search_web({ query, domain }) {
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
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: prompt }],
                    },
                ],
                tools: [{ google_search: {} }],
            }),
        });

        payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const errorMessage = String(
                payload?.error?.message
                ?? payload?.error
                ?? `Google search request failed with status ${response.status}.`,
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
    const webSearchQueries = Array.isArray(
        groundingMetadata?.webSearchQueries ?? groundingMetadata?.web_search_queries,
    )
        ? (groundingMetadata.webSearchQueries ?? groundingMetadata.web_search_queries)
        : [];
    const rawChunks = Array.isArray(
        groundingMetadata?.groundingChunks ?? groundingMetadata?.grounding_chunks,
    )
        ? (groundingMetadata.groundingChunks ?? groundingMetadata.grounding_chunks)
        : [];

    const citations = [];
    const seenUris = new Set();
    for (const chunk of rawChunks) {
        const web = chunk?.web ?? {};
        const uri = String(web?.uri ?? '').trim();
        if (!uri || seenUris.has(uri)) continue;
        seenUris.add(uri);
        citations.push({
            title: String(web?.title ?? '').trim() || uri,
            uri,
        });
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

/**
 * Implementation of generate_image tool.
 * Delegates image generation/editing to the Image agent.
 */
export async function generate_image({
    prompt,
    model,
    aspectRatio,
    imageSize,
}) {
    const promptText = String(prompt ?? '').trim();
    if (!promptText) {
        return { error: 'prompt is required.' };
    }

    try {
        const result = await generateImageWithAgent({
            prompt: promptText,
            model,
            aspectRatio,
            imageSize,
        });
        const usageMetadata = result.usageMetadata && typeof result.usageMetadata === 'object'
            ? result.usageMetadata
            : null;
        const outputSummary = result.text
            ? String(result.text).trim()
            : (result.imageCount > 0 ? `${result.imageCount} image(s) generated.` : '');

        return {
            ok: true,
            status: 'completed',
            model: result.model,
            prompt: promptText,
            text: result.text || '',
            agentThought: result.thought || '',
            imageCount: result.imageCount,
            generatedImages: result.mediaParts.map((part, index) => ({
                index: index + 1,
                mimeType: String(part?.inlineData?.mimeType ?? '').trim() || 'image/png',
                displayName: String(part?.inlineData?.displayName ?? '').trim() || `image-${index + 1}.png`,
            })),
            grounding: result.grounding,
            _mediaParts: result.mediaParts,
            _usageRecords: [
                {
                    source: 'tool',
                    toolName: 'generate_image',
                    status: 'completed',
                    agentId: IMAGE_AGENT_ID,
                    model: result.model,
                    inputText: promptText,
                    outputText: outputSummary,
                    usageMetadata,
                },
            ],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error ?? 'Unknown image generation error.');
        return {
            status: 'error',
            error: `Failed to generate image: ${errorMessage}`,
        };
    }
}

/**
 * Implementation of call_coding_agent tool.
 * Delegates a coding task to the specialized Coding Agent.
 */
export async function call_coding_agent({ task, context, file_paths, attachments }) {
    const taskText = String(task ?? '').trim();
    if (!taskText) {
        return { error: 'task is required.' };
    }

    try {
        const filesData = [];
        if (Array.isArray(file_paths) && file_paths.length > 0) {
            for (const path of file_paths) {
                const absolutePath = isAbsolute(path) ? path : resolve(process.cwd(), path);
                try {
                    const content = await readFile(absolutePath, 'utf8');
                    filesData.push({ path: absolutePath, content });
                } catch (err) {
                    filesData.push({ path: absolutePath, content: `Error reading file: ${err.message}` });
                }
            }
        }

        const result = await generateCodingExpertAdvice({
            task: taskText,
            context,
            files: filesData,
            attachments: Array.isArray(attachments) ? attachments : [],
        });

        const usageMetadata = result.usageMetadata && typeof result.usageMetadata === 'object'
            ? result.usageMetadata
            : null;

        return {
            ok: result.ok !== false,
            status: result.ok !== false ? 'completed' : 'error',
            model: result.model,
            agentThought: result.thought || '',
            text: result.text || '',
            parts: result.parts || [],
            steps: result.steps || [],
            fileCount: filesData.length,
            attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
            _usage: {
                model: result.model,
                status: result.ok !== false ? 'completed' : 'error',
                agentId: CODING_AGENT_ID,
                inputText: taskText,
                outputText: result.text || '',
                usageMetadata,
            },
        };
    } catch (error) {
        return { error: `Coding agent call failed: ${error.message}` };
    }
}

/**
 * Implementation of run_command tool.
 * Starts a shell command and returns a live session snapshot.
 */
export async function run_command({
    CommandLine,
    Cwd,
    WaitMsBeforeAsync = COMMAND_DEFAULT_WAIT_BEFORE_ASYNC_MS,
}) {
    const commandLine = String(CommandLine ?? '').trim();
    if (!commandLine) {
        return { error: 'CommandLine is required.' };
    }

    const cwd = resolveCommandWorkingDirectory(Cwd);
    try {
        const cwdStats = await stat(cwd);
        if (!cwdStats.isDirectory()) {
            return { error: `Cwd is not a directory: ${cwd}` };
        }
    } catch (error) {
        return { error: `Invalid Cwd ${cwd}: ${error.message}` };
    }

    let session;
    try {
        session = startCommandSession(commandLine, cwd);
    } catch (error) {
        return {
            error: `Failed to start command: ${error.message}`,
        };
    }

    const waitMs = clampInteger(
        WaitMsBeforeAsync,
        COMMAND_DEFAULT_WAIT_BEFORE_ASYNC_MS,
        0,
        COMMAND_MAX_WAIT_BEFORE_ASYNC_MS,
    );

    if (waitMs > 0) {
        await Promise.race([
            session.donePromise,
            sleep(waitMs),
        ]);
    }

    return createCommandSnapshot(session);
}

/**
 * Returns live status for a running/finished command session.
 */
export async function getCommandStatusSnapshot({
    commandId,
    waitDurationSeconds = 0,
    outputCharacterCount = COMMAND_OUTPUT_DEFAULT_CHARS,
}) {
    const normalizedId = String(commandId ?? '').trim();
    if (!normalizedId) {
        return { error: 'CommandId is required.' };
    }

    const session = commandSessions.get(normalizedId);
    if (!session) {
        return { error: `Unknown command id: ${normalizedId}` };
    }

    const previousOutputCharsTotal = session.outputCharsTotal;
    await waitForCommandChange(session, waitDurationSeconds, previousOutputCharsTotal);
    return createCommandSnapshot(session, { outputCharacterCount });
}

/**
 * Implementation of command_status tool.
 * Allows polling command output/status.
 */
export async function command_status({
    CommandId,
    WaitDurationSeconds = 0,
    OutputCharacterCount = COMMAND_OUTPUT_DEFAULT_CHARS,
}) {
    return getCommandStatusSnapshot({
        commandId: CommandId,
        waitDurationSeconds: WaitDurationSeconds,
        outputCharacterCount: OutputCharacterCount,
    });
}

/**
 * Implementation of send_command_input tool.
 * Sends text to stdin and/or interrupts a running command.
 */
export async function send_command_input({
    CommandId,
    Input,
    Terminate = false,
    WaitMs = 0,
}) {
    const normalizedId = String(CommandId ?? '').trim();
    if (!normalizedId) {
        return { error: 'CommandId is required.' };
    }

    const session = commandSessions.get(normalizedId);
    if (!session) {
        return { error: `Unknown command id: ${normalizedId}` };
    }

    const input = String(Input ?? '');
    const terminate = normalizeBoolean(Terminate, false);
    const waitMs = clampInteger(WaitMs, 0, 0, 10_000);

    if (session.status !== 'running') {
        return createCommandSnapshot(session);
    }

    if (input && session.process?.stdin && !session.process.stdin.destroyed) {
        try {
            session.process.stdin.write(input);
        } catch (error) {
            appendCommandOutput(session, `\n[stdin-error] ${error.message}\n`);
        }
    }

    if (terminate && session.process) {
        try {
            session.process.kill('SIGINT');
        } catch {
            // noop
        }
    }

    if (waitMs > 0) {
        const previousOutputCharsTotal = session.outputCharsTotal;
        await waitForCommandChange(session, waitMs / 1000, previousOutputCharsTotal);
    }

    return createCommandSnapshot(session);
}

/**
 * Implementation of read_terminal tool.
 * Looks up a command session by name or process id.
 */
export async function read_terminal({
    Name,
    ProcessID,
    OutputCharacterCount = COMMAND_OUTPUT_DEFAULT_CHARS,
}) {
    const session = getSessionByNameOrPid({ Name, ProcessID });
    if (!session) {
        return { error: 'No matching terminal session found.' };
    }

    return createCommandSnapshot(session, {
        outputCharacterCount: OutputCharacterCount,
    });
}

// Map of tool names to their implementation functions
export const toolRegistry = {
    list_dir,
    view_file,
    view_file_outline,
    view_code_item,
    find_by_name,
    grep_search,
    read_url_content,
    view_content_chunk,
    search_web,
    generate_image,
    run_command,
    command_status,
    send_command_input,
    read_terminal,
    write_to_file,
    replace_file_content,
    multi_replace_file_content,
    call_coding_agent,
};

export {
    extractToolMediaParts,
    sanitizeToolResultForModel,
};
