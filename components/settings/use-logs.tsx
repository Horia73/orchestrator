"use client"

import * as React from "react"
import type {
    RequestLogRow,
    ToolLogRow,
    LogsQuery,
    RequestLogInput,
} from "@/lib/observability/schema"
import type { Message } from "@/lib/types"

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

export type LiveTailStatus = "off" | "connecting" | "connected" | "disconnected"

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
    liveTailStatus: LiveTailStatus
}

interface PageSnapshot {
    total: number
    rowSignatures: string[]
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
    const [liveTailStatus, setLiveTailStatus] = React.useState<LiveTailStatus>("connecting")

    // Avoid race conditions when filters change while a fetch is in flight.
    const requestId = React.useRef(0)
    const pageSnapshotRef = React.useRef<PageSnapshot>(makePageSnapshot([], 0))

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
        async (
            mode: "reset" | "append",
            currentCursor: number | null,
            options?: { showLoading?: boolean; skipUnchanged?: boolean }
        ) => {
            const myRid = ++requestId.current
            const showLoading = options?.showLoading ?? mode === "reset"
            if (showLoading) setLoading(true)

            try {
                const res = await fetch(buildUrl(filters, currentCursor))
                if (!res.ok) throw new Error(`Failed to load logs (${res.status})`)
                const data = (await res.json()) as LogsPageResponse
                if (myRid !== requestId.current) return // superseded

                if (mode === "reset") {
                    const nextSnapshot = makePageSnapshot(data.rows, data.total)
                    if (options?.skipUnchanged && samePageSnapshot(pageSnapshotRef.current, nextSnapshot)) {
                        setError(null)
                        return
                    }
                    pageSnapshotRef.current = nextSnapshot
                }
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

    // Keep the latest `fetchPage` in a ref so the SSE effect can call it without
    // listing it as a dependency. `fetchPage` is recreated on every `filters`
    // change; if the stream effect depended on it, every filter tweak would tear
    // down and reopen the EventSource — flashing connecting→connected on each
    // change (and reliably once on mount, when the search debounce churns the
    // filters reference). The stream's lifecycle should track only `liveTail`.
    const fetchPageRef = React.useRef(fetchPage)
    React.useEffect(() => {
        fetchPageRef.current = fetchPage
    }, [fetchPage])

    const clearAll = React.useCallback(async () => {
        const res = await fetch("/api/logs", { method: "DELETE" })
        if (!res.ok) throw new Error(`Failed to clear (${res.status})`)
        setRows([])
        setTotal(0)
        setCursor(null)
        setHasMore(false)
        pageSnapshotRef.current = makePageSnapshot([], 0)
    }, [])

    // Live tail via SSE — refetches the head when an event arrives.
    React.useEffect(() => {
        if (!liveTail) {
            setLiveTailStatus("off")
            return
        }

        setLiveTailStatus("connecting")
        const es = new EventSource("/api/logs/stream")
        let closed = false
        let pendingTimer: number | null = null
        let fallbackTimer: number | null = null

        const trigger = () => {
            if (pendingTimer !== null) return
            // Coalesce bursts (e.g. start + complete fire close together).
            pendingTimer = window.setTimeout(() => {
                pendingTimer = null
                void fetchPageRef.current("reset", null, { showLoading: false })
            }, 250)
        }

        es.onopen = () => {
            if (!closed) setLiveTailStatus("connected")
        }
        es.onerror = () => {
            if (closed) return
            setLiveTailStatus(es.readyState === EventSource.CLOSED ? "disconnected" : "connecting")
        }
        es.onmessage = e => {
            try {
                const data = JSON.parse(e.data)
                if (data.type === "ready") {
                    setLiveTailStatus("connected")
                    // Catch rows inserted while the stream was connecting or reconnecting.
                    void fetchPageRef.current("reset", null, { showLoading: false, skipUnchanged: true })
                    return
                }
                if (data.type === "request_started" || data.type === "request_completed" || data.type === "logs_cleared") {
                    trigger()
                }
            } catch { /* ignore */ }
        }

        fallbackTimer = window.setInterval(() => {
            if (document.visibilityState === "visible") {
                void fetchPageRef.current("reset", null, { showLoading: false, skipUnchanged: true })
            }
        }, 10_000)

        const refreshWhenVisible = () => {
            if (document.visibilityState === "visible") {
                void fetchPageRef.current("reset", null, { showLoading: false, skipUnchanged: true })
            }
        }
        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") refreshWhenVisible()
        }

        window.addEventListener("focus", refreshWhenVisible)
        document.addEventListener("visibilitychange", onVisibilityChange)

        return () => {
            closed = true
            if (pendingTimer !== null) window.clearTimeout(pendingTimer)
            if (fallbackTimer !== null) window.clearInterval(fallbackTimer)
            window.removeEventListener("focus", refreshWhenVisible)
            document.removeEventListener("visibilitychange", onVisibilityChange)
            es.close()
        }
        // Intentionally NOT depending on `fetchPage`: the stream's lifecycle
        // tracks `liveTail` only, and we call the latest fetch via `fetchPageRef`.
    }, [liveTail])

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
        liveTailStatus,
    }
}

function makePageSnapshot(rows: RequestLogRow[], total: number): PageSnapshot {
    return {
        total,
        rowSignatures: rows.slice(0, PAGE_SIZE).map(rowSignature),
    }
}

function samePageSnapshot(a: PageSnapshot, b: PageSnapshot): boolean {
    if (a.total !== b.total || a.rowSignatures.length !== b.rowSignatures.length) return false
    return a.rowSignatures.every((signature, index) => signature === b.rowSignatures[index])
}

function rowSignature(row: RequestLogRow): string {
    return [
        row.id,
        row.status,
        row.startedAt,
        row.endedAt ?? "",
        row.durationMs ?? "",
        row.thinkingMs ?? "",
        row.inputTokens ?? "",
        row.outputTokens ?? "",
        row.thinkingTokens ?? "",
        row.cachedTokens ?? "",
        row.toolUseTokens ?? "",
        row.totalTokens ?? "",
        row.toolCallCount,
        row.errorMessage ?? "",
    ].join("|")
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
    transcript: RequestLogTranscript | null
    hasInput: boolean
    input: RequestLogInput | null
}

export type RequestLogTranscript =
    {
        userMessage: Message | null
        assistantMessage: Message
    }

const DETAIL_POLL_MS = 1200

/**
 * Lazy-load a single request's detail (tool calls, transcript, full input).
 *
 * While the row is still streaming (`live`), poll the detail in the background
 * so tool calls — written to the DB as each tool finishes — show up in the
 * expanded panel without the user having to collapse and re-expand it. The
 * very first load (per request) shows the spinner; every subsequent refresh
 * (live polls + the one final pull after the stream ends, when the output text
 * and reasoning are persisted) updates silently so the panel never flashes.
 */
export function useRequestDetail(requestId: string | null, options?: { live?: boolean }): {
    data: RequestDetail | null
    loading: boolean
    error: string | null
} {
    const live = options?.live ?? false
    const [data, setData] = React.useState<RequestDetail | null>(null)
    const [loading, setLoading] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)

    // Whether we already hold data for the CURRENT request. Survives the effect
    // re-run triggered by `live` flipping (so the post-stream refresh stays
    // background) while resetting when the request id changes.
    const loadedForRef = React.useRef<string | null>(null)

    React.useEffect(() => {
        if (!requestId) { setData(null); loadedForRef.current = null; return }
        let cancelled = false
        let timer: number | null = null

        const fetchDetail = (foreground: boolean) => {
            if (foreground) setLoading(true)
            fetch(`/api/logs/${encodeURIComponent(requestId)}?includeInput=0`)
                .then(async res => {
                    if (!res.ok) throw new Error(`Failed (${res.status})`)
                    return res.json() as Promise<RequestDetail>
                })
                .then(json => {
                    if (cancelled) return
                    loadedForRef.current = requestId
                    setData(json)
                    setError(null)
                    // Self-stop once the run is no longer streaming, even if the
                    // parent hasn't yet flipped `live` from its list refresh.
                    if (json.log.status !== "streaming" && timer !== null) {
                        window.clearInterval(timer)
                        timer = null
                    }
                })
                .catch((err: unknown) => {
                    // A background refresh that fails must not replace good data
                    // with an error banner — only the first load surfaces errors.
                    if (cancelled || !foreground) return
                    setError(err instanceof Error ? err.message : "Unknown error")
                })
                .finally(() => { if (!cancelled && foreground) setLoading(false) })
        }

        // Spinner only the first time we load this request; the live polls and
        // the final post-stream pull are silent background refreshes.
        fetchDetail(loadedForRef.current !== requestId)

        if (live) {
            timer = window.setInterval(() => fetchDetail(false), DETAIL_POLL_MS)
        }

        return () => {
            cancelled = true
            if (timer !== null) window.clearInterval(timer)
        }
    }, [requestId, live])

    return { data, loading, error }
}

export function useRequestInput(requestId: string, enabled: boolean): {
    input: RequestLogInput | null
    loading: boolean
    error: string | null
} {
    const [input, setInput] = React.useState<RequestLogInput | null>(null)
    const [loading, setLoading] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const loadedForRef = React.useRef<string | null>(null)

    React.useEffect(() => {
        if (!enabled || loadedForRef.current === requestId) return

        let cancelled = false
        setLoading(true)
        fetch(`/api/logs/${encodeURIComponent(requestId)}?includeInput=1`)
            .then(async res => {
                if (!res.ok) throw new Error(`Failed (${res.status})`)
                return res.json() as Promise<RequestDetail>
            })
            .then(json => {
                if (cancelled) return
                loadedForRef.current = requestId
                setInput(json.input ?? null)
                setError(null)
            })
            .catch((err: unknown) => {
                if (cancelled) return
                setError(err instanceof Error ? err.message : "Unknown error")
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })

        return () => {
            cancelled = true
        }
    }, [requestId, enabled])

    return { input, loading, error }
}
