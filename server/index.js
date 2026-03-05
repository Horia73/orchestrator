import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { API_PORT, CRON_CONFIG, getGeminiContextMessages } from './core/config.js';
import { listClientAgentDefinitions, DEFAULT_AGENT_ID } from './agents/index.js';
import { CODING_AGENT_ID } from './agents/coding/index.js';
import { IMAGE_AGENT_ID } from './agents/image/index.js';
import {
    generateAssistantReplyStream,
    generateChatTitleWithMetadata,
    injectSteeringNote,
    peekSteeringNotes,
    consumeSteeringNotes,
} from './services/geminiService.js';
import { openEventsStream, broadcastEvent, updateStreamingSnapshot, getStreamingSnapshot, clearStreamingSnapshot } from './core/events.js';
import { getCommandStatusSnapshot } from './tools/index.js';
import { estimateUsageCost } from './pricing/usage.js';
import { appendSystemLog, clearLogs, getLogsSnapshot, initLogStorage } from './storage/logs.js';
import { appendUsageRecord, clearUsageRecords, getUsageSnapshotByRange, initUsageStorage } from './storage/usage.js';
import { listEditableFileSections, readEditableFile, writeEditableFile } from './storage/editableFiles.js';
import {
    createUploadFromRequestStream,
    deleteUpload,
    getUploadResponseHeaders,
    initUploadStorage,
    markUploadsCommitted,
    resolveUpload,
} from './storage/uploads.js';
import {
    initStorage,
    listChats,
    getChat,
    createChatFromFirstMessage,
    appendMessage,
    ensureInboxChat,
    getChatMessages,
    getRecentMessages,
    removeChat,
    clearChatMessages,
    updateChatTitle,
    INBOX_CHAT_KIND,
} from './storage/chats.js';
import { getAgentConfig, normalizeAgentId, readSettings, writeSettings, readUiSettings, writeUiSettings } from './storage/settings.js';
import { decodeUploadHeaderValue } from './storage/http/uploadHeaders.js';
import { memoryStore } from './services/memory.js';
import { skillsLoader, parseRequires, checkRequirements } from './services/skills.js';
import { mcpService, writeMcpServers } from './services/mcp.js';
import { createChatGenerationState } from './services/chat/generationState.js';
import {
    buildUsageInputText,
    buildUserMessageParts,
    createMessageId,
    formatGeminiError,
    getFirstMessageSeed,
    normalizeClientId,
    normalizeIncomingAttachments,
    normalizeMessageText,
    normalizeReplyToPayload,
    resolveRuntimeAgentForMessage,
} from './services/chat/input.js';
import { buildBrowserResumeFollowUpNote, buildDeferredSteeringPrompt } from './services/chat/steeringPrompts.js';
import {
    formatCommandError,
    getGitUpdateSnapshot,
    readLocalPackageVersion,
    runCommand,
    runGit,
} from './services/system/updateManager.js';
import { renderMissingFrontendHtml } from './core/frontend/fallbackHtml.js';
import { watchModelsConfig } from './core/watchers/modelsWatcher.js';
import { cronService } from './services/cron.js';
import { MODELS_CONFIG_PATH, ORCHESTRATOR_HOME } from './core/dataPaths.js';
import { ensureModelCatalogExists } from './core/modelCatalogSeed.js';
import { getModelsForClient } from './services/modelCatalog.js';
import {
    continueBrowserAgentSession,
    getBrowserAgentRecordingForChat,
    getBrowserAgentRecordingVideoForChat,
    handleBrowserAgentRemoteDesktopUpgrade,
    inspectBrowserAgentSessionForChat,
    performBrowserAgentLiveAction,
    streamBrowserAgentLiveView,
} from './services/browserAgent.js';
import { isBootOnboardingActive, readBootPromptInstruction } from './services/bootOnboarding.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const DIST_INDEX_PATH = path.join(DIST_DIR, 'index.html');
const frontendAssets = express.static(DIST_DIR, {
    index: false,
    extensions: false,
});

ensureModelCatalogExists();

app.disable('x-powered-by');

const {
    enqueueChatWork,
    registerActiveGeneration,
    unregisterActiveGeneration,
    countActiveGenerationsForClient,
    requestStopForClient,
    requestStopForChat,
} = createChatGenerationState();
const steeringFollowUpsInFlight = new Set();

watchModelsConfig({
    watchDir: ORCHESTRATOR_HOME,
    modelsConfigPath: MODELS_CONFIG_PATH,
    onModelsUpdated: (payload) => {
        broadcastEvent('models.updated', payload);
    },
});

app.post('/api/uploads', async (req, res, next) => {
    try {
        const uploadName = decodeUploadHeaderValue(req.header('x-upload-name')) || 'attachment';
        const uploadMimeType = decodeUploadHeaderValue(req.header('x-upload-mime-type'))
            || req.header('content-type')
            || 'application/octet-stream';

        const upload = await createUploadFromRequestStream({
            request: req,
            name: uploadName,
            mimeType: uploadMimeType,
        });

        res.json({ upload: upload.public });
    } catch (error) {
        if (error?.code === 'UPLOAD_TOO_LARGE' || error?.code === 'UPLOAD_EMPTY') {
            res.status(400).json({ error: error.message });
            return;
        }
        next(error);
    }
});

app.delete('/api/uploads/:uploadId', async (req, res, next) => {
    try {
        const removed = await deleteUpload(req.params?.uploadId, { allowCommitted: false });
        if (!removed) {
            res.status(404).json({ error: 'Upload not found.' });
            return;
        }

        res.json({ ok: true });
    } catch (error) {
        if (error?.code === 'UPLOAD_ALREADY_COMMITTED') {
            res.status(409).json({ error: error.message });
            return;
        }
        if (error?.code === 'UPLOAD_INVALID_ID') {
            res.status(400).json({ error: error.message });
            return;
        }
        next(error);
    }
});

app.get('/api/uploads/:uploadId/content', async (req, res, next) => {
    try {
        const { metadata, absolutePath } = await resolveUpload(req.params?.uploadId);
        const stats = await fs.promises.stat(absolutePath);
        const headers = getUploadResponseHeaders(metadata);
        const range = String(req.headers.range ?? '').trim();

        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
            if (!match) {
                res.status(416).set('Content-Range', `bytes */${stats.size}`).end();
                return;
            }

            const start = match[1] ? Number(match[1]) : 0;
            const end = match[2] ? Number(match[2]) : (stats.size - 1);
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= stats.size) {
                res.status(416).set('Content-Range', `bytes */${stats.size}`).end();
                return;
            }

            res.writeHead(206, {
                ...headers,
                'Content-Length': end - start + 1,
                'Content-Range': `bytes ${start}-${end}/${stats.size}`,
            });
            fs.createReadStream(absolutePath, { start, end }).pipe(res);
            return;
        }

        res.writeHead(200, {
            ...headers,
            'Content-Length': stats.size,
        });
        fs.createReadStream(absolutePath).pipe(res);
    } catch (error) {
        if (error?.code === 'UPLOAD_NOT_FOUND') {
            res.status(404).json({ error: error.message });
            return;
        }
        if (error?.code === 'UPLOAD_INVALID_ID') {
            res.status(400).json({ error: error.message });
            return;
        }
        next(error);
    }
});

app.use(express.json({ limit: '10mb' }));

async function writeSystemLog({ level = 'info', source = 'system', eventType, message, data, agentId } = {}) {
    const log = await appendSystemLog({
        level,
        source,
        eventType,
        message,
        data,
        agentId,
    });

    broadcastEvent('system.log', { log });
    return log;
}

function normalizeUsageStatus(value, fallback = 'completed') {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'error') {
        return 'error';
    }

    if (normalized === 'stopped') {
        return 'stopped';
    }

    if (normalized === 'completed') {
        return 'completed';
    }

    return fallback;
}

function normalizeUsageSource(value, fallback = 'chat') {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized || fallback;
}

function normalizeUsageCreatedAt(value, fallback = Date.now()) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return Math.trunc(fallback);
    }

    return Math.trunc(parsed);
}

function normalizeUsageText(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    if (normalized) {
        return normalized;
    }

    return String(fallback ?? '').trim();
}

function normalizeUsageThinkingLevel(value) {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
        return '';
    }

    return normalized.toLowerCase();
}

async function trackUsageRequest({
    chatId,
    clientId,
    originClientId,
    model,
    thinkingLevel = '',
    status = 'completed',
    agentId,
    inputText = '',
    outputText = '',
    createdAt,
    usageMetadata = null,
    source = 'chat',
    parentRequestId,
    toolName,
    toolCallId,
    activityLog,
} = {}) {
    const normalizedStatus = normalizeUsageStatus(status);
    const normalizedSource = normalizeUsageSource(source);
    const normalizedCreatedAt = normalizeUsageCreatedAt(createdAt);
    const normalizedThinkingLevel = normalizeUsageThinkingLevel(thinkingLevel);
    const usageEstimate = estimateUsageCost({
        model,
        usageMetadata,
    });

    const usagePayload = {
        chatId,
        clientId,
        model: usageEstimate.modelId,
        status: normalizedStatus,
        agentId,
        inputText,
        outputText,
        createdAt: normalizedCreatedAt,
        inputTokens: usageEstimate.inputTokens,
        outputTokens: usageEstimate.outputTokens,
        outputImageTokens: usageEstimate.outputImageTokens,
        outputImageCount: usageEstimate.outputImageCount,
        thoughtsTokens: usageEstimate.thoughtsTokens,
        toolUsePromptTokens: usageEstimate.toolUsePromptTokens,
        totalTokens: usageEstimate.totalTokens,
        priced: usageEstimate.priced,
        inputCostUsd: usageEstimate.inputCostUsd,
        outputCostUsd: usageEstimate.outputCostUsd,
        totalCostUsd: usageEstimate.totalCostUsd,
        usageMetadata,
        source: normalizedSource,
        activityLog,
    };

    if (normalizedThinkingLevel) {
        usagePayload.thinkingLevel = normalizedThinkingLevel;
    }

    const normalizedParentRequestId = String(parentRequestId ?? '').trim();
    if (normalizedParentRequestId) {
        usagePayload.parentRequestId = normalizedParentRequestId;
    }

    const normalizedToolName = String(toolName ?? '').trim();
    if (normalizedToolName) {
        usagePayload.toolName = normalizedToolName;
    }

    const normalizedToolCallId = String(toolCallId ?? '').trim();
    if (normalizedToolCallId) {
        usagePayload.toolCallId = normalizedToolCallId;
    }

    const usageRecord = await appendUsageRecord(usagePayload);

    broadcastEvent('usage.logged', {
        request: usageRecord,
        originClientId,
    });

    const isToolUsage = normalizedSource === 'tool';
    const logLevel = normalizedStatus === 'error'
        ? 'error'
        : (normalizedStatus === 'stopped' ? 'warn' : 'info');
    const thinkingSuffix = normalizedThinkingLevel
        ? ` (thinking=${normalizedThinkingLevel})`
        : '';
    const logMessage = isToolUsage
        ? `Tracked tool request (${normalizedStatus}) for ${usageRecord.model}${thinkingSuffix}.`
        : `Tracked request (${normalizedStatus}) for ${usageRecord.model}${thinkingSuffix}.`;

    void writeSystemLog({
        level: logLevel,
        source: 'usage',
        eventType: isToolUsage ? 'usage.tool_request_logged' : 'usage.request_logged',
        message: logMessage,
        data: {
            requestId: usageRecord.id,
            chatId,
            parentRequestId: normalizedParentRequestId || undefined,
            toolName: normalizedToolName || undefined,
            toolCallId: normalizedToolCallId || undefined,
            source: normalizedSource,
            agentId: usageRecord.agentId,
            model: usageRecord.model,
            thinkingLevel: usageRecord.thinkingLevel || undefined,
            status: normalizedStatus,
            inputTokens: usageRecord.inputTokens,
            outputTokens: usageRecord.outputTokens,
            costUsd: usageRecord.totalCostUsd,
        },
    }).catch(() => undefined);

    return usageRecord;
}

async function trackToolUsageRecords({
    chatId,
    clientId,
    originClientId,
    toolUsageRecords,
    fallbackAgentId,
    parentRequestId,
    fallbackCreatedAt,
} = {}) {
    for (const toolUsage of toolUsageRecords) {
        if (!toolUsage || typeof toolUsage !== 'object') {
            continue;
        }

        const toolUsageMetadata = toolUsage.usageMetadata && typeof toolUsage.usageMetadata === 'object'
            ? toolUsage.usageMetadata
            : null;
        const toolModel = String(toolUsage.model ?? '').trim();
        if (!toolModel && !toolUsageMetadata) {
            continue;
        }
        if (toolModel.toLowerCase().startsWith('tool:')) {
            continue;
        }

        const toolName = String(toolUsage.toolName ?? '').trim();
        await trackUsageRequest({
            chatId,
            clientId,
            status: normalizeUsageStatus(toolUsage.status),
            agentId: String(toolUsage.agentId ?? '').trim() || fallbackAgentId,
            model: toolModel,
            inputText: normalizeUsageText(
                toolUsage.inputText,
                toolName ? `[tool:${toolName}]` : '[tool]',
            ),
            outputText: normalizeUsageText(toolUsage.outputText),
            createdAt: normalizeUsageCreatedAt(toolUsage.createdAt, fallbackCreatedAt),
            usageMetadata: toolUsageMetadata,
            thinkingLevel: normalizeUsageThinkingLevel(toolUsage.thinkingLevel),
            originClientId,
            source: normalizeUsageSource(toolUsage.source, 'tool'),
            parentRequestId,
            toolName,
            toolCallId: String(toolUsage.toolCallId ?? '').trim(),
            activityLog: Array.isArray(toolUsage.activityLog) ? toolUsage.activityLog : undefined,
        });
    }
}

async function generateAndApplyChatTitle({
    chatId,
    clientId,
    originClientId = clientId,
    usageAgentId = DEFAULT_AGENT_ID,
    text = '',
    attachments = [],
    aiText = '',
} = {}) {
    const startedAt = Date.now();
    const titleSourceText = buildUsageInputText({ text, attachments });

    let titleResult;
    try {
        titleResult = await generateChatTitleWithMetadata({ text, attachments, aiText });
    } catch (error) {
        const message = formatGeminiError(error);
        await writeSystemLog({
            level: 'error',
            source: 'chat',
            eventType: 'chat.title_generation_failed',
            message,
            agentId: usageAgentId,
            data: {
                chatId,
                clientId,
            },
        }).catch(() => undefined);
        return null;
    }

    const generatedTitle = String(titleResult?.title ?? '').trim();
    const model = String(titleResult?.model ?? '').trim() || 'gemini-3.1-flash-lite-preview';
    const usageMetadata = titleResult?.usageMetadata ?? null;
    const thinkingLevel = normalizeUsageThinkingLevel(titleResult?.thinkingLevel);
    const generationError = titleResult?.error;

    await trackUsageRequest({
        chatId,
        clientId,
        originClientId,
        status: generationError ? 'error' : 'completed',
        agentId: usageAgentId,
        model,
        inputText: titleSourceText || '[title-generation]',
        outputText: generatedTitle,
        createdAt: startedAt,
        usageMetadata,
        thinkingLevel,
        source: 'title',
    }).catch(() => undefined);

    if (generationError) {
        await writeSystemLog({
            level: 'error',
            source: 'chat',
            eventType: 'chat.title_generation_failed',
            message: formatGeminiError(generationError),
            agentId: usageAgentId,
            data: {
                chatId,
                clientId,
                model,
            },
        }).catch(() => undefined);
        return null;
    }

    if (!generatedTitle) {
        await writeSystemLog({
            level: 'warn',
            source: 'chat',
            eventType: 'chat.title_generation_empty',
            message: 'Chat title generation returned an empty title.',
            agentId: usageAgentId,
            data: {
                chatId,
                clientId,
                model,
            },
        }).catch(() => undefined);
        return null;
    }

    const updatedChat = await updateChatTitle(chatId, generatedTitle);
    if (!updatedChat) {
        return null;
    }

    broadcastEvent('chat.upsert', {
        chat: updatedChat,
        originClientId,
    });

    await writeSystemLog({
        source: 'chat',
        eventType: 'chat.title_generated',
        message: 'Chat title generated successfully.',
        agentId: usageAgentId,
        data: {
            chatId,
            clientId,
            model,
            title: generatedTitle,
        },
    }).catch(() => undefined);

    return updatedChat;
}

async function generateStreamingAssistantTurn({
    chat,
    clientId,
    originClientId = clientId,
    runtimeAgentId,
    usageAgentId,
    usageInputText,
    historyWithLatestUserTurn,
    systemInstructionOverride = '',
} = {}) {
    const aiMessageId = createMessageId();
    const aiMessageCreatedAt = Date.now();
    let streamedAssistantText = '';
    let streamedAssistantThought = '';
    let streamedAssistantParts = [];
    let streamedAssistantSteps = [];
    let assistantText = '';
    let usageMetadata = null;
    let modelForUsage = getAgentConfig(runtimeAgentId).model;
    let thinkingLevelForUsage = normalizeUsageThinkingLevel(getAgentConfig(runtimeAgentId).thinkingLevel);
    let requestStatus = 'completed';
    let toolUsageRecords = [];

    const initialStreamingMessage = {
        id: aiMessageId,
        chatId: chat.id,
        role: 'ai',
        text: '',
        thought: '',
        parts: [],
        steps: [],
        createdAt: aiMessageCreatedAt,
        thinkingStartedAt: aiMessageCreatedAt,
    };
    updateStreamingSnapshot(chat.id, {
        message: initialStreamingMessage,
    });

    broadcastEvent('message.streaming', {
        chatId: chat.id,
        streamState: 'streaming',
        message: initialStreamingMessage,
        originClientId,
    });

    const activeGeneration = registerActiveGeneration(clientId, chat.id);
    try {
        const streamResult = await generateAssistantReplyStream(historyWithLatestUserTurn, {
            chatId: chat.id,
            messageId: aiMessageId,
            clientId,
            onUpdate: async ({ text, thought, parts, steps }) => {
                streamedAssistantText = text;
                streamedAssistantThought = thought;
                streamedAssistantParts = Array.isArray(parts) ? parts : streamedAssistantParts;
                streamedAssistantSteps = Array.isArray(steps) ? steps : streamedAssistantSteps;
                const messageSnapshot = {
                    id: aiMessageId,
                    chatId: chat.id,
                    role: 'ai',
                    text,
                    thought,
                    parts: streamedAssistantParts,
                    steps: streamedAssistantSteps,
                    createdAt: aiMessageCreatedAt,
                    thinkingStartedAt: aiMessageCreatedAt,
                };
                updateStreamingSnapshot(chat.id, { message: messageSnapshot });
                broadcastEvent('message.streaming', {
                    chatId: chat.id,
                    streamState: 'streaming',
                    message: messageSnapshot,
                    originClientId,
                });
            },
            shouldStop: () => activeGeneration.stopRequested,
            agentId: runtimeAgentId,
            systemInstructionOverride,
        });

        usageMetadata = streamResult.usageMetadata ?? null;
        modelForUsage = String(streamResult.model ?? modelForUsage).trim() || modelForUsage;
        thinkingLevelForUsage = normalizeUsageThinkingLevel(streamResult.thinkingLevel ?? thinkingLevelForUsage);
        toolUsageRecords = Array.isArray(streamResult.toolUsageRecords)
            ? streamResult.toolUsageRecords
            : [];
        assistantText = String(streamResult.text ?? '').trim();
        if (streamResult.stopped) {
            requestStatus = 'stopped';
            if (!assistantText) {
                assistantText = 'Stopped.';
            } else if (!assistantText.endsWith('Stopped.')) {
                assistantText = `${assistantText}\n\nStopped.`;
            }
        } else if (!assistantText) {
            assistantText = 'No text response was returned by Gemini.';
        }
        streamedAssistantThought = streamResult.thought;
        streamedAssistantParts = Array.isArray(streamResult.parts)
            ? streamResult.parts
            : streamedAssistantParts;
        streamedAssistantSteps = Array.isArray(streamResult.steps)
            ? streamResult.steps
            : streamedAssistantSteps;

        broadcastEvent('message.streaming', {
            chatId: chat.id,
            streamState: 'complete',
            message: {
                id: aiMessageId,
                chatId: chat.id,
                role: 'ai',
                text: assistantText,
                thought: streamedAssistantThought,
                parts: streamedAssistantParts,
                steps: streamedAssistantSteps,
                createdAt: aiMessageCreatedAt,
            },
            originClientId,
        });
    } catch (error) {
        requestStatus = 'error';
        const formattedError = formatGeminiError(error);
        assistantText = streamedAssistantText
            ? `${streamedAssistantText}\n\n${formattedError}`
            : formattedError;
        void writeSystemLog({
            level: 'error',
            source: 'gemini',
            eventType: 'generation.failed',
            message: formattedError,
            agentId: runtimeAgentId,
            data: {
                chatId: chat.id,
                clientId,
                agentId: runtimeAgentId,
            },
        }).catch(() => undefined);

        broadcastEvent('message.streaming', {
            chatId: chat.id,
            streamState: 'complete',
            message: {
                id: aiMessageId,
                chatId: chat.id,
                role: 'ai',
                text: assistantText,
                thought: streamedAssistantThought,
                parts: streamedAssistantParts,
                steps: streamedAssistantSteps,
                createdAt: aiMessageCreatedAt,
            },
            originClientId,
        });
    } finally {
        unregisterActiveGeneration(activeGeneration);
        clearStreamingSnapshot(chat.id);
    }

    const shouldPersistAiMessage = Boolean(
        assistantText
        || String(streamedAssistantThought ?? '').trim()
        || (Array.isArray(streamedAssistantParts) && streamedAssistantParts.length > 0)
        || (Array.isArray(streamedAssistantSteps) && streamedAssistantSteps.length > 0),
    );
    let finalChat = chat;
    let appendedAiMessage = null;

    if (shouldPersistAiMessage) {
        const appendedAi = await appendMessage(chat.id, {
            id: aiMessageId,
            role: 'ai',
            text: assistantText,
            thought: streamedAssistantThought,
            parts: streamedAssistantParts,
            steps: streamedAssistantSteps,
            createdAt: aiMessageCreatedAt,
        });

        appendedAiMessage = appendedAi.message;
        finalChat = appendedAi.chat;

        broadcastEvent('message.added', {
            chatId: chat.id,
            message: appendedAi.message,
            originClientId,
        });

        broadcastEvent('chat.upsert', {
            chat: appendedAi.chat,
            originClientId,
        });
    }

    const usageRecord = await trackUsageRequest({
        chatId: chat.id,
        clientId,
        status: requestStatus,
        agentId: usageAgentId,
        model: modelForUsage,
        inputText: usageInputText,
        outputText: assistantText,
        createdAt: aiMessageCreatedAt,
        usageMetadata,
        thinkingLevel: thinkingLevelForUsage,
        originClientId,
        source: 'chat',
    });

    await trackToolUsageRecords({
        chatId: chat.id,
        clientId,
        originClientId,
        toolUsageRecords,
        fallbackAgentId: usageAgentId,
        parentRequestId: usageRecord.id,
        fallbackCreatedAt: aiMessageCreatedAt,
    });

    return {
        chat: finalChat,
        aiMessage: appendedAiMessage,
        assistantText,
    };
}

function scheduleDeferredSteeringFollowUp({ chatId, clientId, originClientId = clientId } = {}) {
    const normalizedChatId = String(chatId ?? '').trim();
    if (!normalizedChatId || steeringFollowUpsInFlight.has(normalizedChatId)) {
        return;
    }

    if (peekSteeringNotes(normalizedChatId).length === 0) {
        return;
    }

    steeringFollowUpsInFlight.add(normalizedChatId);
    void enqueueChatWork(normalizedChatId, async () => {
        try {
            const notes = consumeSteeringNotes(normalizedChatId);
            if (notes.length === 0) {
                return;
            }

            const chat = await getChat(normalizedChatId);
            if (!chat) {
                return;
            }

            const chatAgentId = normalizeAgentId(chat.agentId);
            const runtimeAgentId = resolveRuntimeAgentForMessage({
                chatAgentId,
                text: notes.join('\n'),
                attachments: [],
            }).agentId;
            const syntheticPrompt = buildDeferredSteeringPrompt(notes);
            if (!syntheticPrompt) {
                return;
            }
            const systemInstructionOverride = isBootOnboardingActive()
                ? readBootPromptInstruction()
                : '';

            const history = await getRecentMessages(normalizedChatId, getGeminiContextMessages());
            const historyWithLatestUserTurn = [
                ...history,
                {
                    id: createMessageId(),
                    role: 'user',
                    text: syntheticPrompt,
                    createdAt: Date.now(),
                },
            ];

            await generateStreamingAssistantTurn({
                chat,
                clientId,
                originClientId,
                runtimeAgentId,
                usageAgentId: chatAgentId,
                usageInputText: syntheticPrompt,
                historyWithLatestUserTurn,
                systemInstructionOverride,
            });
        } catch (error) {
            const message = formatGeminiError(error);
            void writeSystemLog({
                level: 'error',
                source: 'chat',
                eventType: 'chat.steering_follow_up_failed',
                message,
                data: {
                    chatId: normalizedChatId,
                    clientId,
                },
            }).catch(() => undefined);
        } finally {
            steeringFollowUpsInFlight.delete(normalizedChatId);
            if (peekSteeringNotes(normalizedChatId).length > 0) {
                scheduleDeferredSteeringFollowUp({
                    chatId: normalizedChatId,
                    clientId,
                    originClientId,
                });
            }
        }
    });
}

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

app.get('/api/version', (_req, res) => {
    res.json({ version: readLocalPackageVersion() });
});

app.get('/api/update/status', (_req, res) => {
    try {
        const snapshot = getGitUpdateSnapshot({ fetchRemote: true });
        res.json({
            ok: true,
            checkedAt: new Date().toISOString(),
            ...snapshot,
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: formatCommandError(error, 'Failed to read update status.'),
        });
    }
});

app.get('/api/events', (req, res) => {
    openEventsStream(req, res);
});

app.get('/api/agents', (_req, res) => {
    try {
        const agents = listClientAgentDefinitions();
        res.json({ agents, defaultAgentId: DEFAULT_AGENT_ID });
    } catch {
        res.status(500).json({ error: 'Failed to list agents.' });
    }
});

/* ---- Settings endpoints ---- */
app.get('/api/settings', (_req, res) => {
    try {
        const settings = readSettings();
        const uiSettings = readUiSettings();
        res.json({ settings, uiSettings });
    } catch {
        res.status(500).json({ error: 'Failed to read settings.' });
    }
});

app.put('/api/settings', (req, res) => {
    try {
        const settings = req.body?.settings;
        const uiSettings = req.body?.uiSettings;

        let normalizedSettings = null;
        if (settings && typeof settings === 'object') {
            normalizedSettings = writeSettings(settings);
        } else if (settings !== undefined) {
            res.status(400).json({ error: 'Invalid settings payload.' });
            void writeSystemLog({
                level: 'warn',
                source: 'settings',
                eventType: 'settings.invalid_payload',
                message: 'Rejected invalid settings payload.',
            }).catch(() => undefined);
            return;
        } else {
            normalizedSettings = readSettings();
        }

        let normalizedUiSettings = null;
        if (uiSettings && typeof uiSettings === 'object') {
            normalizedUiSettings = writeUiSettings(uiSettings);
        } else {
            normalizedUiSettings = readUiSettings();
        }

        res.json({ ok: true, settings: normalizedSettings, uiSettings: normalizedUiSettings });
        void writeSystemLog({
            source: 'settings',
            eventType: 'settings.updated',
            message: 'Settings updated.',
            data: { agents: Object.keys(normalizedSettings || {}) },
        }).catch(() => undefined);

    } catch {
        res.status(500).json({ error: 'Failed to save settings.' });
        void writeSystemLog({
            level: 'error',
            source: 'settings',
            eventType: 'settings.update_failed',
            message: 'Failed to save settings.',
        }).catch(() => undefined);
    }
});

app.get('/api/mcp/servers', async (req, res) => {
    try {
        const includeTools = req.query?.includeTools === '1' || req.query?.includeTools === 'true';
        const servers = await mcpService.getServersSnapshot({ includeTools });
        res.json({ servers });
    } catch (error) {
        res.status(500).json({ error: 'Failed to read MCP servers.' });
        void writeSystemLog({
            level: 'error',
            source: 'mcp',
            eventType: 'mcp.read_failed',
            message: 'Failed to read MCP servers.',
            data: {
                error: String(error?.message ?? error ?? ''),
            },
        }).catch(() => undefined);
    }
});

app.get('/api/mcp/servers/:serverId/tools', async (req, res) => {
    try {
        const serverId = String(req.params?.serverId ?? '').trim();
        const server = await mcpService.getServerSnapshot(serverId, {
            includeTools: true,
            forceRefresh: true,
        });
        res.json({ server });
    } catch (error) {
        if (error?.code === 'MCP_SERVER_NOT_FOUND') {
            res.status(404).json({ error: error.message });
            return;
        }

        res.status(500).json({ error: 'Failed to read MCP server tools.' });
        void writeSystemLog({
            level: 'error',
            source: 'mcp',
            eventType: 'mcp.tools_read_failed',
            message: 'Failed to read MCP server tools.',
            data: {
                serverId: String(req.params?.serverId ?? ''),
                error: String(error?.message ?? error ?? ''),
            },
        }).catch(() => undefined);
    }
});

app.put('/api/mcp/servers', async (req, res) => {
    try {
        const serversPayload = req.body?.servers;
        if (!Array.isArray(serversPayload)) {
            res.status(400).json({ error: 'Invalid MCP servers payload.' });
            return;
        }

        const savedServers = writeMcpServers(serversPayload);
        await mcpService.syncConfig(savedServers);
        const servers = await mcpService.getServersSnapshot({ includeTools: false });

        res.json({ ok: true, servers });
        broadcastEvent('mcp.updated', {
            serverCount: servers.length,
        });
        void writeSystemLog({
            source: 'mcp',
            eventType: 'mcp.updated',
            message: 'MCP servers updated.',
            data: {
                serverCount: servers.length,
            },
        }).catch(() => undefined);
    } catch (error) {
        res.status(500).json({ error: 'Failed to save MCP servers.' });
        void writeSystemLog({
            level: 'error',
            source: 'mcp',
            eventType: 'mcp.update_failed',
            message: 'Failed to save MCP servers.',
            data: {
                error: String(error?.message ?? error ?? ''),
            },
        }).catch(() => undefined);
    }
});

app.get('/api/settings/editor/files', (_req, res) => {
    try {
        const sections = listEditableFileSections();
        res.json({ sections });
    } catch {
        res.status(500).json({ error: 'Failed to list editable files.' });
    }
});

app.get('/api/settings/editor/file', (req, res) => {
    try {
        const filePath = String(req.query?.path ?? '').trim();
        const file = readEditableFile(filePath);
        res.json({ file });
    } catch (error) {
        const code = error?.code;
        if (code === 'EDITABLE_FILE_INVALID_PATH') {
            res.status(400).json({ error: error.message });
            return;
        }
        if (code === 'EDITABLE_FILE_NOT_FOUND') {
            res.status(404).json({ error: error.message });
            return;
        }
        if (code === 'EDITABLE_FILE_FORBIDDEN' || code === 'EDITABLE_FILE_BINARY') {
            res.status(403).json({ error: error.message });
            return;
        }

        res.status(500).json({ error: 'Failed to read editable file.' });
    }
});

app.put('/api/settings/editor/file', (req, res) => {
    try {
        const filePath = String(req.body?.path ?? '').trim();
        const content = String(req.body?.content ?? '');
        const expectedModifiedAt = req.body?.modifiedAt;
        const file = writeEditableFile({ filePath, content, expectedModifiedAt });
        res.json({ ok: true, file });
        void writeSystemLog({
            source: 'settings',
            eventType: 'settings.editable_file_saved',
            message: 'Editable settings file saved.',
            data: {
                path: file.path,
                kind: file.kind,
            },
        }).catch(() => undefined);
    } catch (error) {
        const code = error?.code;
        if (code === 'EDITABLE_FILE_INVALID_PATH') {
            res.status(400).json({ error: error.message });
            return;
        }
        if (code === 'EDITABLE_FILE_NOT_FOUND') {
            res.status(404).json({ error: error.message });
            return;
        }
        if (code === 'EDITABLE_FILE_FORBIDDEN' || code === 'EDITABLE_FILE_BINARY') {
            res.status(403).json({ error: error.message });
            return;
        }
        if (code === 'EDITABLE_FILE_CONFLICT') {
            res.status(409).json({ error: error.message });
            return;
        }

        res.status(500).json({ error: 'Failed to save editable file.' });
        void writeSystemLog({
            level: 'error',
            source: 'settings',
            eventType: 'settings.editable_file_save_failed',
            message: 'Failed to save editable settings file.',
            data: { path: String(req.body?.path ?? '').trim() },
        }).catch(() => undefined);
    }
});

/* ---- Memory endpoints ---- */
app.get('/api/memory', (_req, res) => {
    try {
        res.json(memoryStore.getSnapshot());
    } catch {
        res.status(500).json({ error: 'Failed to read memory.' });
    }
});

app.put('/api/memory', (req, res) => {
    try {
        const content = String(req.body?.memory ?? '');
        memoryStore.writeLongTerm(content);
        broadcastEvent('memory.updated', {});
        res.json({ ok: true });
    } catch {
        res.status(500).json({ error: 'Failed to update memory.' });
    }
});

app.delete('/api/memory', (_req, res) => {
    try {
        memoryStore.clearAll();
        broadcastEvent('memory.cleared', {});
        res.json({ ok: true });
    } catch {
        res.status(500).json({ error: 'Failed to clear memory.' });
    }
});

/* ---- Skills endpoints ---- */
app.get('/api/skills', (_req, res) => {
    try {
        const skills = skillsLoader.listSkills(false).map((s) => {
            const meta = skillsLoader.getSkillMetadata(s.name) ?? {};
            const requires = parseRequires(meta);
            const available = checkRequirements(requires);
            const resources = skillsLoader.listSkillResources(s.name);
            return {
                name: s.name,
                source: s.source,
                description: meta.description ?? s.name,
                always: meta.always === true,
                available,
                enabled: skillsLoader.isSkillEnabled(s.name),
                hasResources: resources.length > 0,
                resourceCount: resources.length,
                license: meta.license || null,
            };
        });
        res.json({ skills });
    } catch {
        res.status(500).json({ error: 'Failed to list skills.' });
    }
});

app.get('/api/skills/:name/resources', (req, res) => {
    const name = String(req.params.name).trim();
    const resources = skillsLoader.listSkillResources(name);
    res.json({ name, resources });
});

app.get('/api/skills/:name/resources/*path', (req, res) => {
    const name = String(req.params.name).trim();
    const parsedPath = req.params.path || req.params[0] || '';
    const resourcePath = Array.isArray(parsedPath) ? parsedPath.join('/') : parsedPath;
    const content = skillsLoader.loadSkillResource(name, resourcePath);
    if (content === null) {
        res.status(404).json({ error: 'Resource not found.' });
        return;
    }
    res.type('text/plain').send(content);
});

app.put('/api/skills/:name/enabled', (req, res) => {
    const name = String(req.params.name).trim();
    const enabled = req.body?.enabled === true;
    skillsLoader.setSkillEnabled(name, enabled);
    res.json({ ok: true, name, enabled });
    void writeSystemLog({
        source: 'skills',
        eventType: 'skill.toggled',
        message: `Skill "${name}" ${enabled ? 'enabled' : 'disabled'}.`,
    }).catch(() => undefined);
});

app.get('/api/skills/:name', (req, res) => {
    const name = String(req.params.name).trim();
    const content = skillsLoader.loadSkill(name);
    if (!content) {
        res.status(404).json({ error: 'Skill not found.' });
        return;
    }
    const meta = skillsLoader.getSkillMetadata(name) ?? {};
    const resources = skillsLoader.listSkillResources(name);
    res.json({ name, content, metadata: meta, resources });
});

app.post('/api/skills/:name', (req, res) => {
    try {
        const name = String(req.params.name).trim();
        const content = String(req.body?.content ?? '');
        if (!content) {
            res.status(400).json({ error: 'Skill content is required.' });
            return;
        }
        skillsLoader.saveWorkspaceSkill(name, content);
        res.json({ ok: true });
        void writeSystemLog({
            source: 'skills',
            eventType: 'skill.saved',
            message: `Workspace skill "${name}" saved.`,
        }).catch(() => undefined);
    } catch {
        res.status(500).json({ error: 'Failed to save skill.' });
    }
});

app.delete('/api/skills/:name', (req, res) => {
    const name = String(req.params.name).trim();
    const removed = skillsLoader.removeWorkspaceSkill(name);
    if (!removed) {
        res.status(404).json({ error: 'Workspace skill not found.' });
        return;
    }
    res.json({ ok: true });
    void writeSystemLog({
        source: 'skills',
        eventType: 'skill.removed',
        message: `Workspace skill "${name}" removed.`,
    }).catch(() => undefined);
});

/* ---- Cron / Scheduling endpoints ---- */
app.get('/api/cron', (_req, res) => {
    try {
        const jobs = cronService.listJobs();
        const status = cronService.status();
        res.json({ ...status, jobs });
    } catch {
        res.status(500).json({ error: 'Failed to list cron jobs.' });
    }
});

app.post('/api/cron', (req, res) => {
    try {
        const { name, schedule, prompt, chatId } = req.body ?? {};
        const job = cronService.addJob({ name, schedule, prompt, chatId });
        broadcastEvent('cron.added', { job });
        void writeSystemLog({
            source: 'cron',
            eventType: 'cron.added',
            message: `Scheduled job "${job.name}" added.`,
            data: { jobId: job.id, name: job.name },
        }).catch(() => undefined);
        res.json({ ok: true, job });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to add job.';
        res.status(400).json({ error: message });
    }
});

app.delete('/api/cron/:jobId', (req, res) => {
    const jobId = String(req.params.jobId).trim();
    const removed = cronService.removeJob(jobId);
    if (!removed) {
        res.status(404).json({ error: 'Job not found.' });
        return;
    }
    broadcastEvent('cron.removed', { jobId });
    void writeSystemLog({
        source: 'cron',
        eventType: 'cron.removed',
        message: `Scheduled job ${jobId} removed.`,
        data: { jobId },
    }).catch(() => undefined);
    res.json({ ok: true });
});

app.put('/api/cron/:jobId', (req, res) => {
    const jobId = String(req.params.jobId).trim();
    const enabled = req.body?.enabled !== false;
    const job = cronService.enableJob(jobId, enabled);
    if (!job) {
        res.status(404).json({ error: 'Job not found.' });
        return;
    }
    broadcastEvent('cron.updated', { job });
    res.json({ ok: true, job });
});

app.post('/api/cron/:jobId/run', async (req, res) => {
    const jobId = String(req.params.jobId).trim();
    const job = await cronService.runJob(jobId);
    if (!job) {
        res.status(404).json({ error: 'Job not found.' });
        return;
    }
    res.json({ ok: true, job });
});

app.get('/api/models', async (_req, res) => {
    try {
        const models = await getModelsForClient();
        res.json({ models });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch models.' });
        void appendSystemLog({
            level: 'error',
            source: 'models',
            eventType: 'models.fetch_failed',
            message: 'Failed to fetch model catalog.',
            data: {
                error: String(error?.message ?? error ?? ''),
            },
        }).catch(() => undefined);
    }
});

app.get('/api/usage', async (req, res, next) => {
    try {
        const date = String(req.query?.date ?? '').trim();
        const requestedStartDate = String(req.query?.startDate ?? '').trim();
        const requestedEndDate = String(req.query?.endDate ?? '').trim();
        const agentId = String(req.query?.agentId ?? '').trim();
        const source = String(req.query?.source ?? '').trim();
        const startDate = requestedStartDate || date;
        const endDate = requestedEndDate || requestedStartDate || date;
        const snapshot = await getUsageSnapshotByRange({
            startDate,
            endDate,
            date,
            agentId,
            source,
        });
        res.json(snapshot);
    } catch (error) {
        next(error);
    }
});

app.delete('/api/usage', async (_req, res, next) => {
    try {
        await clearUsageRecords();
        broadcastEvent('usage.cleared', {});
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

app.get('/api/logs', async (req, res, next) => {
    try {
        const date = String(req.query?.date ?? '').trim();
        const requestedStartDate = String(req.query?.startDate ?? '').trim();
        const requestedEndDate = String(req.query?.endDate ?? '').trim();
        const startDate = requestedStartDate || date;
        const endDate = requestedEndDate || requestedStartDate || date;
        const limit = Number(req.query?.limit ?? 400);
        const level = String(req.query?.level ?? '').trim();
        const agentId = String(req.query?.agentId ?? '').trim();

        const snapshot = await getLogsSnapshot({
            startDate,
            endDate,
            date,
            limit,
            level,
            agentId,
        });

        res.json(snapshot);
    } catch (error) {
        next(error);
    }
});

app.delete('/api/logs', async (_req, res, next) => {
    try {
        await clearLogs();
        broadcastEvent('logs.cleared', {});
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

function scheduleApiLifecycleHelper(helperFileName, logPrefix = 'system') {
    const helperPath = path.join(process.cwd(), 'server', 'cli', helperFileName);

    setTimeout(() => {
        try {
            const child = spawn(process.execPath, [helperPath, String(process.pid)], {
                cwd: process.cwd(),
                detached: true,
                stdio: 'ignore',
                env: {
                    ...process.env,
                },
            });
            child.unref();
            process.exit(0);
        } catch (error) {
            console.error(`[${logPrefix}] Failed to schedule lifecycle helper: ${error.message}`);
        }
    }, 500);
}

app.post('/api/update', (_req, res) => {
    try {
        const snapshot = getGitUpdateSnapshot({ fetchRemote: true });

        if (snapshot.behind === 0 && snapshot.ahead === 0) {
            return res.json({ ok: true, message: 'Already up to date — no changes pulled.', restarting: false });
        }

        if (snapshot.behind === 0 && snapshot.ahead > 0) {
            const commitWord = snapshot.ahead === 1 ? 'commit' : 'commits';
            return res.json({
                ok: true,
                message: `Local branch is ahead of ${snapshot.remoteRef} by ${snapshot.ahead} ${commitWord}. Nothing to pull.`,
                restarting: false,
            });
        }

        if (snapshot.behind > 0 && snapshot.ahead > 0) {
            return res.status(409).json({
                error: `Local branch has diverged from ${snapshot.remoteRef}. Resolve the git history manually before auto-update.`,
            });
        }

        runGit(['merge', '--ff-only', snapshot.remoteRef], { timeout: 45000 });
        runCommand('npm', ['install'], { timeout: 180000 });
        runCommand('npm', ['run', 'build'], { timeout: 180000 });

        const refreshed = getGitUpdateSnapshot({ fetchRemote: false });
        const newVersion = refreshed.localVersion || 'unknown';

        res.json({ ok: true, message: `Update to v${newVersion} installed and built. Restarting…`, restarting: true });
        scheduleApiLifecycleHelper('restartApi.js', 'update');
    } catch (error) {
        res.status(500).json({ error: formatCommandError(error, 'Update failed') });
    }
});

app.post('/api/system/restart', (_req, res) => {
    res.json({
        ok: true,
        restarting: true,
        message: 'Restart scheduled. Reconnecting…',
    });
    scheduleApiLifecycleHelper('restartApi.js', 'system-restart');
});

app.post('/api/system/reset', (_req, res) => {
    res.json({
        ok: true,
        restarting: true,
        message: 'Reset scheduled. Runtime data will be recreated.',
    });
    scheduleApiLifecycleHelper('resetApi.js', 'system-reset');
});

app.get('/api/chats', async (_req, res, next) => {
    try {
        const chats = await listChats();
        res.json({ chats });
    } catch (error) {
        next(error);
    }
});

app.get('/api/chats/:chatId/messages', async (req, res, next) => {
    try {
        const { chatId } = req.params;
        const chat = await getChat(chatId);
        if (!chat) {
            res.status(404).json({ error: 'Chat not found.' });
            return;
        }

        const messages = await getChatMessages(chatId);
        res.json({ chat, messages });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/chats/:chatId/messages', async (req, res, next) => {
    try {
        const { chatId } = req.params;
        const clientId = normalizeClientId(req.query.clientId);
        const existingChat = await getChat(chatId);

        if (!existingChat) {
            res.status(404).json({ error: 'Chat not found.' });
            return;
        }

        const cleared = await clearChatMessages(chatId);
        if (!cleared) {
            res.status(404).json({ error: 'Chat not found.' });
            return;
        }

        broadcastEvent('chat.messages_cleared', {
            chatId,
            originClientId: clientId,
        });

        res.json({ ok: true });
        void writeSystemLog({
            source: 'chat',
            eventType: 'chat.messages_cleared',
            message: 'Chat messages cleared.',
            data: { chatId, clientId },
        }).catch(() => undefined);
    } catch (error) {
        next(error);
    }
});

app.delete('/api/chats/:chatId', async (req, res, next) => {
    try {
        const { chatId } = req.params;
        const clientId = normalizeClientId(req.query.clientId);
        const existingChat = await getChat(chatId);

        if (!existingChat) {
            res.status(404).json({ error: 'Chat not found.' });
            void writeSystemLog({
                level: 'warn',
                source: 'chat',
                eventType: 'chat.delete_not_found',
                message: 'Delete requested for missing chat.',
                data: { chatId, clientId },
            }).catch(() => undefined);
            return;
        }

        if (existingChat.deletable === false) {
            res.status(403).json({ error: 'This chat cannot be deleted.' });
            void writeSystemLog({
                level: 'warn',
                source: 'chat',
                eventType: 'chat.delete_forbidden',
                message: 'Delete requested for protected chat.',
                data: { chatId, clientId, kind: existingChat.kind },
            }).catch(() => undefined);
            return;
        }

        const removed = await removeChat(chatId);
        if (!removed) {
            res.status(404).json({ error: 'Chat not found.' });
            return;
        }

        broadcastEvent('chat.deleted', {
            chatId,
            originClientId: clientId,
        });

        res.json({ ok: true });
        void writeSystemLog({
            source: 'chat',
            eventType: 'chat.deleted',
            message: 'Chat deleted.',
            data: { chatId, clientId },
        }).catch(() => undefined);
    } catch (error) {
        next(error);
    }
});

app.post('/api/chat/stop', (req, res) => {
    const clientId = normalizeClientId(req.body?.clientId);
    const requestedChatId = String(req.body?.chatId ?? '').trim();
    const chatId = requestedChatId || null;
    const stoppedCountForClient = requestStopForClient(clientId, chatId);
    const stoppedCount = (
        stoppedCountForClient > 0
        || !chatId
    )
        ? stoppedCountForClient
        : requestStopForChat(chatId);

    res.json({
        ok: true,
        stoppedCount,
    });
    void writeSystemLog({
        source: 'chat',
        eventType: 'chat.stop_requested',
        message: `Stop requested for ${stoppedCount} generation(s).`,
        data: { clientId, chatId, stoppedCount },
    }).catch(() => undefined);
});

app.get('/api/chat/:chatId/streaming-state', (req, res) => {
    const chatId = String(req.params?.chatId ?? '').trim();
    if (!chatId) {
        return res.json({ active: false });
    }
    const snapshot = getStreamingSnapshot(chatId);
    if (!snapshot) {
        return res.json({ active: false });
    }
    res.json({
        active: true,
        message: snapshot.message,
        agentStreaming: snapshot.agentStreaming,
        updatedAt: snapshot.updatedAt,
    });
});

app.get('/api/browser-agent/sessions/:sessionId/live.mjpeg', async (req, res, next) => {
    try {
        const sessionId = String(req.params?.sessionId ?? '').trim();
        const chatId = String(req.query?.chatId ?? '').trim();
        if (!sessionId || !chatId) {
            return res.status(400).json({ error: 'sessionId and chatId are required.' });
        }

        await streamBrowserAgentLiveView({
            sessionId,
            chatId,
            req,
            res,
        });
    } catch (error) {
        if (!res.headersSent) {
            next(error);
        }
    }
});

app.get('/api/browser-agent/sessions/:sessionId', async (req, res, next) => {
    try {
        const sessionId = String(req.params?.sessionId ?? '').trim();
        const chatId = String(req.query?.chatId ?? '').trim();
        if (!sessionId || !chatId) {
            return res.status(400).json({ error: 'sessionId and chatId are required.' });
        }

        const result = await inspectBrowserAgentSessionForChat({
            sessionId,
            chatId,
        });
        res.json(result);
    } catch (error) {
        next(error);
    }
});

app.get('/api/browser-agent/sessions/:sessionId/recording', async (req, res, next) => {
    try {
        const sessionId = String(req.params?.sessionId ?? '').trim();
        const chatId = String(req.query?.chatId ?? '').trim();
        const limit = Number(req.query?.limit);
        if (!sessionId || !chatId) {
            return res.status(400).json({ error: 'sessionId and chatId are required.' });
        }

        const result = await getBrowserAgentRecordingForChat({
            sessionId,
            chatId,
            limit,
        });
        res.json(result);
    } catch (error) {
        next(error);
    }
});

app.get('/api/browser-agent/sessions/:sessionId/recording/video', async (req, res, next) => {
    try {
        const sessionId = String(req.params?.sessionId ?? '').trim();
        const chatId = String(req.query?.chatId ?? '').trim();
        const index = Number(req.query?.index);
        const download = String(req.query?.download ?? '').trim() === '1';
        if (!sessionId || !chatId) {
            return res.status(400).json({ error: 'sessionId and chatId are required.' });
        }

        const videoFile = await getBrowserAgentRecordingVideoForChat({
            sessionId,
            chatId,
            index,
        });

        if (download) {
            res.attachment(videoFile.fileName);
        }
        if (videoFile.mimeType) {
            res.type(videoFile.mimeType);
        }
        res.sendFile(videoFile.localPath);
    } catch (error) {
        next(error);
    }
});

app.post('/api/browser-agent/sessions/:sessionId/control', async (req, res, next) => {
    try {
        const sessionId = String(req.params?.sessionId ?? '').trim();
        const chatId = String(req.body?.chatId ?? '').trim();
        const action = String(req.body?.action ?? '').trim();
        if (!sessionId || !chatId || !action) {
            return res.status(400).json({ error: 'sessionId, chatId, and action are required.' });
        }

        const result = await performBrowserAgentLiveAction(sessionId, {
            chatId,
            action,
            x: req.body?.x,
            y: req.body?.y,
            text: req.body?.text,
            key: req.body?.key,
            url: req.body?.url,
            durationMs: req.body?.durationMs,
        });
        res.json(result);
    } catch (error) {
        next(error);
    }
});

app.post('/api/browser-agent/sessions/:sessionId/continue', async (req, res, next) => {
    try {
        const sessionId = String(req.params?.sessionId ?? '').trim();
        const chatId = String(req.body?.chatId ?? '').trim();
        const clientId = String(req.body?.clientId ?? '').trim();
        if (!sessionId || !chatId) {
            return res.status(400).json({ error: 'sessionId and chatId are required.' });
        }

        const result = await continueBrowserAgentSession({
            sessionId,
            chatId,
            clientId,
            note: req.body?.note,
        });

        const shouldResumeOrchestrator = result?.profileMode === 'persistent' && (
            ['completed', 'error', 'stopped'].includes(String(result?.status ?? '').trim().toLowerCase())
            || (
                String(result?.status ?? '').trim().toLowerCase() === 'awaiting_user'
                && ['confirmation', 'info'].includes(String(result?.questionType ?? '').trim().toLowerCase())
            )
        );

        if (shouldResumeOrchestrator) {
            const note = buildBrowserResumeFollowUpNote(result);
            if (note) {
                injectSteeringNote(chatId, note);
                scheduleDeferredSteeringFollowUp({
                    chatId,
                    clientId,
                    originClientId: clientId,
                });
            }
        }

        res.json(result);
    } catch (error) {
        next(error);
    }
});

app.get('/api/commands/:commandId/status', async (req, res) => {
    const commandId = String(req.params?.commandId ?? '').trim();
    const waitDurationSeconds = Number(req.query?.wait ?? 0);
    const outputCharacterCount = Number(req.query?.chars ?? 12_000);

    const snapshot = await getCommandStatusSnapshot({
        commandId,
        waitDurationSeconds,
        outputCharacterCount,
    });

    if (snapshot?.error) {
        const statusCode = snapshot.error.startsWith('Unknown command id') ? 404 : 400;
        res.status(statusCode).json(snapshot);
        return;
    }

    res.json(snapshot);
});

app.post('/api/chat/send', async (req, res, next) => {
    try {
        const inputText = normalizeMessageText(req.body?.message);
        let attachments = [];
        try {
            attachments = await normalizeIncomingAttachments(req.body?.attachments);
        } catch (error) {
            const message = error instanceof Error && error.message
                ? error.message
                : 'Invalid attachments.';
            res.status(400).json({ error: message });
            return;
        }

        if (!inputText && attachments.length === 0) {
            res.status(400).json({ error: 'Message text or at least one attachment is required.' });
            return;
        }

        const clientId = normalizeClientId(req.body?.clientId);
        const clientMessageId = String(req.body?.clientMessageId ?? '').trim() || createMessageId();
        const requestedChatId = String(req.body?.chatId ?? '').trim();
        const requestedAgentId = normalizeAgentId(req.body?.agentId);
        const isSteering = req.body?.isSteering === true;
        const replyTo = normalizeReplyToPayload(req.body?.replyTo);

        let chat = requestedChatId ? await getChat(requestedChatId) : null;
        let created = false;

        if (chat?.kind === INBOX_CHAT_KIND) {
            res.status(403).json({ error: 'Inbox is read-only. Use Reply to start a new chat.' });
            void writeSystemLog({
                level: 'warn',
                source: 'chat',
                eventType: 'chat.send_inbox_forbidden',
                message: 'Direct send requested for Inbox chat.',
                data: { chatId: requestedChatId, clientId },
            }).catch(() => undefined);
            return;
        }

        if (!chat) {
            if (requestedChatId) {
                res.status(404).json({ error: 'Chat not found.' });
                void writeSystemLog({
                    level: 'warn',
                    source: 'chat',
                    eventType: 'chat.send_not_found',
                    message: 'Message send requested for missing chat.',
                    data: { requestedChatId, clientId },
                }).catch(() => undefined);
                return;
            }

            chat = await createChatFromFirstMessage(getFirstMessageSeed({
                text: inputText,
                attachments,
            }), {
                agentId: requestedAgentId,
            });
            created = true;
            broadcastEvent('chat.upsert', {
                chat,
                originClientId: clientId,
            });
            void writeSystemLog({
                source: 'chat',
                eventType: 'chat.created',
                message: 'Chat created from first message.',
                data: { chatId: chat.id, clientId, agentId: chat.agentId },
            }).catch(() => undefined);
        }

        const hasAttachments = attachments && attachments.length > 0;
        const bootOnboardingActive = isBootOnboardingActive();

        const chatAgentId = normalizeAgentId(chat.agentId);
        const userMessageParts = buildUserMessageParts({
            text: inputText,
            attachments,
        });
        const usageInputText = buildUsageInputText({
            text: inputText,
            attachments,
        });
        const routingDecision = resolveRuntimeAgentForMessage({
            chatAgentId,
            text: inputText,
            attachments,
        });
        const runtimeAgentId = routingDecision.agentId;
        const systemInstructionOverride = bootOnboardingActive
            ? readBootPromptInstruction()
            : '';

        if (created && !hasAttachments && inputText && !bootOnboardingActive) {
            void generateAndApplyChatTitle({
                chatId: chat.id,
                clientId,
                originClientId: clientId,
                usageAgentId: chatAgentId,
                text: inputText,
                attachments,
            }).catch(() => undefined);
        }

        if (routingDecision.routed) {
            void writeSystemLog({
                source: 'router',
                eventType: 'orchestrator.route',
                message: `Orchestrator routed request to ${runtimeAgentId}.`,
                agentId: runtimeAgentId,
                data: {
                    chatId: chat.id,
                    clientId,
                    fromAgentId: chatAgentId,
                    toAgentId: runtimeAgentId,
                    reason: routingDecision.reason,
                    imageAttachmentCount: routingDecision.imageAttachmentCount,
                },
            }).catch(() => undefined);
        }

        const shouldDeferSteeringToActiveGeneration = isSteering
            && countActiveGenerationsForClient(clientId, chat.id) > 0;

        if (shouldDeferSteeringToActiveGeneration) {
            const appendedUser = await appendMessage(chat.id, {
                id: clientMessageId,
                role: 'user',
                text: inputText,
                parts: userMessageParts,
                replyTo,
            });
            await markUploadsCommitted(
                attachments.map((attachment) => attachment.uploadId),
                { chatId: chat.id, messageId: appendedUser.message.id },
            );

            broadcastEvent('message.added', {
                chatId: chat.id,
                message: appendedUser.message,
                originClientId: clientId,
            });

            broadcastEvent('chat.upsert', {
                chat: appendedUser.chat,
                originClientId: clientId,
            });

            injectSteeringNote(chat.id, usageInputText);

            void writeSystemLog({
                source: 'chat',
                eventType: 'chat.steering_deferred',
                message: 'Queued steering for the next reasoning boundary.',
                data: {
                    chatId: chat.id,
                    clientId,
                    agentId: runtimeAgentId,
                },
            }).catch(() => undefined);

            if (created && hasAttachments) {
                void generateAndApplyChatTitle({
                    chatId: chat.id,
                    clientId,
                    originClientId: clientId,
                    usageAgentId: chatAgentId,
                    text: inputText,
                    attachments,
                }).catch(() => undefined);
            }

            res.json({
                chat: appendedUser.chat,
                userMessage: appendedUser.message,
                aiMessage: null,
                created,
            });
            return;
        }

        const result = await enqueueChatWork(chat.id, async () => {
            const appendedUser = await appendMessage(chat.id, {
                id: clientMessageId,
                role: 'user',
                text: inputText,
                parts: userMessageParts,
                replyTo,
            });
            await markUploadsCommitted(
                attachments.map((attachment) => attachment.uploadId),
                { chatId: chat.id, messageId: appendedUser.message.id },
            );

            broadcastEvent('message.added', {
                chatId: chat.id,
                message: appendedUser.message,
                originClientId: clientId,
            });

            broadcastEvent('chat.upsert', {
                chat: appendedUser.chat,
                originClientId: clientId,
            });

            const history = await getRecentMessages(chat.id, getGeminiContextMessages() + 1);

            const assistantResult = await generateStreamingAssistantTurn({
                chat: appendedUser.chat,
                clientId,
                originClientId: clientId,
                runtimeAgentId,
                usageAgentId: chatAgentId,
                usageInputText,
                historyWithLatestUserTurn: history,
                systemInstructionOverride,
            });
            let finalChat = assistantResult.chat;
            const appendedAiMessage = assistantResult.aiMessage;
            const assistantText = assistantResult.assistantText;

            if (created && hasAttachments) {
                void generateAndApplyChatTitle({
                    chatId: chat.id,
                    clientId,
                    originClientId: clientId,
                    usageAgentId: chatAgentId,
                    text: inputText,
                    attachments,
                    aiText: assistantText,
                }).catch(() => undefined);
            }
            scheduleDeferredSteeringFollowUp({
                chatId: chat.id,
                clientId,
                originClientId: clientId,
            });

            return {
                chat: finalChat,
                userMessage: appendedUser.message,
                aiMessage: appendedAiMessage,
            };
        });

        res.json({
            ...result,
            created,
        });
    } catch (error) {
        next(error);
    }
});

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
    }

    if (req.path === '/api' || req.path.startsWith('/api/')) {
        next();
        return;
    }

    if (!fs.existsSync(DIST_INDEX_PATH)) {
        if (req.accepts('html')) {
            res.status(503).type('html').send(renderMissingFrontendHtml());
            return;
        }

        next();
        return;
    }

    frontendAssets(req, res, (error) => {
        if (error) {
            next(error);
            return;
        }

        const isAssetRequest = req.path.includes('.');
        if (isAssetRequest || !req.accepts('html')) {
            next();
            return;
        }

        res.sendFile(DIST_INDEX_PATH);
    });
});

app.use((error, _req, res, next) => {
    void next;
    const message = error instanceof Error ? error.message : 'Unknown server error.';
    void writeSystemLog({
        level: 'error',
        source: 'api',
        eventType: 'api.unhandled_error',
        message,
    }).catch(() => undefined);
    res.status(500).json({ error: message });
});

async function handleCronJob(job) {
    const chat = await ensureInboxChat();
    const chatId = chat.id;
    const syntheticPrompt = `[Scheduled: ${job.name}] ${job.prompt}`;

    void writeSystemLog({
        source: 'cron',
        eventType: 'cron.fired',
        message: `Scheduled job "${job.name}" fired.`,
        data: { jobId: job.id, chatId, prompt: job.prompt.slice(0, 200) },
    }).catch(() => undefined);

    broadcastEvent('cron.executed', { jobId: job.id, name: job.name, chatId });

    const cronClientId = `cron-${job.id}`;

    await enqueueChatWork(chatId, async () => {
        const chatAgentId = normalizeAgentId(chat.agentId);
        const runtimeAgentId = chatAgentId;
        const history = await getRecentMessages(chatId, getGeminiContextMessages());
        const historyWithLatestUserTurn = [
            ...history,
            {
                id: createMessageId(),
                chatId,
                role: 'user',
                text: syntheticPrompt,
                createdAt: Date.now(),
            },
        ];

        await generateStreamingAssistantTurn({
            chat,
            clientId: cronClientId,
            originClientId: cronClientId,
            runtimeAgentId,
            usageAgentId: chatAgentId,
            usageInputText: syntheticPrompt,
            historyWithLatestUserTurn,
        });
    });
}

async function start() {
    await initStorage();
    await ensureInboxChat();
    await initUploadStorage();
    await initUsageStorage();
    await initLogStorage();

    // Start cron service if enabled
    if (CRON_CONFIG.enabled) {
        cronService.start(async (job) => {
            try {
                await handleCronJob(job);
            } catch (error) {
                console.error(`[cron] Error executing job "${job.name}":`, error);
                void writeSystemLog({
                    level: 'error',
                    source: 'cron',
                    eventType: 'cron.error',
                    message: `Cron job "${job.name}" failed: ${error?.message ?? error}`,
                    data: { jobId: job.id },
                }).catch(() => undefined);
            }
        });
    }

    const server = http.createServer(app);
    server.on('upgrade', (req, socket, head) => {
        void handleBrowserAgentRemoteDesktopUpgrade(req, socket, head)
            .then((handled) => {
                if (!handled) {
                    socket.destroy();
                }
            })
            .catch(() => {
                socket.destroy();
            });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(API_PORT, () => {
            console.log(`Orchestrator listening on http://localhost:${API_PORT}`);
            void writeSystemLog({
                source: 'system',
                eventType: 'server.started',
                message: `Orchestrator started on port ${API_PORT}.`,
            }).catch(() => undefined);
            resolve();
        });
    });

    const shutdown = () => {
        cronService.stop();
        server.close(() => {
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

start().catch((error) => {
    console.error(error);
    process.exit(1);
});
