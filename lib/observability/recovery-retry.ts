import { isTransientSqliteContentionError } from '@/lib/scheduling/sqlite-errors'

export interface RecoveryRetryOptions {
    maxAttempts?: number
    initialDelayMs?: number
    maxDelayMs?: number
    sleep?: (delayMs: number) => Promise<void>
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

/**
 * Startup reconciliation is correctness work, not optional telemetry. A host
 * reboot can leave another auto-started container briefly holding the profile
 * WAL, so one SQLITE_BUSY must not leave interrupted chat rows looking live
 * until the next deploy. Retry only known SQLite contention; programming and
 * schema errors still fail immediately.
 */
export async function retryTransientSqliteRecovery<T>(
    operation: () => T | Promise<T>,
    options: RecoveryRetryOptions = {},
): Promise<T> {
    const maxAttempts = positiveInteger(options.maxAttempts, 6)
    const initialDelayMs = nonNegativeInteger(options.initialDelayMs, 250)
    const maxDelayMs = nonNegativeInteger(options.maxDelayMs, 4_000)
    const sleep = options.sleep ?? delay

    for (let attempt = 1; ; attempt++) {
        try {
            return await operation()
        } catch (error) {
            if (!isTransientSqliteContentionError(error) || attempt >= maxAttempts) {
                throw error
            }
            const delayMs = Math.min(
                maxDelayMs,
                initialDelayMs * (2 ** (attempt - 1)),
            )
            options.onRetry?.(error, attempt, delayMs)
            await sleep(delayMs)
        }
    }
}

function delay(delayMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, delayMs))
}

function positiveInteger(value: number | undefined, fallback: number): number {
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
    return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback
}
