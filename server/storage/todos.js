import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TODO_DATA_DIR } from '../core/dataPaths.js';

const TODO_TITLE_FALLBACK = 'Current plan';
const VALID_ITEM_STATUSES = new Set(['pending', 'in_progress', 'completed', 'blocked']);

function getTodoFilePath(chatId) {
    return path.join(TODO_DATA_DIR, `${chatId}.json`);
}

function normalizeTodoItem(rawItem, index) {
    if (!rawItem || typeof rawItem !== 'object') {
        return null;
    }

    const id = String(rawItem.id ?? `item-${index + 1}`).trim() || `item-${index + 1}`;
    const label = String(
        rawItem.label
        ?? rawItem.text
        ?? rawItem.title
        ?? '',
    ).trim();

    if (!label) {
        return null;
    }

    const normalizedStatus = String(rawItem.status ?? '').trim().toLowerCase();
    const status = VALID_ITEM_STATUSES.has(normalizedStatus)
        ? normalizedStatus
        : 'pending';

    const details = String(rawItem.details ?? rawItem.note ?? '').trim();

    return {
        id,
        label,
        status,
        ...(details ? { details } : {}),
    };
}

function buildTodoSummary(items) {
    const safeItems = Array.isArray(items) ? items : [];
    const counts = {
        pending: 0,
        in_progress: 0,
        completed: 0,
        blocked: 0,
    };

    for (const item of safeItems) {
        if (counts[item.status] !== undefined) {
            counts[item.status] += 1;
        }
    }

    return counts;
}

function normalizeTodoState(rawState, { fallbackTitle = TODO_TITLE_FALLBACK } = {}) {
    const safeState = rawState && typeof rawState === 'object' ? rawState : {};
    const items = Array.isArray(safeState.items)
        ? safeState.items.map(normalizeTodoItem).filter(Boolean)
        : [];
    const summary = buildTodoSummary(items);
    const updatedAt = Number(safeState.updatedAt);

    return {
        title: String(safeState.title ?? fallbackTitle).trim() || fallbackTitle,
        items,
        itemCount: items.length,
        summary,
        updatedAt: Number.isFinite(updatedAt) && updatedAt > 0
            ? updatedAt
            : Date.now(),
    };
}

async function ensureTodoDir() {
    await fs.mkdir(TODO_DATA_DIR, { recursive: true });
}

async function readJson(filePath) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

async function writeJsonAtomic(filePath, payload) {
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await fs.rename(tempPath, filePath);
}

export async function getTodoState(chatId, options = {}) {
    const normalizedChatId = String(chatId ?? '').trim();
    if (!normalizedChatId) {
        throw new Error('chatId is required.');
    }

    const filePath = getTodoFilePath(normalizedChatId);
    const payload = await readJson(filePath);
    if (!payload) {
        return normalizeTodoState(null, options);
    }

    return normalizeTodoState(payload, options);
}

export async function replaceTodoState(chatId, nextState, options = {}) {
    const normalizedChatId = String(chatId ?? '').trim();
    if (!normalizedChatId) {
        throw new Error('chatId is required.');
    }

    await ensureTodoDir();
    const normalizedState = normalizeTodoState(nextState, options);
    await writeJsonAtomic(getTodoFilePath(normalizedChatId), normalizedState);
    return normalizedState;
}

export async function clearTodoState(chatId, options = {}) {
    const normalizedChatId = String(chatId ?? '').trim();
    if (!normalizedChatId) {
        throw new Error('chatId is required.');
    }

    await ensureTodoDir();
    await fs.rm(getTodoFilePath(normalizedChatId), { force: true });
    return normalizeTodoState(null, options);
}

export async function removeTodoState(chatId) {
    const normalizedChatId = String(chatId ?? '').trim();
    if (!normalizedChatId) {
        return false;
    }

    await fs.rm(getTodoFilePath(normalizedChatId), { force: true });
    return true;
}
