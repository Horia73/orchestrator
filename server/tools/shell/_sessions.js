import pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { normalizeInteger, clampInteger, sleep } from '../_utils.js';
import { broadcastEvent } from '../../core/events.js';

export const COMMAND_SESSIONS_MAX = 80;
export const COMMAND_OUTPUT_MAX_CHARS = 240_000;
export const COMMAND_OUTPUT_DEFAULT_CHARS = 12_000;
export const COMMAND_DEFAULT_WAIT_BEFORE_ASYNC_MS = 600;
export const COMMAND_MAX_WAIT_BEFORE_ASYNC_MS = 15_000;
export const COMMAND_MAX_WAIT_STATUS_SECONDS = 30;
const COMMAND_STATUS_POLL_MS = 120;

const SIGNAL_MAP = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 9: 'SIGKILL', 15: 'SIGTERM' };

export const commandSessions = new Map();

export function resolveCommandWorkingDirectory(cwdValue) {
    const raw = String(cwdValue ?? '').trim();
    if (!raw) return process.cwd();
    if (isAbsolute(raw)) return raw;
    return resolve(process.cwd(), raw);
}

export function normalizeOutputCharacterCount(value) {
    return clampInteger(value, COMMAND_OUTPUT_DEFAULT_CHARS, 0, COMMAND_OUTPUT_MAX_CHARS);
}

export function normalizeWaitDurationSeconds(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.min(COMMAND_MAX_WAIT_STATUS_SECONDS, Math.max(0, parsed));
}

export function trimOutputTail(value, maxChars = COMMAND_OUTPUT_DEFAULT_CHARS) {
    const text = String(value ?? '');
    if (maxChars <= 0) return '';
    if (text.length <= maxChars) return text;
    return text.slice(text.length - maxChars);
}

export function appendCommandOutput(session, chunk) {
    if (!session) return;
    const text = Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk ?? '');
    if (!text) return;

    session.output += text;
    session.outputCharsTotal += text.length;
    session.lastOutputAt = Date.now();

    if (session.output.length > COMMAND_OUTPUT_MAX_CHARS) {
        const trimChars = session.output.length - COMMAND_OUTPUT_MAX_CHARS;
        session.output = session.output.slice(trimChars);
        session.outputTruncated = true;
    }
}

export function markCommandFinished(session, { status, code = null, signal = null, errorMessage = null }) {
    if (!session || session.status !== 'running') return;

    session.status = status;
    session.exitCode = Number.isInteger(code) ? code : null;
    session.signal = typeof signal === 'string' && signal ? signal : null;
    session.endedAt = Date.now();
    session.endedAtIso = new Date(session.endedAt).toISOString();
    session.process = null;

    if (errorMessage) {
        appendCommandOutput(session, `\n[error] ${errorMessage}\n`);
    }
}

export function pruneCommandSessions() {
    if (commandSessions.size <= COMMAND_SESSIONS_MAX) return;

    const candidates = [...commandSessions.values()]
        .sort((a, b) => a.createdAt - b.createdAt);

    for (const session of candidates) {
        if (commandSessions.size <= COMMAND_SESSIONS_MAX) break;
        if (session.status === 'running') continue;
        commandSessions.delete(session.id);
    }

    if (commandSessions.size <= COMMAND_SESSIONS_MAX) return;

    for (const session of candidates) {
        if (commandSessions.size <= COMMAND_SESSIONS_MAX) break;
        if (session.status === 'running') continue;
        commandSessions.delete(session.id);
    }
}

export function createCommandSnapshot(session, { outputCharacterCount = COMMAND_OUTPUT_DEFAULT_CHARS } = {}) {
    if (!session) {
        return { error: 'Unknown command session.' };
    }

    const outputLimit = normalizeOutputCharacterCount(outputCharacterCount);
    const now = Date.now();
    const endTime = session.endedAt ?? now;
    const durationMs = Math.max(0, endTime - session.startedAt);

    return {
        commandId: session.id,
        name: session.name,
        command: session.command,
        cwd: session.cwd,
        pid: session.pid,
        status: session.status,
        running: session.status === 'running',
        startedAt: session.startedAtIso,
        endedAt: session.endedAtIso,
        durationMs,
        durationSeconds: Math.floor(durationMs / 1000),
        exitCode: session.exitCode,
        signal: session.signal,
        output: trimOutputTail(session.output, outputLimit),
        outputCharsVisible: Math.min(outputLimit, session.output.length),
        outputCharsTotal: session.outputCharsTotal,
        outputTruncated: session.outputTruncated,
    };
}

export function getSessionByNameOrPid({ Name, ProcessID }) {
    const processId = normalizeInteger(ProcessID, NaN);
    if (Number.isInteger(processId) && processId > 0) {
        for (const session of commandSessions.values()) {
            if (session.pid === processId) return session;
        }
    }

    const requestedName = String(Name ?? '').trim().toLowerCase();
    if (requestedName) {
        const matches = [...commandSessions.values()]
            .filter((session) => session.name.toLowerCase().includes(requestedName))
            .sort((a, b) => b.startedAt - a.startedAt);
        if (matches.length > 0) return matches[0];
    }

    return null;
}

export async function waitForCommandChange(session, waitDurationSeconds, previousOutputCharsTotal) {
    const maxWaitMs = Math.floor(normalizeWaitDurationSeconds(waitDurationSeconds) * 1000);
    if (!session || maxWaitMs <= 0) return;

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        if (session.status !== 'running') return;
        if (session.outputCharsTotal !== previousOutputCharsTotal) return;
        await sleep(COMMAND_STATUS_POLL_MS);
    }
}

function createCommandName(commandLine) {
    const text = String(commandLine ?? '').trim();
    if (!text) return 'command';

    const firstToken = text.split(/\s+/)[0];
    if (!firstToken) return 'command';

    return firstToken;
}

export function startCommandSession(commandLine, cwd) {
    const now = Date.now();
    const commandId = `cmd_${randomUUID()}`;
    const name = createCommandName(commandLine);

    const ptyProcess = pty.spawn('/bin/zsh', ['-lc', commandLine], {
        name: 'xterm-256color',
        cols: 220,
        rows: 50,
        cwd,
        env: {
            ...process.env,
            TERM: 'xterm-256color',
            PAGER: 'cat',
        },
    });

    const session = {
        id: commandId,
        name,
        command: commandLine,
        cwd,
        pid: ptyProcess.pid ?? null,
        status: 'running',
        startedAt: now,
        startedAtIso: new Date(now).toISOString(),
        endedAt: null,
        endedAtIso: null,
        exitCode: null,
        signal: null,
        output: '',
        outputCharsTotal: 0,
        outputTruncated: false,
        lastOutputAt: now,
        process: ptyProcess,
        donePromise: null,
    };

    commandSessions.set(commandId, session);
    pruneCommandSessions();

    ptyProcess.on('data', (chunk) => {
        appendCommandOutput(session, chunk);
        broadcastEvent('command.output', { commandId, chunk });
    });

    session.donePromise = new Promise((resolvePromise) => {
        ptyProcess.on('exit', (code, signal) => {
            if (session.status === 'running') {
                const signalName = signal > 0 ? (SIGNAL_MAP[signal] ?? `SIG${signal}`) : null;
                const status = signalName ? 'terminated' : (code === 0 ? 'completed' : 'failed');
                markCommandFinished(session, {
                    status,
                    code: signalName ? null : code,
                    signal: signalName,
                });
            }
            resolvePromise();
        });
    });

    return session;
}

export async function getCommandStatusSnapshot({
    commandId,
    waitDurationSeconds = 0,
    outputCharacterCount = COMMAND_OUTPUT_DEFAULT_CHARS,
}) {
    const normalizedId = String(commandId ?? '').trim();
    if (!normalizedId) {
        return { error: 'CommandId is required.' };
    }

    const session = commandSessions.get(normalizedId);
    if (!session) {
        return { error: `Unknown command id: ${normalizedId}` };
    }

    const previousOutputCharsTotal = session.outputCharsTotal;
    await waitForCommandChange(session, waitDurationSeconds, previousOutputCharsTotal);
    return createCommandSnapshot(session, { outputCharacterCount });
}
