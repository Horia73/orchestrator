import fs from 'fs'

import db from '@/lib/db'
import { ARTIFACTS_DIR, PRIVATE_STATE_DIR, UPLOADS_DIR } from '@/lib/config'
import {
    resetWorkspaceEnvToInitialState,
    resetWorkspaceFilesToInitialState,
    resetWorkspaceMemoryToInitialState,
} from '@/lib/settings/workspace-files'

export const FACTORY_RESET_SCOPES = ['chat', 'automations', 'memory', 'integrations', 'env'] as const
export type FactoryResetScope = (typeof FACTORY_RESET_SCOPES)[number]

const DEFAULT_FACTORY_RESET_SCOPES: FactoryResetScope[] = ['chat', 'automations', 'memory', 'integrations']

const CHAT_TABLES = [
    'tool_logs',
    'request_log_reasoning',
    'request_logs',
    'audio_context_cache',
    'agent_thread_messages',
    'agent_threads',
    'artifacts',
    'messages',
    'conversations',
] as const

const AUTOMATION_AND_SAVED_DATA_TABLES = [
    'scheduled_task_runs',
    'scheduled_tasks',
    'push_subscriptions',
    'watchlist_quote_cache',
    'watchlist_history_cache',
    'watchlist_observations',
    'watchlist_alerts',
    'watchlist_items',
    'monitor_watch_events',
    'monitor_watches',
    'map_saved_places',
    'map_saved_areas',
] as const

export interface FactoryResetResult {
    scopes: FactoryResetScope[]
    clearedTables: Record<string, number>
    resetDirectories: string[]
    preservedEnvLocal: boolean
    resetMemoryFiles: string[]
    resetEnvLocal: boolean
}

export function factoryResetAppData(opts?: {
    preserveEnvLocal?: boolean
    scopes?: FactoryResetScope[]
}): FactoryResetResult {
    const scopes = normalizeScopes(opts)
    const clearedTables: Record<string, number> = {}
    const resetDirectories: string[] = []
    const resetMemoryFiles: string[] = []
    let preservedEnvLocal = false
    let resetEnvLocal = false

    db.transaction(() => {
        if (scopes.includes('chat')) clearTables(CHAT_TABLES, clearedTables)
        if (scopes.includes('automations')) clearTables(AUTOMATION_AND_SAVED_DATA_TABLES, clearedTables)
    })()

    if (scopes.includes('chat')) {
        resetDirectory(UPLOADS_DIR, 0o755)
        resetDirectories.push(UPLOADS_DIR)
        resetDirectory(ARTIFACTS_DIR, 0o755)
        resetDirectories.push(ARTIFACTS_DIR)
    }

    if (scopes.includes('integrations')) {
        resetDirectory(PRIVATE_STATE_DIR, 0o700)
        resetDirectories.push(PRIVATE_STATE_DIR)
    }

    const legacyFullWorkspaceReset = opts?.scopes === undefined && scopes.includes('memory')
    if (legacyFullWorkspaceReset) {
        const workspace = resetWorkspaceFilesToInitialState({
            preserveEnvLocal: opts?.preserveEnvLocal ?? true,
        })
        preservedEnvLocal = workspace.preservedEnvLocal
        resetMemoryFiles.push('workspace')
        resetEnvLocal = !preservedEnvLocal
    } else {
        if (scopes.includes('memory')) {
            const memory = resetWorkspaceMemoryToInitialState()
            resetMemoryFiles.push(...memory.resetFiles)
        }
        if (scopes.includes('env')) {
            resetEnvLocal = resetWorkspaceEnvToInitialState().reset
        } else {
            preservedEnvLocal = true
        }
    }

    return {
        scopes,
        clearedTables,
        resetDirectories,
        preservedEnvLocal,
        resetMemoryFiles,
        resetEnvLocal,
    }
}

export function isFactoryResetScope(value: unknown): value is FactoryResetScope {
    return typeof value === 'string' && (FACTORY_RESET_SCOPES as readonly string[]).includes(value)
}

function normalizeScopes(opts?: { preserveEnvLocal?: boolean; scopes?: FactoryResetScope[] }): FactoryResetScope[] {
    const requested = opts?.scopes
    if (requested === undefined) {
        const scopes = [...DEFAULT_FACTORY_RESET_SCOPES]
        if (opts?.preserveEnvLocal === false) scopes.push('env')
        return scopes
    }

    const seen = new Set<FactoryResetScope>()
    for (const scope of requested) {
        if (isFactoryResetScope(scope)) seen.add(scope)
    }
    return [...seen]
}

function clearTables(tables: readonly string[], clearedTables: Record<string, number>): void {
    const cleared: string[] = []
    for (const table of tables) {
        if (!tableExists(table)) continue
        const result = db.prepare(`DELETE FROM ${table}`).run()
        clearedTables[table] = (clearedTables[table] ?? 0) + result.changes
        cleared.push(table)
    }
    if (cleared.length > 0 && tableExists('sqlite_sequence')) {
        db.prepare(
            `DELETE FROM sqlite_sequence WHERE name IN (${cleared.map(() => '?').join(',')})`
        ).run(...cleared)
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
