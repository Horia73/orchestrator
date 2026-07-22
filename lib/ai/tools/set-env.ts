import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import { displayPath } from './sandbox'
import { stringArg } from './helpers'
import { invalidateMapsConnectionProbe } from '@/lib/integrations/maps'
import { invalidateWeatherConnectionProbe } from '@/lib/integrations/weather'
import { invalidateWeatherProviderState } from '@/lib/weather/providers'
import { upsertWorkspaceEnvValue } from '@/lib/secrets/workspace-env'

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

    try {
        const result = upsertWorkspaceEnvValue(key, value)
        if (key === 'GOOGLE_MAPS_API_KEY') {
            invalidateMapsConnectionProbe()
            invalidateWeatherConnectionProbe()
            invalidateWeatherProviderState()
        }

        return {
            success: true,
            data: {
                path: displayPath(result.path),
                key,
                action: result.action,
                value: '[redacted]',
                bytes: result.bytes,
            },
        }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Unknown error writing env var' }
    }
}
