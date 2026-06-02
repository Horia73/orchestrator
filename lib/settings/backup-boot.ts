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
const LIVE_DB = path.join(/* turbopackIgnore: true */ ORCHESTRATOR_STATE_DIR, 'data.db')

/**
 * If a restore staged a new database, swap it in atomically. Returns true if a
 * pending restore was applied. Never throws — a failure here must not break
 * boot; the staged files remain for the next attempt.
 */
export function applyPendingDbRestore(): boolean {
    try {
        if (!fs.existsSync(/* turbopackIgnore: true */ APPLY_MARKER)) return false
        if (!fs.existsSync(/* turbopackIgnore: true */ PENDING_DB)) {
            // Marker without a payload: clear it so we don't loop on every boot.
            fs.rmSync(/* turbopackIgnore: true */ PENDING_RESTORE_DIR, { recursive: true, force: true })
            return false
        }

        // Write the restored copy to a temp sibling first, then rename — an
        // atomic swap on the same filesystem so a crash mid-apply never leaves a
        // half-written data.db in place.
        const tmp = LIVE_DB + '.restoring'
        fs.copyFileSync(/* turbopackIgnore: true */ PENDING_DB, tmp)

        // Keep a one-shot copy of the database being replaced, for manual
        // recovery if the restored file turns out to be unwanted.
        if (fs.existsSync(/* turbopackIgnore: true */ LIVE_DB)) {
            try {
                fs.copyFileSync(/* turbopackIgnore: true */ LIVE_DB, LIVE_DB + '.pre-restore')
            } catch {
                // Best-effort safety copy only.
            }
        }

        // Drop stale WAL/SHM so SQLite does not replay the old log over the
        // freshly restored database.
        for (const suffix of ['-wal', '-shm']) {
            try {
                fs.rmSync(/* turbopackIgnore: true */ LIVE_DB + suffix, { force: true })
            } catch {
                // Ignore — absent sidecar files are fine.
            }
        }

        fs.renameSync(/* turbopackIgnore: true */ tmp, LIVE_DB)
        fs.rmSync(/* turbopackIgnore: true */ PENDING_RESTORE_DIR, { recursive: true, force: true })
        console.log('[backup] applied pending database restore')
        return true
    } catch (err) {
        console.error('[backup] failed to apply pending database restore', err)
        return false
    }
}
