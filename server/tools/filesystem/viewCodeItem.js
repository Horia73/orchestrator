import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { parseOutlineItems, findOutlineItemForNodePath, findFallbackCodeItem } from './_outline.js';

const MAX_NODE_PATHS = 5;

export const declaration = {
    name: 'view_code_item',
    description: 'View code items (functions/classes) from a file by node path.',
    parameters: {
        type: 'OBJECT',
        properties: {
            File: {
                type: 'STRING',
                description: 'Absolute path to file.',
            },
            NodePaths: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: 'List of node paths to inspect (max 5).',
            },
            waitForPreviousTools: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
        },
        required: ['File', 'NodePaths'],
    },
};

export async function execute({ File, NodePaths }) {
    const targetPath = String(File ?? '').trim();
    if (!targetPath) {
        return { error: 'File is required.' };
    }

    if (!isAbsolute(targetPath)) {
        return { error: `File must be an absolute path: ${targetPath}` };
    }

    const nodePaths = Array.isArray(NodePaths)
        ? NodePaths.map((value) => String(value ?? '').trim()).filter(Boolean)
        : [];

    if (nodePaths.length === 0) {
        return { error: 'NodePaths must contain at least one node path.' };
    }

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
                items.push({ requestedNodePath, found: false, content: '' });
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

        return {
            path: targetPath,
            relativePath: relative(process.cwd(), targetPath),
            totalLines: lines.length,
            requestedCount: nodePaths.length,
            returnedCount: items.length,
            truncated: nodePaths.length > limitedNodePaths.length,
            matchCount: items.filter((item) => item.found === true).length,
            items,
        };
    } catch (error) {
        return { error: `Failed to view code item(s) in ${targetPath}: ${error.message}` };
    }
}
