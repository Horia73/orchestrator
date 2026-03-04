#!/usr/bin/env node
import { buildAppRuntimeState, getConfiguredPort, spawnDetachedAppProcess, writeAppRuntimeState } from './lifecycleCore.js';

const POLL_INTERVAL_MS = 250;
const WAIT_TIMEOUT_MS = 15_000;

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

    const child = spawnDetachedAppProcess();
    const pid = Number(child.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error('Failed to restart background server.');
    }

    writeAppRuntimeState(buildAppRuntimeState(pid, getConfiguredPort()));
}

main().catch((error) => {
    console.error(`[restart-api] ${error.message}`);
    process.exitCode = 1;
});
