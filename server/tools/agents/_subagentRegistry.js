const subagentRegistry = new Map();

function normalizeId(value) {
    return String(value ?? '').trim();
}

function cloneRecord(record) {
    return record ? { ...record } : null;
}

export function isSubagentId(value) {
    return normalizeId(value).startsWith('subagent-');
}

export function registerSubagent(record) {
    const subagentId = normalizeId(record?.subagentId);
    if (!subagentId) {
        return null;
    }

    const now = Date.now();
    const normalized = {
        subagentId,
        chatId: normalizeId(record?.chatId),
        clientId: normalizeId(record?.clientId),
        ownerId: normalizeId(record?.ownerId),
        parentMessageId: normalizeId(record?.parentMessageId),
        parentToolCallId: normalizeId(record?.parentToolCallId),
        parentSubagentId: normalizeId(record?.parentSubagentId),
        parentAgentId: normalizeId(record?.parentAgentId),
        agentId: normalizeId(record?.agentId) || 'multipurpose',
        task: String(record?.task ?? '').trim(),
        context: String(record?.context ?? '').trim(),
        status: String(record?.status ?? 'spawned').trim().toLowerCase() || 'spawned',
        spawnDepth: Number(record?.spawnDepth) > 0 ? Math.trunc(Number(record.spawnDepth)) : 0,
        createdAt: Number(record?.createdAt) > 0 ? Math.trunc(Number(record.createdAt)) : now,
        updatedAt: Number(record?.updatedAt) > 0 ? Math.trunc(Number(record.updatedAt)) : now,
    };

    subagentRegistry.set(subagentId, normalized);
    return cloneRecord(normalized);
}

export function updateSubagent(subagentId, patch = {}) {
    const normalizedId = normalizeId(subagentId);
    if (!normalizedId) {
        return null;
    }

    const existing = subagentRegistry.get(normalizedId);
    if (!existing) {
        return null;
    }

    const next = {
        ...existing,
        ...patch,
        subagentId: normalizedId,
        updatedAt: Number(patch?.updatedAt) > 0 ? Math.trunc(Number(patch.updatedAt)) : Date.now(),
    };

    subagentRegistry.set(normalizedId, next);
    return cloneRecord(next);
}

export function getSubagent(subagentId) {
    return cloneRecord(subagentRegistry.get(normalizeId(subagentId)) ?? null);
}

export function countSubagentsByOwnerId(ownerId) {
    const normalizedOwnerId = normalizeId(ownerId);
    if (!normalizedOwnerId) {
        return 0;
    }

    let count = 0;
    for (const record of subagentRegistry.values()) {
        if (normalizeId(record?.ownerId) === normalizedOwnerId) {
            count += 1;
        }
    }

    return count;
}

export function countActiveSubagentsByOwnerId(ownerId) {
    const normalizedOwnerId = normalizeId(ownerId);
    if (!normalizedOwnerId) {
        return 0;
    }

    let count = 0;
    for (const record of subagentRegistry.values()) {
        const status = String(record?.status ?? '').trim().toLowerCase();
        if (
            normalizeId(record?.ownerId) === normalizedOwnerId
            && (status === 'queued' || status === 'running' || status === 'thinking' || status === 'working')
        ) {
            count += 1;
        }
    }

    return count;
}
