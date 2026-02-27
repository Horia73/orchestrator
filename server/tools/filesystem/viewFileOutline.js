import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { normalizeInteger } from '../_utils.js';
import { parseOutlineItems } from './_outline.js';

const PAGE_SIZE = 100;
const PREVIEW_MAX_LINES = 800;

export const declaration = {
    name: 'view_file_outline',
    description: 'View a lightweight outline of classes/functions in a file.',
    parameters: {
        type: 'OBJECT',
        properties: {
            AbsolutePath: {
                type: 'STRING',
                description: 'Path to file to inspect. Must be an absolute path.',
            },
            ItemOffset: {
                type: 'INTEGER',
                description: 'Optional pagination offset for outline items.',
            },
            waitForPreviousTools: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
        },
        required: ['AbsolutePath'],
    },
};

export async function execute({ AbsolutePath, ItemOffset }) {
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
        return { error: `Failed to view outline for ${targetPath}: ${error.message}` };
    }
}
