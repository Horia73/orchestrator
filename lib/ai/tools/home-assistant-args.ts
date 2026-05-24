import type { ToolDef } from '@/lib/ai/agents/types'
import { booleanArg, clamp, numberArg } from './helpers'

export function inventorySchema(): ToolDef['input_schema'] {
    return {
        type: 'object',
        properties: {
            include_attributes: {
                type: 'boolean',
                description: 'Include full entity attributes. Defaults to true for automation/script/scene inspection.',
            },
            max_results: {
                type: 'integer',
                description: 'Maximum entities to return. Defaults to 500 and is capped at 5000.',
            },
        },
    }
}

export function inventoryOptions(args: Record<string, unknown>) {
    return {
        includeAttributes: booleanArg(args, ['include_attributes', 'includeAttributes'], true),
        maxResults: clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 500)), 1, 5000),
    }
}

export function stringListArg(args: Record<string, unknown>, keys: string[]): string[] {
    for (const key of keys) {
        const value = args[key]
        if (Array.isArray(value))
            return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        if (typeof value === 'string' && value.trim()) {
            return value
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
        }
    }
    return []
}

export function registryKindsArg(args: Record<string, unknown>) {
    const allowed = new Set(['areas', 'devices', 'entities', 'floors', 'labels'])
    const kinds = stringListArg(args, ['kinds', 'kind']).filter((kind) => allowed.has(kind))
    return kinds.length ? (kinds as Array<'areas' | 'devices' | 'entities' | 'floors' | 'labels'>) : undefined
}

export function recordArg(args: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
    for (const key of keys) {
        const value = args[key]
        if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
        if (typeof value === 'string' && value.trim().startsWith('{')) {
            try {
                const parsed = JSON.parse(value) as unknown
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                    return parsed as Record<string, unknown>
            } catch {
                return undefined
            }
        }
    }
    return undefined
}

export function optionalNumberArg(args: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = args[key]
        if (typeof value === 'number' && Number.isFinite(value)) return value
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value)
            if (Number.isFinite(parsed)) return parsed
        }
    }
    return undefined
}

export function numberArrayArg(args: Record<string, unknown>, keys: string[]): number[] | undefined {
    for (const key of keys) {
        const value = args[key]
        if (Array.isArray(value)) {
            const parsed = value
                .map((item) => (typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : Number.NaN))
                .filter(Number.isFinite)
            if (parsed.length > 0) return parsed
        }
        if (typeof value === 'string' && value.trim()) {
            const parsed = value
                .split(',')
                .map((item) => Number(item.trim()))
                .filter(Number.isFinite)
            if (parsed.length > 0) return parsed
        }
    }
    return undefined
}
