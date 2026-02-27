const subscribers = new Set();
let sequence = 0;

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
