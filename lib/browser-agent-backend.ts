import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'

import type { BrowserBackend, BrowserBackendPreference } from '@/lib/browser-agent-runtime/config'

export type BrowserBackendConfigSource = 'env' | 'settings' | 'default'

export interface BrowserBackendDiagnostics {
    supported: boolean
    missing: string[]
}

export interface BrowserBackendResolution {
    configured: BrowserBackendPreference
    effective: BrowserBackend
    source: BrowserBackendConfigSource
    envOverride: BrowserBackendPreference | null
    platform: NodeJS.Platform
    officialDisplay: BrowserBackendDiagnostics
    reason: string
}

interface ResolveBrowserBackendOptions {
    envValue?: string | null
    settingsValue?: BrowserBackendPreference | null
    chromeExecutablePath?: string | null
    platform?: NodeJS.Platform
}

const OFFICIAL_DISPLAY_TOOLS: Array<{ commands: string[]; label: string }> = [
    {
        commands: ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome'],
        label: 'Chromium/Chrome',
    },
    { commands: ['Xvnc', 'Xtigervnc'], label: 'Xvnc/TigerVNC' },
    { commands: ['xdotool'], label: 'xdotool' },
    { commands: ['xclip'], label: 'xclip' },
    { commands: ['import'], label: 'ImageMagick import' },
]

export function parseBrowserBackendPreference(value: unknown): BrowserBackendPreference | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim().toLowerCase().replace(/_/g, '-')
    if (normalized === 'auto' || normalized === 'patchright' || normalized === 'official-display') {
        return normalized
    }
    return null
}

export function resolveBrowserBackend(options: ResolveBrowserBackendOptions = {}): BrowserBackendResolution {
    const platform = options.platform ?? process.platform
    const envOverride = parseBrowserBackendPreference(options.envValue ?? process.env.BROWSER_AGENT_BACKEND)
    const configured = envOverride
        ?? options.settingsValue
        ?? 'auto'
    const source: BrowserBackendConfigSource = envOverride
        ? 'env'
        : options.settingsValue
            ? 'settings'
            : 'default'
    const officialDisplay = getOfficialDisplayDiagnostics({
        chromeExecutablePath: options.chromeExecutablePath,
        platform,
    })

    if (configured === 'patchright') {
        return {
            configured,
            effective: 'patchright',
            source,
            envOverride,
            platform,
            officialDisplay,
            reason: 'Patchright is explicitly selected.',
        }
    }

    if (configured === 'official-display') {
        return {
            configured,
            effective: 'official-display',
            source,
            envOverride,
            platform,
            officialDisplay,
            reason: officialDisplay.supported
                ? 'Official Chromium display is explicitly selected.'
                : formatOfficialDisplayUnavailableReason(platform, officialDisplay.missing, 'Official Chromium display is explicitly selected but unavailable'),
        }
    }

    if (platform === 'linux' && officialDisplay.supported) {
        return {
            configured,
            effective: 'official-display',
            source,
            envOverride,
            platform,
            officialDisplay,
            reason: 'Auto selected official Chromium display on Linux.',
        }
    }

    return {
        configured,
        effective: 'patchright',
        source,
        envOverride,
        platform,
        officialDisplay,
        reason: platform === 'linux'
            ? formatOfficialDisplayUnavailableReason(platform, officialDisplay.missing, 'Auto fell back to Patchright')
            : `Auto selected Patchright on ${platform}.`,
    }
}

function getOfficialDisplayDiagnostics({
    chromeExecutablePath,
    platform,
}: {
    chromeExecutablePath?: string | null
    platform: NodeJS.Platform
}): BrowserBackendDiagnostics {
    if (platform !== 'linux') {
        return {
            supported: false,
            missing: [`Linux host (current platform: ${platform})`],
        }
    }

    const missing: string[] = []
    const chromeCandidates = [
        chromeExecutablePath || undefined,
        process.env.BROWSER_AGENT_CHROME_EXECUTABLE_PATH,
        process.env.CHROME_EXECUTABLE_PATH,
        ...OFFICIAL_DISPLAY_TOOLS[0].commands,
    ]
    if (!findExecutable(chromeCandidates)) missing.push(OFFICIAL_DISPLAY_TOOLS[0].label)

    for (const tool of OFFICIAL_DISPLAY_TOOLS.slice(1)) {
        if (!findExecutable(tool.commands)) missing.push(tool.label)
    }

    return {
        supported: missing.length === 0,
        missing,
    }
}

function formatOfficialDisplayUnavailableReason(
    platform: NodeJS.Platform,
    missing: string[],
    prefix: string,
): string {
    if (platform !== 'linux') {
        return `${prefix}: official-display only runs on Linux.`
    }
    return missing.length > 0
        ? `${prefix}: missing ${missing.join(', ')}.`
        : `${prefix}: official-display is unavailable.`
}

function findExecutable(candidates: Array<string | undefined>): string | null {
    for (const candidate of candidates) {
        if (!candidate) continue
        if (candidate.includes(path.sep) && fs.existsSync(/* turbopackIgnore: true */ candidate)) return candidate
        const found = spawnSync('sh', ['-lc', `command -v ${shellQuote(candidate)}`], { encoding: 'utf8' })
        const value = found.stdout.trim()
        if (found.status === 0 && value) return value
    }
    return null
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}
