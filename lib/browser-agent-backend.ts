import type { BrowserBackend, BrowserBackendPreference } from '@/lib/browser-agent-runtime/config'

export type BrowserBackendConfigSource = 'settings' | 'default'

export interface BrowserBackendResolution {
    configured: BrowserBackendPreference
    effective: BrowserBackend
    source: BrowserBackendConfigSource
    platform: NodeJS.Platform
    reason: string
}

interface ResolveBrowserBackendOptions {
    settingsValue?: BrowserBackendPreference | null
    platform?: NodeJS.Platform
}

export function parseBrowserBackendPreference(value: unknown): BrowserBackendPreference | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim().toLowerCase().replace(/_/g, '-')
    return normalized === 'patchright' ? 'patchright' : null
}

export function resolveBrowserBackend(options: ResolveBrowserBackendOptions = {}): BrowserBackendResolution {
    const platform = options.platform ?? process.platform
    const configured = options.settingsValue ?? 'patchright'
    return {
        configured,
        effective: 'patchright',
        source: options.settingsValue ? 'settings' : 'default',
        platform,
        reason: 'Patchright is the only browser backend.',
    }
}
