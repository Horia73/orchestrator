import net from 'node:net';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const REMOTE_DESKTOP_WIDTH = 1920;
const REMOTE_DESKTOP_HEIGHT = 1080;
const XVFB_BINARY = process.env.BROWSER_AGENT_XVFB_PATH || 'Xvfb';
const X11VNC_BINARY = process.env.BROWSER_AGENT_X11VNC_PATH || 'x11vnc';
const REMOTE_DESKTOP_START_TIMEOUT_MS = 10_000;

const vncUpgradeServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
});

function sanitizeText(value) {
    return String(value ?? '').trim();
}

function buildRemoteDesktopWebSocketPath(sessionId) {
    return `/api/browser-agent/sessions/${encodeURIComponent(sanitizeText(sessionId))}/vnc/ws`;
}

function waitForStreamLine(stream, timeoutMs = REMOTE_DESKTOP_START_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        let settled = false;
        let timeoutId = null;

        const cleanup = () => {
            settled = true;
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }
            stream.off('data', handleData);
            stream.off('error', handleError);
            stream.off('close', handleClose);
        };

        const handleError = (error) => {
            if (settled) {
                return;
            }
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        const handleClose = () => {
            if (settled) {
                return;
            }
            cleanup();
            reject(new Error('The process stream closed before a ready signal was received.'));
        };

        const handleData = (chunk) => {
            if (settled) {
                return;
            }
            buffer += String(chunk ?? '');
            const newlineIndex = buffer.indexOf('\n');
            if (newlineIndex < 0) {
                return;
            }

            const line = buffer.slice(0, newlineIndex).trim();
            cleanup();
            resolve(line);
        };

        timeoutId = setTimeout(() => {
            if (settled) {
                return;
            }
            cleanup();
            reject(new Error('Timed out waiting for the process to become ready.'));
        }, timeoutMs);

        stream.on('data', handleData);
        stream.on('error', handleError);
        stream.on('close', handleClose);
    });
}

function waitForProcessExit(child, timeoutMs = 3_000) {
    return new Promise((resolve) => {
        if (!child || child.exitCode !== null || child.killed) {
            resolve();
            return;
        }

        let settled = false;
        let timeoutId = null;

        const cleanup = () => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }
            child.off('exit', handleExit);
            child.off('close', handleExit);
            resolve();
        };

        const handleExit = () => {
            cleanup();
        };

        child.once('exit', handleExit);
        child.once('close', handleExit);
        timeoutId = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
                // ignore forced shutdown errors
            }
            cleanup();
        }, timeoutMs);
    });
}

function waitForTcpPort(port, timeoutMs = REMOTE_DESKTOP_START_TIMEOUT_MS) {
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
        const attempt = () => {
            const socket = net.createConnection({ host: '127.0.0.1', port });
            const finish = (error = null) => {
                socket.removeAllListeners();
                socket.destroy();
                if (!error) {
                    resolve();
                    return;
                }
                if (Date.now() - startedAt >= timeoutMs) {
                    reject(error);
                    return;
                }
                setTimeout(attempt, 100);
            };

            socket.once('connect', () => finish());
            socket.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
        };

        attempt();
    });
}

function getAvailableTcpPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(port);
            });
        });
    });
}

function createUnavailableRemoteDesktop(reason) {
    return {
        enabled: false,
        available: false,
        mode: 'novnc',
        platform: process.platform,
        status: 'unavailable',
        reason: sanitizeText(reason),
        width: REMOTE_DESKTOP_WIDTH,
        height: REMOTE_DESKTOP_HEIGHT,
        directKeyboard: true,
        directPointer: true,
    };
}

function attachChildLifecycle(remoteDesktop, child, label) {
    child.once('exit', (code, signal) => {
        if (remoteDesktop.closed) {
            return;
        }
        remoteDesktop.available = false;
        remoteDesktop.status = 'error';
        remoteDesktop.reason = `${label} exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}.`;
    });
}

async function spawnXvfb() {
    const child = spawn(XVFB_BINARY, [
        '-screen',
        '0',
        `${REMOTE_DESKTOP_WIDTH}x${REMOTE_DESKTOP_HEIGHT}x24`,
        '-nolisten',
        'tcp',
        '-ac',
        '-displayfd',
        '1',
    ], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stderrChunks = [];
    child.stderr?.on('data', (chunk) => {
        stderrChunks.push(String(chunk ?? ''));
    });

    try {
        const displayNumberLine = await waitForStreamLine(child.stdout);
        const displayNumber = Number(displayNumberLine);
        if (!Number.isFinite(displayNumber)) {
            throw new Error(`Xvfb returned an invalid display number: ${displayNumberLine}`);
        }

        return {
            child,
            display: `:${displayNumber}`,
        };
    } catch (error) {
        try {
            child.kill('SIGTERM');
        } catch {
            // ignore shutdown failures
        }
        await waitForProcessExit(child);
        const stderrText = stderrChunks.join('').trim();
        if (stderrText) {
            throw new Error(stderrText);
        }
        throw error;
    }
}

export function supportsLinuxRemoteDesktop() {
    if (process.platform !== 'linux') {
        return false;
    }

    const disabled = sanitizeText(process.env.BROWSER_AGENT_DISABLE_LINUX_REMOTE_DESKTOP).toLowerCase();
    return disabled !== '1' && disabled !== 'true' && disabled !== 'yes';
}

export async function createLinuxRemoteDesktop(sessionId) {
    if (!supportsLinuxRemoteDesktop()) {
        return createUnavailableRemoteDesktop('Linux remote desktop is not enabled on this host.');
    }

    let xvfb = null;
    let x11vnc = null;

    try {
        xvfb = await spawnXvfb();
        const vncPort = await getAvailableTcpPort();
        x11vnc = spawn(X11VNC_BINARY, [
            '-display',
            xvfb.display,
            '-rfbport',
            String(vncPort),
            '-localhost',
            '-forever',
            '-shared',
            '-noxdamage',
            '-xkb',
            '-repeat',
            '-nopw',
            '-wait',
            '5',
            '-defer',
            '5',
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        await waitForTcpPort(vncPort);

        const remoteDesktop = {
            enabled: true,
            available: true,
            mode: 'novnc',
            platform: 'linux',
            status: 'ready',
            reason: '',
            sessionId: sanitizeText(sessionId),
            display: xvfb.display,
            width: REMOTE_DESKTOP_WIDTH,
            height: REMOTE_DESKTOP_HEIGHT,
            vncPort,
            websocketPath: buildRemoteDesktopWebSocketPath(sessionId),
            env: {
                DISPLAY: xvfb.display,
            },
            directKeyboard: true,
            directPointer: true,
            closed: false,
            processes: {
                xvfb: xvfb.child,
                x11vnc,
            },
            async close() {
                if (remoteDesktop.closed) {
                    return;
                }
                remoteDesktop.closed = true;
                remoteDesktop.available = false;
                remoteDesktop.status = 'closed';

                try {
                    x11vnc.kill('SIGTERM');
                } catch {
                    // ignore shutdown failures
                }
                await waitForProcessExit(x11vnc);

                try {
                    xvfb.child.kill('SIGTERM');
                } catch {
                    // ignore shutdown failures
                }
                await waitForProcessExit(xvfb.child);
            },
        };

        attachChildLifecycle(remoteDesktop, xvfb.child, 'Xvfb');
        attachChildLifecycle(remoteDesktop, x11vnc, 'x11vnc');
        return remoteDesktop;
    } catch (error) {
        if (x11vnc) {
            try {
                x11vnc.kill('SIGTERM');
            } catch {
                // ignore shutdown failures
            }
            await waitForProcessExit(x11vnc);
        }
        if (xvfb?.child) {
            try {
                xvfb.child.kill('SIGTERM');
            } catch {
                // ignore shutdown failures
            }
            await waitForProcessExit(xvfb.child);
        }

        const message = error instanceof Error ? error.message : String(error);
        return createUnavailableRemoteDesktop(message || 'Failed to start Linux remote desktop.');
    }
}

export function buildRemoteDesktopState(remoteDesktop) {
    if (!remoteDesktop || typeof remoteDesktop !== 'object') {
        return createUnavailableRemoteDesktop('Remote desktop is unavailable.');
    }

    return {
        enabled: remoteDesktop.enabled === true,
        available: remoteDesktop.available === true,
        mode: sanitizeText(remoteDesktop.mode) || 'novnc',
        platform: sanitizeText(remoteDesktop.platform) || process.platform,
        status: sanitizeText(remoteDesktop.status) || 'unknown',
        reason: sanitizeText(remoteDesktop.reason) || undefined,
        width: Number(remoteDesktop.width) || REMOTE_DESKTOP_WIDTH,
        height: Number(remoteDesktop.height) || REMOTE_DESKTOP_HEIGHT,
        websocketPath: sanitizeText(remoteDesktop.websocketPath) || undefined,
        directKeyboard: remoteDesktop.directKeyboard !== false,
        directPointer: remoteDesktop.directPointer !== false,
    };
}

export function getRemoteDesktopUpgradeTarget(urlValue) {
    const requestUrl = new URL(urlValue, 'http://localhost');
    const pathname = requestUrl.pathname;
    const match = pathname.match(/^\/api\/browser-agent\/sessions\/([^/]+)\/vnc\/ws$/);
    if (!match) {
        return null;
    }

    return {
        sessionId: decodeURIComponent(match[1]),
        chatId: sanitizeText(requestUrl.searchParams.get('chatId')),
    };
}

export function proxyRemoteDesktopUpgrade({ req, socket, head, remoteDesktop }) {
    return new Promise((resolve, reject) => {
        vncUpgradeServer.handleUpgrade(req, socket, head, (ws) => {
            const tcpSocket = net.createConnection({
                host: '127.0.0.1',
                port: Number(remoteDesktop.vncPort),
            });
            let settled = false;

            const cleanup = () => {
                tcpSocket.removeAllListeners();
                try {
                    tcpSocket.destroy();
                } catch {
                    // ignore cleanup failures
                }
                ws.removeAllListeners();
                try {
                    ws.close();
                } catch {
                    // ignore cleanup failures
                }
            };

            settled = true;
            resolve(true);
            tcpSocket.on('data', (chunk) => {
                if (ws.readyState === ws.OPEN) {
                    ws.send(chunk, { binary: true }, () => undefined);
                }
            });
            tcpSocket.on('error', (error) => {
                if (!settled) {
                    settled = true;
                    reject(error instanceof Error ? error : new Error(String(error)));
                    return;
                }
                if (ws.readyState === ws.OPEN) {
                    ws.close(1011, error instanceof Error ? error.message.slice(0, 120) : 'VNC bridge failed.');
                }
            });
            tcpSocket.on('close', () => {
                if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
                    ws.close();
                }
            });

            ws.on('message', (data, isBinary) => {
                if (!tcpSocket.writable) {
                    return;
                }
                tcpSocket.write(isBinary ? data : Buffer.from(String(data)));
            });
            ws.on('close', cleanup);
            ws.on('error', cleanup);
        });
    });
}
