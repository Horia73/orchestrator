import { getAgentConfig } from '../../storage/settings.js';
import { CODING_AGENT_ID } from './index.js';
import { getExecutionContext } from '../../core/context.js';
import { broadcastEvent } from '../../core/events.js';

/**
 * Generates expert advice from the Coding Agent.
 * This version supports streaming and tool calls, making it "identical" to the orchestrator's workflow.
 */
export async function generateCodingExpertAdvice({ task, context, files = [], attachments = [] } = {}) {
    const defaultAgentConfig = getAgentConfig(CODING_AGENT_ID);
    const contextData = getExecutionContext();

    // 1. Build the initial turn for the expert
    let promptText = `Solve the following coding task.\n\n`;
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

    const history = [{
        role: 'user',
        parts: parts
    }];

    console.log(`[CodingService] Starting expert execution for task: "${task.slice(0, 50)}..."`);

    let finalResult = null;

    try {
        const { generateAssistantReplyStream } = await import('../../services/geminiService.js');

        finalResult = await generateAssistantReplyStream(history, {
            agentId: CODING_AGENT_ID,
            chatId: contextData?.chatId,
            messageId: contextData?.messageId,
            clientId: contextData?.clientId,
            onUpdate: async ({ text, thought, parts: expertParts, steps }) => {
                if (contextData?.chatId && contextData?.messageId) {
                    broadcastEvent('agent.streaming', {
                        chatId: contextData.chatId,
                        messageId: contextData.messageId,
                        toolCallId: contextData.toolCallId,
                        toolName: contextData.toolName,
                        agentId: CODING_AGENT_ID,
                        payload: {
                            text,
                            thought,
                            parts: expertParts,
                            steps: steps,
                            isThinking: true,
                            clientId: contextData?.clientId
                        }
                    });
                }
            }
        });

        if (contextData?.chatId && contextData?.messageId) {
            broadcastEvent('agent.streaming', {
                chatId: contextData.chatId,
                messageId: contextData.messageId,
                toolCallId: contextData.toolCallId,
                toolName: contextData.toolName,
                agentId: CODING_AGENT_ID,
                payload: {
                    text: finalResult.text,
                    thought: finalResult.thought,
                    parts: finalResult.parts,
                    steps: finalResult.steps,
                    isThinking: false,
                    clientId: contextData?.clientId
                }
            });
        }

        return {
            ok: true,
            model: finalResult.model,
            text: finalResult.text,
            thought: finalResult.thought,
            parts: finalResult.parts,
            steps: finalResult.steps,
            usageMetadata: finalResult.usageMetadata,
        };
    } catch (error) {
        console.error(`[CodingService] Expert execution failed:`, error);
        return {
            ok: false,
            error: error.message,
            text: `Expert encountered an error: ${error.message}`,
            parts: [],
            steps: []
        };
    }
}
