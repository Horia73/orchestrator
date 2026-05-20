import type { ProviderCapabilities } from '@/lib/ai/agents/types'

export const BROWSER_CAPABILITIES: ProviderCapabilities = {
    kinds: ['text'],
    nativeBuiltins: [],
    statefulMode: true,
    promptCaching: 'none',
    attachmentMode: 'none',
    thinkingSupport: false,
    requiresApiKey: false,
}
