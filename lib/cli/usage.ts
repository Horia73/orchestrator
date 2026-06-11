/**
 * CLI subscription quota reader.
 *
 * Codex CLI quota comes from chatgpt.com/backend-api/wham/usage with the
 * OAuth token from ~/.codex/auth.json. This is the endpoint codex's own
 * `/status` panel polls every 60s; see codex-rs/backend-client/src/client.rs::
 * get_rate_limits.
 */
import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { codexCliEnv, codexRuntimeAuthPath, prepareCodexRuntimeHome } from './codex-env'
import { resolveBin } from './resolve-bin'
import { activeRuntimePaths } from '@/lib/runtime-paths'

export interface CliQuotaWindow {
    /** Percent of the window used, 0-100. */
    usedPercent: number
    /** Unix epoch seconds at which this window resets. */
    resetsAt: number
    /** Window length in seconds, when the source reports it authoritatively. */
    windowSeconds?: number
}

export interface CliQuotaSnapshot {
    cliId: 'codex'
    /** True when we successfully read a fresh snapshot. */
    available: boolean
    /** When `available` is false, a human-readable reason. */
    error?: string
    /** Rolling 5-hour window. */
    fiveHour?: CliQuotaWindow
    /** Rolling 7-day window. */
    weekly?: CliQuotaWindow
    /** Where this snapshot came from, surfaced for the UI's source line. */
    source: 'api' | 'none'
    /** Unix ms when the snapshot was captured. */
    fetchedAt: number
    /** Unix ms of the underlying data point itself. */
    dataTimestamp?: number
}

export type CliQuotaId = CliQuotaSnapshot['cliId']

const USER_CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json')
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_USAGE_TIMEOUT_MS = 8_000
const CODEX_AUTH_REFRESH_TIMEOUT_MS = 15_000

interface CodexAuthFile {
    tokens?: {
        access_token?: string
        account_id?: string
    }
}

interface CodexUsageWindow {
    used_percent?: number
    limit_window_seconds?: number
    reset_after_seconds?: number
    reset_at?: number
}

interface CodexUsageResponse {
    rate_limit?: {
        primary_window?: CodexUsageWindow
        secondary_window?: CodexUsageWindow
    }
}

function readCodexAuth(): { token: string; accountId: string } | null {
    prepareCodexRuntimeHome()
    const runtimeAuthPath = codexRuntimeAuthPath()
    const paths = runtimeAuthPath === USER_CODEX_AUTH_PATH
        ? [runtimeAuthPath]
        : [runtimeAuthPath, USER_CODEX_AUTH_PATH]

    for (const authPath of paths) {
        if (!existsSync(authPath)) continue
        const parsed = readCodexAuthFile(authPath)
        if (parsed) return parsed
    }
    return null
}

function readCodexAuthFile(authPath: string): { token: string; accountId: string } | null {
    try {
        const raw = readFileSync(authPath, 'utf-8')
        const parsed = JSON.parse(raw) as CodexAuthFile
        const token = parsed.tokens?.access_token
        const accountId = parsed.tokens?.account_id
        if (!token || !accountId) return null
        return { token, accountId }
    } catch {
        return null
    }
}

function codexWindow(w: CodexUsageWindow | undefined): CliQuotaWindow | undefined {
    if (!w || typeof w.used_percent !== 'number') return undefined
    let resetsAt = typeof w.reset_at === 'number' ? w.reset_at : 0
    if (!resetsAt && typeof w.reset_after_seconds === 'number') {
        resetsAt = Math.floor(Date.now() / 1000) + w.reset_after_seconds
    }
    const windowSeconds = typeof w.limit_window_seconds === 'number' && w.limit_window_seconds > 0
        ? w.limit_window_seconds
        : undefined
    return { usedPercent: w.used_percent, resetsAt, ...(windowSeconds ? { windowSeconds } : {}) }
}

async function refreshCodexAuth(): Promise<boolean> {
    prepareCodexRuntimeHome()
    const codexBin = resolveBin('codex')
    if (codexBin === 'codex') return false

    return new Promise(resolve => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | null = null
        const finish = (ok: boolean) => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            resolve(ok)
        }

        let proc: ReturnType<typeof spawn>
        try {
            // `codex login status` refreshes stale OAuth credentials before it
            // reports "Logged in". The quota endpoint reads auth.json directly,
            // so trigger the same refresh path before deciding auth is expired.
            proc = spawn(codexBin, ['login', 'status'], {
                stdio: ['ignore', 'ignore', 'ignore'],
                env: codexCliEnv({ DISABLE_TELEMETRY: '1' }),
                cwd: activeRuntimePaths().agentWorkspaceDir,
            })
        } catch {
            finish(false)
            return
        }

        timer = setTimeout(() => {
            try { proc.kill('SIGKILL') } catch { /* ignore */ }
            finish(false)
        }, CODEX_AUTH_REFRESH_TIMEOUT_MS)

        proc.on('error', () => finish(false))
        proc.on('exit', code => finish(code === 0))
    })
}

async function fetchCodexUsage(auth: { token: string; accountId: string }): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CODEX_USAGE_TIMEOUT_MS)
    return fetch(CODEX_USAGE_URL, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${auth.token}`,
            // Both casings are used by codex CLI in different versions.
            'chatgpt-account-id': auth.accountId,
            // Cloudflare gates this endpoint to the codex client UA.
            Originator: 'codex_cli_rs',
            'User-Agent': 'codex_cli_rs/0.0.0',
            Accept: 'application/json',
        },
        signal: controller.signal,
    }).finally(() => clearTimeout(timer))
}

async function getCodexQuota(): Promise<CliQuotaSnapshot> {
    const fetchedAt = Date.now()
    let auth = readCodexAuth()
    if (!auth) {
        return {
            cliId: 'codex',
            available: false,
            error: 'Not logged in (no Codex auth in Orchestrator runtime or ~/.codex/auth.json).',
            source: 'none',
            fetchedAt,
        }
    }

    try {
        let res = await fetchCodexUsage(auth)

        if (res.status === 401 || res.status === 403) {
            const refreshed = await refreshCodexAuth()
            auth = refreshed ? readCodexAuth() : auth
            if (refreshed && auth) {
                res = await fetchCodexUsage(auth)
            }
        }

        if (res.status === 401 || res.status === 403) {
            return {
                cliId: 'codex',
                available: false,
                error: 'Codex quota endpoint rejected auth after an automatic refresh. Codex model access may still work; run `codex login` if this quota card keeps failing.',
                source: 'api',
                fetchedAt,
            }
        }
        if (!res.ok) {
            return {
                cliId: 'codex',
                available: false,
                error: `Usage endpoint returned HTTP ${res.status}.`,
                source: 'api',
                fetchedAt,
            }
        }

        const json = (await res.json()) as CodexUsageResponse
        const fiveHour = codexWindow(json.rate_limit?.primary_window)
        const weekly = codexWindow(json.rate_limit?.secondary_window)

        if (!fiveHour && !weekly) {
            return {
                cliId: 'codex',
                available: false,
                error: 'Endpoint returned no rate-limit windows.',
                source: 'api',
                fetchedAt,
            }
        }

        return {
            cliId: 'codex',
            available: true,
            fiveHour,
            weekly,
            source: 'api',
            fetchedAt,
            dataTimestamp: fetchedAt,
        }
    } catch (err) {
        return {
            cliId: 'codex',
            available: false,
            error: err instanceof Error ? err.message : 'Network error.',
            source: 'api',
            fetchedAt,
        }
    }
}

export async function getCliQuota(cliId: CliQuotaId): Promise<CliQuotaSnapshot> {
    void cliId
    return getCodexQuota()
}

export async function getAllCliQuotas(): Promise<Record<CliQuotaId, CliQuotaSnapshot>> {
    return {
        codex: await getCodexQuota(),
    }
}
