"use client"

import * as React from "react"

export interface CliQuotaWindow {
    usedPercent: number
    resetsAt: number
    windowSeconds?: number
}

export interface CliQuotaSnapshot {
    cliId: "claude-code" | "codex"
    available: boolean
    error?: string
    fiveHour?: CliQuotaWindow
    weekly?: CliQuotaWindow
    weeklySonnet?: CliQuotaWindow
    source: "app-server" | "api" | "host-bridge" | "log" | "tui" | "none"
    fetchedAt: number
    dataTimestamp?: number
}

export type CliQuotaMap = Record<string, CliQuotaSnapshot>

/** Fetches /api/cli/usage with a manual `refresh()` for the recheck button. */
export function useCliUsage() {
    const [data, setData] = React.useState<CliQuotaMap | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)
    const reqId = React.useRef(0)

    const fetchUsage = React.useCallback(async () => {
        const myReq = ++reqId.current
        setLoading(true)
        try {
            const res = await fetch("/api/cli/usage", { cache: "no-store" })
            if (!res.ok) throw new Error(`Failed (${res.status})`)
            const json = (await res.json()) as CliQuotaMap
            if (myReq !== reqId.current) return
            setData(json)
            setError(null)
        } catch (err) {
            if (myReq !== reqId.current) return
            setError(err instanceof Error ? err.message : "Unknown error")
        } finally {
            if (myReq === reqId.current) setLoading(false)
        }
    }, [])

    React.useEffect(() => { void fetchUsage() }, [fetchUsage])

    return { data, loading, error, refresh: fetchUsage }
}
