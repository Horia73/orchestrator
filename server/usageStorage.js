import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_DIR = path.resolve(process.cwd(), 'server', 'data');
const USAGE_LOG_PATH = path.join(DATA_DIR, 'usage.jsonl');

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

function toSafeString(value) {
    if (typeof value === 'string') {
        return value;
    }

    return String(value ?? '');
}

function toSafeTokenCount(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
    }

    return Math.trunc(parsed);
}

function toSafeUsd(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
    }

    return parsed;
}

async function ensureInitialized() {
    if (initialized) {
        return;
    }

    await fs.mkdir(DATA_DIR, { recursive: true });

    try {
        await fs.access(USAGE_LOG_PATH);
    } catch {
        await fs.writeFile(USAGE_LOG_PATH, '', 'utf8');
    }

    initialized = true;
}

async function appendLine(filePath, payload) {
    await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function readUsageRecords() {
    await ensureInitialized();

    try {
        const raw = await fs.readFile(USAGE_LOG_PATH, 'utf8');
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
                // Ignore malformed lines to keep the log resilient.
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

function summarizeUsageRecords(records) {
    const totals = {
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        thoughtsTokens: 0,
        toolUsePromptTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        pricedRequestCount: 0,
        unpricedRequestCount: 0,
    };

    const modelMap = new Map();

    for (const record of records) {
        totals.requestCount += 1;
        totals.inputTokens += toSafeTokenCount(record.inputTokens);
        totals.outputTokens += toSafeTokenCount(record.outputTokens);
        totals.thoughtsTokens += toSafeTokenCount(record.thoughtsTokens);
        totals.toolUsePromptTokens += toSafeTokenCount(record.toolUsePromptTokens);
        totals.totalTokens += toSafeTokenCount(record.totalTokens);
        totals.totalCostUsd += toSafeUsd(record.totalCostUsd);

        const priced = record.priced === true;
        if (priced) {
            totals.pricedRequestCount += 1;
        } else {
            totals.unpricedRequestCount += 1;
        }

        const model = toSafeString(record.model || 'unknown-model');
        const current = modelMap.get(model) ?? {
            model,
            requestCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            thoughtsTokens: 0,
            toolUsePromptTokens: 0,
            totalTokens: 0,
            totalCostUsd: 0,
            pricedRequestCount: 0,
            unpricedRequestCount: 0,
        };

        current.requestCount += 1;
        current.inputTokens += toSafeTokenCount(record.inputTokens);
        current.outputTokens += toSafeTokenCount(record.outputTokens);
        current.thoughtsTokens += toSafeTokenCount(record.thoughtsTokens);
        current.toolUsePromptTokens += toSafeTokenCount(record.toolUsePromptTokens);
        current.totalTokens += toSafeTokenCount(record.totalTokens);
        current.totalCostUsd += toSafeUsd(record.totalCostUsd);

        if (priced) {
            current.pricedRequestCount += 1;
        } else {
            current.unpricedRequestCount += 1;
        }

        modelMap.set(model, current);
    }

    const byModel = [...modelMap.values()].sort((a, b) => {
        const byCost = b.totalCostUsd - a.totalCostUsd;
        if (byCost !== 0) return byCost;

        const byCount = b.requestCount - a.requestCount;
        if (byCount !== 0) return byCount;

        return a.model.localeCompare(b.model);
    });

    return {
        totals,
        byModel,
    };
}

export async function initUsageStorage() {
    await ensureInitialized();
}

export async function appendUsageRecord(payload = {}) {
    await ensureInitialized();

    const createdAtCandidate = Number(payload.createdAt);
    const createdAt = Number.isFinite(createdAtCandidate) && createdAtCandidate > 0
        ? Math.trunc(createdAtCandidate)
        : Date.now();

    const dateKey = normalizeDateKey(payload.dateKey ?? toDateKeyFromTimestamp(createdAt));

    const record = {
        id: toSafeString(payload.id || `request-${randomUUID()}`),
        chatId: toSafeString(payload.chatId),
        clientId: toSafeString(payload.clientId),
        model: toSafeString(payload.model || 'unknown-model'),
        status: toSafeString(payload.status || 'completed'),
        inputText: toSafeString(payload.inputText),
        outputText: toSafeString(payload.outputText),
        createdAt,
        dateKey,
        inputTokens: toSafeTokenCount(payload.inputTokens),
        outputTokens: toSafeTokenCount(payload.outputTokens),
        thoughtsTokens: toSafeTokenCount(payload.thoughtsTokens),
        toolUsePromptTokens: toSafeTokenCount(payload.toolUsePromptTokens),
        totalTokens: toSafeTokenCount(payload.totalTokens),
        priced: payload.priced === true,
        inputCostUsd: toSafeUsd(payload.inputCostUsd),
        outputCostUsd: toSafeUsd(payload.outputCostUsd),
        totalCostUsd: toSafeUsd(payload.totalCostUsd),
    };

    if (payload.usageMetadata && typeof payload.usageMetadata === 'object') {
        record.usageMetadata = payload.usageMetadata;
    }

    await appendLine(USAGE_LOG_PATH, record);
    return record;
}

export async function getUsageSnapshotByDate(dateKeyInput) {
    const date = normalizeDateKey(dateKeyInput);
    return getUsageSnapshotByRange({
        startDate: date,
        endDate: date,
    });
}

export async function getUsageSnapshotByRange(input = {}) {
    const startCandidate = normalizeDateKey(input.startDate ?? input.date);
    const endCandidate = normalizeDateKey(input.endDate ?? input.date ?? startCandidate);
    const startDate = startCandidate <= endCandidate ? startCandidate : endCandidate;
    const endDate = startCandidate <= endCandidate ? endCandidate : startCandidate;

    const records = await readUsageRecords();
    const requests = records
        .filter((record) => {
            const dateKey = String(record?.dateKey ?? '');
            return dateKey >= startDate && dateKey <= endDate;
        })
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

    const summary = summarizeUsageRecords(requests);

    return {
        date: startDate === endDate ? startDate : null,
        startDate,
        endDate,
        requests,
        ...summary,
    };
}

export { getTodayDateKey };
