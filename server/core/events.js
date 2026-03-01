const subscribers = new Set();
let sequence = 0;

/**
 * Snapshot of the latest streaming state per chatId for recovery on reconnect.
 * Each entry: { message, agentStreaming: { [toolName]: payload }, updatedAt }
 */
const streamingSnapshots = new Map();

export function updateStreamingSnapshot(chatId, { message, agentToolName, agentPayload } = {}) {
    if (!chatId) return;
    const snapshot = streamingSnapshots.get(chatId) ?? { message: null, agentStreaming: {}, updatedAt: 0 };
    if (message) snapshot.message = message;
    if (agentToolName && agentPayload) snapshot.agentStreaming[agentToolName] = agentPayload;
    snapshot.updatedAt = Date.now();
    streamingSnapshots.set(chatId, snapshot);
}

export function getStreamingSnapshot(chatId) {
    return streamingSnapshots.get(chatId) ?? null;
}

export function clearStreamingSnapshot(chatId) {
    streamingSnapshots.delete(chatId);
}

function writeEvent(res, payload) {
    res.write(`id: ${payload.id}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function openEventsStream(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    subscribers.add(res);
    writeEvent(res, {
        id: ++sequence,
        type: 'system.connected',
        createdAt: Date.now(),
    });

    const keepAlive = setInterval(() => {
        res.write(': keep-alive\n\n');
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        subscribers.delete(res);
    });
}

export function broadcastEvent(type, payload = {}) {
    const event = {
        id: ++sequence,
        type,
        createdAt: Date.now(),
        ...payload,
    };

    for (const res of subscribers) {
        writeEvent(res, event);
    }

    return event;
}
