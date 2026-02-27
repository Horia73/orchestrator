import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import { normalizeBoolean, toLogicalLines } from '../_utils.js';

const PREVIEW_LIMIT = 200;

export const declaration = {
    name: 'write_to_file',
    description: 'Create or overwrite a file on disk.',
    parameters: {
        type: 'OBJECT',
        properties: {
            TargetFile: {
                type: 'STRING',
                description: 'Absolute path to target file.',
            },
            CodeContent: {
                type: 'STRING',
                description: 'Content to write to file.',
            },
            Overwrite: {
                type: 'BOOLEAN',
                description: 'Whether to overwrite existing file content.',
            },
            EmptyFile: {
                type: 'BOOLEAN',
                description: 'If true, create an empty file.',
            },
            waitForPreviousTools: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
        },
        required: ['TargetFile', 'Overwrite'],
    },
};

export async function execute({
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
            return { error: `TargetFile already exists and Overwrite is false: ${targetPath}` };
        }

        await writeFile(targetPath, content, 'utf8');

        const oldLines = toLogicalLines(previousContent);
        const newLines = toLogicalLines(content);
        const removedLines = existed ? oldLines.length : 0;
        const addedLines = newLines.length;
        const previewLines = [];

        if (existed) {
            for (let i = 0; i < oldLines.length && previewLines.length < PREVIEW_LIMIT; i += 1) {
                previewLines.push({ type: 'removed', oldLineNumber: i + 1, text: oldLines[i] });
            }
        }

        for (let i = 0; i < newLines.length && previewLines.length < PREVIEW_LIMIT; i += 1) {
            previewLines.push({ type: 'added', newLineNumber: i + 1, text: newLines[i] });
        }

        if ((oldLines.length + newLines.length) > PREVIEW_LIMIT) {
            previewLines.push({ type: 'context', lineNumber: null, text: '... diff preview truncated ...' });
        }

        return {
            path: targetPath,
            relativePath: relative(process.cwd(), targetPath),
            created: !existed,
            overwritten: existed,
            bytesWritten: Buffer.byteLength(content, 'utf8'),
            addedLines,
            removedLines,
            diffPreview: { lines: previewLines },
        };
    } catch (error) {
        return { error: `Failed to write file ${targetPath}: ${error.message}` };
    }
}
