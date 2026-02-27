import { stat } from 'node:fs/promises';
import { clampInteger, sleep } from '../_utils.js';
import {
    COMMAND_DEFAULT_WAIT_BEFORE_ASYNC_MS,
    COMMAND_MAX_WAIT_BEFORE_ASYNC_MS,
    resolveCommandWorkingDirectory,
    startCommandSession,
    createCommandSnapshot,
} from './_sessions.js';

export const declaration = {
    name: 'run_command',
    description: 'Run a shell command in the workspace and return a live command session snapshot.',
    parameters: {
        type: 'OBJECT',
        properties: {
            CommandLine: {
                type: 'STRING',
                description: 'Command to execute in a shell.',
            },
            Cwd: {
                type: 'STRING',
                description: 'Optional working directory (absolute or relative to workspace).',
            },
            WaitMsBeforeAsync: {
                type: 'INTEGER',
                description: 'Optional milliseconds to wait before returning while command may continue in background.',
            },
            SafeToAutoRun: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
            waitForPreviousTools: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
        },
        required: ['CommandLine'],
    },
};

export async function execute({
    CommandLine,
    Cwd,
    WaitMsBeforeAsync = COMMAND_DEFAULT_WAIT_BEFORE_ASYNC_MS,
}) {
    const commandLine = String(CommandLine ?? '').trim();
    if (!commandLine) {
        return { error: 'CommandLine is required.' };
    }

    const cwd = resolveCommandWorkingDirectory(Cwd);
    try {
        const cwdStats = await stat(cwd);
        if (!cwdStats.isDirectory()) {
            return { error: `Cwd is not a directory: ${cwd}` };
        }
    } catch (error) {
        return { error: `Invalid Cwd ${cwd}: ${error.message}` };
    }

    let session;
    try {
        session = startCommandSession(commandLine, cwd);
    } catch (error) {
        return { error: `Failed to start command: ${error.message}` };
    }

    const waitMs = clampInteger(
        WaitMsBeforeAsync,
        COMMAND_DEFAULT_WAIT_BEFORE_ASYNC_MS,
        0,
        COMMAND_MAX_WAIT_BEFORE_ASYNC_MS,
    );

    if (waitMs > 0) {
        await Promise.race([session.donePromise, sleep(waitMs)]);
    }

    return createCommandSnapshot(session);
}
