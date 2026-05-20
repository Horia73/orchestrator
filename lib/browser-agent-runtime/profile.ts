import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export function ensureBrowserProfileDir(
    profilePath: string,
    log: (message: string) => void,
    logError: (message: string, error?: unknown) => void,
): void {
    if (fs.existsSync(/* turbopackIgnore: true */ profilePath)) return;
    try {
        fs.mkdirSync(/* turbopackIgnore: true */ profilePath, { recursive: true });
        log(`📂 Created User Data Dir: ${profilePath}`);
    } catch (err) {
        logError(`❌ Failed to create User Data Dir: ${profilePath}`, err);
    }
}

export function isBrowserProfileInUseError(err: unknown): boolean {
    const message = formatBrowserError(err).toLowerCase();
    return message.includes('browser is already running')
        || message.includes('userdatadir')
        || message.includes('user data dir')
        || message.includes('user data directory')
        || message.includes('profile appears to be in use')
        || message.includes('processsingleton')
        || message.includes('singletonlock')
        || message.includes('singleton lock')
        || message.includes('lockfile');
}

export function killBrowserProcessesUsingPath(profilePath: string): number {
    const processes = browserProcessesUsingPath(profilePath);
    let killed = 0;
    for (const processInfo of processes) {
        try {
            process.kill(processInfo.pid, 'SIGTERM');
            killed += 1;
        } catch {
            // The process may have exited between ps and kill.
        }
    }
    return killed;
}

export function cleanupStaleBrowserProfileLocks(profilePath: string): number {
    if (!profilePath || browserProcessesUsingPath(profilePath).length > 0) return 0;

    let removed = 0;
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        const filePath = path.join(/* turbopackIgnore: true */ profilePath, name);
        try {
            fs.lstatSync(/* turbopackIgnore: true */ filePath);
            fs.rmSync(/* turbopackIgnore: true */ filePath, { force: true, recursive: false });
            removed += 1;
        } catch {
            // If the file disappeared or is not removable, Chromium will report it on launch.
        }
    }
    return removed;
}

export function formatBrowserError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

function browserProcessesUsingPath(profilePath: string): Array<{ pid: number; command: string }> {
    let output: string;
    try {
        output = execFileSync('ps', ['-axo', 'pid=,command='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch {
        return [];
    }

    const processes: Array<{ pid: number; command: string }> = [];
    for (const line of output.split('\n')) {
        if (!line.includes(profilePath)) continue;
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (!match) continue;
        const pid = Number(match[1]);
        const command = match[2];
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
        if (!/chrome|chromium|brave|edge/i.test(command)) continue;
        processes.push({ pid, command });
    }
    return processes;
}
