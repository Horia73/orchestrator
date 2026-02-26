import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = path.resolve(process.cwd(), 'server', 'data');
const LOGS_PATH = path.join(DATA_DIR, 'logs.jsonl');
const MAX_STRING_LENGTH = 4000;

let initialized = false;

function pad2(value) {
    return String(value).padStart(2, '0');
}

function toDateKeyFromTimestamp(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function getTodayDateKey() {
    return toDateKeyFromTimestamp(Date.now());
}

function isValidDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeDateKey(value) {
    const raw = String(value ?? '').trim();
    if (isValidDateKey(raw)) {
        return raw;
    }

    return getTodayDateKey();
}

function toSafeString(value, fallback = '') {
    const raw = String(value ?? fallback);
    if (raw.length <= MAX_STRING_LENGTH) {
        return raw;
    }

    return `${raw.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
}

function sanitizeData(value, depth = 0) {
    if (value === null || value === undefined) {
        return value;
    }

    if (depth >= 3) {
        return '[max-depth]';
    }

    if (typeof value === 'string') {
        return toSafeString(value);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }

    if (Array.isArray(value)) {
        return value.slice(0, 50).map((item) => sanitizeData(item, depth + 1));
    }

    if (typeof value === 'object') {
        const output = {};
        const entries = Object.entries(value).slice(0, 50);
        for (const [key, item] of entries) {
            output[key] = sanitizeData(item, depth + 1);
        }
        return output;
    }

    return toSafeString(value);
}

async function ensureInitialized() {
    if (initialized) {
        return;
    }

    await fs.mkdir(DATA_DIR, { recursive: true });

    try {
        await fs.access(LOGS_PATH);
    } catch {
        await fs.writeFile(LOGS_PATH, '', 'utf8');
    }

    initialized = true;
}

async function appendLine(filePath, payload) {
    await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function readLogRecords() {
    await ensureInitialized();

    try {
        const raw = await fs.readFile(LOGS_PATH, 'utf8');
        if (!raw.trim()) {
            return [];
        }

        const records = [];
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed && typeof parsed === 'object') {
                    records.push(parsed);
                }
            } catch {
                // Ignore malformed line.
            }
        }

        return records;
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return [];
        }

        throw error;
    }
}

export async function initLogStorage() {
    await ensureInitialized();
}

export async function appendSystemLog(payload = {}) {
    await ensureInitialized();

    const createdAtCandidate = Number(payload.createdAt);
    const createdAt = Number.isFinite(createdAtCandidate) && createdAtCandidate > 0
        ? Math.trunc(createdAtCandidate)
        : Date.now();

    const dateKey = normalizeDateKey(payload.dateKey ?? toDateKeyFromTimestamp(createdAt));
    const level = toSafeString(payload.level || 'info', 'info').toLowerCase();
    const source = toSafeString(payload.source || 'system', 'system');
    const eventType = toSafeString(payload.eventType || 'event', 'event');
    const message = toSafeString(payload.message || eventType, eventType);

    const record = {
        id: toSafeString(payload.id || `log-${randomUUID()}`),
        level: level === 'error' || level === 'warn' ? level : 'info',
        source,
        eventType,
        message,
        createdAt,
        dateKey,
    };

    if (payload.data !== undefined) {
        record.data = sanitizeData(payload.data);
    }

    await appendLine(LOGS_PATH, record);
    return record;
}

export async function getLogsSnapshot(input = {}) {
    const startCandidate = normalizeDateKey(input.startDate ?? input.date);
    const endCandidate = normalizeDateKey(input.endDate ?? input.date ?? startCandidate);
    const startDate = startCandidate <= endCandidate ? startCandidate : endCandidate;
    const endDate = startCandidate <= endCandidate ? endCandidate : startCandidate;

    const limitCandidate = Number(input.limit);
    const limit = Number.isFinite(limitCandidate) && limitCandidate > 0
        ? Math.min(Math.trunc(limitCandidate), 2000)
        : 400;

    const levelFilterRaw = String(input.level ?? '').trim().toLowerCase();
    const levelFilter = levelFilterRaw === 'info' || levelFilterRaw === 'warn' || levelFilterRaw === 'error'
        ? levelFilterRaw
        : null;

    const records = await readLogRecords();
    const logs = records
        .filter((record) => {
            const dateKey = String(record?.dateKey ?? '');
            if (dateKey < startDate || dateKey > endDate) {
                return false;
            }

            if (levelFilter && String(record?.level ?? '') !== levelFilter) {
                return false;
            }

            return true;
        })
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
        .slice(0, limit);

    const totals = {
        totalCount: logs.length,
        infoCount: 0,
        warnCount: 0,
        errorCount: 0,
    };

    for (const log of logs) {
        const level = String(log?.level ?? '').toLowerCase();
        if (level === 'error') {
            totals.errorCount += 1;
        } else if (level === 'warn') {
            totals.warnCount += 1;
        } else {
            totals.infoCount += 1;
        }
    }

    return {
        date: startDate === endDate ? startDate : null,
        startDate,
        endDate,
        limit,
        level: levelFilter,
        totals,
        logs,
    };
}
