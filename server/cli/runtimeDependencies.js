import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { c } from './helpers.js';
import { getProjectRoot } from './lifecycleCore.js';

const execFileAsync = promisify(execFile);
const LINUX_BROWSER_EXTRA_COMMANDS = ['ffmpeg', 'Xvfb', 'x11vnc'];

function isTruthyEnvFlag(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function quoteForShell(value) {
    return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function runProcess(command, args, { cwd = getProjectRoot() } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            stdio: 'inherit',
            env: {
                ...process.env,
            },
        });

        child.on('error', reject);
        child.on('exit', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(
                new Error(
                    signal
                        ? `${path.basename(command)} exited with signal ${signal}.`
                        : `${path.basename(command)} exited with code ${code}.`,
                ),
            );
        });
    });
}

async function hasShellCommand(command) {
    if (process.platform === 'win32') {
        return false;
    }

    try {
        await execFileAsync('/bin/sh', [
            '-lc',
            `command -v ${quoteForShell(command)} >/dev/null 2>&1`,
        ]);
        return true;
    } catch {
        return false;
    }
}

function getPatchrightCliPath() {
    return path.join(getProjectRoot(), 'node_modules', 'patchright', 'cli.js');
}

async function getMissingLinuxBrowserExtraCommands() {
    const installed = await Promise.all(
        LINUX_BROWSER_EXTRA_COMMANDS.map((command) => hasShellCommand(command)),
    );

    return LINUX_BROWSER_EXTRA_COMMANDS.filter((_, index) => installed[index] !== true);
}

async function getPrivilegeEscalationPrefix() {
    if (process.platform === 'win32') {
        return [];
    }

    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        return [];
    }

    if (await hasShellCommand('sudo')) {
        return ['sudo'];
    }

    if (await hasShellCommand('doas')) {
        return ['doas'];
    }

    throw new Error('Linux browser extras need root privileges to install, but neither `sudo` nor `doas` is available.');
}

async function detectLinuxPackageManager() {
    const candidates = ['apt-get', 'dnf', 'yum', 'pacman', 'apk'];
    for (const candidate of candidates) {
        if (await hasShellCommand(candidate)) {
            return candidate;
        }
    }

    return null;
}

function buildLinuxExtraInstallPlan(packageManager) {
    switch (packageManager) {
    case 'apt-get':
        return [
            { command: 'apt-get', args: ['update'] },
            { command: 'apt-get', args: ['install', '-y', 'ffmpeg', 'xvfb', 'x11vnc'] },
        ];
    case 'dnf':
        return [
            { command: 'dnf', args: ['install', '-y', 'ffmpeg', 'xorg-x11-server-Xvfb', 'x11vnc'] },
        ];
    case 'yum':
        return [
            { command: 'yum', args: ['install', '-y', 'ffmpeg', 'xorg-x11-server-Xvfb', 'x11vnc'] },
        ];
    case 'pacman':
        return [
            { command: 'pacman', args: ['-Sy', '--noconfirm', '--needed', 'ffmpeg', 'xorg-server-xvfb', 'x11vnc'] },
        ];
    case 'apk':
        return [
            { command: 'apk', args: ['add', 'ffmpeg', 'xvfb', 'x11vnc'] },
        ];
    default:
        return null;
    }
}

async function ensureLinuxBrowserExtras() {
    const missingBeforeInstall = await getMissingLinuxBrowserExtraCommands();
    if (missingBeforeInstall.length === 0) {
        console.log(c.green('  Linux browser extras ready.'));
        return;
    }

    const packageManager = await detectLinuxPackageManager();
    if (!packageManager) {
        throw new Error(
            `Missing Linux browser extras (${missingBeforeInstall.join(', ')}), and no supported package manager was found. Supported managers: apt-get, dnf, yum, pacman, apk.`,
        );
    }

    const installPlan = buildLinuxExtraInstallPlan(packageManager);
    if (!installPlan || installPlan.length === 0) {
        throw new Error(
            `Missing Linux browser extras (${missingBeforeInstall.join(', ')}), but automatic installation is not implemented for ${packageManager}.`,
        );
    }

    const privilegePrefix = await getPrivilegeEscalationPrefix();
    console.log(c.dim(`  Installing Linux browser extras via ${packageManager} (${missingBeforeInstall.join(', ')})...`));

    for (const step of installPlan) {
        await runProcess(
            privilegePrefix[0] ?? step.command,
            privilegePrefix.length > 0
                ? [...privilegePrefix.slice(1), step.command, ...step.args]
                : step.args,
        );
    }

    const missingAfterInstall = await getMissingLinuxBrowserExtraCommands();
    if (missingAfterInstall.length > 0) {
        throw new Error(
            `Linux browser extras are still missing after installation (${missingAfterInstall.join(', ')}).`,
        );
    }

    console.log(c.green('  Linux browser extras ready.'));
}

export async function ensureBrowserRuntimeDependencies() {
    if (isTruthyEnvFlag(process.env.ORCHESTRATOR_SKIP_BROWSER_SETUP)) {
        console.log(c.yellow('  Skipping browser runtime bootstrap because ORCHESTRATOR_SKIP_BROWSER_SETUP is enabled.'));
        return;
    }

    const patchrightCliPath = getPatchrightCliPath();
    if (!fs.existsSync(patchrightCliPath)) {
        throw new Error('Patchright is not installed in this workspace. Run `npm install` before `npm run setup`.');
    }

    console.log(c.bold('  Browser runtime'));
    console.log(
        c.dim(
            process.platform === 'linux'
                ? '  Installing Patchright Chromium and Linux browser dependencies (sudo may be required)...'
                : '  Installing Patchright Chromium runtime...',
        ),
    );

    const installArgs = ['install'];
    if (process.platform === 'linux') {
        installArgs.push('--with-deps');
    }
    installArgs.push('chromium');

    await runProcess(process.execPath, [patchrightCliPath, ...installArgs]);
    console.log(c.green('  Browser runtime ready.'));

    if (process.platform === 'linux') {
        await ensureLinuxBrowserExtras();
    }
}
