import pty from 'node-pty';
import os from 'os';

function stripAnsi(str) {
    // Simple regex to strip ANSI color and formatting codes
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

export class PtyTerminalToolClient {
    constructor(config = {}, { onLog } = {}) {
        this.config = config;
        this.onLog = typeof onLog === 'function' ? onLog : null;
        this.sessions = new Map();
        this.nextId = 1;
    }

    updateConfig(patch = {}) {
        if (!patch || typeof patch !== 'object') return;
        if (typeof patch.enabled === 'boolean') {
            this.config.enabled = patch.enabled;
        }
    }

    getConfig() {
        return {
            enabled: Boolean(this.config.enabled),
        };
    }

    async runTask({ goal, action, terminalId, command, input, signal }) {
        if (!this.config.enabled) {
            return {
                ok: false,
                agent: 'pty_terminal',
                error: 'PtyTerminal tool is disabled.',
            };
        }

        this.onLog?.({
            level: 'info',
            component: 'pty-terminal-tool',
            event: 'tool_task_started',
            message: `Pty action: ${action}`,
            data: { action, terminalId, command, input },
        });

        try {
            if (action === 'start') {
                const id = String(this.nextId++);
                const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

                const ptyProcess = pty.spawn(shell, [], {
                    name: 'xterm-color',
                    cols: 120,
                    rows: 40,
                    cwd: process.cwd(),
                    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' }
                });

                const session = {
                    id,
                    process: ptyProcess,
                    outputHistory: '',
                    newOutput: ''
                };

                ptyProcess.onData((data) => {
                    const clean = stripAnsi(data);
                    session.outputHistory += clean;
                    session.newOutput += clean;
                });

                ptyProcess.onExit(({ exitCode }) => {
                    session.newOutput += `\n[Process exited with code ${exitCode}]\n`;
                });

                this.sessions.set(id, session);

                if (command) {
                    ptyProcess.write(`${command}\r`);
                }

                // Wait a bit for the command to produce initial output
                await new Promise(r => setTimeout(r, 1000));

                const outputToReturn = session.newOutput;
                session.newOutput = ''; // clear unread buffer

                return {
                    ok: true,
                    agent: 'pty_terminal',
                    terminalId: id,
                    output: outputToReturn,
                    summary: `Started terminal ${id}${command ? ` and ran: ${command}` : ''}.`
                };
            }

            if (action === 'read') {
                const session = this.sessions.get(String(terminalId));
                if (!session) {
                    return { ok: false, agent: 'pty_terminal', error: `Terminal ${terminalId} not found.` };
                }

                const outputToReturn = session.newOutput;
                session.newOutput = '';

                return {
                    ok: true,
                    agent: 'pty_terminal',
                    terminalId,
                    output: outputToReturn || '(no new output)',
                    summary: `Read output from terminal ${terminalId}.`
                };
            }

            if (action === 'write') {
                const session = this.sessions.get(String(terminalId));
                if (!session) {
                    return { ok: false, agent: 'pty_terminal', error: `Terminal ${terminalId} not found.` };
                }

                if (input !== undefined) {
                    session.process.write(input);
                }

                await new Promise(r => setTimeout(r, 1000));

                const outputToReturn = session.newOutput;
                session.newOutput = '';

                return {
                    ok: true,
                    agent: 'pty_terminal',
                    terminalId,
                    output: outputToReturn,
                    summary: `Wrote to terminal ${terminalId}.`
                };
            }

            if (action === 'kill') {
                const session = this.sessions.get(String(terminalId));
                if (!session) {
                    return { ok: false, agent: 'pty_terminal', error: `Terminal ${terminalId} not found.` };
                }

                session.process.kill();
                this.sessions.delete(String(terminalId));

                return {
                    ok: true,
                    agent: 'pty_terminal',
                    terminalId,
                    summary: `Terminal ${terminalId} killed.`
                };
            }

            return {
                ok: false,
                agent: 'pty_terminal',
                error: `Unknown action: ${action}`
            };

        } catch (error) {
            return {
                ok: false,
                agent: 'pty_terminal',
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
}
