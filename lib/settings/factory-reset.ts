import fs from 'fs'

import db from '@/lib/db'
import { PRIVATE_STATE_DIR, UPLOADS_DIR } from '@/lib/config'
import { resetWorkspaceFilesToInitialState } from '@/lib/settings/workspace-files'

const RESET_TABLES = [
    'tool_logs',
    'request_logs',
    'scheduled_task_runs',
    'scheduled_tasks',
    'push_subscriptions',
    'watchlist_quote_cache',
    'watchlist_history_cache',
    'watchlist_observations',
    'watchlist_alerts',
    'watchlist_items',
    'agent_thread_messages',
    'agent_threads',
    'artifacts',
    'messages',
    'conversations',
] as const

export interface FactoryResetResult {
    clearedTables: Record<string, number>
    preservedEnvLocal: boolean
}

export function factoryResetAppData(opts?: { preserveEnvLocal?: boolean }): FactoryResetResult {
    const clearedTables: Record<string, number> = {}

    db.transaction(() => {
        for (const table of RESET_TABLES) {
            if (!tableExists(table)) continue
            const result = db.prepare(`DELETE FROM ${table}`).run()
            clearedTables[table] = result.changes
        }
        if (tableExists('sqlite_sequence')) {
            db.prepare(
                `DELETE FROM sqlite_sequence WHERE name IN (${RESET_TABLES.map(() => '?').join(',')})`
            ).run(...RESET_TABLES)
        }
    })()

    resetDirectory(UPLOADS_DIR, 0o755)
    resetDirectory(PRIVATE_STATE_DIR, 0o700)
    const workspace = resetWorkspaceFilesToInitialState({
        preserveEnvLocal: opts?.preserveEnvLocal ?? true,
    })

    return {
        clearedTables,
        preservedEnvLocal: workspace.preservedEnvLocal,
    }
}

function tableExists(name: string): boolean {
    const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(name) as { name: string } | undefined
    return Boolean(row)
}

function resetDirectory(dir: string, mode: number): void {
    fs.rmSync(/* turbopackIgnore: true */ dir, { recursive: true, force: true })
    fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true, mode })
    try {
        fs.chmodSync(/* turbopackIgnore: true */ dir, mode)
    } catch {
        // Some mounted filesystems ignore chmod.
    }
}
