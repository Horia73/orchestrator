import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import {
    inventoryOptions,
    inventorySchema,
    numberArrayArg,
    optionalNumberArg,
    recordArg,
    registryKindsArg,
    stringListArg,
} from './home-assistant-args'
import {
    getHomeAssistantIntegrationStatus,
    homeAssistantApiInfo,
    homeAssistantAutomationActivity,
    homeAssistantCallService,
    homeAssistantCameraSnapshot,
    homeAssistantCheckConfig,
    homeAssistantErrorLog,
    homeAssistantGetConfig,
    homeAssistantGetState,
    homeAssistantHistory,
    homeAssistantListAutomations,
    homeAssistantListAutomationConfigs,
    homeAssistantListCalendars,
    homeAssistantListEvents,
    homeAssistantListRegistries,
    homeAssistantListScenes,
    homeAssistantListScripts,
    homeAssistantListServices,
    homeAssistantListStates,
    homeAssistantLogbook,
    homeAssistantNotify,
    homeAssistantPreviewAction,
    homeAssistantReadActionAudit,
    homeAssistantReadAutomationConfig,
    homeAssistantReadCalendar,
    homeAssistantRenderTemplate,
    homeAssistantSearchEntities,
    homeAssistantSetClimate,
    homeAssistantSetCover,
    homeAssistantSetLight,
    homeAssistantWebSocketRead,
    saveHomeAssistantConfig,
} from '@/lib/integrations/home-assistant'
import { recordIntegrationStatuses } from '@/lib/integrations/status-snapshot'
import { booleanArg, clamp, numberArg, stringArg } from './helpers'

export const homeAssistantStatusTool: ToolDef = {
    id: 'HomeAssistantStatus',
    name: 'HomeAssistantStatus',
    description: 'Checks the read-only Home Assistant integration status and reports whether URL/token config works.',
    input_schema: {
        type: 'object',
        properties: {},
    },
    tags: ['read', 'home-assistant', 'setup'],
}

export const homeAssistantConfigureTool: ToolDef = {
    id: 'HomeAssistantConfigure',
    name: 'HomeAssistantConfigure',
    description: [
        'Saves Home Assistant URL and long-lived access token locally, then verifies the connection.',
        'Use this during setup when the user provides HOME_ASSISTANT_URL/HOME_ASSISTANT_TOKEN or pasted .env lines.',
        'Never echo the token back to the user. This does not mutate Home Assistant itself.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            base_url: {
                type: 'string',
                description: 'Home Assistant base URL, for example http://homeassistant.local:8123.',
            },
            token: {
                type: 'string',
                description: 'Home Assistant long-lived access token. Treat as secret.',
            },
            raw_env: {
                type: 'string',
                description: 'Optional pasted env lines containing HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN.',
            },
        },
    },
    tags: ['read', 'home-assistant', 'setup'],
}

export const homeAssistantApiInfoTool: ToolDef = {
    id: 'HomeAssistantApiInfo',
    name: 'HomeAssistantApiInfo',
    description: 'Reads GET /api/ from Home Assistant to confirm the API is running. Read-only.',
    input_schema: { type: 'object', properties: {} },
    tags: ['read', 'home-assistant'],
}

export const homeAssistantGetConfigTool: ToolDef = {
    id: 'HomeAssistantGetConfig',
    name: 'HomeAssistantGetConfig',
    description: 'Reads Home Assistant core configuration from GET /api/config. Read-only.',
    input_schema: { type: 'object', properties: {} },
    tags: ['read', 'home-assistant'],
}

export const homeAssistantListStatesTool: ToolDef = {
    id: 'HomeAssistantListStates',
    name: 'HomeAssistantListStates',
    description: 'Lists Home Assistant entity states with optional domain/query filters. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            domain: {
                type: 'string',
                description: 'Optional entity domain such as light, sensor, automation, script, scene, climate.',
            },
            query: {
                type: 'string',
                description: 'Optional case-insensitive search over entity_id, friendly_name, and state.',
            },
            include_attributes: {
                type: 'boolean',
                description: 'Include full attributes. Defaults to false to keep output compact.',
            },
            max_results: {
                type: 'integer',
                description: 'Maximum states to return. Defaults to 500 and is capped at 5000.',
            },
        },
    },
    tags: ['read', 'home-assistant', 'entities'],
}

export const homeAssistantGetStateTool: ToolDef = {
    id: 'HomeAssistantGetState',
    name: 'HomeAssistantGetState',
    description: 'Reads the current full state for one Home Assistant entity_id. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            entity_id: {
                type: 'string',
                description: 'Home Assistant entity_id, for example sensor.living_room_temperature.',
            },
        },
        required: ['entity_id'],
    },
    tags: ['read', 'home-assistant', 'entities'],
}

export const homeAssistantSearchEntitiesTool: ToolDef = {
    id: 'HomeAssistantSearchEntities',
    name: 'HomeAssistantSearchEntities',
    description: 'Searches Home Assistant entities by entity_id, friendly_name, or current state. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Search text.',
            },
            domain: {
                type: 'string',
                description: 'Optional domain filter.',
            },
            include_attributes: {
                type: 'boolean',
                description: 'Include full attributes. Defaults to false.',
            },
            max_results: {
                type: 'integer',
                description: 'Maximum entities to return. Defaults to 100 and is capped at 5000.',
            },
        },
        required: ['query'],
    },
    tags: ['read', 'home-assistant', 'entities'],
}

export const homeAssistantListServicesTool: ToolDef = {
    id: 'HomeAssistantListServices',
    name: 'HomeAssistantListServices',
    description:
        'Lists Home Assistant service domains and service schemas from GET /api/services. Read-only; does not call services.',
    input_schema: {
        type: 'object',
        properties: {
            domain: {
                type: 'string',
                description: 'Optional service domain filter, for example light or automation.',
            },
        },
    },
    tags: ['read', 'home-assistant', 'services'],
}

export const homeAssistantListEventsTool: ToolDef = {
    id: 'HomeAssistantListEvents',
    name: 'HomeAssistantListEvents',
    description: 'Lists Home Assistant event types from GET /api/events. Read-only.',
    input_schema: { type: 'object', properties: {} },
    tags: ['read', 'home-assistant', 'events'],
}

export const homeAssistantHistoryTool: ToolDef = {
    id: 'HomeAssistantHistory',
    name: 'HomeAssistantHistory',
    description: 'Reads Home Assistant history for one or more entity_ids. Defaults to the last 24 hours. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            entity_ids: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Entity IDs to read history for. Required to avoid accidentally fetching the full database.',
            },
            start_time: {
                type: 'string',
                description: 'Optional ISO start time. Defaults to 24 hours ago.',
            },
            end_time: {
                type: 'string',
                description: 'Optional ISO end time.',
            },
            minimal_response: {
                type: 'boolean',
                description: 'Pass minimal_response to Home Assistant.',
            },
            no_attributes: {
                type: 'boolean',
                description: 'Pass no_attributes to Home Assistant.',
            },
            significant_changes_only: {
                type: 'boolean',
                description: 'Pass significant_changes_only to Home Assistant.',
            },
            max_state_changes: {
                type: 'integer',
                description: 'Maximum state changes per entity series. Defaults to 300 and is capped at 2000.',
            },
        },
        required: ['entity_ids'],
    },
    tags: ['read', 'home-assistant', 'history'],
}

export const homeAssistantLogbookTool: ToolDef = {
    id: 'HomeAssistantLogbook',
    name: 'HomeAssistantLogbook',
    description:
        'Reads Home Assistant logbook entries, optionally for one entity. Defaults to the last 24 hours. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            entity_id: {
                type: 'string',
                description: 'Optional entity_id filter.',
            },
            start_time: {
                type: 'string',
                description: 'Optional ISO start time. Defaults to 24 hours ago.',
            },
            end_time: {
                type: 'string',
                description: 'Optional ISO end time.',
            },
            max_results: {
                type: 'integer',
                description: 'Maximum logbook entries to return. Defaults to 200 and is capped at 2000.',
            },
        },
    },
    tags: ['read', 'home-assistant', 'logbook'],
}

export const homeAssistantErrorLogTool: ToolDef = {
    id: 'HomeAssistantErrorLog',
    name: 'HomeAssistantErrorLog',
    description:
        'Reads the Home Assistant error log tail from documented GET /api/error_log. Read-only. If this Home Assistant instance does not expose that endpoint, returns available=false with a clear message instead of failing the whole integration.',
    input_schema: {
        type: 'object',
        properties: {
            max_chars: {
                type: 'integer',
                description: 'Maximum trailing characters to return. Defaults to 60000 and is capped at 200000.',
            },
        },
    },
    tags: ['read', 'home-assistant', 'logs'],
}

export const homeAssistantListCalendarsTool: ToolDef = {
    id: 'HomeAssistantListCalendars',
    name: 'HomeAssistantListCalendars',
    description: 'Lists Home Assistant calendar entities from GET /api/calendars. Read-only.',
    input_schema: { type: 'object', properties: {} },
    tags: ['read', 'home-assistant', 'calendars'],
}

export const homeAssistantReadCalendarTool: ToolDef = {
    id: 'HomeAssistantReadCalendar',
    name: 'HomeAssistantReadCalendar',
    description: 'Reads Home Assistant calendar events for a calendar entity and time range. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            calendar_entity_id: {
                type: 'string',
                description: 'Calendar entity_id, for example calendar.family.',
            },
            start: {
                type: 'string',
                description: 'ISO start timestamp.',
            },
            end: {
                type: 'string',
                description: 'ISO end timestamp.',
            },
        },
        required: ['calendar_entity_id', 'start', 'end'],
    },
    tags: ['read', 'home-assistant', 'calendars'],
}

export const homeAssistantCameraSnapshotTool: ToolDef = {
    id: 'HomeAssistantCameraSnapshot',
    name: 'HomeAssistantCameraSnapshot',
    description: 'Reads a Home Assistant camera snapshot from /api/camera_proxy/{camera_entity_id}. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            camera_entity_id: {
                type: 'string',
                description: 'Camera entity_id, for example camera.front_door.',
            },
            max_bytes: {
                type: 'integer',
                description: 'Maximum bytes to include as a data URL. Defaults/caps at 5MB.',
            },
        },
        required: ['camera_entity_id'],
    },
    tags: ['read', 'home-assistant', 'camera'],
}

export const homeAssistantRenderTemplateTool: ToolDef = {
    id: 'HomeAssistantRenderTemplate',
    name: 'HomeAssistantRenderTemplate',
    description: 'Renders a Home Assistant template through POST /api/template. Read-only; it does not call services.',
    input_schema: {
        type: 'object',
        properties: {
            template: {
                type: 'string',
                description: 'Home Assistant template text to render.',
            },
        },
        required: ['template'],
    },
    tags: ['read', 'home-assistant', 'templates'],
}

export const homeAssistantCheckConfigTool: ToolDef = {
    id: 'HomeAssistantCheckConfig',
    name: 'HomeAssistantCheckConfig',
    description:
        'Runs Home Assistant config validation through POST /api/config/core/check_config. Read-only validation.',
    input_schema: { type: 'object', properties: {} },
    tags: ['read', 'home-assistant', 'config'],
}

export const homeAssistantWebSocketReadTool: ToolDef = {
    id: 'HomeAssistantWebSocketRead',
    name: 'HomeAssistantWebSocketRead',
    description:
        'Runs a whitelisted read-only Home Assistant WebSocket command: get_config, get_states, get_services, get_panels, or ping.',
    input_schema: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                enum: ['get_config', 'get_states', 'get_services', 'get_panels', 'ping'],
                description: 'Read-only WebSocket command.',
            },
        },
        required: ['command'],
    },
    tags: ['read', 'home-assistant', 'websocket'],
}

export const homeAssistantListRegistriesTool: ToolDef = {
    id: 'HomeAssistantListRegistries',
    name: 'HomeAssistantListRegistries',
    description:
        'Best-effort read of Home Assistant area, device, entity, floor, and label registries over WebSocket. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            kinds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional subset: areas, devices, entities, floors, labels.',
            },
        },
    },
    tags: ['read', 'home-assistant', 'registries'],
}

export const homeAssistantListAutomationsTool: ToolDef = {
    id: 'HomeAssistantListAutomations',
    name: 'HomeAssistantListAutomations',
    description: 'Lists automation.* entities, attributes, and automation service schema. Read-only.',
    input_schema: inventorySchema(),
    tags: ['read', 'home-assistant', 'automations'],
}

export const homeAssistantListScriptsTool: ToolDef = {
    id: 'HomeAssistantListScripts',
    name: 'HomeAssistantListScripts',
    description: 'Lists script.* entities, attributes, and script service schema. Read-only.',
    input_schema: inventorySchema(),
    tags: ['read', 'home-assistant', 'scripts'],
}

export const homeAssistantListScenesTool: ToolDef = {
    id: 'HomeAssistantListScenes',
    name: 'HomeAssistantListScenes',
    description: 'Lists scene.* entities, attributes, and scene service schema. Read-only.',
    input_schema: inventorySchema(),
    tags: ['read', 'home-assistant', 'scenes'],
}

export const homeAssistantAutomationActivityTool: ToolDef = {
    id: 'HomeAssistantAutomationActivity',
    name: 'HomeAssistantAutomationActivity',
    description:
        'Reads logbook activity for automation entities. Defaults to listed automations and last 24 hours. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            entity_ids: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Optional automation entity IDs. If omitted, reads the first automations returned by HomeAssistantListAutomations.',
            },
            start_time: {
                type: 'string',
                description: 'Optional ISO start time. Defaults to 24 hours ago.',
            },
            end_time: {
                type: 'string',
                description: 'Optional ISO end time.',
            },
            max_entities: {
                type: 'integer',
                description: 'Maximum automation entities to inspect. Defaults to 10 and is capped at 25.',
            },
            max_logbook_entries_per_entity: {
                type: 'integer',
                description: 'Maximum logbook entries per automation. Defaults to 25 and is capped at 200.',
            },
        },
    },
    tags: ['read', 'home-assistant', 'automations', 'logbook'],
}

export const homeAssistantReadAutomationConfigTool: ToolDef = {
    id: 'HomeAssistantReadAutomationConfig',
    name: 'HomeAssistantReadAutomationConfig',
    description:
        'Reads trigger/condition/action components for one Home Assistant automation when it is exposed by the automation config API. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            entity_id: {
                type: 'string',
                description: 'Automation entity_id, for example automation.living.',
            },
        },
        required: ['entity_id'],
    },
    tags: ['read', 'home-assistant', 'automations'],
}

export const homeAssistantListAutomationConfigsTool: ToolDef = {
    id: 'HomeAssistantListAutomationConfigs',
    name: 'HomeAssistantListAutomationConfigs',
    description:
        'Reads trigger/condition/action components for multiple automation entities when available. Falls back cleanly for YAML/unexposed automations. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            entity_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional automation entity IDs. If omitted, reads automation configs up to max_results.',
            },
            include_raw: {
                type: 'boolean',
                description: 'Return raw config objects instead of normalized component summaries.',
            },
            max_results: {
                type: 'integer',
                description: 'Maximum automations to inspect. Defaults to 100 and is capped at 500.',
            },
        },
    },
    tags: ['read', 'home-assistant', 'automations'],
}

export const homeAssistantPreviewActionTool: ToolDef = {
    id: 'HomeAssistantPreviewAction',
    name: 'HomeAssistantPreviewAction',
    description: 'Validates and previews a Home Assistant service call against action policy without executing it.',
    input_schema: {
        type: 'object',
        properties: {
            domain: {
                type: 'string',
                description: 'Service domain, for example light, cover, climate, notify, switch.',
            },
            service: {
                type: 'string',
                description: 'Service name, for example turn_on, set_temperature, mobile_app_horias_iphone.',
            },
            target: {
                type: 'object',
                description: 'Optional Home Assistant target object, usually { "entity_id": "..." }.',
            },
            data: { type: 'object', description: 'Optional service data payload.' },
            confirmed: {
                type: 'boolean',
                description: 'Whether the user has explicitly confirmed this exact non-direct service call.',
            },
            reason: {
                type: 'string',
                description: 'Short user-facing reason for the action.',
            },
        },
        required: ['domain', 'service'],
    },
    tags: ['read', 'home-assistant', 'actions'],
}

export const homeAssistantCallServiceTool: ToolDef = {
    id: 'HomeAssistantCallService',
    name: 'HomeAssistantCallService',
    description: [
        'Executes a Home Assistant service call in action mode.',
        'Direct domains light, cover, climate, and notify may be called when the user clearly asked.',
        'Every other service domain requires explicit user confirmation of the exact service, target, and data; set confirmed=true only after that confirmation.',
        'The tool validates service availability and records before/after audit state.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            domain: {
                type: 'string',
                description: 'Service domain, for example light, switch, lock, automation, script.',
            },
            service: {
                type: 'string',
                description: 'Service name within the domain.',
            },
            target: {
                type: 'object',
                description: 'Optional Home Assistant target object.',
            },
            data: { type: 'object', description: 'Optional service data payload.' },
            confirmed: {
                type: 'boolean',
                description: 'Required true for non-direct domains after explicit user confirmation.',
            },
            reason: {
                type: 'string',
                description: 'Short reason to store in the local action audit log.',
            },
            return_response: {
                type: 'boolean',
                description: 'Request a Home Assistant response when the service supports it.',
            },
        },
        required: ['domain', 'service'],
    },
    tags: ['write', 'home-assistant', 'actions'],
}

export const homeAssistantSetLightTool: ToolDef = {
    id: 'HomeAssistantSetLight',
    name: 'HomeAssistantSetLight',
    description:
        'Direct action-mode light control with brightness, color, color temperature, effect, transition, turn_on, turn_off, and toggle.',
    input_schema: {
        type: 'object',
        properties: {
            entity_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'One or more light entity IDs.',
            },
            action: {
                type: 'string',
                enum: ['turn_on', 'turn_off', 'toggle'],
                description: 'Light action. Defaults to turn_on.',
            },
            brightness: { type: 'integer', description: 'Brightness 0-255.' },
            brightness_pct: {
                type: 'number',
                description: 'Brightness percent 0-100.',
            },
            rgb_color: {
                type: 'array',
                items: { type: 'integer' },
                description: 'RGB color array [r,g,b], each 0-255.',
            },
            hs_color: {
                type: 'array',
                items: { type: 'number' },
                description: 'HS color array [hue 0-360, saturation 0-100].',
            },
            color_temp_kelvin: {
                type: 'integer',
                description: 'Color temperature in Kelvin.',
            },
            effect: { type: 'string', description: 'Optional light effect.' },
            transition: { type: 'number', description: 'Transition seconds.' },
        },
        required: ['entity_ids'],
    },
    tags: ['write', 'home-assistant', 'actions', 'lights'],
}

export const homeAssistantSetCoverTool: ToolDef = {
    id: 'HomeAssistantSetCover',
    name: 'HomeAssistantSetCover',
    description: 'Direct action-mode cover control: open, close, stop, toggle, set position, or set tilt position.',
    input_schema: {
        type: 'object',
        properties: {
            entity_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'One or more cover entity IDs.',
            },
            action: {
                type: 'string',
                enum: ['open', 'close', 'stop', 'toggle', 'set_position', 'set_tilt_position'],
                description: 'Cover action.',
            },
            position: {
                type: 'integer',
                description: 'Cover position 0-100 for set_position.',
            },
            tilt_position: {
                type: 'integer',
                description: 'Tilt position 0-100 for set_tilt_position.',
            },
        },
        required: ['entity_ids', 'action'],
    },
    tags: ['write', 'home-assistant', 'actions', 'covers'],
}

export const homeAssistantSetClimateTool: ToolDef = {
    id: 'HomeAssistantSetClimate',
    name: 'HomeAssistantSetClimate',
    description:
        'Direct action-mode climate control for HVAC mode, temperature, preset, fan, humidity, and swing mode.',
    input_schema: {
        type: 'object',
        properties: {
            entity_ids: {
                type: 'array',
                items: { type: 'string' },
                description: 'One or more climate entity IDs.',
            },
            hvac_mode: {
                type: 'string',
                description: 'HVAC mode such as off, heat, cool, heat_cool, fan_only.',
            },
            temperature: { type: 'number', description: 'Target temperature.' },
            target_temp_low: {
                type: 'number',
                description: 'Low target temperature.',
            },
            target_temp_high: {
                type: 'number',
                description: 'High target temperature.',
            },
            preset_mode: { type: 'string', description: 'Preset mode.' },
            fan_mode: { type: 'string', description: 'Fan mode.' },
            humidity: { type: 'integer', description: 'Target humidity 0-100.' },
            swing_mode: { type: 'string', description: 'Swing mode.' },
        },
        required: ['entity_ids'],
    },
    tags: ['write', 'home-assistant', 'actions', 'climate'],
}

export const homeAssistantNotifyTool: ToolDef = {
    id: 'HomeAssistantNotify',
    name: 'HomeAssistantNotify',
    description:
        'Direct action-mode Home Assistant notify call. Use a notify service such as mobile_app_horias_iphone and provide a message.',
    input_schema: {
        type: 'object',
        properties: {
            service: {
                type: 'string',
                description: 'Notify service name, for example mobile_app_horias_iphone.',
            },
            message: { type: 'string', description: 'Notification message.' },
            title: { type: 'string', description: 'Optional notification title.' },
            data: { type: 'object', description: 'Optional notify data payload.' },
        },
        required: ['service', 'message'],
    },
    tags: ['write', 'home-assistant', 'actions', 'notify'],
}

export const homeAssistantReadActionAuditTool: ToolDef = {
    id: 'HomeAssistantReadActionAudit',
    name: 'HomeAssistantReadActionAudit',
    description: 'Reads recent local Home Assistant action audit entries. Read-only.',
    input_schema: {
        type: 'object',
        properties: {
            max_results: {
                type: 'integer',
                description: 'Maximum audit entries to return. Defaults to 50 and is capped at 200.',
            },
        },
    },
    tags: ['read', 'home-assistant', 'actions', 'audit'],
}

export const homeAssistantTools: ToolDef[] = [
    homeAssistantStatusTool,
    homeAssistantConfigureTool,
    homeAssistantApiInfoTool,
    homeAssistantGetConfigTool,
    homeAssistantListStatesTool,
    homeAssistantGetStateTool,
    homeAssistantSearchEntitiesTool,
    homeAssistantListServicesTool,
    homeAssistantListEventsTool,
    homeAssistantHistoryTool,
    homeAssistantLogbookTool,
    homeAssistantErrorLogTool,
    homeAssistantListCalendarsTool,
    homeAssistantReadCalendarTool,
    homeAssistantCameraSnapshotTool,
    homeAssistantRenderTemplateTool,
    homeAssistantCheckConfigTool,
    homeAssistantWebSocketReadTool,
    homeAssistantListRegistriesTool,
    homeAssistantListAutomationsTool,
    homeAssistantListScriptsTool,
    homeAssistantListScenesTool,
    homeAssistantAutomationActivityTool,
    homeAssistantReadAutomationConfigTool,
    homeAssistantListAutomationConfigsTool,
    homeAssistantPreviewActionTool,
    homeAssistantCallServiceTool,
    homeAssistantSetLightTool,
    homeAssistantSetCoverTool,
    homeAssistantSetClimateTool,
    homeAssistantNotifyTool,
    homeAssistantReadActionAuditTool,
]

export async function executeHomeAssistantStatus(): Promise<ToolResult> {
    const data = await getHomeAssistantIntegrationStatus(true)
    recordIntegrationStatuses({ homeAssistant: data })
    return { success: true, data }
}

export async function executeHomeAssistantConfigure(args: Record<string, unknown>): Promise<ToolResult> {
    const data = await saveHomeAssistantConfig({
        baseUrl: stringArg(args, ['base_url', 'baseUrl', 'url']),
        token: stringArg(args, ['token', 'access_token', 'accessToken']),
        rawEnv: stringArg(args, ['raw_env', 'rawEnv']),
    })
    recordIntegrationStatuses({ homeAssistant: data })
    return {
        success: true,
        data: {
            ...data,
            instruction: data.connected
                ? 'Home Assistant is configured and verified. Do not reveal the stored token. Next, call MapsListLocationSources, infer which person.* or device_tracker.* represents the current user, and call MapsSetLocationSource for a high-confidence match; ask the user only if candidates are ambiguous.'
                : 'Config was saved, but Home Assistant did not verify. Ask for the corrected URL/token or local network access.',
        },
    }
}

export async function executeHomeAssistantApiInfo(): Promise<ToolResult> {
    return { success: true, data: await homeAssistantApiInfo() }
}

export async function executeHomeAssistantGetConfig(): Promise<ToolResult> {
    return { success: true, data: await homeAssistantGetConfig() }
}

export async function executeHomeAssistantListStates(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await homeAssistantListStates({
            domain: stringArg(args, ['domain']),
            query: stringArg(args, ['query', 'q']),
            includeAttributes: booleanArg(args, ['include_attributes', 'includeAttributes'], false),
            maxResults: clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 500)), 1, 5000),
        }),
    }
}

export async function executeHomeAssistantGetState(args: Record<string, unknown>): Promise<ToolResult> {
    const entityId = stringArg(args, ['entity_id', 'entityId'])
    if (!entityId) return { success: false, error: 'Missing required parameter: entity_id' }
    return { success: true, data: await homeAssistantGetState(entityId) }
}

export async function executeHomeAssistantSearchEntities(args: Record<string, unknown>): Promise<ToolResult> {
    const query = stringArg(args, ['query', 'q'])
    if (!query) return { success: false, error: 'Missing required parameter: query' }
    return {
        success: true,
        data: await homeAssistantSearchEntities({
            query,
            domain: stringArg(args, ['domain']),
            includeAttributes: booleanArg(args, ['include_attributes', 'includeAttributes'], false),
            maxResults: clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 100)), 1, 5000),
        }),
    }
}

export async function executeHomeAssistantListServices(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await homeAssistantListServices(stringArg(args, ['domain'])),
    }
}

export async function executeHomeAssistantListEvents(): Promise<ToolResult> {
    return { success: true, data: await homeAssistantListEvents() }
}

export async function executeHomeAssistantHistory(args: Record<string, unknown>): Promise<ToolResult> {
    const entityIds = stringListArg(args, ['entity_ids', 'entityIds', 'entity_id', 'entityId'])
    if (entityIds.length === 0) return { success: false, error: 'Missing required parameter: entity_ids' }
    return {
        success: true,
        data: await homeAssistantHistory({
            entityIds,
            startTime: stringArg(args, ['start_time', 'startTime']),
            endTime: stringArg(args, ['end_time', 'endTime']),
            minimalResponse: booleanArg(args, ['minimal_response', 'minimalResponse'], false),
            noAttributes: booleanArg(args, ['no_attributes', 'noAttributes'], false),
            significantChangesOnly: booleanArg(args, ['significant_changes_only', 'significantChangesOnly'], false),
            maxStateChanges: clamp(Math.floor(numberArg(args, ['max_state_changes', 'maxStateChanges'], 300)), 1, 2000),
        }),
    }
}

export async function executeHomeAssistantLogbook(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await homeAssistantLogbook({
            entityId: stringArg(args, ['entity_id', 'entityId']),
            startTime: stringArg(args, ['start_time', 'startTime']),
            endTime: stringArg(args, ['end_time', 'endTime']),
            maxResults: clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 200)), 1, 2000),
        }),
    }
}

export async function executeHomeAssistantErrorLog(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await homeAssistantErrorLog(
            clamp(Math.floor(numberArg(args, ['max_chars', 'maxChars'], 60_000)), 1_000, 200_000)
        ),
    }
}

export async function executeHomeAssistantListCalendars(): Promise<ToolResult> {
    return { success: true, data: await homeAssistantListCalendars() }
}

export async function executeHomeAssistantReadCalendar(args: Record<string, unknown>): Promise<ToolResult> {
    const calendarEntityId = stringArg(args, ['calendar_entity_id', 'calendarEntityId'])
    const start = stringArg(args, ['start'])
    const end = stringArg(args, ['end'])
    if (!calendarEntityId)
        return {
            success: false,
            error: 'Missing required parameter: calendar_entity_id',
        }
    if (!start || !end)
        return {
            success: false,
            error: 'Missing required parameters: start and end',
        }
    return {
        success: true,
        data: await homeAssistantReadCalendar({ calendarEntityId, start, end }),
    }
}

export async function executeHomeAssistantCameraSnapshot(args: Record<string, unknown>): Promise<ToolResult> {
    const cameraEntityId = stringArg(args, ['camera_entity_id', 'cameraEntityId'])
    if (!cameraEntityId)
        return {
            success: false,
            error: 'Missing required parameter: camera_entity_id',
        }
    return {
        success: true,
        data: await homeAssistantCameraSnapshot({
            cameraEntityId,
            maxBytes: clamp(
                Math.floor(numberArg(args, ['max_bytes', 'maxBytes'], 5 * 1024 * 1024)),
                1_000,
                5 * 1024 * 1024
            ),
        }),
    }
}

export async function executeHomeAssistantRenderTemplate(args: Record<string, unknown>): Promise<ToolResult> {
    const template = stringArg(args, ['template'])
    if (!template) return { success: false, error: 'Missing required parameter: template' }
    return { success: true, data: await homeAssistantRenderTemplate(template) }
}

export async function executeHomeAssistantCheckConfig(): Promise<ToolResult> {
    return { success: true, data: await homeAssistantCheckConfig() }
}

export async function executeHomeAssistantWebSocketRead(args: Record<string, unknown>): Promise<ToolResult> {
    const command = stringArg(args, ['command'])
    if (!command) return { success: false, error: 'Missing required parameter: command' }
    if (!['get_config', 'get_states', 'get_services', 'get_panels', 'ping'].includes(command)) {
        return {
            success: false,
            error: `Unsupported read-only Home Assistant WebSocket command: ${command}`,
        }
    }
    return {
        success: true,
        data: await homeAssistantWebSocketRead(
            command as 'get_config' | 'get_states' | 'get_services' | 'get_panels' | 'ping'
        ),
    }
}

export async function executeHomeAssistantListRegistries(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await homeAssistantListRegistries(registryKindsArg(args)),
    }
}

export async function executeHomeAssistantListAutomations(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await homeAssistantListAutomations(inventoryOptions(args)),
    }
}

export async function executeHomeAssistantListScripts(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await homeAssistantListScripts(inventoryOptions(args)),
    }
}

export async function executeHomeAssistantListScenes(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await homeAssistantListScenes(inventoryOptions(args)),
    }
}

export async function executeHomeAssistantAutomationActivity(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await homeAssistantAutomationActivity({
            entityIds: stringListArg(args, ['entity_ids', 'entityIds', 'entity_id', 'entityId']),
            startTime: stringArg(args, ['start_time', 'startTime']),
            endTime: stringArg(args, ['end_time', 'endTime']),
            maxEntities: clamp(Math.floor(numberArg(args, ['max_entities', 'maxEntities'], 10)), 1, 25),
            maxLogbookEntriesPerEntity: clamp(
                Math.floor(numberArg(args, ['max_logbook_entries_per_entity', 'maxLogbookEntriesPerEntity'], 25)),
                1,
                200
            ),
        }),
    }
}

export async function executeHomeAssistantReadAutomationConfig(args: Record<string, unknown>): Promise<ToolResult> {
    const entityId = stringArg(args, ['entity_id', 'entityId'])
    if (!entityId) return { success: false, error: 'Missing required parameter: entity_id' }
    return {
        success: true,
        data: await homeAssistantReadAutomationConfig(entityId),
    }
}

export async function executeHomeAssistantListAutomationConfigs(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await homeAssistantListAutomationConfigs({
            entityIds: stringListArg(args, ['entity_ids', 'entityIds', 'entity_id', 'entityId']),
            includeRaw: booleanArg(args, ['include_raw', 'includeRaw'], false),
            maxResults: clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 100)), 1, 500),
        }),
    }
}

export async function executeHomeAssistantPreviewAction(args: Record<string, unknown>): Promise<ToolResult> {
    const domain = stringArg(args, ['domain'])
    const service = stringArg(args, ['service'])
    if (!domain || !service)
        return {
            success: false,
            error: 'Missing required parameters: domain and service',
        }
    return {
        success: true,
        data: await homeAssistantPreviewAction({
            domain,
            service,
            target: recordArg(args, ['target']),
            data: recordArg(args, ['data']),
            confirmed: booleanArg(args, ['confirmed'], false),
            reason: stringArg(args, ['reason']),
        }),
    }
}

export async function executeHomeAssistantCallService(args: Record<string, unknown>): Promise<ToolResult> {
    const domain = stringArg(args, ['domain'])
    const service = stringArg(args, ['service'])
    if (!domain || !service)
        return {
            success: false,
            error: 'Missing required parameters: domain and service',
        }
    return {
        success: true,
        data: await homeAssistantCallService({
            domain,
            service,
            target: recordArg(args, ['target']),
            data: recordArg(args, ['data']),
            confirmed: booleanArg(args, ['confirmed'], false),
            reason: stringArg(args, ['reason']),
            returnResponse: booleanArg(args, ['return_response', 'returnResponse'], false),
        }),
    }
}

export async function executeHomeAssistantSetLight(args: Record<string, unknown>): Promise<ToolResult> {
    const entityIds = stringListArg(args, ['entity_ids', 'entityIds', 'entity_id', 'entityId'])
    if (entityIds.length === 0) return { success: false, error: 'Missing required parameter: entity_ids' }
    const action = stringArg(args, ['action']) || undefined
    if (action && !['turn_on', 'turn_off', 'toggle'].includes(action))
        return { success: false, error: `Unsupported light action: ${action}` }
    return {
        success: true,
        data: await homeAssistantSetLight({
            entityIds,
            action: action as 'turn_on' | 'turn_off' | 'toggle' | undefined,
            brightness: optionalNumberArg(args, ['brightness']),
            brightnessPct: optionalNumberArg(args, ['brightness_pct', 'brightnessPct']),
            rgbColor: numberArrayArg(args, ['rgb_color', 'rgbColor']),
            hsColor: numberArrayArg(args, ['hs_color', 'hsColor']),
            colorTempKelvin: optionalNumberArg(args, ['color_temp_kelvin', 'colorTempKelvin']),
            effect: stringArg(args, ['effect']) || undefined,
            transition: optionalNumberArg(args, ['transition']),
        }),
    }
}

export async function executeHomeAssistantSetCover(args: Record<string, unknown>): Promise<ToolResult> {
    const entityIds = stringListArg(args, ['entity_ids', 'entityIds', 'entity_id', 'entityId'])
    const action = stringArg(args, ['action'])
    if (entityIds.length === 0) return { success: false, error: 'Missing required parameter: entity_ids' }
    if (!['open', 'close', 'stop', 'toggle', 'set_position', 'set_tilt_position'].includes(action)) {
        return { success: false, error: 'Missing or unsupported cover action.' }
    }
    return {
        success: true,
        data: await homeAssistantSetCover({
            entityIds,
            action: action as 'open' | 'close' | 'stop' | 'toggle' | 'set_position' | 'set_tilt_position',
            position: optionalNumberArg(args, ['position']),
            tiltPosition: optionalNumberArg(args, ['tilt_position', 'tiltPosition']),
        }),
    }
}

export async function executeHomeAssistantSetClimate(args: Record<string, unknown>): Promise<ToolResult> {
    const entityIds = stringListArg(args, ['entity_ids', 'entityIds', 'entity_id', 'entityId'])
    if (entityIds.length === 0) return { success: false, error: 'Missing required parameter: entity_ids' }
    return {
        success: true,
        data: await homeAssistantSetClimate({
            entityIds,
            hvacMode: stringArg(args, ['hvac_mode', 'hvacMode']) || undefined,
            temperature: optionalNumberArg(args, ['temperature']),
            targetTempLow: optionalNumberArg(args, ['target_temp_low', 'targetTempLow']),
            targetTempHigh: optionalNumberArg(args, ['target_temp_high', 'targetTempHigh']),
            presetMode: stringArg(args, ['preset_mode', 'presetMode']) || undefined,
            fanMode: stringArg(args, ['fan_mode', 'fanMode']) || undefined,
            humidity: optionalNumberArg(args, ['humidity']),
            swingMode: stringArg(args, ['swing_mode', 'swingMode']) || undefined,
        }),
    }
}

export async function executeHomeAssistantNotify(args: Record<string, unknown>): Promise<ToolResult> {
    const service = stringArg(args, ['service'])
    const message = stringArg(args, ['message'])
    if (!service || !message)
        return {
            success: false,
            error: 'Missing required parameters: service and message',
        }
    return {
        success: true,
        data: await homeAssistantNotify({
            service,
            message,
            title: stringArg(args, ['title']) || undefined,
            data: recordArg(args, ['data']),
        }),
    }
}

export async function executeHomeAssistantReadActionAudit(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await homeAssistantReadActionAudit(
            clamp(Math.floor(numberArg(args, ['max_results', 'maxResults'], 50)), 1, 200)
        ),
    }
}
