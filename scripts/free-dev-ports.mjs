#!/usr/bin/env node

import { execSync } from 'node:child_process';
import process from 'node:process';

const DEFAULT_PORTS = [3020, 3030, 5173];
const workspaceRoot = process.cwd();

function parsePorts(rawArgs) {
  const parsed = rawArgs
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 65535);

  return parsed.length > 0 ? Array.from(new Set(parsed)) : DEFAULT_PORTS;
}

function run(command) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function listListeningPids(port) {
  if (process.platform === 'win32') return [];
  const output = run(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
  if (!output) return [];
  return Array.from(
    new Set(
      output
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value) && value > 0)
    )
  );
}

function readCommandLine(pid) {
  if (process.platform === 'win32') return '';
  return run(`ps -p ${pid} -o command=`).trim();
}

function readWorkingDirectory(pid) {
  if (process.platform === 'win32') return '';
  const output = run(`lsof -a -p ${pid} -d cwd -Fn`);
  if (!output) return '';

  const cwdLine = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('n'));

  return cwdLine ? cwdLine.slice(1) : '';
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopPid(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !isAlive(pid);
  }

  for (let i = 0; i < 12; i += 1) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return !isAlive(pid);
  }

  for (let i = 0; i < 5; i += 1) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }

  return !isAlive(pid);
}

async function freePort(port) {
  const pids = listListeningPids(port);
  if (pids.length === 0) {
    return;
  }

  const localProcesses = [];
  const foreignProcesses = [];

  for (const pid of pids) {
    const command = readCommandLine(pid);
    const cwd = readWorkingDirectory(pid);
    const belongsToWorkspace = (cwd && cwd.startsWith(workspaceRoot))
      || (command && command.includes(workspaceRoot));

    if (belongsToWorkspace) {
      localProcesses.push({ pid, command, cwd });
    } else {
      foreignProcesses.push({ pid, command, cwd });
    }
  }

  for (const processInfo of foreignProcesses) {
    const details = processInfo.command || processInfo.cwd || 'unknown command';
    console.warn(`[ports] Port ${port} used by non-workspace PID ${processInfo.pid} (${details}); skipping.`);
  }

  for (const processInfo of localProcesses) {
    const stopped = await stopPid(processInfo.pid);
    if (stopped) {
      console.log(`[ports] Freed ${port} by stopping PID ${processInfo.pid}.`);
    } else {
      console.warn(`[ports] Failed to stop PID ${processInfo.pid} on port ${port}.`);
    }
  }
}

async function main() {
  if (process.platform === 'win32') {
    console.warn('[ports] Windows is not supported by this helper; skipping cleanup.');
    return;
  }

  if (!run('command -v lsof')) {
    console.warn('[ports] lsof is not available; skipping cleanup.');
    return;
  }

  const ports = parsePorts(process.argv.slice(2));
  for (const port of ports) {
    // Sequential cleanup avoids signaling races across related processes.
    await freePort(port);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ports] Cleanup failed: ${message}`);
  process.exit(1);
});
