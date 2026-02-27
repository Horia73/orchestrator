import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { normalizeBoolean, normalizeInteger, countOccurrences } from '../_utils.js';

export const declaration = {
    name: 'replace_file_content',
    description: 'Replace a target snippet within a specific line range of a file.',
    parameters: {
        type: 'OBJECT',
        properties: {
            TargetFile: {
                type: 'STRING',
                description: 'Absolute path to target file.',
            },
            StartLine: {
                type: 'INTEGER',
                description: '1-indexed start line of search range (inclusive).',
            },
            EndLine: {
                type: 'INTEGER',
                description: '1-indexed end line of search range (inclusive).',
            },
            TargetContent: {
                type: 'STRING',
                description: 'Exact text to find inside the provided line range.',
            },
            ReplacementContent: {
                type: 'STRING',
                description: 'Replacement text.',
            },
            AllowMultiple: {
                type: 'BOOLEAN',
                description: 'If true, replaces all occurrences in range.',
            },
            waitForPreviousTools: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
        },
        required: ['TargetFile', 'StartLine', 'EndLine', 'TargetContent', 'ReplacementContent', 'AllowMultiple'],
    },
};

export async function execute({
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
            return { error: `EndLine (${endLine}) is out of bounds for file with ${lines.length} lines.` };
        }

        const rangeStartIndex = startLine - 1;
        const rangeEndIndex = endLine;
        const originalRangeText = lines.slice(rangeStartIndex, rangeEndIndex).join('\n');

        const occurrences = countOccurrences(originalRangeText, targetContent);
        if (occurrences === 0) {
            return { error: 'TargetContent was not found in the provided line range.' };
        }

        if (!allowMultiple && occurrences > 1) {
            return { error: 'TargetContent appears multiple times in range. Set AllowMultiple=true or narrow range.' };
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

        await writeFile(targetPath, updatedLines.join(lineEnding), 'utf8');

        const previewLines = [];
        if (startLine > 1) {
            previewLines.push({ type: 'context', lineNumber: startLine - 1, text: lines[startLine - 2] });
        }
        for (let i = 0; i < originalRangeLines.length; i += 1) {
            previewLines.push({ type: 'removed', oldLineNumber: startLine + i, text: originalRangeLines[i] });
        }
        for (let i = 0; i < replacedRangeLines.length; i += 1) {
            previewLines.push({ type: 'added', newLineNumber: startLine + i, text: replacedRangeLines[i] });
        }
        if (endLine < lines.length) {
            previewLines.push({ type: 'context', lineNumber: endLine + 1, text: lines[endLine] });
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
            diffPreview: { lines: previewLines.slice(0, 200) },
        };
    } catch (error) {
        return { error: `Failed to replace content in ${targetPath}: ${error.message}` };
    }
}
