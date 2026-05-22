"use client"

import * as React from "react"

export interface CliStatusEntry {
    name: string
    description: string
    bin: string
    installHint: string
    installDocsUrl?: string
    loginHint: string
    installed: boolean
    loggedIn: boolean
    /** True when credentials exist but are expired/expiring — render as Reconnect. */
    needsReconnect?: boolean
    /** Unix-ms OAuth expiry, if known. */
    expiresAt?: number
    /** `oauth`, `setup-token`, `api-key`, `unknown`. */
    authMethod?: "oauth" | "setup-token" | "api-key" | "unknown"
    detail?: string
}

export type CliStatusMap = Record<string, CliStatusEntry>

/** Fetches /api/cli/status with a `refresh()` for after login/logout flows. */
export function useCliStatus() {
    const [data, setData] = React.useState<CliStatusMap | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)

    const fetchStatus = React.useCallback(async () => {
        setLoading(true)
        try {
            const res = await fetch("/api/cli/status")
            if (!res.ok) throw new Error(`Failed (${res.status})`)
            const json = (await res.json()) as CliStatusMap
            setData(json)
            setError(null)
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error")
        } finally {
            setLoading(false)
        }
    }, [])

    React.useEffect(() => { void fetchStatus() }, [fetchStatus])

    return { data, loading, error, refresh: fetchStatus }
}
