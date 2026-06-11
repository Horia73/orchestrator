import { spawn } from 'child_process'

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
    void id
    return codexCliEnv()
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

        proc.stdout.setEncoding('utf8')
        proc.stderr.setEncoding('utf8')
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
 * never treated as proof of logout.
 */
function authFileExists(id: CliId): boolean {
    void id
    return codexAuthFileExists()
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

/** Probe every CLI once, enrich + resolve, and refresh the shared cache. */
async function probeAllCliStatuses(): Promise<Record<CliId, CliStatus>> {
    const entries = await Promise.all(
        CLI_IDS.map(async id => {
            const probe = await runStatus(id)
            return [id, resolveStatus(id, probe)] as const
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
