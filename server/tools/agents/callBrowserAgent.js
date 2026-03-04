import {
    captureBrowserAgentScreenshot,
    inspectBrowserAgentSession,
    runBrowserAgentTask,
    terminateBrowserAgentSession,
} from '../../services/browserAgent.js';

const TOOL_NAME = 'call_browser_agent';

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
} = {}) {
    try {
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

        const result = await runBrowserAgentTask({
            task: taskText,
            context,
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
