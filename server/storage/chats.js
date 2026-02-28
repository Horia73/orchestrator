import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeAgentId } from './settings.js';
import {
    CHAT_DATA_DIR,
    CHAT_INDEX_PATH,
    CHAT_MESSAGES_DIR,
} from '../core/dataPaths.js';
const CHATS_DIR = CHAT_MESSAGES_DIR;
const INDEX_PATH = CHAT_INDEX_PATH;

const DEFAULT_INDEX = {
    version: 2,
    chats: [],
};

let initialized = false;
let state = { ...DEFAULT_INDEX };

function createChatId() {
    return `chat-${randomUUID()}`;
}

function createMessageId() {
    return `msg-${randomUUID()}`;
}

function sortChats(chats) {
    return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
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

            const createdAt = Number(rawChat.createdAt);
            const updatedAt = Number(rawChat.updatedAt);
            const messageCount = Number(rawChat.messageCount);
            const normalizedChat = {
                id,
                title: String(rawChat.title ?? 'Untitled'),
                createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
                updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
                messageCount: Number.isFinite(messageCount) && messageCount >= 0
                    ? Math.trunc(messageCount)
                    : 0,
                lastMessagePreview: String(rawChat.lastMessagePreview ?? ''),
                agentId: normalizeAgentId(rawChat.agentId),
            };

            if (String(rawChat.agentId ?? '').trim().toLowerCase() !== normalizedChat.agentId) {
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

    state.chats = sortChats(state.chats);
    initialized = true;
}

async function appendLine(filePath, payload) {
    await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
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
    return sortChats(state.chats);
}

export async function getChat(chatId) {
    await ensureInitialized();
    return state.chats.find((chat) => chat.id === chatId) ?? null;
}

export async function createChatFromFirstMessage(firstMessageText, options = {}) {
    await ensureInitialized();
    const now = Date.now();

    const chat = {
        id: createChatId(),
        title: 'Untitled',
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        lastMessagePreview: '',
        agentId: normalizeAgentId(options?.agentId),
    };

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

    if (normalizedParts) {
        message.parts = normalizedParts;
    }

    if (normalizedSteps) {
        message.steps = normalizedSteps;
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
    await fs.rm(chatPath, { force: true });
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
    if (!cleanTitle) cleanTitle = 'Untitled';
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
