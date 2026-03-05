import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function runCommand(binary, args, {
    cwd = process.cwd(),
    timeout = 15000,
} = {}) {
    return execFileSync(binary, args, {
        cwd,
        timeout,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
    }).trim();
}

export function runGit(args, options = {}) {
    return runCommand('git', args, options);
}

function parsePackageVersion(rawContent) {
    try {
        const parsed = JSON.parse(String(rawContent ?? ''));
        const version = String(parsed?.version ?? '').trim();
        return version || null;
    } catch {
        return null;
    }
}

export function readLocalPackageVersion() {
    try {
        const raw = fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8');
        return parsePackageVersion(raw) ?? '0.0.0';
    } catch {
        return '0.0.0';
    }
}

function readRemotePackageVersion(remoteRef) {
    try {
        const raw = runGit(['show', `${remoteRef}:package.json`], { timeout: 10000 });
        return parsePackageVersion(raw);
    } catch {
        return null;
    }
}

export function formatCommandError(error, fallbackMessage = 'Command failed') {
    const stderr = String(error?.stderr ?? '').trim();
    const stdout = String(error?.stdout ?? '').trim();
    const message = String(error?.message ?? '').trim();
    return stderr || stdout || message || fallbackMessage;
}

export function getGitUpdateSnapshot({
    fetchRemote = true,
} = {}) {
    const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') {
        throw new Error('Current git checkout is detached (HEAD). Switch to a branch first.');
    }

    let remoteRef = '';
    try {
        remoteRef = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    } catch {
        remoteRef = `origin/${branch}`;
    }

    const remoteRefParts = remoteRef.split('/');
    const remoteName = remoteRefParts[0] || 'origin';
    const remoteBranch = remoteRefParts.slice(1).join('/') || branch;

    if (fetchRemote) {
        runGit(['fetch', remoteName, remoteBranch, '--tags', '--quiet'], { timeout: 30000 });
    }

    const localSha = runGit(['rev-parse', 'HEAD']);
    const remoteSha = runGit(['rev-parse', remoteRef]);
    const aheadBehindRaw = runGit(['rev-list', '--left-right', '--count', `${localSha}...${remoteSha}`]);
    const [aheadRaw = '0', behindRaw = '0'] = aheadBehindRaw.split(/\s+/);
    const ahead = Number.parseInt(aheadRaw, 10) || 0;
    const behind = Number.parseInt(behindRaw, 10) || 0;

    let status = 'up-to-date';
    if (behind > 0 && ahead === 0) {
        status = 'update-available';
    } else if (behind === 0 && ahead > 0) {
        status = 'ahead';
    } else if (behind > 0 && ahead > 0) {
        status = 'diverged';
    }

    let localCommitDate = null;
    let remoteCommitDate = null;
    try {
        localCommitDate = runGit(['show', '-s', '--format=%cI', localSha], { timeout: 10000 }) || null;
    } catch {
        localCommitDate = null;
    }
    try {
        remoteCommitDate = runGit(['show', '-s', '--format=%cI', remoteSha], { timeout: 10000 }) || null;
    } catch {
        remoteCommitDate = null;
    }

    return {
        branch,
        remoteRef,
        localSha,
        localShaShort: localSha.slice(0, 7),
        remoteSha,
        remoteShaShort: remoteSha.slice(0, 7),
        ahead,
        behind,
        status,
        canInstall: behind > 0 && ahead === 0,
        localCommitDate,
        remoteCommitDate,
        localVersion: readLocalPackageVersion(),
        remoteVersion: readRemotePackageVersion(remoteRef),
    };
}
