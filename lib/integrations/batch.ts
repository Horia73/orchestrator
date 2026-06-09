// Shared batch primitive for per-item integration tools.
//
// Many integration tools act on a single entity (a Gmail message, a WhatsApp
// chat, a Calendar event, a Drive file). Acting on N of them used to cost N
// model tool-calls. The tools now also accept an array of IDs and fan out
// through this runner so the model can do it in ONE call.
//
// Providers that expose a native bulk endpoint (Gmail messages.batchModify,
// Google People batch*, Home Assistant target.entity_id arrays) should use that
// directly instead of this loop. This runner is for providers whose API is
// single-item only (Gmail threads, WhatsApp web, Calendar, Drive), where the
// win is purely in collapsing model round-trips.

export interface BatchItemResult {
    /** The target ID this outcome belongs to. */
    id: string
    ok: boolean
    /** Present when ok — the per-item result returned by the worker. */
    data?: unknown
    /** Present when !ok — the failure message for this item. */
    error?: string
}

export interface BatchResult {
    /** Discriminator so callers/UI can tell a batch summary from a single result. */
    batch: true
    total: number
    succeeded: number
    failed: number
    items: BatchItemResult[]
}

const MAX_CONCURRENCY = 20
const DEFAULT_CONCURRENCY = 6

/**
 * Run `fn` over every id with bounded concurrency, collecting per-item
 * successes and failures. A single item failing never rejects the whole batch —
 * its error is captured in `items` and reflected in `failed`. Input order is
 * preserved in `items`.
 */
export async function runIdBatch(
    ids: string[],
    fn: (id: string) => Promise<unknown>,
    opts: { concurrency?: number } = {}
): Promise<BatchResult> {
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, MAX_CONCURRENCY))
    const items: BatchItemResult[] = new Array(ids.length)
    let cursor = 0

    async function worker(): Promise<void> {
        while (true) {
            const index = cursor++
            if (index >= ids.length) return
            const id = ids[index]
            try {
                const data = await fn(id)
                items[index] = { id, ok: true, data }
            } catch (error) {
                items[index] = { id, ok: false, error: error instanceof Error ? error.message : String(error) }
            }
        }
    }

    const workerCount = Math.min(concurrency, ids.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))

    const succeeded = items.reduce((n, item) => (item.ok ? n + 1 : n), 0)
    return { batch: true, total: ids.length, succeeded, failed: ids.length - succeeded, items }
}
