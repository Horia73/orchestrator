/**
 * CLI subscription quota readers.
 *
 * Both Claude Code and Codex CLI enforce a 5-hour rolling window and a
 * 7-day window on top of any per-request rate limiting.
 *
 *   - claude-code → spawn the CLI in a PTY, type `/usage`, scrape the rendered
 *     TUI panel. Docker installs prefer the token-protected host bridge so the
 *     TUI runs where the user's Claude subscription login actually lives. There
 *     is no public `--usage --json` flag and the undocumented OAuth usage
 *     endpoint is heavily rate-limited from third parties, so we mirror what a
 *     human would do.
 *
 *   - codex → chatgpt.com/backend-api/wham/usage with the OAuth token from
 *     ~/.codex/auth.json (this is the endpoint codex's own `/status` panel
 *     polls every 60s; see codex-rs/backend-client/src/client.rs::
 *     get_rate_limits).
 */
import { spawn } from 'child_process'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { spawn as ptySpawn } from 'node-pty'

import { resolveBin, augmentedEnv } from './resolve-bin'
import { codexCliEnv, codexRuntimeAuthPath, prepareCodexRuntimeHome } from './codex-env'
import { getAllCliStatuses } from './status'
import { activeRuntimePaths } from '@/lib/runtime-paths'

export interface CliQuotaWindow {
    /** Percent of the window used, 0–100. */
    usedPercent: number
    /** Unix epoch seconds at which this window resets. */
    resetsAt: number
    /**
     * Window length in seconds, when the source reports it authoritatively
     * (Codex's `limit_window_seconds`). Omitted for Claude Code, whose windows
     * are the fixed 5h / 7d — consumers fall back to those constants. Used to
     * project when the window will run out at the current burn rate.
     */
    windowSeconds?: number
}

export interface CliQuotaSnapshot {
    cliId: 'claude-code' | 'codex'
    /** True when we successfully read a fresh snapshot. */
    available: boolean
    /** When `available` is false, a human-readable reason. */
    error?: string
    /** Rolling 5-hour window. */
    fiveHour?: CliQuotaWindow
    /** Rolling 7-day window (all models). */
    weekly?: CliQuotaWindow
    /** Sonnet-specific 7-day window — Claude Code only. */
    weeklySonnet?: CliQuotaWindow
    /** Where this snapshot came from, surfaced for the UI's "source" line. */
    source: 'api' | 'host-bridge' | 'log' | 'tui' | 'none'
    /** Unix ms when the snapshot was captured. */
    fetchedAt: number
    /**
     * Unix ms of the underlying data point itself. For the API path this
     * matches fetchedAt; for the log path it's when the row was written, which
     * may be hours behind if the CLI hasn't been used recently.
     */
    dataTimestamp?: number
}

export type CliQuotaId = CliQuotaSnapshot['cliId']

// ---------------------------------------------------------------------------
// Claude Code — scrape the /usage TUI panel
// ---------------------------------------------------------------------------

const CLAUDE_USAGE_TIMEOUT_MS = 30_000
const CLAUDE_USAGE_RETRY_DELAY_MS = 500
const CLAUDE_USAGE_HOST_BRIDGE_TIMEOUT_MS = 35_000

interface ClaudeUsageRaw {
    /** Cleaned-up plain text of the /usage panel. */
    text: string
    /** Raw PTY bytes (after ANSI strip) for debugging. */
    raw: string
}

interface ClaudeUsageBridgeResponse {
    ok?: boolean
    text?: string
    raw?: string
    error?: string
}

/**
 * Make an interactive `claude` session usable for the /usage scrape with no
 * human at the keyboard. The chat path uses `claude -p`, which skips first-run
 * onboarding; the interactive TUI does NOT, so without these flags claude shows
 * the theme + "Select login method" pickers and `/usage` never renders (this
 * was verified end-to-end on the live container). The account is already
 * authenticated via the stored OAuth token — we're only suppressing cosmetic
 * first-run UI, exactly the state a one-time interactive login would leave:
 *   • global: hasCompletedOnboarding / numStartups / theme → skip onboarding
 *   • per-folder: hasTrustDialogAccepted → skip the "trust this folder?" prompt
 * Idempotent: writes ~/.claude.json once (atomically, temp + rename) and never
 * again once the flags stick, keeping the race with claude's own writes to a
 * single one-time pass.
 */
function ensureClaudeInteractiveReady(dir: string): void {
    const configPath = join(homedir(), '.claude.json')
    let data: Record<string, unknown>
    try {
        data = existsSync(configPath)
            ? (JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>)
            : {}
    } catch {
        // Malformed/locked config — don't clobber it; the scrape will surface a
        // clear error (login/trust prompt) if the session really isn't ready.
        return
    }
    if (!data || typeof data !== 'object') return

    let changed = false

    // Global onboarding — skips the theme + login-method pickers.
    if (data.hasCompletedOnboarding !== true) { data.hasCompletedOnboarding = true; changed = true }
    if (typeof data.numStartups !== 'number' || (data.numStartups as number) < 1) { data.numStartups = 1; changed = true }
    if (!data.theme) { data.theme = 'dark'; changed = true }

    // Per-folder trust — skips the "Do you trust this folder?" prompt.
    const projects = (data.projects && typeof data.projects === 'object')
        ? (data.projects as Record<string, Record<string, unknown>>)
        : ((data.projects = {}) as Record<string, Record<string, unknown>>)
    const existing = projects[dir]
    const project = (existing && typeof existing === 'object') ? existing : (projects[dir] = {})
    if (project.hasTrustDialogAccepted !== true) {
        const defaults: Record<string, unknown> = {
            allowedTools: [],
            mcpContextUris: [],
            mcpServers: {},
            enabledMcpjsonServers: [],
            disabledMcpjsonServers: [],
            hasClaudeMdExternalIncludesApproved: false,
            hasClaudeMdExternalIncludesWarningShown: false,
        }
        for (const [k, v] of Object.entries(defaults)) {
            if (!(k in project)) project[k] = v
        }
        project.hasTrustDialogAccepted = true
        changed = true
    }
    if (typeof project.projectOnboardingSeenCount !== 'number' || (project.projectOnboardingSeenCount as number) < 1) {
        project.projectOnboardingSeenCount = 1
        changed = true
    }

    if (!changed) return
    try {
        const tmp = `${configPath}.orch-usage-tmp`
        writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
        renameSync(tmp, configPath)
    } catch {
        // Best effort — a failed write just means the next scrape retries.
    }
}

/**
 * Drive `claude` in a PTY: wait for the prompt, send `/usage`, capture the
 * rendered panel, then Ctrl+C out. Returns the cleaned panel text.
 */
async function captureClaudeUsagePanel(): Promise<ClaudeUsageRaw | { error: string }> {
    const claudeBin = resolveBin('claude')
    if (claudeBin === 'claude') {
        return { error: 'Claude Code CLI is not installed.' }
    }

    // Run from the agent workspace — the same directory the chat path drives
    // claude in. Prime ~/.claude.json so the interactive TUI opens straight to a
    // usable session (no onboarding/trust prompts) where /usage can render.
    const cwd = activeRuntimePaths().agentWorkspaceDir
    ensureClaudeInteractiveReady(cwd)

    return new Promise(resolve => {
        let pty: ReturnType<typeof ptySpawn>
        try {
            // `--strict-mcp-config --mcp-config {}` mirrors the host bridge: it
            // stops claude from loading the user/project MCP servers on startup
            // (which can hang for tens of seconds and is what made the
            // in-container scrape unsafe to run inline before). DISABLE_AUTOUPDATER
            // is critical — an auto-update kicking off on launch corrupts the TUI
            // mid-scrape so /usage never settles (verified on the live container).
            pty = ptySpawn(claudeBin, ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], {
                name: 'xterm-256color',
                cols: 140,
                rows: 50,
                cwd,
                env: augmentedEnv({ DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' }) as { [key: string]: string },
            })
        } catch (err) {
            resolve({ error: `Failed to spawn claude: ${err instanceof Error ? err.message : 'unknown error'}` })
            return
        }

        let buf = ''
        let lastDataAt = Date.now()
        let phase: 'wait-prompt' | 'wait-panel' | 'quitting' | 'done' = 'wait-prompt'
        const startedAt = Date.now()

        pty.onData(d => {
            buf += d
            lastDataAt = Date.now()
        })

        const finish = (result: ClaudeUsageRaw | { error: string }) => {
            if (phase === 'done') return
            phase = 'done'
            clearInterval(tick)
            try { pty.kill() } catch { /* ignore */ }
            resolve(result)
        }

        pty.onExit(() => {
            if (phase === 'done') return
            const cleaned = stripAnsi(buf)
            // If we got the panel before exit, treat as success.
            if (hasClaudeUsageQuota(cleaned)) {
                finish({ text: cleaned, raw: cleaned })
            } else {
                finish({ error: 'claude exited before rendering /usage panel.' })
            }
        })

        const tick = setInterval(() => {
            const idleMs = Date.now() - lastDataAt
            const elapsed = Date.now() - startedAt
            const cleanedSoFar = stripAnsi(buf)

            // Abort if we see a trust prompt — we can't safely accept it
            // unattended from a different cwd context.
            if (phase === 'wait-prompt' && cleanedSoFar.includes('trust this folder')) {
                finish({ error: `claude needs to trust ${cwd} first — open claude interactively here once.` })
                return
            }

            if (
                phase === 'wait-prompt'
                && ((idleMs > 1200 && cleanedSoFar.trim().length > 0) || elapsed > 5000)
            ) {
                phase = 'wait-panel'
                pty.write('/usage')
                // Small gap so claude's slash-command suggestion UI lands first,
                // then Enter commits the command.
                setTimeout(() => { if (phase === 'wait-panel') pty.write('\r') }, 250)
                return
            }

            if (phase === 'wait-panel') {
                // Panel is ready when at least one quota window parses AND the
                // output has been idle for a beat (some data trickles in as
                // "Refreshing..." sections settle).
                if (hasClaudeUsageQuota(cleanedSoFar) && idleMs > 1200) {
                    finish({ text: cleanedSoFar, raw: cleanedSoFar })
                    return
                }
            }

            if (elapsed > CLAUDE_USAGE_TIMEOUT_MS) {
                finish({ error: 'Timed out waiting for /usage panel.' })
            }
        }, 250)
    })
}

async function captureClaudeUsagePanelFromHostBridge(): Promise<ClaudeUsageRaw | { error: string } | null> {
    const url = claudeUsageHostBridgeUrl()
    if (!url) return null

    const token = process.env.ORCHESTRATOR_HOST_BRIDGE_TOKEN
        || process.env.ORCHESTRATOR_DOCKER_UPDATE_TOKEN
        || process.env.ORCHESTRATOR_HOST_UPDATE_TOKEN
    if (!token) return { error: 'Docker host bridge token is not configured.' }

    try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), CLAUDE_USAGE_HOST_BRIDGE_TIMEOUT_MS)
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Orchestrator-Host-Bridge-Token': token,
                Accept: 'application/json',
            },
            signal: controller.signal,
        }).finally(() => clearTimeout(timer))

        const json = (await res.json().catch(() => ({}))) as ClaudeUsageBridgeResponse
        if (!res.ok) {
            const detail = typeof json.error === 'string' && json.error.trim() ? `: ${json.error}` : ''
            return { error: `Docker host bridge returned HTTP ${res.status}${detail}.` }
        }

        if (json.ok && typeof json.text === 'string' && json.text.trim()) {
            return { text: json.text, raw: typeof json.raw === 'string' ? json.raw : json.text }
        }
        return { error: json.error || 'Docker host bridge did not return Claude usage data.' }
    } catch (err) {
        return { error: err instanceof Error ? `Docker host bridge failed: ${err.message}` : 'Docker host bridge failed.' }
    }
}

function claudeUsageHostBridgeUrl(): string | null {
    const explicitUsage = process.env.ORCHESTRATOR_CLAUDE_USAGE_BRIDGE_URL?.trim()
    if (explicitUsage) return normalizeClaudeUsageBridgeUrl(explicitUsage, true)

    const hostBridge = process.env.ORCHESTRATOR_HOST_BRIDGE_URL?.trim()
    if (hostBridge) return normalizeClaudeUsageBridgeUrl(hostBridge)

    const updateBridge = (
        process.env.ORCHESTRATOR_DOCKER_UPDATE_URL
        || process.env.ORCHESTRATOR_HOST_UPDATE_URL
        || ''
    ).trim()
    if (updateBridge) return normalizeClaudeUsageBridgeUrl(updateBridge)

    return null
}

function normalizeClaudeUsageBridgeUrl(value: string, exact = false): string | null {
    try {
        const url = new URL(value)
        if (!exact && (!url.pathname || url.pathname === '/' || url.pathname === '/update' || url.pathname === '/status')) {
            url.pathname = '/claude-usage'
            url.search = ''
            url.hash = ''
        }
        return url.toString()
    } catch {
        return null
    }
}

/**
 * Strip the noisy parts of the PTY stream: ANSI CSI escapes, OSC sequences,
 * and other control bytes that survived (carriage returns, bells…). What
 * remains is more or less the human-visible text, though glyphs may run
 * together because the TUI uses absolute cursor positioning.
 */
function stripAnsi(s: string): string {
    return s
        // CSI (cursor moves, colours, modes)
        .replace(/\x1B\[[?]?[0-9;]*[a-zA-Z@`~]/g, '')
        // OSC (window title, etc) — terminated by BEL or ST
        .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
        // Single-shift and charset selectors
        .replace(/\x1B[()*+][0-9A-Za-z]/g, '')
        .replace(/\x1B[=>]/g, '')
        // Stray control bytes (keep \n and \r)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
}

function hasClaudeUsageQuota(text: string): boolean {
    const parsed = parseClaudeUsageText(text)
    return Boolean(parsed.fiveHour || parsed.weekly || parsed.weeklySonnet)
}

/**
 * Parse the cleaned /usage panel text. Markers are stable across renders;
 * percentages and reset strings are deterministic enough to anchor on labels.
 *
 * The TUI sometimes mangles parenthesized labels (e.g. "Sonnet only" renders
 * as "Sonet nly") because of absolute-positioning gaps between glyphs, so we
 * match `Current week (...)` loosely and classify by inner-text contents.
 */
function parseClaudeUsageText(text: string): {
    fiveHour?: CliQuotaWindow
    weekly?: CliQuotaWindow
    weeklySonnet?: CliQuotaWindow
} {
    // Replace runs of progress-bar glyphs (█▌▏ etc.) and whitespace with a
    // single space so the regex anchors don't need to skip them.
    const norm = text.replace(/[█▉▊▋▌▍▎▏░]+/g, ' ').replace(/\s+/g, ' ')
    const currentLabel = 'Curr[a-z]*\\s*session'
    const weekLabel = 'Curr[a-z]*\\s*week'
    // Claude 2.1 can render "Current session" as "Curretsession" and
    // "Resets" as "Reses" after ANSI/cursor-position stripping.
    const resetLabel = 'Res(?:ets?|es)'
    const usedLabel = '(\\d{1,3})%\\s*u\\w*d'
    const stopLabel = `(?:${weekLabel}|What|Last|Extra\\s*usage)`
    const bodyBeforeReset = `(?:(?!\\s*${stopLabel}).)*?`
    const untilNextSection = `(?=\\s*${stopLabel}|$)`

    const fiveHour = extractWindow(
        norm,
        new RegExp(`${currentLabel}[^%]*?${usedLabel}${bodyBeforeReset}${resetLabel}\\s*(.+?)${untilNextSection}`, 'i')
    )

    let weekly: CliQuotaWindow | undefined
    let weeklySonnet: CliQuotaWindow | undefined
    const weekRe = new RegExp(`${weekLabel}\\s*\\(([^)]+)\\)[^%]*?${usedLabel}${bodyBeforeReset}${resetLabel}\\s*(.+?)${untilNextSection}`, 'gi')
    let m: RegExpExecArray | null
    while ((m = weekRe.exec(norm)) !== null) {
        const inner = m[1].toLowerCase()
        const win: CliQuotaWindow = {
            usedPercent: Number(m[2]),
            resetsAt: parseClaudeResetText(m[3].trim()),
        }
        if (!Number.isFinite(win.usedPercent) || win.resetsAt <= 0) continue
        // Mangled or not, "Sonnet only" reliably contains an 's', 'n', 't'
        // sequence; "all models" contains "all" or "models". Use both.
        if (inner.includes('son') || inner.includes('only')) weeklySonnet = win
        else weekly = win
    }

    return { fiveHour, weekly, weeklySonnet }
}

function extractWindow(text: string, re: RegExp): CliQuotaWindow | undefined {
    const m = text.match(re)
    if (!m) return undefined
    const pct = Number(m[1])
    if (!Number.isFinite(pct)) return undefined
    const resetText = m[2].trim()
    const resetsAt = parseClaudeResetText(resetText)
    if (resetsAt <= 0) return undefined
    return { usedPercent: pct, resetsAt }
}

/**
 * Translate claude's friendly reset strings into a unix epoch (seconds).
 * Accepts a few shapes:
 *   - "2:40am (Europe/Bucharest)"           — next occurrence today/tomorrow
 *   - "May 15 at 7pm (Europe/Bucharest)"    — explicit date, this/next year
 *   - "Jun 1 (Europe/Bucharest)"            — date only, treat as midnight
 *
 * We compute in the IANA timezone claude printed; falls back to local time if
 * parsing fails.
 */
function parseClaudeResetText(input: string): number {
    const tzMatch = input.match(/\(([^)]+)\)\s*$/)
    const tz = tzMatch ? tzMatch[1].trim() : undefined
    const stripped = input
        .replace(/\([^)]+\)\s*$/, '')
        .trim()
        .replace(/([A-Za-z])(\d)/g, '$1 $2')
        .replace(/(\d)\s*at\s*(\d)/gi, '$1 at $2')

    // Variant A: "May 15 at 7pm", "May 29, 7pm" (Claude 2.1.153+), "May 15 7:30pm",
    // or date-only "Jun 1". The day/time separator may be " at ", a comma, or
    // just whitespace — claude's wording drifts between CLI versions.
    const dateTimeRe = /^([A-Za-z]{3,9})\s+(\d{1,2})(?:[,\s]+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i
    const m1 = stripped.match(dateTimeRe)
    if (m1) {
        const month = monthIndex(m1[1])
        const day = Number(m1[2])
        const hour = m1[3] ? to24Hour(Number(m1[3]), m1[5]) : 0
        const minute = m1[4] ? Number(m1[4]) : 0
        if (month >= 0) return assembleEpoch({ month, day, hour, minute }, tz)
    }

    // Variant B: just a time of day like "2:40am" or "7pm"
    const timeRe = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i
    const m2 = stripped.match(timeRe)
    if (m2) {
        const hour = to24Hour(Number(m2[1]), m2[3])
        const minute = m2[2] ? Number(m2[2]) : 0
        return assembleEpoch({ hour, minute }, tz, true)
    }

    return 0
}

function monthIndex(name: string): number {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    return months.indexOf(name.slice(0, 3).toLowerCase())
}

function to24Hour(h: number, ampm: string | undefined): number {
    if (!ampm) return h
    const isPm = ampm.toLowerCase() === 'pm'
    if (isPm && h !== 12) return h + 12
    if (!isPm && h === 12) return 0
    return h
}

/**
 * Build a unix epoch from (month?, day?, hour, minute) in the given IANA tz.
 * If only hour/minute are provided, the next future occurrence (today or
 * tomorrow) is returned.
 *
 * We use Intl.DateTimeFormat with timeZone to find the UTC offset of the
 * target tz at the target wall-clock, then iterate to converge — DST makes
 * a single-pass calculation fragile.
 */
function assembleEpoch(
    parts: { month?: number; day?: number; hour: number; minute: number },
    tz: string | undefined,
    timeOnly = false
): number {
    const now = new Date()
    const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone

    // Year defaults to the current year in that tz, but if the resulting
    // moment is in the past for a date-bearing input, bump to next year.
    let year = nowYearInTz(zone, now)
    let month = parts.month ?? nowMonthInTz(zone, now)
    let day = parts.day ?? nowDayInTz(zone, now)

    let epoch = wallClockToEpoch(year, month, day, parts.hour, parts.minute, zone)

    if (timeOnly && epoch <= Math.floor(now.getTime() / 1000)) {
        // Push by one day for time-only inputs in the past
        const next = new Date(epoch * 1000 + 24 * 3600 * 1000)
        year = nowYearInTz(zone, next)
        month = nowMonthInTz(zone, next)
        day = nowDayInTz(zone, next)
        epoch = wallClockToEpoch(year, month, day, parts.hour, parts.minute, zone)
    } else if (!timeOnly && epoch <= Math.floor(now.getTime() / 1000)) {
        // For date-bearing inputs without an explicit year, roll into next year
        year += 1
        epoch = wallClockToEpoch(year, month, day, parts.hour, parts.minute, zone)
    }
    return epoch
}

function wallClockToEpoch(y: number, m: number, d: number, h: number, min: number, tz: string): number {
    // Build a "guess" assuming UTC, then compute the offset that tz applies at
    // that instant, then correct. One iteration is enough except across DST
    // gaps; a second pass cleans those up.
    const guess = Date.UTC(y, m, d, h, min, 0)
    const offsetMs = tzOffsetMsAt(guess, tz)
    let epochMs = guess - offsetMs
    const offsetMs2 = tzOffsetMsAt(epochMs, tz)
    if (offsetMs2 !== offsetMs) epochMs = guess - offsetMs2
    return Math.floor(epochMs / 1000)
}

function tzOffsetMsAt(epochMs: number, tz: string): number {
    // Format the instant in the target tz, then re-parse as UTC to derive
    // offset. This is the canonical workaround for missing Temporal API.
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    })
    const parts = fmt.formatToParts(new Date(epochMs))
    const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0)
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
    return asUtc - epochMs
}

function nowYearInTz(tz: string, when: Date): number {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(when))
}
function nowMonthInTz(tz: string, when: Date): number {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'numeric' }).format(when)) - 1
}
function nowDayInTz(tz: string, when: Date): number {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric' }).format(when))
}

/**
 * One actual read of the Claude /usage panel. In Docker we try the host bridge
 * first (for deployments where claude is installed on the host), then fall back
 * to scraping claude *inside the container* — which is where the binary and the
 * user's subscription login live on container installs, so the host bridge is
 * a no-op there. Always run via getClaudeCodeQuota(), never directly: this can
 * take 5-10s+ and must not block the request thread (see the cache below).
 */
async function scrapeClaudeCodeQuota(): Promise<CliQuotaSnapshot> {
    const fetchedAt = Date.now()
    const runningInDocker = process.env.ORCHESTRATOR_SERVICE_MANAGER === 'docker'
    let captured: ClaudeUsageRaw | { error: string } | null = null
    let source: CliQuotaSnapshot['source'] = 'tui'

    if (runningInDocker) {
        captured = await captureClaudeUsagePanelFromHostBridge()
        if (captured && !('error' in captured)) source = 'host-bridge'
    }

    if (!captured || 'error' in captured) {
        const status = await getClaudeStatusForUsage()
        const statusError = claudeStatusError(status)
        if (statusError) {
            return {
                cliId: 'claude-code',
                available: false,
                error: withBridgeError(statusError, captured),
                source: 'none',
                fetchedAt,
            }
        }
    }

    if (!captured || 'error' in captured) {
        captured = await captureClaudeUsagePanel()
        source = 'tui'
    }
    if ('error' in captured && captured.error.includes('Timed out')) {
        await sleep(CLAUDE_USAGE_RETRY_DELAY_MS)
        captured = await captureClaudeUsagePanel()
    }
    if ('error' in captured) {
        return {
            cliId: 'claude-code',
            available: false,
            error: captured.error,
            source,
            fetchedAt,
        }
    }

    const parsed = parseClaudeUsageText(captured.text)
    if (!parsed.fiveHour && !parsed.weekly) {
        return {
            cliId: 'claude-code',
            available: false,
            error: 'Couldn\'t parse the /usage panel — claude\'s output may have changed.',
            source,
            fetchedAt,
        }
    }
    return {
        cliId: 'claude-code',
        available: true,
        fiveHour: parsed.fiveHour,
        weekly: parsed.weekly,
        weeklySonnet: parsed.weeklySonnet,
        source,
        fetchedAt,
        dataTimestamp: fetchedAt,
    }
}

// ---------------------------------------------------------------------------
// Claude usage cache (stale-while-revalidate)
//
// Scraping the /usage TUI takes 5-10s+, which is why it used to be disabled in
// Docker — running it inline blocked the request and the popover's 15s fetch
// would abort. We decouple it: serve a cached snapshot instantly and refresh in
// the background under a single-flight lock. A cold cache waits a bounded slice
// (< the client abort) so the very first open still gets live data when it can;
// otherwise it returns a "warming" placeholder and the next open is populated.
// Module-level state persists for the life of the server process.
// ---------------------------------------------------------------------------

const CLAUDE_QUOTA_TTL_MS = 90_000
const CLAUDE_QUOTA_COLD_WAIT_MS = 12_000

interface ClaudeQuotaCacheEntry {
    snapshot: CliQuotaSnapshot
    storedAt: number
}

let claudeQuotaCache: ClaudeQuotaCacheEntry | null = null
let claudeQuotaInflight: Promise<CliQuotaSnapshot> | null = null

function refreshClaudeCodeQuota(): Promise<CliQuotaSnapshot> {
    if (!claudeQuotaInflight) {
        claudeQuotaInflight = scrapeClaudeCodeQuota()
            .catch((err): CliQuotaSnapshot => ({
                cliId: 'claude-code',
                available: false,
                error: err instanceof Error ? err.message : 'Failed to read Claude usage.',
                source: 'none',
                fetchedAt: Date.now(),
            }))
            .then(snapshot => {
                // Store every result (success or error) so the UI surfaces the
                // real state — but never let an error clobber a still-fresh good
                // read (transient scrape failures shouldn't blank the gauge).
                const prev = claudeQuotaCache
                const keepPrevGood = !snapshot.available
                    && prev?.snapshot.available === true
                    && Date.now() - prev.storedAt < CLAUDE_QUOTA_TTL_MS
                if (!keepPrevGood) claudeQuotaCache = { snapshot, storedAt: Date.now() }
                return claudeQuotaCache?.snapshot ?? snapshot
            })
            .finally(() => { claudeQuotaInflight = null })
    }
    return claudeQuotaInflight
}

async function getClaudeCodeQuota(): Promise<CliQuotaSnapshot> {
    const now = Date.now()
    const cached = claudeQuotaCache
    if (cached && now - cached.storedAt < CLAUDE_QUOTA_TTL_MS) {
        return cached.snapshot
    }

    const inflight = refreshClaudeCodeQuota()

    // Stale snapshot present → serve it now, let the refresh update for next time.
    if (cached) return cached.snapshot

    // Cold cache → wait a bounded slice (under the client's 15s abort) so the
    // first open gets live data when the scrape is quick; otherwise hand back a
    // placeholder and let the background refresh land before the next open.
    const winner = await Promise.race([
        inflight,
        sleep(CLAUDE_QUOTA_COLD_WAIT_MS).then(() => null),
    ])
    if (winner) return winner
    return {
        cliId: 'claude-code',
        available: false,
        error: 'Fetching Claude usage… reopen this in a moment.',
        source: 'none',
        fetchedAt: now,
    }
}

async function getClaudeStatusForUsage() {
    try {
        const statuses = await getAllCliStatuses({ force: true, ttlMs: 0 })
        return statuses['claude-code']
    } catch {
        return null
    }
}

function claudeStatusError(status: Awaited<ReturnType<typeof getClaudeStatusForUsage>>): string | null {
    if (!status) return null
    if (!status.installed) return 'Claude Code CLI is not installed.'
    if (status.needsReconnect) {
        return 'Claude Code session expired. Open Settings > Auth and click Reconnect, or run `claude setup-token`.'
    }
    if (!status.loggedIn) {
        return status.detail
            ? `Claude Code CLI is installed but not logged in (${status.detail}).`
            : 'Claude Code CLI is installed but not logged in.'
    }
    return null
}

function withBridgeError(message: string, captured: ClaudeUsageRaw | { error: string } | null): string {
    if (!captured || !('error' in captured)) return message
    return `${message} Host bridge error: ${captured.error}`
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Codex — chatgpt.com/backend-api/wham/usage (same endpoint codex /status polls)
// ---------------------------------------------------------------------------

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
    // Prefer absolute reset_at; fall back to wall-clock-now + reset_after.
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
            // `codex login status` is cheap but still goes through the Codex
            // auth bootstrap, which refreshes stale OAuth credentials before
            // it reports "Logged in". The quota endpoint reads auth.json
            // directly, so it must trigger this same refresh path before
            // deciding the token is expired.
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
            // Both casings are used by codex CLI in different versions —
            // the server is case-insensitive, but spelling matters.
            'chatgpt-account-id': auth.accountId,
            // Cloudflare gates this endpoint to the codex client UA. The
            // `Originator` header is what the CLI sends; the version in
            // User-Agent is loose, the server doesn't pin it.
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

// ---------------------------------------------------------------------------
// Combined snapshot
// ---------------------------------------------------------------------------

export async function getCliQuota(cliId: CliQuotaId): Promise<CliQuotaSnapshot> {
    return cliId === 'claude-code'
        ? getClaudeCodeQuota()
        : getCodexQuota()
}

export async function getAllCliQuotas(): Promise<Record<string, CliQuotaSnapshot>> {
    const [claudeCode, codex] = await Promise.all([
        getCliQuota('claude-code'),
        getCliQuota('codex'),
    ])
    return {
        'claude-code': claudeCode,
        'codex': codex,
    }
}
