import { randomBytes } from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { WebSocketServer, type WebSocket } from 'ws';

export type BrowserLiveViewMode = 'disabled' | 'mac-headful' | 'linux-vnc';

export interface BrowserLiveViewState {
    enabled: boolean;
    available: boolean;
    ready: boolean;
    mode: BrowserLiveViewMode;
    platform: NodeJS.Platform;
    display?: string;
    width?: number;
    height?: number;
    vncHost?: string;
    vncPort?: number;
    wsHost?: string;
    wsPort?: number;
    wsToken?: string;
    reason?: string;
}

export interface BrowserDisplayController {
    ensureStarted(): Promise<BrowserLiveViewState>;
    getState(): BrowserLiveViewState;
    close(): Promise<void>;
}

interface BrowserDisplayControllerOptions {
    enabled: boolean;
    viewport: { width: number; height: number };
    onLog?: (message: string) => void;
}

const DEFAULT_WS_PORT = 6080;
const DEFAULT_DISPLAY_START = 90;
const DEFAULT_DISPLAY_END = 110;

export function createBrowserDisplayController(options: BrowserDisplayControllerOptions): BrowserDisplayController {
    let state: BrowserLiveViewState = {
        enabled: options.enabled,
        available: false,
        ready: false,
        mode: options.enabled
            ? process.platform === 'darwin'
                ? 'mac-headful'
                : process.platform === 'linux'
                    ? 'linux-vnc'
                    : 'disabled'
            : 'disabled',
        platform: process.platform,
        width: options.viewport.width,
        height: options.viewport.height,
        reason: options.enabled ? undefined : 'Live view is disabled.',
    };

    let startPromise: Promise<BrowserLiveViewState> | null = null;
    let xvnc: ChildProcess | null = null;
    let windowManager: ChildProcess | null = null;
    let proxy: VncWebSocketProxy | null = null;

    const log = (message: string) => options.onLog?.(message);

    const closeProcess = async (proc: ChildProcess | null) => {
        if (!proc || proc.exitCode !== null || proc.killed) return;
        try {
            proc.kill('SIGTERM');
        } catch {
            return;
        }
        await sleep(250);
        if (proc.exitCode === null && !proc.killed) {
            try { proc.kill('SIGKILL'); } catch {}
        }
    };

    const startLinuxVnc = async (): Promise<BrowserLiveViewState> => {
        const xvncBin = findExecutable([
            process.env.BROWSER_AGENT_XVNC_BIN,
            'Xvnc',
            'Xtigervnc',
        ]);

        if (!xvncBin) {
            return {
                ...state,
                available: false,
                ready: false,
                reason: 'Xvnc/TigerVNC is not installed. Install tigervnc-standalone-server in the Linux container.',
            };
        }

        const displayNumber = selectDisplayNumber();
        const display = `:${displayNumber}`;
        const vncHost = '127.0.0.1';
        const vncPort = intEnv('BROWSER_AGENT_VNC_PORT', 5900 + displayNumber);
        const wsHost = process.env.BROWSER_AGENT_VNC_WS_HOST || '127.0.0.1';
        const wsPort = intEnv('BROWSER_AGENT_VNC_WS_PORT', DEFAULT_WS_PORT);
        const wsToken = process.env.BROWSER_AGENT_VNC_WS_TOKEN || randomBytes(18).toString('base64url');
        const runtimeDir = process.env.XDG_RUNTIME_DIR || `/tmp/browser-agent-runtime-${process.getuid?.() ?? 'user'}`;
        try {
            fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
        } catch {}

        const geometry = `${options.viewport.width}x${options.viewport.height}`;
        const xvncArgs = [
            display,
            '-geometry', geometry,
            '-depth', '24',
            '-rfbport', String(vncPort),
            '-localhost',
            '-SecurityTypes', 'None',
            '-AlwaysShared',
            '-DisconnectClients=0',
        ];

        log(`🖥️ Starting virtual browser display ${display} (${geometry})...`);
        xvnc = spawn(xvncBin, xvncArgs, {
            env: {
                ...process.env,
                XDG_RUNTIME_DIR: runtimeDir,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        pipeProcessLogs(xvnc, log, 'Xvnc');

        const ready = await waitForTcp(vncHost, vncPort, 8_000);
        if (!ready) {
            await closeProcess(xvnc);
            xvnc = null;
            return {
                ...state,
                available: false,
                ready: false,
                reason: `Xvnc did not open ${vncHost}:${vncPort}. Check VNC server arguments and container packages.`,
            };
        }

        startWindowManager(display, log).then(proc => {
            windowManager = proc;
        }).catch(error => {
            log(`⚠️ Window manager unavailable: ${error instanceof Error ? error.message : String(error)}`);
        });

        proxy = new VncWebSocketProxy({
            listenHost: wsHost,
            listenPort: wsPort,
            targetHost: vncHost,
            targetPort: vncPort,
            token: wsToken,
            onLog: log,
        });
        await proxy.start();

        return {
            enabled: true,
            available: true,
            ready: true,
            mode: 'linux-vnc',
            platform: process.platform,
            display,
            width: options.viewport.width,
            height: options.viewport.height,
            vncHost,
            vncPort,
            wsHost,
            wsPort,
            wsToken,
        };
    };

    const controller: BrowserDisplayController = {
        async ensureStarted() {
            if (!options.enabled) return state;
            if (state.ready || state.mode === 'mac-headful') {
                state = {
                    ...state,
                    available: state.mode === 'mac-headful' || state.available,
                    ready: state.mode === 'mac-headful' || state.ready,
                    reason: state.mode === 'mac-headful' ? 'Patchright is running in a local headful browser window.' : state.reason,
                };
                return state;
            }
            if (process.platform !== 'linux') return state;
            if (startPromise) return startPromise;
            startPromise = startLinuxVnc()
                .then(next => {
                    state = next;
                    return state;
                })
                .finally(() => {
                    startPromise = null;
                });
            return startPromise;
        },

        getState() {
            return { ...state };
        },

        async close() {
            await proxy?.close();
            proxy = null;
            await closeProcess(windowManager);
            windowManager = null;
            await closeProcess(xvnc);
            xvnc = null;
            state = {
                ...state,
                available: state.mode === 'mac-headful',
                ready: state.mode === 'mac-headful',
                reason: state.mode === 'mac-headful' ? state.reason : 'Live view stopped.',
            };
        },
    };

    return controller;
}

function findExecutable(candidates: Array<string | undefined>): string | null {
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (candidate.includes(path.sep) && fs.existsSync(candidate)) return candidate;
        const found = spawnSync('sh', ['-lc', `command -v ${shellQuote(candidate)}`], { encoding: 'utf8' });
        const value = found.stdout.trim();
        if (found.status === 0 && value) return value;
    }
    return null;
}

function selectDisplayNumber(): number {
    const configured = intEnv('BROWSER_AGENT_DISPLAY', 0);
    if (configured > 0) return configured;

    for (let display = DEFAULT_DISPLAY_START; display <= DEFAULT_DISPLAY_END; display++) {
        if (!fs.existsSync(`/tmp/.X${display}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${display}`)) {
            return display;
        }
    }
    return DEFAULT_DISPLAY_START + Math.floor(Math.random() * 100);
}

async function startWindowManager(
    display: string,
    log: ((message: string) => void) | undefined,
): Promise<ChildProcess | null> {
    const wm = findExecutable([
        process.env.BROWSER_AGENT_WINDOW_MANAGER_BIN,
        'openbox',
        'fluxbox',
        'matchbox-window-manager',
    ]);
    if (!wm) {
        log?.('⚠️ No lightweight window manager found; Chromium will still run on the virtual display.');
        return null;
    }

    const args = path.basename(wm).includes('openbox') ? ['--sm-disable'] : [];
    const proc = spawn(wm, args, {
        env: { ...process.env, DISPLAY: display },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipeProcessLogs(proc, log, 'wm');
    log?.(`🪟 Window manager started on ${display}.`);
    return proc;
}

function pipeProcessLogs(
    proc: ChildProcess,
    log: ((message: string) => void) | undefined,
    label: string,
) {
    const write = (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text) log?.(`[${label}] ${text}`);
    };
    proc.stdout?.on('data', write);
    proc.stderr?.on('data', write);
}

function intEnv(name: string, fallback: number): number {
    const value = process.env[name];
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function waitForTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    return new Promise(resolve => {
        const attempt = () => {
            const socket = net.createConnection({ host, port });
            let settled = false;
            const done = (ok: boolean) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                if (ok) {
                    resolve(true);
                    return;
                }
                if (Date.now() - startedAt >= timeoutMs) {
                    resolve(false);
                    return;
                }
                setTimeout(attempt, 150);
            };
            socket.once('connect', () => done(true));
            socket.once('error', () => done(false));
            socket.setTimeout(500, () => done(false));
        };
        attempt();
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

class VncWebSocketProxy {
    private server: WebSocketServer | null = null;
    private heartbeat: NodeJS.Timeout | null = null;

    constructor(private readonly options: {
        listenHost: string;
        listenPort: number;
        targetHost: string;
        targetPort: number;
        token: string;
        onLog?: (message: string) => void;
    }) {}

    async start(): Promise<void> {
        if (this.server) return;

        this.server = new WebSocketServer({
            host: this.options.listenHost,
            port: this.options.listenPort,
        });

        this.server.on('connection', (ws, request) => {
            if (!this.isAuthorized(request.url || '')) {
                ws.close(1008, 'Unauthorized');
                return;
            }
            this.attach(ws);
        });
        this.server.on('error', error => {
            this.options.onLog?.(`⚠️ VNC WebSocket proxy error: ${error.message}`);
        });

        await new Promise<void>((resolve, reject) => {
            const server = this.server;
            if (!server) return reject(new Error('VNC WebSocket proxy was not created.'));
            server.once('listening', () => resolve());
            server.once('error', reject);
        });

        this.heartbeat = setInterval(() => {
            for (const client of this.server?.clients ?? []) {
                if (client.readyState === client.OPEN) {
                    try { client.ping(); } catch {}
                }
            }
        }, 15_000);
        this.heartbeat.unref?.();

        this.options.onLog?.(`🔌 VNC WebSocket proxy listening on ${this.options.listenHost}:${this.options.listenPort}.`);
    }

    async close(): Promise<void> {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        const server = this.server;
        this.server = null;
        if (!server) return;
        for (const client of server.clients) {
            try { client.close(1001, 'Proxy shutting down.'); } catch {}
        }
        await new Promise<void>(resolve => server.close(() => resolve()));
    }

    private isAuthorized(url: string): boolean {
        try {
            const parsed = new URL(url, 'ws://localhost');
            return parsed.pathname.split('/').filter(Boolean).includes(this.options.token)
                || parsed.searchParams.get('token') === this.options.token;
        } catch {
            return false;
        }
    }

    private attach(ws: WebSocket): void {
        const socket = net.createConnection({
            host: this.options.targetHost,
            port: this.options.targetPort,
            noDelay: true,
        });

        socket.on('data', chunk => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(chunk, { binary: true }, () => {});
        });
        socket.on('error', error => {
            this.options.onLog?.(`⚠️ VNC TCP proxy error: ${error.message}`);
            try { ws.close(1011, 'VNC target error.'); } catch {}
        });
        socket.on('close', () => {
            try { ws.close(1000, 'VNC target closed.'); } catch {}
        });

        ws.on('message', data => {
            if (!socket.writable) return;
            if (Buffer.isBuffer(data)) {
                socket.write(data);
            } else if (Array.isArray(data)) {
                socket.write(Buffer.concat(data));
            } else if (data instanceof ArrayBuffer) {
                socket.write(Buffer.from(data));
            } else {
                socket.write(Buffer.from(String(data), 'binary'));
            }
        });
        ws.on('close', () => socket.destroy());
        ws.on('error', () => socket.destroy());
    }
}
