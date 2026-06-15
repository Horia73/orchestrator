import fs from 'fs'
import os from 'os'
import path from 'path'

import { PRIVATE_STATE_DIR } from '@/lib/runtime-paths'
import { augmentedEnv } from './resolve-bin'

/**
 * Codex runtime home is SHARED across all profiles, not per-profile.
 *
 * Codex authenticates with a single OAuth account (one device login), so every
 * profile should run against the same credentials. We deliberately anchor on the
 * admin/root private dir ({@link PRIVATE_STATE_DIR}) rather than the active
 * profile's `privateStateDir`. The old per-profile layout broke non-admin
 * profiles: each profile got its own isolated runtime home seeded once from the
 * shared `~/.codex/auth.json`, but OAuth token refresh writes back only into the
 * home that refreshed it. Once one profile (admin) refreshed — rotating the
 * shared refresh token server-side — every other profile was stranded on an
 * expired, now-unrefreshable copy, so codex failed there and the orchestrator
 * fell through to its (unconfigured) provider fallback. One shared home means a
 * refresh by any profile keeps codex alive for all of them.
 */
export function codexRuntimeHome(): string {
    return path.join(PRIVATE_STATE_DIR, 'codex-runtime-home')
}

export function codexRuntimeCodexHome(): string {
    return path.join(codexRuntimeHome(), '.codex')
}

export function codexRuntimeAuthPath(): string {
    return path.join(codexRuntimeCodexHome(), 'auth.json')
}

function runtimeConfigPath(): string {
    return path.join(codexRuntimeCodexHome(), 'config.toml')
}

const SANITIZED_CONFIG = [
    '# Managed by Orchestrator.',
    '# Keep Codex app-server isolated from user MCP config that may differ by CLI version.',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    '[features]',
    'multi_agent = false',
    'apps = false',
    'plugins = false',
    'skills = false',
    '',
].join('\n')

export function codexCliEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const runtimeHome = prepareCodexRuntimeHome()
    return {
        ...augmentedEnv(extra),
        HOME: runtimeHome,
        CODEX_HOME: path.join(runtimeHome, '.codex'),
    }
}

export function prepareCodexRuntimeHome(): string {
    fs.mkdirSync(codexRuntimeCodexHome(), { recursive: true })
    writeSanitizedConfig()
    syncAuthFile()
    return codexRuntimeHome()
}

/**
 * Cheap, synchronous check for whether Codex has credentials on disk.
 *
 * Used as a fallback "logged in" signal when `codex login status` is too slow
 * to answer (cold Node start / CPU contention / transient network) — the
 * presence of a non-empty `auth.json` is a far more stable truth than a probe
 * that timed out. We check the isolated runtime home first (where device-auth
 * and {@link syncAuthFile} land tokens), then the user's real `~/.codex`.
 *
 * Absence is NOT treated as proof of logout by callers — this only provides a
 * positive signal to override an inconclusive probe.
 */
export function codexAuthFileExists(): boolean {
    const candidates = [codexRuntimeAuthPath(), path.join(os.homedir(), '.codex', 'auth.json')]
    return candidates.some(candidate => {
        try {
            return fs.statSync(candidate).size > 0
        } catch {
            return false
        }
    })
}

function writeSanitizedConfig(): void {
    try {
        const configPath = runtimeConfigPath()
        const existing = fs.existsSync(configPath)
            ? fs.readFileSync(configPath, 'utf-8')
            : null
        if (existing !== SANITIZED_CONFIG) {
            fs.writeFileSync(configPath, SANITIZED_CONFIG, { encoding: 'utf-8', mode: 0o600 })
        }
    } catch {
        // Let Codex surface a concrete auth/config error if the runtime home is not writable.
    }
}

function syncAuthFile(): void {
    const source = path.join(os.homedir(), '.codex', 'auth.json')
    const target = codexRuntimeAuthPath()
    if (source === target || !fs.existsSync(source)) return

    try {
        const sourceStat = fs.statSync(source)
        const targetStat = fs.existsSync(target) ? fs.statSync(target) : null
        if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs) return
        fs.copyFileSync(source, target)
        fs.chmodSync(target, 0o600)
    } catch {
        // Best effort. Device auth through Orchestrator writes directly into the runtime home.
    }
}
