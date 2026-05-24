import {
    getConfig,
    updateConfig,
    type SmartMonitorLiveLocationSource,
} from '@/lib/config'
import {
    homeAssistantGetState,
    homeAssistantListStates,
    type HomeAssistantState,
    type HomeAssistantStateSummary,
} from '@/lib/integrations/home-assistant'
import type { MapCoordinate } from '@/lib/maps/schema'
import { getUserMapLocation } from '@/lib/maps/user-location'

export type CurrentMapLocationSource = 'home-assistant' | 'profile'

export interface CurrentMapLocation {
    source: CurrentMapLocationSource
    label: string
    position: MapCoordinate
    accuracyMeters: number | null
    entityId?: string
    state?: string
    lastUpdated?: string | null
    fallbackReason?: string
}

export interface HomeAssistantLocationCandidate {
    provider: 'home-assistant'
    entityId: string
    domain: string
    label: string
    state: string
    position: MapCoordinate | null
    accuracyMeters: number | null
    lastUpdated: string | null
    selected: boolean
}

const ENTITY_ID_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+$/i
const LOCATION_DOMAINS = new Set(['person', 'device_tracker', 'zone'])

export function getConfiguredHomeAssistantLocationSource(): SmartMonitorLiveLocationSource | null {
    const source = getConfig().smartMonitor?.liveLocationSource
    return source?.provider === 'home-assistant' ? source : null
}

export async function resolveCurrentMapLocation(): Promise<CurrentMapLocation> {
    const configuredSource = getConfiguredHomeAssistantLocationSource()
    if (configuredSource) {
        try {
            const state = await homeAssistantGetState(configuredSource.entityId)
            const direct = extractHomeAssistantLocation(state)
            const zoneFallback = direct
                ? null
                : await resolveHomeAssistantZoneLocation(state.state).catch(() => null)
            const location = direct ?? zoneFallback

            if (location) {
                return {
                    source: 'home-assistant',
                    label: configuredSource.label || location.label,
                    position: location.position,
                    accuracyMeters: location.accuracyMeters,
                    entityId: state.entity_id,
                    state: state.state,
                    lastUpdated: state.last_updated ?? state.last_changed ?? null,
                }
            }

            return profileFallback(`Home Assistant entity ${state.entity_id} has no latitude/longitude.`)
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Home Assistant location could not be read.'
            return profileFallback(message)
        }
    }

    return profileFallback(null)
}

export async function listHomeAssistantLocationCandidates(): Promise<HomeAssistantLocationCandidate[]> {
    const selected = getConfiguredHomeAssistantLocationSource()?.entityId ?? null
    const inventory = await homeAssistantListStates({
        includeAttributes: true,
        maxResults: 5_000,
    })

    return inventory.states
        .filter(state => isLocationCandidate(state))
        .map(state => {
            const location = extractHomeAssistantLocation(state)
            return {
                provider: 'home-assistant' as const,
                entityId: state.entity_id,
                domain: state.domain,
                label: state.name || state.entity_id,
                state: state.state,
                position: location?.position ?? null,
                accuracyMeters: location?.accuracyMeters ?? null,
                lastUpdated: state.last_updated,
                selected: state.entity_id === selected,
            }
        })
        .sort((a, b) => {
            if (a.selected !== b.selected) return a.selected ? -1 : 1
            if (Boolean(a.position) !== Boolean(b.position)) return a.position ? -1 : 1
            if (a.domain !== b.domain) return domainRank(a.domain) - domainRank(b.domain)
            return a.entityId.localeCompare(b.entityId)
        })
}

export async function validateHomeAssistantLocationEntity(entityId: string) {
    const cleanEntityId = cleanEntityIdInput(entityId)
    const state = await homeAssistantGetState(cleanEntityId)
    const location = extractHomeAssistantLocation(state)
        ?? await resolveHomeAssistantZoneLocation(state.state).catch(() => null)
    if (!location) {
        throw new Error(`Home Assistant entity ${cleanEntityId} does not expose latitude/longitude.`)
    }
    return { state, location }
}

export function saveHomeAssistantLocationSource(input: {
    entityId: string
    label?: string | null
}): SmartMonitorLiveLocationSource {
    const current = getConfig()
    const source: SmartMonitorLiveLocationSource = {
        provider: 'home-assistant',
        entityId: cleanEntityIdInput(input.entityId),
        confirmedAt: Date.now(),
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    }

    updateConfig({
        smartMonitor: {
            ...(current.smartMonitor ?? {}),
            liveLocationSource: source,
        },
    })

    return source
}

export function clearHomeAssistantLocationSource(): void {
    const current = getConfig()
    const smartMonitor = current.smartMonitor
    if (!smartMonitor?.liveLocationSource) return

    const rest = { ...smartMonitor }
    delete rest.liveLocationSource
    updateConfig({
        smartMonitor: Object.keys(rest).length > 0 ? rest : undefined,
    })
}

export function extractHomeAssistantLocation(state: HomeAssistantState | HomeAssistantStateSummary): {
    label: string
    position: MapCoordinate
    accuracyMeters: number | null
} | null {
    const attributes = isRecord(state.attributes) ? state.attributes : {}
    const latitude = coerceNumber(attributes.latitude)
    const longitude = coerceNumber(attributes.longitude)
    if (!isLatitude(latitude) || !isLongitude(longitude)) return null

    const friendlyName = stringAttribute(attributes, 'friendly_name')
    return {
        label: friendlyName || state.entity_id,
        position: [longitude, latitude],
        accuracyMeters: coerceAccuracy(attributes.gps_accuracy ?? attributes.accuracy),
    }
}

function profileFallback(fallbackReason: string | null): CurrentMapLocation {
    const profile = getUserMapLocation()
    const reason = fallbackReason ?? profile.fallbackReason ?? null
    return {
        source: 'profile',
        label: profile.label,
        position: profile.position,
        accuracyMeters: null,
        ...(reason ? { fallbackReason: reason } : {}),
    }
}

async function resolveHomeAssistantZoneLocation(stateValue: string): Promise<{
    label: string
    position: MapCoordinate
    accuracyMeters: number | null
} | null> {
    const zoneEntityId = zoneEntityIdForState(stateValue)
    if (!zoneEntityId) return null
    const zone = await homeAssistantGetState(zoneEntityId)
    return extractHomeAssistantLocation(zone)
}

function zoneEntityIdForState(stateValue: string): string | null {
    const clean = stateValue.trim().toLowerCase()
    if (!clean || clean === 'not_home' || clean === 'unknown' || clean === 'unavailable') return null
    if (!/^[a-z0-9_]+$/.test(clean)) return null
    return `zone.${clean}`
}

function isLocationCandidate(state: HomeAssistantStateSummary): boolean {
    if (LOCATION_DOMAINS.has(state.domain)) return true
    return Boolean(extractHomeAssistantLocation(state))
}

function domainRank(domain: string): number {
    if (domain === 'person') return 0
    if (domain === 'device_tracker') return 1
    if (domain === 'zone') return 2
    return 3
}

function cleanEntityIdInput(entityId: string): string {
    const clean = entityId.trim()
    if (!ENTITY_ID_PATTERN.test(clean)) {
        throw new Error('Home Assistant entity_id must look like domain.name.')
    }
    return clean
}

function coerceNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
    }
    return null
}

function coerceAccuracy(value: unknown): number | null {
    const parsed = coerceNumber(value)
    return parsed !== null && parsed >= 0 ? parsed : null
}

function isLatitude(value: number | null): value is number {
    return value !== null && value >= -90 && value <= 90
}

function isLongitude(value: number | null): value is number {
    return value !== null && value >= -180 && value <= 180
}

function stringAttribute(attributes: Record<string, unknown>, key: string): string | null {
    const value = attributes[key]
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
