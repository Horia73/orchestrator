import { mayOwnDurableAiBackgroundWork } from '@/lib/ai/worker-generations'
import { durableAiWorkerId } from '@/lib/ai/worker-generations'

type Initializer = () => void | Promise<void>

interface BackgroundLeadershipState {
    initialized: boolean
    initializing: boolean
    timer: ReturnType<typeof setInterval> | null
}

const globalForLeadership = globalThis as unknown as {
    __orchestratorBackgroundLeadership?: BackgroundLeadershipState
}

const state = globalForLeadership.__orchestratorBackgroundLeadership ?? {
    initialized: false,
    initializing: false,
    timer: null,
}
if (!globalForLeadership.__orchestratorBackgroundLeadership) {
    globalForLeadership.__orchestratorBackgroundLeadership = state
}

/** Arm a standby-safe background runtime. Every worker process boots this
 * watcher, but only the generation named by registry.backgroundOwner runs the
 * initializer. Promotion therefore needs no process restart and recovery never
 * races a still-draining generation. */
export function startBackgroundRuntimeWhenLeader(initializer: Initializer): void {
    const maybeInitialize = async () => {
        if (state.initialized || state.initializing || !mayOwnDurableAiBackgroundWork()) return
        state.initializing = true
        try {
            await initializer()
            state.initialized = true
        } catch (error) {
            console.error('[background-leadership] initialization failed', error)
        } finally {
            state.initializing = false
        }
    }

    void maybeInitialize()
    if (state.timer) return
    state.timer = setInterval(() => {
        void maybeInitialize()
    }, 500)
    state.timer.unref?.()
}

export function isBackgroundRuntimeReady(): boolean {
    return state.initialized && mayOwnDurableAiBackgroundWork()
}

export function canRunBackgroundLoop(): boolean {
    if (process.env.ORCHESTRATOR_AI_WORKER_PROCESS !== '1' || !durableAiWorkerId()) {
        return true
    }
    return state.initialized && mayOwnDurableAiBackgroundWork()
}
