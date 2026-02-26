import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

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

// Map of tool names to their implementation functions
export const toolRegistry = {
    list_dir,
    view_file,
};
