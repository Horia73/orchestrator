import type {
    AvailabilityResult,
    CheapCheckInput,
    CheapCheckResult,
    SourceAdapter,
} from './types'

// ---------------------------------------------------------------------------
// Reserved-slot custom source adapter.
//
// `custom` exists in the WatchSource union as an escape hatch for future
// adapters that don't fit the existing sources (e.g., custom HTTP webhooks,
// IoT MQTT subscriptions, third-party services). Today it is intentionally
// unimplemented — creating a watch with source: 'custom' is allowed by the
// schema but cheap-check reports it unavailable, so the engine skips it.
//
// When a real custom source ships, replace this stub with the concrete
// adapter and register it in lib/monitor/sources/index.ts.
// ---------------------------------------------------------------------------

export const customSourceAdapter: SourceAdapter = {
    source: 'custom',
    supportedRuleKinds: [],
    supportedActionKinds: ['notify_inbox'],

    async isAvailable(): Promise<AvailabilityResult> {
        return {
            available: false,
            reason: 'Custom source has no adapter yet. Pick gmail / google_calendar / whatsapp / home_assistant / web / weather.',
        }
    },

    async cheapCheck(input: CheapCheckInput): Promise<CheapCheckResult> {
        return {
            ok: false,
            error: 'Custom source has no adapter yet.',
            matches: [],
            candidatesSeen: 0,
            stateUpdate: {},
            fetchedAt: input.now,
        }
    },
}
