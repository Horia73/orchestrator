import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

export const declaration = {
    name: 'view_file',
    description: 'View the contents of a file from the local filesystem.',
    parameters: {
        type: 'OBJECT',
        properties: {
            AbsolutePath: {
                type: 'STRING',
                description: 'Path to file to view. Must be an absolute path.',
            },
            StartLine: {
                type: 'INTEGER',
                description: 'Optional start line to view (1-indexed, inclusive).',
            },
            EndLine: {
                type: 'INTEGER',
                description: 'Optional end line to view (1-indexed, inclusive).',
            },
            waitForPreviousTools: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
        },
        required: ['AbsolutePath'],
    },
};

export async function execute({ AbsolutePath, StartLine, EndLine }) {
    const targetPath = String(AbsolutePath ?? '').trim();
    if (!targetPath) {
        return { error: 'AbsolutePath is required.' };
    }

    if (!isAbsolute(targetPath)) {
        return { error: `AbsolutePath must be an absolute path: ${targetPath}` };
    }

    const hasStart = StartLine !== undefined && StartLine !== null;
    const hasEnd = EndLine !== undefined && EndLine !== null;
    const parsedStart = hasStart ? Number(StartLine) : 1;
    const parsedEnd = hasEnd ? Number(EndLine) : undefined;

    if (!Number.isInteger(parsedStart) || parsedStart < 1) {
        return { error: 'StartLine must be an integer greater than or equal to 1.' };
    }

    if (parsedEnd !== undefined && (!Number.isInteger(parsedEnd) || parsedEnd < parsedStart)) {
        return { error: 'EndLine must be an integer greater than or equal to StartLine.' };
    }

    try {
        const fileStats = await stat(targetPath);
        if (!fileStats.isFile()) {
            return { error: `Path is not a file: ${targetPath}` };
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
        return { error: `Failed to view file ${targetPath}: ${error.message}` };
    }
}
