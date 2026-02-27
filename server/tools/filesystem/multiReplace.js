import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { normalizeBoolean, normalizeInteger, countOccurrences } from '../_utils.js';

const PREVIEW_LIMIT = 220;

export const declaration = {
    name: 'multi_replace_file_content',
    description: 'Apply multiple replacement chunks in one pass on the same file.',
    parameters: {
        type: 'OBJECT',
        properties: {
            TargetFile: {
                type: 'STRING',
                description: 'Absolute path to target file.',
            },
            ReplacementChunks: {
                type: 'ARRAY',
                description: 'Array of replacement chunks.',
                items: {
                    type: 'OBJECT',
                    properties: {
                        StartLine: { type: 'INTEGER' },
                        EndLine: { type: 'INTEGER' },
                        TargetContent: { type: 'STRING' },
                        ReplacementContent: { type: 'STRING' },
                        AllowMultiple: { type: 'BOOLEAN' },
                    },
                    required: ['StartLine', 'EndLine', 'TargetContent', 'ReplacementContent', 'AllowMultiple'],
                },
            },
            waitForPreviousTools: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
        },
        required: ['TargetFile', 'ReplacementChunks'],
    },
};

export async function execute({ TargetFile, ReplacementChunks }) {
    const targetPath = String(TargetFile ?? '').trim();
    if (!targetPath) {
        return { error: 'TargetFile is required.' };
    }

    if (!isAbsolute(targetPath)) {
        return { error: `TargetFile must be an absolute path: ${targetPath}` };
    }

    const chunksInput = Array.isArray(ReplacementChunks) ? ReplacementChunks : [];
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

        preparedChunks.push({ index, startLine, endLine, targetContent, replacementContent, allowMultiple });
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

        for (const chunk of sortedChunks) {
            const { startLine, endLine, targetContent, replacementContent, allowMultiple, index } = chunk;

            if (endLine > workingLines.length) {
                return {
                    error: `Replacement chunk ${index + 1}: EndLine (${endLine}) is out of bounds for file with ${workingLines.length} lines.`,
                };
            }

            const beforeLines = workingLines;
            const originalRangeText = beforeLines.slice(startLine - 1, endLine).join('\n');

            const occurrences = countOccurrences(originalRangeText, targetContent);
            if (occurrences === 0) {
                return { error: `Replacement chunk ${index + 1}: TargetContent was not found in the provided line range.` };
            }

            if (!allowMultiple && occurrences > 1) {
                return { error: `Replacement chunk ${index + 1}: TargetContent appears multiple times in range. Set AllowMultiple=true or narrow range.` };
            }

            const replacedRangeText = allowMultiple
                ? originalRangeText.split(targetContent).join(replacementContent)
                : originalRangeText.replace(targetContent, replacementContent);

            const originalRangeLines = originalRangeText.split(/\r?\n/);
            const replacedRangeLines = replacedRangeText.split(/\r?\n/);

            workingLines = [
                ...beforeLines.slice(0, startLine - 1),
                ...replacedRangeLines,
                ...beforeLines.slice(endLine),
            ];

            totalRemovedLines += originalRangeLines.length;
            totalAddedLines += replacedRangeLines.length;
            totalReplacedOccurrences += allowMultiple ? occurrences : 1;

            if (previewLines.length < PREVIEW_LIMIT) {
                previewLines.push({ type: 'context', lineNumber: null, text: `@@ chunk ${index + 1} (${startLine}-${endLine}) @@` });
            }
            if (startLine > 1 && previewLines.length < PREVIEW_LIMIT) {
                previewLines.push({ type: 'context', lineNumber: startLine - 1, text: beforeLines[startLine - 2] });
            }
            for (let i = 0; i < originalRangeLines.length && previewLines.length < PREVIEW_LIMIT; i += 1) {
                previewLines.push({ type: 'removed', oldLineNumber: startLine + i, text: originalRangeLines[i] });
            }
            for (let i = 0; i < replacedRangeLines.length && previewLines.length < PREVIEW_LIMIT; i += 1) {
                previewLines.push({ type: 'added', newLineNumber: startLine + i, text: replacedRangeLines[i] });
            }
            if (endLine < beforeLines.length && previewLines.length < PREVIEW_LIMIT) {
                previewLines.push({ type: 'context', lineNumber: endLine + 1, text: beforeLines[endLine] });
            }
        }

        if (previewLines.length >= PREVIEW_LIMIT) {
            previewLines.push({ type: 'context', lineNumber: null, text: '... diff preview truncated ...' });
        }

        await writeFile(targetPath, workingLines.join(lineEnding), 'utf8');

        return {
            path: targetPath,
            relativePath: relative(process.cwd(), targetPath),
            chunkCount: preparedChunks.length,
            replacedOccurrences: totalReplacedOccurrences,
            resultingLineCount: workingLines.length,
            addedLines: totalAddedLines,
            removedLines: totalRemovedLines,
            diffPreview: { lines: previewLines.slice(0, PREVIEW_LIMIT) },
        };
    } catch (error) {
        return { error: `Failed to apply multi_replace_file_content in ${targetPath}: ${error.message}` };
    }
}
