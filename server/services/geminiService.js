import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import {
    getGeminiApiKey,
    getGeminiContextMessages,
    reloadConfigJson,
} from '../core/config.js';
import { retryOnRateLimit } from '../core/rateLimit.js';
import { CONFIG_PATH } from '../core/dataPaths.js';
import {
    DEFAULT_AGENT_ID,
    getAgentDefinition,
    getAgentToolAccess,
    normalizeAgentId,
} from '../agents/index.js';
import { MAX_SUBAGENT_TOOL_CALLS } from '../core/subagentPolicy.js';
import { getAgentConfig, readSettings, writeSettings } from '../storage/settings.js';
import {
    buildFunctionTools,
    extractToolMediaParts,
    sanitizeToolResultForModel,
    toolRegistry,
} from '../tools/index.js';
import { executionContext } from '../core/context.js';
import { resolveUpload } from '../storage/uploads.js';
import { mcpService } from './mcp.js';
import { listAvailableModelsFromApi, resolveThinkingConfig as resolveCatalogThinkingConfig } from './modelCatalog.js';

const pendingSteeringNotes = new Map();
const PARALLEL_TOOL_NAMES = new Set([
    'spawn_subagent',
    'search_web',
    'read_url_content',
]);
const MAX_INLINE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export function injectSteeringNote(chatId, text) {
    const existing = pendingSteeringNotes.get(chatId) || [];
    existing.push(text);
    pendingSteeringNotes.set(chatId, existing);
}

export function peekSteeringNotes(chatId) {
    return [...(pendingSteeringNotes.get(chatId) || [])];
}

export function consumeSteeringNotes(chatId) {
    const notes = peekSteeringNotes(chatId);
    pendingSteeringNotes.delete(chatId);
    return notes;
}

let cachedClient = null;

// ─── Thinking Level Compatibility ────────────────────────────────────────────
// Runtime auto-discovery cache: modelId → Set<unsupported level strings>.
// When a thinking level causes an API error, it's recorded here so subsequent
// calls automatically fall back without retrying the bad level.
const unsupportedLevelsCache = new Map();
const THINKING_FALLBACK_CHAIN = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', null];

function getEffectiveThinkingLevel(modelId, requestedLevel) {
    const unsupported = unsupportedLevelsCache.get(modelId);
    if (!unsupported?.has(requestedLevel)) return requestedLevel;
    const startIdx = THINKING_FALLBACK_CHAIN.indexOf(requestedLevel);
    for (let i = startIdx + 1; i < THINKING_FALLBACK_CHAIN.length; i++) {
        const candidate = THINKING_FALLBACK_CHAIN[i];
        if (candidate === null || !unsupported.has(candidate)) return candidate;
    }
    return null;
}

function persistUnsupportedLevel(modelId, level) {
    try {
        const current = reloadConfigJson() ?? {};
        const caps = current.modelCapabilities ?? {};
        const model = caps[modelId] ?? {};
        const existing = new Set(Array.isArray(model.unsupportedThinkingLevels) ? model.unsupportedThinkingLevels : []);
        existing.add(level);
        model.unsupportedThinkingLevels = [...existing];
        caps[modelId] = model;
        current.modelCapabilities = caps;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8');
    } catch (err) {
        console.warn('[gemini] Failed to persist unsupported thinking level:', err?.message);
    }
}

function autoFixAgentThinkingLevel(agentId, modelId, unsupportedLevel) {
    try {
        const agentConfig = getAgentConfig(agentId);
        if (agentConfig.model !== modelId) return;
        if (String(agentConfig.thinkingLevel ?? '').toUpperCase() !== unsupportedLevel) return;
        const effectiveLevel = getEffectiveThinkingLevel(modelId, unsupportedLevel);
        if (!effectiveLevel || effectiveLevel === unsupportedLevel) return;
        const settings = readSettings();
        if (!settings[agentId]) return;
        settings[agentId] = { ...settings[agentId], thinkingLevel: effectiveLevel };
        writeSettings(settings);
        console.log(`[gemini] Auto-updated ${agentId} thinkingLevel: ${unsupportedLevel} → ${effectiveLevel}`);
    } catch (err) {
        console.warn('[gemini] Failed to auto-fix agent thinking level:', err?.message);
    }
}

function recordUnsupportedLevel(modelId, level, { agentId } = {}) {
    if (!unsupportedLevelsCache.has(modelId)) {
        unsupportedLevelsCache.set(modelId, new Set());
    }
    unsupportedLevelsCache.get(modelId).add(level);
    persistUnsupportedLevel(modelId, level);
    if (agentId) autoFixAgentThinkingLevel(agentId, modelId, level);
}

export function getUnsupportedLevels(modelId) {
    const set = unsupportedLevelsCache.get(modelId);
    return set ? [...set] : [];
}

// Load persisted unsupported levels from disk on startup
(function loadPersistedUnsupportedLevels() {
    try {
        const config = reloadConfigJson();
        const caps = config?.modelCapabilities;
        if (!caps || typeof caps !== 'object') return;
        for (const [modelId, model] of Object.entries(caps)) {
            if (!Array.isArray(model.unsupportedThinkingLevels)) continue;
            for (const level of model.unsupportedThinkingLevels) {
                if (!unsupportedLevelsCache.has(modelId)) unsupportedLevelsCache.set(modelId, new Set());
                unsupportedLevelsCache.get(modelId).add(level);
            }
        }
    } catch {
        // ignore
    }
})();

function isThinkingLevelError(error) {
    const msg = String(error?.message ?? error ?? '').toLowerCase();
    return /thinking/i.test(msg) && /invalid|unsupported|not.+support|not.+available/i.test(msg);
}

// ─── Core helpers ────────────────────────────────────────────────────────────

function buildChatConfigForAgent({ agentId, agentConfig, sharedTools }) {
    const agentDefinition = getAgentDefinition(agentId);
    const modelId = agentConfig.model;

    const wrappedMapThinkingLevel = (level) => {
        const requested = String(level ?? '').trim().toUpperCase();
        const effective = THINKING_FALLBACK_CHAIN.includes(requested)
            ? getEffectiveThinkingLevel(modelId, requested)
            : requested;
        if (effective === null) return null;
        return resolveCatalogThinkingConfig(modelId, effective);
    };

    return agentDefinition.buildChatConfig({
        agentConfig,
        mapThinkingLevel: wrappedMapThinkingLevel,
        sharedTools,
    });
}

function mergeFunctionDeclarationTools(baseTools, extraDeclarations = []) {
    const declarations = Array.isArray(extraDeclarations)
        ? extraDeclarations.filter((item) => item && typeof item === 'object')
        : [];

    if (declarations.length === 0) {
        return baseTools;
    }

    const merged = Array.isArray(baseTools) ? [...baseTools] : [];
    merged.push({
        functionDeclarations: declarations,
    });
    return merged;
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
        if (typeof part.isExecuting === 'boolean') {
            normalized.isExecuting = part.isExecuting;
        }
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

/**
 * Extract inline data attachments (images, audio, etc.) from a normalized message parts array.
 * Returns an array of { mimeType, data } objects suitable for agent tool forwarding.
 */
function extractUserAttachments(messageParts) {
    if (!Array.isArray(messageParts)) return [];
    const attachments = [];
    for (const part of messageParts) {
        const inlineData = part?.inlineData;
        if (inlineData && typeof inlineData === 'object') {
            const mimeType = String(inlineData.mimeType ?? '').trim();
            const data = String(inlineData.data ?? '').trim();
            if (mimeType && data) {
                attachments.push({ mimeType, data });
            }
        }
    }
    return attachments;
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
            let traceResponse = item.response;

            // Special handling for view_file and similar tools to keep the trace compact and readable.
            // We truncate the main 'content' or 'text' fields more aggressively in the trace logs.
            if (traceResponse && typeof traceResponse === 'object') {
                if (typeof traceResponse.content === 'string') {
                    traceResponse = { ...traceResponse, content: truncateForToolTrace(traceResponse.content, 400) };
                } else if (typeof traceResponse.text === 'string' && item.name !== 'generate_image') {
                    traceResponse = { ...traceResponse, text: truncateForToolTrace(traceResponse.text, 400) };
                } else if (Array.isArray(traceResponse.items)) {
                    // For tools like view_code_item
                    traceResponse = {
                        ...traceResponse,
                        items: traceResponse.items.map((it) => (it && typeof it.content === 'string'
                            ? { ...it, content: truncateForToolTrace(it.content, 400) }
                            : it)),
                    };
                }
            }

            lines.push(`tool_${itemNo}_response=${truncateForToolTrace(safeJsonStringify(traceResponse), TOOL_TRACE_MAX_RESPONSE_CHARS)}`);
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

    const withoutTrace = raw
        .replace(/\[tool_trace][\s\S]*?\[\/tool_trace]/g, '')  // complete blocks
        .replace(/\[tool_trace][\s\S]*/g, '');                  // incomplete blocks (no closing tag)
    return withoutTrace
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function sanitizeVisibleText(value) {
    return stripToolTraceBlocks(value);
}

function base64ByteLength(value) {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
        return 0;
    }

    const padding = normalized.endsWith('==') ? 2 : (normalized.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function canInlineAttachmentForModel(mimeType) {
    const normalized = String(mimeType ?? '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    return (
        normalized.startsWith('image/')
        || normalized.startsWith('audio/')
        || normalized.startsWith('video/')
        || normalized === 'application/pdf'
        || normalized === 'text/plain'
        || normalized === 'text/csv'
        || normalized === 'application/json'
    );
}

function buildAttachmentHint({
    name,
    mimeType,
    sizeBytes,
    absolutePath,
    note = '',
} = {}) {
    const segments = [];
    const safeName = String(name ?? '').trim() || 'attachment';
    const safeMimeType = String(mimeType ?? '').trim() || 'application/octet-stream';

    segments.push(`- ${safeName} [${safeMimeType}]`);
    if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
        segments.push(`${Math.trunc(sizeBytes)} bytes`);
    }
    if (absolutePath) {
        segments.push(`tool_path=${absolutePath}`);
    }
    if (note) {
        segments.push(note);
    }

    return segments.join(' | ');
}

async function describeFileDataAttachment(fileData) {
    if (!fileData || typeof fileData !== 'object') {
        return null;
    }

    const uploadId = String(fileData.uploadId ?? '').trim();
    if (!uploadId) {
        const fileUri = String(fileData.fileUri ?? fileData.file_uri ?? '').trim();
        const mimeType = String(fileData.mimeType ?? fileData.mime_type ?? '').trim();
        const displayName = String(fileData.displayName ?? '').trim();
        const sizeBytes = Number(fileData.sizeBytes);
        return {
            name: displayName || 'attachment',
            mimeType,
            sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.trunc(sizeBytes) : 0,
            absolutePath: '',
            fileUri,
            inlineData: null,
        };
    }

    try {
        const { metadata, absolutePath } = await resolveUpload(uploadId);
        return {
            name: metadata.name,
            mimeType: metadata.mimeType,
            sizeBytes: metadata.sizeBytes,
            absolutePath,
            fileUri: String(fileData.fileUri ?? fileData.file_uri ?? '').trim(),
            inlineData: null,
            uploadId,
        };
    } catch {
        const mimeType = String(fileData.mimeType ?? fileData.mime_type ?? '').trim();
        const displayName = String(fileData.displayName ?? '').trim();
        const sizeBytes = Number(fileData.sizeBytes);
        return {
            name: displayName || 'attachment',
            mimeType,
            sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.trunc(sizeBytes) : 0,
            absolutePath: '',
            fileUri: String(fileData.fileUri ?? fileData.file_uri ?? '').trim(),
            inlineData: null,
            uploadId,
        };
    }
}

async function buildUserMessagePartsForModel(message, { hydrateInlineAttachments = false } = {}) {
    const rawParts = Array.isArray(message?.parts) ? message.parts : null;
    if (!rawParts || rawParts.length === 0) {
        return [{ text: String(message?.text ?? '') }];
    }

    const textSegments = [];
    const attachmentHints = [];
    const inlineParts = [];
    let remainingInlineBudget = MAX_INLINE_ATTACHMENT_BYTES;

    for (const rawPart of rawParts) {
        if (!rawPart || typeof rawPart !== 'object') {
            continue;
        }

        if (typeof rawPart.text === 'string' && rawPart.text.trim()) {
            textSegments.push(rawPart.text);
            continue;
        }

        const inlineData = rawPart.inlineData;
        if (inlineData && typeof inlineData === 'object') {
            const mimeType = String(inlineData.mimeType ?? inlineData.mime_type ?? '').trim();
            const data = String(inlineData.data ?? '').trim();
            const sizeBytes = base64ByteLength(data);
            const displayName = String(inlineData.displayName ?? inlineData.display_name ?? '').trim();
            attachmentHints.push(buildAttachmentHint({
                name: displayName || 'attachment',
                mimeType,
                sizeBytes,
                note: 'embedded_attachment',
            }));

            if (
                hydrateInlineAttachments
                && data
                && canInlineAttachmentForModel(mimeType)
                && sizeBytes > 0
                && sizeBytes <= remainingInlineBudget
            ) {
                inlineParts.push({
                    inlineData: {
                        mimeType,
                        data,
                    },
                });
                remainingInlineBudget -= sizeBytes;
            }
            continue;
        }

        const fileData = rawPart.fileData;
        if (fileData && typeof fileData === 'object') {
            const attachment = await describeFileDataAttachment(fileData);
            if (!attachment) {
                continue;
            }

            const exceedsInlineBudget = attachment.sizeBytes > remainingInlineBudget;
            let inlineNote = 'binary_omitted_from_history';
            if (hydrateInlineAttachments && !canInlineAttachmentForModel(attachment.mimeType)) {
                inlineNote = 'type_not_inlined';
            } else if (hydrateInlineAttachments && exceedsInlineBudget) {
                inlineNote = 'size_not_inlined';
            }

            attachmentHints.push(buildAttachmentHint({
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                absolutePath: attachment.absolutePath,
                note: inlineNote,
            }));

            if (
                hydrateInlineAttachments
                && attachment.absolutePath
                && canInlineAttachmentForModel(attachment.mimeType)
                && attachment.sizeBytes > 0
                && attachment.sizeBytes <= remainingInlineBudget
            ) {
                const fileBytes = await fs.promises.readFile(attachment.absolutePath);
                inlineParts.push({
                    inlineData: {
                        mimeType: attachment.mimeType,
                        data: fileBytes.toString('base64'),
                    },
                });
                remainingInlineBudget -= attachment.sizeBytes;
            }
        }
    }

    const combinedText = [
        textSegments.join('\n').trim(),
        attachmentHints.length > 0
            ? ['[attachments]', ...attachmentHints].join('\n')
            : '',
    ]
        .filter(Boolean)
        .join('\n\n');

    if (!combinedText && inlineParts.length > 0) {
        return inlineParts;
    }

    const textPart = { text: combinedText || String(message?.text ?? '') };
    return inlineParts.length > 0
        ? [...inlineParts, textPart]
        : [textPart];
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

async function normalizeHistory(messages) {
    const normalizedMessages = [];

    for (const message of messages) {
        if (!message || (message.role !== 'user' && message.role !== 'ai')) {
            continue;
        }

        if (message.role === 'ai') {
            const mediaParts = buildModelHistoryMediaParts(message);
            const baseTextPart = { text: buildModelHistoryText(message) };
            normalizedMessages.push({
                role: 'model',
                parts: mediaParts.length > 0
                    ? [baseTextPart, ...mediaParts]
                    : [baseTextPart],
            });
            continue;
        }

        normalizedMessages.push({
            role: 'user',
            parts: await buildUserMessagePartsForModel(message, {
                hydrateInlineAttachments: false,
            }),
        });
    }

    return normalizedMessages;
}

function getClient() {
    const freshKey = getGeminiApiKey();
    if (!freshKey) {
        throw new Error('Missing GEMINI_API_KEY or VITE_GEMINI_API_KEY in environment or config.json.');
    }

    if (!cachedClient || cachedClient._lastApiKey !== freshKey) {
        cachedClient = new GoogleGenAI({ apiKey: freshKey });
        cachedClient._lastApiKey = freshKey;
    }

    return cachedClient;
}

async function createChatSession(
    historyWithLatestUserTurn,
    { agentId = DEFAULT_AGENT_ID, toolAccessOverride } = {},
) {
    if (!Array.isArray(historyWithLatestUserTurn) || historyWithLatestUserTurn.length === 0) {
        throw new Error('Cannot generate reply without a user message.');
    }

    const latest = historyWithLatestUserTurn[historyWithLatestUserTurn.length - 1];
    if (!latest || latest.role !== 'user') {
        throw new Error('Latest turn must be from user.');
    }

    const previousTurns = historyWithLatestUserTurn
        .slice(0, -1)
        .slice(-getGeminiContextMessages());

    const normalizedAgentId = normalizeAgentId(agentId);

    // Read model + generation options dynamically from saved settings
    const agentConfig = getAgentConfig(normalizedAgentId);
    const toolAccess = Array.isArray(toolAccessOverride)
        ? toolAccessOverride
            .map((name) => String(name ?? '').trim())
            .filter(Boolean)
        : getAgentToolAccess(normalizedAgentId);
    const localTools = buildFunctionTools(toolAccess);
    const mcpCatalog = toolAccess.length > 0
        ? await mcpService.getActiveToolCatalog()
        : { declarations: [], bindings: new Map() };
    const sharedTools = mergeFunctionDeclarationTools(localTools, mcpCatalog.declarations);

    const history = await normalizeHistory(previousTurns);
    const latestMessage = await buildUserMessagePartsForModel(latest, {
        hydrateInlineAttachments: true,
    });

    const chat = getClient().chats.create({
        model: agentConfig.model,
        history,
        config: buildChatConfigForAgent({
            agentId: normalizedAgentId,
            agentConfig,
            sharedTools,
        }),
    });

    return {
        chat,
        latestMessage,
        model: agentConfig.model,
        agentConfig,
        allowedToolNames: new Set([
            ...toolAccess,
            ...mcpCatalog.bindings.keys(),
        ]),
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

function isParallelToolName(toolName) {
    return PARALLEL_TOOL_NAMES.has(String(toolName ?? '').trim());
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

    const durationMs = Number(step.thinkingDurationMs);
    if (Number.isFinite(durationMs) && durationMs > 0) {
        normalized.thinkingDurationMs = durationMs;
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

function normalizeToolUsageActivityLog(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((entry, index) => {
            if (!entry || typeof entry !== 'object') {
                const content = String(entry ?? '').trim();
                if (!content) {
                    return null;
                }

                return {
                    id: `browser-activity-${index + 1}`,
                    content,
                    isLive: false,
                };
            }

            const content = String(entry.content ?? entry.message ?? '').trim();
            if (!content) {
                return null;
            }

            const createdAt = Number(entry.createdAt);

            return {
                id: String(entry.id ?? '').trim() || `browser-activity-${index + 1}`,
                content,
                createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.trunc(createdAt) : undefined,
                isLive: entry.isLive === true || entry.isThinking === true,
            };
        })
        .filter(Boolean);
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
        activityLog: normalizeToolUsageActivityLog(rawRecord.activityLog),
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

    if (normalized.length > 0) {
        return normalized;
    }

    const resolvedToolName = String(toolName ?? '').trim();
    if (!resolvedToolName) {
        return [];
    }

    const toolCallId = typeof functionCall?.id === 'string' && functionCall.id.trim()
        ? functionCall.id.trim()
        : '';
    const sanitizedResult = sanitizeToolResultForModel(toolResult);
    const fallbackOutputText = typeof toolResult?.error === 'string' && toolResult.error.trim()
        ? `Tool error: ${toolResult.error.trim()}`
        : safeJsonStringify(sanitizedResult ?? {});

    return [{
        source: 'tool',
        toolName: resolvedToolName,
        toolCallId,
        status: normalizeToolUsageStatus(toolResult?.error ? 'error' : 'completed'),
        agentId: '',
        model: `tool:${resolvedToolName}`,
        inputText: truncateForToolUsage(`[tool:${resolvedToolName}] ${safeJsonStringify(args ?? {})}`),
        outputText: truncateForToolUsage(fallbackOutputText),
        activityLog: [],
        createdAt: Date.now(),
        usageMetadata: null,
    }];

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

export async function generateAssistantReply(
    historyWithLatestUserTurn,
    { agentId = DEFAULT_AGENT_ID, toolAccessOverride } = {},
) {
    const { chat, latestMessage, model, agentConfig } = await createChatSession(historyWithLatestUserTurn, {
        agentId,
        toolAccessOverride,
    });

    try {
        const response = await retryOnRateLimit(() => chat.sendMessage({
            message: latestMessage,
        }));
        return finalizeText(sanitizeVisibleText(response?.text));
    } catch (error) {
        const currentLevel = String(agentConfig?.thinkingLevel ?? '').trim().toUpperCase();
        if (currentLevel && isThinkingLevelError(error)) {
            recordUnsupportedLevel(model, currentLevel, { agentId });
            const retrySession = await createChatSession(historyWithLatestUserTurn, {
                agentId,
                toolAccessOverride,
            });
            const response = await retryOnRateLimit(() => retrySession.chat.sendMessage({
                message: retrySession.latestMessage,
            }));
            return finalizeText(sanitizeVisibleText(response?.text));
        }
        throw error;
    }
}

export async function generateAssistantReplyStream(
    historyWithLatestUserTurn,
    {
        onUpdate,
        shouldStop,
        agentId = DEFAULT_AGENT_ID,
        chatId = '',
        messageId = '',
        clientId = '',
        spawnDepth = 0,
        maxSubagentSpawnDepth,
        toolAccessOverride,
    } = {},
) {
    const {
        chat,
        latestMessage,
        model,
        agentConfig,
        allowedToolNames,
    } = await createChatSession(historyWithLatestUserTurn, {
        agentId,
        toolAccessOverride,
    });
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
    let currentStepStartMs = null;
    let stepEventSequence = 0;
    let currentStepFirstTextEvent = null;
    let currentStepFirstToolEvent = null;
    let apiCallCount = 0;
    let toolCallCount = 0;
    let stopReason = '';
    let didAppendToolLimitNotice = false;
    const syntheticToolCallIds = new Map();
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

    function ensureFunctionCallId(functionCall) {
        if (!functionCall || typeof functionCall !== 'object') {
            return functionCall;
        }

        const explicitId = typeof functionCall.id === 'string' ? functionCall.id.trim() : '';
        if (explicitId) {
            return functionCall;
        }

        const callKey = getFunctionCallKey(functionCall);
        let syntheticId = syntheticToolCallIds.get(callKey);
        if (!syntheticId) {
            syntheticId = `toolcall-${randomUUID().slice(0, 8)}`;
            syntheticToolCallIds.set(callKey, syntheticId);
        }

        return {
            ...functionCall,
            id: syntheticId,
        };
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
            if (currentStepStartMs !== null) {
                candidate.thinkingDurationMs = Math.max(0, Date.now() - currentStepStartMs);
            }
        } else {
            candidate.isWorked = true;
            if (currentStepStartMs !== null) {
                candidate.thinkingDurationMs = Math.max(0, Date.now() - currentStepStartMs);
            }
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
        currentStepStartMs = null;
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

    async function executeFunctionCall(functionCall) {
        const name = typeof functionCall?.name === 'string' && functionCall.name
            ? functionCall.name
            : 'unknown_tool';
        const args = functionCall?.args && typeof functionCall.args === 'object'
            ? functionCall.args
            : {};
        const currentExecutionContext = executionContext.getStore() || null;

        const toolFn = toolRegistry[name];
        let result;
        if (!allowedToolNames.has(name)) {
            result = { error: `Tool ${name} is not allowed for this agent.` };
        } else if (toolFn) {
            try {
                result = await executionContext.run({
                    chatId,
                    messageId,
                    clientId,
                    agentId,
                    toolCallId: (typeof functionCall?.id === 'string' ? functionCall.id : ''),
                    toolName: name,
                    shouldStop: isStopRequested,
                    userAttachments: extractUserAttachments(latestMessage),
                    chatHistory: historyWithLatestUserTurn,
                    spawnDepth,
                    maxSubagentSpawnDepth,
                    subagentId: String(currentExecutionContext?.subagentId ?? '').trim() || undefined,
                    parentAgentId: String(currentExecutionContext?.parentAgentId ?? '').trim() || undefined,
                }, () => toolFn(args));
            } catch (error) {
                result = { error: `Tool ${name} failed: ${error.message}` };
            }
        } else {
            result = await mcpService.callToolByAlias(name, args);
        }

        const toolUsageRecords = extractToolUsageRecords(result, {
            toolName: name,
            functionCall,
            args,
        });
        const toolMediaParts = extractToolMediaParts(result);
        const modelVisibleResult = sanitizeToolResultForModel(result);

        const functionResponse = {
            name,
            response: modelVisibleResult,
        };
        if (typeof functionCall?.id === 'string' && functionCall.id.trim().length > 0) {
            functionResponse.id = functionCall.id;
        }

        return {
            functionResponse,
            toolUsageRecords,
            toolMediaParts,
        };
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
                        const normalizedFunctionCall = ensureFunctionCallId(part.functionCall);
                        const callKey = getFunctionCallKey(normalizedFunctionCall);
                        if (!functionCallsByKey.has(callKey)) {
                            functionCallsByKey.set(callKey, normalizedFunctionCall);
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
                    const normalizedFunctionCall = ensureFunctionCallId(functionCall);
                    const callKey = getFunctionCallKey(normalizedFunctionCall);
                    if (!functionCallsByKey.has(callKey)) {
                        functionCallsByKey.set(callKey, normalizedFunctionCall);
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
            stopReason: 'user_stop',
            model,
            apiCallCount: 0,
            toolCallCount: 0,
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
    currentStepStartMs = Date.now();
    await emitUpdate({ force: true, stepIsThinking: true });

    const rateLimitOnWaiting = async (ms) => {
        await emitUpdate({ force: true, thoughtOverride: `⏳ Rate limit reached. Retrying in ${Math.round(ms / 1000)}s...` });
    };

    let activeChat = chat;
    let initialStreamResult;
    try {
        const initialStream = await retryOnRateLimit(
            () => activeChat.sendMessageStream({ message: latestMessage }),
            { onWaiting: rateLimitOnWaiting },
        );
        initialStreamResult = await processStream(initialStream);
    } catch (error) {
        // If the error is a thinking-level incompatibility, auto-fallback and retry once.
        const currentLevel = String(agentConfig?.thinkingLevel ?? '').trim().toUpperCase();
        if (currentLevel && isThinkingLevelError(error)) {
            recordUnsupportedLevel(model, currentLevel, { agentId });
            // Recreate the chat session — buildChatConfigForAgent now uses the cache.
            const retrySession = await createChatSession(historyWithLatestUserTurn, {
                agentId,
                toolAccessOverride,
            });
            activeChat = retrySession.chat;
            const retryStream = await retryOnRateLimit(
                () => activeChat.sendMessageStream({ message: retrySession.latestMessage }),
                { onWaiting: rateLimitOnWaiting },
            );
            initialStreamResult = await processStream(retryStream);
        } else {
            throw error;
        }
    }

    accumulateUsage(initialStreamResult.usageMetadata);
    let pendingFunctionCalls = initialStreamResult.functionCalls;
    const isSubagentExecution = Number(spawnDepth ?? 0) > 0;

    // Handle tool calls if any (potentially multiple rounds)
    while (pendingFunctionCalls.length > 0 && !stopped) {
        if (isSubagentExecution && toolCallCount >= MAX_SUBAGENT_TOOL_CALLS) {
            stopReason = 'subagent_tool_call_limit';
            stopped = true;
            if (!didAppendToolLimitNotice) {
                fullText = mergeChunkIntoText(
                    fullText,
                    `\n\nStopped after reaching the subagent tool-call limit (${MAX_SUBAGENT_TOOL_CALLS}).`,
                );
                didAppendToolLimitNotice = true;
            }
            break;
        }

        const orderedFunctionResponses = new Array(pendingFunctionCalls.length);
        const parallelExecutions = [];
        let toolCallLimitReachedThisRound = false;

        for (let index = 0; index < pendingFunctionCalls.length; index += 1) {
            const functionCall = pendingFunctionCalls[index];
            if (isStopRequested()) {
                stopped = true;
                break;
            }

            const name = typeof functionCall?.name === 'string' && functionCall.name
                ? functionCall.name
                : 'unknown_tool';

            if (isSubagentExecution && toolCallCount >= MAX_SUBAGENT_TOOL_CALLS) {
                toolCallLimitReachedThisRound = true;
                const limitResponse = {
                    name,
                    response: {
                        error: `Subagent tool-call limit reached (${MAX_SUBAGENT_TOOL_CALLS}). Stop using tools and answer with the findings already gathered.`,
                    },
                };
                if (typeof functionCall?.id === 'string' && functionCall.id.trim().length > 0) {
                    limitResponse.id = functionCall.id;
                }
                toolPartsAccumulator.push({ functionCall });
                toolPartsAccumulator.push({ functionResponse: limitResponse });
                orderedFunctionResponses[index] = { functionResponse: limitResponse };
                continue;
            }

            toolCallCount += 1;

            const toolCallPartState = {
                functionCall,
                isExecuting: true,
            };
            markCurrentStepToolEvent();
            toolPartsAccumulator.push(toolCallPartState);

            await emitUpdate({ stepIsThinking: false });

            const finalizeExecution = async ({ functionResponse, toolUsageRecords, toolMediaParts }) => {
                for (const usageRecord of toolUsageRecords) {
                    toolUsageRecordsAccumulator.push(usageRecord);
                }

                for (const toolMediaPart of toolMediaParts) {
                    collectInlineMediaPart(toolMediaPart);
                }

                toolCallPartState.isExecuting = false;
                toolPartsAccumulator.push({ functionResponse });
                orderedFunctionResponses[index] = { functionResponse };
                await emitUpdate({ stepIsThinking: false });
            };

            if (isParallelToolName(name)) {
                parallelExecutions.push(
                    executeFunctionCall(functionCall).then(finalizeExecution),
                );
                continue;
            }

            const completedExecution = await executeFunctionCall(functionCall);
            await finalizeExecution(completedExecution);
        }

        if (parallelExecutions.length > 0) {
            await Promise.all(parallelExecutions);
        }

        if (stopped) {
            break;
        }

        const functionResponses = orderedFunctionResponses.filter(Boolean);
        if (functionResponses.length === 0) {
            break;
        }

        const notes = consumeSteeringNotes(chatId);
        if (notes.length > 0) {
            for (const note of notes) {
                functionResponses.push({ text: `[System Injection/User Steering Note received during execution]: ${note}` });
            }
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
        currentStepStartMs = Date.now();
        await emitUpdate({ force: true, stepIsThinking: true });
        const nextStream = await retryOnRateLimit(
            () => chat.sendMessageStream({ message: functionResponses }),
            { onWaiting: rateLimitOnWaiting },
        );
        const nextStreamResult = await processStream(nextStream);
        accumulateUsage(nextStreamResult.usageMetadata);
        pendingFunctionCalls = nextStreamResult.functionCalls;

        if (toolCallLimitReachedThisRound && pendingFunctionCalls.length > 0) {
            stopReason = 'subagent_tool_call_limit';
            stopped = true;
            if (!didAppendToolLimitNotice) {
                fullText = mergeChunkIntoText(
                    fullText,
                    `\n\nStopped after reaching the subagent tool-call limit (${MAX_SUBAGENT_TOOL_CALLS}).`,
                );
                didAppendToolLimitNotice = true;
            }
        }
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
        stopReason,
        model,
        apiCallCount,
        toolCallCount,
        toolUsageRecords: toolUsageRecordsAccumulator,
        usageMetadata: usageAccumulator,
    };
}

export async function listAvailableModels() {
    return listAvailableModelsFromApi();
}

export async function generateChatTitle({ text, attachments, aiText }) {
    const prompt = [];
    if (attachments && attachments.length > 0) {
        prompt.push('User uploaded some attachments/images.');
    }
    if (text) {
        prompt.push(`User input: "${text}"`);
    }
    if (aiText) {
        const truncated = String(aiText).slice(0, 1000);
        prompt.push(`AI Response (preview): "${truncated}"`);
    }

    prompt.push('Task: Generate a short, conversational and concise title (1-5 words max) for this chat conversation based on the context above. Only output the title. Do not include quotes, markdown bolding, or any explanations.');

    try {
        const client = getClient();
        const model = 'gemini-3.1-flash-lite-preview';
        const doc = prompt.join('\n\n');
        const result = await retryOnRateLimit(() => client.models.generateContent({
            model,
            contents: doc,
            config: { thinkingConfig: { thinkingLevel: 'minimal' } }
        }));

        const generatedTitle = result.text?.trim();
        return generatedTitle || null;
    } catch (error) {
        console.warn('Failed to generate chat title:', error?.message ?? error);
        return null; // Fallback
    }
}
