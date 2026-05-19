"use client"

import * as React from "react"
import type {
  ScheduledAction,
  ScheduledTask,
  ScheduleSpec,
} from "@/lib/scheduling/schema"
import type { TaskRunRecord } from "@/lib/scheduling/store"

export type { TaskRunRecord }

const POLL_MS = 4000
const RUN_HISTORY_PAGE_SIZE = 50

export interface TaskRunPage {
  runs: TaskRunRecord[]
  nextCursor: string | null
  hasMore: boolean
  total: number
}

export interface TaskRunFilters {
  status?: "ok" | "error"
  trigger?: "schedule" | "manual"
  surfaced?: boolean
}

export interface NewTaskPayload {
  title: string
  action: ScheduledAction
  schedule: ScheduleSpec
  enabled: boolean
}

interface SchedulingApi {
  tasks: ScheduledTask[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  createTask: (payload: NewTaskPayload) => Promise<void>
  updateTask: (id: string, patch: Partial<NewTaskPayload>) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  runTask: (
    id: string
  ) => Promise<{ ok: boolean; conversationId: string | null; error?: string }>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  fetchRuns: (
    taskId: string,
    options?: {
      before?: string | null
      limit?: number
      filters?: TaskRunFilters
    }
  ) => Promise<TaskRunPage>
}

async function asError(res: Response): Promise<string> {
  try {
    const data = await res.json()
    return typeof data?.error === "string"
      ? data.error
      : `Request failed (${res.status})`
  } catch {
    return `Request failed (${res.status})`
  }
}

const SchedulingContext = React.createContext<SchedulingApi | null>(null)

export function SchedulingProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [tasks, setTasks] = React.useState<ScheduledTask[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/scheduled-tasks", { cache: "no-store" })
      if (!res.ok) throw new Error(await asError(res))
      const data = await res.json()
      setTasks(Array.isArray(data.tasks) ? data.tasks : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks")
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    refresh().finally(() => {
      if (!cancelled) setLoading(false)
    })

    const onTick = () => {
      if (document.visibilityState === "visible") void refresh()
    }
    const interval = window.setInterval(onTick, POLL_MS)
    document.addEventListener("visibilitychange", onTick)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onTick)
    }
  }, [refresh])

  const createTask = React.useCallback(
    async (payload: NewTaskPayload) => {
      const res = await fetch("/api/scheduled-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(await asError(res))
      await refresh()
    },
    [refresh]
  )

  const updateTask = React.useCallback(
    async (id: string, patch: Partial<NewTaskPayload>) => {
      const res = await fetch(`/api/scheduled-tasks/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error(await asError(res))
      await refresh()
    },
    [refresh]
  )

  const deleteTask = React.useCallback(
    async (id: string) => {
      const res = await fetch(`/api/scheduled-tasks/${id}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error(await asError(res))
      await refresh()
    },
    [refresh]
  )

  const runTask = React.useCallback(
    async (id: string) => {
      const res = await fetch(`/api/scheduled-tasks/${id}/run`, {
        method: "POST",
      })
      const data = await res
        .json()
        .catch(() => ({ ok: false, conversationId: null, error: "Run failed" }))
      await refresh()
      window.dispatchEvent(new CustomEvent("orchestrator:inbox-updated"))
      return data as {
        ok: boolean
        conversationId: string | null
        error?: string
      }
    },
    [refresh]
  )

  const setEnabled = React.useCallback(
    async (id: string, enabled: boolean) => {
      await updateTask(id, { enabled })
    },
    [updateTask]
  )

  const fetchRuns = React.useCallback(
    async (
      taskId: string,
      options: {
        before?: string | null
        limit?: number
        filters?: TaskRunFilters
      } = {}
    ): Promise<TaskRunPage> => {
      const params = new URLSearchParams({
        limit: String(options.limit ?? RUN_HISTORY_PAGE_SIZE),
      })
      if (options.before) params.set("before", options.before)
      if (options.filters?.status) params.set("status", options.filters.status)
      if (options.filters?.trigger)
        params.set("trigger", options.filters.trigger)
      if (options.filters?.surfaced !== undefined)
        params.set("surfaced", String(options.filters.surfaced))
      const res = await fetch(
        `/api/scheduled-tasks/${taskId}/runs?${params.toString()}`,
        { cache: "no-store" }
      )
      if (!res.ok) throw new Error(await asError(res))
      const data = await res.json()
      return {
        runs: Array.isArray(data.runs) ? data.runs : [],
        nextCursor:
          typeof data.nextCursor === "string" ? data.nextCursor : null,
        hasMore: Boolean(data.hasMore),
        total: typeof data.total === "number" ? data.total : 0,
      }
    },
    []
  )

  const value = React.useMemo<SchedulingApi>(
    () => ({
      tasks,
      loading,
      error,
      refresh,
      createTask,
      updateTask,
      deleteTask,
      runTask,
      setEnabled,
      fetchRuns,
    }),
    [
      tasks,
      loading,
      error,
      refresh,
      createTask,
      updateTask,
      deleteTask,
      runTask,
      setEnabled,
      fetchRuns,
    ]
  )

  return (
    <SchedulingContext.Provider value={value}>
      {children}
    </SchedulingContext.Provider>
  )
}

export function useScheduling(): SchedulingApi {
  const ctx = React.useContext(SchedulingContext)
  if (!ctx)
    throw new Error("useScheduling must be used within a SchedulingProvider")
  return ctx
}
