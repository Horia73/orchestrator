// Next.js boot hook. `registerRuntime()` runs once when the Node server process
// starts (both `next dev` and `next start`). This is where the scheduler's
// background tick is armed. It must never be bundled into Edge instrumentation.
export async function registerRuntime(): Promise<void> {
    const {
        isDurableAiWorkerProcess,
        ownsDurableAiBackgroundWork,
    } = await import('@/lib/ai/durable-worker')
    const { mayOwnDurableAiBackgroundWork } = await import('@/lib/ai/worker-generations')
    // Apply a staged backup restore BEFORE anything opens the database. The
    // connection in '@/lib/db' is created at import time, so a restored data.db
    // can only be swapped in here, on the next boot after a restore. The boot
    // module intentionally imports nothing that touches '@/lib/db'.
    if (ownsDurableAiBackgroundWork() && mayOwnDurableAiBackgroundWork()) {
        try {
            const { applyPendingDbRestore } = await import('@/lib/settings/backup-boot')
            applyPendingDbRestore()
        } catch (err) {
            console.error('[backup] pending restore check failed', err)
        }
    }
    // The voice gateway is a request-serving surface (WebSocket upgrade
    // handler consumed by scripts/start.mjs via a globalThis hook), not
    // background work — register it even when schedulers are disabled, but
    // never in throwaway preview instances.
    if (process.env.ORCHESTRATOR_PREVIEW !== '1' && !isDurableAiWorkerProcess()) {
        try {
            const { registerVoiceGateway } = await import('@/lib/voice/gateway')
            registerVoiceGateway()
        } catch (err) {
            console.error('[voice] failed to register voice gateway', err)
        }
    }
    // Data migration (not background work): promote any legacy profile-scoped
    // skills into the shared global skills root. Custom skills are global-only
    // by policy; this back-fills installs that predate that migration so nothing
    // lingers with a read-only "Profile" badge. Idempotent — a cheap no-op once
    // each profile's private/skills dir is drained. Runs before the background
    // gate so it still applies when schedulers/monitors are disabled.
    if (process.env.ORCHESTRATOR_PREVIEW !== '1' && !isDurableAiWorkerProcess()) {
        try {
            const { promoteLegacyProfileSkillsToGlobal } = await import('@/lib/skills/registry')
            await forEachProfile((profileId) => {
                const { moved, skipped } = promoteLegacyProfileSkillsToGlobal()
                if (moved.length) {
                    console.log(
                        `[skills] promoted ${moved.length} legacy profile skill(s) to global for ${profileId}: ${moved.join(', ')}`,
                    )
                }
                if (skipped.length) {
                    console.warn(
                        `[skills] kept ${skipped.length} legacy profile skill(s) for ${profileId} (a global skill already owns the id): ${skipped.join(', ')}`,
                    )
                }
            })
        } catch (err) {
            console.error('[skills] failed to promote legacy profile skills', err)
        }
    }
    // Both the request-serving web process and the worker need their own OOM
    // backstop. Keep this before the background-owner return below.
    if (!backgroundWorkDisabled()) {
        try {
            const { startMemoryWatchdog } = await import('@/lib/observability/memory-watchdog')
            startMemoryWatchdog()
        } catch (err) {
            console.error('[memory] failed to arm watchdog', err)
        }
    }

    if (backgroundWorkDisabled() || !ownsDurableAiBackgroundWork()) return
    const { startBackgroundRuntimeWhenLeader } = await import('@/lib/ai/background-leadership')
    startBackgroundRuntimeWhenLeader(initializeBackgroundRuntime)
}

async function initializeBackgroundRuntime(): Promise<void> {
    // Recovery must wait until the previous generation is fully drained. A
    // standby worker shares the same profile DBs and must never seal request
    // logs or detached jobs that are still alive in the old process.
    try {
        const { sealInterruptedStreamingRequestLogs } = await import('@/lib/observability/store')
        await forEachProfile(() => sealInterruptedStreamingRequestLogs())
    } catch (err) {
        console.error('[observability] failed to seal interrupted profile streams', err)
    }

    const { startScheduler } = await import('@/lib/scheduling/scheduler')
    startScheduler()
    // Steering resilience: if a queued follow-up isn't drained by the client
    // that sent it (phone locked mid-run), run it headlessly via a wake turn.
    try {
        const { startFollowUpSweep } = await import('@/lib/chat-wake')
        startFollowUpSweep()
    } catch (err) {
        console.error('[chat-wake] failed to arm follow-up sweep', err)
    }
    // Tracked background jobs: reconcile rows that were 'running' before a
    // restart (their child processes are no longer ours) and arm the liveness
    // poll that fires completion wakes.
    try {
        const { startBackgroundJobWatcher } = await import('@/lib/ai/background-jobs')
        startBackgroundJobWatcher()
    } catch (err) {
        console.error('[background-jobs] failed to arm watcher', err)
    }
    // Async specialist batches normally keep the durable worker registered
    // until every child settles. If the process itself crashed, seal the
    // durable rows as lost and wake only batches the parent explicitly
    // detached, so potentially side-effecting work is never replayed blindly.
    try {
        const { startAsyncDelegationRecovery } = await import('@/lib/ai/async-delegations')
        startAsyncDelegationRecovery()
    } catch (err) {
        console.error('[async-delegations] failed to arm recovery', err)
    }
    // A host/container restart kills detached self-development previews but
    // leaves their isolated worktrees intact. Recover only the newest recent
    // dirty run, then wake its owning conversation to continue the same gate.
    try {
        const { startSelfDevRecovery } = await import('@/lib/self-dev/recovery')
        startSelfDevRecovery()
    } catch (err) {
        console.error('[self-dev] failed to arm interrupted-run recovery', err)
    }
    // Pre-warm the integration status snapshot so the first scheduler tick
    // (Smart Monitor, Microscripts, scheduled agents) sees real connection
    // state instead of `unknown`. Fire-and-forget — boot must not block on
    // network probes; if the refresh fails, the snapshot stays cold and the
    // stale-while-revalidate path will retry on the next read.
    try {
        const { refreshIntegrationStatusSnapshot } = await import('@/lib/integrations/status-snapshot')
        void forEachProfile(() => refreshIntegrationStatusSnapshot()).catch((err) => {
            console.error('[integrations] failed to pre-warm status snapshot', err)
        })
    } catch (err) {
        console.error('[integrations] failed to schedule status pre-warm', err)
    }
    // Connect the consolidated markets monitor to the watchlist data layer and
    // arm its system heartbeat. Best-effort: a failure here must not break boot.
    try {
        const { wireMarketsMonitor } = await import('@/lib/monitoring/watchlist-adapter')
        await forEachProfile(() => wireMarketsMonitor())
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
        await forEachProfile(() => wireSmartMonitor())
        const { appEventEmitter } = await import('@/lib/events')
        appEventEmitter.on('app:update', (event) => {
            if (event?.type !== 'monitor_watches.changed') return
            runForEventProfile(event, () => syncSmartMonitorActivation()).catch((syncErr) => {
                console.error('[smart-monitor] sync after watch change failed', syncErr)
            })
        })
        // Catch up missed integration-install offer cards (e.g., user
        // connected Gmail while the app was down). Best-effort; idempotent.
        const { maybeOfferSmartMonitor } = await import('@/lib/monitoring/smart-monitor-offer')
        void forEachProfile(() => maybeOfferSmartMonitor())
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
        await forEachProfile(() => wireMicroscripts())
        const { appEventEmitter } = await import('@/lib/events')
        appEventEmitter.on('app:update', (event) => {
            if (event?.type !== 'microscripts.changed') return
            runForEventProfile(event, () => syncMicroscriptsActivation()).catch((syncErr) => {
                console.error('[microscripts] sync after change failed', syncErr)
            })
        })
    } catch (err) {
        console.error('[microscripts] failed to wire heartbeat', err)
    }
    // Durable webhook → Microscript delivery queue. Microscript recovery must
    // run first so an interrupted script is claimable before its queued event
    // resumes. Ingress kicks workers immediately; this hook recovers rows that
    // were queued/running when the process stopped.
    try {
        const { wireWebhookDispatchQueue } = await import('@/lib/webhooks/dispatch')
        await wireWebhookDispatchQueue()
    } catch (err) {
        console.error('[webhooks] failed to wire dispatch queue', err)
    }
    // Arm the nightly Memory reflection system task. Idempotent — creates the
    // single "Memory reflection" agent wake on first boot and reconciles its
    // schedule/prompt on each boot. Stays enabled unconditionally; the heavy
    // logic is model-owned in the task's dedicated wake prompt, not in code.
    try {
        const { wireMemoryReflection } = await import('@/lib/monitoring/memory-reflection-adapter')
        await forEachProfile(() => wireMemoryReflection())
        const { appEventEmitter } = await import('@/lib/events')
        appEventEmitter.on('app:update', (event) => {
            if (event?.type !== 'config.updated') return
            runForEventProfile(event, () => wireMemoryReflection()).catch((syncErr) => {
                console.error('[memory] sync after config change failed', syncErr)
            })
        })
    } catch (err) {
        console.error('[memory] failed to wire memory reflection', err)
    }
    // Arm the weekly Capability audit system task. Idempotent — creates the
    // single "Capability audit" agent wake on first boot and reconciles its
    // schedule/prompt on each boot (and on timezone change). It only triages
    // AGENT_NEEDS.md into a ranked Inbox proposal and never implements; the
    // logic is model-owned in the task prompt, not in code.
    try {
        const { wireCapabilityAudit } = await import('@/lib/self-dev/capability-audit-adapter')
        await forEachProfile(() => wireCapabilityAudit())
        const { appEventEmitter } = await import('@/lib/events')
        appEventEmitter.on('app:update', (event) => {
            if (event?.type !== 'config.updated') return
            runForEventProfile(event, () => wireCapabilityAudit()).catch((syncErr) => {
                console.error('[capability-audit] sync after config change failed', syncErr)
            })
        })
    } catch (err) {
        console.error('[capability-audit] failed to wire capability audit', err)
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

type ProfileAwareEvent = { profileId?: string | null }

async function forEachProfile<T>(
    fn: (profileId: string) => T | Promise<T>,
): Promise<void> {
    const { listProfiles } = await import('@/lib/profiles/store')
    const { runWithProfileContext } = await import('@/lib/profiles/context')
    for (const profile of listProfiles()) {
        await runWithProfileContext(
            { profileId: profile.id, role: profile.role },
            () => fn(profile.id),
        )
    }
}

async function runForEventProfile<T>(
    event: ProfileAwareEvent,
    fn: () => T | Promise<T>,
): Promise<void> {
    const profileId = event.profileId
    if (!profileId) {
        await forEachProfile(fn)
        return
    }
    const { runWithProfileContext } = await import('@/lib/profiles/context')
    await runWithProfileContext({ profileId }, fn)
}
