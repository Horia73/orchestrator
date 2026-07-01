import { getEnvValue, getProviderApiKeyInfo } from '@/lib/config'
import { checkLMStudioServer, LM_STUDIO_API_KEY_ENV, LM_STUDIO_BASE_URL_ENV, type LMStudioHealth } from '@/lib/lm-studio'
import { getAllCliStatuses } from '@/lib/cli/status'
import { CLI_SPECS, type CliId } from '@/lib/cli/specs'
import type { EffectiveProviderEntry } from '@/lib/models/schema'

export type ProviderAuthKind = 'api-key' | 'base-url' | 'cli' | 'none'

export interface ProviderReadiness {
    available: boolean
    authKind: ProviderAuthKind
    apiKeyConfigured: boolean
    apiKeyMasked: string | null
    cliInstalled?: boolean
    cliLoggedIn?: boolean
    cliName?: string
    unavailableReason: string | null
    chatMessage: string | null
}

const CLI_PROVIDER_IDS = new Set<string>(['claude-code', 'codex'])
const BASE_URL_PROVIDER_IDS = new Set<string>(['lm-studio'])
const LM_STUDIO_READINESS_TTL_MS = 5000
let lmStudioReadinessCache: {
    key: string
    at: number
    health: LMStudioHealth
} | null = null

export function isCliProviderId(providerId: string): providerId is CliId {
    return CLI_PROVIDER_IDS.has(providerId)
}

function maskKey(key: string): string {
    return key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : 'configured'
}

function isNoApiKeyProvider(provider: EffectiveProviderEntry): boolean {
    return provider.apiKeyEnv.includes('NO_API_KEY')
}

export async function getProviderReadiness(
    providerId: string,
    provider: EffectiveProviderEntry | undefined
): Promise<ProviderReadiness> {
    if (!provider) {
        return {
            available: false,
            authKind: 'none',
            apiKeyConfigured: false,
            apiKeyMasked: null,
            unavailableReason: `Provider ${providerId} is not in the model registry.`,
            chatMessage: 'No model loaded. Choose a valid provider and model in Settings, then try again.',
        }
    }

    if (isCliProviderId(providerId)) {
        const statuses = await getAllCliStatuses()
        const status = statuses[providerId]
        const spec = CLI_SPECS[providerId]
        // A token that's expired-or-expiring-imminently is functionally
        // unavailable: the next chat will fail with a silent 401 from the
        // CLI. Surface this as a setup error up-front so the chat route
        // returns a structured 401 with a clear chatMessage instead of
        // letting the empty/cryptic stream error reach the bubble.
        const expired = Boolean(status?.needsReconnect)
        const available = Boolean(status?.installed && status?.loggedIn && !expired)
        const unavailableReason = available
            ? null
            : !status?.installed
                ? `${spec.name} is not installed.`
                : !status?.loggedIn
                    ? `${spec.name} is installed but not logged in.`
                    : `${spec.name} OAuth token has expired and needs reconnect.`
        return {
            available,
            authKind: 'cli',
            apiKeyConfigured: false,
            apiKeyMasked: null,
            cliInstalled: Boolean(status?.installed),
            cliLoggedIn: Boolean(status?.loggedIn) && !expired,
            cliName: spec.name,
            unavailableReason,
            chatMessage: available
                ? null
                : !status?.installed
                    ? `No model loaded. Install ${spec.name} from Settings > Models, then log in before sending a chat message.`
                    : !status?.loggedIn
                        ? `No model loaded. Log in to ${spec.name} from Settings > Models before sending a chat message.`
                        : `${spec.name} session expired. Open Settings > Models and click Reconnect, or run \`claude setup-token\` for a long-lived token that won't expire on a headless server.`,
        }
    }

    if (isNoApiKeyProvider(provider)) {
        return {
            available: true,
            authKind: 'none',
            apiKeyConfigured: false,
            apiKeyMasked: null,
            unavailableReason: null,
            chatMessage: null,
        }
    }

    if (BASE_URL_PROVIDER_IDS.has(providerId)) {
        const urlInfo = getProviderApiKeyInfo(providerId, provider)
        const url = urlInfo?.value ?? null
        if (!url) {
            return {
                available: false,
                authKind: 'base-url',
                apiKeyConfigured: false,
                apiKeyMasked: null,
                unavailableReason: `Missing ${LM_STUDIO_BASE_URL_ENV}.`,
                chatMessage: `No model loaded. Add ${LM_STUDIO_BASE_URL_ENV} in Settings > Models > LM Studio, then connect and try again.`,
            }
        }

        const apiKey = getEnvValue(LM_STUDIO_API_KEY_ENV)
        const health = await getCachedLMStudioReadiness(url, apiKey)
        const available = health.online
        return {
            available,
            authKind: 'base-url',
            apiKeyConfigured: true,
            apiKeyMasked: url,
            unavailableReason: available
                ? null
                : `LM Studio is offline at ${health.baseUrl}${health.error ? `: ${health.error}` : ''}`,
            chatMessage: available
                ? null
                : `LM Studio is configured but not reachable at ${health.baseUrl}. Start the LM Studio server, enable LAN access if needed, or reconnect it from Settings > Models > LM Studio.`,
        }
    }

    const keyInfo = getProviderApiKeyInfo(providerId, provider)
    const key = keyInfo?.value ?? null
    const available = Boolean(key && key.length > 0)
    return {
        available,
        authKind: 'api-key',
        apiKeyConfigured: available,
        apiKeyMasked: key ? maskKey(key) : null,
        unavailableReason: available
            ? null
            : `Missing ${provider.apiKeyEnv}.`,
        chatMessage: available
            ? null
            : `No model loaded. Add ${provider.apiKeyEnv} in Settings > Files > .env.local, then try again.`,
    }
}

async function getCachedLMStudioReadiness(baseUrl: string, apiKey: string | null): Promise<LMStudioHealth> {
    const key = `${baseUrl}\n${apiKey ?? ''}`
    const now = Date.now()
    if (
        lmStudioReadinessCache &&
        lmStudioReadinessCache.key === key &&
        now - lmStudioReadinessCache.at < LM_STUDIO_READINESS_TTL_MS
    ) {
        return lmStudioReadinessCache.health
    }
    const health = await checkLMStudioServer(baseUrl, apiKey, { timeoutMs: 900 })
    lmStudioReadinessCache = { key, at: now, health }
    return health
}

export async function getProviderReadinessMap(
    registry: Record<string, EffectiveProviderEntry>
): Promise<Record<string, ProviderReadiness>> {
    const entries = await Promise.all(
        Object.entries(registry).map(async ([providerId, provider]) => [
            providerId,
            await getProviderReadiness(providerId, provider),
        ] as const)
    )
    return Object.fromEntries(entries)
}
