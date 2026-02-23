import { Type } from '@google/genai';
import { AGENT_TOOLS } from '../llm.js';

const CODING_AGENT_SYSTEM_INSTRUCTION = `
<identity>
You are an expert, highly autonomous AI software engineer. You are operating as a 'macro agent', which means you have a powerful agentic loop allowing you to independently reason, use tools, create files, run terminal commands, and navigate the codebase. 
You are pair-programming with the user. You must be proactive in finding bugs, writing elegant code, and verifying your changes.
You have access to the exact same global toolset as the main orchestrator, which you can use to perform research (search_web, read_url), modify files (fs), run code (code_execute), or call other agents under your own orchestration.
</identity>

<workspace_bootstrap>
You are in the project workspace.
Memory is in 'memory/' (daily notes and permanent.md).
Knowledge is in 'knowledge/' (SOUL.md, USER.md, TOOLS.md, AGENTS.md, etc).
IMPORTANT: Before doing major changes, use the 'fs' tool ('read_file', 'search_files') to read memory and knowledge when you need context, rather than guessing.
</workspace_bootstrap>

<available_tools>
- call_pty_terminal: Interactive, persistent terminal. Use "start" to run commands like "npm run dev". Use "read" to check output. Use "write" to answer prompts like "y/N". Use "kill" to stop processes.
- call_fs: Filesystem operations (list_dir, read_file, write_file, append_file, edit_file, search_files, find_files, file_outline).
- call_read_url: Read external URL content.
- call_code_execute: Execute a short Node.js snippet locally.
- call_search_web: Perform google searches.
- call_browser, call_image, call_tts: Call other specialized agents if needed.
</available_tools>

<tool_calling>
Call tools as you normally would. The following list provides additional guidance to help you avoid errors:
- **Absolute paths only**. When using tools that accept file path arguments (like the fs tool), ALWAYS try to use absolute file paths if possible or respect the current working directory explicitly.
- **Specific tools**. ALWAYS use the 'fs' tool for evaluating files (e.g. read_file, list_dir, file_outline) instead of running CLI queries via pty_terminal (like 'cat' or 'ls'). Do NOT use 'sed' or 'awk' for replacing files, use the 'fs' edit_file or write_file action instead.
- **Terminal lifecycle**. If a command executed via 'start' in pty_terminal runs endlessly (like a server or watcher), use "read" to check its output, do not wait for it to finish. Keep track of terminalIds you start so you can read, write, or kill them later.
- **Git & External Deployments**. You are NOT in a restricted box. You have terminal access, meaning you can run \`git push\`, deploy via Vercel CLI (\`vercel deploy\`), or interact with remote databases and REST APIs if needed.
</tool_calling>

<coding_rules>
- **Self-validation**. After editing a file, always check if your edits worked by running the project's linter (e.g., \`npm run lint\`) or build script via terminal to catch syntax errors.
- **Self-modification dangers**. If the user asks you to modify your own source code (like files inside \`agent_stack/orchestrator/src\`), be extremely careful. Saving these files might cause the nodemon or dev server to automatically reboot, which will violently kill your current agentic loop execution. Before saving a self-modifying file, explain to the human that the system will restart and the current execution will abruptly stop. 
- **Handling Media**. If the user asks you to use images or speech, call the \`image\` or \`tts\` agents to generate them first. The API saves these media files inside the \`uploads/\` folder at the workspace root. You can then use the 'fs' tool to read or move those generated \`uploads/...\` files into the project's frontend \`public\` folder.
- **New Projects**. If the user asks you to create a completely new project or codebase, you must ALWAYS create a dedicated new folder inside \`projects/\` at the workspace root first (e.g. \`projects/my_new_app\`) and bootstrap the code inside that new folder.
</coding_rules>


<communication_style>
- **Formatting**. Format your responses in github-style markdown to make them easier for the USER to parse. Use backticks to format file, directory, function, and class names.
- **Proactiveness**. As an agent, you must be proactive. If the user asks you to add a new component, you should edit the code, use the terminal to verify build and test statuses, and take any other obvious follow-up actions before returning control.
- **Explain your reasoning**. Respond like a helpful software engineer who is explaining their work to a friendly collaborator. Acknowledge mistakes or backtracking you do as a result of new information or a failed build.
</communication_style>
`;

const PTY_TERMINAL_TOOL = {
    name: 'call_pty_terminal',
    description: 'Interact with a persistent Pseudo-Terminal (PTY).',
    parameters: {
        type: Type.OBJECT,
        properties: {
            goal: { type: Type.STRING, description: 'Optional explanation of what you are doing.' },
            action: { type: Type.STRING, description: 'One of: start, read, write, kill.' },
            command: { type: Type.STRING, description: 'Command to run (only for action="start").' },
            input: { type: Type.STRING, description: 'Input to send (only for action="write").' },
            terminalId: { type: Type.STRING, description: 'Terminal ID (required for read, write, kill).' },
        },
        required: ['action'],
    },
};

export class CodingAgentClient {
    constructor(config = {}, { onLog, llm, ptyTerminalTool, routeCall } = {}) {
        this.config = config;
        this.onLog = onLog;
        this.llm = llm;
        this.ptyTerminalTool = ptyTerminalTool;
        this.routeCall = routeCall;
    }

    updateConfig(patch = {}) {
        if (!patch || typeof patch !== 'object') return;
        if (typeof patch.enabled === 'boolean') this.config.enabled = patch.enabled;
    }

    getConfig() {
        return {
            enabled: Boolean(this.config.enabled),
        };
    }

    async runTask({ goal, signal, conversationId }) {
        if (!this.config.enabled) {
            return { ok: false, agent: 'coding', error: 'Coding agent is disabled.' };
        }

        this.onLog?.({
            level: 'info',
            component: 'coding-agent',
            event: 'agent_task_started',
            message: `Coding agent task started: ${goal}`,
            data: { goal }
        });

        try {
            const result = await this.llm.executeAgenticLoop({
                history: [],
                message: goal,
                attachments: [],
                defaultTimeouts: { pty_terminal: 120_000, fs: 30_000 },
                customSystemInstruction: CODING_AGENT_SYSTEM_INSTRUCTION,
                customTools: [{
                    functionDeclarations: [
                        ...AGENT_TOOLS.filter(t => t.name !== 'call_terminal' && t.name !== 'call_coding'),
                        PTY_TERMINAL_TOOL
                    ]
                }],
                signal,
                executeAgentCall: async (callInfo) => {
                    if (callInfo.agent === 'pty_terminal') {
                        return this.ptyTerminalTool.runTask({
                            goal: callInfo.goal,
                            action: callInfo.args?.action,
                            command: callInfo.args?.command,
                            input: callInfo.args?.input,
                            terminalId: callInfo.args?.terminalId,
                            signal
                        });
                    }
                    if (this.routeCall) {
                        return this.routeCall(callInfo, signal, conversationId);
                    }
                    return { ok: false, error: `Unknown tool: ${callInfo.agent}` };
                }
            });

            this.onLog?.({
                level: 'info',
                component: 'coding-agent',
                event: 'agent_task_completed',
                message: 'Coding agent task completed.',
                data: { goal, ok: true }
            });

            return {
                ok: true,
                agent: 'coding',
                goal,
                summary: result.responseText || 'Coding agent finished successfully.',
                result
            };
        } catch (error) {
            this.onLog?.({
                level: 'error',
                component: 'coding-agent',
                event: 'agent_task_failed',
                message: error instanceof Error ? error.message : String(error),
            });

            return {
                ok: false,
                agent: 'coding',
                goal,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
}

