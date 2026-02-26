import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
    GEMINI_API_KEY,
    GEMINI_CONTEXT_MESSAGES,
} from './config.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { getAgentConfig } from './settings.js';
import { toolRegistry } from './tools.js';

const TOOLS = [
    {
        functionDeclarations: [
            {
                name: 'list_dir',
                description: 'List the contents of a directory, i.e. all files and subdirectories that are children of the directory.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        DirectoryPath: {
                            type: 'STRING',
                            description: 'Path to list contents of, should be absolute path to a directory',
                        },
                        waitForPreviousTools: {
                            type: 'BOOLEAN',
                            description: 'Optional scheduling hint. Ignored by local tool implementation.',
                        },
                    },
                    required: ['DirectoryPath'],
                },
            },
            {
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
            },
            {
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
            },
            {
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
            },
            {
                name: 'find_by_name',
                description: 'Search for files and subdirectories within a specified directory using a glob pattern.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        SearchDirectory: {
                            type: 'STRING',
                            description: 'The absolute directory path to search within.',
                        },
                        Pattern: {
                            type: 'STRING',
                            description: 'Glob pattern to match against file or directory names.',
                        },
                        Type: {
                            type: 'STRING',
                            description: 'Optional type filter: file, directory, or any.',
                        },
                        Extensions: {
                            type: 'ARRAY',
                            items: { type: 'STRING' },
                            description: 'Optional list of file extensions to include (without leading dot).',
                        },
                        Excludes: {
                            type: 'ARRAY',
                            items: { type: 'STRING' },
                            description: 'Optional list of glob patterns to exclude.',
                        },
                        FullPath: {
                            type: 'BOOLEAN',
                            description: 'If true, match Pattern against full absolute path instead of only filename.',
                        },
                        MaxDepth: {
                            type: 'INTEGER',
                            description: 'Optional maximum recursion depth.',
                        },
                        waitForPreviousTools: {
                            type: 'BOOLEAN',
                            description: 'Optional scheduling hint. Ignored by local tool implementation.',
                        },
                    },
                    required: ['SearchDirectory', 'Pattern'],
                },
            },
            {
                name: 'grep_search',
                description: 'Search text inside files using ripgrep.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        Query: {
                            type: 'STRING',
                            description: 'The search text or regex pattern.',
                        },
                        SearchPath: {
                            type: 'STRING',
                            description: 'Absolute path to a file or directory to search.',
                        },
                        Includes: {
                            type: 'ARRAY',
                            items: { type: 'STRING' },
                            description: 'Optional glob filters for file paths.',
                        },
                        IsRegex: {
                            type: 'BOOLEAN',
                            description: 'If true, treat Query as regex. If false, literal search.',
                        },
                        MatchPerLine: {
                            type: 'BOOLEAN',
                            description: 'If true, return line-level matches. If false, return only file names.',
                        },
                        CaseInsensitive: {
                            type: 'BOOLEAN',
                            description: 'If true, search is case-insensitive.',
                        },
                        waitForPreviousTools: {
                            type: 'BOOLEAN',
                            description: 'Optional scheduling hint. Ignored by local tool implementation.',
                        },
                    },
                    required: ['Query', 'SearchPath'],
                },
            },
            {
                name: 'read_url_content',
                description: 'Fetch the content of a URL via HTTP request.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        Url: {
                            type: 'STRING',
                            description: 'HTTP or HTTPS URL to fetch.',
                        },
                        waitForPreviousTools: {
                            type: 'BOOLEAN',
                            description: 'Optional scheduling hint. Ignored by local tool implementation.',
                        },
                    },
                    required: ['Url'],
                },
            },
            {
                name: 'view_content_chunk',
                description: 'View a specific chunk from a previously fetched URL document.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        document_id: {
                            type: 'STRING',
                            description: 'Document ID returned by read_url_content.',
                        },
                        position: {
                            type: 'INTEGER',
                            description: '0-indexed chunk position to view.',
                        },
                        waitForPreviousTools: {
                            type: 'BOOLEAN',
                            description: 'Optional scheduling hint. Ignored by local tool implementation.',
                        },
                    },
                    required: ['document_id', 'position'],
                },
            },
            {
                name: 'run_command',
                description: 'Run a shell command in the workspace and return a live command session snapshot.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        CommandLine: {
                            type: 'STRING',
                            description: 'Command to execute in a shell.',
                        },
                        Cwd: {
                            type: 'STRING',
                            description: 'Optional working directory (absolute or relative to workspace).',
                        },
                        WaitMsBeforeAsync: {
                            type: 'INTEGER',
                            description: 'Optional milliseconds to wait before returning while command may continue in background.',
                        },
                        SafeToAutoRun: {
                            type: 'BOOLEAN',
                            description: 'Optional scheduling hint. Ignored by local tool implementation.',
                        },
                        waitForPreviousTools: {
                            type: 'BOOLEAN',
                            description: 'Optional scheduling hint. Ignored by local tool implementation.',
                        },
                    },
                    required: ['CommandLine'],
                },
            },
            {
                name: 'command_status',
                description: 'Poll the status/output of a previously started command session.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        CommandId: {
                            type: 'STRING',
                            description: 'Command session id returned by run_command.',
                        },
                        WaitDurationSeconds: {
                            type: 'NUMBER',
                            description: 'Optional long-poll duration in seconds.',
                        },
                        OutputCharacterCount: {
                            type: 'INTEGER',
                            description: 'Optional number of output characters to return from the tail.',
                        },
                        waitForPreviousTools: {
                            type: 'BOOLEAN',
                            description: 'Optional scheduling hint. Ignored by local tool implementation.',
                        },
                    },
                    required: ['CommandId'],
                },
            },
            {
                name: 'send_command_input',
                description: 'Send stdin input to a running command session or request termination.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        CommandId: {
                            type: 'STRING',
                            description: 'Command session id returned by run_command.',
                        },
                        Input: {
                            type: 'STRING',
                            description: 'Optional input text to write to stdin.',
                        },
                        Terminate: {
                            type: 'BOOLEAN',
                            description: 'If true, send SIGINT to the command process.',
                        },
                        WaitMs: {
                            type: 'INTEGER',
                            description: 'Optional wait in milliseconds before returning updated status.',
                        },
                        SafeToAutoRun: {
                            type: 'BOOLEAN',
                            description: 'Optional scheduling hint. Ignored by local tool implementation.',
                        },
                        waitForPreviousTools: {
                            type: 'BOOLEAN',
                            description: 'Optional scheduling hint. Ignored by local tool implementation.',
                        },
                    },
                    required: ['CommandId'],
                },
            },
            {
                name: 'read_terminal',
                description: 'Read terminal state by command name or process id.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        Name: {
                            type: 'STRING',
                            description: 'Optional command name hint (e.g. npm, node, pytest).',
                        },
                        ProcessID: {
                            type: 'INTEGER',
                            description: 'Optional process id to lookup.',
                        },
                        OutputCharacterCount: {
                            type: 'INTEGER',
                            description: 'Optional number of output characters to return from the tail.',
                        },
                        waitForPreviousTools: {
                            type: 'BOOLEAN',
                            description: 'Optional scheduling hint. Ignored by local tool implementation.',
                        },
                    },
                },
            },
            {
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
            },
            {
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
            },
            {
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
            },
        ],
    },
];

const THINKING_LEVEL_MAP = {
    MINIMAL: ThinkingLevel.MINIMAL,
    LOW: ThinkingLevel.LOW,
    MEDIUM: ThinkingLevel.MEDIUM,
    HIGH: ThinkingLevel.HIGH,
};

let cachedClient = null;

function mapThinkingLevel(level) {
    const normalized = String(level ?? '').trim().toUpperCase();
    return THINKING_LEVEL_MAP[normalized] ?? ThinkingLevel.MINIMAL;
}

function normalizePart(part) {
    if (!part || typeof part !== 'object') {
        return null;
    }

    const normalized = {};

    if (typeof part.thought === 'boolean') {
        normalized.thought = part.thought;
    }

    if (typeof part.thoughtSignature === 'string' && part.thoughtSignature.trim().length > 0) {
        normalized.thoughtSignature = part.thoughtSignature;
    }

    // Gemini Part uses oneof for its main data field.
    // Defensive normalization: if old persisted data has multiple data fields,
    // keep a single representative field to avoid 400 INVALID_ARGUMENT.
    const hasText = typeof part.text === 'string';
    const hasFunctionCall = !!(part.functionCall && typeof part.functionCall === 'object');
    const hasFunctionResponse = !!(part.functionResponse && typeof part.functionResponse === 'object');
    const hasInlineData = !!(part.inlineData && typeof part.inlineData === 'object');
    const hasFileData = !!(part.fileData && typeof part.fileData === 'object');

    if (hasFunctionCall) {
        normalized.functionCall = part.functionCall;
    } else if (hasFunctionResponse) {
        normalized.functionResponse = part.functionResponse;
    } else if (hasText) {
        normalized.text = part.text;
    } else if (hasInlineData) {
        normalized.inlineData = part.inlineData;
    } else if (hasFileData) {
        normalized.fileData = part.fileData;
    }

    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeParts(parts) {
    if (!Array.isArray(parts)) {
        return null;
    }

    const normalized = parts
        .map(normalizePart)
        .filter(Boolean);

    return normalized.length > 0 ? normalized : null;
}

function normalizeMessageParts(message) {
    const preservedParts = normalizeParts(message?.parts);
    if (preservedParts) {
        return preservedParts;
    }

    return [{ text: String(message?.text ?? '') }];
}

const TOOL_TRACE_MAX_ARGS_CHARS = 1200;
const TOOL_TRACE_MAX_RESPONSE_CHARS = 6000;
const TOOL_TRACE_MAX_TOTAL_CHARS = 20000;

function safeJsonStringify(value) {
    try {
        return JSON.stringify(value ?? null);
    } catch {
        return '"[unserializable]"';
    }
}

function truncateForToolTrace(text, maxChars) {
    const raw = String(text ?? '');
    if (raw.length <= maxChars) {
        return raw;
    }

    const remaining = raw.length - maxChars;
    return `${raw.slice(0, maxChars)}... [truncated ${remaining} chars]`;
}

function buildToolTraceText(parts) {
    if (!Array.isArray(parts) || parts.length === 0) {
        return '';
    }

    const callParts = parts.filter((part) => part?.functionCall && !part?.thoughtSignature);
    const responseParts = parts
        .filter((part) => part?.functionResponse)
        .map((part) => part.functionResponse);

    if (callParts.length === 0 && responseParts.length === 0) {
        return '';
    }

    const entries = callParts.map((part) => {
        const call = part.functionCall ?? {};
        return {
            id: typeof call.id === 'string' ? call.id.trim() : '',
            name: typeof call.name === 'string' ? call.name : 'unknown_tool',
            args: call.args ?? {},
            response: undefined,
        };
    });

    const callIndexById = new Map();
    const pendingIndexesByName = new Map();
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry.id) {
            callIndexById.set(entry.id, index);
        }

        const queue = pendingIndexesByName.get(entry.name) ?? [];
        queue.push(index);
        pendingIndexesByName.set(entry.name, queue);
    }

    for (const functionResponse of responseParts) {
        const responseId = typeof functionResponse?.id === 'string' ? functionResponse.id.trim() : '';
        const responseName = typeof functionResponse?.name === 'string'
            ? functionResponse.name
            : 'unknown_tool';
        let targetIndex;

        if (responseId && callIndexById.has(responseId)) {
            targetIndex = callIndexById.get(responseId);
        } else {
            const queue = pendingIndexesByName.get(responseName) ?? [];
            while (queue.length > 0) {
                const candidate = queue.shift();
                if (candidate !== undefined && entries[candidate]?.response === undefined) {
                    targetIndex = candidate;
                    break;
                }
            }
            pendingIndexesByName.set(responseName, queue);
        }

        if (targetIndex === undefined) {
            entries.push({
                id: responseId,
                name: responseName,
                args: {},
                response: functionResponse?.response ?? null,
            });
            continue;
        }

        entries[targetIndex].response = functionResponse?.response ?? null;
    }

    const lines = [
        '[tool_trace]',
        `tool_count=${entries.length}`,
    ];

    for (let index = 0; index < entries.length; index += 1) {
        const item = entries[index];
        const itemNo = index + 1;
        lines.push(`tool_${itemNo}_name=${item.name}`);
        lines.push(`tool_${itemNo}_args=${truncateForToolTrace(safeJsonStringify(item.args), TOOL_TRACE_MAX_ARGS_CHARS)}`);
        if (item.response !== undefined) {
            lines.push(`tool_${itemNo}_response=${truncateForToolTrace(safeJsonStringify(item.response), TOOL_TRACE_MAX_RESPONSE_CHARS)}`);
        } else {
            lines.push(`tool_${itemNo}_response="[pending]"`);
        }
    }
    lines.push('[/tool_trace]');

    return truncateForToolTrace(lines.join('\n'), TOOL_TRACE_MAX_TOTAL_CHARS);
}

function stripToolTraceBlocks(value) {
    const raw = String(value ?? '');
    if (!raw) return '';

    const withoutTrace = raw.replace(/\[tool_trace][\s\S]*?\[\/tool_trace]/g, '');
    return withoutTrace
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function sanitizeVisibleText(value) {
    return stripToolTraceBlocks(value);
}

function sanitizeStepsForOutput(steps) {
    if (!Array.isArray(steps)) return [];

    const sanitized = steps
        .map((step) => {
            if (!step || typeof step !== 'object') return null;
            return {
                ...step,
                text: sanitizeVisibleText(step.text ?? ''),
            };
        })
        .map(normalizeStep)
        .filter(Boolean);

    return sanitized;
}

function buildModelHistoryText(message) {
    const baseText = String(message?.text ?? '').trim();
    const toolTrace = buildToolTraceText(message?.parts);

    if (baseText && toolTrace) {
        return `${baseText}\n\n${toolTrace}`;
    }

    if (baseText) {
        return baseText;
    }

    if (toolTrace) {
        return toolTrace;
    }

    return '';
}

function normalizeHistory(messages) {
    return messages
        .filter((message) => message && (message.role === 'user' || message.role === 'ai'))
        .map((message) => {
            if (message.role === 'ai') {
                // Keep prior model turns oneof-safe while preserving tool context.
                return {
                    role: 'model',
                    parts: [{ text: buildModelHistoryText(message) }],
                };
            }

            return {
                role: 'user',
                parts: normalizeMessageParts(message),
            };
        });
}

function getClient() {
    if (!GEMINI_API_KEY) {
        throw new Error('Missing GEMINI_API_KEY or VITE_GEMINI_API_KEY in environment.');
    }

    if (!cachedClient) {
        cachedClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    }

    return cachedClient;
}

function createChatSession(historyWithLatestUserTurn) {
    if (!Array.isArray(historyWithLatestUserTurn) || historyWithLatestUserTurn.length === 0) {
        throw new Error('Cannot generate reply without a user message.');
    }

    const latest = historyWithLatestUserTurn[historyWithLatestUserTurn.length - 1];
    if (!latest || latest.role !== 'user') {
        throw new Error('Latest turn must be from user.');
    }

    const previousTurns = historyWithLatestUserTurn
        .slice(0, -1)
        .slice(-GEMINI_CONTEXT_MESSAGES);

    // Read model + thinking level dynamically from saved settings
    const agentConfig = getAgentConfig('orchestrator');

    const chat = getClient().chats.create({
        model: agentConfig.model,
        history: normalizeHistory(previousTurns),
        config: {
            systemInstruction: SYSTEM_PROMPT,
            thinkingConfig: {
                thinkingLevel: mapThinkingLevel(agentConfig.thinkingLevel),
                includeThoughts: true,
            },
            tools: TOOLS,
        },
    });

    return {
        chat,
        latestText: String(latest.text ?? ''),
    };
}

function mergeChunkIntoText(previousText, chunkText) {
    const nextChunk = String(chunkText ?? '');
    if (!nextChunk) return previousText;

    if (nextChunk.startsWith(previousText)) {
        return nextChunk;
    }

    if (previousText.startsWith(nextChunk)) {
        return previousText;
    }

    return `${previousText}${nextChunk}`;
}

function extractDelta(previousValue, currentValue) {
    const previous = String(previousValue ?? '');
    const current = String(currentValue ?? '');

    if (!current) return '';
    if (!previous) return current;

    if (current.startsWith(previous)) {
        return current.slice(previous.length);
    }

    // Defensive fallback for occasional non-prefix stream chunks.
    if (previous.startsWith(current)) {
        return '';
    }

    return current;
}

function normalizeStep(step) {
    if (!step || typeof step !== 'object') {
        return null;
    }

    const text = String(step.text ?? '');
    const thought = String(step.thought ?? '');
    const parts = normalizeParts(step.parts);
    const isThinking = step.isThinking === true;
    const isWorked = step.isWorked === true;
    const textFirst = step.textFirst === true;

    if (!text.trim() && !thought.trim() && !parts && !isThinking && !isWorked) {
        return null;
    }

    const normalized = {
        index: Number(step.index) || 0,
        text,
        thought,
    };

    if (parts) {
        normalized.parts = parts;
    }

    if (isThinking) {
        normalized.isThinking = true;
    }

    if (isWorked) {
        normalized.isWorked = true;
    }

    if (textFirst) {
        normalized.textFirst = true;
    }

    return normalized;
}

function normalizeSteps(steps) {
    if (!Array.isArray(steps)) {
        return [];
    }

    return steps
        .map(normalizeStep)
        .filter(Boolean);
}

function finalizeText(value) {
    const text = String(value ?? '').trim();
    if (text) {
        return text;
    }

    return 'No text response was returned by Gemini.';
}

function finalizeThought(value) {
    return String(value ?? '').trim();
}

function extractChunkThoughtText(chunk) {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
        return '';
    }

    let thought = '';
    for (const part of parts) {
        if (part?.thought === true && typeof part.text === 'string') {
            thought += part.text;
        }
    }

    return thought;
}

function extractChunkThoughtSignatures(chunk) {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
        return [];
    }

    const signatures = [];
    for (const part of parts) {
        if (typeof part?.thoughtSignature === 'string' && part.thoughtSignature.trim().length > 0) {
            signatures.push(part.thoughtSignature);
        }
    }

    return signatures;
}

function extractChunkSignatureParts(chunk) {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
        return [];
    }

    const signatureParts = [];
    for (const part of parts) {
        if (typeof part?.thoughtSignature !== 'string' || part.thoughtSignature.trim().length === 0) {
            continue;
        }

        const normalized = normalizePart(part);
        if (normalized) {
            signatureParts.push(normalized);
        }
    }

    return signatureParts;
}

function extractChunkResponseText(chunk) {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
        if (typeof chunk?.text === 'string') {
            return chunk.text;
        }
        return '';
    }

    let text = '';
    for (const part of parts) {
        if (part?.thought === true) {
            continue;
        }

        if (typeof part?.text === 'string') {
            text += part.text;
        }
    }

    return text;
}

function extractChunkFunctionCalls(chunk) {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
        return [];
    }

    const functionCalls = [];
    for (const part of parts) {
        if (part?.functionCall && typeof part.functionCall === 'object') {
            functionCalls.push(part.functionCall);
        }
    }

    return functionCalls;
}

function getFunctionCallKey(functionCall) {
    const id = typeof functionCall?.id === 'string' ? functionCall.id.trim() : '';
    if (id) {
        return `id:${id}`;
    }

    const name = typeof functionCall?.name === 'string' ? functionCall.name : 'unknown_tool';
    let argsKey = '{}';
    try {
        argsKey = JSON.stringify(functionCall?.args ?? {});
    } catch {
        argsKey = '[unserializable-args]';
    }

    return `${name}:${argsKey}`;
}

function buildFinalModelParts({ text, thought, signatureParts, toolParts = [] }) {
    const parts = [];
    if (thought) {
        parts.push({
            text: thought,
            thought: true,
        });
    }

    for (const toolPart of toolParts) {
        parts.push(toolPart);
    }

    if (text) {
        parts.push({ text });
    }

    for (const signaturePart of signatureParts) {
        parts.push(signaturePart);
    }

    return parts;
}

export async function generateAssistantReply(historyWithLatestUserTurn) {
    const { chat, latestText } = createChatSession(historyWithLatestUserTurn);

    const response = await chat.sendMessage({
        message: latestText,
    });

    return finalizeText(sanitizeVisibleText(response?.text));
}

export async function generateAssistantReplyStream(historyWithLatestUserTurn, { onUpdate, shouldStop } = {}) {
    const { chat, latestText } = createChatSession(historyWithLatestUserTurn);
    const isStopRequested = typeof shouldStop === 'function'
        ? () => shouldStop() === true
        : () => false;
    let stopped = false;

    let fullText = '';
    let fullThought = '';
    let emittedText = '';
    let emittedThought = '';
    let emittedSignatureKey = '';
    let emittedPartsKey = '';
    let emittedStepsKey = '';
    const thoughtSignatureSet = new Set();
    const signaturePartsByKey = new Map();
    const toolPartsAccumulator = [];
    const stepSnapshots = [];
    let lastStepTextCheckpoint = '';
    let lastStepThoughtCheckpoint = '';
    let lastStepToolPartIndex = 0;
    let currentStepSawThinking = false;
    let stepEventSequence = 0;
    let currentStepFirstTextEvent = null;
    let currentStepFirstToolEvent = null;

    function markCurrentStepTextEvent() {
        if (currentStepFirstTextEvent !== null) {
            return;
        }
        const textDelta = extractDelta(lastStepTextCheckpoint, fullText);
        if (!textDelta) {
            return;
        }
        stepEventSequence += 1;
        currentStepFirstTextEvent = stepEventSequence;
    }

    function markCurrentStepToolEvent() {
        if (currentStepFirstToolEvent !== null) {
            return;
        }
        stepEventSequence += 1;
        currentStepFirstToolEvent = stepEventSequence;
    }

    function buildCurrentStep({ isThinking = false } = {}) {
        const textDelta = extractDelta(lastStepTextCheckpoint, fullText);
        const thoughtDelta = extractDelta(lastStepThoughtCheckpoint, fullThought);
        const toolPartsDelta = toolPartsAccumulator
            .slice(lastStepToolPartIndex)
            .map((part) => normalizePart(part))
            .filter(Boolean);
        const hasStepPayload = textDelta.trim() || thoughtDelta.trim() || toolPartsDelta.length > 0;

        if (!hasStepPayload && !isThinking && !currentStepSawThinking) {
            return null;
        }

        const candidate = {
            index: stepSnapshots.length + 1,
            text: textDelta,
            thought: thoughtDelta,
            parts: toolPartsDelta,
        };

        const textAppearsBeforeTools = (
            currentStepFirstTextEvent !== null
            && (
                currentStepFirstToolEvent === null
                || currentStepFirstTextEvent <= currentStepFirstToolEvent
            )
        );
        if (textAppearsBeforeTools) {
            candidate.textFirst = true;
        }

        if (isThinking) {
            candidate.isThinking = true;
        } else {
            candidate.isWorked = true;
        }

        return normalizeStep(candidate);
    }

    function pushStepSnapshot() {
        const step = buildCurrentStep({ isThinking: false });
        if (!step) {
            return;
        }

        stepSnapshots.push(step);

        lastStepTextCheckpoint = fullText;
        lastStepThoughtCheckpoint = fullThought;
        lastStepToolPartIndex = toolPartsAccumulator.length;
        currentStepSawThinking = false;
        currentStepFirstTextEvent = null;
        currentStepFirstToolEvent = null;
    }

    function buildStreamingSteps({ stepIsThinking = false } = {}) {
        const normalizedCompletedSteps = normalizeSteps(stepSnapshots);
        const activeStep = buildCurrentStep({ isThinking: stepIsThinking });
        if (activeStep) {
            normalizedCompletedSteps.push(activeStep);
        }

        return normalizedCompletedSteps;
    }

    async function emitUpdate({ force = false, stepIsThinking = false, textOverride, thoughtOverride, partsOverride, stepsOverride } = {}) {
        if (!onUpdate) {
            return;
        }

        const updateText = sanitizeVisibleText(textOverride ?? fullText);
        const updateThought = thoughtOverride ?? fullThought;
        const currentThoughtSignatures = [...thoughtSignatureSet];
        const currentSignatureKey = currentThoughtSignatures.join('|');
        const currentParts = partsOverride ?? buildFinalModelParts({
            text: updateText,
            thought: updateThought,
            signatureParts: [...signaturePartsByKey.values()],
            toolParts: toolPartsAccumulator,
        });
        const currentSteps = sanitizeStepsForOutput(
            stepsOverride ?? buildStreamingSteps({ stepIsThinking }),
        );
        const currentPartsKey = safeJsonStringify(currentParts);
        const currentStepsKey = safeJsonStringify(currentSteps);

        const changed = (
            force
            || updateText !== emittedText
            || updateThought !== emittedThought
            || currentSignatureKey !== emittedSignatureKey
            || currentPartsKey !== emittedPartsKey
            || currentStepsKey !== emittedStepsKey
        );

        if (!changed) {
            return;
        }

        emittedText = updateText;
        emittedThought = updateThought;
        emittedSignatureKey = currentSignatureKey;
        emittedPartsKey = currentPartsKey;
        emittedStepsKey = currentStepsKey;

        await onUpdate({
            text: updateText,
            thought: updateThought,
            parts: currentParts,
            steps: currentSteps,
        });
    }

    async function processStream(currentStream) {
        const functionCallsByKey = new Map();

        for await (const chunk of currentStream) {
            if (isStopRequested()) {
                stopped = true;
                break;
            }

            const chunkParts = chunk?.candidates?.[0]?.content?.parts;
            if (Array.isArray(chunkParts) && chunkParts.length > 0) {
                for (const part of chunkParts) {
                    if (typeof part?.thoughtSignature === 'string' && part.thoughtSignature.trim().length > 0) {
                        thoughtSignatureSet.add(part.thoughtSignature);
                        const normalizedSignaturePart = normalizePart(part);
                        if (
                            normalizedSignaturePart
                            && typeof normalizedSignaturePart.thoughtSignature === 'string'
                            && !signaturePartsByKey.has(normalizedSignaturePart.thoughtSignature)
                        ) {
                            signaturePartsByKey.set(
                                normalizedSignaturePart.thoughtSignature,
                                normalizedSignaturePart,
                            );
                        }
                    }

                    if (part?.functionCall && typeof part.functionCall === 'object') {
                        const callKey = getFunctionCallKey(part.functionCall);
                        if (!functionCallsByKey.has(callKey)) {
                            functionCallsByKey.set(callKey, part.functionCall);
                            markCurrentStepToolEvent();
                        }
                        continue;
                    }

                    if (part?.thought === true && typeof part.text === 'string') {
                        fullThought = mergeChunkIntoText(fullThought, part.text);
                        continue;
                    }

                    if (typeof part?.text === 'string') {
                        fullText = mergeChunkIntoText(fullText, part.text);
                        markCurrentStepTextEvent();
                    }
                }
            } else {
                fullText = mergeChunkIntoText(fullText, extractChunkResponseText(chunk));
                markCurrentStepTextEvent();
                fullThought = mergeChunkIntoText(fullThought, extractChunkThoughtText(chunk));
                for (const signature of extractChunkThoughtSignatures(chunk)) {
                    thoughtSignatureSet.add(signature);
                }
                for (const signaturePart of extractChunkSignatureParts(chunk)) {
                    if (typeof signaturePart.thoughtSignature !== 'string') {
                        continue;
                    }
                    if (!signaturePartsByKey.has(signaturePart.thoughtSignature)) {
                        signaturePartsByKey.set(signaturePart.thoughtSignature, signaturePart);
                    }
                }
                for (const functionCall of extractChunkFunctionCalls(chunk)) {
                    const callKey = getFunctionCallKey(functionCall);
                    if (!functionCallsByKey.has(callKey)) {
                        functionCallsByKey.set(callKey, functionCall);
                        markCurrentStepToolEvent();
                    }
                }
            }

            await emitUpdate({ stepIsThinking: true });
        }

        // API request finished; keep the active step visible without thinking state.
        await emitUpdate({ stepIsThinking: false });

        return [...functionCallsByKey.values()];
    }

    if (isStopRequested()) {
        return {
            text: '',
            thought: '',
            parts: [],
            steps: [],
            stopped: true,
        };
    }

    // Show "thinking" immediately when API call starts, before first chunk arrives.
    currentStepSawThinking = true;
    await emitUpdate({ force: true, stepIsThinking: true });
    const initialStream = await chat.sendMessageStream({
        message: latestText,
    });
    let pendingFunctionCalls = await processStream(initialStream);

    // Handle tool calls if any (potentially multiple rounds)
    while (pendingFunctionCalls.length > 0 && !stopped) {
        const functionResponses = [];
        for (const functionCall of pendingFunctionCalls) {
            if (isStopRequested()) {
                stopped = true;
                break;
            }

            const name = typeof functionCall?.name === 'string' && functionCall.name
                ? functionCall.name
                : 'unknown_tool';
            const args = functionCall?.args && typeof functionCall.args === 'object'
                ? functionCall.args
                : {};

            const toolCallPartState = {
                functionCall,
                isExecuting: true,
            };
            markCurrentStepToolEvent();
            toolPartsAccumulator.push(toolCallPartState);

            await emitUpdate({ stepIsThinking: false });

            const toolFn = toolRegistry[name];
            let result;
            if (toolFn) {
                result = await toolFn(args);
            } else {
                result = { error: `Tool ${name} not found` };
            }

            toolCallPartState.isExecuting = false;

            const functionResponse = {
                name,
                response: result,
            };
            if (typeof functionCall?.id === 'string' && functionCall.id.trim().length > 0) {
                functionResponse.id = functionCall.id;
            }

            toolPartsAccumulator.push({
                functionResponse,
            });

            functionResponses.push({
                functionResponse,
            });

            await emitUpdate({ stepIsThinking: false });
        }

        if (stopped) {
            break;
        }

        if (functionResponses.length === 0) {
            break;
        }

        // One API step is complete once tool outputs are ready for the next model call.
        pushStepSnapshot();

        if (isStopRequested()) {
            stopped = true;
            break;
        }

        // Return tool outputs to the model and continue the stream.
        // Surface "thinking" immediately when the next API call is initiated.
        currentStepSawThinking = true;
        await emitUpdate({ force: true, stepIsThinking: true });
        const nextStream = await chat.sendMessageStream({
            message: functionResponses,
        });
        pendingFunctionCalls = await processStream(nextStream);
    }

    // Capture any trailing text/thought from the final model turn (no further tools).
    pushStepSnapshot();

    const visibleFullText = sanitizeVisibleText(fullText);
    const finalText = stopped
        ? String(visibleFullText ?? '').trim()
        : finalizeText(visibleFullText);
    const finalThought = finalizeThought(fullThought);
    const finalThoughtSignatures = [...thoughtSignatureSet];
    const finalSignatureKey = finalThoughtSignatures.join('|');
    const finalSteps = sanitizeStepsForOutput(normalizeSteps(stepSnapshots));
    const finalParts = buildFinalModelParts({
        text: finalText,
        thought: finalThought,
        signatureParts: [...signaturePartsByKey.values()],
        toolParts: toolPartsAccumulator,
    });
    const finalPartsKey = safeJsonStringify(finalParts);
    const finalStepsKey = safeJsonStringify(finalSteps);

    if (
        onUpdate
        && (
            finalText !== emittedText
            || finalThought !== emittedThought
            || finalSignatureKey !== emittedSignatureKey
            || finalPartsKey !== emittedPartsKey
            || finalStepsKey !== emittedStepsKey
        )
    ) {
        await onUpdate({
            text: finalText,
            thought: finalThought,
            parts: finalParts,
            steps: finalSteps,
        });
    }

    return {
        text: finalText,
        thought: finalThought,
        parts: finalParts,
        steps: finalSteps,
        stopped,
    };
}

export async function listAvailableModels() {
    if (!GEMINI_API_KEY) {
        throw new Error('Missing GEMINI_API_KEY in environment.');
    }
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
    if (!res.ok) {
        throw new Error(`Failed to fetch models: ${res.status}`);
    }
    const data = await res.json();
    return data.models || [];
}
