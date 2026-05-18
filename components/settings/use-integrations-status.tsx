"use client"

import * as React from "react"

export interface GmailIntegrationStatusEntry {
    id: "gmail"
    name: string
    description: string
    configured: boolean
    connected: boolean
    accountEmail: string | null
    scopes: string[]
    requestedScopes: string[]
    missingConfig: string[]
    redirectUri: string
    expiresAt: number | null
    needsReconnect: boolean
    error?: string
}

export interface GoogleCalendarIntegrationStatusEntry {
    id: "googleCalendar"
    name: string
    description: string
    configured: boolean
    connected: boolean
    accountEmail: string | null
    scopes: string[]
    requestedScopes: string[]
    missingConfig: string[]
    redirectUri: string
    expiresAt: number | null
    needsReconnect: boolean
    calendarCount: number | null
    writableCalendarCount: number | null
    primaryCalendarId: string | null
    primaryCalendarSummary: string | null
    timeZone: string | null
    capabilities: string[]
    error?: string
}

export interface GoogleDriveIntegrationStatusEntry {
    id: "googleDrive"
    name: string
    description: string
    configured: boolean
    connected: boolean
    accountEmail: string | null
    accountName: string | null
    scopes: string[]
    requestedScopes: string[]
    missingConfig: string[]
    redirectUri: string
    expiresAt: number | null
    needsReconnect: boolean
    storageQuota: {
        limit: string | null
        usage: string | null
        usageInDrive: string | null
        usageInDriveTrash: string | null
    } | null
    maxUploadSize: string | null
    appInstalled: boolean | null
    capabilities: string[]
    error?: string
}

export type WhatsAppPhase =
    | "idle"
    | "starting"
    | "qr"
    | "authenticated"
    | "ready"
    | "disconnected"
    | "auth_failure"
    | "error"

export interface WhatsAppIntegrationStatusEntry {
    id: "whatsapp"
    name: string
    description: string
    configured: boolean
    connected: boolean
    accountName: string | null
    phoneNumber: string | null
    phase: WhatsAppPhase
    sessionStored: boolean
    qrAvailable: boolean
    qrDataUrl: string | null
    qrImageUrl: string | null
    qrUpdatedAt: number | null
    qrExpiresAt: number | null
    lastReadyAt: number | null
    lastSyncAt: number | null
    lastError: string | null
    browserExecutablePath: string | null
    missingConfig: string[]
    needsReconnect: boolean
    capabilities: string[]
}

export interface HomeAssistantIntegrationStatusEntry {
    id: "homeAssistant"
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
    actionMode: {
        version: 1
        enabled: boolean
        directDomains: string[]
        confirmOtherDomains: boolean
        updatedAt: number
    }
}

export interface RuntimeAccessInfo {
    appOrigin: string
    appHost: string | null
    appPort: string
    publicUrl: string | null
    serverHostname: string
    sshUser: string | null
    envHostLanIp: string | null
    runtimeIPv4: string[]
    resolvedAppHostIPv4: string[]
    sshHostCandidates: string[]
    tunnel: {
        localPort: string
        remotePort: string
        remoteHost: string
        command: string
        openUrl: string
        keepOpen: string
        stop: string
    }
}

export type IntegrationStatusEntry =
    | GmailIntegrationStatusEntry
    | GoogleCalendarIntegrationStatusEntry
    | GoogleDriveIntegrationStatusEntry
    | WhatsAppIntegrationStatusEntry
    | HomeAssistantIntegrationStatusEntry

export interface IntegrationsStatus {
    gmail: GmailIntegrationStatusEntry
    googleCalendar: GoogleCalendarIntegrationStatusEntry
    googleDrive: GoogleDriveIntegrationStatusEntry
    whatsapp: WhatsAppIntegrationStatusEntry
    homeAssistant: HomeAssistantIntegrationStatusEntry
    runtime?: RuntimeAccessInfo
}

export function useIntegrationsStatus() {
    const [data, setData] = React.useState<IntegrationsStatus | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)

    const refresh = React.useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch("/api/integrations/status", { cache: "no-store" })
            if (!res.ok) throw new Error(`Failed (${res.status})`)
            const json = (await res.json()) as IntegrationsStatus
            setData(json)
            setError(null)
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error")
        } finally {
            setLoading(false)
        }
    }, [])

    React.useEffect(() => { void refresh() }, [refresh])

    return { data, loading, error, refresh }
}
