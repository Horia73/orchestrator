import fs from 'fs'
import path from 'path'

import db from '@/lib/db'
import {
    appendRuntimeRequestLogIndex,
    appendRuntimeRunIndex,
    runtimeIndexRoot,
} from '@/lib/runtime-index'
import type { RequestLogRow } from '@/lib/observability/schema'
import { ADMIN_PROFILE_ID } from '@/lib/profiles/constants'
import { isAdminProfileId, normalizeProfileId, runWithProfileContext } from '@/lib/profiles/context'
import { listProfiles } from '@/lib/profiles/store'

type RunRow = {
    id: string
    taskId: string
    taskTitle: string | null
    startedAt: number
    endedAt: number
    status: 'ok' | 'error'
    trigger: 'schedule' | 'manual'
    surfaced: number
    conversationId: string | null
    summary: string
    error: string | null
}

type RequestLogIndexRow = {
    id: string
    conversationId: string
    agentId: string
    agentThreadId: string | null
    parentRequestId: string | null
    depth: number
    provider: string
    model: string
    status: RequestLogRow['status']
    startedAt: number
    endedAt: number | null
    durationMs: number | null
    toolCallCount: number
    interactionId: string | null
    errorMessage: string | null
    inputText: string | null
    outputText: string | null
}

function rebuildProfile(profileId: string): void {
    runWithProfileContext(
        { profileId, role: isAdminProfileId(profileId) ? 'admin' : 'member' },
        () => {
            const root = runtimeIndexRoot()
            fs.rmSync(path.join(root, 'runs'), { recursive: true, force: true })
            fs.rmSync(path.join(root, 'logs'), { recursive: true, force: true })

            const runs = db
                .prepare(`
                    SELECT r.*, t.title as taskTitle
                    FROM scheduled_task_runs r
                    LEFT JOIN scheduled_tasks t ON t.id = r.taskId
                    ORDER BY r.startedAt ASC
                `)
                .all() as RunRow[]

            for (const row of runs) {
                appendRuntimeRunIndex({
                    id: row.id,
                    taskId: row.taskId,
                    taskTitle: row.taskTitle,
                    startedAt: row.startedAt,
                    endedAt: row.endedAt,
                    status: row.status,
                    trigger: row.trigger,
                    surfaced: row.surfaced === 1,
                    conversationId: row.conversationId,
                    summary: row.summary,
                    error: row.error,
                })
            }

            const logs = db
                .prepare(`
                    SELECT id, conversationId, agentId, agentThreadId, parentRequestId, depth,
                           provider, model, status, startedAt, endedAt, durationMs,
                           toolCallCount, interactionId, errorMessage, inputText, outputText
                    FROM request_logs
                    ORDER BY startedAt ASC
                `)
                .all() as RequestLogIndexRow[]

            for (const row of logs) {
                appendRuntimeRequestLogIndex(row)
            }

            console.log(`Rebuilt runtime index for ${profileId} at ${root}`)
            console.log(`Indexed ${runs.length} scheduled task run(s) and ${logs.length} agent log(s).`)
        }
    )
}

const args = process.argv.slice(2)
const profileFlagIndex = args.indexOf('--profile')
const requestedProfile = profileFlagIndex >= 0 ? args[profileFlagIndex + 1] : null
if (profileFlagIndex >= 0 && !requestedProfile) {
    throw new Error('--profile requires a profile id.')
}

const profileIds = args.includes('--all-profiles')
    ? listProfiles({ includeDisabled: true }).map((profile) => profile.id)
    : [normalizeProfileId(requestedProfile ?? ADMIN_PROFILE_ID)]

for (const profileId of profileIds) rebuildProfile(profileId)
