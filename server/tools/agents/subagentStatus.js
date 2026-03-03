import { getSubagent } from './_subagentRegistry.js';

export const declaration = {
    name: 'subagent_status',
    description: 'Checks the status of a subagent branch started with spawn_subagent. Use this instead of command_status for subagent IDs.',
    parameters: {
        type: 'OBJECT',
        properties: {
            subagentId: {
                type: 'STRING',
                description: 'The subagent ID returned by spawn_subagent (for example "subagent-ab12cd34").',
            },
            includeResultText: {
                type: 'BOOLEAN',
                description: 'If true, include the latest/full text result when available.',
            },
        },
        required: ['subagentId'],
    },
};

export async function execute({ subagentId, includeResultText = false }) {
    const normalizedId = String(subagentId ?? '').trim();
    if (!normalizedId) {
        return { error: 'subagentId is required.' };
    }

    const record = getSubagent(normalizedId);
    if (!record) {
        return {
            error: `Unknown subagent id: ${normalizedId}. Use the exact id returned by spawn_subagent.`,
        };
    }

    const payload = {
        subagentId: record.subagentId,
        status: record.status,
        agentId: record.agentId,
        task: record.task,
        parentToolCallId: record.parentToolCallId || undefined,
        parentMessageId: record.parentMessageId || undefined,
        createdAt: record.createdAt,
        startedAt: record.startedAt || undefined,
        updatedAt: record.updatedAt,
        completedAt: record.completedAt || undefined,
        durationMs: record.durationMs || undefined,
        totalTokens: record.totalTokens || undefined,
        error: record.error || undefined,
    };

    const resultText = String(record.text ?? '').trim();
    if (includeResultText) {
        payload.text = resultText;
        payload.thought = String(record.thought ?? '').trim();
    } else if (resultText) {
        payload.preview = resultText.slice(0, 600);
    }

    return payload;
}
