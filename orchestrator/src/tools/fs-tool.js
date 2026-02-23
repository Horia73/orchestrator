import fsp from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const MAX_READ_LINES = 800;
const MAX_SEARCH_RESULTS = 50;
const MAX_RESULT_CHARS = 8000;

// ── list_dir ────────────────────────────────────────────────────────────────────

async function listDir(dirPath) {
    try {
        const entries = await fsp.readdir(dirPath, { withFileTypes: true });
        const lines = entries.map((entry) => {
            if (entry.isDirectory()) return `[DIR]  ${entry.name}`;
            return `[FILE] ${entry.name}`;
        });
        return lines.join('\n') || '(empty directory)';
    } catch (err) {
        return `Error reading directory: ${err.message}`;
    }
}

// ── read_file (with line range support) ─────────────────────────────────────────

async function readFile(filePath, startLine, endLine) {
    try {
        const raw = await fsp.readFile(filePath, 'utf8');
        const allLines = raw.split('\n');
        const totalLines = allLines.length;

        let start = 1;
        let end = totalLines;

        if (Number.isFinite(startLine) && startLine > 0) {
            start = Math.min(startLine, totalLines);
        }
        if (Number.isFinite(endLine) && endLine > 0) {
            end = Math.min(endLine, totalLines);
        }
        if (end < start) end = start;

        // Cap to MAX_READ_LINES
        if ((end - start + 1) > MAX_READ_LINES) {
            end = start + MAX_READ_LINES - 1;
        }

        const selectedLines = allLines.slice(start - 1, end);
        const numbered = selectedLines.map((line, i) => `${start + i}: ${line}`);
        const header = `File: ${filePath} | Lines ${start}-${end} of ${totalLines}`;
        return `${header}\n${numbered.join('\n')}`;
    } catch (err) {
        return `Error reading file: ${err.message}`;
    }
}

// ── write_file ──────────────────────────────────────────────────────────────────

async function writeFile(filePath, contents) {
    try {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, contents, 'utf8');
        return `Successfully wrote to ${filePath}`;
    } catch (err) {
        return `Error writing file: ${err.message}`;
    }
}

// ── append_file ─────────────────────────────────────────────────────────────────

async function appendFile(filePath, contents) {
    try {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.appendFile(filePath, contents, 'utf8');
        return `Successfully appended to ${filePath}`;
    } catch (err) {
        return `Error appending to file: ${err.message}`;
    }
}

// ── edit_file (with uniqueness validation and flexible matching) ─────────────

function normalizeWhitespace(text) {
    return text.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n').trim();
}

async function editFile(filePath, targetText, replacementText) {
    try {
        const contents = await fsp.readFile(filePath, 'utf8');

        // Step 1: Exact match
        const exactCount = contents.split(targetText).length - 1;
        if (exactCount === 1) {
            const updated = contents.replace(targetText, replacementText);
            await fsp.writeFile(filePath, updated, 'utf8');
            return `Successfully edited ${filePath} (exact match)`;
        }

        if (exactCount > 1) {
            return `Error: target text found ${exactCount} times in ${filePath}. Must match exactly once. Make target text more specific or include surrounding context.`;
        }

        // Step 2: Flexible whitespace match
        const normalizedContents = normalizeWhitespace(contents);
        const normalizedTarget = normalizeWhitespace(targetText);
        if (normalizedContents.includes(normalizedTarget)) {
            // Find actual position using line-by-line approach
            const contentLines = contents.split('\n');
            const targetLines = targetText.split('\n').map((l) => l.trim());

            for (let i = 0; i <= contentLines.length - targetLines.length; i++) {
                let matches = true;
                for (let j = 0; j < targetLines.length; j++) {
                    if (contentLines[i + j].trim() !== targetLines[j]) {
                        matches = false;
                        break;
                    }
                }
                if (matches) {
                    const before = contentLines.slice(0, i).join('\n');
                    const after = contentLines.slice(i + targetLines.length).join('\n');
                    const updated = [before, replacementText, after].filter((s) => s !== '').join('\n');
                    await fsp.writeFile(filePath, updated, 'utf8');
                    return `Successfully edited ${filePath} (flexible whitespace match at line ${i + 1})`;
                }
            }
        }

        return `Error: target text not found in ${filePath}. Ensure the target text exactly matches content in the file, including indentation.`;
    } catch (err) {
        return `Error editing file: ${err.message}`;
    }
}

// ── search_files (ripgrep with fallback) ────────────────────────────────────────

async function searchFiles(dirPath, query) {
    // Try ripgrep first
    try {
        const { stdout } = await execFileAsync('rg', [
            '--no-heading',
            '--line-number',
            '--max-count', '5',
            '--max-filesize', '1M',
            '--glob', '!node_modules',
            '--glob', '!.git',
            '--glob', '!*.png',
            '--glob', '!*.jpg',
            '--glob', '!*.jpeg',
            '--glob', '!*.gif',
            '--glob', '!*.ico',
            '--glob', '!*.woff*',
            '--glob', '!*.ttf',
            '--glob', '!package-lock.json',
            query,
            dirPath,
        ], { timeout: 10000, maxBuffer: 1024 * 1024 });

        const lines = stdout.split('\n').filter(Boolean);
        if (lines.length > MAX_SEARCH_RESULTS) {
            return lines.slice(0, MAX_SEARCH_RESULTS).join('\n') + `\n... (${lines.length - MAX_SEARCH_RESULTS} more results truncated)`;
        }
        return lines.join('\n') || `No matches found for "${query}"`;
    } catch (rgError) {
        // ripgrep not found or returned non-zero (no matches)
        if (rgError.code === 1 || rgError.status === 1) {
            return `No matches found for "${query}"`;
        }

        // Fallback to naive scan if ripgrep is not installed
        if (rgError.code === 'ENOENT') {
            return searchFilesFallback(dirPath, query);
        }

        return `Search error: ${rgError.message}`;
    }
}

async function searchFilesFallback(dirPath, query) {
    try {
        const results = [];
        async function scan(currentDir, depth = 0) {
            if (depth > 8 || results.length >= MAX_SEARCH_RESULTS) return;
            const entries = await fsp.readdir(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                if (results.length >= MAX_SEARCH_RESULTS) break;
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== 'node_modules' && entry.name !== '.git') {
                        await scan(fullPath, depth + 1);
                    }
                } else if (entry.isFile() && !/\.(png|jpg|jpeg|gif|ico|woff|ttf)$/i.test(entry.name)) {
                    try {
                        const contents = await fsp.readFile(fullPath, 'utf8');
                        const lines = contents.split('\n');
                        for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
                            if (lines[i].includes(query)) {
                                results.push(`${fullPath}:${i + 1}:${lines[i].trim().slice(0, 200)}`);
                            }
                        }
                    } catch {
                        // ignore unreadable
                    }
                }
            }
        }
        await scan(dirPath);
        return results.length > 0 ? results.join('\n') : `No matches found for "${query}"`;
    } catch (err) {
        return `Error searching files: ${err.message}`;
    }
}

// ── file_outline (parse structure of JS/Python/Markdown files) ──────────────────

async function fileOutline(filePath) {
    try {
        const raw = await fsp.readFile(filePath, 'utf8');
        const ext = path.extname(filePath).toLowerCase();
        const lines = raw.split('\n');
        const totalLines = lines.length;
        const items = [];

        if (ext === '.js' || ext === '.mjs' || ext === '.ts' || ext === '.jsx' || ext === '.tsx') {
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const trimmed = line.trim();

                // Classes
                if (/^(export\s+)?(default\s+)?class\s+\w/.test(trimmed)) {
                    const match = trimmed.match(/class\s+(\w+)/);
                    items.push({ type: 'class', name: match?.[1] || 'unknown', line: i + 1 });
                }
                // Functions (named, arrow assigned, methods)
                else if (/^(export\s+)?(default\s+)?(async\s+)?function\s+\w/.test(trimmed)) {
                    const match = trimmed.match(/function\s+(\w+)/);
                    items.push({ type: 'function', name: match?.[1] || 'unknown', line: i + 1 });
                }
                else if (/^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/.test(trimmed) || /^(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s+)?function/.test(trimmed)) {
                    const match = trimmed.match(/(const|let|var)\s+(\w+)/);
                    items.push({ type: 'function', name: match?.[2] || 'unknown', line: i + 1 });
                }
                // Class methods
                else if (/^\s+(async\s+)?\w+\s*\(/.test(line) && !/^\s*(if|else|for|while|switch|return|try|catch|new|throw|const|let|var)/.test(trimmed)) {
                    const match = trimmed.match(/^(async\s+)?(\w+)\s*\(/);
                    if (match?.[2] && match[2] !== 'function') {
                        items.push({ type: 'method', name: match[2], line: i + 1 });
                    }
                }
                // Imports
                else if (/^import\s+/.test(trimmed)) {
                    const match = trimmed.match(/from\s+['"]([^'"]+)['"]/);
                    items.push({ type: 'import', name: match?.[1] || trimmed.slice(0, 60), line: i + 1 });
                }
            }
        } else if (ext === '.py') {
            for (let i = 0; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                if (/^class\s+\w/.test(trimmed)) {
                    const match = trimmed.match(/class\s+(\w+)/);
                    items.push({ type: 'class', name: match?.[1] || 'unknown', line: i + 1 });
                } else if (/^(async\s+)?def\s+\w/.test(trimmed)) {
                    const match = trimmed.match(/def\s+(\w+)/);
                    items.push({ type: 'function', name: match?.[1] || 'unknown', line: i + 1 });
                } else if (/^\s+(async\s+)?def\s+\w/.test(lines[i])) {
                    const match = trimmed.match(/def\s+(\w+)/);
                    items.push({ type: 'method', name: match?.[1] || 'unknown', line: i + 1 });
                }
            }
        } else if (ext === '.md') {
            for (let i = 0; i < lines.length; i++) {
                const match = lines[i].match(/^(#{1,6})\s+(.+)/);
                if (match) {
                    items.push({ type: `h${match[1].length}`, name: match[2].trim(), line: i + 1 });
                }
            }
        } else {
            return `File outline not supported for ${ext} files. Supported: .js .mjs .ts .jsx .tsx .py .md`;
        }

        if (items.length === 0) {
            return `${filePath} (${totalLines} lines) — no outline items found.`;
        }

        const header = `${filePath} (${totalLines} lines, ${items.length} items)`;
        const body = items.map((item) => `  L${item.line}: [${item.type}] ${item.name}`).join('\n');
        return `${header}\n${body}`;
    } catch (err) {
        return `Error reading file outline: ${err.message}`;
    }
}

// ── find_files (by name pattern using fd or fallback) ───────────────────────────

async function findFiles(dirPath, pattern) {
    // Extract extension from glob patterns like "*.js" or ".js"
    const extMatch = pattern.match(/^\*?\.(\w+)$/);
    const fdArgs = [
        '--max-results', String(MAX_SEARCH_RESULTS),
        '--exclude', 'node_modules',
        '--exclude', '.git',
    ];

    if (extMatch) {
        fdArgs.push('-e', extMatch[1], '', dirPath);
    } else {
        fdArgs.push(pattern, dirPath);
    }

    // Try fd first
    try {
        const { stdout } = await execFileAsync('fd', fdArgs, {
            timeout: 10000,
            maxBuffer: 512 * 1024,
        });

        const lines = stdout.split('\n').filter(Boolean);
        return lines.join('\n') || `No files matching "${pattern}"`;
    } catch (fdError) {
        // fd not installed — fallback with find
        if (fdError.code === 'ENOENT') {
            const findPattern = extMatch ? `*.${extMatch[1]}` : `*${pattern}*`;
            try {
                const { stdout } = await execFileAsync('find', [
                    dirPath,
                    '-maxdepth', '6',
                    '-name', findPattern,
                    '-not', '-path', '*/node_modules/*',
                    '-not', '-path', '*/.git/*',
                ], { timeout: 10000, maxBuffer: 512 * 1024 });

                const lines = stdout.split('\n').filter(Boolean).slice(0, MAX_SEARCH_RESULTS);
                return lines.join('\n') || `No files matching "${pattern}"`;
            } catch (findError) {
                return `Error finding files: ${findError.message}`;
            }
        }
        if (fdError.code === 1 || fdError.status === 1) {
            return `No files matching "${pattern}"`;
        }
        return `Error finding files: ${fdError.message}`;
    }
}

// ── FsToolClient ────────────────────────────────────────────────────────────────

export class FsToolClient {
    constructor(config = {}, { onLog } = {}) {
        this.config = config;
        this.onLog = typeof onLog === 'function' ? onLog : null;
    }

    updateConfig(patch = {}) {
        if (!patch || typeof patch !== 'object') return;
        if (typeof patch.enabled === 'boolean') {
            this.config.enabled = patch.enabled;
        }
    }

    getConfig() {
        return {
            enabled: Boolean(this.config.enabled),
        };
    }

    async runTask({ goal, signal }) {
        if (!this.config.enabled) {
            return {
                ok: false,
                agent: 'fs',
                goal,
                error: 'FS tool is disabled.',
                summary: 'FS tool disabled.',
            };
        }

        let parsedGoal = goal;
        if (typeof goal === 'string') {
            try {
                parsedGoal = JSON.parse(goal);
            } catch (err) {
                return {
                    ok: false,
                    agent: 'fs',
                    goal,
                    error: `Invalid goal JSON string: ${err.message}`,
                    summary: 'Invalid goal string.',
                };
            }
        }

        const {
            action,
            path: targetPath,
            content,
            targetText,
            replacementText,
            query,
            pattern,
            startLine,
            endLine,
        } = parsedGoal || {};

        this.onLog?.({
            level: 'info',
            component: 'fs-tool',
            event: 'tool_task_started',
            message: `FS action started: ${action} on ${targetPath || 'unknown_path'}`,
        });

        try {
            let result = '';
            if (action === 'list_dir') {
                result = await listDir(targetPath);
            } else if (action === 'read_file') {
                result = await readFile(targetPath, Number(startLine), Number(endLine));
            } else if (action === 'write_file') {
                result = await writeFile(targetPath, content);
            } else if (action === 'append_file') {
                result = await appendFile(targetPath, content);
            } else if (action === 'edit_file') {
                result = await editFile(targetPath, targetText, replacementText);
            } else if (action === 'search_files') {
                result = await searchFiles(targetPath, query);
            } else if (action === 'find_files') {
                result = await findFiles(targetPath, pattern || query);
            } else if (action === 'file_outline') {
                result = await fileOutline(targetPath);
            } else {
                return {
                    ok: false,
                    agent: 'fs',
                    goal,
                    error: `Unknown FS action: ${action}. Valid actions: list_dir, read_file, write_file, append_file, edit_file, search_files, find_files, file_outline`,
                    summary: `Unknown action: ${action}`,
                };
            }

            this.onLog?.({
                level: 'info',
                component: 'fs-tool',
                event: 'tool_task_completed',
                message: `FS action completed: ${action}`,
            });

            const isError = result.startsWith('Error');
            const summary = result.length > MAX_RESULT_CHARS
                ? result.substring(0, MAX_RESULT_CHARS) + `\n... (truncated, ${result.length} total chars)`
                : result;

            return {
                ok: !isError,
                agent: 'fs',
                goal,
                summary,
                text: result,
            };

        } catch (error) {
            this.onLog?.({
                level: 'error',
                component: 'fs-tool',
                event: 'tool_task_failed',
                message: error.message,
            });

            return {
                ok: false,
                agent: 'fs',
                goal,
                error: error.message,
                summary: error.message,
            };
        }
    }
}
