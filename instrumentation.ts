// Next.js boot hook. `register()` runs once when the server process starts
// (both `next dev` and `next start`). This is where the scheduler's
// background tick is armed. Guarded to the Node.js runtime — it must never
// run in the Edge runtime, and the scheduler itself is idempotent.
export async function register(): Promise<void> {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return
    // Apply a staged backup restore BEFORE anything opens the database. The
    // connection in '@/lib/db' is created at import time, so a restored data.db
    // can only be swapped in here, on the next boot after a restore. The boot
    // module intentionally imports nothing that touches '@/lib/db'.
    try {
        const { applyPendingDbRestore } = await import('@/lib/settings/backup-boot')
        applyPendingDbRestore()
    } catch (err) {
        console.error('[backup] pending restore check failed', err)
    }
    if (backgroundWorkDisabled()) return
    const { startScheduler } = await import('@/lib/scheduling/scheduler')
    startScheduler()
    // Pre-warm the integration status snapshot so the first scheduler tick
    // (Smart Monitor, Microscripts, scheduled agents) sees real connection
    // state instead of `unknown`. Fire-and-forget — boot must not block on
    // network probes; if the refresh fails, the snapshot stays cold and the
    // stale-while-revalidate path will retry on the next read.
    try {
        const { refreshIntegrationStatusSnapshot } = await import('@/lib/integrations/status-snapshot')
        void refreshIntegrationStatusSnapshot().catch((err) => {
            console.error('[integrations] failed to pre-warm status snapshot', err)
        })
    } catch (err) {
        console.error('[integrations] failed to schedule status pre-warm', err)
    }
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
    // Arm the nightly Memory reflection system task. Idempotent — creates the
    // single "Memory reflection" agent wake on first boot and reconciles its
    // schedule/prompt on each boot. Stays enabled unconditionally; the heavy
    // logic is model-owned in <memory_reflection_protocol>, not in code.
    try {
        const { wireMemoryReflection } = await import('@/lib/monitoring/memory-reflection-adapter')
        await wireMemoryReflection()
    } catch (err) {
        console.error('[memory] failed to wire memory reflection', err)
    }
    // Confirm managed self-updates after the restarted process is alive. The
    // update runner/host bridge records the expected commit before restart;
    // this boot hook compares it to the running build and posts one Inbox item.
    try {
        const { confirmPendingUpdateAfterRestart, startPendingUpdatePoll } = await import('@/lib/update/manager')
        void confirmPendingUpdateAfterRestart()
        // Keep the latest-release cache warm so the orchestrator chat prompt
        // can show <pending_update> without any blocking work on the hot path.
        startPendingUpdatePoll()
    } catch (err) {
        console.error('[update] failed to confirm post-restart state', err)
    }
}

function backgroundWorkDisabled(): boolean {
    return (
        process.env.ORCHESTRATOR_PREVIEW === '1' ||
        process.env.ORCHESTRATOR_DISABLE_BACKGROUND === '1' ||
        process.env.ORCHESTRATOR_DISABLE_SCHEDULER === '1' ||
        process.env.ORCHESTRATOR_DISABLE_MONITORS === '1' ||
        process.env.ORCHESTRATOR_DISABLE_MICROSCRIPTS === '1' ||
        process.env.ORCHESTRATOR_DISABLE_UPDATE_CONFIRMATION === '1'
    )
}
