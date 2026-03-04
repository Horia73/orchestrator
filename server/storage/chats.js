import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeAgentId } from './settings.js';
import {
    CHAT_DATA_DIR,
    CHAT_INDEX_PATH,
    CHAT_MESSAGES_DIR,
} from '../core/dataPaths.js';
import { deleteUploads } from './uploads.js';
import { removeTodoState } from './todos.js';
const CHATS_DIR = CHAT_MESSAGES_DIR;
const INDEX_PATH = CHAT_INDEX_PATH;

const DEFAULT_INDEX = {
    version: 3,
    chats: [],
};

export const DEFAULT_CHAT_KIND = 'default';
export const INBOX_CHAT_KIND = 'inbox';
export const INBOX_CHAT_ID = 'chat-inbox';
export const INBOX_CHAT_TITLE = 'Inbox';

let initialized = false;
let state = { ...DEFAULT_INDEX };

function createChatId() {
    return `chat-${randomUUID()}`;
}

function createMessageId() {
    return `msg-${randomUUID()}`;
}

function sortChats(chats) {
    return [...chats].sort((a, b) => {
        const pinnedDiff = Number(Boolean(b?.pinned)) - Number(Boolean(a?.pinned));
        if (pinnedDiff !== 0) {
            return pinnedDiff;
        }

        return b.updatedAt - a.updatedAt;
    });
}

function getChatFilePath(chatId) {
    return path.join(CHATS_DIR, `${chatId}.jsonl`);
}

function truncatePreview(text) {
    const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return '';
    if (cleaned.length <= 90) return cleaned;
    return `${cleaned.slice(0, 89).trimEnd()}…`;
}

function findChatIndex(chatId) {
    return state.chats.findIndex((chat) => chat.id === chatId);
}

function normalizeChatKind(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === INBOX_CHAT_KIND ? INBOX_CHAT_KIND : DEFAULT_CHAT_KIND;
}

function buildChatRecord(rawChat = {}) {
    const id = String(rawChat.id ?? '').trim() || createChatId();
    const kind = normalizeChatKind(rawChat.kind);
    const isInbox = kind === INBOX_CHAT_KIND || id === INBOX_CHAT_ID;
    const createdAt = Number(rawChat.createdAt);
    const updatedAt = Number(rawChat.updatedAt);
    const messageCount = Number(rawChat.messageCount);
    const lastConsolidated = Number(rawChat.lastConsolidated);

    return {
        id: isInbox ? INBOX_CHAT_ID : id,
        title: isInbox ? INBOX_CHAT_TITLE : String(rawChat.title ?? 'Untitled'),
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
        messageCount: Number.isFinite(messageCount) && messageCount >= 0
            ? Math.trunc(messageCount)
            : 0,
        lastMessagePreview: String(rawChat.lastMessagePreview ?? ''),
        agentId: normalizeAgentId(rawChat.agentId),
        lastConsolidated: Number.isFinite(lastConsolidated) && lastConsolidated >= 0
            ? Math.trunc(lastConsolidated)
            : 0,
        kind: isInbox ? INBOX_CHAT_KIND : kind,
        pinned: isInbox ? true : rawChat.pinned === true,
        deletable: isInbox ? false : rawChat.deletable !== false,
    };
}

function normalizeReplyTo(replyTo) {
    if (!replyTo || typeof replyTo !== 'object') {
        return null;
    }

    const chatId = String(replyTo.chatId ?? '').trim();
    const messageId = String(replyTo.messageId ?? '').trim();
    if (!chatId || !messageId) {
        return null;
    }

    const previewText = String(replyTo.previewText ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
    const chatTitle = String(replyTo.chatTitle ?? '').trim().slice(0, 80);
    const role = String(replyTo.role ?? '').trim().toLowerCase() === 'user' ? 'user' : 'ai';

    return {
        chatId,
        messageId,
        role,
        previewText,
        ...(chatTitle ? { chatTitle } : {}),
    };
}

function normalizeMessagePart(part) {
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
        normalized.inlineData = part.inlineData;
    } else if (hasFileData) {
        normalized.fileData = part.fileData;
    }

    return Object.keys(normalized).length > 0 ? normalized : null;
}

function collectUploadIdsFromParts(parts, into) {
    if (!Array.isArray(parts)) {
        return;
    }

    for (const part of parts) {
        const uploadId = String(part?.fileData?.uploadId ?? '').trim();
        if (uploadId) {
            into.add(uploadId);
        }
    }
}

function normalizeMessageParts(parts) {
    if (!Array.isArray(parts)) {
        return null;
    }

    const normalized = parts
        .map(normalizeMessagePart)
        .filter(Boolean);

    return normalized.length > 0 ? normalized : null;
}

function normalizeMessageStep(step, index) {
    if (!step || typeof step !== 'object') {
        return null;
    }

    const normalizedParts = normalizeMessageParts(step.parts);
    const text = String(step.text ?? '');
    const thought = String(step.thought ?? '');
    const isThinking = step.isThinking === true;
    const isWorked = step.isWorked === true;
    const textFirst = step.textFirst === true;
    const normalized = {
        index: Number(step.index) || (index + 1),
        text,
        thought,
    };

    if (normalizedParts) {
        normalized.parts = normalizedParts;
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

    if (!text.trim() && !thought.trim() && !normalizedParts && !isThinking && !isWorked) {
        return null;
    }

    return normalized;
}

function normalizeMessageSteps(steps) {
    if (!Array.isArray(steps)) {
        return null;
    }

    const normalized = steps
        .map((step, index) => normalizeMessageStep(step, index))
        .filter(Boolean);

    return normalized.length > 0 ? normalized : null;
}

async function atomicWriteJson(filePath, payload) {
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tmpPath, filePath);
}

async function persistIndex() {
    await atomicWriteJson(INDEX_PATH, {
        ...state,
        chats: sortChats(state.chats),
    });
}

async function ensureInitialized() {
    if (initialized) return;

    await fs.mkdir(CHAT_DATA_DIR, { recursive: true });
    await fs.mkdir(CHATS_DIR, { recursive: true });

    try {
        const raw = await fs.readFile(INDEX_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const parsedChats = Array.isArray(parsed?.chats) ? parsed.chats : [];
        const normalizedChats = [];
        let shouldPersist = Number(parsed?.version) !== DEFAULT_INDEX.version;

        for (const rawChat of parsedChats) {
            if (!rawChat || typeof rawChat !== 'object') {
                shouldPersist = true;
                continue;
            }

            const id = String(rawChat.id ?? '').trim();
            if (!id) {
                shouldPersist = true;
                continue;
            }

            const normalizedChat = buildChatRecord(rawChat);

            if (
                String(rawChat.agentId ?? '').trim().toLowerCase() !== normalizedChat.agentId
                || normalizeChatKind(rawChat.kind) !== normalizedChat.kind
                || Boolean(rawChat.pinned) !== Boolean(normalizedChat.pinned)
                || Boolean(rawChat.deletable !== false) !== Boolean(normalizedChat.deletable)
                || (normalizedChat.kind === INBOX_CHAT_KIND && normalizedChat.id !== id)
                || (normalizedChat.kind === INBOX_CHAT_KIND && normalizedChat.title !== String(rawChat.title ?? ''))
            ) {
                shouldPersist = true;
            }

            normalizedChats.push(normalizedChat);
        }

        state = {
            version: DEFAULT_INDEX.version,
            chats: normalizedChats,
        };
        if (shouldPersist) {
            await persistIndex();
        }
    } catch {
        state = { ...DEFAULT_INDEX };
        await persistIndex();
    }

    if (!state.chats.some((chat) => chat.id === INBOX_CHAT_ID)) {
        const inboxChat = buildChatRecord({
            id: INBOX_CHAT_ID,
            title: INBOX_CHAT_TITLE,
            agentId: 'orchestrator',
            kind: INBOX_CHAT_KIND,
            pinned: true,
            deletable: false,
        });
        state.chats = sortChats([inboxChat, ...state.chats]);
        await fs.writeFile(getChatFilePath(inboxChat.id), '', 'utf8');
        await persistIndex();
    }

    state.chats = sortChats(state.chats);
    initialized = true;
}

async function appendLine(filePath, payload) {
    await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function rewriteJsonLines(filePath, payloads) {
    const serialized = Array.isArray(payloads) && payloads.length > 0
        ? `${payloads.map((payload) => JSON.stringify(payload)).join('\n')}\n`
        : '';
    await fs.writeFile(filePath, serialized, 'utf8');
}

async function readJsonLines(filePath) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        if (!raw.trim()) return [];

        return raw
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return [];
        }

        throw error;
    }
}

export async function initStorage() {
    await ensureInitialized();
}

export async function listChats() {
    await ensureInitialized();
    await ensureInboxChat();
    return sortChats(state.chats);
}

export async function getChat(chatId) {
    await ensureInitialized();
    if (String(chatId ?? '').trim() === INBOX_CHAT_ID) {
        return ensureInboxChat();
    }
    return state.chats.find((chat) => chat.id === chatId) ?? null;
}

export async function createChatFromFirstMessage(firstMessageText, options = {}) {
    await ensureInitialized();
    const now = Date.now();

    const chat = buildChatRecord({
        id: createChatId(),
        title: 'Untitled',
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        lastMessagePreview: '',
        agentId: normalizeAgentId(options?.agentId),
        lastConsolidated: 0,
        kind: options?.kind,
        pinned: options?.pinned,
        deletable: options?.deletable,
    });

    state.chats = [chat, ...state.chats];
    await fs.writeFile(getChatFilePath(chat.id), '', 'utf8');
    await persistIndex();

    return chat;
}

export async function appendMessage(chatId, payload) {
    await ensureInitialized();

    const chatIdx = findChatIndex(chatId);
    if (chatIdx === -1) {
        throw new Error(`Chat "${chatId}" was not found.`);
    }

    const normalizedParts = normalizeMessageParts(payload.parts);
    const normalizedSteps = normalizeMessageSteps(payload.steps);
    const message = {
        id: payload.id ?? createMessageId(),
        chatId,
        role: payload.role,
        text: String(payload.text ?? ''),
        thought: String(payload.thought ?? ''),
        createdAt: payload.createdAt ?? Date.now(),
    };
    const normalizedReplyTo = normalizeReplyTo(payload.replyTo);

    if (normalizedParts) {
        message.parts = normalizedParts;
    }

    if (normalizedSteps) {
        message.steps = normalizedSteps;
    }

    if (normalizedReplyTo) {
        message.replyTo = normalizedReplyTo;
    }

    await appendLine(getChatFilePath(chatId), message);

    const current = state.chats[chatIdx];
    const nextCount = current.messageCount + 1;
    const nextTitle = current.title;
    const nextPreview = message.role === 'ai'
        ? truncatePreview(message.text)
        : current.lastMessagePreview;

    const updated = {
        ...current,
        title: nextTitle,
        updatedAt: message.createdAt,
        messageCount: nextCount,
        lastMessagePreview: nextPreview,
    };

    state.chats[chatIdx] = updated;
    state.chats = sortChats(state.chats);
    await persistIndex();

    return {
        message,
        chat: updated,
    };
}

function normalizePersistedMessage(chatId, payload) {
    const normalizedParts = normalizeMessageParts(payload.parts);
    const normalizedSteps = normalizeMessageSteps(payload.steps);
    const message = {
        id: String(payload.id ?? createMessageId()).trim() || createMessageId(),
        chatId,
        role: payload.role,
        text: String(payload.text ?? ''),
        thought: String(payload.thought ?? ''),
        createdAt: payload.createdAt ?? Date.now(),
    };
    const normalizedReplyTo = normalizeReplyTo(payload.replyTo);

    if (normalizedParts) {
        message.parts = normalizedParts;
    }

    if (normalizedSteps) {
        message.steps = normalizedSteps;
    }

    if (normalizedReplyTo) {
        message.replyTo = normalizedReplyTo;
    }

    return message;
}

export async function updateMessage(chatId, messageId, updater) {
    await ensureInitialized();

    const chatIdx = findChatIndex(chatId);
    if (chatIdx === -1) {
        throw new Error(`Chat "${chatId}" was not found.`);
    }

    const normalizedMessageId = String(messageId ?? '').trim();
    if (!normalizedMessageId) {
        throw new Error('messageId is required.');
    }

    const filePath = getChatFilePath(chatId);
    const messages = await readJsonLines(filePath);
    const messageIndex = messages.findIndex((message) => String(message?.id ?? '').trim() === normalizedMessageId);
    if (messageIndex === -1) {
        return null;
    }

    const currentMessage = messages[messageIndex];
    const nextValue = typeof updater === 'function'
        ? await updater(currentMessage)
        : updater;

    if (!nextValue || typeof nextValue !== 'object') {
        return null;
    }

    const nextMessage = normalizePersistedMessage(chatId, {
        ...currentMessage,
        ...nextValue,
        id: currentMessage.id,
        chatId,
        role: nextValue.role ?? currentMessage.role,
        createdAt: nextValue.createdAt ?? currentMessage.createdAt,
    });

    messages[messageIndex] = nextMessage;
    await rewriteJsonLines(filePath, messages);

    const currentChat = state.chats[chatIdx];
    const lastMessage = messages[messages.length - 1] ?? null;
    const updated = {
        ...currentChat,
        updatedAt: Math.max(
            Number(currentChat.updatedAt) || 0,
            Number(nextMessage.createdAt) || 0,
        ),
        lastMessagePreview: (
            lastMessage?.role === 'ai'
                ? truncatePreview(lastMessage.text)
                : currentChat.lastMessagePreview
        ),
    };

    state.chats[chatIdx] = updated;
    state.chats = sortChats(state.chats);
    await persistIndex();

    return {
        message: nextMessage,
        chat: updated,
    };
}

export async function getChatMessages(chatId) {
    await ensureInitialized();
    return readJsonLines(getChatFilePath(chatId));
}

export async function getRecentMessages(chatId, limit) {
    const messages = await getChatMessages(chatId);
    if (!limit || messages.length <= limit) {
        return messages;
    }

    return messages.slice(messages.length - limit);
}

export async function removeChat(chatId) {
    await ensureInitialized();

    const existing = await getChat(chatId);
    if (!existing) {
        return false;
    }

    state.chats = state.chats.filter((chat) => chat.id !== chatId);
    await persistIndex();

    const chatPath = getChatFilePath(chatId);
    const messages = await readJsonLines(chatPath);
    const uploadIds = new Set();
    for (const message of messages) {
        collectUploadIdsFromParts(message?.parts, uploadIds);
        if (Array.isArray(message?.steps)) {
            for (const step of message.steps) {
                collectUploadIdsFromParts(step?.parts, uploadIds);
            }
        }
    }

    await fs.rm(chatPath, { force: true });
    await deleteUploads([...uploadIds], { allowCommitted: true });
    await removeTodoState(chatId);
    return true;
}

export async function clearChatMessages(chatId) {
    await ensureInitialized();

    const chatIdx = findChatIndex(chatId);
    if (chatIdx === -1) {
        return false;
    }

    const chatPath = getChatFilePath(chatId);
    const messages = await readJsonLines(chatPath);
    const uploadIds = new Set();
    for (const message of messages) {
        collectUploadIdsFromParts(message?.parts, uploadIds);
        if (Array.isArray(message?.steps)) {
            for (const step of message.steps) {
                collectUploadIdsFromParts(step?.parts, uploadIds);
            }
        }
    }

    await rewriteJsonLines(chatPath, []);
    await deleteUploads([...uploadIds], { allowCommitted: true });

    const current = state.chats[chatIdx];
    const updated = {
        ...current,
        messageCount: 0,
        lastMessagePreview: '',
        updatedAt: Date.now(),
    };
    state.chats[chatIdx] = updated;
    state.chats = sortChats(state.chats);
    await persistIndex();

    return true;
}

export async function updateChatTitle(chatId, newTitle) {
    await ensureInitialized();

    const chatIdx = findChatIndex(chatId);
    if (chatIdx === -1) {
        return null;
    }

    const current = state.chats[chatIdx];
    let cleanTitle = String(newTitle ?? '').trim();
    if (current.kind === INBOX_CHAT_KIND) {
        cleanTitle = INBOX_CHAT_TITLE;
    } else if (!cleanTitle) {
        cleanTitle = 'Untitled';
    }
    if (cleanTitle.startsWith('"') && cleanTitle.endsWith('"')) {
        cleanTitle = cleanTitle.slice(1, -1);
    }

    cleanTitle = cleanTitle.split('\n')[0].replace(/\*\*/g, '').trim();

    const updated = {
        ...current,
        title: cleanTitle,
        updatedAt: Date.now(),
    };

    state.chats[chatIdx] = updated;
    state.chats = sortChats(state.chats);
    await persistIndex();

    return updated;
}

export async function updateChatLastConsolidated(chatId, value) {
    await ensureInitialized();

    const chatIdx = findChatIndex(chatId);
    if (chatIdx === -1) return null;

    const current = state.chats[chatIdx];
    const updated = {
        ...current,
        lastConsolidated: Math.trunc(Number(value) || 0),
    };

    state.chats[chatIdx] = updated;
    await persistIndex();
    return updated;
}

export async function ensureInboxChat() {
    await ensureInitialized();

    const existing = state.chats.find((chat) => chat.id === INBOX_CHAT_ID);
    if (existing) {
        const normalized = buildChatRecord(existing);
        const existingFilePath = getChatFilePath(normalized.id);
        try {
            await fs.access(existingFilePath);
        } catch {
            await fs.writeFile(existingFilePath, '', 'utf8');
        }

        if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
            const index = findChatIndex(INBOX_CHAT_ID);
            state.chats[index] = normalized;
            state.chats = sortChats(state.chats);
            await persistIndex();
            return normalized;
        }

        return existing;
    }

    const inboxChat = buildChatRecord({
        id: INBOX_CHAT_ID,
        title: INBOX_CHAT_TITLE,
        agentId: 'orchestrator',
        kind: INBOX_CHAT_KIND,
        pinned: true,
        deletable: false,
    });

    state.chats = sortChats([inboxChat, ...state.chats]);
    await fs.writeFile(getChatFilePath(inboxChat.id), '', 'utf8');
    await persistIndex();
    return inboxChat;
}
