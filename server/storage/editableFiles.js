import fs from 'node:fs';
import path from 'node:path';
import { listAgentDefinitions } from '../agents/index.js';
import { DATA_ROOT_DIR, SECRETS_ENV_PATH } from '../core/dataPaths.js';
import { syncSecretEnv } from '../core/secretEnv.js';

const SOURCE_ROOT_DIR = path.resolve(process.cwd());
const AGENTS_ROOT_DIR = path.join(SOURCE_ROOT_DIR, 'server', 'agents');
const SKIPPED_BASENAMES = new Set(['.DS_Store']);
const DATA_GROUP_ORDER = new Map([
    ['memory', 0],
    ['secrets', 1],
    ['cron', 2],
    ['logs', 3],
    ['usage', 4],
    ['chats', 5],
]);

function normalizeLineEndings(value) {
    return String(value ?? '').replace(/\r\n/g, '\n');
}

function toDisplayPath(value) {
    return String(value ?? '').split(path.sep).join('/');
}

function normalizeTimestamp(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp < 0) {
        return 0;
    }

    return Math.round(timestamp);
}

function isInsidePath(parentPath, candidatePath) {
    const relative = path.relative(parentPath, candidatePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getFileStat(filePath) {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) {
        const error = new Error('File not found.');
        error.code = 'EDITABLE_FILE_NOT_FOUND';
        throw error;
    }

    return stat;
}

function readTextFile(filePath) {
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) {
        const error = new Error('This file is not a text file and cannot be edited here.');
        error.code = 'EDITABLE_FILE_BINARY';
        throw error;
    }

    return buffer.toString('utf8');
}

function walkFiles(dirPath) {
    if (!fs.existsSync(dirPath)) {
        return [];
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        .filter((entry) => !SKIPPED_BASENAMES.has(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));

    const files = [];
    for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkFiles(entryPath));
            continue;
        }

        if (entry.isFile()) {
            files.push(entryPath);
        }
    }

    return files;
}

function buildDataEntry(filePath) {
    const stat = getFileStat(filePath);
    const relativePath = toDisplayPath(path.relative(DATA_ROOT_DIR, filePath));

    return {
        kind: 'data',
        path: filePath,
        label: relativePath || path.basename(filePath),
        relativePath,
        sizeBytes: stat.size,
        modifiedAt: normalizeTimestamp(stat.mtimeMs),
        sensitive: path.resolve(filePath) === path.resolve(SECRETS_ENV_PATH),
        restartRequired: false,
    };
}

function buildPromptEntry(filePath, agentDefinition) {
    const stat = getFileStat(filePath);
    const relativePath = toDisplayPath(path.relative(SOURCE_ROOT_DIR, filePath));

    return {
        kind: 'prompt',
        path: filePath,
        label: `${agentDefinition.name} prompt`,
        relativePath,
        sizeBytes: stat.size,
        modifiedAt: normalizeTimestamp(stat.mtimeMs),
        sensitive: false,
        restartRequired: true,
        agentId: agentDefinition.id,
        agentName: agentDefinition.name,
    };
}

function listPromptEntries() {
    return listAgentDefinitions()
        .map((agentDefinition) => {
            const promptPath = path.join(AGENTS_ROOT_DIR, agentDefinition.id, 'prompt.js');
            if (!fs.existsSync(promptPath)) {
                return null;
            }

            return buildPromptEntry(promptPath, agentDefinition);
        })
        .filter(Boolean);
}

function sortDataEntries(entries) {
    return [...entries].sort((a, b) => {
        const [aTopLevel = ''] = String(a.relativePath ?? '').split('/');
        const [bTopLevel = ''] = String(b.relativePath ?? '').split('/');
        const aRank = DATA_GROUP_ORDER.get(aTopLevel) ?? Number.MAX_SAFE_INTEGER;
        const bRank = DATA_GROUP_ORDER.get(bTopLevel) ?? Number.MAX_SAFE_INTEGER;
        if (aRank !== bRank) {
            return aRank - bRank;
        }

        return String(a.relativePath ?? '').localeCompare(String(b.relativePath ?? ''));
    });
}

function findPromptEntryByPath(filePath) {
    const normalizedTargetPath = path.resolve(filePath);
    return listPromptEntries().find((entry) => path.resolve(entry.path) === normalizedTargetPath) ?? null;
}

function resolveEditableEntry(filePath) {
    const normalizedInput = String(filePath ?? '').trim();
    if (!normalizedInput) {
        const error = new Error('A file path is required.');
        error.code = 'EDITABLE_FILE_INVALID_PATH';
        throw error;
    }
    const normalizedPath = path.resolve(normalizedInput);

    if (isInsidePath(path.resolve(DATA_ROOT_DIR), normalizedPath) && !SKIPPED_BASENAMES.has(path.basename(normalizedPath))) {
        return buildDataEntry(normalizedPath);
    }

    const promptEntry = findPromptEntryByPath(normalizedPath);
    if (promptEntry) {
        return promptEntry;
    }

    const error = new Error('This file cannot be edited from Settings.');
    error.code = 'EDITABLE_FILE_FORBIDDEN';
    throw error;
}

export function listEditableFileSections() {
    const dataEntries = sortDataEntries(
        walkFiles(DATA_ROOT_DIR).map((filePath) => buildDataEntry(filePath)),
    );
    const promptEntries = listPromptEntries();

    return [
        {
            id: 'data',
            label: 'Data files',
            items: dataEntries,
        },
        {
            id: 'prompts',
            label: 'Agent prompts',
            items: promptEntries,
        },
    ];
}

export function readEditableFile(filePath) {
    const entry = resolveEditableEntry(filePath);
    return {
        ...entry,
        content: readTextFile(entry.path),
    };
}

export function writeEditableFile({ filePath, content, expectedModifiedAt } = {}) {
    const entry = resolveEditableEntry(filePath);
    const currentStat = getFileStat(entry.path);
    const currentModifiedAt = normalizeTimestamp(currentStat.mtimeMs);
    const normalizedExpectedModifiedAt = normalizeTimestamp(expectedModifiedAt);

    if (normalizedExpectedModifiedAt > 0 && normalizedExpectedModifiedAt !== currentModifiedAt) {
        const error = new Error('The file changed on disk. Reload it before saving.');
        error.code = 'EDITABLE_FILE_CONFLICT';
        throw error;
    }

    fs.writeFileSync(entry.path, normalizeLineEndings(content), 'utf8');

    if (path.resolve(entry.path) === path.resolve(SECRETS_ENV_PATH)) {
        syncSecretEnv();
    }

    return readEditableFile(entry.path);
}
