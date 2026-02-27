// Central tools registry. Replaces catalog.js + runtime.js.
// To add a new tool: create a file exporting `declaration` + `execute`, then add it to ALL_TOOLS below.

import * as listDir from './filesystem/listDir.js';
import * as viewFile from './filesystem/viewFile.js';
import * as viewFileOutline from './filesystem/viewFileOutline.js';
import * as viewCodeItem from './filesystem/viewCodeItem.js';
import * as findByName from './filesystem/findByName.js';
import * as grepSearch from './filesystem/grepSearch.js';
import * as writeToFile from './filesystem/writeToFile.js';
import * as replaceContent from './filesystem/replaceContent.js';
import * as multiReplace from './filesystem/multiReplace.js';
import * as readUrl from './web/readUrl.js';
import * as viewContentChunk from './web/viewContentChunk.js';
import * as searchWeb from './web/searchWeb.js';
import * as runCommand from './shell/runCommand.js';
import * as commandStatus from './shell/commandStatus.js';
import * as sendCommandInput from './shell/sendCommandInput.js';
import * as readTerminal from './shell/readTerminal.js';
import * as generateImage from './agents/generateImage.js';
import * as callCodingAgent from './agents/callCodingAgent.js';

const ALL_TOOLS = [
    listDir,
    viewFile,
    viewFileOutline,
    viewCodeItem,
    findByName,
    grepSearch,
    writeToFile,
    replaceContent,
    multiReplace,
    readUrl,
    viewContentChunk,
    searchWeb,
    runCommand,
    commandStatus,
    sendCommandInput,
    readTerminal,
    generateImage,
    callCodingAgent,
];

const declarationByName = new Map(ALL_TOOLS.map((tool) => [tool.declaration.name, tool.declaration]));

export const toolRegistry = Object.fromEntries(
    ALL_TOOLS.map((tool) => [tool.declaration.name, tool.execute]),
);

export const ALL_SHARED_TOOL_NAMES = ALL_TOOLS.map((tool) => tool.declaration.name);

export function buildFunctionTools(toolNames = []) {
    const requestedNames = Array.isArray(toolNames) ? toolNames : [];
    const selectedDeclarations = [];
    const used = new Set();

    for (const rawName of requestedNames) {
        const name = String(rawName ?? '').trim();
        if (!name || used.has(name)) continue;

        const declaration = declarationByName.get(name);
        if (!declaration) continue;

        selectedDeclarations.push(declaration);
        used.add(name);
    }

    if (selectedDeclarations.length === 0) {
        return undefined;
    }

    return [{ functionDeclarations: selectedDeclarations }];
}

// Re-export utilities consumed by geminiService and server/index.js
export { extractToolMediaParts, sanitizeToolResultForModel } from './_utils.js';
export { getCommandStatusSnapshot } from './shell/_sessions.js';
