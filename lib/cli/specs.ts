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

export interface CliStatus {
    /** True if the binary is on PATH. */
    installed: boolean
    /** True if the user is authenticated (subscription/cloud). */
    loggedIn: boolean
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
}

export const CLI_SPECS: Record<CliId, CliSpec> = {
    'claude-code': {
        id: 'claude-code',
        name: 'Claude Code',
        bin: 'claude',
        description: 'Anthropic Claude Code subscription. Used as the primary coding agent.',
        installBin: 'npm',
        installArgs: ['install', '-g', '@anthropic-ai/claude-code'],
        installHint: 'Installs Claude Code with npm. Anthropic recommends running this without sudo; Node.js 18+ is required.',
        installDocsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
        loginHint: 'Browser will open for Anthropic OAuth. Complete sign-in there, then close this window.',
        loginArgs: ['auth', 'login'],
        logoutArgs: ['auth', 'logout'],
        statusArgs: ['auth', 'status'],
        parseStatus: (stdout, _stderr, exitCode) => {
            // claude auth status emits JSON. Fall back to a permissive parse so
            // a rogue Claude Code update can't break login state detection.
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
    },
    'codex': {
        id: 'codex',
        name: 'Codex CLI',
        bin: 'codex',
        description: 'OpenAI Codex CLI subscription. Used alongside Claude Code for coding tasks.',
        installBin: 'npm',
        installArgs: ['install', '-g', '@openai/codex'],
        installHint: 'Installs the OpenAI Codex CLI with npm. Node.js 22 is recommended for this app.',
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
