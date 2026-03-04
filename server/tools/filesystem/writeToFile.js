import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import { normalizeBoolean, toLogicalLines } from '../_utils.js';

const PREVIEW_LIMIT = 200;
const PREVIEW_CONTEXT_LINES = 2;

function getCommonPrefixLength(previousLines, nextLines) {
    const maxLength = Math.min(previousLines.length, nextLines.length);
    let index = 0;
    while (index < maxLength && previousLines[index] === nextLines[index]) {
        index += 1;
    }
    return index;
}

function getCommonSuffixLength(previousLines, nextLines, prefixLength) {
    const maxLength = Math.min(previousLines.length, nextLines.length) - prefixLength;
    let index = 0;
    while (
        index < maxLength
        && previousLines[previousLines.length - 1 - index] === nextLines[nextLines.length - 1 - index]
    ) {
        index += 1;
    }
    return index;
}

function buildWritePreviewLines(previousLines, nextLines, { existed }) {
    const previewLines = [];

    if (!existed) {
        for (let i = 0; i < nextLines.length && previewLines.length < PREVIEW_LIMIT; i += 1) {
            previewLines.push({ type: 'added', newLineNumber: i + 1, text: nextLines[i] });
        }
        return previewLines;
    }

    const prefixLength = getCommonPrefixLength(previousLines, nextLines);
    const suffixLength = getCommonSuffixLength(previousLines, nextLines, prefixLength);
    const previousMiddleEnd = previousLines.length - suffixLength;
    const nextMiddleEnd = nextLines.length - suffixLength;

    const prefixContextStart = Math.max(0, prefixLength - PREVIEW_CONTEXT_LINES);
    for (let i = prefixContextStart; i < prefixLength && previewLines.length < PREVIEW_LIMIT; i += 1) {
        previewLines.push({ type: 'context', lineNumber: i + 1, text: previousLines[i] });
    }

    for (let i = prefixLength; i < previousMiddleEnd && previewLines.length < PREVIEW_LIMIT; i += 1) {
        previewLines.push({ type: 'removed', oldLineNumber: i + 1, text: previousLines[i] });
    }

    for (let i = prefixLength; i < nextMiddleEnd && previewLines.length < PREVIEW_LIMIT; i += 1) {
        previewLines.push({ type: 'added', newLineNumber: i + 1, text: nextLines[i] });
    }

    const suffixContextEnd = Math.min(nextLines.length, nextMiddleEnd + PREVIEW_CONTEXT_LINES);
    for (let i = nextMiddleEnd; i < suffixContextEnd && previewLines.length < PREVIEW_LIMIT; i += 1) {
        previewLines.push({ type: 'context', lineNumber: i + 1, text: nextLines[i] });
    }

    if (previewLines.length === 0 && previousLines.length === nextLines.length) {
        const contextLine = previousLines[0] ?? '';
        previewLines.push({ type: 'context', lineNumber: 1, text: contextLine });
    }

    return previewLines;
}

function getWriteDeltaCounts(previousLines, nextLines, { existed }) {
    if (!existed) {
        return {
            addedLines: nextLines.length,
            removedLines: 0,
        };
    }

    const prefixLength = getCommonPrefixLength(previousLines, nextLines);
    const suffixLength = getCommonSuffixLength(previousLines, nextLines, prefixLength);

    return {
        addedLines: Math.max(0, nextLines.length - prefixLength - suffixLength),
        removedLines: Math.max(0, previousLines.length - prefixLength - suffixLength),
    };
}

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
        const { addedLines, removedLines } = getWriteDeltaCounts(oldLines, newLines, { existed });
        const previewLines = buildWritePreviewLines(oldLines, newLines, { existed });

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
