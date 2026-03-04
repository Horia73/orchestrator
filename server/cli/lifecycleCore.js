import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_LOG_PATH, APP_RUNTIME_PATH, RUNTIME_DATA_DIR } from '../core/dataPaths.js';
import { reloadConfigJson } from '../core/config.js';

const DEFAULT_API_PORT = 8787;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_CHECK_TIMEOUT_MS = 2_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_ENTRY_PATH = path.join(PROJECT_ROOT, 'server', 'index.js');
const DIST_INDEX_PATH = path.join(PROJECT_ROOT, 'dist', 'index.html');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPositiveInteger(value, fallback) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
    }

    return fallback;
}

function ensureRuntimeDirectories() {
    fs.mkdirSync(RUNTIME_DATA_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(APP_LOG_PATH), { recursive: true });
}

function getNpmInvocation() {
    const npmExecPath = String(process.env.npm_execpath ?? '').trim();
    if (npmExecPath) {
        return {
            command: process.execPath,
            args: [npmExecPath],
        };
    }

    return {
        command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        args: [],
    };
}

export function getProjectRoot() {
    return PROJECT_ROOT;
}

export function getDistIndexPath() {
    return DIST_INDEX_PATH;
}

export function isBuildReady() {
    return fs.existsSync(DIST_INDEX_PATH);
}

export function getConfiguredPort() {
    const shellPort = toPositiveInteger(process.env.API_PORT, null);
    if (shellPort) {
        return shellPort;
    }

    const configPort = toPositiveInteger(reloadConfigJson()?.port, null);
    if (configPort) {
        return configPort;
    }

    return DEFAULT_API_PORT;
}

export function getAppUrl(port = getConfiguredPort()) {
    return `http://localhost:${port}`;
}

export function readAppRuntimeState() {
    try {
        if (!fs.existsSync(APP_RUNTIME_PATH)) {
            return null;
        }

        return JSON.parse(fs.readFileSync(APP_RUNTIME_PATH, 'utf8'));
    } catch {
        return null;
    }
}

export function writeAppRuntimeState(state) {
    ensureRuntimeDirectories();
    fs.writeFileSync(APP_RUNTIME_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function clearAppRuntimeState() {
    try {
        fs.rmSync(APP_RUNTIME_PATH, { force: true });
    } catch {
        // Ignore cleanup failures.
    }
}

export function isProcessAlive(pid) {
    const normalizedPid = toPositiveInteger(pid, null);
    if (!normalizedPid) {
        return false;
    }

    try {
        process.kill(normalizedPid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

export async function waitForProcessExit(pid, timeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
    const normalizedPid = toPositiveInteger(pid, null);
    if (!normalizedPid) {
        return true;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(normalizedPid)) {
            return true;
        }
        await sleep(HEALTH_POLL_INTERVAL_MS);
    }

    return !isProcessAlive(normalizedPid);
}

export async function probeAppHealth(port = getConfiguredPort()) {
    try {
        const response = await fetch(`${getAppUrl(port)}/api/health`, {
            signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        });
        if (!response.ok) {
            return false;
        }

        const payload = await response.json().catch(() => null);
        return payload?.ok === true;
    } catch {
        return false;
    }
}

export async function waitForAppHealth(port = getConfiguredPort(), timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await probeAppHealth(port)) {
            return true;
        }

        await sleep(HEALTH_POLL_INTERVAL_MS);
    }

    return probeAppHealth(port);
}

export function buildAppRuntimeState(pid, port = getConfiguredPort()) {
    return {
        pid,
        port,
        appUrl: getAppUrl(port),
        logPath: APP_LOG_PATH,
        cwd: PROJECT_ROOT,
        startedAt: new Date().toISOString(),
    };
}

export function spawnDetachedAppProcess() {
    ensureRuntimeDirectories();
    fs.appendFileSync(APP_LOG_PATH, `\n[${new Date().toISOString()}] Starting Orchestrator background server\n`, 'utf8');
    const logFd = fs.openSync(APP_LOG_PATH, 'a');

    try {
        const child = spawn(process.execPath, [SERVER_ENTRY_PATH], {
            cwd: PROJECT_ROOT,
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: {
                ...process.env,
            },
        });

        child.unref();
        return child;
    } finally {
        fs.closeSync(logFd);
    }
}

export function getAppLogTail(lineCount = 40) {
    try {
        if (!fs.existsSync(APP_LOG_PATH)) {
            return '';
        }

        const content = fs.readFileSync(APP_LOG_PATH, 'utf8');
        return content
            .trimEnd()
            .split(/\r?\n/)
            .slice(-Math.max(1, Math.trunc(lineCount)))
            .join('\n');
    } catch {
        return '';
    }
}

export function runNpmScript(scriptName, { stdio = 'inherit', extraArgs = [] } = {}) {
    const normalizedScriptName = String(scriptName ?? '').trim();
    if (!normalizedScriptName) {
        return Promise.reject(new Error('An npm script name is required.'));
    }

    const { command, args } = getNpmInvocation();
    const npmArgs = [...args, 'run', normalizedScriptName];
    if (Array.isArray(extraArgs) && extraArgs.length > 0) {
        npmArgs.push('--', ...extraArgs.map((value) => String(value)));
    }

    return new Promise((resolve, reject) => {
        const child = spawn(command, npmArgs, {
            cwd: PROJECT_ROOT,
            stdio,
            env: {
                ...process.env,
            },
        });

        child.on('error', reject);
        child.on('exit', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }

            const reason = signal
                ? `npm run ${normalizedScriptName} exited with signal ${signal}.`
                : `npm run ${normalizedScriptName} exited with code ${code}.`;
            reject(new Error(reason));
        });
    });
}
