import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { API_PORT, GEMINI_CONTEXT_MESSAGES } from './core/config.js';
import { listClientAgentDefinitions, DEFAULT_AGENT_ID } from './agents/index.js';
import { CODING_AGENT_ID } from './agents/coding/index.js';
import { IMAGE_AGENT_ID } from './agents/image/index.js';
import { ORCHESTRATOR_AGENT_ID } from './agents/orchestrator/index.js';
import { generateAssistantReplyStream, listAvailableModels, getUnsupportedLevels, generateChatTitle } from './services/geminiService.js';
import { buildMergedModels } from '../src/config/agentModels.js';
import { openEventsStream, broadcastEvent, updateStreamingSnapshot, getStreamingSnapshot, clearStreamingSnapshot } from './core/events.js';
import { getCommandStatusSnapshot } from './tools/index.js';
import { estimateUsageCost } from './pricing/usage.js';
import { appendSystemLog, clearLogs, getLogsSnapshot, initLogStorage } from './storage/logs.js';
import { appendUsageRecord, clearUsageRecords, getUsageSnapshotByRange, initUsageStorage } from './storage/usage.js';
import {
    initStorage,
    listChats,
    getChat,
    createChatFromFirstMessage,
    appendMessage,
    getChatMessages,
    getRecentMessages,
    removeChat,
    updateChatTitle,
    updateChatLastConsolidated,
} from './storage/chats.js';
import { getAgentConfig, normalizeAgentId, readSettings, writeSettings } from './storage/settings.js';
import { memoryStore } from './services/memory.js';
import { skillsLoader } from './services/skills.js';
import { MEMORY_CONFIG, CRON_CONFIG } from './core/config.js';
import { cronService } from './services/cron.js';

const app = express();
app.use(express.json({ limit: '80mb' }));

const chatQueues = new Map();
const activeGenerationsByClient = new Map();


function createMessageId() {
    return `msg-${randomUUID()}`;
}

function formatGeminiError(error) {
    if (error instanceof Error && error.message) {
        return `Gemini error: ${error.message}`;
    }

    return 'Gemini error: Request failed.';
}

function normalizeMessageText(value) {
    return String(value ?? '').trim();
}


function countImageAttachments(attachments) {
    if (!Array.isArray(attachments)) {
        return 0;
    }

    let count = 0;
    for (const attachment of attachments) {
        const mimeType = String(attachment?.mimeType ?? '').trim().toLowerCase();
        if (mimeType.startsWith('image/')) {
            count += 1;
        }
    }

    return count;
}

function detectOrchestratorRoute({ attachments }) {
    const imageAttachmentCount = countImageAttachments(attachments);

    return {
        agentId: ORCHESTRATOR_AGENT_ID,
        routed: false,
        reason: 'general_intent',
        imageAttachmentCount,
    };
}

function resolveRuntimeAgentForMessage({ chatAgentId, text, attachments }) {
    const normalizedChatAgentId = normalizeAgentId(chatAgentId);
    if (normalizedChatAgentId !== ORCHESTRATOR_AGENT_ID) {
        return {
            agentId: normalizedChatAgentId,
            routed: false,
            reason: 'fixed_chat_agent',
            imageAttachmentCount: countImageAttachments(attachments),
        };
    }

    return detectOrchestratorRoute({
        text,
        attachments,
    });
}

const MAX_MESSAGE_ATTACHMENTS = 16;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function normalizeAttachmentMimeType(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized || !normalized.includes('/')) {
        return 'application/octet-stream';
    }

    return normalized;
}

function normalizeAttachmentName(value, index) {
    const fallback = `attachment-${index + 1}`;
    const normalized = String(value ?? '').trim();
    if (!normalized) return fallback;
    if (normalized.length <= 220) return normalized;
    return `${normalized.slice(0, 217)}...`;
}

function normalizeIncomingAttachments(value) {
    if (value === undefined || value === null) {
        return [];
    }

    if (!Array.isArray(value)) {
        throw new Error('Attachments must be an array.');
    }

    if (value.length > MAX_MESSAGE_ATTACHMENTS) {
        throw new Error(`Too many attachments. Maximum is ${MAX_MESSAGE_ATTACHMENTS}.`);
    }

    const normalized = [];
    let totalBytes = 0;

    for (let index = 0; index < value.length; index += 1) {
        const rawAttachment = value[index];
        if (!rawAttachment || typeof rawAttachment !== 'object') {
            continue;
        }

        const rawDataValue = String(rawAttachment.data ?? '').trim();
        if (!rawDataValue) {
            continue;
        }

        const data = rawDataValue.startsWith('data:')
            ? rawDataValue.slice(rawDataValue.indexOf(',') + 1).trim()
            : rawDataValue;

        const bytes = Buffer.from(data, 'base64');
        if (bytes.length === 0) {
            throw new Error(`Attachment ${index + 1} is empty or not valid base64.`);
        }

        if (bytes.length > MAX_ATTACHMENT_BYTES) {
            throw new Error(`Attachment "${normalizeAttachmentName(rawAttachment.name, index)}" is larger than 50 MB.`);
        }

        totalBytes += bytes.length;
        if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
            throw new Error('Total attachment size exceeds 50 MB.');
        }

        const normalizedAttachment = {
            name: normalizeAttachmentName(rawAttachment.name, index),
            mimeType: normalizeAttachmentMimeType(rawAttachment.mimeType ?? rawAttachment.type),
            data,
            sizeBytes: bytes.length,
        };
        normalized.push(normalizedAttachment);
    }

    return normalized;
}

function buildUserMessageParts({ text, attachments }) {
    const normalizedText = String(text ?? '').trim();
    const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
    const parts = normalizedAttachments.map((attachment) => ({
        inlineData: {
            mimeType: attachment.mimeType,
            data: attachment.data,
            displayName: attachment.name,
        },
    }));

    if (normalizedText) {
        parts.push({ text: normalizedText });
    }

    return parts.length > 0 ? parts : undefined;
}

function getFirstMessageSeed({ text, attachments }) {
    const normalizedText = String(text ?? '').trim();
    if (normalizedText) {
        return normalizedText;
    }

    const firstAttachmentName = String(attachments?.[0]?.name ?? '').trim();
    if (firstAttachmentName) {
        return `Attachment: ${firstAttachmentName}`;
    }

    return 'Attachment';
}

function buildUsageInputText({ text, attachments }) {
    const normalizedText = String(text ?? '').trim();
    const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
    if (normalizedAttachments.length === 0) {
        return normalizedText;
    }

    const label = normalizedAttachments
        .map((attachment) => String(attachment?.name ?? '').trim())
        .filter(Boolean)
        .join(', ');

    if (!normalizedText) {
        return label ? `[attachments] ${label}` : '[attachments]';
    }

    if (!label) {
        return normalizedText;
    }

    return `${normalizedText}\n\n[attachments] ${label}`;
}

function normalizeClientId(value) {
    const normalized = String(value ?? '').trim();
    return normalized || 'unknown-client';
}

function enqueueChatWork(chatId, task) {
    const previous = chatQueues.get(chatId) ?? Promise.resolve();
    const run = previous
        .catch(() => undefined)
        .then(task)
        .finally(() => {
            if (chatQueues.get(chatId) === run) {
                chatQueues.delete(chatId);
            }
        });

    chatQueues.set(chatId, run);
    return run;
}

function registerActiveGeneration(clientId, chatId) {
    const generation = {
        clientId,
        chatId,
        stopRequested: false,
    };

    const existing = activeGenerationsByClient.get(clientId) ?? new Set();
    existing.add(generation);
    activeGenerationsByClient.set(clientId, existing);
    return generation;
}

function unregisterActiveGeneration(generation) {
    if (!generation) return;

    const existing = activeGenerationsByClient.get(generation.clientId);
    if (!existing) return;

    existing.delete(generation);
    if (existing.size === 0) {
        activeGenerationsByClient.delete(generation.clientId);
    }
}

function requestStopForClient(clientId, chatId) {
    const existing = activeGenerationsByClient.get(clientId);
    if (!existing || existing.size === 0) {
        return 0;
    }

    let stoppedCount = 0;
    for (const generation of existing) {
        if (chatId && generation.chatId !== chatId) {
            continue;
        }

        if (!generation.stopRequested) {
            generation.stopRequested = true;
            stoppedCount += 1;
        }
    }

    return stoppedCount;
}

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

async function trackUsageRequest({
    chatId,
    clientId,
    originClientId,
    model,
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
} = {}) {
    const normalizedStatus = normalizeUsageStatus(status);
    const normalizedSource = normalizeUsageSource(source);
    const normalizedCreatedAt = normalizeUsageCreatedAt(createdAt);
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
    };

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
    const logMessage = isToolUsage
        ? `Tracked tool request (${normalizedStatus}) for ${usageRecord.model}.`
        : `Tracked request (${normalizedStatus}) for ${usageRecord.model}.`;

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
            status: normalizedStatus,
            inputTokens: usageRecord.inputTokens,
            outputTokens: usageRecord.outputTokens,
            costUsd: usageRecord.totalCostUsd,
        },
    }).catch(() => undefined);

    return usageRecord;
}

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

app.get('/api/version', async (_req, res) => {
    try {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
        res.json({ version: pkg.version });
    } catch {
        res.json({ version: '0.0.0' });
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
        res.json({ settings });
    } catch {
        res.status(500).json({ error: 'Failed to read settings.' });
    }
});

app.put('/api/settings', (req, res) => {
    try {
        const settings = req.body?.settings;
        if (!settings || typeof settings !== 'object') {
            res.status(400).json({ error: 'Invalid settings payload.' });
            void writeSystemLog({
                level: 'warn',
                source: 'settings',
                eventType: 'settings.invalid_payload',
                message: 'Rejected invalid settings payload.',
            }).catch(() => undefined);
            return;
        }
        const normalizedSettings = writeSettings(settings);
        res.json({ ok: true, settings: normalizedSettings });
        void writeSystemLog({
            source: 'settings',
            eventType: 'settings.updated',
            message: 'Settings updated.',
            data: { agents: Object.keys(normalizedSettings) },
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

/* ---- Memory endpoints ---- */
app.get('/api/memory', (_req, res) => {
    try {
        res.json({
            enabled: MEMORY_CONFIG.enabled,
            memory: memoryStore.readLongTerm(),
            history: memoryStore.readHistory(),
        });
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

/* ---- Archive chat to memory (used on "new chat") ---- */
app.post('/api/chats/:chatId/archive', async (req, res, next) => {
    try {
        if (!MEMORY_CONFIG.enabled) {
            res.json({ ok: true, skipped: true, reason: 'memory disabled' });
            return;
        }

        const { chatId } = req.params;
        const chat = await getChat(chatId);
        if (!chat) {
            res.status(404).json({ error: 'Chat not found.' });
            return;
        }

        const lastConsolidated = chat.lastConsolidated ?? 0;
        const allMessages = await getChatMessages(chatId);
        const unconsolidated = allMessages.slice(lastConsolidated);

        if (unconsolidated.length === 0) {
            res.json({ ok: true, skipped: true, reason: 'nothing to consolidate' });
            return;
        }

        // Immediately stash last 20 messages as pending context (sync, instant).
        // This way, if the user sends a message in a new chat before consolidation
        // finishes, the AI still has context from the previous conversation.
        const recentForContext = unconsolidated.slice(-20);
        const contextLines = recentForContext.map((m) => {
            const ts = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 16) : '?';
            const role = String(m.role ?? 'user').toUpperCase();
            const text = String(m.text ?? '').slice(0, 1000);
            return `[${ts}] ${role}: ${text}`;
        });
        memoryStore.setPendingContext(contextLines.join('\n'));

        // Respond immediately — consolidation runs in background
        res.json({ ok: true, consolidated: unconsolidated.length, pending: true });

        // Run LLM consolidation in background
        memoryStore.consolidate(unconsolidated).then((ok) => {
            if (ok) {
                updateChatLastConsolidated(chatId, allMessages.length).catch(() => undefined);
                broadcastEvent('memory.consolidated', {});
                void writeSystemLog({
                    source: 'memory',
                    eventType: 'memory.archived',
                    message: `Archived ${unconsolidated.length} messages from chat ${chatId} into long-term memory.`,
                }).catch(() => undefined);
            }
            // Clear pending context once consolidation is done (memory is now in MEMORY.md)
            memoryStore.clearPendingContext();
        }).catch(() => {
            memoryStore.clearPendingContext();
        });
    } catch (error) {
        next(error);
    }
});

/* ---- Skills endpoints ---- */
app.get('/api/skills', (_req, res) => {
    try {
        const skills = skillsLoader.listSkills(false).map((s) => {
            const meta = skillsLoader.getSkillMetadata(s.name) ?? {};
            return {
                name: s.name,
                source: s.source,
                description: meta.description ?? s.name,
                always: meta.always === true,
                available: true, // listSkills(false) includes unavailable
            };
        });
        res.json({ skills });
    } catch {
        res.status(500).json({ error: 'Failed to list skills.' });
    }
});

app.get('/api/skills/:name', (req, res) => {
    const name = String(req.params.name).trim();
    const content = skillsLoader.loadSkill(name);
    if (!content) {
        res.status(404).json({ error: 'Skill not found.' });
        return;
    }
    const meta = skillsLoader.getSkillMetadata(name) ?? {};
    res.json({ name, content, metadata: meta });
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
        const rawModels = await listAvailableModels();
        const merged = buildMergedModels(rawModels);
        const enriched = merged.map((m) => {
            const raw = rawModels.find((r) => r.name === m.fullName);
            return {
                ...m,
                thinking: raw?.thinking ?? false,
                unsupportedThinkingLevels: getUnsupportedLevels(m.id),
            };
        });
        res.json({ models: enriched });
    } catch {
        res.status(500).json({ error: 'Failed to fetch models.' });
    }
});

app.get('/api/usage', async (req, res, next) => {
    try {
        const date = String(req.query?.date ?? '').trim();
        const requestedStartDate = String(req.query?.startDate ?? '').trim();
        const requestedEndDate = String(req.query?.endDate ?? '').trim();
        const agentId = String(req.query?.agentId ?? '').trim();
        const startDate = requestedStartDate || date;
        const endDate = requestedEndDate || requestedStartDate || date;
        const snapshot = await getUsageSnapshotByRange({
            startDate,
            endDate,
            date,
            agentId,
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

app.post('/api/update', async (_req, res) => {
    const { execSync, spawn } = await import('node:child_process');
    try {
        const pullOutput = execSync('git pull origin main', { cwd: process.cwd(), timeout: 30000, stdio: 'pipe' }).toString();

        // Check if already up to date
        if (/already up.to.date/i.test(pullOutput)) {
            return res.json({ ok: true, message: 'Already up to date — no changes pulled.', restarting: false });
        }

        execSync('npm install', { cwd: process.cwd(), timeout: 60000, stdio: 'pipe' });

        // Read new version from updated package.json
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        let newVersion = 'unknown';
        try {
            const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
            newVersion = pkg.version;
        } catch { /* ignore */ }

        res.json({ ok: true, message: `Update to v${newVersion} installed. Restarting…`, restarting: true });

        // Schedule restart after response is sent
        setTimeout(() => {
            const child = spawn('npm', ['run', 'restart'], {
                cwd: process.cwd(),
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
            process.exit(0);
        }, 500);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Update failed' });
    }
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

app.delete('/api/chats/:chatId', async (req, res, next) => {
    try {
        const { chatId } = req.params;
        const clientId = normalizeClientId(req.query.clientId);

        // Archive unconsolidated messages to memory before deleting
        if (MEMORY_CONFIG.enabled) {
            try {
                const chat = await getChat(chatId);
                if (chat) {
                    const lastConsolidated = chat.lastConsolidated ?? 0;
                    const allMessages = await getChatMessages(chatId);
                    const unconsolidated = allMessages.slice(lastConsolidated);
                    if (unconsolidated.length > 0) {
                        memoryStore.consolidate(unconsolidated).then((ok) => {
                            if (ok) {
                                broadcastEvent('memory.consolidated', {});
                                void writeSystemLog({
                                    source: 'memory',
                                    eventType: 'memory.archived',
                                    message: `Archived ${unconsolidated.length} messages from chat ${chatId} before deletion.`,
                                }).catch(() => undefined);
                            } else {
                                console.warn(`[memory] Consolidation before delete failed for chat ${chatId}, proceeding with deletion`);
                            }
                        }).catch((memError) => {
                            console.warn(`[memory] Error consolidating before delete for chat ${chatId}:`, memError?.message);
                        });
                    }
                }
            } catch (memError) {
                console.warn(`[memory] Error consolidating before delete for chat ${chatId}:`, memError?.message);
            }
        }

        const removed = await removeChat(chatId);
        if (!removed) {
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
    const stoppedCount = requestStopForClient(clientId, chatId);

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
            attachments = normalizeIncomingAttachments(req.body?.attachments);
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

        let chat = requestedChatId ? await getChat(requestedChatId) : null;
        let created = false;

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
        if (created && !hasAttachments && inputText) {
            generateChatTitle({ text: inputText }).then(generatedTitle => {
                if (generatedTitle) {
                    updateChatTitle(chat.id, generatedTitle).then(updatedChat => {
                        if (updatedChat) {
                            broadcastEvent('chat.upsert', {
                                chat: updatedChat,
                                originClientId: clientId,
                            });
                        }
                    }).catch(() => undefined);
                }
            }).catch(() => undefined);
        }

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

        const result = await enqueueChatWork(chat.id, async () => {
            const appendedUser = await appendMessage(chat.id, {
                id: clientMessageId,
                role: 'user',
                text: inputText,
                parts: userMessageParts,
            });

            broadcastEvent('message.added', {
                chatId: chat.id,
                message: appendedUser.message,
                originClientId: clientId,
            });

            broadcastEvent('chat.upsert', {
                chat: appendedUser.chat,
                originClientId: clientId,
            });

            const history = await getRecentMessages(chat.id, GEMINI_CONTEXT_MESSAGES + 1);

            const aiMessageId = createMessageId();
            const aiMessageCreatedAt = Date.now();
            let streamedAssistantText = '';
            let streamedAssistantThought = '';
            let streamedAssistantParts = [];
            let streamedAssistantSteps = [];
            let assistantText;
            let usageMetadata = null;
            let modelForUsage = getAgentConfig(runtimeAgentId).model;
            let requestStatus = 'completed';
            let toolUsageRecords = [];

            broadcastEvent('message.streaming', {
                chatId: chat.id,
                message: {
                    id: aiMessageId,
                    chatId: chat.id,
                    role: 'ai',
                    text: '',
                    thought: '',
                    parts: [],
                    steps: [],
                    createdAt: aiMessageCreatedAt,
                },
                originClientId: clientId,
            });

            const activeGeneration = registerActiveGeneration(clientId, chat.id);
            try {
                const streamResult = await generateAssistantReplyStream(history, {
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
                        };
                        updateStreamingSnapshot(chat.id, { message: messageSnapshot });
                        broadcastEvent('message.streaming', {
                            chatId: chat.id,
                            message: messageSnapshot,
                            originClientId: clientId,
                        });
                    },
                    shouldStop: () => activeGeneration.stopRequested,
                    agentId: runtimeAgentId,
                });
                usageMetadata = streamResult.usageMetadata ?? null;
                modelForUsage = String(streamResult.model ?? modelForUsage).trim() || modelForUsage;
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

                // Ensure the final streaming frame contains per-step snapshots.
                broadcastEvent('message.streaming', {
                    chatId: chat.id,
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
                    originClientId: clientId,
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
                    originClientId: clientId,
                });
            } finally {
                unregisterActiveGeneration(activeGeneration);
                clearStreamingSnapshot(chat.id);
            }

            const appendedAi = await appendMessage(chat.id, {
                id: aiMessageId,
                role: 'ai',
                text: assistantText,
                thought: streamedAssistantThought,
                parts: streamedAssistantParts,
                steps: streamedAssistantSteps,
                createdAt: aiMessageCreatedAt,
            });

            broadcastEvent('message.added', {
                chatId: chat.id,
                message: appendedAi.message,
                originClientId: clientId,
            });

            broadcastEvent('chat.upsert', {
                chat: appendedAi.chat,
                originClientId: clientId,
            });

            if (created && hasAttachments) {
                generateChatTitle({ text: inputText, attachments, aiText: assistantText }).then(generatedTitle => {
                    if (generatedTitle) {
                        updateChatTitle(chat.id, generatedTitle).then(updatedChat => {
                            if (updatedChat) {
                                broadcastEvent('chat.upsert', {
                                    chat: updatedChat,
                                    originClientId: clientId,
                                });
                            }
                        }).catch(() => undefined);
                    }
                }).catch(() => undefined);
            }

            const usageRecord = await trackUsageRequest({
                chatId: chat.id,
                clientId,
                status: requestStatus,
                agentId: chatAgentId,
                model: modelForUsage,
                inputText: usageInputText,
                outputText: assistantText,
                createdAt: aiMessageCreatedAt,
                usageMetadata,
                originClientId: clientId,
                source: 'chat',
            });

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

                const toolName = String(toolUsage.toolName ?? '').trim();
                await trackUsageRequest({
                    chatId: chat.id,
                    clientId,
                    status: normalizeUsageStatus(toolUsage.status),
                    agentId: String(toolUsage.agentId ?? '').trim() || chatAgentId,
                    model: toolModel,
                    inputText: normalizeUsageText(
                        toolUsage.inputText,
                        toolName ? `[tool:${toolName}]` : '[tool]',
                    ),
                    outputText: normalizeUsageText(toolUsage.outputText),
                    createdAt: normalizeUsageCreatedAt(toolUsage.createdAt, aiMessageCreatedAt),
                    usageMetadata: toolUsageMetadata,
                    originClientId: clientId,
                    source: normalizeUsageSource(toolUsage.source, 'tool'),
                    parentRequestId: usageRecord.id,
                    toolName,
                    toolCallId: String(toolUsage.toolCallId ?? '').trim(),
                });
            }

            // Trigger memory consolidation in background when unconsolidated count exceeds window
            if (MEMORY_CONFIG.enabled && !memoryStore.isConsolidating) {
                const freshChat = await getChat(chat.id);
                const lastConsolidated = freshChat?.lastConsolidated ?? 0;
                const unconsolidatedCount = (freshChat?.messageCount ?? 0) - lastConsolidated;

                if (unconsolidatedCount >= MEMORY_CONFIG.window) {
                    const allMessages = await getChatMessages(chat.id);
                    const halfWindow = Math.floor(MEMORY_CONFIG.window / 2);
                    const messagesToConsolidate = allMessages.slice(lastConsolidated, -halfWindow);
                    if (messagesToConsolidate.length > 0) {
                        const newPointer = allMessages.length - halfWindow;
                        memoryStore.consolidate(messagesToConsolidate).then((ok) => {
                            if (ok) {
                                updateChatLastConsolidated(chat.id, newPointer).catch(() => undefined);
                                broadcastEvent('memory.consolidated', {});
                                void writeSystemLog({
                                    source: 'memory',
                                    eventType: 'memory.consolidated',
                                    message: `Consolidated ${messagesToConsolidate.length} messages into long-term memory (pointer: ${lastConsolidated} → ${newPointer}).`,
                                }).catch(() => undefined);
                            }
                        }).catch(() => undefined);
                    }
                }
            }

            return {
                chat: appendedAi.chat,
                userMessage: appendedUser.message,
                aiMessage: appendedAi.message,
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
    const chatId = job.chatId;
    if (!chatId) {
        console.warn(`[cron] Job "${job.name}" has no chatId, skipping.`);
        return;
    }

    const chat = await getChat(chatId);
    if (!chat) {
        console.warn(`[cron] Chat ${chatId} not found for job "${job.name}", skipping.`);
        return;
    }

    void writeSystemLog({
        source: 'cron',
        eventType: 'cron.fired',
        message: `Scheduled job "${job.name}" fired.`,
        data: { jobId: job.id, chatId, prompt: job.prompt.slice(0, 200) },
    }).catch(() => undefined);

    broadcastEvent('cron.executed', { jobId: job.id, name: job.name, chatId });

    // Inject the cron prompt as a user message and generate a reply
    const cronClientId = `cron-${job.id}`;
    const cronMessageId = createMessageId();

    await enqueueChatWork(chatId, async () => {
        const appendedUser = await appendMessage(chatId, {
            id: cronMessageId,
            role: 'user',
            text: `[Scheduled: ${job.name}] ${job.prompt}`,
        });

        broadcastEvent('message.added', {
            chatId,
            message: appendedUser.message,
            originClientId: cronClientId,
        });

        broadcastEvent('chat.upsert', {
            chat: appendedUser.chat,
            originClientId: cronClientId,
        });

        const chatAgentId = normalizeAgentId(chat.agentId);
        const runtimeAgentId = chatAgentId;
        const history = await getRecentMessages(chatId, GEMINI_CONTEXT_MESSAGES + 1);

        const aiMessageId = createMessageId();
        const aiMessageCreatedAt = Date.now();
        let assistantText = '';
        let streamedThought = '';
        let streamedParts = [];
        let streamedSteps = [];
        let usageMetadata = null;
        let modelForUsage = getAgentConfig(runtimeAgentId).model;
        let requestStatus = 'completed';

        broadcastEvent('message.streaming', {
            chatId,
            message: { id: aiMessageId, chatId, role: 'ai', text: '', thought: '', parts: [], steps: [], createdAt: aiMessageCreatedAt },
            originClientId: cronClientId,
        });

        try {
            const streamResult = await generateAssistantReplyStream(history, {
                chatId,
                messageId: aiMessageId,
                clientId: cronClientId,
                onUpdate: async ({ text, thought, parts, steps }) => {
                    assistantText = text;
                    streamedThought = thought;
                    streamedParts = Array.isArray(parts) ? parts : streamedParts;
                    streamedSteps = Array.isArray(steps) ? steps : streamedSteps;
                    broadcastEvent('message.streaming', {
                        chatId,
                        message: { id: aiMessageId, chatId, role: 'ai', text, thought, parts: streamedParts, steps: streamedSteps, createdAt: aiMessageCreatedAt },
                        originClientId: cronClientId,
                    });
                },
                shouldStop: () => false,
                agentId: runtimeAgentId,
            });

            usageMetadata = streamResult.usageMetadata ?? null;
            modelForUsage = String(streamResult.model ?? modelForUsage).trim() || modelForUsage;
            assistantText = String(streamResult.text ?? '').trim() || 'No response.';
            streamedThought = streamResult.thought;
            streamedParts = Array.isArray(streamResult.parts) ? streamResult.parts : streamedParts;
            streamedSteps = Array.isArray(streamResult.steps) ? streamResult.steps : streamedSteps;
        } catch (error) {
            requestStatus = 'error';
            assistantText = assistantText
                ? `${assistantText}\n\n${formatGeminiError(error)}`
                : formatGeminiError(error);
        }

        const appendedAi = await appendMessage(chatId, {
            id: aiMessageId,
            role: 'ai',
            text: assistantText,
            thought: streamedThought,
            parts: streamedParts,
            steps: streamedSteps,
            createdAt: aiMessageCreatedAt,
        });

        broadcastEvent('message.added', {
            chatId,
            message: appendedAi.message,
            originClientId: cronClientId,
        });

        broadcastEvent('chat.upsert', {
            chat: appendedAi.chat,
            originClientId: cronClientId,
        });

        await trackUsageRequest({
            chatId,
            clientId: cronClientId,
            status: requestStatus,
            agentId: chatAgentId,
            model: modelForUsage,
            inputText: job.prompt,
            outputText: assistantText,
            createdAt: aiMessageCreatedAt,
            usageMetadata,
            originClientId: cronClientId,
            source: 'cron',
        });
    });
}

async function start() {
    await initStorage();
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

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(API_PORT, () => {
            console.log(`API listening on http://localhost:${API_PORT}`);
            void writeSystemLog({
                source: 'system',
                eventType: 'server.started',
                message: `API started on port ${API_PORT}.`,
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
