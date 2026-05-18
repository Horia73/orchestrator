import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, isAbsolute } from 'path'
import { execFileSync } from 'child_process'

/**
 * Resolve a CLI binary name to an absolute path.
 *
 * Next.js inherits PATH from whatever shell launched it; in many setups that
 * misses common user-bin directories like ~/.local/bin or
 * ~/.npm-global/bin. We walk known fallback locations after the cheap PATH
 * lookup so spawn() never fails with `posix_spawnp failed` when the binary
 * exists but isn't on the inherited PATH.
 *
 * Cached per-bin so repeated lookups don't shell out for `which` each time.
 */
const cache = new Map<string, string>()

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

    // Try the cheap shell lookup first.
    try {
        const out = execFileSync('which', [name], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        if (out && existsSync(/* turbopackIgnore: true */ out)) {
            cache.set(name, out)
            return out
        }
    } catch { /* not on PATH */ }

    // Fall back to user/system locations.
    const home = homedir()
    for (const rel of FALLBACK_DIRS) {
        const candidate = join(/* turbopackIgnore: true */ home, rel, name)
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
 * pass the resolved binary path but it itself shells out to other tools
 * (e.g. `claude` invoking `node` to run helper scripts).
 */
export function augmentedEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
    const home = homedir()
    const dirs = [
        join(/* turbopackIgnore: true */ home, '.local/bin'),
        join(/* turbopackIgnore: true */ home, '.npm-global/bin'),
        ...FALLBACK_GLOBALS,
    ]
    const currentPath = process.env.PATH ?? ''
    const merged = [currentPath, ...dirs.filter(d => !currentPath.includes(d))].filter(Boolean).join(':')

    const env: NodeJS.ProcessEnv = { ...process.env, ...extra, PATH: merged }
    return env
}
