import fs from 'fs'
import path from 'path'
import { activeRuntimePaths } from '@/lib/runtime-paths'

/**
 * Resolve a caller-supplied path against the agent sandbox.
 *
 * The sandbox has one primary root (AGENT_WORKSPACE_DIR, exposed at `/`).
 *
 * Rules:
 *  - Relative paths resolve under AGENT_WORKSPACE_DIR.
 *  - Absolute paths are accepted only if they sit inside the allowed root.
 *  - Any resolved path that escapes (via `..` or absolute traversal) is rejected.
 *
 * Returns either `{ ok: true, resolved }` with the absolute path inside a
 * sandboxed root, or `{ ok: false, error }` with a user-facing error message
 * safe to surface back to the model. We never reveal the absolute host paths
 * in the error — only the relative form the caller supplied — so a misuse
 * can't leak the host filesystem layout.
 */
export type SandboxResult =
    | { ok: true; resolved: string }
    | { ok: false; error: string }

/**
 * A mount point in the sandbox. `prefix === ''` means the workspace root
 * itself (displayed as `/`); any other prefix appears to the agent as a
 * virtual subdirectory of the workspace root.
 */
export interface SandboxRoot {
    absolute: string
    prefix: string
}

const DISCOVERY_HIDDEN_NAMES = new Set([
    '.orchestrator',
    '.claude',
    '.claude-memory',
    'CLAUDE.md',
])

const PROTECTED_AGENT_FILE_PATTERNS = [
    /^\.env(?:$|\.)/,
]

/**
 * Build the current list of allowed roots. Kept as an array so callers do not
 * need to change if we add explicit user-managed mounts later.
 */
export function getSandboxRoots(): SandboxRoot[] {
    return [{ absolute: path.resolve(/* turbopackIgnore: true */ activeRuntimePaths().agentWorkspaceDir), prefix: '' }]
}

export function isHiddenFromDiscovery(name: string): boolean {
    return DISCOVERY_HIDDEN_NAMES.has(name) || isProtectedAgentFileName(name)
}

export function isInsideHiddenDiscoveryPath(resolvedAbsolute: string): boolean {
    const root = getSandboxRoots()[0].absolute
    const rel = path.relative(root, resolvedAbsolute)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
    return rel.split(path.sep).some(segment => isHiddenFromDiscovery(segment))
}

export function isProtectedAgentFileName(name: string): boolean {
    return PROTECTED_AGENT_FILE_PATTERNS.some(re => re.test(name))
}

export function isInsideProtectedAgentPath(resolvedAbsolute: string): boolean {
    const root = getSandboxRoots()[0].absolute
    const rel = path.relative(root, resolvedAbsolute)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
    return rel.split(path.sep).some(segment => isProtectedAgentFileName(segment))
}

export function protectedAgentPathError(resolvedAbsolute: string): string {
    return `Protected workspace file cannot be accessed by generic agent filesystem tools: ${displayPath(resolvedAbsolute)}. Use the dedicated setup/settings flow for secrets.`
}

export function commandMentionsProtectedAgentPath(command: string): boolean {
    return /(^|[\s"'`=;|&<>/\\])\.env(?:$|[\s"'`;|&<>/\\.]|local|development|production|test)/.test(command)
}

export function hiddenDiscoveryRgArgs(): string[] {
    return [
        '--glob', '!.orchestrator/**',
        '--glob', '!**/.orchestrator/**',
        '--glob', '!.claude/**',
        '--glob', '!**/.claude/**',
        '--glob', '!.claude-memory/**',
        '--glob', '!**/.claude-memory/**',
        '--glob', '!CLAUDE.md',
        '--glob', '!**/CLAUDE.md',
        '--glob', '!.env*',
        '--glob', '!**/.env*',
    ]
}

function stripLeadingSlash(p: string): string {
    return p.startsWith('/') ? p.slice(1) : p
}

function isInside(candidate: string, root: string): boolean {
    const rel = path.relative(root, candidate)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function resolveSandboxed(inputPath: string | undefined): SandboxResult {
    const raw = (inputPath ?? '').trim()
    const roots = getSandboxRoots()
    const workspaceRoot = roots[0].absolute

    // Empty, ".", or "/" → workspace root as exposed to the model.
    if (raw === '' || raw === '.' || raw === './' || raw === '/') {
        return { ok: true, resolved: workspaceRoot }
    }

    // Absolute host path → must land inside some allowed root
    if (path.isAbsolute(raw)) {
        const candidate = path.resolve(/* turbopackIgnore: true */ raw)
        for (const root of roots) {
            if (isInside(candidate, root.absolute)) {
                return validateSandboxContainment(candidate, root.absolute, raw, 'agent workspace')
            }
        }
        return {
            ok: false,
            error: `Path is outside the agent workspace: ${raw}. Agents can only read files under the workspace directory.`,
        }
    }

    // Plain relative path → workspace
    const candidate = path.resolve(/* turbopackIgnore: true */ workspaceRoot, raw)
    if (isInside(candidate, workspaceRoot)) {
        return validateSandboxContainment(candidate, workspaceRoot, raw, 'agent workspace')
    }
    return {
        ok: false,
        error: `Path is outside the agent workspace: ${raw}. Agents can only read files under the workspace directory.`,
    }
}

/**
 * Writable paths are stricter than readable paths: agents may only mutate the
 * primary workspace root.
 */
export function resolveSandboxedWritable(inputPath: string | undefined): SandboxResult {
    const raw = (inputPath ?? '').trim()
    if (!raw) {
        return { ok: false, error: 'Missing required file path.' }
    }

    const workspaceRoot = getSandboxRoots()[0].absolute
    const candidate = raw === '/'
        ? workspaceRoot
        : path.isAbsolute(raw)
        ? path.resolve(/* turbopackIgnore: true */ raw)
        : path.resolve(/* turbopackIgnore: true */ workspaceRoot, stripLeadingSlash(raw))

    if (isInside(candidate, workspaceRoot)) {
        return validateSandboxContainment(candidate, workspaceRoot, raw, 'writable agent workspace')
    }

    return {
        ok: false,
        error: `Path is outside the writable agent workspace: ${raw}. Agents can only write under the workspace directory.`,
    }
}

function validateSandboxContainment(
    candidate: string,
    root: string,
    raw: string,
    label: 'agent workspace' | 'writable agent workspace',
): SandboxResult {
    const rootReal = realpathOrResolved(root)
    const unsafeSymlink = firstUnsafeSymlink(candidate, root, rootReal)
    if (unsafeSymlink) {
        return {
            ok: false,
            error: `Path resolves outside the ${label}: ${raw}. Agents can only access files under the workspace directory.`,
        }
    }

    const candidateReal = realpathIfExists(candidate)
    if (candidateReal && !isInside(candidateReal, rootReal)) {
        return {
            ok: false,
            error: `Path resolves outside the ${label}: ${raw}. Agents can only access files under the workspace directory.`,
        }
    }

    return { ok: true, resolved: candidate }
}

function firstUnsafeSymlink(candidate: string, root: string, rootReal: string): string | null {
    let current = candidate
    for (;;) {
        try {
            const stat = fs.lstatSync(/* turbopackIgnore: true */ current)
            if (stat.isSymbolicLink()) {
                const real = realpathIfExists(current)
                if (!real || !isInside(real, rootReal)) return current
            }
        } catch {
            // Missing path components are fine for future writes; keep walking
            // upward so existing parent symlinks are still checked.
        }

        if (current === root) return null
        const parent = path.dirname(current)
        if (parent === current) return null
        current = parent
    }
}

function realpathIfExists(candidate: string): string | null {
    try {
        return fs.realpathSync.native(/* turbopackIgnore: true */ candidate)
    } catch {
        return null
    }
}

function realpathOrResolved(candidate: string): string {
    return realpathIfExists(candidate) ?? path.resolve(/* turbopackIgnore: true */ candidate)
}

/**
 * Display form for a sandboxed path — strips the host root so the model sees
 * stable, workspace-relative paths. The workspace root itself is shown as "/".
 */
export function displayPath(resolvedAbsolute: string): string {
    for (const root of getSandboxRoots()) {
        if (resolvedAbsolute === root.absolute) {
            return root.prefix === '' ? '/' : '/' + root.prefix
        }
        if (resolvedAbsolute.startsWith(root.absolute + path.sep)) {
            const tail = resolvedAbsolute
                .slice(root.absolute.length + 1)
                .split(path.sep)
                .join('/')
            return root.prefix === '' ? '/' + tail : '/' + root.prefix + '/' + tail
        }
    }
    return resolvedAbsolute
}
