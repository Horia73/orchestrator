import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import WebSocket from 'ws'

import { PRIVATE_STATE_DIR, WORKSPACE_ENV_PATH, getEnvValue } from '@/lib/config'

const URL_ENV_KEYS = ['HOME_ASSISTANT_URL', 'HA_URL', 'HASS_URL']
const TOKEN_ENV_KEYS = ['HOME_ASSISTANT_TOKEN', 'HOME_ASSISTANT_ACCESS_TOKEN', 'HA_TOKEN', 'HASS_TOKEN']
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_STATUS_TIMEOUT_MS = 8_000
const DEFAULT_MAX_RESULTS = 500
const MAX_RESULTS_CAP = 5_000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const ACTION_POLICY_PATH = path.join(PRIVATE_STATE_DIR, 'home-assistant-action-policy.json')
const ACTION_AUDIT_PATH = path.join(PRIVATE_STATE_DIR, 'home-assistant-action-audit.jsonl')
const DIRECT_ACTION_DOMAINS = ['light', 'cover', 'climate', 'notify'] as const

const READ_ONLY_CAPABILITIES = [
    'REST API status, config, events, services, states',
    'REST history, logbook, error log, calendars, camera snapshots',
    'REST template rendering and config validation',
    'WebSocket get_config, get_states, get_services, get_panels, ping',
    'Best-effort WebSocket registries: areas, devices, entities, floors, labels',
    'Automation, script, and scene inventory from entity states and activity logs',
    'Action mode with direct light/cover/climate/notify calls and confirmation-gated service calls for every other domain',
] as const

interface EnvLookup {
    value: string | null
    key: string | null
}

interface HomeAssistantConfig {
    baseUrl: string | null
    token: string | null
    missing: string[]
    envKeys: {
        baseUrl: string | null
        token: string | null
    }
}

export interface HomeAssistantIntegrationStatus {
    id: 'homeAssistant'
    name: string
    description: string
    configured: boolean
    connected: boolean
    baseUrl: string | null
    version: string | null
    locationName: string | null
    timeZone: string | null
    unitSystem: string | null
    entityCount: number | null
    serviceDomainCount: number | null
    missingConfig: string[]
    needsReconnect: boolean
    lastCheckedAt: number | null
    error?: string
    capabilities: string[]
    actionMode: HomeAssistantActionPolicy
}

export interface HomeAssistantConfigInput {
    baseUrl?: string
    token?: string
    rawEnv?: string
}

export interface HomeAssistantState {
    entity_id: string
    state: string
    attributes?: Record<string, unknown>
    last_changed?: string
    last_updated?: string
    context?: unknown
}

export interface HomeAssistantStateSummary {
    entity_id: string
    domain: string
    state: string
    name: string | null
    last_changed: string | null
    last_updated: string | null
    attributes?: Record<string, unknown>
}

export interface HomeAssistantListStatesOptions {
    domain?: string
    query?: string
    includeAttributes?: boolean
    maxResults?: number
}

export interface HomeAssistantHistoryOptions {
    entityIds: string[]
    startTime?: string
    endTime?: string
    minimalResponse?: boolean
    noAttributes?: boolean
    significantChangesOnly?: boolean
    maxStateChanges?: number
}

export interface HomeAssistantLogbookOptions {
    startTime?: string
    endTime?: string
    entityId?: string
    maxResults?: number
}

export interface HomeAssistantCalendarOptions {
    calendarEntityId: string
    start: string
    end: string
}

export interface HomeAssistantCameraSnapshotOptions {
    cameraEntityId: string
    maxBytes?: number
}

export interface HomeAssistantDomainInventoryOptions {
    includeAttributes?: boolean
    maxResults?: number
}

export interface HomeAssistantAutomationActivityOptions {
    entityIds?: string[]
    startTime?: string
    endTime?: string
    maxEntities?: number
    maxLogbookEntriesPerEntity?: number
}

export interface HomeAssistantActionPolicy {
    version: 1
    enabled: boolean
    directDomains: string[]
    confirmOtherDomains: boolean
    updatedAt: number
}

export interface HomeAssistantActionPolicyInput {
    enabled?: boolean
    directDomains?: string[]
    confirmOtherDomains?: boolean
}

export interface HomeAssistantServiceCallInput {
    domain: string
    service: string
    target?: Record<string, unknown>
    data?: Record<string, unknown>
    confirmed?: boolean
    reason?: string
    returnResponse?: boolean
}

export interface HomeAssistantServiceCallResult {
    auditId: string
    service: string
    risk: 'direct' | 'confirmation_required'
    confirmed: boolean
    changedEntityIds: string[]
    before: HomeAssistantStateSummary[]
    after: HomeAssistantStateSummary[]
    response: unknown
}

export interface HomeAssistantSetLightOptions {
    entityIds: string[]
    action?: 'turn_on' | 'turn_off' | 'toggle'
    brightness?: number
    brightnessPct?: number
    rgbColor?: number[]
    hsColor?: number[]
    colorTempKelvin?: number
    effect?: string
    transition?: number
}

export interface HomeAssistantSetCoverOptions {
    entityIds: string[]
    action: 'open' | 'close' | 'stop' | 'toggle' | 'set_position' | 'set_tilt_position'
    position?: number
    tiltPosition?: number
}

export interface HomeAssistantSetClimateOptions {
    entityIds: string[]
    hvacMode?: string
    temperature?: number
    targetTempLow?: number
    targetTempHigh?: number
    presetMode?: string
    fanMode?: string
    humidity?: number
    swingMode?: string
}

export interface HomeAssistantNotifyOptions {
    service: string
    message: string
    title?: string
    data?: Record<string, unknown>
}

export interface HomeAssistantAutomationConfigReadOptions {
    entityIds?: string[]
    includeRaw?: boolean
    maxResults?: number
}

type RegistryKind = 'areas' | 'devices' | 'entities' | 'floors' | 'labels'
type SafeWebSocketCommand = 'get_config' | 'get_states' | 'get_services' | 'get_panels' | 'ping'

interface WebSocketMessage {
    id?: number
    type?: string
    success?: boolean
    result?: unknown
    error?: {
        code?: string
        message?: string
    }
    message?: string
}

interface NormalizedServiceCall {
    domain: string
    service: string
    target: Record<string, unknown>
    data: Record<string, unknown>
    confirmed: boolean
    reason: string
    returnResponse: boolean
    policy: HomeAssistantActionPolicy
    risk: 'direct' | 'confirmation_required'
    serviceSchema: unknown
}

export async function getHomeAssistantIntegrationStatus(validate = true): Promise<HomeAssistantIntegrationStatus> {
    const config = getHomeAssistantConfig()
    const configured = config.missing.length === 0
    const base: HomeAssistantIntegrationStatus = {
        id: 'homeAssistant',
        name: 'Home Assistant',
        description: 'Read-only smart-home integration for Home Assistant REST and WebSocket APIs.',
        configured,
        connected: false,
        baseUrl: config.baseUrl,
        version: null,
        locationName: null,
        timeZone: null,
        unitSystem: null,
        entityCount: null,
        serviceDomainCount: null,
        missingConfig: config.missing,
        needsReconnect: configured,
        lastCheckedAt: validate && configured ? Date.now() : null,
        capabilities: [...READ_ONLY_CAPABILITIES],
        actionMode: getHomeAssistantActionPolicy(),
    }

    if (!configured || !validate) return base

    const [apiStatus, haConfig, states, services] = await Promise.allSettled([
        homeAssistantRestJson<Record<string, unknown>>('/api/', undefined, DEFAULT_STATUS_TIMEOUT_MS),
        homeAssistantRestJson<Record<string, unknown>>('/api/config', undefined, DEFAULT_STATUS_TIMEOUT_MS),
        homeAssistantRestJson<HomeAssistantState[]>('/api/states', undefined, DEFAULT_STATUS_TIMEOUT_MS),
        homeAssistantRestJson<Array<{ domain?: string }>>('/api/services', undefined, DEFAULT_STATUS_TIMEOUT_MS),
    ])

    if (haConfig.status === 'rejected') {
        return {
            ...base,
            error: haConfig.reason instanceof Error ? haConfig.reason.message : 'Could not read Home Assistant config.',
        }
    }

    const configBody = haConfig.value
    const unitSystem = isRecord(configBody.unit_system) ? stringField(configBody.unit_system, 'length') : null

    return {
        ...base,
        connected: true,
        version: stringField(configBody, 'version') || null,
        locationName: stringField(configBody, 'location_name') || null,
        timeZone: stringField(configBody, 'time_zone') || null,
        unitSystem,
        entityCount: states.status === 'fulfilled' && Array.isArray(states.value) ? states.value.length : null,
        serviceDomainCount: services.status === 'fulfilled' && Array.isArray(services.value) ? services.value.length : null,
        needsReconnect: false,
        error: apiStatus.status === 'rejected'
            ? (apiStatus.reason instanceof Error ? apiStatus.reason.message : 'Home Assistant API status check failed.')
            : undefined,
    }
}

export async function saveHomeAssistantConfig(input: HomeAssistantConfigInput): Promise<HomeAssistantIntegrationStatus> {
    const current = getHomeAssistantConfig()
    const pasted = parseEnvAssignments(input.rawEnv ?? '')
    const baseUrl = cleanConfigValue(input.baseUrl)
        || firstDefinedEnvValue(pasted, URL_ENV_KEYS)
        || current.baseUrl
        || ''
    const token = cleanConfigValue(input.token)
        || firstDefinedEnvValue(pasted, TOKEN_ENV_KEYS)
        || current.token
        || ''

    if (!baseUrl) throw new Error(`Missing Home Assistant URL: ${formatEnvChoice(URL_ENV_KEYS)}`)
    if (!token) throw new Error(`Missing Home Assistant token: ${formatEnvChoice(TOKEN_ENV_KEYS)}`)

    const normalizedUrl = normalizeBaseUrl(baseUrl)
    patchWorkspaceEnv({
        HOME_ASSISTANT_URL: normalizedUrl,
        HOME_ASSISTANT_TOKEN: token,
    })
    process.env.HOME_ASSISTANT_URL = normalizedUrl
    process.env.HOME_ASSISTANT_TOKEN = token

    return getHomeAssistantIntegrationStatus(true)
}

export async function disconnectHomeAssistant(): Promise<HomeAssistantIntegrationStatus> {
    patchWorkspaceEnv({})
    for (const key of [...URL_ENV_KEYS, ...TOKEN_ENV_KEYS]) delete process.env[key]
    return getHomeAssistantIntegrationStatus(false)
}

export function getHomeAssistantActionPolicy(): HomeAssistantActionPolicy {
    const defaultPolicy: HomeAssistantActionPolicy = {
        version: 1,
        enabled: false,
        directDomains: [...DIRECT_ACTION_DOMAINS],
        confirmOtherDomains: true,
        updatedAt: 0,
    }

    try {
        if (!fs.existsSync(ACTION_POLICY_PATH)) return defaultPolicy
        const parsed = JSON.parse(fs.readFileSync(ACTION_POLICY_PATH, 'utf-8')) as Partial<HomeAssistantActionPolicy>
        return normalizeActionPolicy(parsed, defaultPolicy)
    } catch {
        return defaultPolicy
    }
}

export function saveHomeAssistantActionPolicy(input: HomeAssistantActionPolicyInput): HomeAssistantActionPolicy {
    const current = getHomeAssistantActionPolicy()
    const next = normalizeActionPolicy({
        ...current,
        ...input,
        updatedAt: Date.now(),
    }, current)

    fs.mkdirSync(path.dirname(ACTION_POLICY_PATH), { recursive: true })
    fs.writeFileSync(ACTION_POLICY_PATH, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
    try {
        fs.chmodSync(ACTION_POLICY_PATH, 0o600)
    } catch {
        // Best effort.
    }
    return next
}

export async function homeAssistantApiInfo(): Promise<Record<string, unknown>> {
    return homeAssistantRestJson<Record<string, unknown>>('/api/')
}

export async function homeAssistantGetConfig(): Promise<Record<string, unknown>> {
    return homeAssistantRestJson<Record<string, unknown>>('/api/config')
}

export async function homeAssistantListEvents(): Promise<unknown[]> {
    return homeAssistantRestJson<unknown[]>('/api/events')
}

export async function homeAssistantListServices(domain?: string): Promise<unknown[]> {
    const services = await homeAssistantRestJson<Array<Record<string, unknown>>>('/api/services')
    const cleanDomain = cleanDomainFilter(domain)
    if (!cleanDomain) return services
    return services.filter(item => stringField(item, 'domain') === cleanDomain)
}

export async function homeAssistantListStates(options: HomeAssistantListStatesOptions = {}) {
    const states = await homeAssistantRestJson<HomeAssistantState[]>('/api/states')
    const filtered = filterStates(states, options.domain, options.query)
    const maxResults = clampInt(options.maxResults ?? DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CAP)
    const limited = filtered.slice(0, maxResults)
    return {
        count: filtered.length,
        returned: limited.length,
        truncated: filtered.length > limited.length,
        states: limited.map(state => summarizeState(state, options.includeAttributes === true)),
    }
}

export async function homeAssistantGetState(entityId: string): Promise<HomeAssistantState> {
    const cleanEntityId = cleanEntity(entityId)
    if (!cleanEntityId) throw new Error('Home Assistant entity_id is required.')
    return homeAssistantRestJson<HomeAssistantState>(`/api/states/${encodeURIComponent(cleanEntityId)}`)
}

export async function homeAssistantSearchEntities(options: HomeAssistantListStatesOptions = {}) {
    return homeAssistantListStates({
        ...options,
        maxResults: options.maxResults ?? 100,
    })
}

export async function homeAssistantHistory(options: HomeAssistantHistoryOptions) {
    const entityIds = uniqueCleanEntities(options.entityIds)
    if (entityIds.length === 0) {
        throw new Error('At least one Home Assistant entity_id is required for history reads.')
    }

    const startTime = normalizeTimestamp(options.startTime) ?? defaultStartTime()
    const params = new URLSearchParams()
    params.set('filter_entity_id', entityIds.join(','))
    if (options.endTime) params.set('end_time', normalizeTimestamp(options.endTime) ?? options.endTime)
    if (options.minimalResponse !== undefined) params.set('minimal_response', String(options.minimalResponse))
    if (options.noAttributes !== undefined) params.set('no_attributes', String(options.noAttributes))
    if (options.significantChangesOnly !== undefined) {
        params.set('significant_changes_only', String(options.significantChangesOnly))
    }

    const result = await homeAssistantRestJson<HomeAssistantState[][]>(
        `/api/history/period/${encodeURIComponent(startTime)}?${params.toString()}`
    )
    const maxStateChanges = clampInt(options.maxStateChanges ?? 300, 1, 2_000)
    return {
        entityIds,
        startTime,
        endTime: options.endTime ?? null,
        series: result.map(series => {
            const limited = series.slice(-maxStateChanges)
            return {
                count: series.length,
                returned: limited.length,
                truncated: series.length > limited.length,
                states: limited,
            }
        }),
    }
}

export async function homeAssistantLogbook(options: HomeAssistantLogbookOptions = {}) {
    const startTime = normalizeTimestamp(options.startTime) ?? defaultStartTime()
    const params = new URLSearchParams()
    if (options.endTime) params.set('end_time', normalizeTimestamp(options.endTime) ?? options.endTime)
    const entityId = cleanEntity(options.entityId ?? '')
    if (entityId) params.set('entity', entityId)
    const suffix = params.toString() ? `?${params.toString()}` : ''
    const result = await homeAssistantRestJson<unknown[]>(`/api/logbook/${encodeURIComponent(startTime)}${suffix}`)
    const maxResults = clampInt(options.maxResults ?? 200, 1, 2_000)
    const limited = result.slice(0, maxResults)
    return {
        startTime,
        endTime: options.endTime ?? null,
        entityId: entityId || null,
        count: result.length,
        returned: limited.length,
        truncated: result.length > limited.length,
        entries: limited,
    }
}

export async function homeAssistantErrorLog(maxChars = 60_000) {
    const text = await homeAssistantRestText('/api/error_log')
    const max = clampInt(maxChars, 1_000, 200_000)
    return {
        length: text.length,
        truncated: text.length > max,
        text: text.length > max ? text.slice(-max) : text,
    }
}

export async function homeAssistantListCalendars(): Promise<unknown[]> {
    return homeAssistantRestJson<unknown[]>('/api/calendars')
}

export async function homeAssistantReadCalendar(options: HomeAssistantCalendarOptions): Promise<unknown> {
    const calendarEntityId = cleanEntity(options.calendarEntityId)
    if (!calendarEntityId) throw new Error('calendar_entity_id is required.')
    if (!options.start || !options.end) throw new Error('Calendar reads require start and end timestamps.')

    const params = new URLSearchParams({
        start: normalizeTimestamp(options.start) ?? options.start,
        end: normalizeTimestamp(options.end) ?? options.end,
    })
    return homeAssistantRestJson<unknown>(`/api/calendars/${encodeURIComponent(calendarEntityId)}?${params.toString()}`)
}

export async function homeAssistantCameraSnapshot(options: HomeAssistantCameraSnapshotOptions) {
    const cameraEntityId = cleanEntity(options.cameraEntityId)
    if (!cameraEntityId) throw new Error('camera_entity_id is required.')
    const maxBytes = clampInt(options.maxBytes ?? MAX_IMAGE_BYTES, 1_000, MAX_IMAGE_BYTES)
    const response = await homeAssistantFetch(
        `/api/camera_proxy/${encodeURIComponent(cameraEntityId)}?time=${Date.now()}`,
        { headers: { Accept: 'image/*' } },
        DEFAULT_TIMEOUT_MS
    )
    const contentType = response.headers.get('content-type') || 'application/octet-stream'
    const bytes = Buffer.from(await response.arrayBuffer())
    const includeBody = bytes.byteLength <= maxBytes
    return {
        cameraEntityId,
        contentType,
        size: bytes.byteLength,
        included: includeBody,
        truncated: !includeBody,
        dataUrl: includeBody ? `data:${contentType};base64,${bytes.toString('base64')}` : null,
    }
}

export async function homeAssistantRenderTemplate(template: string) {
    const cleanTemplate = template.trim()
    if (!cleanTemplate) throw new Error('Template is required.')
    const rendered = await homeAssistantRestText('/api/template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: cleanTemplate }),
    })
    return { rendered }
}

export async function homeAssistantCheckConfig(): Promise<unknown> {
    return homeAssistantRestJson<unknown>('/api/config/core/check_config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    }, 60_000)
}

export async function homeAssistantPreviewAction(input: HomeAssistantServiceCallInput) {
    const normalized = await normalizeServiceCall(input)
    const entityIds = extractEntityIds(normalized.target, normalized.data)
    const before = await readStatesForAudit(entityIds)
    return {
        service: `${normalized.domain}.${normalized.service}`,
        policy: normalized.policy,
        risk: normalized.risk,
        confirmationRequired: normalized.risk === 'confirmation_required' && !normalized.confirmed,
        confirmed: normalized.confirmed,
        target: normalized.target,
        data: normalized.data,
        entityIds,
        before,
        serviceSchema: normalized.serviceSchema,
    }
}

export async function homeAssistantCallService(input: HomeAssistantServiceCallInput): Promise<HomeAssistantServiceCallResult> {
    const normalized = await normalizeServiceCall(input)
    if (normalized.risk === 'confirmation_required' && !normalized.confirmed) {
        throw new Error([
            `Confirmation required before calling ${normalized.domain}.${normalized.service}.`,
            'Ask the user to confirm the exact Home Assistant service, target, and data, then retry with confirmed=true.',
        ].join(' '))
    }

    const entityIds = extractEntityIds(normalized.target, normalized.data)
    const before = await readStatesForAudit(entityIds)
    const body = buildServiceCallBody(normalized.target, normalized.data)
    const query = normalized.returnResponse ? '?return_response' : ''
    const response = await homeAssistantRestJson<unknown>(
        `/api/services/${encodeURIComponent(normalized.domain)}/${encodeURIComponent(normalized.service)}${query}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        },
        DEFAULT_TIMEOUT_MS
    )

    await sleep(600)
    const changedEntityIds = uniqueCleanEntities([
        ...entityIds,
        ...extractStateEntityIds(response),
    ])
    const after = await readStatesForAudit(changedEntityIds)
    const auditId = await appendActionAudit({
        service: `${normalized.domain}.${normalized.service}`,
        risk: normalized.risk,
        confirmed: normalized.confirmed,
        reason: normalized.reason || null,
        target: normalized.target,
        data: normalized.data,
        changedEntityIds,
        before,
        after,
        responseSummary: summarizeServiceResponse(response),
    })

    return {
        auditId,
        service: `${normalized.domain}.${normalized.service}`,
        risk: normalized.risk,
        confirmed: normalized.confirmed,
        changedEntityIds,
        before,
        after,
        response,
    }
}

export async function homeAssistantSetLight(options: HomeAssistantSetLightOptions): Promise<HomeAssistantServiceCallResult> {
    const entityIds = uniqueCleanEntities(options.entityIds)
    if (entityIds.length === 0) throw new Error('At least one light entity_id is required.')
    const service = options.action ?? 'turn_on'
    if (!['turn_on', 'turn_off', 'toggle'].includes(service)) throw new Error(`Unsupported light action: ${service}`)

    const data: Record<string, unknown> = {}
    if (options.brightness !== undefined) data.brightness = clampInt(options.brightness, 0, 255)
    if (options.brightnessPct !== undefined) data.brightness_pct = clampNumber(options.brightnessPct, 0, 100)
    if (options.rgbColor?.length === 3) data.rgb_color = options.rgbColor.map(value => clampInt(value, 0, 255))
    if (options.hsColor?.length === 2) data.hs_color = [clampNumber(options.hsColor[0], 0, 360), clampNumber(options.hsColor[1], 0, 100)]
    if (options.colorTempKelvin !== undefined) data.color_temp_kelvin = clampInt(options.colorTempKelvin, 1_500, 10_000)
    if (options.effect) data.effect = options.effect
    if (options.transition !== undefined) data.transition = clampNumber(options.transition, 0, 3600)

    return homeAssistantCallService({
        domain: 'light',
        service,
        target: { entity_id: entityIds },
        data,
        reason: 'direct light action',
    })
}

export async function homeAssistantSetCover(options: HomeAssistantSetCoverOptions): Promise<HomeAssistantServiceCallResult> {
    const entityIds = uniqueCleanEntities(options.entityIds)
    if (entityIds.length === 0) throw new Error('At least one cover entity_id is required.')
    const serviceByAction: Record<HomeAssistantSetCoverOptions['action'], string> = {
        open: 'open_cover',
        close: 'close_cover',
        stop: 'stop_cover',
        toggle: 'toggle',
        set_position: 'set_cover_position',
        set_tilt_position: 'set_cover_tilt_position',
    }
    const service = serviceByAction[options.action]
    if (!service) throw new Error(`Unsupported cover action: ${options.action}`)
    const data: Record<string, unknown> = {}
    if (options.action === 'set_position') data.position = clampInt(options.position ?? 0, 0, 100)
    if (options.action === 'set_tilt_position') data.tilt_position = clampInt(options.tiltPosition ?? 0, 0, 100)

    return homeAssistantCallService({
        domain: 'cover',
        service,
        target: { entity_id: entityIds },
        data,
        reason: 'direct cover action',
    })
}

export async function homeAssistantSetClimate(options: HomeAssistantSetClimateOptions): Promise<HomeAssistantServiceCallResult[]> {
    const entityIds = uniqueCleanEntities(options.entityIds)
    if (entityIds.length === 0) throw new Error('At least one climate entity_id is required.')
    const target = { entity_id: entityIds }
    const results: HomeAssistantServiceCallResult[] = []

    if (options.temperature !== undefined || options.targetTempLow !== undefined || options.targetTempHigh !== undefined) {
        const data: Record<string, unknown> = {}
        if (options.temperature !== undefined) data.temperature = options.temperature
        if (options.targetTempLow !== undefined) data.target_temp_low = options.targetTempLow
        if (options.targetTempHigh !== undefined) data.target_temp_high = options.targetTempHigh
        if (options.hvacMode) data.hvac_mode = options.hvacMode
        results.push(await homeAssistantCallService({ domain: 'climate', service: 'set_temperature', target, data, reason: 'direct climate temperature action' }))
    } else if (options.hvacMode) {
        results.push(await homeAssistantCallService({ domain: 'climate', service: 'set_hvac_mode', target, data: { hvac_mode: options.hvacMode }, reason: 'direct climate mode action' }))
    }

    if (options.presetMode) {
        results.push(await homeAssistantCallService({ domain: 'climate', service: 'set_preset_mode', target, data: { preset_mode: options.presetMode }, reason: 'direct climate preset action' }))
    }
    if (options.fanMode) {
        results.push(await homeAssistantCallService({ domain: 'climate', service: 'set_fan_mode', target, data: { fan_mode: options.fanMode }, reason: 'direct climate fan action' }))
    }
    if (options.humidity !== undefined) {
        results.push(await homeAssistantCallService({ domain: 'climate', service: 'set_humidity', target, data: { humidity: clampInt(options.humidity, 0, 100) }, reason: 'direct climate humidity action' }))
    }
    if (options.swingMode) {
        results.push(await homeAssistantCallService({ domain: 'climate', service: 'set_swing_mode', target, data: { swing_mode: options.swingMode }, reason: 'direct climate swing action' }))
    }

    if (results.length === 0) throw new Error('No climate action was specified.')
    return results
}

export async function homeAssistantNotify(options: HomeAssistantNotifyOptions): Promise<HomeAssistantServiceCallResult> {
    const service = cleanServiceName(options.service)
    if (!service) throw new Error('Notify service is required, for example mobile_app_horias_iphone.')
    const message = options.message.trim()
    if (!message) throw new Error('Notify message is required.')
    return homeAssistantCallService({
        domain: 'notify',
        service,
        data: {
            message,
            ...(options.title ? { title: options.title } : {}),
            ...(options.data ? { data: options.data } : {}),
        },
        reason: 'direct notify action',
    })
}

export async function homeAssistantReadAutomationConfig(entityId: string): Promise<unknown> {
    const state = await homeAssistantGetState(entityId)
    const automationId = isRecord(state.attributes) ? stringField(state.attributes, 'id') : ''
    if (!automationId) throw new Error(`Automation ${entityId} does not expose an internal config id.`)
    return homeAssistantRestJson<unknown>(`/api/config/automation/config/${encodeURIComponent(automationId)}`)
}

export async function homeAssistantListAutomationConfigs(options: HomeAssistantAutomationConfigReadOptions = {}) {
    const requested = uniqueCleanEntities(options.entityIds ?? [])
    const maxResults = clampInt(options.maxResults ?? 100, 1, 500)
    const inventory = await homeAssistantListStates({
        domain: 'automation',
        includeAttributes: true,
        maxResults: 1_000,
    })
    const candidates = requested.length > 0
        ? inventory.states.filter(state => requested.includes(state.entity_id))
        : inventory.states
    const limited = candidates.slice(0, maxResults)
    const configs = []

    for (const state of limited) {
        const automationId = isRecord(state.attributes) ? stringField(state.attributes, 'id') : ''
        if (!automationId) {
            configs.push({
                entity_id: state.entity_id,
                ok: false,
                error: 'Automation does not expose an internal config id.',
                state,
            })
            continue
        }

        try {
            const config = await homeAssistantRestJson<Record<string, unknown>>(`/api/config/automation/config/${encodeURIComponent(automationId)}`)
            configs.push({
                entity_id: state.entity_id,
                ok: true,
                config: options.includeRaw === true ? config : summarizeAutomationConfig(config),
            })
        } catch (err) {
            configs.push({
                entity_id: state.entity_id,
                ok: false,
                error: err instanceof Error ? err.message : 'Could not read automation config.',
                state,
            })
        }
    }

    return {
        count: candidates.length,
        returned: configs.length,
        truncated: candidates.length > limited.length,
        configs,
    }
}

export async function homeAssistantReadActionAudit(maxResults = 50) {
    const max = clampInt(maxResults, 1, 200)
    if (!fs.existsSync(ACTION_AUDIT_PATH)) return { entries: [] }
    const lines = fs.readFileSync(ACTION_AUDIT_PATH, 'utf-8').split(/\r?\n/).filter(Boolean)
    return {
        entries: lines.slice(-max).map(line => {
            try {
                return JSON.parse(line) as unknown
            } catch {
                return { parseError: true, raw: line.slice(0, 1000) }
            }
        }),
    }
}

export async function homeAssistantWebSocketRead(command: SafeWebSocketCommand): Promise<unknown> {
    if (!['get_config', 'get_states', 'get_services', 'get_panels', 'ping'].includes(command)) {
        throw new Error(`Unsupported read-only Home Assistant WebSocket command: ${command}`)
    }
    return homeAssistantWebSocketCommand(command)
}

export async function homeAssistantListRegistries(kinds?: RegistryKind[]) {
    const wanted = new Set((kinds?.length ? kinds : ['areas', 'devices', 'entities', 'floors', 'labels']) as RegistryKind[])
    const commands: Array<{ key: RegistryKind; type: string }> = [
        { key: 'areas', type: 'config/area_registry/list' },
        { key: 'devices', type: 'config/device_registry/list' },
        { key: 'entities', type: 'config/entity_registry/list' },
        { key: 'floors', type: 'config/floor_registry/list' },
        { key: 'labels', type: 'config/label_registry/list' },
    ]
    const out: Partial<Record<RegistryKind, { ok: boolean; data?: unknown; error?: string }>> = {}

    for (const command of commands) {
        if (!wanted.has(command.key)) continue
        try {
            out[command.key] = { ok: true, data: await homeAssistantWebSocketCommand(command.type) }
        } catch (err) {
            out[command.key] = {
                ok: false,
                error: err instanceof Error ? err.message : `Could not read ${command.key} registry.`,
            }
        }
    }

    return out
}

export async function homeAssistantListAutomations(options: HomeAssistantDomainInventoryOptions = {}) {
    return homeAssistantDomainInventory('automation', options)
}

export async function homeAssistantListScripts(options: HomeAssistantDomainInventoryOptions = {}) {
    return homeAssistantDomainInventory('script', options)
}

export async function homeAssistantListScenes(options: HomeAssistantDomainInventoryOptions = {}) {
    return homeAssistantDomainInventory('scene', options)
}

export async function homeAssistantAutomationActivity(options: HomeAssistantAutomationActivityOptions = {}) {
    const requestedEntityIds = uniqueCleanEntities(options.entityIds ?? [])
    const maxEntities = clampInt(options.maxEntities ?? 10, 1, 25)
    const entityIds = requestedEntityIds.length > 0
        ? requestedEntityIds.slice(0, maxEntities)
        : (await homeAssistantListAutomations({ maxResults: maxEntities })).entities.map(item => item.entity_id)
    const maxLogbookEntriesPerEntity = clampInt(options.maxLogbookEntriesPerEntity ?? 25, 1, 200)

    const entries = []
    for (const entityId of entityIds) {
        try {
            entries.push({
                entityId,
                ok: true,
                logbook: await homeAssistantLogbook({
                    entityId,
                    startTime: options.startTime,
                    endTime: options.endTime,
                    maxResults: maxLogbookEntriesPerEntity,
                }),
            })
        } catch (err) {
            entries.push({
                entityId,
                ok: false,
                error: err instanceof Error ? err.message : 'Could not read automation activity.',
            })
        }
    }

    return {
        entityIds,
        entries,
        truncated: requestedEntityIds.length > entityIds.length,
    }
}

async function homeAssistantDomainInventory(domain: string, options: HomeAssistantDomainInventoryOptions) {
    const states = await homeAssistantListStates({
        domain,
        includeAttributes: options.includeAttributes ?? true,
        maxResults: options.maxResults ?? DEFAULT_MAX_RESULTS,
    })
    const { states: entities, ...summary } = states
    const services = await homeAssistantListServices(domain).catch(err => ({
        error: err instanceof Error ? err.message : 'Could not read services.',
    }))
    return {
        domain,
        ...summary,
        services,
        entities,
    }
}

async function homeAssistantRestJson<T>(pathAndQuery: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const response = await homeAssistantFetch(pathAndQuery, init, timeoutMs)
    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!text) return undefined as T
    try {
        return JSON.parse(text) as T
    } catch {
        throw new Error(`Home Assistant API returned non-JSON response for ${pathAndQuery}.`)
    }
}

async function homeAssistantRestText(pathAndQuery: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const response = await homeAssistantFetch(pathAndQuery, init, timeoutMs)
    return response.text()
}

async function homeAssistantFetch(pathAndQuery: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
    const config = requireHomeAssistantConfig()
    const url = new URL(pathAndQuery, ensureTrailingSlash(config.baseUrl))
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${config.token}`)
    if (!headers.has('Accept')) headers.set('Accept', 'application/json')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetch(url, {
            ...init,
            headers,
            signal: init.signal ?? controller.signal,
        })
        if (!response.ok) {
            throw new Error(`Home Assistant API failed (${response.status}): ${await responseErrorText(response)}`)
        }
        return response
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            throw new Error(`Home Assistant API timed out after ${timeoutMs}ms.`)
        }
        throw err
    } finally {
        clearTimeout(timer)
    }
}

async function homeAssistantWebSocketCommand(type: string, payload: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const config = requireHomeAssistantConfig()
    const endpoint = new URL('/api/websocket', config.baseUrl)
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'

    return new Promise((resolve, reject) => {
        let done = false
        let authenticated = false
        const id = 1
        const ws = new WebSocket(endpoint.toString(), { handshakeTimeout: timeoutMs })
        const timer = setTimeout(() => fail(new Error(`Home Assistant WebSocket timed out after ${timeoutMs}ms.`)), timeoutMs)

        const finish = (value: unknown) => {
            if (done) return
            done = true
            clearTimeout(timer)
            try {
                ws.close()
            } catch {
                // Best effort.
            }
            resolve(value)
        }

        const fail = (err: Error) => {
            if (done) return
            done = true
            clearTimeout(timer)
            try {
                ws.close()
            } catch {
                // Best effort.
            }
            reject(err)
        }

        ws.on('message', raw => {
            let message: WebSocketMessage
            try {
                message = JSON.parse(raw.toString()) as WebSocketMessage
            } catch {
                fail(new Error('Home Assistant WebSocket returned invalid JSON.'))
                return
            }

            if (message.type === 'auth_required') {
                ws.send(JSON.stringify({ type: 'auth', access_token: config.token }))
                return
            }

            if (message.type === 'auth_invalid') {
                fail(new Error(message.message || 'Home Assistant WebSocket authentication failed.'))
                return
            }

            if (message.type === 'auth_ok') {
                authenticated = true
                ws.send(JSON.stringify({ id, type, ...payload }))
                return
            }

            if (!authenticated || message.id !== id) return

            if (message.type === 'pong') {
                finish({ type: 'pong' })
                return
            }

            if (message.type === 'result') {
                if (message.success === false) {
                    fail(new Error(message.error?.message || message.error?.code || `Home Assistant WebSocket command failed: ${type}`))
                    return
                }
                finish(message.result)
            }
        })

        ws.on('error', err => fail(err instanceof Error ? err : new Error('Home Assistant WebSocket error.')))
        ws.on('close', () => {
            if (!done) fail(new Error(`Home Assistant WebSocket closed before ${type} completed.`))
        })
    })
}

async function normalizeServiceCall(input: HomeAssistantServiceCallInput): Promise<NormalizedServiceCall> {
    const policy = getHomeAssistantActionPolicy()
    if (!policy.enabled) {
        throw new Error('Home Assistant action mode is disabled. Enable it from Settings > Auth before calling services.')
    }

    const domain = cleanDomainFilter(input.domain)
    const service = cleanServiceName(input.service)
    if (!domain) throw new Error('Home Assistant service domain is required.')
    if (!service) throw new Error('Home Assistant service name is required.')

    const services = await homeAssistantRestJson<Array<Record<string, unknown>>>('/api/services')
    const domainEntry = services.find(item => stringField(item, 'domain') === domain)
    const domainServices = isRecord(domainEntry?.services) ? domainEntry.services : null
    const serviceSchema = domainServices?.[service]
    if (!domainEntry || !domainServices || serviceSchema === undefined) {
        throw new Error(`Home Assistant service is not available: ${domain}.${service}`)
    }

    const direct = policy.directDomains.includes(domain)
    if (!direct && !policy.confirmOtherDomains) {
        throw new Error(`Home Assistant service ${domain}.${service} is outside direct action domains and confirmOtherDomains is disabled.`)
    }

    return {
        domain,
        service,
        target: sanitizeRecord(input.target),
        data: sanitizeRecord(input.data),
        confirmed: input.confirmed === true,
        reason: cleanReason(input.reason),
        returnResponse: input.returnResponse === true,
        policy,
        risk: direct ? 'direct' : 'confirmation_required',
        serviceSchema,
    }
}

function normalizeActionPolicy(input: Partial<HomeAssistantActionPolicy>, fallback: HomeAssistantActionPolicy): HomeAssistantActionPolicy {
    const directDomains = Array.isArray(input.directDomains)
        ? [...new Set(input.directDomains.map(cleanDomainFilter).filter(Boolean))]
        : fallback.directDomains
    return {
        version: 1,
        enabled: typeof input.enabled === 'boolean' ? input.enabled : fallback.enabled,
        directDomains: directDomains.length > 0 ? directDomains : [...DIRECT_ACTION_DOMAINS],
        confirmOtherDomains: typeof input.confirmOtherDomains === 'boolean' ? input.confirmOtherDomains : fallback.confirmOtherDomains,
        updatedAt: typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) ? input.updatedAt : fallback.updatedAt,
    }
}

function buildServiceCallBody(target: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
    const body: Record<string, unknown> = { ...data }
    const targetCopy = { ...target }
    if (targetCopy.entity_id !== undefined && body.entity_id === undefined) {
        body.entity_id = targetCopy.entity_id
        delete targetCopy.entity_id
    }
    if (Object.keys(targetCopy).length > 0) body.target = targetCopy
    return body
}

function extractEntityIds(target: Record<string, unknown>, data: Record<string, unknown>): string[] {
    return uniqueCleanEntities([
        ...entityIdsFromValue(target.entity_id),
        ...entityIdsFromValue(data.entity_id),
    ])
}

function entityIdsFromValue(value: unknown): string[] {
    if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean)
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    return []
}

function extractStateEntityIds(value: unknown): string[] {
    const out: string[] = []
    const visit = (item: unknown) => {
        if (Array.isArray(item)) {
            for (const child of item) visit(child)
            return
        }
        if (!isRecord(item)) return
        const entityId = item.entity_id
        if (typeof entityId === 'string') out.push(entityId)
        for (const child of Object.values(item)) {
            if (Array.isArray(child) || isRecord(child)) visit(child)
        }
    }
    visit(value)
    return uniqueCleanEntities(out)
}

async function readStatesForAudit(entityIds: string[]): Promise<HomeAssistantStateSummary[]> {
    const states: HomeAssistantStateSummary[] = []
    for (const entityId of uniqueCleanEntities(entityIds)) {
        try {
            states.push(summarizeState(await homeAssistantGetState(entityId), true))
        } catch (err) {
            states.push({
                entity_id: entityId,
                domain: getEntityDomain(entityId),
                state: 'unavailable',
                name: null,
                last_changed: null,
                last_updated: null,
                attributes: {
                    audit_error: err instanceof Error ? err.message : 'Could not read state.',
                },
            })
        }
    }
    return states
}

async function appendActionAudit(input: Record<string, unknown>): Promise<string> {
    const auditId = randomUUID()
    const record = {
        id: auditId,
        timestamp: new Date().toISOString(),
        ...safeJsonForAudit(input),
    }
    fs.mkdirSync(path.dirname(ACTION_AUDIT_PATH), { recursive: true })
    fs.appendFileSync(ACTION_AUDIT_PATH, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', mode: 0o600 })
    try {
        fs.chmodSync(ACTION_AUDIT_PATH, 0o600)
    } catch {
        // Best effort.
    }
    return auditId
}

function safeJsonForAudit(value: unknown): Record<string, unknown> {
    const json = JSON.stringify(value)
    if (json.length <= 80_000 && isRecord(value)) return value
    return {
        truncated: true,
        jsonPrefix: json.slice(0, 60_000),
        originalChars: json.length,
    }
}

function summarizeServiceResponse(value: unknown): unknown {
    if (Array.isArray(value)) {
        return {
            type: 'array',
            length: value.length,
            entityIds: extractStateEntityIds(value).slice(0, 200),
        }
    }
    return value
}

function summarizeAutomationConfig(config: Record<string, unknown>) {
    const triggers = arrayField(config, 'triggers', 'trigger')
    const conditions = arrayField(config, 'conditions', 'condition')
    const actions = arrayField(config, 'actions', 'action')
    return {
        id: stringField(config, 'id') || null,
        alias: stringField(config, 'alias') || null,
        description: stringField(config, 'description') || '',
        mode: stringField(config, 'mode') || null,
        triggerCount: triggers.length,
        conditionCount: conditions.length,
        actionCount: actions.length,
        triggers,
        conditions,
        actions,
    }
}

function arrayField(record: Record<string, unknown>, plural: string, singular: string): unknown[] {
    const value = record[plural] ?? record[singular]
    if (Array.isArray(value)) return value
    return value === undefined || value === null ? [] : [value]
}

function sanitizeRecord(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {}
}

function cleanServiceName(value: string | undefined): string {
    return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '')
}

function cleanReason(value: string | undefined): string {
    return (value ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 500)
}

function clampNumber(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min
    return Math.min(max, Math.max(min, value))
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function getHomeAssistantConfig(): HomeAssistantConfig {
    const baseUrlLookup = firstEnv(URL_ENV_KEYS)
    const tokenLookup = firstEnv(TOKEN_ENV_KEYS)
    const missing: string[] = []
    let baseUrl: string | null = null

    if (!baseUrlLookup.value) {
        missing.push(formatEnvChoice(URL_ENV_KEYS))
    } else {
        try {
            baseUrl = normalizeBaseUrl(baseUrlLookup.value)
        } catch (err) {
            missing.push(err instanceof Error ? err.message : 'valid HOME_ASSISTANT_URL')
        }
    }

    if (!tokenLookup.value) missing.push(formatEnvChoice(TOKEN_ENV_KEYS))

    return {
        baseUrl,
        token: tokenLookup.value,
        missing,
        envKeys: {
            baseUrl: baseUrlLookup.key,
            token: tokenLookup.key,
        },
    }
}

function requireHomeAssistantConfig(): { baseUrl: string; token: string } {
    const config = getHomeAssistantConfig()
    if (!config.baseUrl || !config.token || config.missing.length > 0) {
        throw new Error(`Home Assistant is not configured. Missing: ${config.missing.join(', ')}`)
    }
    return { baseUrl: config.baseUrl, token: config.token }
}

function filterStates(states: HomeAssistantState[], domain?: string, query?: string): HomeAssistantState[] {
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

function summarizeState(state: HomeAssistantState, includeAttributes: boolean): HomeAssistantStateSummary {
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

function firstEnv(keys: string[]): EnvLookup {
    for (const key of keys) {
        const value = getEnvValue(key)
        if (value) return { value, key }
    }
    return { value: null, key: null }
}

function firstDefinedEnvValue(values: Record<string, string>, keys: string[]): string {
    for (const key of keys) {
        const value = cleanConfigValue(values[key])
        if (value) return value
    }
    return ''
}

function parseEnvAssignments(raw: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
        const idx = normalized.indexOf('=')
        if (idx <= 0) continue
        const key = normalized.slice(0, idx).trim()
        if (!isAcceptedHomeAssistantEnvKey(key)) continue
        out[key] = stripEnvQuotes(normalized.slice(idx + 1).trim())
    }
    return out
}

function patchWorkspaceEnv(values: Record<string, string>): void {
    fs.mkdirSync(path.dirname(WORKSPACE_ENV_PATH), { recursive: true })
    const existing = fs.existsSync(WORKSPACE_ENV_PATH)
        ? fs.readFileSync(WORKSPACE_ENV_PATH, 'utf-8')
        : ''
    const keysToReplace = new Set([...URL_ENV_KEYS, ...TOKEN_ENV_KEYS])
    const kept = existing
        .split(/\r?\n/)
        .filter(line => {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#')) return true
            const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
            const idx = normalized.indexOf('=')
            if (idx <= 0) return true
            return !keysToReplace.has(normalized.slice(0, idx).trim())
        })

    while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
    const entries = Object.entries(values).filter(([, value]) => value)
    if (entries.length > 0) {
        if (kept.length > 0) kept.push('')
        kept.push('# Home Assistant read-only API integration')
        for (const [key, value] of entries) kept.push(`${key}=${formatEnvValue(value)}`)
    }

    fs.writeFileSync(WORKSPACE_ENV_PATH, `${kept.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 })
    try {
        fs.chmodSync(WORKSPACE_ENV_PATH, 0o600)
    } catch {
        // Best effort; some filesystems ignore chmod.
    }
}

function isAcceptedHomeAssistantEnvKey(key: string): boolean {
    return URL_ENV_KEYS.includes(key) || TOKEN_ENV_KEYS.includes(key)
}

function normalizeBaseUrl(value: string): string {
    const raw = cleanConfigValue(value)
    if (!raw) throw new Error('valid HOME_ASSISTANT_URL')
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        throw new Error('valid HOME_ASSISTANT_URL with http:// or https://')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('valid HOME_ASSISTANT_URL with http:// or https://')
    }
    url.pathname = url.pathname.replace(/\/+$/, '')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
}

function cleanConfigValue(value: string | undefined): string {
    return stripEnvQuotes((value ?? '').replace(/[\r\n]/g, '').trim())
}

function stripEnvQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1)
    }
    return value
}

function formatEnvValue(value: string): string {
    if (value === '') return '""'
    if (/^[A-Za-z0-9_./:@%+=,\-]+$/.test(value)) return value
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function formatEnvChoice(keys: string[]): string {
    return keys.length === 1 ? keys[0] : `${keys[0]} (or ${keys.slice(1).join(', ')})`
}

function ensureTrailingSlash(value: string): string {
    return value.endsWith('/') ? value : `${value}/`
}

function getEntityDomain(entityId: string): string {
    const idx = entityId.indexOf('.')
    return idx > 0 ? entityId.slice(0, idx) : ''
}

function cleanEntity(value: string): string {
    return value.trim().replace(/\s+/g, '')
}

function uniqueCleanEntities(values: string[]): string[] {
    return [...new Set(values.map(cleanEntity).filter(Boolean))]
}

function cleanDomainFilter(value: string | undefined): string {
    return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '')
}

function normalizeTimestamp(value: string | undefined): string | null {
    const trimmed = value?.trim()
    if (!trimmed) return null
    const date = new Date(trimmed)
    return Number.isNaN(date.getTime()) ? trimmed : date.toISOString()
}

function defaultStartTime(): string {
    return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
}

function clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min
    return Math.min(max, Math.max(min, Math.floor(value)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stringField(record: Record<string, unknown>, key: string): string {
    const value = record[key]
    return typeof value === 'string' ? value : ''
}

async function responseErrorText(response: Response): Promise<string> {
    const text = await response.text().catch(() => '')
    if (!text) return response.statusText || 'unknown error'
    try {
        const parsed = JSON.parse(text) as { message?: string; error?: string | { message?: string } }
        if (typeof parsed.message === 'string') return parsed.message
        if (typeof parsed.error === 'string') return parsed.error
        if (isRecord(parsed.error) && typeof parsed.error.message === 'string') return parsed.error.message
    } catch {
        // Use raw text below.
    }
    return text.slice(0, 1000)
}
