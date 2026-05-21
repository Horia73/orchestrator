import { randomBytes } from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { WebSocketServer, type WebSocket } from 'ws';

import type { BrowserLiveViewState } from './display';

interface StartLinuxVncDisplayOptions {
    viewport: { width: number; height: number };
    previousState: BrowserLiveViewState;
    onLog?: (message: string) => void;
}

export interface LinuxVncDisplayHandle {
    close(): Promise<void>;
}

export interface LinuxVncDisplayStartResult {
    state: BrowserLiveViewState;
    handle: LinuxVncDisplayHandle | null;
}

const DEFAULT_WS_PORT = 6080;
const DEFAULT_DISPLAY_START = 90;
const DEFAULT_DISPLAY_END = 200;

export async function startLinuxVncDisplay(options: StartLinuxVncDisplayOptions): Promise<LinuxVncDisplayStartResult> {
    const runtime = new LinuxVncDisplayRuntime(options);
    const state = await runtime.start();
    return { state, handle: state.ready ? runtime : null };
}

class LinuxVncDisplayRuntime implements LinuxVncDisplayHandle {
    private xvnc: ChildProcess | null = null;
    private windowManager: ChildProcess | null = null;
    private proxyRoute: VncProxyRoute | null = null;
    private displayLockPath: string | null = null;

    constructor(private readonly options: StartLinuxVncDisplayOptions) {}

    async start(): Promise<BrowserLiveViewState> {
        const xvncBin = findExecutable([
            process.env.BROWSER_AGENT_XVNC_BIN,
            'Xvnc',
            'Xtigervnc',
        ]);

        if (!xvncBin) {
            return {
                ...this.options.previousState,
                available: false,
                ready: false,
                reason: 'Xvnc/TigerVNC is not installed. Install tigervnc-standalone-server in the Linux container.',
            };
        }

        const displayAllocation = acquireDisplayAllocation();
        this.displayLockPath = displayAllocation.lockPath;
        const displayNumber = displayAllocation.displayNumber;
        const display = `:${displayNumber}`;
        const vncHost = '127.0.0.1';
        const vncPort = intEnv('BROWSER_AGENT_VNC_PORT', 5900 + displayNumber);
        const wsHost = process.env.BROWSER_AGENT_VNC_WS_HOST || '127.0.0.1';
        const wsPort = intEnv('BROWSER_AGENT_VNC_WS_PORT', DEFAULT_WS_PORT);
        const configuredWsToken = process.env.BROWSER_AGENT_VNC_WS_TOKEN;
        const wsToken = configuredWsToken
            ? `${configuredWsToken}.${randomBytes(9).toString('base64url')}`
            : randomBytes(18).toString('base64url');
        const runtimeDir = process.env.XDG_RUNTIME_DIR || `/tmp/browser-agent-runtime-${process.getuid?.() ?? 'user'}`;
        try {
            fs.mkdirSync(/* turbopackIgnore: true */ runtimeDir, { recursive: true, mode: 0o700 });
        } catch {}

        const geometry = `${this.options.viewport.width}x${this.options.viewport.height}`;
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

        this.log(`🖥️ Starting virtual browser display ${display} (${geometry})...`);
        this.xvnc = spawn(xvncBin, xvncArgs, {
            env: {
                ...process.env,
                XDG_RUNTIME_DIR: runtimeDir,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        pipeProcessLogs(this.xvnc, this.options.onLog, 'Xvnc');

        const ready = await waitForTcp(vncHost, vncPort, 8_000);
        if (!ready) {
            await this.close();
            return {
                ...this.options.previousState,
                available: false,
                ready: false,
                reason: `Xvnc did not open ${vncHost}:${vncPort}. Check VNC server arguments and container packages.`,
            };
        }

        try {
            this.windowManager = await startWindowManager(display, this.options.onLog);
        } catch (error) {
            this.log(`⚠️ Window manager unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }

        const proxy = await VncWebSocketProxy.forEndpoint({
            listenHost: wsHost,
            listenPort: wsPort,
            onLog: this.options.onLog,
        });
        try {
            this.proxyRoute = proxy.registerRoute({
                token: wsToken,
                targetHost: vncHost,
                targetPort: vncPort,
            });
        } catch (error) {
            const reason = `VNC WebSocket proxy could not listen on ${wsHost}:${wsPort}: ${formatDisplayError(error)}`;
            this.log(`⚠️ ${reason}`);
            await this.close();
            return {
                ...this.options.previousState,
                available: false,
                ready: false,
                reason,
            };
        }

        return {
            enabled: true,
            available: true,
            ready: true,
            mode: 'linux-vnc',
            platform: process.platform,
            display,
            width: this.options.viewport.width,
            height: this.options.viewport.height,
            vncHost,
            vncPort,
            wsHost,
            wsPort,
            wsToken,
        };
    }

    async close(): Promise<void> {
        await this.proxyRoute?.close();
        this.proxyRoute = null;
        await closeProcess(this.windowManager);
        this.windowManager = null;
        await closeProcess(this.xvnc);
        this.xvnc = null;
        releaseDisplayLock(this.displayLockPath);
        this.displayLockPath = null;
    }

    private log(message: string): void {
        this.options.onLog?.(message);
    }
}

function findExecutable(candidates: Array<string | undefined>): string | null {
    for (const candidate of candidates) {
        if (!candidate) continue;
        if (candidate.includes(path.sep) && fs.existsSync(/* turbopackIgnore: true */ candidate)) return candidate;
        const found = spawnSync('sh', ['-lc', `command -v ${shellQuote(candidate)}`], { encoding: 'utf8' });
        const value = found.stdout.trim();
        if (found.status === 0 && value) return value;
    }
    return null;
}

function acquireDisplayAllocation(): { displayNumber: number; lockPath: string } {
    const configured = intEnv('BROWSER_AGENT_DISPLAY', 0);
    if (configured > 0) {
        return {
            displayNumber: configured,
            lockPath: acquireDisplayLock(configured),
        };
    }

    for (let display = DEFAULT_DISPLAY_START; display <= DEFAULT_DISPLAY_END; display++) {
        if (
            !fs.existsSync(/* turbopackIgnore: true */ `/tmp/.X${display}-lock`) &&
            !fs.existsSync(/* turbopackIgnore: true */ `/tmp/.X11-unix/X${display}`)
        ) {
            const lockPath = tryAcquireDisplayLock(display);
            if (lockPath) {
                return { displayNumber: display, lockPath };
            }
        }
    }

    for (let attempt = 0; attempt < 100; attempt++) {
        const display = DEFAULT_DISPLAY_END + 1 + Math.floor(Math.random() * 400);
        if (
            fs.existsSync(/* turbopackIgnore: true */ `/tmp/.X${display}-lock`) ||
            fs.existsSync(/* turbopackIgnore: true */ `/tmp/.X11-unix/X${display}`)
        ) {
            continue;
        }
        const lockPath = tryAcquireDisplayLock(display);
        if (lockPath) {
            return { displayNumber: display, lockPath };
        }
    }

    throw new Error(`No free browser display could be reserved in :${DEFAULT_DISPLAY_START}-:${DEFAULT_DISPLAY_END}.`);
}

function acquireDisplayLock(display: number): string {
    const lockPath = tryAcquireDisplayLock(display);
    if (!lockPath) {
        throw new Error(`Browser display :${display} is already reserved.`);
    }
    return lockPath;
}

function tryAcquireDisplayLock(display: number): string | null {
    const lockPath = `/tmp/browser-agent-display-${display}.lock`;
    removeStaleDisplayLock(lockPath);

    try {
        const fd = fs.openSync(/* turbopackIgnore: true */ lockPath, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
        } finally {
            fs.closeSync(fd);
        }
        return lockPath;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            return null;
        }
        throw error;
    }
}

function removeStaleDisplayLock(lockPath: string): void {
    let raw = '';
    try {
        raw = fs.readFileSync(/* turbopackIgnore: true */ lockPath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        return;
    }

    const pid = Number(raw.split(/\s+/)[0]);
    if (Number.isFinite(pid) && pid > 0 && processIsAlive(pid)) {
        return;
    }

    try {
        fs.unlinkSync(/* turbopackIgnore: true */ lockPath);
    } catch {}
}

function releaseDisplayLock(lockPath: string | null): void {
    if (!lockPath) return;
    try {
        const raw = fs.readFileSync(/* turbopackIgnore: true */ lockPath, 'utf8');
        const pid = Number(raw.split(/\s+/)[0]);
        if (pid && pid !== process.pid) return;
    } catch {}
    try {
        fs.unlinkSync(/* turbopackIgnore: true */ lockPath);
    } catch {}
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
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

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            cleanup();
            resolve(false);
        }, timeoutMs);
        timer.unref?.();
        const onExit = () => {
            cleanup();
            resolve(true);
        };
        const cleanup = () => {
            clearTimeout(timer);
            proc.off('exit', onExit);
            proc.off('close', onExit);
        };
        proc.once('exit', onExit);
        proc.once('close', onExit);
    });
}

async function closeProcess(proc: ChildProcess | null) {
    if (!proc || proc.exitCode !== null || proc.killed) return;
    try {
        proc.kill('SIGTERM');
    } catch {
        return;
    }
    const exited = await waitForExit(proc, 750);
    if (!exited && proc.exitCode === null) {
        try { proc.kill('SIGKILL'); } catch {}
        await waitForExit(proc, 1_000);
    }
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatDisplayError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

interface VncProxyRoute {
    close(): Promise<void>;
}

interface VncRouteTarget {
    targetHost: string;
    targetPort: number;
}

const vncProxyServers = new Map<string, Promise<VncWebSocketProxy>>();

class VncWebSocketProxy {
    private server: WebSocketServer | null = null;
    private heartbeat: NodeJS.Timeout | null = null;
    private routes = new Map<string, VncRouteTarget>();
    private closePromise: Promise<void> | null = null;

    constructor(private readonly options: {
        endpointKey: string;
        listenHost: string;
        listenPort: number;
        onLog?: (message: string) => void;
    }) {}

    static async forEndpoint(options: {
        listenHost: string;
        listenPort: number;
        onLog?: (message: string) => void;
    }): Promise<VncWebSocketProxy> {
        const key = `${options.listenHost}:${options.listenPort}`;
        let existing = vncProxyServers.get(key);
        if (!existing) {
            existing = (async () => {
                const proxy = new VncWebSocketProxy({
                    ...options,
                    endpointKey: key,
                });
                await proxy.start();
                return proxy;
            })();
            vncProxyServers.set(key, existing);
            existing.catch(() => {
                vncProxyServers.delete(key);
            });
        }
        return existing;
    }

    async start(): Promise<void> {
        if (this.server) return;

        this.server = new WebSocketServer({
            host: this.options.listenHost,
            port: this.options.listenPort,
        });

        this.server.on('connection', (ws, request) => {
            const target = this.resolveTarget(request.url || '');
            if (!target) {
                ws.close(1008, 'Unauthorized');
                return;
            }
            this.attach(ws, target);
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

    registerRoute(options: { token: string; targetHost: string; targetPort: number }): VncProxyRoute {
        this.routes.set(options.token, {
            targetHost: options.targetHost,
            targetPort: options.targetPort,
        });
        return {
            close: async () => {
                this.routes.delete(options.token);
                await this.closeIfIdle();
            },
        };
    }

    private async closeIfIdle(): Promise<void> {
        if (this.routes.size > 0 || !this.server) return;
        if (this.closePromise) {
            await this.closePromise;
            return;
        }

        const server = this.server;
        this.closePromise = new Promise<void>((resolve) => {
            if (this.heartbeat) {
                clearInterval(this.heartbeat);
                this.heartbeat = null;
            }

            for (const client of server.clients) {
                try { client.terminate(); } catch {}
            }

            server.close(() => resolve());
        }).finally(() => {
            if (this.server === server) {
                this.server = null;
            }
            this.closePromise = null;
            vncProxyServers.delete(this.options.endpointKey);
            this.options.onLog?.(`🔌 VNC WebSocket proxy stopped on ${this.options.listenHost}:${this.options.listenPort}.`);
        });

        await this.closePromise;
    }

    private resolveTarget(url: string): VncRouteTarget | null {
        try {
            const parsed = new URL(url, 'ws://localhost');
            const candidates = [
                ...parsed.pathname.split('/').filter(Boolean),
                parsed.searchParams.get('token') || '',
            ].filter(Boolean);
            for (const token of candidates) {
                const target = this.routes.get(token);
                if (target) return target;
            }
            return null;
        } catch {
            return null;
        }
    }

    private attach(ws: WebSocket, target: VncRouteTarget): void {
        const socket = net.createConnection({
            host: target.targetHost,
            port: target.targetPort,
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
