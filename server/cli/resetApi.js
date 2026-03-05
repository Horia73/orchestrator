#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const POLL_INTERVAL_MS = 250;
const WAIT_TIMEOUT_MS = 20_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RESET_SCRIPT_PATH = path.join(PROJECT_ROOT, 'server', 'cli', 'reset.js');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

async function waitForProcessExit(pid) {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
            return true;
        }
        await sleep(POLL_INTERVAL_MS);
    }

    return !isProcessAlive(pid);
}

async function main() {
    const parentPid = Number(process.argv[2]);
    if (!Number.isInteger(parentPid) || parentPid <= 0) {
        throw new Error('Parent PID is required.');
    }

    const stopped = await waitForProcessExit(parentPid);
    if (!stopped) {
        throw new Error(`Timed out waiting for process ${parentPid} to exit.`);
    }

    const child = spawn(process.execPath, [RESET_SCRIPT_PATH], {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
        },
    });
    child.unref();
}

main().catch((error) => {
    console.error(`[reset-api] ${error.message}`);
    process.exitCode = 1;
});
