/**
 * HTTP control server for orchestration
 */

import http, { IncomingMessage, Server, ServerResponse } from 'http';
import { AgentRuntime, RuntimeControlAction } from './runtime.js';
import { ControlApiConfig } from './config.js';

interface JsonObject {
    [key: string]: unknown;
}

export interface ControlServer {
    start(): Promise<void>;
    stop(): Promise<void>;
}

function parseBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return null;
}

function asNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return null;
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function parseControlAction(body: JsonObject): RuntimeControlAction {
    const type = asString(body.type).trim();

    if (!type) {
        throw new Error('Missing field: type');
    }

    if (type === 'click') {
        const x = asNumber(body.x);
        const y = asNumber(body.y);
        if (x === null || y === null) {
            throw new Error('Invalid click coordinates. Expected numeric x and y.');
        }

        const countRaw = asNumber(body.count);
        const count = countRaw === null ? 1 : Math.max(1, Math.min(2, Math.floor(countRaw)));
        return { type: 'click', x: Math.round(x), y: Math.round(y), count };
    }

    if (type === 'hover') {
        const x = asNumber(body.x);
        const y = asNumber(body.y);
        if (x === null || y === null) {
            throw new Error('Invalid hover coordinates. Expected numeric x and y.');
        }
        return { type: 'hover', x: Math.round(x), y: Math.round(y) };
    }

    if (type === 'hold') {
        const x = asNumber(body.x);
        const y = asNumber(body.y);
        if (x === null || y === null) {
            throw new Error('Invalid hold coordinates. Expected numeric x and y.');
        }

        const durationRaw = asNumber(body.durationMs);
        const durationMs = durationRaw === null
            ? 1200
            : Math.max(100, Math.min(10000, Math.floor(durationRaw)));

        return { type: 'hold', x: Math.round(x), y: Math.round(y), durationMs };
    }

    if (type === 'scroll') {
        const direction = asString(body.direction).trim().toLowerCase();
        if (direction !== 'up' && direction !== 'down') {
            throw new Error('Invalid scroll direction. Use "up" or "down".');
        }
        return { type: 'scroll', direction };
    }

    if (type === 'type') {
        const text = asString(body.text);
        return { type: 'type', text };
    }

    if (type === 'pressKey') {
        const key = asString(body.key).trim();
        if (!key) {
            throw new Error('Missing field: key');
        }
        return { type: 'pressKey', key };
    }

    if (type === 'navigate') {
        const url = asString(body.url).trim();
        if (!url) {
            throw new Error('Missing field: url');
        }
        return { type: 'navigate', url };
    }

    if (type === 'goBack') {
        return { type: 'goBack' };
    }

    if (type === 'goForward') {
        return { type: 'goForward' };
    }

    if (type === 'reload') {
        return { type: 'reload' };
    }

    if (type === 'clear') {
        return { type: 'clear' };
    }

    throw new Error(`Unsupported control type: ${type}`);
}

export function createControlServer(
    runtime: AgentRuntime,
    config: ControlApiConfig,
    onLog: (message: string) => void = (message) => console.log(message)
): ControlServer {
    let server: Server | null = null;

    const sendJson = (res: ServerResponse, statusCode: number, payload: JsonObject) => {
        const body = JSON.stringify(payload);
        res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
    };

    const sendMethodNotAllowed = (res: ServerResponse) => {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    };

    const ensureAuthorized = (req: IncomingMessage, res: ServerResponse): boolean => {
        if (!config.apiKey) {
            return true;
        }

        const headerApiKey = req.headers['x-api-key'];
        const authHeader = req.headers.authorization;
        const bearerToken = authHeader && authHeader.startsWith('Bearer ')
            ? authHeader.slice('Bearer '.length)
            : null;

        const provided = (Array.isArray(headerApiKey) ? headerApiKey[0] : headerApiKey) || bearerToken;
        if (provided !== config.apiKey) {
            sendJson(res, 401, { ok: false, error: 'Unauthorized' });
            return false;
        }

        return true;
    };

    const readJsonBody = async (req: IncomingMessage): Promise<JsonObject> => {
        const chunks: Buffer[] = [];
        let size = 0;

        for await (const chunk of req) {
            const piece = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            chunks.push(piece);
            size += piece.length;
            if (size > 1024 * 1024) {
                throw new Error('Request body too large');
            }
        }

        if (chunks.length === 0) {
            return {};
        }

        const raw = Buffer.concat(chunks).toString('utf8');
        return JSON.parse(raw) as JsonObject;
    };

    const handler = async (req: IncomingMessage, res: ServerResponse) => {
        try {
            if (!ensureAuthorized(req, res)) {
                return;
            }

            const method = req.method || 'GET';
            const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
            const pathname = requestUrl.pathname;

            if (method === 'GET' && pathname === '/health') {
                sendJson(res, 200, { ok: true });
                return;
            }

            if (method === 'GET' && pathname === '/status') {
                const status = await runtime.getStatus();
                sendJson(res, 200, { ok: true, status });
                return;
            }

            if (pathname === '/open') {
                if (method !== 'POST') {
                    sendMethodNotAllowed(res);
                    return;
                }

                const status = await runtime.getStatus();
                const frame = await runtime.getLatestFrame({ live: true });
                const history = await runtime.getFrameHistory(120);
                sendJson(res, 200, { ok: true, status, frame, history });
                return;
            }

            if (pathname === '/frame') {
                if (method !== 'GET') {
                    sendMethodNotAllowed(res);
                    return;
                }

                const liveFlag = parseBoolean(requestUrl.searchParams.get('live'));
                const frame = await runtime.getLatestFrame({ live: liveFlag === true });
                sendJson(res, 200, { ok: true, frame });
                return;
            }

            if (pathname === '/history') {
                if (method !== 'GET') {
                    sendMethodNotAllowed(res);
                    return;
                }

                const limitRaw = asNumber(requestUrl.searchParams.get('limit'));
                const limit = limitRaw === null
                    ? 120
                    : Math.max(1, Math.min(240, Math.floor(limitRaw)));
                const history = await runtime.getFrameHistory(limit);
                sendJson(res, 200, { ok: true, history });
                return;
            }

            if (pathname === '/manual-control') {
                if (method !== 'POST') {
                    sendMethodNotAllowed(res);
                    return;
                }

                const body = await readJsonBody(req);
                const enabled = parseBoolean(body.enabled);
                if (enabled === null) {
                    sendJson(res, 400, { ok: false, error: 'Missing boolean field: enabled' });
                    return;
                }

                await runtime.setManualControl(enabled);
                const status = await runtime.getStatus();
                sendJson(res, 200, { ok: true, status });
                return;
            }

            if (pathname === '/control') {
                if (method !== 'POST') {
                    sendMethodNotAllowed(res);
                    return;
                }

                const body = await readJsonBody(req);
                const action = parseControlAction(body);
                const result = await runtime.performControl(action);
                const frame = await runtime.getLatestFrame({ live: true });
                const status = await runtime.getStatus();

                sendJson(res, result.ok ? 200 : 400, {
                    ok: result.ok,
                    result,
                    frame,
                    status,
                });
                return;
            }

            if (pathname === '/task') {
                if (method !== 'POST') {
                    sendMethodNotAllowed(res);
                    return;
                }

                const body = await readJsonBody(req);
                const goal = typeof body.goal === 'string' ? body.goal : '';
                if (!goal.trim()) {
                    sendJson(res, 400, { ok: false, error: 'Missing non-empty string field: goal' });
                    return;
                }

                await runtime.submitTask(goal, {
                    cleanContext: typeof body.cleanContext === 'boolean' ? body.cleanContext : undefined,
                    preserveContext: typeof body.preserveContext === 'boolean' ? body.preserveContext : undefined,
                    model: typeof body.model === 'string' ? body.model : undefined,
                    thinkingBudget: typeof body.thinkingBudget === 'number' ? body.thinkingBudget : undefined,
                });

                const status = await runtime.getStatus();
                sendJson(res, 200, { ok: true, status });
                return;
            }

            if (pathname === '/stop') {
                if (method !== 'POST') {
                    sendMethodNotAllowed(res);
                    return;
                }

                runtime.stopTask();
                const status = await runtime.getStatus();
                sendJson(res, 200, { ok: true, status });
                return;
            }

            if (pathname === '/reset') {
                if (method !== 'POST') {
                    sendMethodNotAllowed(res);
                    return;
                }

                const body = await readJsonBody(req);
                await runtime.resetContext({
                    stopRunningTask: typeof body.stopRunningTask === 'boolean' ? body.stopRunningTask : undefined,
                    clearConversationHistory: typeof body.clearConversationHistory === 'boolean' ? body.clearConversationHistory : undefined,
                    clearActionHistory: typeof body.clearActionHistory === 'boolean' ? body.clearActionHistory : undefined,
                    clearClipboard: typeof body.clearClipboard === 'boolean' ? body.clearClipboard : undefined,
                    clearCurrentGoal: typeof body.clearCurrentGoal === 'boolean' ? body.clearCurrentGoal : undefined,
                    clearInterruptFlag: typeof body.clearInterruptFlag === 'boolean' ? body.clearInterruptFlag : undefined,
                    clearMemory: typeof body.clearMemory === 'boolean' ? body.clearMemory : undefined,
                    clearFrameHistory: typeof body.clearFrameHistory === 'boolean' ? body.clearFrameHistory : undefined,
                    navigateToStartup: typeof body.navigateToStartup === 'boolean' ? body.navigateToStartup : undefined,
                });

                const status = await runtime.getStatus();
                sendJson(res, 200, { ok: true, status });
                return;
            }

            if (pathname === '/restart') {
                if (method !== 'POST') {
                    sendMethodNotAllowed(res);
                    return;
                }

                await runtime.restart();
                const status = await runtime.getStatus();
                sendJson(res, 200, { ok: true, status, note: 'Runtime restarted (browser relaunched).' });
                return;
            }

            sendJson(res, 404, { ok: false, error: 'Not found' });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendJson(res, 500, { ok: false, error: message });
        }
    };

    return {
        async start() {
            if (server) {
                return;
            }

            server = http.createServer((req, res) => {
                void handler(req, res);
            });

            await new Promise<void>((resolve, reject) => {
                server?.once('error', reject);
                server?.listen(config.port, config.host, () => resolve());
            });

            onLog(`🌐 Control API listening on http://${config.host}:${config.port}`);
        },

        async stop() {
            if (!server) {
                return;
            }

            await new Promise<void>((resolve, reject) => {
                server?.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });

            server = null;
            onLog('🛑 Control API stopped.');
        },
    };
}
