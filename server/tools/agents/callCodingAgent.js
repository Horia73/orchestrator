import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const CODING_AGENT_ID = 'coding';

export const declaration = {
    name: 'call_coding_agent',
    description: 'Delegates a complex coding task to a specialized Coding Agent. Use this for heavy logic, deep refactoring, or complex debugging. You can provide specific file paths if the task requires analyzing or modifying existing code, and images (base64) for visual/UI issues.',
    parameters: {
        type: 'OBJECT',
        properties: {
            task: {
                type: 'STRING',
                description: 'The specific coding task or problem to solve.',
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
                description: 'Optional file attachments (images, PDFs, audio recordings, or any other media supported by Gemini) to help the agent understand the task.',
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

        const { generateCodingExpertAdvice } = await import('../../agents/coding/service.js');
        const result = await generateCodingExpertAdvice({
            task: taskText,
            context,
            files: filesData,
            attachments: Array.isArray(attachments) ? attachments : [],
        });

        const usageMetadata = result.usageMetadata && typeof result.usageMetadata === 'object'
            ? result.usageMetadata
            : null;

        return {
            ok: result.ok !== false,
            status: result.ok !== false ? 'completed' : 'error',
            model: result.model,
            agentThought: result.thought || '',
            text: result.text || '',
            parts: result.parts || [],
            steps: result.steps || [],
            fileCount: filesData.length,
            attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
            _usage: {
                model: result.model,
                status: result.ok !== false ? 'completed' : 'error',
                agentId: CODING_AGENT_ID,
                inputText: taskText,
                outputText: result.text || '',
                usageMetadata,
            },
        };
    } catch (error) {
        return { error: `Coding agent call failed: ${error.message}` };
    }
}
