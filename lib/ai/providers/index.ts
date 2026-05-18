import type { AIProvider, ProviderCapabilities } from '@/lib/ai/agents/types'
import { GoogleProvider, GOOGLE_CAPABILITIES } from './google'
import { AnthropicProvider } from './anthropic'
import { OpenAIProvider } from './openai'
import { ClaudeCodeProvider } from './claude-code'
import { CodexProvider } from './codex'
import { BrowserProvider } from './browser'

const providerCache = new Map<string, { apiKey: string; provider: AIProvider }>()

export function getProvider(providerId: string, apiKey: string): AIProvider {
    // Cache providers by id + key so config changes do not keep using a stale client.
    const cached = providerCache.get(providerId)
    if (cached?.apiKey === apiKey) return cached.provider

    let provider: AIProvider

    switch (providerId) {
        case 'google':
            provider = new GoogleProvider(apiKey)
            break
        case 'anthropic':
            provider = new AnthropicProvider(apiKey)
            break
        case 'openai':
            provider = new OpenAIProvider(apiKey)
            break
        case 'claude-code':
            provider = new ClaudeCodeProvider(apiKey)
            break
        case 'codex':
            provider = new CodexProvider(apiKey)
            break
        case 'browser':
            provider = new BrowserProvider(apiKey)
            break
        default:
            throw new Error(`Unknown provider: ${providerId}`)
    }

    providerCache.set(providerId, { apiKey, provider })
    return provider
}

/**
 * Provider capability snapshot — safe to call without an API key. Used by
 * settings/registry to decide which providers to surface for which agent kind.
 */
const STATIC_CAPABILITIES: Record<string, ProviderCapabilities> = {
    // Google has to be sourced from a const — instantiating the class would
    // construct `new GoogleGenAI({ apiKey: '' })`, which logs a warning.
    google: GOOGLE_CAPABILITIES,
    anthropic: new AnthropicProvider('').capabilities,
    openai: new OpenAIProvider('').capabilities,
    'claude-code': new ClaudeCodeProvider('').capabilities,
    codex: new CodexProvider('').capabilities,
    browser: new BrowserProvider('').capabilities,
}

export function getProviderCapabilities(providerId: string): ProviderCapabilities | null {
    return STATIC_CAPABILITIES[providerId] ?? null
}
