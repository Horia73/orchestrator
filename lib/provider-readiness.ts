import { getProviderApiKeyInfo } from '@/lib/config'
import { getAllCliStatuses } from '@/lib/cli/status'
import { CLI_SPECS, type CliId } from '@/lib/cli/specs'
import type { EffectiveProviderEntry } from '@/lib/models/schema'

export type ProviderAuthKind = 'api-key' | 'cli' | 'none'

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
        const available = Boolean(status?.installed && status?.loggedIn)
        const unavailableReason = available
            ? null
            : !status?.installed
                ? `${spec.name} is not installed.`
                : `${spec.name} is installed but not logged in.`
        return {
            available,
            authKind: 'cli',
            apiKeyConfigured: false,
            apiKeyMasked: null,
            cliInstalled: Boolean(status?.installed),
            cliLoggedIn: Boolean(status?.loggedIn),
            cliName: spec.name,
            unavailableReason,
            chatMessage: available
                ? null
                : !status?.installed
                    ? `No model loaded. Install ${spec.name} from Settings > Auth, then log in before sending a chat message.`
                    : `No model loaded. Log in to ${spec.name} from Settings > Auth before sending a chat message.`,
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
