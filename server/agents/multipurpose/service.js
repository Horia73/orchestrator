import { MULTIPURPOSE_AGENT_ID } from './index.js';
import { getExecutionContext } from '../../core/context.js';
import { broadcastEvent, updateStreamingSnapshot } from '../../core/events.js';

/**
 * Generates expert advice from the Multipurpose Agent.
 * This version supports streaming and tool calls, making it identical to the coding agent's workflow.
 */
export async function generateMultipurposeAdvice({
    task,
    context,
    files = [],
    attachments = [],
    previousTurns = [],
    spawnDepth = 0,
    maxSubagentSpawnDepth,
} = {}) {
    const contextData = getExecutionContext();
    const subagentId = String(contextData?.subagentId ?? '').trim();

    // 1. Build the initial turn for the expert
    let promptText = `Solve the following task.\n\n`;
    if (context) {
        promptText += `Context:\n${context}\n\n`;
    }

    if (Array.isArray(files) && files.length > 0) {
        promptText += `Reference Files:\n`;
        for (const file of files) {
            promptText += `--- FILE: ${file.path} ---\n${file.content}\n\n`;
        }
    }

    promptText += `Task:\n${task}`;

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

    // Build multi-turn history from previous agent interactions in this chat.
    const history = [
        ...previousTurns,
        { role: 'user', parts },
    ];

    console.log(`[MultipurposeService] Starting execution for task: "${task.slice(0, 50)}..."`);

    let finalResult = null;

    try {
        const { generateAssistantReplyStream } = await import('../../services/geminiService.js');

        finalResult = await generateAssistantReplyStream(history, {
            agentId: MULTIPURPOSE_AGENT_ID,
            chatId: contextData?.chatId,
            messageId: contextData?.messageId,
            clientId: contextData?.clientId,
            spawnDepth: spawnDepth ?? contextData?.spawnDepth ?? 0,
            maxSubagentSpawnDepth: maxSubagentSpawnDepth ?? contextData?.maxSubagentSpawnDepth,
            shouldStop: contextData?.shouldStop ?? (() => false),
            onUpdate: async ({ text, thought, parts: expertParts, steps }) => {
                if (contextData?.chatId && contextData?.messageId) {
                    const agentPayload = {
                        text,
                        thought,
                        parts: expertParts,
                        steps: steps,
                        isThinking: true,
                        status: thought ? 'thinking' : 'running',
                        clientId: contextData?.clientId,
                        subagentId: subagentId || undefined,
                        agentId: MULTIPURPOSE_AGENT_ID,
                    };
                    broadcastEvent('agent.streaming', {
                        chatId: contextData.chatId,
                        messageId: contextData.messageId,
                        toolCallId: contextData.toolCallId,
                        toolName: contextData.toolName,
                        agentId: MULTIPURPOSE_AGENT_ID,
                        payload: agentPayload,
                    });
                    updateStreamingSnapshot(contextData.chatId, {
                        agentToolCallId: contextData.toolCallId,
                        agentToolName: contextData.toolName,
                        agentPayload,
                    });
                }
            }
        });

        const completedOk = finalResult?.stopped !== true;
        const finalStatus = completedOk ? 'completed' : 'stopped';

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
                agentId: MULTIPURPOSE_AGENT_ID,
            };
            broadcastEvent('agent.streaming', {
                chatId: contextData.chatId,
                messageId: contextData.messageId,
                toolCallId: contextData.toolCallId,
                toolName: contextData.toolName,
                agentId: MULTIPURPOSE_AGENT_ID,
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
            thinkingLevel: finalResult.thinkingLevel,
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
        console.error(`[MultipurposeService] Execution failed:`, error);
        if (contextData?.chatId && contextData?.messageId) {
            const errorPayload = {
                text: `Multipurpose agent encountered an error: ${error.message}`,
                thought: '',
                parts: [],
                steps: [],
                isThinking: false,
                status: 'error',
                error: error.message,
                clientId: contextData?.clientId,
                subagentId: subagentId || undefined,
                agentId: MULTIPURPOSE_AGENT_ID,
            };
            broadcastEvent('agent.streaming', {
                chatId: contextData.chatId,
                messageId: contextData.messageId,
                toolCallId: contextData.toolCallId,
                toolName: contextData.toolName,
                agentId: MULTIPURPOSE_AGENT_ID,
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
            text: `Multipurpose agent encountered an error: ${error.message}`,
            parts: [],
            steps: []
        };
    }
}
