import {
    GMAIL_TOOL_IDS,
    GOOGLE_CALENDAR_TOOL_IDS,
    GOOGLE_CONTACTS_TOOL_IDS,
    GOOGLE_DOCS_TOOL_IDS,
    GOOGLE_DRIVE_TOOL_IDS,
    GOOGLE_SHEETS_TOOL_IDS,
    GOOGLE_SLIDES_TOOL_IDS,
    HOME_ASSISTANT_TOOL_IDS,
    WHATSAPP_TOOL_IDS,
} from '@/lib/ai/agents/builtins'
import { INTEGRATION_RUNBOOKS } from '@/lib/integrations/runbooks'

// ---------------------------------------------------------------------------
// Integration manifest — single source of truth.
//
// Ties together, per integration family: the human-facing capability summary
// (cheap, always in context), the runbook (setup manual, read on demand), the
// connection-status source, and the split between *setup/lifecycle* tools
// (always exposed so an agent can verify/connect) and *operational* tools
// (heavy schemas, exposed only once the integration is connected AND the
// agent has explicitly activated the toolset for the conversation).
//
// This is what lets the orchestrator know an integration *exists* and what it
// *does* without paying for ~100 tool schemas on every turn.
// ---------------------------------------------------------------------------

/** Connection-status source. Docs/Sheets/Slides share the Google Workspace OAuth account. */
export type IntegrationStatusKind =
    | 'gmail'
    | 'google-calendar'
    | 'google-drive'
    | 'whatsapp'
    | 'home-assistant'
    | 'weather'

export interface IntegrationManifestEntry {
    /** Stable id — used by ActivateIntegrationTools, the activation store, and the runbook. */
    id: string
    /** Display label for the <integrations> block. */
    label: string
    /** 1-2 line plain-language summary of what the integration can do. Always in context. */
    capability: string
    /** Runbook id (INTEGRATION_RUNBOOKS) the agent reads to set this up. Null when none exists. */
    runbookId: string | null
    /** Which connection-status snapshot entry reflects this integration's state. */
    statusKind: IntegrationStatusKind
    /** Setup/lifecycle tool ids — always exposed for in-scope integrations (Tier 1). */
    setupToolIds: string[]
    /** Operational tool ids — exposed only when connected AND activated (Tier 2). */
    operationalToolIds: string[]
    /** Optional note shown in the block, e.g. shared-account caveats. */
    note?: string
}

/** Tool ids that are part of the setup/lifecycle surface, by family. */
const GOOGLE_CALENDAR_SETUP = ['GoogleCalendarStatus', 'GoogleCalendarConfigure', 'GoogleCalendarStartOAuth']
const GOOGLE_DRIVE_SETUP = ['GoogleDriveStatus', 'GoogleDriveConfigure', 'GoogleDriveStartOAuth']
const WHATSAPP_SETUP = ['WhatsAppStatus', 'WhatsAppConnect']
const HOME_ASSISTANT_SETUP = ['HomeAssistantStatus', 'HomeAssistantConfigure']
const WEATHER_SETUP = ['WeatherStatus']

function operationalOnly(all: string[], setup: string[]): string[] {
    const setupSet = new Set(setup)
    return all.filter(id => !setupSet.has(id))
}

export const INTEGRATION_MANIFEST: IntegrationManifestEntry[] = [
    {
        id: 'gmail',
        label: 'Gmail',
        capability: 'Email: search the mailbox, read threads, create/send drafts and emails, manage labels, archive/trash, download attachments.',
        runbookId: 'gmail',
        statusKind: 'gmail',
        // Gmail has no in-tool setup surface; setup is driven via the runbook + config API.
        setupToolIds: [],
        operationalToolIds: [...GMAIL_TOOL_IDS],
    },
    {
        id: 'google-calendar',
        label: 'Google Calendar',
        capability: 'Calendar: list/search events, check free/busy and availability, create/update/move/delete events, respond to invites.',
        runbookId: 'google-calendar',
        statusKind: 'google-calendar',
        setupToolIds: GOOGLE_CALENDAR_SETUP,
        operationalToolIds: operationalOnly(GOOGLE_CALENDAR_TOOL_IDS, GOOGLE_CALENDAR_SETUP),
    },
    {
        id: 'google-workspace',
        label: 'Google Workspace',
        capability: 'Workspace: browse/search Drive files and shared drives; read/download/export/upload/organize/share files; create and edit native Docs, Sheets, and Slides; read/manage Google Contacts and contact groups.',
        runbookId: 'google-workspace',
        statusKind: 'google-drive',
        setupToolIds: GOOGLE_DRIVE_SETUP,
        operationalToolIds: [
            ...operationalOnly(GOOGLE_DRIVE_TOOL_IDS, GOOGLE_DRIVE_SETUP),
            ...GOOGLE_CONTACTS_TOOL_IDS,
            ...GOOGLE_DOCS_TOOL_IDS,
            ...GOOGLE_SHEETS_TOOL_IDS,
            ...GOOGLE_SLIDES_TOOL_IDS,
        ],
        note: 'Uses the existing Google Workspace OAuth token stored by the Google Drive integration endpoints.',
    },
    {
        id: 'whatsapp',
        label: 'WhatsApp',
        capability: 'WhatsApp: list/read/search recent chats, send confirmed messages/media, and delete confirmed messages for everyone.',
        runbookId: 'whatsapp',
        statusKind: 'whatsapp',
        setupToolIds: WHATSAPP_SETUP,
        operationalToolIds: operationalOnly(WHATSAPP_TOOL_IDS, WHATSAPP_SETUP),
    },
    {
        id: 'home-assistant',
        label: 'Home Assistant',
        capability: 'Smart home: read states/history/logbook/automations, render templates, and control lights/covers/climate/notify plus confirmed service calls.',
        runbookId: 'home-assistant',
        statusKind: 'home-assistant',
        setupToolIds: HOME_ASSISTANT_SETUP,
        operationalToolIds: operationalOnly(HOME_ASSISTANT_TOOL_IDS, HOME_ASSISTANT_SETUP),
    },
    {
        id: 'weather',
        label: 'Weather',
        capability: 'Render live iOS-style weather cards inline in the chat — current conditions, 24-hour scroll, 10-day forecast, UV/wind/sunrise detail tiles, optional AQI, historical comparison, and pollen. Uses Google Weather / Air Quality / Pollen when the shared Maps Platform key is configured, with keyless Open-Meteo fallback.',
        runbookId: 'weather',
        statusKind: 'weather',
        setupToolIds: WEATHER_SETUP,
        // WeatherShow lives on the orchestrator directly (composition exclusive).
        // Manifest entry exists for the connection-status block.
        operationalToolIds: [],
        note: 'WeatherShow is always visible to the orchestrator. Forecasts work without Google via Open-Meteo (keyless, ECMWF-backed); GOOGLE_MAPS_API_KEY + Weather API upgrades the primary provider, Air Quality API upgrades local AQI, and Pollen API upgrades pollen. Open-Meteo remains the keyless fallback for AQ, historical comparison, and seasonal pollen.',
    },
]

const MANIFEST_BY_ID = new Map(INTEGRATION_MANIFEST.map(e => [e.id, e]))

export function getIntegrationManifest(id: string): IntegrationManifestEntry | undefined {
    return MANIFEST_BY_ID.get(id)
}

/** Every operational tool id mapped back to its manifest id (for exposure gating). */
const OPERATIONAL_TOOL_TO_INTEGRATION = new Map<string, string>()
for (const entry of INTEGRATION_MANIFEST) {
    for (const toolId of entry.operationalToolIds) {
        OPERATIONAL_TOOL_TO_INTEGRATION.set(toolId, entry.id)
    }
}

/** Returns the manifest id if `toolId` is a gated operational integration tool, else undefined. */
export function operationalIntegrationFor(toolId: string): string | undefined {
    return OPERATIONAL_TOOL_TO_INTEGRATION.get(toolId)
}

/**
 * Manifest entries an agent is "in scope" for, given its declared tool id list
 * (the static grant from its AgentConfig — NOT the gated runtime set). An
 * integration is in scope if the agent declares any of its setup or
 * operational tools.
 */
export function integrationsInScope(declaredToolIds: string[]): IntegrationManifestEntry[] {
    const declared = new Set(declaredToolIds)
    return INTEGRATION_MANIFEST.filter(entry =>
        entry.setupToolIds.some(id => declared.has(id)) ||
        entry.operationalToolIds.some(id => declared.has(id))
    )
}

/** Resolve the runbook workspace path for a manifest entry, if it has one. */
export function runbookPathFor(entry: IntegrationManifestEntry): string | null {
    if (!entry.runbookId) return null
    const runbook = INTEGRATION_RUNBOOKS.find(r => r.id === entry.runbookId)
    return runbook?.relativePath ?? null
}
