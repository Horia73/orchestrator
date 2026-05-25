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
    // Arm the Smart Monitor system heartbeat. Idempotent — creates the system
    // task in Scheduling on first boot, then on each boot reconciles its
    // enabled state with whether any watches exist. After arming, subscribe
    // to `monitor_watches.changed` so adding/removing/toggling a watch (from
    // either the API or the orchestrator's monitor_watch_* tools) auto-arms
    // or auto-pauses the heartbeat without callers needing to remember to.
    try {
        const { wireSmartMonitor, syncSmartMonitorActivation } = await import(
            '@/lib/monitoring/smart-monitor-adapter'
        )
        await wireSmartMonitor()
        const { appEventEmitter } = await import('@/lib/events')
        appEventEmitter.on('app:update', (event) => {
            if (event?.type !== 'monitor_watches.changed') return
            syncSmartMonitorActivation().catch((syncErr) => {
                console.error('[smart-monitor] sync after watch change failed', syncErr)
            })
        })
        // Catch up missed integration-install offer cards (e.g., user
        // connected Gmail while the app was down). Best-effort; idempotent.
        const { maybeOfferSmartMonitor } = await import('@/lib/monitoring/smart-monitor-offer')
        void maybeOfferSmartMonitor()
    } catch (err) {
        console.error('[monitoring] failed to wire smart monitor', err)
    }
    // Arm the Microscripts heartbeat. The heartbeat itself is a single
    // scheduled system task; it runs only while at least one microscript is
    // enabled/runnable and then executes due scripts with their own budgets.
    try {
        const { wireMicroscripts, syncMicroscriptsActivation } = await import(
            '@/lib/microscripts/heartbeat'
        )
        await wireMicroscripts()
        const { appEventEmitter } = await import('@/lib/events')
        appEventEmitter.on('app:update', (event) => {
            if (event?.type !== 'microscripts.changed') return
            syncMicroscriptsActivation().catch((syncErr) => {
                console.error('[microscripts] sync after change failed', syncErr)
            })
        })
    } catch (err) {
        console.error('[microscripts] failed to wire heartbeat', err)
    }
    // Offer model-owned daily memory consolidation as Inbox setup, if the
    // preference is not already recorded. This only posts a setup card; it
    // does not create a dedicated scheduled task or edit memory by itself.
    try {
        const { maybeOfferDailyMemoryConsolidation } = await import('@/lib/memory/daily-consolidation-offer')
        void maybeOfferDailyMemoryConsolidation()
    } catch (err) {
        console.error('[memory-offer] failed to check daily consolidation offer', err)
    }
}
