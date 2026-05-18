// Next.js boot hook. `register()` runs once when the server process starts
// (both `next dev` and `next start`). This is where the scheduler's
// background tick is armed. Guarded to the Node.js runtime — it must never
// run in the Edge runtime, and the scheduler itself is idempotent.
export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return
    const { startScheduler } = await import('@/lib/scheduling/scheduler')
    startScheduler()
    // Connect the consolidated markets monitor to the watchlist data layer and
    // arm its system heartbeat. Best-effort: a failure here must not break boot.
    try {
        const { wireMarketsMonitor } = await import('@/lib/monitoring/watchlist-adapter')
        await wireMarketsMonitor()
    } catch (err) {
        console.error('[monitoring] failed to wire markets monitor', err)
    }
}
