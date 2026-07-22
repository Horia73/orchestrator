import fs from 'fs'
import os from 'os'
import path from 'path'

import { PRIVATE_STATE_DIR } from '@/lib/runtime-paths'
import { agentCommandEnv } from './resolve-bin'

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

export function codexAuthPaths(): string[] {
    return [...new Set([
        codexRuntimeAuthPath(),
        path.join(os.homedir(), '.codex', 'auth.json'),
    ])]
}

const CODEX_MAINTENANCE_LOCK_STALE_MS = 2 * 60 * 60_000

export function codexRuntimeMaintenanceLockPath(codexHome = codexRuntimeCodexHome()): string {
    return path.join(codexHome, '.orchestrator-maintenance.lock')
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
    if (codexRuntimeMaintenanceActive()) {
        throw new Error('Codex runtime maintenance is in progress; retry shortly.')
    }
    return buildCodexCliEnv(extra)
}

/** Maintenance owns the exclusive runtime lock, so it must bypass the normal
 * launch guard when it starts Codex app-server for official thread/delete. */
export function codexMaintenanceCliEnv(
    extra?: Record<string, string | undefined>,
    codexHome = codexRuntimeCodexHome()
): NodeJS.ProcessEnv {
    if (path.resolve(codexHome) === path.resolve(codexRuntimeCodexHome())) {
        return buildCodexCliEnv(extra)
    }
    fs.mkdirSync(codexHome, { recursive: true })
    return {
        ...agentCommandEnv(extra),
        HOME: path.dirname(codexHome),
        CODEX_HOME: codexHome,
    }
}

function buildCodexCliEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const runtimeHome = prepareCodexRuntimeHome()
    return {
        ...agentCommandEnv(extra),
        HOME: runtimeHome,
        CODEX_HOME: path.join(runtimeHome, '.codex'),
    }
}

export function codexRuntimeMaintenanceActive(
    now = Date.now(),
    codexHome = codexRuntimeCodexHome()
): boolean {
    const lockPath = codexRuntimeMaintenanceLockPath(codexHome)
    try {
        const age = now - fs.statSync(lockPath).mtimeMs
        if (age <= CODEX_MAINTENANCE_LOCK_STALE_MS) return true
        fs.rmSync(lockPath, { force: true })
        return false
    } catch {
        return false
    }
}

export function acquireCodexRuntimeMaintenanceLock(
    now = Date.now(),
    codexHome = codexRuntimeCodexHome()
): (() => void) | null {
    fs.mkdirSync(codexHome, { recursive: true })
    const lockPath = codexRuntimeMaintenanceLockPath(codexHome)
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const fd = fs.openSync(lockPath, 'wx', 0o600)
            try {
                fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() })}\n`)
            } finally {
                fs.closeSync(fd)
            }
            return () => {
                try {
                    fs.rmSync(lockPath, { force: true })
                } catch {
                    // The stale-lock path is fail-safe; the next run can recover.
                }
            }
        } catch (error) {
            if (!isAlreadyExists(error)) throw error
            if (codexRuntimeMaintenanceActive(now, codexHome)) return null
        }
    }
    return null
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
    return codexAuthPaths().some(candidate => {
        try {
            return fs.statSync(candidate).size > 0
        } catch {
            return false
        }
    })
}

/**
 * Remove every Codex credential copy managed or imported by Orchestrator.
 *
 * Codex runs with an isolated HOME, but that runtime is initially seeded from
 * the user's real ~/.codex/auth.json. Running `codex logout` only inside the
 * isolated HOME removes the runtime copy; the next status check would otherwise
 * import the source copy again and make the account appear logged in. Logout is
 * therefore complete only after both files are gone.
 */
export function clearCodexAuthFiles(paths: string[] = codexAuthPaths()): void {
    const failures: string[] = []
    for (const authPath of new Set(paths)) {
        try {
            fs.rmSync(authPath, { force: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push(`${authPath}: ${message}`)
        }
    }
    if (failures.length > 0) {
        throw new Error(`Failed to remove Codex credentials: ${failures.join('; ')}`)
    }
}

/**
 * Return true only when both independent Codex account surfaces rejected the
 * same saved credentials. A single quota endpoint can fail for reasons that do
 * not affect model access, so callers must not log the user out on one signal.
 */
export function codexAuthRejectedByBoth(
    appServerError: string | null | undefined,
    usageEndpointError: string | null | undefined
): boolean {
    return isCodexAuthRejection(appServerError) && isCodexAuthRejection(usageEndpointError)
}

function isCodexAuthRejection(error: string | null | undefined): boolean {
    const message = (error ?? '').toLowerCase()
    if (!message) return false
    return (
        message.includes('401 unauthorized') ||
        message.includes('403 forbidden') ||
        message.includes('token_expired') ||
        message.includes('authentication token is expired') ||
        message.includes('refresh token was revoked') ||
        message.includes('refresh token has been revoked') ||
        message.includes('rejected auth after an automatic refresh')
    )
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

function isAlreadyExists(error: unknown): boolean {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
}
