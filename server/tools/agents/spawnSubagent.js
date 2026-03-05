import { randomUUID } from 'node:crypto';
import { executionContext, getExecutionContext } from '../../core/context.js';
import {
    MAX_SUBAGENT_SPAWN_DEPTH,
    normalizeMaxSubagentSpawnDepth,
} from '../../core/subagentPolicy.js';
import { mergeContextWithReportingPolicy } from '../../agents/shared/reportingRules.js';
import {
    registerSubagent,
    updateSubagent,
} from './_subagentRegistry.js';

const SPAWN_SUBAGENT_TOOL_NAME = 'spawn_subagent';
const VALID_AGENT_IDS = new Set(['coding', 'multipurpose', 'researcher']);

function resolveSubagentAgentId({ requestedAgentId, callerAgentId }) {
    const specifiedAgent = String(requestedAgentId ?? '').trim().toLowerCase();
    if (VALID_AGENT_IDS.has(specifiedAgent)) {
        return specifiedAgent;
    }

    const normalizedCallerAgentId = String(callerAgentId ?? '').trim().toLowerCase();
    if (VALID_AGENT_IDS.has(normalizedCallerAgentId)) {
        return normalizedCallerAgentId;
    }

    return 'multipurpose';
}

function buildSpawnOwnerId({ chatId, messageId, subagentId }) {
    const normalizedSubagentId = String(subagentId ?? '').trim();
    if (normalizedSubagentId) {
        return `subagent:${normalizedSubagentId}`;
    }

    const normalizedChatId = String(chatId ?? '').trim();
    const normalizedMessageId = String(messageId ?? '').trim();
    return `message:${normalizedChatId}:${normalizedMessageId}`;
}

function extractTokenCount(usageMetadata) {
    if (!usageMetadata || typeof usageMetadata !== 'object') {
        return 0;
    }

    return Number(usageMetadata.totalTokenCount)
        || (
            Number(usageMetadata.promptTokenCount || 0)
            + Number(usageMetadata.candidatesTokenCount || usageMetadata.responseTokenCount || 0)
            + Number(usageMetadata.thoughtsTokenCount || 0)
            + Number(usageMetadata.toolUsePromptTokenCount || 0)
        );
}

async function runSubagentInline({
    task,
    context,
    chatId,
    clientId,
    subagentId,
    agentId,
    spawnDepth,
    parentMessageId,
    parentToolCallId,
    parentAgentId,
    shouldStop,
    maxSubagentSpawnDepth,
}) {
    const startedAt = Date.now();
    let resultStatus = 'completed';
    let resultText = '';
    let resultThought = '';
    let resultParts = [];
    let resultSteps = [];
    let totalTokens = 0;
    let errorText = '';
    let resultModel = '';
    let usageMetadata = null;
    let toolUsageRecords = [];
    let resultStopReason = '';

    updateSubagent(subagentId, {
        status: 'running',
        startedAt,
    });

    try {
        let result;
        const runWithContext = (runner) => executionContext.run({
            chatId,
            messageId: parentMessageId || undefined,
            clientId,
            toolCallId: parentToolCallId || undefined,
            toolName: SPAWN_SUBAGENT_TOOL_NAME,
            agentId,
            parentAgentId,
            spawnDepth,
            maxSubagentSpawnDepth,
            subagentId,
            shouldStop,
        }, runner);

        if (agentId === 'coding') {
            const { generateCodingExpertAdvice } = await import('../../agents/coding/service.js');
            result = await runWithContext(() => generateCodingExpertAdvice({
                task,
                context,
                files: [],
                attachments: [],
                previousTurns: [],
                spawnDepth,
                maxSubagentSpawnDepth,
            }));
        } else if (agentId === 'researcher') {
            const { generateResearchAdvice } = await import('../../agents/researcher/service.js');
            result = await runWithContext(() => generateResearchAdvice({
                task,
                context,
                files: [],
                attachments: [],
                previousTurns: [],
                spawnDepth,
                maxSubagentSpawnDepth,
            }));
        } else {
            const { generateMultipurposeAdvice } = await import('../../agents/multipurpose/service.js');
            result = await runWithContext(() => generateMultipurposeAdvice({
                task,
                context,
                files: [],
                attachments: [],
                previousTurns: [],
                spawnDepth,
                maxSubagentSpawnDepth,
            }));
        }

        resultText = String(result?.text ?? '').trim();
        resultThought = String(result?.thought ?? '').trim();
        resultParts = Array.isArray(result?.parts) ? result.parts : [];
        resultSteps = Array.isArray(result?.steps) ? result.steps : [];
        resultModel = String(result?.model ?? '').trim();
        usageMetadata = result?.usageMetadata && typeof result.usageMetadata === 'object'
            ? result.usageMetadata
            : null;
        toolUsageRecords = Array.isArray(result?.toolUsageRecords) ? result.toolUsageRecords : [];
        resultStopReason = String(result?.stopReason ?? '').trim();
        totalTokens = extractTokenCount(usageMetadata);

        if (result?.ok === false) {
            if (result?.stopped === true) {
                resultStatus = 'stopped';
                errorText = resultText || 'Subagent stopped before completion.';
            } else {
                resultStatus = 'error';
                errorText = resultText || 'Subagent returned an error.';
            }
        }
    } catch (error) {
        resultStatus = 'error';
        errorText = `Subagent failed to execute: ${error.message}`;
        resultText = errorText;
        resultThought = '';
        resultParts = [];
        resultSteps = [];
    }

    const durationMs = Date.now() - startedAt;
    updateSubagent(subagentId, {
        status: resultStatus,
        completedAt: Date.now(),
        durationMs,
        totalTokens,
        text: resultText,
        thought: resultThought,
        parts: resultParts,
        steps: resultSteps,
        error: errorText,
    });

    return {
        ok: resultStatus !== 'error',
        status: resultStatus,
        subagentId,
        agentId,
        parentToolCallId: parentToolCallId || undefined,
        parentMessageId: parentMessageId || undefined,
        durationMs,
        totalTokens,
        task,
        text: resultText,
        thought: resultThought,
        parts: Array.isArray(resultParts) ? resultParts : [],
        steps: Array.isArray(resultSteps) ? resultSteps : [],
        stopReason: resultStopReason || undefined,
        error: errorText || undefined,
        _usage: usageMetadata
            ? {
                source: 'agent',
                model: resultModel || undefined,
                status: resultStatus,
                agentId,
                inputText: task,
                outputText: resultText,
                usageMetadata,
            }
            : undefined,
        _usageRecords: toolUsageRecords,
    };
}

export const declaration = {
    name: 'spawn_subagent',
    description: `Runs a delegated subagent branch inline as part of the current response. Use this for parallelizable work that should remain inside the same answer, not as a detached background task. You can launch multiple subagents in the same tool round to cover different domains concurrently. A first-level subagent may spawn child subagents once more, but depth cannot exceed ${MAX_SUBAGENT_SPAWN_DEPTH}; some executions may impose a lower depth cap.`,
    parameters: {
        type: 'OBJECT',
        properties: {
            task: {
                type: 'STRING',
                description: 'The specific task, problem, or research slice for the subagent to solve.',
            },
            context: {
                type: 'STRING',
                description: 'Optional textual context or instructions to provide to the subagent.',
            },
            agentId: {
                type: 'STRING',
                description: 'The ID of the agent to spawn. Must be one of: "coding", "multipurpose", "researcher". Defaults to the calling agent type.',
            },
        },
        required: ['task'],
    },
};

export async function execute({ task, context, agentId }) {
    const taskText = String(task ?? '').trim();
    if (!taskText) {
        return { error: 'task is required.' };
    }

    const enrichedContext = mergeContextWithReportingPolicy(context);

    const contextData = getExecutionContext();
    const chatId = String(contextData?.chatId ?? '').trim();
    const clientId = String(contextData?.clientId ?? '').trim();
    const parentMessageId = String(contextData?.messageId ?? '').trim();
    const parentToolCallId = String(contextData?.toolCallId ?? '').trim();
    const parentAgentId = String(contextData?.agentId ?? '').trim();
    const parentSubagentId = String(contextData?.subagentId ?? '').trim();
    const spawnDepth = Number(contextData?.spawnDepth ?? 0);
    const maxSubagentSpawnDepth = normalizeMaxSubagentSpawnDepth(contextData?.maxSubagentSpawnDepth);

    if (!chatId || !clientId) {
        return { error: 'Cannot spawn subagent: missing chatId or clientId in execution context.' };
    }

    if (spawnDepth >= maxSubagentSpawnDepth) {
        return {
            error: `Max subagent spawn depth reached (${maxSubagentSpawnDepth}). Terminal subagents cannot spawn further subagents.`,
        };
    }

    const ownerId = buildSpawnOwnerId({
        chatId,
        messageId: parentMessageId,
        subagentId: parentSubagentId,
    });

    const resolvedAgentId = resolveSubagentAgentId({
        requestedAgentId: agentId,
        callerAgentId: parentAgentId,
    });
    const subagentId = `subagent-${randomUUID().slice(0, 8)}`;

    registerSubagent({
        subagentId,
        chatId,
        clientId,
        ownerId,
        parentMessageId,
        parentToolCallId,
        parentSubagentId,
        parentAgentId,
        agentId: resolvedAgentId,
        task: taskText,
        context: enrichedContext,
        status: 'queued',
        spawnDepth: spawnDepth + 1,
        maxSubagentSpawnDepth,
    });

    return runSubagentInline({
        task: taskText,
        context: enrichedContext,
        chatId,
        clientId,
        subagentId,
        agentId: resolvedAgentId,
        spawnDepth: spawnDepth + 1,
        parentMessageId,
        parentToolCallId,
        parentAgentId,
        shouldStop: contextData?.shouldStop ?? (() => false),
        maxSubagentSpawnDepth,
    });
}
