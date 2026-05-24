import fs from 'fs'

import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { displayPath, resolveSandboxedWritable } from './sandbox'
import { ensureParentDir, stringArg } from './helpers'
import { emitAppEvent } from '@/lib/events'
import { invalidateMapsConnectionProbe } from '@/lib/integrations/maps'
import { invalidateWeatherConnectionProbe } from '@/lib/integrations/weather'
import { invalidateWeatherProviderState } from '@/lib/weather/providers'

export const setEnvTool: ToolDef = {
    id: 'SetEnv',
    name: 'SetEnv',
    description: [
        'Sets or updates one variable in the workspace .env.local file.',
        'Use this for API keys, tokens, service URLs, local IPs, and runtime configuration that should not go into markdown memory.',
        'The value is written to disk but never returned in the tool result.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            key: {
                type: 'string',
                description: 'Environment variable name, e.g. HOME_ASSISTANT_TOKEN.',
            },
            value: {
                type: 'string',
                description: 'Environment variable value. This is sensitive and will be redacted in UI/tool logs.',
            },
        },
        required: ['key', 'value'],
    },
    tags: ['write', 'filesystem', 'secret'],
}

export function executeSetEnv(args: Record<string, unknown>): ToolResult {
    const key = stringArg(args, ['key', 'name'])
    const value = args.value

    if (!key) return { success: false, error: 'Missing required parameter: key' }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        return { success: false, error: `Invalid env var name: ${key}` }
    }
    if (typeof value !== 'string') return { success: false, error: 'Missing required string parameter: value' }

    const sandboxed = resolveSandboxedWritable('.env.local')
    if (!sandboxed.ok) return { success: false, error: sandboxed.error }

    try {
        ensureParentDir(sandboxed.resolved)
        const existing = fs.existsSync(sandboxed.resolved)
            ? fs.readFileSync(sandboxed.resolved, 'utf-8')
            : ''
        const lines = existing.split(/\r?\n/).filter(line => !line.trim().startsWith('#'))
        const formatted = `${key}=${formatEnvValue(value)}`
        let action: 'created' | 'updated' = 'created'
        const next = [...lines]
        const keyIndex = next.findIndex(line => isKeyLine(line, key))

        if (keyIndex >= 0) {
            action = 'updated'
            next[keyIndex] = formatted
        } else {
            while (next.length > 0 && next[next.length - 1] === '') next.pop()
            next.push(formatted)
        }

        const output = next.join('\n').replace(/\n*$/, '\n')
        fs.writeFileSync(sandboxed.resolved, output, 'utf-8')
        try {
            fs.chmodSync(sandboxed.resolved, 0o600)
        } catch {
            // Best effort; some filesystems ignore chmod.
        }
        process.env[key] = value
        if (key === 'GOOGLE_MAPS_API_KEY') {
            invalidateMapsConnectionProbe()
            invalidateWeatherConnectionProbe()
            invalidateWeatherProviderState()
        }
        emitAppEvent({ type: 'settings.changed', reason: 'env' })

        return {
            success: true,
            data: {
                path: displayPath(sandboxed.resolved),
                key,
                action,
                value: '[redacted]',
                bytes: Buffer.byteLength(output, 'utf-8'),
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Unknown error writing env var' }
    }
}

function isKeyLine(line: string, key: string): boolean {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return false
    const idx = trimmed.indexOf('=')
    if (idx <= 0) return false
    return trimmed.slice(0, idx).trim() === key
}

function formatEnvValue(value: string): string {
    if (value === '') return '""'
    if (/^[A-Za-z0-9_./:@%+=,\-]+$/.test(value)) return value
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
