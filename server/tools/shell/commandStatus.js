import { COMMAND_OUTPUT_DEFAULT_CHARS } from './_sessions.js';
import { getCommandStatusSnapshot } from './_sessions.js';

export const declaration = {
    name: 'command_status',
    description: 'Poll the status/output of a previously started command session.',
    parameters: {
        type: 'OBJECT',
        properties: {
            CommandId: {
                type: 'STRING',
                description: 'Command session id returned by run_command.',
            },
            WaitDurationSeconds: {
                type: 'NUMBER',
                description: 'Optional long-poll duration in seconds.',
            },
            OutputCharacterCount: {
                type: 'INTEGER',
                description: 'Optional number of output characters to return from the tail.',
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
    WaitDurationSeconds = 0,
    OutputCharacterCount = COMMAND_OUTPUT_DEFAULT_CHARS,
}) {
    return getCommandStatusSnapshot({
        commandId: CommandId,
        waitDurationSeconds: WaitDurationSeconds,
        outputCharacterCount: OutputCharacterCount,
    });
}
