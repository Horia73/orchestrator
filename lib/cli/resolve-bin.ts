import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, isAbsolute } from 'path'
import { execFileSync } from 'child_process'

/**
 * Resolve a CLI binary name to an absolute path.
 *
 * Next.js inherits PATH from whatever shell launched it; in many setups that
 * misses common user-bin directories like ~/.local/bin or
 * ~/.npm-global/bin. For the managed coding CLIs we prefer the app-managed npm
 * prefix before PATH so stale nvm/global installs cannot shadow the binary that
 * Settings -> Models installs and updates.
 *
 * Cached per-bin so repeated lookups don't shell out for `which` each time.
 */
const cache = new Map<string, string>()

const MANAGED_CLI_BINS = new Set(['claude', 'codex'])

const FALLBACK_DIRS = [
    '.local/bin',
    '.npm-global/bin',
    '.nvm/versions/node/current/bin',
    '.bun/bin',
    '.cargo/bin',
]
const FALLBACK_GLOBALS = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
]

export function resolveBin(name: string): string {
    if (isAbsolute(name) && existsSync(/* turbopackIgnore: true */ name)) return name

    const cached = cache.get(name)
    if (cached) return cached

    const home = homedir()

    const configuredOverride = configuredBinOverride(name)
    if (configuredOverride && existsSync(/* turbopackIgnore: true */ configuredOverride)) {
        cache.set(name, configuredOverride)
        return configuredOverride
    }

    // For CLIs Orchestrator owns from Settings, check stable managed locations
    // before PATH. A user shell may prepend old nvm/npm bins; letting those win
    // makes status, usage, and app-server runs disagree across processes.
    if (MANAGED_CLI_BINS.has(name)) {
        for (const candidate of managedCliCandidates(name, home)) {
            if (existsSync(/* turbopackIgnore: true */ candidate)) {
                cache.set(name, candidate)
                return candidate
            }
        }
    }

    // Try the cheap shell lookup.
    try {
        const out = execFileSync('which', [name], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        if (out && existsSync(/* turbopackIgnore: true */ out)) {
            cache.set(name, out)
            return out
        }
    } catch { /* not on PATH */ }

    // Fall back to user/system locations.
    const npmPrefix = npmGlobalPrefix(home)
    const userDirs = [
        join(/* turbopackIgnore: true */ npmPrefix, 'bin'),
        ...FALLBACK_DIRS.map(rel => join(/* turbopackIgnore: true */ home, rel)),
    ]
    for (const dir of userDirs) {
        const candidate = join(/* turbopackIgnore: true */ dir, name)
        if (existsSync(/* turbopackIgnore: true */ candidate)) {
            cache.set(name, candidate)
            return candidate
        }
    }
    for (const dir of FALLBACK_GLOBALS) {
        const candidate = join(/* turbopackIgnore: true */ dir, name)
        if (existsSync(/* turbopackIgnore: true */ candidate)) {
            cache.set(name, candidate)
            return candidate
        }
    }

    // Give up — return the bare name so the caller's spawn error surfaces
    // "command not found" with the original identifier.
    return name
}

/**
 * Build an env that augments PATH with common user bin dirs. Useful when we
 * pass the resolved binary path but it itself shells out to other tools.
 */
export function augmentedEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const home = homedir()
    const npmPrefix = npmGlobalPrefix(home)
    const npmBin = join(/* turbopackIgnore: true */ npmPrefix, 'bin')
    try {
        mkdirSync(npmBin, { recursive: true })
    } catch {
        // Let npm surface the real permissions error if the home directory is not writable.
    }
    const dirs = [
        npmBin,
        join(/* turbopackIgnore: true */ home, '.local/bin'),
        ...FALLBACK_GLOBALS,
    ]
    const currentPath = process.env.PATH ?? ''
    const managedPrefix = dirs.filter(d => !pathHasDir(currentPath, d))
    const merged = [...managedPrefix, currentPath].filter(Boolean).join(':')

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        NPM_CONFIG_PREFIX: npmPrefix,
        ...extra,
        PATH: merged,
    }
    return env
}

/**
 * Resolve the shell that runs agent commands (foreground Bash tool and
 * tracked background jobs). $SHELL is honored when it points at a real
 * executable (interactive installs); container images often have no SHELL
 * env and no zsh, so fall through the common system shells instead of
 * hardcoding one — a bare `SHELL || '/bin/zsh'` fallback made every spawn
 * fail with `spawn /bin/zsh ENOENT` in the production Docker image.
 */
let commandShell: string | null = null
export function resolveCommandShell(): string {
    if (commandShell) return commandShell
    const candidates = [
        process.env.SHELL?.trim(),
        '/bin/bash',
        '/usr/bin/bash',
        '/bin/zsh',
        '/bin/sh',
        '/usr/bin/sh',
    ]
    for (const candidate of candidates) {
        if (candidate && isAbsolute(candidate) && existsSync(/* turbopackIgnore: true */ candidate)) {
            commandShell = candidate
            return candidate
        }
    }
    return '/bin/sh'
}

function npmGlobalPrefix(home: string): string {
    const configured = process.env.NPM_CONFIG_PREFIX?.trim()
    return configured || join(/* turbopackIgnore: true */ home, '.npm-global')
}

function configuredBinOverride(name: string): string | null {
    const envName = name === 'codex'
        ? 'ORCHESTRATOR_CODEX_BIN'
        : name === 'claude'
            ? 'ORCHESTRATOR_CLAUDE_BIN'
            : null
    if (!envName) return null
    const value = process.env[envName]?.trim()
    return value && isAbsolute(value) ? value : null
}

function managedCliCandidates(name: string, home: string): string[] {
    const npmPrefix = npmGlobalPrefix(home)
    const candidates = [
        join(/* turbopackIgnore: true */ npmPrefix, 'bin', name),
        join(/* turbopackIgnore: true */ home, '.npm-global', 'bin', name),
    ]
    if (name === 'codex') {
        candidates.push('/Applications/Codex.app/Contents/Resources/codex')
    }
    return [...new Set(candidates)]
}

function pathHasDir(pathValue: string, dir: string): boolean {
    return pathValue.split(':').some(part => part === dir)
}
