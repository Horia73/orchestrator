import {
    captureBrowserAgentScreenshot,
    inspectBrowserAgentSession,
    runBrowserAgentTask,
    terminateBrowserAgentSession,
} from '../../services/browserAgent.js';
import { resolveUpload } from '../../storage/uploads.js';
import { getExecutionContext } from '../../core/context.js';
import { isAbsolute, resolve } from 'node:path';

const TOOL_NAME = 'call_browser_agent';
const TOOL_PATH_REGEX = /tool_path=([^\n|]+)/gi;

function sanitizeText(value) {
    return String(value ?? '').trim();
}

function toAbsolutePath(filePath) {
    const normalized = sanitizeText(filePath);
    if (!normalized) {
        return '';
    }

    return isAbsolute(normalized) ? normalized : resolve(process.cwd(), normalized);
}

function collectUploadIdsFromParts(parts) {
    if (!Array.isArray(parts)) {
        return [];
    }

    const ids = [];
    for (const part of parts) {
        const uploadId = sanitizeText(part?.fileData?.uploadId);
        if (uploadId) {
            ids.push(uploadId);
        }
    }
    return ids;
}

function extractLatestUserUploadIdsFromHistory(chatHistory) {
    if (!Array.isArray(chatHistory)) {
        return [];
    }

    for (let index = chatHistory.length - 1; index >= 0; index -= 1) {
        const message = chatHistory[index];
        if (sanitizeText(message?.role) !== 'user') {
            continue;
        }
        const ids = collectUploadIdsFromParts(message?.parts);
        if (ids.length > 0) {
            return ids;
        }
    }

    return [];
}

function extractToolPathHints(text) {
    const raw = sanitizeText(text);
    if (!raw) {
        return [];
    }

    const matches = [];
    let match = TOOL_PATH_REGEX.exec(raw);
    while (match) {
        const maybePath = sanitizeText(match[1]);
        if (maybePath) {
            matches.push(maybePath);
        }
        match = TOOL_PATH_REGEX.exec(raw);
    }
    TOOL_PATH_REGEX.lastIndex = 0;
    return matches;
}

async function resolveUploadFiles({
    explicitFilePaths,
    explicitUploadIds,
    inferredUploadIds,
    taskText,
    contextText,
}) {
    const files = [];
    const seenPathSet = new Set();

    const pushFile = (entry) => {
        if (!entry || typeof entry !== 'object') {
            return;
        }
        const absolutePath = toAbsolutePath(entry.absolutePath || entry.path);
        if (!absolutePath || seenPathSet.has(absolutePath)) {
            return;
        }

        seenPathSet.add(absolutePath);
        files.push({
            uploadId: sanitizeText(entry.uploadId || entry.id),
            name: sanitizeText(entry.name),
            mimeType: sanitizeText(entry.mimeType),
            absolutePath,
        });
    };

    for (const rawPath of Array.isArray(explicitFilePaths) ? explicitFilePaths : []) {
        const absolutePath = toAbsolutePath(rawPath);
        if (!absolutePath || seenPathSet.has(absolutePath)) {
            continue;
        }
        seenPathSet.add(absolutePath);
        files.push({
            uploadId: '',
            name: sanitizeText(rawPath).split('/').pop() || absolutePath.split('/').pop() || 'file',
            mimeType: '',
            absolutePath,
        });
    }

    for (const hintedPath of [
        ...extractToolPathHints(taskText),
        ...extractToolPathHints(contextText),
    ]) {
        const absolutePath = toAbsolutePath(hintedPath);
        if (!absolutePath || seenPathSet.has(absolutePath)) {
            continue;
        }
        seenPathSet.add(absolutePath);
        files.push({
            uploadId: '',
            name: hintedPath.split('/').pop() || 'file',
            mimeType: '',
            absolutePath,
        });
    }

    const combinedUploadIds = [
        ...(Array.isArray(explicitUploadIds) ? explicitUploadIds : []),
        ...(Array.isArray(inferredUploadIds) ? inferredUploadIds : []),
    ]
        .map((item) => sanitizeText(item))
        .filter(Boolean);

    const uniqueUploadIds = [...new Set(combinedUploadIds)];
    for (const uploadId of uniqueUploadIds) {
        try {
            const { metadata, absolutePath } = await resolveUpload(uploadId);
            pushFile({
                uploadId,
                name: metadata?.name,
                mimeType: metadata?.mimeType,
                absolutePath,
            });
        } catch {
            // ignore unresolved upload ids
        }
    }

    return files;
}

export const declaration = {
    name: TOOL_NAME,
    description: 'Delegates a live browser interaction task to the Browser Agent. Use this for physical browser actions on real sites and authenticated flows, not normal web research.',
    parameters: {
        type: 'OBJECT',
        properties: {
            task: {
                type: 'STRING',
                description: 'The browser task to perform. Required unless inspect_only or terminate_session is true.',
            },
            context: {
                type: 'STRING',
                description: 'Optional extra instructions or constraints for the browser task.',
            },
            session_id: {
                type: 'STRING',
                description: 'Optional existing Browser Agent session id to continue, inspect, or terminate.',
            },
            new_session: {
                type: 'BOOLEAN',
                description: 'If true, force a fresh browser session instead of reusing the current one.',
            },
            restart_session: {
                type: 'BOOLEAN',
                description: 'If true, relaunch the browser session before running the task.',
            },
            clear_context: {
                type: 'BOOLEAN',
                description: 'If true, clear the browser agent task context before starting the new task.',
            },
            inspect_only: {
                type: 'BOOLEAN',
                description: 'If true, return the current session status without running a new task.',
            },
            terminate_session: {
                type: 'BOOLEAN',
                description: 'If true, stop and close the specified session.',
            },
            capture_screenshot: {
                type: 'BOOLEAN',
                description: 'If true, attach a screenshot of the current browser page after the task or inspect call. Useful for UI verification and visual proof.',
            },
            screenshot_label: {
                type: 'STRING',
                description: 'Optional label for the returned screenshot attachment.',
            },
            file_paths: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: 'Optional absolute or workspace-relative file paths that Browser Agent may upload when a file input is present. Use when files exist on disk.',
            },
            upload_ids: {
                type: 'ARRAY',
                items: { type: 'STRING' },
                description: 'Optional upload IDs from /api/uploads. Preferred for user-attached chat files. If omitted, latest user message attachments are auto-detected when available.',
            },
        },
        required: [],
    },
};

export async function execute({
    task,
    context,
    session_id,
    new_session = false,
    restart_session = false,
    clear_context = false,
    inspect_only = false,
    terminate_session = false,
    capture_screenshot = false,
    screenshot_label = '',
    file_paths = [],
    upload_ids = [],
} = {}) {
    try {
        const contextData = getExecutionContext();
        const sessionId = String(session_id ?? '').trim();
        const wantsScreenshot = capture_screenshot === true;
        const screenshotLabel = String(screenshot_label ?? '').trim();

        if (inspect_only) {
            if (!sessionId) {
                return { error: 'session_id is required when inspect_only is true.' };
            }

            if (wantsScreenshot) {
                return await captureBrowserAgentScreenshot(sessionId, {
                    label: screenshotLabel,
                });
            }

            return await inspectBrowserAgentSession(sessionId);
        }

        if (terminate_session) {
            if (!sessionId) {
                return { error: 'session_id is required when terminate_session is true.' };
            }

            return await terminateBrowserAgentSession(sessionId);
        }

        const taskText = String(task ?? '').trim();
        if (!taskText) {
            return { error: 'task is required unless inspect_only or terminate_session is true.' };
        }

        const inferredUploadIds = extractLatestUserUploadIdsFromHistory(contextData?.chatHistory);
        const uploadFiles = await resolveUploadFiles({
            explicitFilePaths: file_paths,
            explicitUploadIds: upload_ids,
            inferredUploadIds,
            taskText,
            contextText: context,
        });

        const result = await runBrowserAgentTask({
            task: taskText,
            context,
            uploadFiles,
            sessionId,
            newSession: new_session === true,
            restartSession: restart_session === true,
            clearContext: clear_context === true,
            captureScreenshot: wantsScreenshot,
            screenshotLabel,
        });
        return result;
    } catch (error) {
        return { error: `Browser agent call failed: ${error.message}` };
    }
}
