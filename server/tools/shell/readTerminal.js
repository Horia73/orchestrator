import { COMMAND_OUTPUT_DEFAULT_CHARS, getSessionByNameOrPid, createCommandSnapshot } from './_sessions.js';

export const declaration = {
    name: 'read_terminal',
    description: 'Read terminal state by command name or process id.',
    parameters: {
        type: 'OBJECT',
        properties: {
            Name: {
                type: 'STRING',
                description: 'Optional command name hint (e.g. npm, node, pytest).',
            },
            ProcessID: {
                type: 'INTEGER',
                description: 'Optional process id to lookup.',
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
    },
};

export async function execute({
    Name,
    ProcessID,
    OutputCharacterCount = COMMAND_OUTPUT_DEFAULT_CHARS,
}) {
    const session = getSessionByNameOrPid({ Name, ProcessID });
    if (!session) {
        return { error: 'No matching terminal session found.' };
    }

    return createCommandSnapshot(session, { outputCharacterCount: OutputCharacterCount });
}
