// Shared outline parsing helpers used by view_file_outline and view_code_item.

import { escapeRegex } from '../_utils.js';

export function findBlockEndLine(lines, startIndex) {
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

export function parseOutlineItems(lines) {
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

export function findOutlineItemForNodePath(outlineItems, requestedNodePath) {
    const requested = String(requestedNodePath ?? '').trim();
    if (!requested) return null;

    const exact = outlineItems.find((item) => item.nodePath === requested);
    if (exact) return exact;

    const leaf = requested.split('.').filter(Boolean).pop();
    if (!leaf) return null;

    return outlineItems.find((item) => item.nodePath === leaf) ?? null;
}

export function findFallbackCodeItem(lines, nodePath) {
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
