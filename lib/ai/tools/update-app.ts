import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { queueUpdate } from '@/lib/update/manager'

// Tool the orchestrator calls AFTER the user confirms they want to apply a
// pending update. The `<pending_update>` runtime block tells the orchestrator
// when an update exists and instructs it to propose the update once per
// conversation; this tool actually queues the managed update job, which
// shuts the app down, reinstalls, and restarts. The boot hook then posts a
// follow-up assistant message back into this same conversation so the user
// sees the confirmation inline next time they reopen the chat.
export const applyUpdateTool: ToolDef = {
    id: 'apply_update',
    name: 'apply_update',
    description: [
        'Queue the in-app managed self-update to the latest GitHub Release shown in <pending_update>. This tool is release-only: it does not deploy arbitrary commits from master/main.',
        'If the user asks to run a specific pushed commit or says code is on master/main but no newer GitHub Release is available, explain that a tag/GitHub Release must be published first (or an explicit branch update path must be used outside this tool). Do not call apply_update for that case.',
        'Only call this AFTER the user has explicitly confirmed they want to update right now (e.g. "da", "yes", "update"). Do not call this on your own initiative or as part of proposing the update — first describe what would happen, then wait for confirmation.',
        'The app will finish the current chat turn, then close active runs and restart. The next message the user sees in this conversation will be auto-posted by the boot hook once the new build is confirmed.',
        'Returns the queued job summary. After it returns, send ONE short message to the user telling them the update is starting and the app will reconnect shortly; do not keep working on other tasks in the same turn.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            confirmed_by_user: {
                type: 'boolean',
                description: 'Must be true. Set only when the user just confirmed they want to apply the update right now. If you are unsure, ask the user instead of calling this tool.',
            },
        },
        required: ['confirmed_by_user'],
    },
    tags: ['system'],
}

export async function executeApplyUpdate(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext,
): Promise<ToolResult> {
    if (args.confirmed_by_user !== true) {
        return {
            success: false,
            error: 'apply_update requires confirmed_by_user=true. Ask the user before calling.',
        }
    }
    try {
        const status = await queueUpdate({
            mode: 'release',
            initiatedFromConversationId: ctx?.conversationId,
        })
        const job = status.job
        return {
            success: true,
            data: {
                queued: Boolean(job),
                jobId: job?.id ?? null,
                phase: job?.phase ?? 'idle',
                targetVersion: job?.targetVersion ?? status.latest?.version ?? null,
                targetTag: job?.targetTag ?? status.latest?.tag ?? null,
                waitReason: job?.waitReason ?? null,
                currentVersion: status.current.version,
                followUpConversationId: ctx?.conversationId ?? null,
                note: 'Update queued. Tell the user the app will reconnect after restart and the new build will post a confirmation back into this chat.',
            },
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to queue update.'
        const error = message === 'The installed version is already up to date.'
            ? 'The installed version is already up to date. apply_update only sees newer GitHub Releases, not raw commits pushed to master/main; publish a newer release first or use an explicit branch update path.'
            : message
        return {
            success: false,
            error,
        }
    }
}
