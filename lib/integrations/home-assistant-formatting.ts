import type { HomeAssistantState, HomeAssistantStateSummary } from './home-assistant'

export function filterStates(states: HomeAssistantState[], domain?: string, query?: string): HomeAssistantState[] {
    const cleanDomain = cleanDomainFilter(domain)
    const cleanQuery = query?.trim().toLowerCase() ?? ''
    return states
        .filter(state => !cleanDomain || getEntityDomain(state.entity_id) === cleanDomain)
        .filter(state => {
            if (!cleanQuery) return true
            const name = stringField(state.attributes ?? {}, 'friendly_name').toLowerCase()
            return state.entity_id.toLowerCase().includes(cleanQuery)
                || state.state.toLowerCase().includes(cleanQuery)
                || name.includes(cleanQuery)
        })
        .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
}

export function summarizeState(state: HomeAssistantState, includeAttributes: boolean): HomeAssistantStateSummary {
    const attributes = isRecord(state.attributes) ? state.attributes : {}
    return {
        entity_id: state.entity_id,
        domain: getEntityDomain(state.entity_id),
        state: state.state,
        name: stringField(attributes, 'friendly_name') || null,
        last_changed: state.last_changed ?? null,
        last_updated: state.last_updated ?? null,
        attributes: includeAttributes ? attributes : pickKnownAttributes(attributes),
    }
}

export function cleanEntity(value: string): string {
    return value.trim().replace(/\s+/g, '')
}

export function uniqueCleanEntities(values: string[]): string[] {
    return [...new Set(values.map(cleanEntity).filter(Boolean))]
}

export function cleanDomainFilter(value: string | undefined): string {
    return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '')
}

export function normalizeTimestamp(value: string | undefined): string | null {
    const trimmed = value?.trim()
    if (!trimmed) return null
    const date = new Date(trimmed)
    return Number.isNaN(date.getTime()) ? trimmed : date.toISOString()
}

export function defaultStartTime(): string {
    return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
}

export function clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min
    return Math.min(max, Math.max(min, Math.floor(value)))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function stringField(record: Record<string, unknown>, key: string): string {
    const value = record[key]
    return typeof value === 'string' ? value : ''
}

export function getEntityDomain(entityId: string): string {
    const idx = entityId.indexOf('.')
    return idx > 0 ? entityId.slice(0, idx) : ''
}

function pickKnownAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
    const keys = [
        'friendly_name',
        'unit_of_measurement',
        'device_class',
        'state_class',
        'icon',
        'entity_picture',
        'last_triggered',
        'mode',
        'current',
        'supported_features',
    ]
    const out: Record<string, unknown> = {}
    for (const key of keys) {
        if (attributes[key] !== undefined) out[key] = attributes[key]
    }
    return out
}
