import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { CLI_IDS, CLI_SPECS, type CliId, type CliStatus } from './specs'
import { resolveBin, augmentedEnv } from './resolve-bin'
import { codexCliEnv } from './codex-env'

const STATUS_TIMEOUT_MS = 8000
const STATUS_CACHE_TTL_MS = 15_000

/**
 * Treat OAuth access tokens as "needs reconnect" once they're within this
 * window of expiry. Claude Code refreshes opportunistically, but a token that
 * expires mid-stream surfaces as a silent 401 to the user — better to flag
 * Settings as "Reconnect" 10 minutes before the cliff than after.
 */
const OAUTH_EXPIRY_REFRESH_THRESHOLD_MS = 10 * 60 * 1000

let cachedStatuses: { at: number; data: Record<CliId, CliStatus> } | null = null

/**
 * Return whether `bin` is reachable on PATH. We don't use `which`/`where`
 * because behaviour differs across platforms — a one-shot `--version` is
 * cheap and uniform; ENOENT means missing.
 */
async function isInstalled(bin: string): Promise<boolean> {
    return new Promise(resolve => {
        const resolved = resolveBin(bin)
        const proc = spawn(resolved, ['--version'], {
            stdio: ['ignore', 'ignore', 'ignore'],
            env: augmentedEnv(),
        })
        const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(false) }, 3000)
        proc.on('error', () => { clearTimeout(timer); resolve(false) })
        proc.on('exit', code => { clearTimeout(timer); resolve(code === 0) })
    })
}

function envForCli(id: CliId): NodeJS.ProcessEnv {
    return id === 'codex' ? codexCliEnv() : augmentedEnv()
}

/**
 * Run the configured `statusArgs` for a CLI and parse the output. Times out
 * after STATUS_TIMEOUT_MS to avoid blocking the settings page if a CLI hangs.
 */
async function runStatus(id: CliId): Promise<CliStatus> {
    const spec = CLI_SPECS[id]

    if (!await isInstalled(spec.bin)) {
        return { installed: false, loggedIn: false }
    }

    return new Promise<CliStatus>(resolve => {
        const resolvedBin = resolveBin(spec.bin)
        const proc = spawn(resolvedBin, spec.statusArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: envForCli(id),
        })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
            proc.kill('SIGKILL')
            resolve({ installed: true, loggedIn: false, detail: 'status check timed out', raw: stdout })
        }, STATUS_TIMEOUT_MS)

        proc.stdout.on('data', chunk => { stdout += chunk.toString() })
        proc.stderr.on('data', chunk => { stderr += chunk.toString() })
        proc.on('error', err => {
            clearTimeout(timer)
            resolve({ installed: false, loggedIn: false, detail: err.message })
        })
        proc.on('exit', code => {
            clearTimeout(timer)
            try {
                resolve(spec.parseStatus(stdout, stderr, code ?? 0))
            } catch (err) {
                resolve({
                    installed: true,
                    loggedIn: false,
                    detail: err instanceof Error ? err.message : 'parse failed',
                    raw: stdout,
                })
            }
        })
    })
}

/**
 * Inspect the on-disk credentials file for a CLI and decide whether the
 * session is healthy, expiring soon, or already dead. `claude auth status`
 * only reports presence — it returns `loggedIn:true` even for tokens that
 * expired days ago, which silently breaks chat with a 401 mid-stream.
 *
 * We only enrich `claude-code` today; codex doesn't expose its tokens in a
 * file we can portably read.
 */
function enrichWithCredentialMetadata(id: CliId, status: CliStatus): CliStatus {
    if (!status.loggedIn || id !== 'claude-code') return status

    // Claude Code's `auth status` reports the auth source it actually used:
    //   "claude.ai"   → browser OAuth, refreshed from .credentials.json
    //   "oauth_token" → CLAUDE_CODE_OAUTH_TOKEN env (long-lived, doesn't expire)
    //   "api_key"     → ANTHROPIC_API_KEY env
    // When the CLI is using a non-keychain source, the .credentials.json
    // file's expiry is irrelevant — env-var tokens win, and they don't
    // expire on the same clock. Skip enrichment to avoid a false "Reconnect"
    // badge on headless installs that already moved to a long-lived token.
    let runtimeAuthMethod: string | undefined
    try {
        const parsedRaw = status.raw ? JSON.parse(status.raw) as Record<string, unknown> : null
        const v = parsedRaw?.authMethod
        runtimeAuthMethod = typeof v === 'string' ? v : undefined
    } catch {
        /* raw isn't JSON — fall through */
    }

    if (runtimeAuthMethod === 'oauth_token') {
        return {
            ...status,
            authMethod: 'setup-token',
            // Override the (stale) `claude.ai · expired Nd ago` shape the
            // earlier code path would have produced — long-lived tokens
            // don't expire from a per-request perspective.
            detail: status.detail?.replace(/\s*·?\s*expired[^·]*$/i, '').trim() || undefined,
        }
    }
    if (runtimeAuthMethod === 'api_key') {
        return { ...status, authMethod: 'api-key' }
    }

    const credentialsPath = join(homedir(), '.claude', '.credentials.json')
    let raw: string
    try {
        raw = readFileSync(credentialsPath, 'utf-8')
    } catch {
        // File missing despite `loggedIn:true` from the CLI — the CLI knows
        // about a session we can't introspect (e.g. macOS Keychain). Leave
        // the status alone; the CLI's own answer is authoritative.
        return status
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return status
    }

    const oauth = (parsed as { claudeAiOauth?: Record<string, unknown> })?.claudeAiOauth
    if (oauth && typeof oauth === 'object') {
        const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined
        const now = Date.now()
        const enriched: CliStatus = {
            ...status,
            authMethod: 'oauth',
            expiresAt,
        }
        if (typeof expiresAt === 'number' && expiresAt - now < OAUTH_EXPIRY_REFRESH_THRESHOLD_MS) {
            // Token already expired (or expiring in the next 10 min) and the
            // CLI didn't refresh it. Mark as needs-reconnect so the UI can
            // prompt before the user fires a chat and hits a 401.
            enriched.needsReconnect = true
            const expiredAgoMs = now - expiresAt
            enriched.detail = enriched.detail
                ? `${enriched.detail} · ${describeExpiry(expiredAgoMs)}`
                : describeExpiry(expiredAgoMs)
        }
        return enriched
    }

    // Long-lived `claude setup-token` stores under a different key; presence
    // alone is enough — those tokens are static API keys.
    const setupToken = (parsed as { primaryApiKey?: unknown; apiKey?: unknown; setupToken?: unknown })
    if (setupToken?.primaryApiKey || setupToken?.apiKey || setupToken?.setupToken) {
        return { ...status, authMethod: 'setup-token' }
    }

    return status
}

function describeExpiry(expiredAgoMs: number): string {
    if (expiredAgoMs < 0) {
        const inMs = -expiredAgoMs
        if (inMs < 60_000) return 'expires in <1m'
        if (inMs < 3_600_000) return `expires in ${Math.round(inMs / 60_000)}m`
        return `expires in ${Math.round(inMs / 3_600_000)}h`
    }
    if (expiredAgoMs < 60_000) return 'expired just now'
    if (expiredAgoMs < 3_600_000) return `expired ${Math.round(expiredAgoMs / 60_000)}m ago`
    if (expiredAgoMs < 86_400_000) return `expired ${Math.round(expiredAgoMs / 3_600_000)}h ago`
    return `expired ${Math.round(expiredAgoMs / 86_400_000)}d ago`
}

/** Status snapshot for all configured CLIs. Used by /api/cli/status. */
export async function getAllCliStatuses(options?: {
    force?: boolean
    ttlMs?: number
}): Promise<Record<CliId, CliStatus>> {
    const ttlMs = options?.ttlMs ?? STATUS_CACHE_TTL_MS
    if (!options?.force && cachedStatuses && Date.now() - cachedStatuses.at < ttlMs) {
        return cachedStatuses.data
    }

    const entries = await Promise.all(
        CLI_IDS.map(async id => [id, enrichWithCredentialMetadata(id, await runStatus(id))] as const)
    )
    const result = {} as Record<CliId, CliStatus>
    for (const [id, status] of entries) {
        result[id] = status
    }
    cachedStatuses = { at: Date.now(), data: result }
    return result
}
