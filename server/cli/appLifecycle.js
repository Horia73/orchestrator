#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGeminiApiKey } from '../core/config.js';
import { APP_LOG_PATH } from '../core/dataPaths.js';
import {
    c,
    printBanner,
    readConfig,
    maskApiKey,
    CONFIG_PATH,
    DATA_ROOT_DIR,
    ensureDataDirectories,
} from './helpers.js';
import {
    isBuildReady,
    getConfiguredPort,
    getAppUrl,
    readAppRuntimeState,
    writeAppRuntimeState,
    clearAppRuntimeState,
    isProcessAlive,
    waitForProcessExit,
    probeAppHealth,
    waitForAppHealth,
    buildAppRuntimeState,
    spawnDetachedAppProcess,
    getAppLogTail,
    runNpmScript,
} from './lifecycleCore.js';

function formatRuntimeStatusLabel(runtimeState, healthy) {
    const pid = Number(runtimeState?.pid);
    if (!pid) {
        return healthy ? c.yellow('RUNNING (external)') : c.dim('not running');
    }

    if (isProcessAlive(pid)) {
        return healthy ? c.green('RUNNING') : c.yellow('STARTING / DEGRADED');
    }

    return healthy ? c.yellow('RUNNING (external)') : c.dim('stale');
}

async function ensureProductionBuild({ force = false, silent = false } = {}) {
    if (!force && isBuildReady()) {
        return;
    }

    if (!silent) {
        console.log(c.bold('  Build'));
        console.log(`    ${force ? 'Refreshing' : 'Preparing'} production bundle...`);
        console.log('');
    }

    await runNpmScript('build');
}

function cleanupStaleRuntimeState() {
    const runtimeState = readAppRuntimeState();
    if (!runtimeState) {
        return null;
    }

    if (isProcessAlive(runtimeState.pid)) {
        return runtimeState;
    }

    clearAppRuntimeState();
    return null;
}

export async function startManagedApp({ buildIfMissing = true, forceBuild = false, silent = false } = {}) {
    ensureDataDirectories();
    const port = getConfiguredPort();
    const healthyBeforeStart = await probeAppHealth(port);
    const runtimeState = cleanupStaleRuntimeState();

    if (healthyBeforeStart && runtimeState && isProcessAlive(runtimeState.pid)) {
        if (!silent) {
            console.log(c.green(`  Already running at ${getAppUrl(port)} (pid ${runtimeState.pid}).`));
        }
        return runtimeState;
    }

    if (healthyBeforeStart && !runtimeState) {
        if (!silent) {
            console.log(c.yellow(`  Orchestrator is already responding at ${getAppUrl(port)}, but it is not managed by this CLI.`));
        }
        return null;
    }

    if (runtimeState?.pid && isProcessAlive(runtimeState.pid) && !healthyBeforeStart) {
        if (!silent) {
            console.log(c.yellow(`  Found an unhealthy managed process (${runtimeState.pid}); restarting it.`));
        }
        await stopManagedApp({ silent: true });
    }

    if (buildIfMissing || forceBuild) {
        await ensureProductionBuild({ force: forceBuild, silent });
    }

    const child = spawnDetachedAppProcess();
    const childPid = Number(child.pid);
    if (!Number.isInteger(childPid) || childPid <= 0) {
        throw new Error('Failed to spawn the background server.');
    }

    const healthy = await waitForAppHealth(port);
    if (!healthy) {
        try {
            process.kill(childPid, 'SIGTERM');
        } catch {
            // Ignore cleanup failures.
        }
        await waitForProcessExit(childPid);
        clearAppRuntimeState();
        const logTail = getAppLogTail();
        throw new Error(
            logTail
                ? `Background start failed.\n\nRecent log output:\n${logTail}`
                : 'Background start failed and no log output was captured.',
        );
    }

    const nextRuntimeState = buildAppRuntimeState(childPid, port);
    writeAppRuntimeState(nextRuntimeState);

    if (!silent) {
        console.log(c.green(`  Started Orchestrator in background at ${nextRuntimeState.appUrl} (pid ${childPid}).`));
        console.log(c.dim(`  Log file: ${nextRuntimeState.logPath}`));
    }

    return nextRuntimeState;
}

export async function stopManagedApp({ silent = false } = {}) {
    const runtimeState = cleanupStaleRuntimeState();
    const port = getConfiguredPort();
    const healthy = await probeAppHealth(port);

    if (!runtimeState?.pid) {
        if (!silent) {
            if (healthy) {
                console.log(c.yellow(`  Orchestrator is still responding at ${getAppUrl(port)}, but it is not managed by this CLI.`));
            } else {
                console.log(c.dim('  No managed background process is running.'));
            }
        }
        return false;
    }

    const pid = Number(runtimeState.pid);
    if (!isProcessAlive(pid)) {
        clearAppRuntimeState();
        if (!silent) {
            console.log(c.dim('  Cleared stale runtime state.'));
        }
        return false;
    }

    try {
        process.kill(pid, 'SIGTERM');
    } catch (error) {
        if (error?.code !== 'ESRCH') {
            throw error;
        }
    }

    const stoppedGracefully = await waitForProcessExit(pid);
    if (!stoppedGracefully && isProcessAlive(pid)) {
        process.kill(pid, 'SIGKILL');
        await waitForProcessExit(pid);
    }

    clearAppRuntimeState();

    if (!silent) {
        console.log(c.green(`  Stopped Orchestrator background process${pid ? ` ${pid}` : ''}.`));
    }

    return true;
}

export async function restartManagedApp({ buildIfMissing = true, forceBuild = false, silent = false } = {}) {
    await stopManagedApp({ silent: true });
    return startManagedApp({ buildIfMissing, forceBuild, silent });
}

export async function printStatus() {
    cleanupStaleRuntimeState();

    const config = readConfig();
    const configExists = config !== null;
    const port = getConfiguredPort();
    const runtimeState = readAppRuntimeState();
    const healthy = await probeAppHealth(port);
    const apiKey = getGeminiApiKey();

    printBanner();

    console.log(c.bold('  Configuration'));
    console.log(`    Config file:  ${configExists ? c.green(CONFIG_PATH) : c.red(`${CONFIG_PATH} (not found)`)}`);
    console.log(`    API key:      ${apiKey ? c.green(maskApiKey(apiKey)) : c.red('(not set)')}`);
    console.log(`    Port:         ${port}`);
    console.log('');

    console.log(c.bold('  Runtime'));
    console.log(`    Status:       ${formatRuntimeStatusLabel(runtimeState, healthy)}`);
    console.log(`    URL:          ${healthy ? c.green(getAppUrl(port)) : c.dim(getAppUrl(port))}`);
    console.log(`    Build:        ${isBuildReady() ? c.green('ready') : c.yellow('missing')}`);
    console.log(`    PID:          ${runtimeState?.pid ? runtimeState.pid : c.dim('(unmanaged or stopped)')}`);
    console.log(`    Log file:     ${APP_LOG_PATH}`);
    console.log('');

    console.log(c.bold('  Data'));
    console.log(`    Location:     ${DATA_ROOT_DIR}`);
    console.log('');
}

function printUsage() {
    printBanner();
    console.log(c.bold('  Usage'));
    console.log('    node server/cli/appLifecycle.js <start|stop|restart|status>');
    console.log('');
}

export async function runCli(command = process.argv[2]) {
    const normalizedCommand = String(command ?? '').trim().toLowerCase();

    switch (normalizedCommand) {
    case 'start':
        printBanner();
        await startManagedApp({ buildIfMissing: true, forceBuild: false, silent: false });
        console.log('');
        return;
    case 'stop':
        printBanner();
        await stopManagedApp({ silent: false });
        console.log('');
        return;
    case 'restart':
        printBanner();
        await restartManagedApp({ buildIfMissing: true, forceBuild: false, silent: false });
        console.log('');
        return;
    case 'status':
        await printStatus();
        return;
    case 'help':
    case '--help':
    case '-h':
    case '':
        printUsage();
        return;
    default:
        printUsage();
        throw new Error(`Unknown command: ${normalizedCommand}`);
    }
}

const isDirectExecution = process.argv[1]
    ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    : false;

if (isDirectExecution) {
    runCli().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(c.red(`  ${message}`));
        process.exitCode = 1;
    });
}
