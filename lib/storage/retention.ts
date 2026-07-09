import db from '@/lib/db'

const DAY_MS = 86_400_000

export interface StorageRetentionPolicy {
    exactLogDays: number
    scheduledRunDetailDays: number
    toolLogDays: number
}

export interface StorageRetentionResult {
    requestInputsDeleted: number
    requestReasoningDeleted: number
    scheduledRunDetailsCompacted: number
    toolLogsDeleted: number
}

const DEFAULT_POLICY: StorageRetentionPolicy = {
    exactLogDays: 30,
    scheduledRunDetailDays: 30,
    toolLogDays: 90,
}

function retentionDays(name: string, fallback: number): number {
    const raw = process.env[name]?.trim()
    if (!raw) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) return fallback
    // 0 explicitly disables retention for that detail class.
    return Math.max(0, Math.min(3650, Math.floor(value)))
}

export function getStorageRetentionPolicy(): StorageRetentionPolicy {
    return {
        exactLogDays: retentionDays(
            'ORCHESTRATOR_EXACT_LOG_RETENTION_DAYS',
            DEFAULT_POLICY.exactLogDays
        ),
        scheduledRunDetailDays: retentionDays(
            'ORCHESTRATOR_SCHEDULED_RUN_DETAIL_RETENTION_DAYS',
            DEFAULT_POLICY.scheduledRunDetailDays
        ),
        toolLogDays: retentionDays(
            'ORCHESTRATOR_TOOL_LOG_RETENTION_DAYS',
            DEFAULT_POLICY.toolLogDays
        ),
    }
}

/**
 * Prune only duplicative/heavy detail. Request rows, usage/cost metrics,
 * conversation messages, scheduled-run summaries/status, and task history all
 * remain. SQLite can reuse the freed pages immediately; an explicit maintenance
 * VACUUM may later return them to the filesystem without blocking live traffic.
 */
export function pruneStoredDetails(
    now = Date.now(),
    policy = getStorageRetentionPolicy()
): StorageRetentionResult {
    const result: StorageRetentionResult = {
        requestInputsDeleted: 0,
        requestReasoningDeleted: 0,
        scheduledRunDetailsCompacted: 0,
        toolLogsDeleted: 0,
    }

    db.transaction(() => {
        if (policy.exactLogDays > 0) {
            const cutoff = now - policy.exactLogDays * DAY_MS
            result.requestInputsDeleted = db.prepare(`
                DELETE FROM request_log_input
                WHERE createdAt IS NOT NULL AND createdAt < ?
            `).run(cutoff).changes
            result.requestReasoningDeleted = db.prepare(`
                DELETE FROM request_log_reasoning
                WHERE requestId IN (
                    SELECT id FROM request_logs WHERE startedAt < ?
                )
            `).run(cutoff).changes
        }

        if (policy.scheduledRunDetailDays > 0) {
            const cutoff = now - policy.scheduledRunDetailDays * DAY_MS
            result.scheduledRunDetailsCompacted = db.prepare(`
                UPDATE scheduled_task_runs
                SET contentSegments = NULL,
                    reasoning = NULL,
                    attachments = NULL
                WHERE startedAt < ?
                  AND (
                    contentSegments IS NOT NULL
                    OR reasoning IS NOT NULL
                    OR attachments IS NOT NULL
                  )
            `).run(cutoff).changes
        }

        if (policy.toolLogDays > 0) {
            const cutoff = now - policy.toolLogDays * DAY_MS
            result.toolLogsDeleted = db.prepare(`
                DELETE FROM tool_logs WHERE startedAt < ?
            `).run(cutoff).changes
        }
    })()

    return result
}

export function storageRetentionChanged(result: StorageRetentionResult): boolean {
    return Object.values(result).some(value => value > 0)
}
