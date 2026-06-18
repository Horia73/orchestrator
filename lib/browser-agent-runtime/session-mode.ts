export type BrowserSessionMode = 'persistent' | 'incognito'

export const DEFAULT_BROWSER_SESSION_MODE: BrowserSessionMode = 'persistent'
export const BROWSER_SESSION_PREFIX = 'browser_'
export const BROWSER_INCOGNITO_SESSION_PREFIX = 'browser_incognito_'

export function parseBrowserSessionMode(value: unknown): BrowserSessionMode | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim().toLowerCase().replace(/[_\s]+/g, '-')
    if (normalized === 'persistent') return 'persistent'
    if (normalized === 'incognito' || normalized === 'private') return 'incognito'
    return null
}

export function inferBrowserSessionModeFromSessionId(sessionId: string | null | undefined): BrowserSessionMode | null {
    if (!sessionId) return null
    if (sessionId.startsWith(BROWSER_INCOGNITO_SESSION_PREFIX)) return 'incognito'
    if (sessionId.startsWith(BROWSER_SESSION_PREFIX)) return 'persistent'
    return null
}

export function browserSessionModeLabel(mode: BrowserSessionMode): string {
    return mode === 'incognito' ? 'incognito' : 'persistent'
}
