import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { getExecutionContext } from '../../core/context.js';
import { mergeContextWithReportingPolicy } from '../../agents/shared/reportingRules.js';

const MULTIPURPOSE_AGENT_ID = 'multipurpose';
const TOOL_NAME = 'call_multipurpose_agent';
const MAX_PREVIOUS_TURNS = 10;

/**
 * Extract previous multipurpose agent call/response pairs from the chat history
 * and convert them into user/model turn pairs for multi-turn conversation.
 */
function extractPreviousAgentTurns(chatHistory) {
    if (!Array.isArray(chatHistory)) return [];

    const turns = [];
    for (const message of chatHistory) {
        if (message.role !== 'ai' || !Array.isArray(message.parts)) continue;

        for (const part of message.parts) {
            if (!part?.functionCall || part.functionCall.name !== TOOL_NAME) continue;

            const args = part.functionCall.args ?? {};
            const task = String(args.task ?? '').trim();
            if (!task) continue;

            // Find the matching response.
            const callId = typeof part.functionCall.id === 'string' ? part.functionCall.id.trim() : '';
            let responseText = '';
            for (const rPart of message.parts) {
                if (!rPart?.functionResponse) continue;
                const rId = typeof rPart.functionResponse.id === 'string' ? rPart.functionResponse.id.trim() : '';
                const rName = typeof rPart.functionResponse.name === 'string' ? rPart.functionResponse.name : '';
                if ((callId && rId === callId) || rName === TOOL_NAME) {
                    const resp = rPart.functionResponse.response ?? {};
                    responseText = String(resp.text ?? '').trim();
                    break;
                }
            }

            if (!responseText) continue;

            // Build the user prompt the agent would have seen.
            let userText = '';
            if (args.context) userText += `Context:\n${args.context}\n\n`;
            userText += `Task:\n${task}`;

            turns.push(
                { role: 'user', text: userText, parts: [{ text: userText }] },
                { role: 'ai', text: responseText, parts: [{ text: responseText }] },
            );
        }
    }

    // Keep only the most recent turns to avoid context overflow.
    if (turns.length > MAX_PREVIOUS_TURNS * 2) {
        return turns.slice(-(MAX_PREVIOUS_TURNS * 2));
    }
    return turns;
}

export const declaration = {
    name: 'call_multipurpose_agent',
    description: 'Delegates a complex task to the Multipurpose Agent — a versatile specialist with access to all tools and skills. Use this for: research tasks, skill execution, document processing, complex multi-step analysis, or any task requiring multiple tool categories. This agent has access to web search, file operations, shell commands, image generation, and all installed skills.',
    parameters: {
        type: 'OBJECT',
        properties: {
            task: {
                type: 'STRING',
                description: 'The specific task or problem to solve.',
            },
            context: {
                type: 'STRING',
                description: 'Optional textual context or instructions.',
            },
            file_paths: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: 'Optional absolute paths to files the agent should read and analyze.',
            },
            attachments: {
                type: 'ARRAY',
                items: {
                    type: 'OBJECT',
                    properties: {
                        mimeType: { type: 'STRING', description: 'e.g., image/png, application/pdf, audio/mp3, video/mp4, etc.' },
                        data: { type: 'STRING', description: 'Base64 encoded file data.' },
                    },
                    required: ['mimeType', 'data'],
                },
                description: 'Optional file attachments (images, PDFs, audio, or any media supported by Gemini) to help the agent understand the task.',
            },
        },
        required: ['task'],
    },
};

export async function execute({ task, context, file_paths, attachments }) {
    const taskText = String(task ?? '').trim();
    if (!taskText) {
        return { error: 'task is required.' };
    }

    try {
        const filesData = [];
        if (Array.isArray(file_paths) && file_paths.length > 0) {
            for (const path of file_paths) {
                const absolutePath = isAbsolute(path) ? path : resolve(process.cwd(), path);
                try {
                    const content = await readFile(absolutePath, 'utf8');
                    filesData.push({ path: absolutePath, content });
                } catch (err) {
                    filesData.push({ path: absolutePath, content: `Error reading file: ${err.message}` });
                }
            }
        }

        // Merge explicit attachments with user attachments from the conversation context.
        const explicitAttachments = Array.isArray(attachments) ? attachments : [];
        const contextData = getExecutionContext();
        const contextAttachments = Array.isArray(contextData?.userAttachments) ? contextData.userAttachments : [];
        const allAttachments = [...explicitAttachments, ...contextAttachments];

        // Extract previous multipurpose agent interactions from chat history for multi-turn context.
        const previousTurns = extractPreviousAgentTurns(contextData?.chatHistory);

        const { generateMultipurposeAdvice } = await import('../../agents/multipurpose/service.js');
        const result = await generateMultipurposeAdvice({
            task: taskText,
            context: mergeContextWithReportingPolicy(context),
            files: filesData,
            attachments: allAttachments,
            previousTurns,
            spawnDepth: contextData?.spawnDepth ?? 0,
        });

        const usageMetadata = result.usageMetadata && typeof result.usageMetadata === 'object'
            ? result.usageMetadata
            : null;
        const wasStopped = result?.stopped === true || String(result?.stopReason ?? '').trim().length > 0;
        const toolStatus = wasStopped
            ? 'stopped'
            : (result.ok !== false ? 'completed' : 'error');

        return {
            ok: toolStatus !== 'error',
            status: toolStatus,
            model: result.model,
            agentThought: result.thought || '',
            text: result.text || '',
            stopReason: wasStopped ? (result.stopReason || 'stopped') : undefined,
            fileCount: filesData.length,
            attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
            _usageRecords: Array.isArray(result.toolUsageRecords) ? result.toolUsageRecords : [],
            _usage: {
                model: result.model,
                status: toolStatus,
                agentId: MULTIPURPOSE_AGENT_ID,
                inputText: taskText,
                outputText: result.text || '',
                usageMetadata,
            },
        };
    } catch (error) {
        return { error: `Multipurpose agent call failed: ${error.message}` };
    }
}
