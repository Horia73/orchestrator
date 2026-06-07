import fs from 'fs'
import path from 'path'

import { ORCHESTRATOR_STATE_DIR } from '@/lib/runtime-paths'

/**
 * Staged-restore applier. The SQLite connection in `@/lib/db` is opened at
 * import time, so a restored `data.db` cannot be hot-swapped under the running
 * process — it is staged here by the restore route and applied on the next
 * boot, before anything opens the database.
 *
 * This module MUST NOT import `@/lib/db` (directly or transitively): it runs as
 * the very first step of `instrumentation.register()`, ahead of the connection
 * opening. Keep its imports limited to `fs`/`path`/`@/lib/runtime-paths`.
 */
export const PENDING_RESTORE_DIR = path.join(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR, '.pending-restore')

const PENDING_DB = path.join(/* turbopackIgnore: true */ PENDING_RESTORE_DIR, 'data.db')
const APPLY_MARKER = path.join(/* turbopackIgnore: true */ PENDING_RESTORE_DIR, 'APPLY')

/**
 * If a restore staged a new database, swap it in atomically. Returns true if a
 * pending restore was applied. Never throws — a failure here must not break
 * boot; the staged files remain for the next attempt.
 */
export function applyPendingDbRestore(): boolean {
    try {
        if (!fs.existsSync(/* turbopackIgnore: true */ APPLY_MARKER)) return false
        const pendingDbs = listPendingDatabaseFiles()
        if (pendingDbs.length === 0) {
            // Marker without a payload: clear it so we don't loop on every boot.
            fs.rmSync(/* turbopackIgnore: true */ PENDING_RESTORE_DIR, { recursive: true, force: true })
            return false
        }

        for (const pending of pendingDbs) {
            applyPendingDatabaseFile(pending)
        }
        fs.rmSync(/* turbopackIgnore: true */ PENDING_RESTORE_DIR, { recursive: true, force: true })
        console.log(`[backup] applied pending database restore (${pendingDbs.length} database file(s))`)
        return true
    } catch (err) {
        console.error('[backup] failed to apply pending database restore', err)
        return false
    }
}

function listPendingDatabaseFiles(): Array<{ pendingPath: string; relativePath: string }> {
    const out: Array<{ pendingPath: string; relativePath: string }> = []
    if (fs.existsSync(/* turbopackIgnore: true */ PENDING_DB)) {
        out.push({ pendingPath: PENDING_DB, relativePath: 'data.db' })
    }
    const stack: string[] = [PENDING_RESTORE_DIR]
    while (stack.length > 0) {
        const dir = stack.pop() as string
        let names: string[]
        try {
            names = fs.readdirSync(/* turbopackIgnore: true */ dir)
        } catch {
            continue
        }
        for (const name of names) {
            if (name === 'APPLY') continue
            const abs = path.join(/* turbopackIgnore: true */ dir, name)
            let stat: fs.Stats
            try {
                stat = fs.lstatSync(/* turbopackIgnore: true */ abs)
            } catch {
                continue
            }
            if (stat.isDirectory()) {
                stack.push(abs)
                continue
            }
            if (!stat.isFile()) continue
            const relativePath = path.relative(PENDING_RESTORE_DIR, abs).split(path.sep).join('/')
            if (!isDatabaseRelativePath(relativePath)) continue
            if (relativePath === 'data.db' && abs === PENDING_DB) continue
            out.push({ pendingPath: abs, relativePath })
        }
    }
    return out
}

function applyPendingDatabaseFile(input: { pendingPath: string; relativePath: string }): void {
    const livePath = path.join(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR, input.relativePath)
    if (!withinStateDir(livePath)) {
        throw new Error(`Pending restore database escapes state dir: ${input.relativePath}`)
    }
    fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(livePath), { recursive: true })

    const tmp = livePath + '.restoring'
    fs.copyFileSync(/* turbopackIgnore: true */ input.pendingPath, tmp)

    if (fs.existsSync(/* turbopackIgnore: true */ livePath)) {
        try {
            fs.copyFileSync(/* turbopackIgnore: true */ livePath, livePath + '.pre-restore')
        } catch {
            // Best-effort safety copy only.
        }
    }

    for (const suffix of ['-wal', '-shm']) {
        try {
            fs.rmSync(/* turbopackIgnore: true */ livePath + suffix, { force: true })
        } catch {
            // Ignore — absent sidecar files are fine.
        }
    }

    fs.renameSync(/* turbopackIgnore: true */ tmp, livePath)
}

function isDatabaseRelativePath(relativePath: string): boolean {
    return (
        relativePath === 'data.db' ||
        relativePath === 'control.db' ||
        /^profiles\/[^/]+\/data\.db$/.test(relativePath)
    )
}

function withinStateDir(target: string): boolean {
    const resolvedRoot = path.resolve(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR)
    const resolvedTarget = path.resolve(/* turbopackIgnore: true */ target)
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep)
}
