"use client"

import * as React from "react"
import type { UsageRange, UsageReport } from "@/lib/observability/schema"

export function useUsage(range: UsageRange) {
    const [data, setData] = React.useState<UsageReport | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)
    const requestId = React.useRef(0)

    const fetchReport = React.useCallback(() => {
        const myRid = ++requestId.current
        setLoading(true)
        fetch(`/api/usage?range=${range}`)
            .then(async res => {
                if (!res.ok) throw new Error(`Failed (${res.status})`)
                return (await res.json()) as UsageReport
            })
            .then(json => {
                if (myRid !== requestId.current) return
                setData(json)
                setError(null)
            })
            .catch((err: unknown) => {
                if (myRid !== requestId.current) return
                setError(err instanceof Error ? err.message : "Unknown error")
            })
            .finally(() => {
                if (myRid === requestId.current) setLoading(false)
            })
    }, [range])

    React.useEffect(() => {
        fetchReport()
    }, [fetchReport])

    return { data, loading, error, refresh: fetchReport }
}
