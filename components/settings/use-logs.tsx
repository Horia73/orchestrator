"use client"

import * as React from "react"
import type {
    RequestLogRow,
    ToolLogRow,
    LogsQuery,
} from "@/lib/observability/schema"

interface FilterOptions {
    agents: string[]
    providers: string[]
    models: Array<{ provider: string; model: string }>
}

interface LogsPageResponse {
    rows: RequestLogRow[]
    nextCursor: number | null
    total: number
    filters: FilterOptions
}

export interface LogsFilters {
    range: NonNullable<LogsQuery["range"]>
    status: LogsQuery["status"]
    agent?: string
    provider?: string
    model?: string
    q?: string
}

const DEFAULT_FILTERS: LogsFilters = { range: "all", status: undefined }
const PAGE_SIZE = 50

interface UseLogsResult {
    rows: RequestLogRow[]
    total: number
    filters: LogsFilters
    setFilters: (next: LogsFilters | ((prev: LogsFilters) => LogsFilters)) => void
    filterOptions: FilterOptions
    loading: boolean
    error: string | null
    hasMore: boolean
    loadMore: () => void
    /** Refetch the head of the list (page 1). Used by SSE live-tail. */
    refresh: () => void
    clearAll: () => Promise<void>
    liveTail: boolean
    setLiveTail: (next: boolean) => void
}

export function useLogs(): UseLogsResult {
    const [rows, setRows] = React.useState<RequestLogRow[]>([])
    const [total, setTotal] = React.useState(0)
    const [filters, setFilters] = React.useState<LogsFilters>(DEFAULT_FILTERS)
    const [filterOptions, setFilterOptions] = React.useState<FilterOptions>({
        agents: [],
        providers: [],
        models: [],
    })
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)
    const [cursor, setCursor] = React.useState<number | null>(null)
    const [hasMore, setHasMore] = React.useState(false)
    const [liveTail, setLiveTail] = React.useState(true)

    // Avoid race conditions when filters change while a fetch is in flight.
    const requestId = React.useRef(0)

    const buildUrl = React.useCallback((f: LogsFilters, c: number | null): string => {
        const sp = new URLSearchParams()
        sp.set("limit", String(PAGE_SIZE))
        sp.set("range", f.range)
        if (f.status) sp.set("status", f.status)
        if (f.agent) sp.set("agent", f.agent)
        if (f.provider) sp.set("provider", f.provider)
        if (f.model) sp.set("model", f.model)
        if (f.q) sp.set("q", f.q)
        if (c !== null) sp.set("cursor", String(c))
        return `/api/logs?${sp.toString()}`
    }, [])

    const fetchPage = React.useCallback(
        async (mode: "reset" | "append", currentCursor: number | null) => {
            const myRid = ++requestId.current
            if (mode === "reset") setLoading(true)

            try {
                const res = await fetch(buildUrl(filters, currentCursor))
                if (!res.ok) throw new Error(`Failed to load logs (${res.status})`)
                const data = (await res.json()) as LogsPageResponse
                if (myRid !== requestId.current) return // superseded

                setFilterOptions(data.filters)
                setTotal(data.total)
                setCursor(data.nextCursor)
                setHasMore(data.nextCursor !== null)
                if (mode === "reset") {
                    setRows(data.rows)
                } else {
                    setRows(prev => mergeRows(prev, data.rows))
                }
                setError(null)
            } catch (err) {
                if (myRid !== requestId.current) return
                setError(err instanceof Error ? err.message : "Unknown error")
            } finally {
                if (myRid === requestId.current && mode === "reset") setLoading(false)
            }
        },
        [filters, buildUrl]
    )

    // Reset page when filters change.
    React.useEffect(() => {
        void fetchPage("reset", null)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filters])

    const loadMore = React.useCallback(() => {
        if (!hasMore || loading) return
        void fetchPage("append", cursor)
    }, [hasMore, loading, cursor, fetchPage])

    const refresh = React.useCallback(() => {
        void fetchPage("reset", null)
    }, [fetchPage])

    const clearAll = React.useCallback(async () => {
        const res = await fetch("/api/logs", { method: "DELETE" })
        if (!res.ok) throw new Error(`Failed to clear (${res.status})`)
        setRows([])
        setTotal(0)
        setCursor(null)
        setHasMore(false)
    }, [])

    // Live tail via SSE — refetches the head when an event arrives.
    React.useEffect(() => {
        if (!liveTail) return
        const es = new EventSource("/api/logs/stream")
        let pending = false
        const trigger = () => {
            if (pending) return
            pending = true
            // Coalesce bursts (e.g. start + complete fire close together).
            setTimeout(() => {
                pending = false
                void fetchPage("reset", null)
            }, 250)
        }
        es.onmessage = e => {
            try {
                const data = JSON.parse(e.data)
                if (data.type === "request_started" || data.type === "request_completed" || data.type === "logs_cleared") {
                    trigger()
                }
            } catch { /* ignore */ }
        }
        return () => { es.close() }
    }, [liveTail, fetchPage])

    return {
        rows,
        total,
        filters,
        setFilters,
        filterOptions,
        loading,
        error,
        hasMore,
        loadMore,
        refresh,
        clearAll,
        liveTail,
        setLiveTail,
    }
}

function mergeRows(existing: RequestLogRow[], incoming: RequestLogRow[]): RequestLogRow[] {
    if (incoming.length === 0) return existing
    const seen = new Set(existing.map(r => r.id))
    const merged = [...existing]
    for (const r of incoming) {
        if (!seen.has(r.id)) merged.push(r)
    }
    return merged
}

export interface RequestDetail {
    log: RequestLogRow
    toolLogs: ToolLogRow[]
}

/** Lazy-load a single request's detail (tool calls). */
export function useRequestDetail(requestId: string | null): {
    data: RequestDetail | null
    loading: boolean
    error: string | null
} {
    const [data, setData] = React.useState<RequestDetail | null>(null)
    const [loading, setLoading] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)

    React.useEffect(() => {
        if (!requestId) { setData(null); return }
        let cancelled = false
        setLoading(true)
        fetch(`/api/logs/${encodeURIComponent(requestId)}`)
            .then(async res => {
                if (!res.ok) throw new Error(`Failed (${res.status})`)
                return res.json() as Promise<RequestDetail>
            })
            .then(json => { if (!cancelled) { setData(json); setError(null) } })
            .catch((err: unknown) => {
                if (cancelled) return
                setError(err instanceof Error ? err.message : "Unknown error")
            })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [requestId])

    return { data, loading, error }
}
