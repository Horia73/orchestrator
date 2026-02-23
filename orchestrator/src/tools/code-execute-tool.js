import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class CodeExecuteToolClient {
    constructor(config = {}, { onLog } = {}) {
        this.config = config;
        this.onLog = typeof onLog === 'function' ? onLog : null;
    }

    async runTask({ goal }) {
        const trimmedGoal = String(goal || '').trim();
        if (!trimmedGoal) {
            return {
                ok: false,
                agent: 'code_execute',
                goal: '',
                error: 'Missing code to execute.',
                summary: 'No code provided to execute.'
            };
        }

        this.onLog?.({
            level: 'info',
            component: 'code-execute-tool',
            event: 'agent_task_started',
            message: 'Running node code snippet.',
        });

        try {
            // Run the code using node -e
            const { stdout, stderr } = await execFileAsync('node', ['-e', trimmedGoal], {
                timeout: 10000, // 10s max execution time for quick snippets
                maxBuffer: 1024 * 1024, // 1MB buffer
            });

            this.onLog?.({
                level: 'info',
                component: 'code-execute-tool',
                event: 'agent_task_completed',
                message: 'Node code snippet executed successfully.',
            });

            return {
                ok: true,
                agent: 'code_execute',
                goal: trimmedGoal,
                summary: 'Code executed successfully.',
                text: JSON.stringify({
                    stdout: stdout?.trim() || '',
                    stderr: stderr?.trim() || ''
                }),
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isTimeout = error.killed && error.code === 'ERR_CHILD_PROCESS_IPC_DISCONNECT';

            this.onLog?.({
                level: 'error',
                component: 'code-execute-tool',
                event: 'agent_task_failed',
                message: isTimeout ? 'Code execution timed out.' : errorMessage,
            });

            return {
                ok: false,
                agent: 'code_execute',
                goal: trimmedGoal,
                error: isTimeout ? 'Code execution timed out (max 10s).' : errorMessage,
                summary: 'Code execution failed.',
                text: JSON.stringify({
                    stdout: error.stdout?.trim() || '',
                    stderr: error.stderr?.trim() || ''
                }),
            };
        }
    }
}
