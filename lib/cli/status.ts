import { spawn } from 'child_process'
import { readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { CLI_IDS, CLI_SPECS, type CliId, type CliStatus } from './specs'
import { resolveBin, augmentedEnv } from './resolve-bin'
import { codexCliEnv, codexAuthFileExists } from './codex-env'

// `codex login status` cold-starts Node twice (version probe + status probe)
// and may make a network round-trip to validate the token; on a loaded box 8s
// was tight enough to time out intermittently. Give it more headroom — the
// last-good + on-disk fallback below means a longer timeout only costs the
// rare cold probe a little latency, it no longer flips the UI to disconnected.
const STATUS_TIMEOUT_MS = 12_000
const VERSION_TIMEOUT_MS = 5_000
const STATUS_CACHE_TTL_MS = 15_000

/**
 * When a fresh probe comes back *inconclusive* (timeout / cold start /
 * transient spawn error) we serve the last KNOWN-GOOD status instead of a
 * negative placeholder — but only for this long, so a CLI that genuinely got
 * logged out eventually surfaces as disconnected once the cached truth ages
 * out.
 */
const LAST_GOOD_MAX_AGE_MS = 5 * 60 * 1000

/**
 * Treat OAuth access tokens as "needs reconnect" once they're within this
 * window of expiry. Claude Code refreshes opportunistically, but a token that
 * expires mid-stream surfaces as a silent 401 to the user — better to flag
 * Settings as "Reconnect" 10 minutes before the cliff than after.
 */
const OAUTH_EXPIRY_REFRESH_THRESHOLD_MS = 10 * 60 * 1000

let cachedStatuses: { at: number; data: Record<CliId, CliStatus> } | null = null
/** Coalesces concurrent non-forced probes so a page-load burst (settings
 *  bootstrap + chat status + usage) spawns ONE set of CLI processes, not N
 *  that compete for CPU and time each other out. */
let inflight: Promise<Record<CliId, CliStatus>> | null = null
/** Last conclusively-healthy status per CLI, retained across flaky probes. */
const lastGood: Partial<Record<CliId, { at: number; status: CliStatus }>> = {}

/**
 * Result of a single status probe, tagged with whether we actually learned the
 * login state. `conclusive:false` means the probe couldn't answer (timeout,
 * cold start, transient spawn error) — NOT that the user is logged out. The
 * resolver leans on last-good / on-disk credentials before trusting a
 * non-conclusive negative.
 */
interface ProbeResult {
    status: CliStatus
    conclusive: boolean
}

type InstallProbe = 'yes' | 'no' | 'unknown'

/**
 * Return whether `bin` is reachable on PATH. We don't use `which`/`where`
 * because behaviour differs across platforms — a one-shot `--version` is
 * cheap and uniform. `no` = spawn error (ENOENT → genuinely missing), `yes` =
 * it executed, `unknown` = it ran too slowly to answer (box under load).
 */
async function probeInstalled(bin: string): Promise<InstallProbe> {
    return new Promise(resolve => {
        const resolved = resolveBin(bin)
        const proc = spawn(resolved, ['--version'], {
            stdio: ['ignore', 'ignore', 'ignore'],
            env: augmentedEnv(),
        })
        const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve('unknown') }, VERSION_TIMEOUT_MS)
        proc.on('error', () => { clearTimeout(timer); resolve('no') })
        proc.on('exit', () => { clearTimeout(timer); resolve('yes') })
    })
}

function envForCli(id: CliId): NodeJS.ProcessEnv {
    return id === 'codex' ? codexCliEnv() : augmentedEnv()
}

/**
 * Run the configured `statusArgs` for a CLI and parse the output. Times out
 * after STATUS_TIMEOUT_MS to avoid blocking the settings page if a CLI hangs.
 *
 * Returns a {@link ProbeResult}: only a clean parse (or a definitively-missing
 * binary) is `conclusive`. Timeouts and transient spawn errors are reported as
 * `conclusive:false` so {@link resolveStatus} can prefer real evidence over a
 * false "logged out".
 */
async function runStatus(id: CliId): Promise<ProbeResult> {
    const spec = CLI_SPECS[id]

    const install = await probeInstalled(spec.bin)
    if (install === 'no') {
        return { status: { installed: false, loggedIn: false }, conclusive: true }
    }
    if (install === 'unknown') {
        // The binary was too slow to even print its version — the status
        // subcommand will almost certainly time out too. Skip it and let the
        // resolver fall back to on-disk credentials / last-good.
        return { status: { installed: true, loggedIn: false, detail: 'version check timed out' }, conclusive: false }
    }

    return new Promise<ProbeResult>(resolve => {
        const resolvedBin = resolveBin(spec.bin)
        const proc = spawn(resolvedBin, spec.statusArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: envForCli(id),
        })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
            proc.kill('SIGKILL')
            resolve({
                status: { installed: true, loggedIn: false, detail: 'status check timed out', raw: stdout },
                conclusive: false,
            })
        }, STATUS_TIMEOUT_MS)

        proc.stdout.on('data', chunk => { stdout += chunk.toString() })
        proc.stderr.on('data', chunk => { stderr += chunk.toString() })
        proc.on('error', err => {
            clearTimeout(timer)
            // The install probe already confirmed the binary runs, so a spawn
            // error here is transient, not proof of logout.
            resolve({ status: { installed: true, loggedIn: false, detail: err.message }, conclusive: false })
        })
        proc.on('exit', code => {
            clearTimeout(timer)
            try {
                resolve({ status: spec.parseStatus(stdout, stderr, code ?? 0), conclusive: true })
            } catch (err) {
                resolve({
                    status: {
                        installed: true,
                        loggedIn: false,
                        detail: err instanceof Error ? err.message : 'parse failed',
                        raw: stdout,
                    },
                    conclusive: false,
                })
            }
        })
    })
}

/**
 * Positive on-disk evidence that a CLI is authenticated, used only to override
 * an inconclusive probe. Presence is a fallback "logged in" signal; absence is
 * never treated as proof of logout (e.g. Claude Code keychain logins have no
 * credentials file).
 */
function authFileExists(id: CliId): boolean {
    if (id === 'codex') return codexAuthFileExists()
    try {
        return statSync(join(homedir(), '.claude', '.credentials.json')).size > 0
    } catch {
        return false
    }
}

/**
 * Collapse a {@link ProbeResult} into the status we expose. A conclusive probe
 * is authoritative (and refreshes last-good when healthy). An inconclusive one
 * prefers, in order: recent last-good → on-disk credentials → the raw negative.
 */
function resolveStatus(id: CliId, probe: ProbeResult): CliStatus {
    if (probe.conclusive) {
        if (probe.status.loggedIn && !probe.status.needsReconnect) {
            lastGood[id] = { at: Date.now(), status: probe.status }
        }
        return probe.status
    }

    const prev = lastGood[id]
    if (prev && Date.now() - prev.at < LAST_GOOD_MAX_AGE_MS) {
        return prev.status
    }
    if (authFileExists(id)) {
        return { installed: true, loggedIn: true }
    }
    return probe.status
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

/** Probe every CLI once, enrich + resolve, and refresh the shared cache. */
async function probeAllCliStatuses(): Promise<Record<CliId, CliStatus>> {
    const entries = await Promise.all(
        CLI_IDS.map(async id => {
            const probe = await runStatus(id)
            const enriched: ProbeResult = {
                conclusive: probe.conclusive,
                status: enrichWithCredentialMetadata(id, probe.status),
            }
            return [id, resolveStatus(id, enriched)] as const
        })
    )
    const result = {} as Record<CliId, CliStatus>
    for (const [id, status] of entries) {
        result[id] = status
    }
    cachedStatuses = { at: Date.now(), data: result }
    return result
}

/** Status snapshot for all configured CLIs. Used by /api/cli/status. */
export async function getAllCliStatuses(options?: {
    force?: boolean
    ttlMs?: number
}): Promise<Record<CliId, CliStatus>> {
    // A forced refresh (Settings → Auth "Recheck", usage accounting) always
    // runs its own probe so it stays authoritative — it never piggybacks on an
    // in-flight non-forced run.
    if (options?.force) {
        return probeAllCliStatuses()
    }

    const ttlMs = options?.ttlMs ?? STATUS_CACHE_TTL_MS
    if (cachedStatuses && Date.now() - cachedStatuses.at < ttlMs) {
        return cachedStatuses.data
    }

    if (inflight) return inflight
    inflight = probeAllCliStatuses().finally(() => { inflight = null })
    return inflight
}
