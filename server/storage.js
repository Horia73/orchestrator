import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = path.resolve(process.cwd(), 'server', 'data');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');

const DEFAULT_INDEX = {
    version: 1,
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

function truncateForTitle(text) {
    const cleaned = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return 'Untitled';
    if (cleaned.length <= 48) return cleaned;
    return `${cleaned.slice(0, 47).trimEnd()}…`;
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

    await fs.mkdir(CHATS_DIR, { recursive: true });

    try {
        const raw = await fs.readFile(INDEX_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        state = {
            version: 1,
            chats: Array.isArray(parsed?.chats) ? parsed.chats : [],
        };
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

export async function createChatFromFirstMessage(firstMessageText) {
    await ensureInitialized();
    const now = Date.now();

    const chat = {
        id: createChatId(),
        title: truncateForTitle(firstMessageText),
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        lastMessagePreview: '',
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
    const nextTitle = current.messageCount === 0 && message.role === 'user'
        ? truncateForTitle(message.text)
        : current.title;
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
