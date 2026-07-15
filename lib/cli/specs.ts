/**
 * Declarative specs for the CLI integrations we wrap.
 *
 * Each spec describes:
 *   - the binary name (looked up via PATH)
 *   - how to start an interactive login session
 *   - how to log out
 *   - how to check auth status (parsing the output where helpful)
 *   - how to run a one-shot generation given a prompt
 *
 * The corresponding providers (claude-code.ts, codex.ts) read from this
 * registry so that adjusting subcommands or parsing rules is a one-file change.
 */

export type CliId = 'claude-code' | 'codex'

/** Verified app-server baseline for Orchestrator's namespaced dynamic-tool
 * integration. Keep the Settings installer aligned with the Docker host
 * bridge default in scripts/docker-update-bridge.py. */
export const CODEX_CLI_PACKAGE = '@openai/codex@0.144.4'

export interface CliStatus {
    /** True if the binary is on PATH. */
    installed: boolean
    /** Human-readable output from `<bin> --version`, when the binary answers. */
    version?: string
    /** True if the user is authenticated (subscription/cloud). */
    loggedIn: boolean
    /**
     * True when credentials exist locally but are stale/expired and the next
     * agent invocation will fail. Set independently of `loggedIn` so the UI
     * can render a distinct "Reconnect" state without losing the account
     * email/subscription metadata we already parsed.
     */
    needsReconnect?: boolean
    /**
     * Unix-ms timestamp of OAuth access-token expiry, when known. Surfaced so
     * the UI can show "expires in 2h" or "expired 3 days ago" without
     * re-parsing the credentials file.
     */
    expiresAt?: number
    /**
     * How the user is currently authenticated. `oauth` = browser/keychain
     * login (expires); `setup-token` = long-lived token from `claude
     * setup-token` (doesn't expire under normal use). Used to recommend
     * `setup-token` for headless server installs.
     */
    authMethod?: 'oauth' | 'setup-token' | 'api-key' | 'unknown'
    /** Free-form details surfaced in the UI (email, plan, etc.). */
    detail?: string
    /** Raw stdout from the status check — useful when parsing fails. */
    raw?: string
}

export interface CliSpec {
    id: CliId
    name: string
    bin: string
    description: string
    /**
     * Non-interactive install command launched from the Settings UI when the
     * binary is missing. Kept declarative so the terminal runner can execute it
     * without knowing package-manager details.
     */
    installBin: string
    installArgs: string[]
    installHint: string
    installDocsUrl?: string
    /**
     * Hint shown above the mini-terminal during login. Most CLIs auto-open the
     * browser; the hint tells the user what to expect.
     */
    loginHint: string
    /** Args for `claude auth login` style subcommand. */
    loginArgs: string[]
    /** Args for the logout flow. */
    logoutArgs: string[]
    /** Args + parser for the auth-status check. */
    statusArgs: string[]
    parseStatus: (stdout: string, stderr: string, exitCode: number) => CliStatus
    /** Args for non-interactive generation given the user's prompt. */
    generationArgs: (prompt: string) => string[]
    /**
     * Args for the long-lived-token setup flow (e.g. `claude setup-token`).
     * Omit on CLIs without an equivalent — UI hides the button. The flow is
     * interactive (prompts for browser URL, asks user to paste token back) so
     * it runs in the same PTY-backed CliTerminal as `login`.
     */
    setupTokenArgs?: string[]
}

type CliEnv = NodeJS.ProcessEnv | Record<string, string | undefined>

export const CLI_SPECS: Record<CliId, CliSpec> = {
    'claude-code': {
        id: 'claude-code',
        name: 'Claude Code',
        bin: 'claude',
        description: 'Anthropic Claude Code subscription. Used as the primary coding agent.',
        installBin: 'npm',
        installArgs: ['install', '-g', '@anthropic-ai/claude-code'],
        installHint: 'Installs Claude Code with npm into the app user prefix (~/.npm-global), no sudo required. Node.js 18+ is required.',
        installDocsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
        loginHint: 'Browser will open for Anthropic OAuth. Complete sign-in there, then close this window.',
        loginArgs: ['auth', 'login'],
        logoutArgs: ['auth', 'logout'],
        statusArgs: ['auth', 'status'],
        parseStatus: (stdout, _stderr, exitCode) => {
            // claude auth status emits JSON. Fall back to a permissive parse so
            // a rogue Claude Code update can't break login state detection.
            //
            // `loggedIn:true` here means "credentials file exists" — the CLI
            // doesn't probe expiry. We layer expiry detection on top in
            // lib/cli/status.ts by reading ~/.claude/.credentials.json so the
            // UI can distinguish a healthy session from one that needs
            // re-auth (silent 401s mid-stream otherwise — exactly the bug
            // we hit on polybot-linux after 3 days of uptime).
            try {
                const parsed = JSON.parse(stdout) as Record<string, unknown>
                const loggedIn = parsed.loggedIn === true
                const email = typeof parsed.email === 'string' ? parsed.email : undefined
                const provider = typeof parsed.apiProvider === 'string' ? parsed.apiProvider : undefined
                const detail = loggedIn
                    ? [email, provider].filter(Boolean).join(' · ') || undefined
                    : undefined
                return { installed: true, loggedIn, detail, raw: stdout }
            } catch {
                // No JSON — text form. Treat exit 0 + "logged in" mention as success.
                const lower = stdout.toLowerCase()
                return {
                    installed: true,
                    loggedIn: exitCode === 0 && lower.includes('logged in'),
                    raw: stdout,
                }
            }
        },
        // stream-json gives us the final `result` envelope with usage + cost,
        // while `--include-partial-messages` keeps incremental output flowing
        // (otherwise we'd buffer until the whole turn finishes). `--verbose`
        // is required to enable stream-json output in print mode. Requires
        // Claude Code ≥ 2.x — older versions silently dropped the flag.
        generationArgs: prompt => [
            '-p', prompt,
            '--output-format', 'stream-json',
            '--include-partial-messages',
            '--verbose',
        ],
        // `claude setup-token` opens a browser to mint a long-lived API
        // token, prints a code, then waits for the user to paste it back.
        // Required for headless / Docker installs where OAuth refresh
        // silently dies after a few days. Requires a Claude subscription.
        setupTokenArgs: ['setup-token'],
    },
    'codex': {
        id: 'codex',
        name: 'Codex CLI',
        bin: 'codex',
        description: 'OpenAI Codex CLI subscription. Used alongside Claude Code for coding tasks.',
        installBin: 'npm',
        installArgs: ['install', '-g', CODEX_CLI_PACKAGE],
        installHint: 'Installs the production-verified OpenAI Codex CLI into the app user prefix (~/.npm-global), no sudo required. Node.js 22 is recommended for this app.',
        installDocsUrl: 'https://help.openai.com/en/articles/11096431',
        loginHint: 'Browser will open for OpenAI OAuth. Complete sign-in there, then close this window.',
        loginArgs: ['login'],
        logoutArgs: ['logout'],
        statusArgs: ['login', 'status'],
        parseStatus: (stdout, stderr, exitCode) => {
            // Codex routes its status output to **stderr** (logs/diagnostics
            // pattern), not stdout. We accept either stream so the parser is
            // robust to future flips.
            const combined = (stdout + '\n' + stderr).trim()
            const lower = combined.toLowerCase()
            const loggedIn = exitCode === 0 && lower.includes('logged in')
            return {
                installed: true,
                loggedIn,
                detail: loggedIn ? combined.split('\n').find(l => l.toLowerCase().includes('logged in')) : undefined,
                raw: combined,
            }
        },
        // Note: the codex provider builds the full args itself because the
        // shape depends on whether we're starting a thread or resuming one
        // (`codex exec <prompt>` vs. `codex exec resume <id> <prompt>`) and
        // because we layer MCP / config overrides on top via `-c`. This
        // entry is the basic single-turn invocation used by smoke tests.
        generationArgs: prompt => ['exec', '--json', '--skip-git-repo-check', prompt],
    },
}

export const CLI_IDS: CliId[] = Object.keys(CLI_SPECS) as CliId[]

export function getCliLoginArgs(cli: CliId): string[] {
    if (cli === 'codex' && shouldUseCodexDeviceAuth(process.env, process.platform)) {
        return ['login', '--device-auth']
    }
    return CLI_SPECS[cli].loginArgs
}

export function getCliLoginHint(cli: CliId): string {
    if (cli === 'codex' && shouldUseCodexDeviceAuth(process.env, process.platform)) {
        return 'Headless/Docker login detected. Codex will use device auth: open the displayed URL on any browser, enter the code, then return here.'
    }
    return CLI_SPECS[cli].loginHint
}

export function shouldUseCodexDeviceAuth(env: CliEnv = process.env, platform = process.platform): boolean {
    const serviceManager = env.ORCHESTRATOR_SERVICE_MANAGER?.toLowerCase()
    if (serviceManager === 'docker') return true
    if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true
    if (env.SSH_CONNECTION || env.SSH_CLIENT) return true
    return false
}
