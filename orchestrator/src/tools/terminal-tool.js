import { spawn } from 'child_process';

function cleanCommand(rawGoal) {
  const text = String(rawGoal || '').trim();
  if (!text) return '';

  const fencedMatch = text.match(/```(?:bash|sh|zsh|shell)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return String(fencedMatch[1]).trim();
  }

  const inlineMatch = text.match(/`([^`\n]+)`/);
  if (inlineMatch?.[1]) {
    return String(inlineMatch[1]).trim();
  }

  const prefixed = text.replace(/^(run|execute)\s+(command\s*)?[:\-]?\s*/i, '').trim();
  return prefixed || text;
}

function truncateText(value, maxChars) {
  const text = String(value || '');
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return {
      text,
      truncated: false,
    };
  }

  return {
    text: `${text.slice(0, Math.max(0, maxChars - 24))}\n...[truncated output]`,
    truncated: true,
  };
}

function firstUsefulLine(value) {
  const lines = String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[0] || '';
}

function summarizeResult({ ok, timedOut, aborted, exitCode, stdout, stderr }) {
  if (aborted) return 'Terminal command was aborted.';
  if (timedOut) return 'Terminal command timed out.';
  if (ok) {
    const line = firstUsefulLine(stdout) || firstUsefulLine(stderr);
    return line || 'Command completed successfully.';
  }

  const line = firstUsefulLine(stderr) || firstUsefulLine(stdout);
  if (line) return line;
  if (Number.isInteger(exitCode)) return `Command failed with exit code ${exitCode}.`;
  return 'Command failed.';
}

function buildTimeline(command, stdout, stderr, maxLines = 10) {
  const lines = [`$ ${command}`];
  const merged = []
    .concat(
      String(stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `[stdout] ${line}`)
    )
    .concat(
      String(stderr || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `[stderr] ${line}`)
    )
    .slice(0, Math.max(0, maxLines - 1));
  return lines.concat(merged);
}

export class TerminalToolClient {
  constructor(config = {}, { onLog } = {}) {
    this.config = config;
    this.onLog = typeof onLog === 'function' ? onLog : null;
  }

  updateConfig(patch = {}) {
    if (!patch || typeof patch !== 'object') return;

    if (typeof patch.enabled === 'boolean') {
      this.config.enabled = patch.enabled;
    }

    if (typeof patch.cwd === 'string' && patch.cwd.trim()) {
      this.config.cwd = patch.cwd.trim();
    }

    if (typeof patch.shell === 'string' && patch.shell.trim()) {
      this.config.shell = patch.shell.trim();
    }

    if (Number.isFinite(Number(patch.timeoutMs)) && Number(patch.timeoutMs) > 0) {
      this.config.timeoutMs = Math.floor(Number(patch.timeoutMs));
    }

    if (Number.isFinite(Number(patch.maxOutputChars)) && Number(patch.maxOutputChars) > 0) {
      this.config.maxOutputChars = Math.floor(Number(patch.maxOutputChars));
    }
  }

  getConfig() {
    return {
      enabled: Boolean(this.config.enabled),
      cwd: String(this.config.cwd || ''),
      shell: String(this.config.shell || ''),
      timeoutMs: Number(this.config.timeoutMs) || 0,
      maxOutputChars: Number(this.config.maxOutputChars) || 0,
    };
  }

  async runTask({ goal, timeoutMs, signal }) {
    const command = cleanCommand(goal);
    const effectiveTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.config.timeoutMs;

    if (!command) {
      return {
        ok: false,
        agent: 'terminal',
        goal: String(goal || ''),
        command: '',
        error: 'Missing shell command for terminal tool call.',
        summary: 'Missing shell command.',
      };
    }

    if (!this.config.enabled) {
      return {
        ok: false,
        agent: 'terminal',
        goal: String(goal || ''),
        command,
        error: 'Terminal tool is disabled (TERMINAL_TOOL_ENABLED=false).',
        summary: 'Terminal tool disabled.',
      };
    }

    const startedAt = Date.now();
    this.onLog?.({
      level: 'info',
      component: 'terminal-tool',
      event: 'tool_task_started',
      message: `Terminal command started: ${command}`,
      data: {
        command,
        cwd: this.config.cwd,
        shell: this.config.shell,
      },
    });

    try {
      const execution = await this._executeCommand({
        command,
        timeoutMs: effectiveTimeoutMs,
        signal,
      });

      const stdoutResult = truncateText(execution.stdout, this.config.maxOutputChars);
      const stderrResult = truncateText(execution.stderr, this.config.maxOutputChars);
      const ok = execution.exitCode === 0 && !execution.timedOut && !execution.aborted;
      const summary = summarizeResult({
        ok,
        timedOut: execution.timedOut,
        aborted: execution.aborted,
        exitCode: execution.exitCode,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
      });

      const timeline = buildTimeline(command, stdoutResult.text, stderrResult.text);

      this.onLog?.({
        level: ok ? 'info' : 'warn',
        component: 'terminal-tool',
        event: ok ? 'tool_task_completed' : 'tool_task_failed',
        message: `Terminal command ${ok ? 'completed' : 'failed'}: ${command}`,
        data: {
          command,
          durationMs: Date.now() - startedAt,
          exitCode: execution.exitCode,
          timedOut: execution.timedOut,
          aborted: execution.aborted,
          stdoutTruncated: stdoutResult.truncated,
          stderrTruncated: stderrResult.truncated,
        },
      });

      return {
        ok,
        agent: 'terminal',
        goal: String(goal || ''),
        command,
        durationMs: Date.now() - startedAt,
        cwd: this.config.cwd,
        shell: this.config.shell,
        exitCode: execution.exitCode,
        timedOut: execution.timedOut,
        aborted: execution.aborted,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        stdoutTruncated: stdoutResult.truncated,
        stderrTruncated: stderrResult.truncated,
        timeline,
        error: ok ? '' : summary,
        summary,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onLog?.({
        level: 'error',
        component: 'terminal-tool',
        event: 'tool_task_failed',
        message,
        data: {
          command,
          durationMs: Date.now() - startedAt,
        },
      });

      return {
        ok: false,
        agent: 'terminal',
        goal: String(goal || ''),
        command,
        durationMs: Date.now() - startedAt,
        error: message,
        summary: message,
        timeline: [`$ ${command}`, `[error] ${message}`],
      };
    }
  }

  _executeCommand({ command, timeoutMs, signal }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let aborted = false;
      let timedOut = false;
      const maxCaptureChars = Math.max(2000, Number(this.config.maxOutputChars) || 6000) * 4;

      const child = spawn(this.config.shell, ['-lc', command], {
        cwd: this.config.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const killChild = () => {
        if (child.killed) return;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 250).unref();
      };

      const onAbort = () => {
        aborted = true;
        killChild();
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        killChild();
      }, Math.max(1, Number(timeoutMs) || 1));

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      const appendChunk = (target, chunk) => {
        if (target.length >= maxCaptureChars) return target;
        const text = String(chunk || '');
        if (target.length + text.length <= maxCaptureChars) {
          return target + text;
        }
        const remaining = Math.max(0, maxCaptureChars - target.length);
        return target + text.slice(0, remaining);
      };
      child.stdout?.on('data', (chunk) => {
        stdout = appendChunk(stdout, chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr = appendChunk(stderr, chunk);
      });

      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });

      child.once('close', (exitCode) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
          stdout,
          stderr,
          timedOut,
          aborted,
        });
      });

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    });
  }
}
