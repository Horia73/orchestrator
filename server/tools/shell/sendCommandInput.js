import { normalizeBoolean, clampInteger } from '../_utils.js';
import { commandSessions, waitForCommandChange, appendCommandOutput, createCommandSnapshot } from './_sessions.js';

export const declaration = {
    name: 'send_command_input',
    description: 'Send stdin input to a running command session or request termination.',
    parameters: {
        type: 'OBJECT',
        properties: {
            CommandId: {
                type: 'STRING',
                description: 'Command session id returned by run_command.',
            },
            Input: {
                type: 'STRING',
                description: 'Optional input text to write to stdin.',
            },
            Terminate: {
                type: 'BOOLEAN',
                description: 'If true, send SIGINT to the command process.',
            },
            WaitMs: {
                type: 'INTEGER',
                description: 'Optional wait in milliseconds before returning updated status.',
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
        required: ['CommandId'],
    },
};

export async function execute({
    CommandId,
    Input,
    Terminate = false,
    WaitMs = 0,
}) {
    const normalizedId = String(CommandId ?? '').trim();
    if (!normalizedId) {
        return { error: 'CommandId is required.' };
    }

    const session = commandSessions.get(normalizedId);
    if (!session) {
        return { error: `Unknown command id: ${normalizedId}` };
    }

    const input = String(Input ?? '');
    const terminate = normalizeBoolean(Terminate, false);
    const waitMs = clampInteger(WaitMs, 0, 0, 10_000);

    if (session.status !== 'running') {
        return createCommandSnapshot(session);
    }

    if (input && session.process) {
        try {
            session.process.write(input);
        } catch (error) {
            appendCommandOutput(session, `\n[stdin-error] ${error.message}\n`);
        }
    }

    if (terminate && session.process) {
        try {
            session.process.kill('SIGINT');
        } catch {
            // noop
        }
    }

    if (waitMs > 0) {
        const previousOutputCharsTotal = session.outputCharsTotal;
        await waitForCommandChange(session, waitMs / 1000, previousOutputCharsTotal);
    }

    return createCommandSnapshot(session);
}
