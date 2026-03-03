import { RESEARCHER_AGENT_ID } from './index.js';
import { executionContext, getExecutionContext } from '../../core/context.js';
import { broadcastEvent, updateStreamingSnapshot } from '../../core/events.js';

/**
 * Executes a deep research task via the Researcher Agent.
 * Supports streaming, tool calls (search_web, read_url, spawn_subagent, etc.).
 */
export async function generateResearchAdvice({
    task,
    context,
    files = [],
    attachments = [],
    previousTurns = [],
    spawnDepth = 0,
    maxSubagentSpawnDepth,
    toolAccessOverride,
    continuationMode = 'auto',
} = {}) {
    const contextData = getExecutionContext();
    const subagentId = String(contextData?.subagentId ?? '').trim();

    // Build the initial prompt
    let promptText = `Perform the following research task.\n\n`;
    if (context) {
        promptText += `Context:\n${context}\n\n`;
    }

    if (Array.isArray(files) && files.length > 0) {
        promptText += `Reference Files:\n`;
        for (const file of files) {
            promptText += `--- FILE: ${file.path} ---\n${file.content}\n\n`;
        }
    }

    if (Array.isArray(previousTurns) && previousTurns.length > 0) {
        promptText += [
            'Continuation Policy:',
            '- Treat prior researcher turns in this chat as reusable context.',
            '- Continue from existing findings instead of restarting from scratch.',
            '- Avoid repeating the same searches or re-reading the same sources unless you are verifying freshness, resolving contradictions, or drilling deeper.',
            `- Continuation mode: ${continuationMode}.`,
            '',
        ].join('\n');
    }

    promptText += `Research Task:\n${task}`;

    const parts = [{ text: promptText }];
    if (Array.isArray(attachments) && attachments.length > 0) {
        for (const attachment of attachments) {
            parts.push({
                inlineData: {
                    mimeType: attachment.mimeType,
                    data: attachment.data,
                },
            });
        }
    }

    const history = [
        ...previousTurns,
        { role: 'user', parts },
    ];

    console.log(`[ResearcherService] Starting research: "${task.slice(0, 60)}..."`);

    let finalResult = null;

    try {
        const { generateAssistantReplyStream } = await import('../../services/geminiService.js');
        finalResult = await executionContext.run({
            ...(contextData ?? {}),
            maxSubagentSpawnDepth: maxSubagentSpawnDepth ?? contextData?.maxSubagentSpawnDepth,
        }, () => generateAssistantReplyStream(history, {
            agentId: RESEARCHER_AGENT_ID,
            chatId: contextData?.chatId,
            messageId: contextData?.messageId,
            clientId: contextData?.clientId,
            spawnDepth: spawnDepth ?? contextData?.spawnDepth ?? 0,
            maxSubagentSpawnDepth: maxSubagentSpawnDepth ?? contextData?.maxSubagentSpawnDepth,
            toolAccessOverride,
            shouldStop: contextData?.shouldStop ?? (() => false),
            onUpdate: async ({ text, thought, parts: agentParts, steps }) => {
                if (contextData?.chatId && contextData?.messageId) {
                    const agentPayload = {
                        text,
                        thought,
                        parts: agentParts,
                        steps,
                        isThinking: true,
                        status: thought ? 'thinking' : 'running',
                        clientId: contextData?.clientId,
                        subagentId: subagentId || undefined,
                        agentId: RESEARCHER_AGENT_ID,
                    };
                    broadcastEvent('agent.streaming', {
                        chatId: contextData.chatId,
                        messageId: contextData.messageId,
                        toolCallId: contextData.toolCallId,
                        toolName: contextData.toolName,
                        agentId: RESEARCHER_AGENT_ID,
                        payload: agentPayload,
                    });
                    updateStreamingSnapshot(contextData.chatId, {
                        agentToolCallId: contextData.toolCallId,
                        agentToolName: contextData.toolName,
                        agentPayload,
                    });
                }
            },
        }));

        const completedOk = finalResult?.stopped !== true;
        const finalStatus = completedOk ? 'completed' : 'stopped';

        // Final event (isThinking: false)
        if (contextData?.chatId && contextData?.messageId) {
            const finalPayload = {
                text: finalResult.text,
                thought: finalResult.thought,
                parts: finalResult.parts,
                steps: finalResult.steps,
                isThinking: false,
                status: finalStatus,
                stopReason: finalResult.stopReason || undefined,
                clientId: contextData?.clientId,
                subagentId: subagentId || undefined,
                agentId: RESEARCHER_AGENT_ID,
            };
            broadcastEvent('agent.streaming', {
                chatId: contextData.chatId,
                messageId: contextData.messageId,
                toolCallId: contextData.toolCallId,
                toolName: contextData.toolName,
                agentId: RESEARCHER_AGENT_ID,
                payload: finalPayload,
            });
            updateStreamingSnapshot(contextData.chatId, {
                agentToolCallId: contextData.toolCallId,
                agentToolName: contextData.toolName,
                agentPayload: finalPayload,
            });
        }

        return {
            ok: completedOk,
            model: finalResult.model,
            text: finalResult.text,
            thought: finalResult.thought,
            parts: finalResult.parts,
            steps: finalResult.steps,
            stopped: finalResult.stopped === true,
            stopReason: finalResult.stopReason || '',
            usageMetadata: finalResult.usageMetadata,
            toolUsageRecords: Array.isArray(finalResult.toolUsageRecords) ? finalResult.toolUsageRecords : [],
        };
    } catch (error) {
        console.error(`[ResearcherService] Research failed:`, error);
        if (contextData?.chatId && contextData?.messageId) {
            const errorPayload = {
                text: `Research agent encountered an error: ${error.message}`,
                thought: '',
                parts: [],
                steps: [],
                isThinking: false,
                status: 'error',
                error: error.message,
                clientId: contextData?.clientId,
                subagentId: subagentId || undefined,
                agentId: RESEARCHER_AGENT_ID,
            };
            broadcastEvent('agent.streaming', {
                chatId: contextData.chatId,
                messageId: contextData.messageId,
                toolCallId: contextData.toolCallId,
                toolName: contextData.toolName,
                agentId: RESEARCHER_AGENT_ID,
                payload: errorPayload,
            });
            updateStreamingSnapshot(contextData.chatId, {
                agentToolCallId: contextData.toolCallId,
                agentToolName: contextData.toolName,
                agentPayload: errorPayload,
            });
        }
        return {
            ok: false,
            error: error.message,
            text: `Research agent encountered an error: ${error.message}`,
            parts: [],
            steps: [],
        };
    }
}
