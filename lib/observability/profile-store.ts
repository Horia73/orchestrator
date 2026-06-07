import { runWithProfileContext } from "@/lib/profiles/context"
import { listProfiles } from "@/lib/profiles/store"
import type { ProfileRecord } from "@/lib/profiles/types"
import type { LogsQuery, RequestLogRow } from "./schema"
import {
  clearAllLogs,
  getFilterOptions,
  getRequestLog,
  getRequestLogReasoning,
  getToolLogsForRequest,
  queryLogs,
  type FilterOptions,
  type LogsPage,
  type RequestLogReasoning,
} from "./store"
import type { ToolLogRow } from "./schema"

export interface ProfiledRequestLogRow extends RequestLogRow {
  profileId: string
  profileName: string
}

export interface ProfiledRequestLogDetail {
  profile: ProfileRecord
  row: ProfiledRequestLogRow
  reasoning: RequestLogReasoning | null
  toolLogs: ToolLogRow[]
}

export function queryLogsAcrossProfiles(q: LogsQuery): LogsPage {
  const candidates: ProfiledRequestLogRow[] = []
  let total = 0

  for (const profile of listProfiles({ includeDisabled: true })) {
    const page = runWithProfileContext(
      { profileId: profile.id, role: profile.role },
      () => queryLogs(q)
    )
    total += page.total
    candidates.push(...page.rows.map((row) => withProfile(row, profile)))
  }

  candidates.sort((a, b) => {
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt
    return b.id.localeCompare(a.id)
  })
  const rows = candidates.slice(0, q.limit)
  return {
    rows,
    total,
    nextCursor: rows.length === q.limit ? rows[rows.length - 1].startedAt : null,
  }
}

export function getFilterOptionsAcrossProfiles(): FilterOptions {
  const agents = new Set<string>()
  const providers = new Set<string>()
  const modelKeys = new Set<string>()
  const models: Array<{ provider: string; model: string }> = []

  for (const profile of listProfiles({ includeDisabled: true })) {
    const options = runWithProfileContext(
      { profileId: profile.id, role: profile.role },
      () => getFilterOptions()
    )
    for (const agent of options.agents) agents.add(agent)
    for (const provider of options.providers) providers.add(provider)
    for (const model of options.models) {
      const key = `${model.provider}\0${model.model}`
      if (modelKeys.has(key)) continue
      modelKeys.add(key)
      models.push(model)
    }
  }

  return {
    agents: [...agents].sort(),
    providers: [...providers].sort(),
    models: models.sort((a, b) =>
      a.provider === b.provider
        ? a.model.localeCompare(b.model)
        : a.provider.localeCompare(b.provider)
    ),
  }
}

export function getRequestLogDetailAcrossProfiles(
  requestId: string
): ProfiledRequestLogDetail | null {
  for (const profile of listProfiles({ includeDisabled: true })) {
    const detail = runWithProfileContext(
      { profileId: profile.id, role: profile.role },
      () => {
        const row = getRequestLog(requestId)
        if (!row) return null
        return {
          row: withProfile(row, profile),
          reasoning: getRequestLogReasoning(requestId),
          toolLogs: getToolLogsForRequest(requestId),
        }
      }
    )
    if (detail) return { profile, ...detail }
  }
  return null
}

export function clearAllLogsAcrossProfiles(): {
  deletedRequests: number
  deletedTools: number
  profilesCleared: string[]
} {
  let deletedRequests = 0
  let deletedTools = 0
  const profilesCleared: string[] = []

  for (const profile of listProfiles({ includeDisabled: true })) {
    const result = runWithProfileContext(
      { profileId: profile.id, role: profile.role },
      () => clearAllLogs()
    )
    deletedRequests += result.deletedRequests
    deletedTools += result.deletedTools
    profilesCleared.push(profile.id)
  }

  return { deletedRequests, deletedTools, profilesCleared }
}

function withProfile(
  row: RequestLogRow,
  profile: ProfileRecord
): ProfiledRequestLogRow {
  return {
    ...row,
    profileId: profile.id,
    profileName: profile.name,
  }
}
