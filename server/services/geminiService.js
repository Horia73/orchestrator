import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
    GEMINI_API_KEY,
    GEMINI_CONTEXT_MESSAGES,
} from '../core/config.js';
import {
    DEFAULT_AGENT_ID,
    getAgentDefinition,
    getAgentToolAccess,
    normalizeAgentId,
} from '../agents/index.js';
import { buildFunctionTools } from '../tools/catalog.js';
import { getAgentConfig } from '../storage/settings.js';
import {
    extractToolMediaParts,
    sanitizeToolResultForModel,
    toolRegistry,
} from '../tools/runtime.js';
import { executionContext } from '../core/context.js';

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

function buildChatConfigForAgent({ agentId, agentConfig, sharedTools }) {
    const agentDefinition = getAgentDefinition(agentId);
    return agentDefinition.buildChatConfig({
        agentConfig,
        mapThinkingLevel,
        sharedTools,
    });
}

function sanitizeInlineDataForGemini(inlineData) {
    if (!inlineData || typeof inlineData !== 'object') {
        return null;
    }

    const mimeType = String(inlineData.mimeType ?? inlineData.mime_type ?? '').trim();
    const data = String(inlineData.data ?? '').trim();
    if (!mimeType || !data) {
        return null;
    }

    return {
        mimeType,
        data,
    };
}

function sanitizeFileDataForGemini(fileData) {
    if (!fileData || typeof fileData !== 'object') {
        return null;
    }

    const fileUri = String(fileData.fileUri ?? fileData.file_uri ?? '').trim();
    if (!fileUri) {
        return null;
    }

    const mimeType = String(fileData.mimeType ?? fileData.mime_type ?? '').trim();
    return {
        fileUri,
        ...(mimeType ? { mimeType } : {}),
    };
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
        const sanitizedInlineData = sanitizeInlineDataForGemini(part.inlineData);
        if (sanitizedInlineData) {
            normalized.inlineData = sanitizedInlineData;
        }
    } else if (hasFileData) {
        const sanitizedFileData = sanitizeFileDataForGemini(part.fileData);
        if (sanitizedFileData) {
            normalized.fileData = sanitizedFileData;
        }
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
const TOOL_USAGE_MAX_TEXT_CHARS = 4000;

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

function truncateForToolUsage(value, maxChars = TOOL_USAGE_MAX_TEXT_CHARS) {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return '';
    }

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

function buildModelHistoryMediaParts(message) {
    const normalizedParts = normalizeParts(message?.parts);
    if (!normalizedParts) {
        return [];
    }

    return normalizedParts.filter((part) => {
        if (!part || typeof part !== 'object') return false;
        if (part.thought === true) return false;
        return !!(part.inlineData && typeof part.inlineData === 'object');
    });
}

function normalizeHistory(messages) {
    return messages
        .filter((message) => message && (message.role === 'user' || message.role === 'ai'))
        .map((message) => {
            if (message.role === 'ai') {
                // Keep prior model turns oneof-safe while preserving tool context.
                const mediaParts = buildModelHistoryMediaParts(message);
                const baseTextPart = { text: buildModelHistoryText(message) };
                return {
                    role: 'model',
                    parts: mediaParts.length > 0
                        ? [baseTextPart, ...mediaParts]
                        : [baseTextPart],
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

function createChatSession(historyWithLatestUserTurn, { agentId = DEFAULT_AGENT_ID } = {}) {
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

    const normalizedAgentId = normalizeAgentId(agentId);

    // Read model + generation options dynamically from saved settings
    const agentConfig = getAgentConfig(normalizedAgentId);
    const toolAccess = getAgentToolAccess(normalizedAgentId);
    const sharedTools = buildFunctionTools(toolAccess);

    const chat = getClient().chats.create({
        model: agentConfig.model,
        history: normalizeHistory(previousTurns),
        config: buildChatConfigForAgent({
            agentId: normalizedAgentId,
            agentConfig,
            sharedTools,
        }),
    });

    return {
        chat,
        latestMessage: normalizeMessageParts(latest),
        model: agentConfig.model,
        allowedToolNames: new Set(toolAccess),
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

function toTokenCount(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
    }

    return Math.trunc(parsed);
}

function normalizeUsageMetadata(usageMetadata) {
    if (!usageMetadata || typeof usageMetadata !== 'object') {
        return null;
    }

    const promptTokenCount = toTokenCount(usageMetadata.promptTokenCount);
    const candidatesTokenCount = toTokenCount(
        usageMetadata.candidatesTokenCount ?? usageMetadata.responseTokenCount,
    );
    const thoughtsTokenCount = toTokenCount(usageMetadata.thoughtsTokenCount);
    const toolUsePromptTokenCount = toTokenCount(usageMetadata.toolUsePromptTokenCount);

    let totalTokenCount = toTokenCount(usageMetadata.totalTokenCount);
    if (!totalTokenCount) {
        totalTokenCount = (
            promptTokenCount
            + candidatesTokenCount
            + thoughtsTokenCount
            + toolUsePromptTokenCount
        );
    }

    return {
        promptTokenCount,
        candidatesTokenCount,
        thoughtsTokenCount,
        toolUsePromptTokenCount,
        totalTokenCount,
    };
}

function normalizeToolUsageStatus(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'error') {
        return 'error';
    }

    if (normalized === 'stopped') {
        return 'stopped';
    }

    return 'completed';
}

function normalizeToolUsageRecord(
    rawRecord,
    {
        toolName,
        functionCall,
        args,
        toolResult,
    } = {},
) {
    if (!rawRecord || typeof rawRecord !== 'object') {
        return null;
    }

    const usageMetadata = rawRecord.usageMetadata && typeof rawRecord.usageMetadata === 'object'
        ? rawRecord.usageMetadata
        : null;
    const model = String(rawRecord.model ?? '').trim();
    if (!model && !usageMetadata) {
        return null;
    }

    const resolvedToolName = String(rawRecord.toolName ?? toolName ?? '').trim() || 'unknown_tool';
    const toolCallId = typeof functionCall?.id === 'string' && functionCall.id.trim()
        ? functionCall.id.trim()
        : '';
    const fallbackInputText = `[tool:${resolvedToolName}] ${safeJsonStringify(args ?? {})}`;
    const fallbackOutputText = typeof toolResult?.error === 'string' && toolResult.error.trim()
        ? `Tool error: ${toolResult.error.trim()}`
        : '';

    const createdAtValue = Number(rawRecord.createdAt);
    const createdAt = Number.isFinite(createdAtValue) && createdAtValue > 0
        ? Math.trunc(createdAtValue)
        : Date.now();

    return {
        source: String(rawRecord.source ?? '').trim().toLowerCase() || 'tool',
        toolName: resolvedToolName,
        toolCallId,
        status: normalizeToolUsageStatus(rawRecord.status),
        agentId: String(rawRecord.agentId ?? '').trim().toLowerCase(),
        model,
        inputText: truncateForToolUsage(rawRecord.inputText || fallbackInputText),
        outputText: truncateForToolUsage(rawRecord.outputText || fallbackOutputText),
        createdAt,
        usageMetadata,
    };
}

function extractToolUsageRecords(
    toolResult,
    {
        toolName,
        functionCall,
        args,
    } = {},
) {
    if (!toolResult || typeof toolResult !== 'object') {
        return [];
    }

    const rawUsageRecords = [];
    if (Array.isArray(toolResult._usageRecords)) {
        rawUsageRecords.push(...toolResult._usageRecords);
    }
    if (toolResult._usage && typeof toolResult._usage === 'object') {
        rawUsageRecords.push(toolResult._usage);
    }

    const normalized = rawUsageRecords
        .map((rawRecord) => normalizeToolUsageRecord(rawRecord, {
            toolName,
            functionCall,
            args,
            toolResult,
        }))
        .filter(Boolean);

    return normalized;
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

function buildFinalModelParts({ text, thought, mediaParts = [], signatureParts, toolParts = [] }) {
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

    for (const mediaPart of mediaParts) {
        parts.push(mediaPart);
    }

    if (text) {
        parts.push({ text });
    }

    for (const signaturePart of signatureParts) {
        parts.push(signaturePart);
    }

    return parts;
}

export async function generateAssistantReply(historyWithLatestUserTurn, { agentId = DEFAULT_AGENT_ID } = {}) {
    const { chat, latestMessage } = createChatSession(historyWithLatestUserTurn, { agentId });

    const response = await chat.sendMessage({
        message: latestMessage,
    });

    return finalizeText(sanitizeVisibleText(response?.text));
}

export async function generateAssistantReplyStream(
    historyWithLatestUserTurn,
    { onUpdate, shouldStop, agentId = DEFAULT_AGENT_ID, chatId = '', messageId = '', clientId = '' } = {},
) {
    const {
        chat,
        latestMessage,
        model,
        allowedToolNames,
    } = createChatSession(historyWithLatestUserTurn, { agentId });
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
    const mediaPartsByKey = new Map();
    const toolPartsAccumulator = [];
    const stepSnapshots = [];
    let lastStepTextCheckpoint = '';
    let lastStepThoughtCheckpoint = '';
    let lastStepToolPartIndex = 0;
    let currentStepSawThinking = false;
    let stepEventSequence = 0;
    let currentStepFirstTextEvent = null;
    let currentStepFirstToolEvent = null;
    let apiCallCount = 0;
    const usageAccumulator = {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        thoughtsTokenCount: 0,
        toolUsePromptTokenCount: 0,
        totalTokenCount: 0,
    };
    const toolUsageRecordsAccumulator = [];

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

    function accumulateUsage(usageMetadata) {
        const normalized = normalizeUsageMetadata(usageMetadata);
        if (!normalized) {
            return;
        }

        apiCallCount += 1;
        usageAccumulator.promptTokenCount += normalized.promptTokenCount;
        usageAccumulator.candidatesTokenCount += normalized.candidatesTokenCount;
        usageAccumulator.thoughtsTokenCount += normalized.thoughtsTokenCount;
        usageAccumulator.toolUsePromptTokenCount += normalized.toolUsePromptTokenCount;
        usageAccumulator.totalTokenCount += normalized.totalTokenCount;
    }

    function collectInlineMediaPart(rawPart) {
        if (!rawPart || typeof rawPart !== 'object') {
            return;
        }

        const inlineData = rawPart.inlineData;
        if (!inlineData || typeof inlineData !== 'object') {
            return;
        }

        // Ignore thought-only intermediate images emitted during model reasoning.
        if (rawPart.thought === true) {
            return;
        }

        const mimeType = String(inlineData.mimeType ?? inlineData.mime_type ?? '').trim().toLowerCase();
        const data = String(inlineData.data ?? '').trim();
        if (!mimeType.startsWith('image/') || !data) {
            return;
        }

        if (typeof rawPart.thoughtSignature === 'string' && rawPart.thoughtSignature.trim()) {
            return;
        }

        const normalizedMediaPart = normalizePart(rawPart);
        if (!normalizedMediaPart) {
            return;
        }

        const signatureKey = typeof rawPart.thoughtSignature === 'string' && rawPart.thoughtSignature.trim()
            ? rawPart.thoughtSignature.trim()
            : '';
        const fallbackKey = `${mimeType}:${data.length}:${data.slice(0, 48)}`;
        const key = signatureKey || fallbackKey;
        if (!mediaPartsByKey.has(key)) {
            mediaPartsByKey.set(key, normalizedMediaPart);
        }
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
            mediaParts: [...mediaPartsByKey.values()],
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
        let latestUsageMetadata = null;

        for await (const chunk of currentStream) {
            const normalizedChunkUsage = normalizeUsageMetadata(chunk?.usageMetadata);
            if (normalizedChunkUsage) {
                latestUsageMetadata = normalizedChunkUsage;
            }

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

                    if (part?.inlineData && typeof part.inlineData === 'object') {
                        collectInlineMediaPart(part);
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

        return {
            functionCalls: [...functionCallsByKey.values()],
            usageMetadata: latestUsageMetadata,
        };
    }

    if (isStopRequested()) {
        return {
            text: '',
            thought: '',
            parts: [],
            steps: [],
            stopped: true,
            model,
            apiCallCount: 0,
            toolUsageRecords: [],
            usageMetadata: {
                promptTokenCount: 0,
                candidatesTokenCount: 0,
                thoughtsTokenCount: 0,
                toolUsePromptTokenCount: 0,
                totalTokenCount: 0,
            },
        };
    }

    // Show "thinking" immediately when API call starts, before first chunk arrives.
    currentStepSawThinking = true;
    await emitUpdate({ force: true, stepIsThinking: true });
    const initialStream = await chat.sendMessageStream({
        message: latestMessage,
    });
    const initialStreamResult = await processStream(initialStream);
    accumulateUsage(initialStreamResult.usageMetadata);
    let pendingFunctionCalls = initialStreamResult.functionCalls;

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
            if (!allowedToolNames.has(name)) {
                result = { error: `Tool ${name} is not allowed for this agent.` };
            } else if (toolFn) {
                result = await executionContext.run({
                    chatId,
                    messageId,
                    clientId,
                    toolCallId: (typeof functionCall?.id === 'string' ? functionCall.id : ''),
                    toolName: name,
                }, () => toolFn(args));
            } else {
                result = { error: `Tool ${name} not found` };
            }

            const toolUsageRecords = extractToolUsageRecords(result, {
                toolName: name,
                functionCall,
                args,
            });
            for (const usageRecord of toolUsageRecords) {
                toolUsageRecordsAccumulator.push(usageRecord);
            }

            const toolMediaParts = extractToolMediaParts(result);
            for (const toolMediaPart of toolMediaParts) {
                collectInlineMediaPart(toolMediaPart);
            }

            const modelVisibleResult = sanitizeToolResultForModel(result);

            toolCallPartState.isExecuting = false;

            const functionResponse = {
                name,
                response: modelVisibleResult,
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
        const nextStreamResult = await processStream(nextStream);
        accumulateUsage(nextStreamResult.usageMetadata);
        pendingFunctionCalls = nextStreamResult.functionCalls;
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
        mediaParts: [...mediaPartsByKey.values()],
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
        model,
        apiCallCount,
        toolUsageRecords: toolUsageRecordsAccumulator,
        usageMetadata: usageAccumulator,
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
