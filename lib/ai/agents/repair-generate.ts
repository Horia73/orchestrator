import { randomUUID } from 'crypto'
import { artifactRepairAgent } from './artifact-repair'
import { runTextSubAgent } from './runner'
import {
    repairMessageArtifacts,
    type RepairMessageArtifactsResult,
} from '@/lib/artifacts/repair-message'

// ---------------------------------------------------------------------------
// Binds the pure validate+repair pass (lib/artifacts/repair-message.ts) to the
// Artifact Repair agent for background surfaces. The chat route keeps its own
// streaming-aware wiring; scheduled runs, microscripts, and inline Inbox
// replies call `repairMessageArtifactsWithAgent` right before they store the
// assistant message.
// ---------------------------------------------------------------------------

export interface RepairMessageWithAgentArgs {
    /** Complete assistant message content about to be stored. */
    content: string
    /** Conversation the repair sub-agent run is logged under. */
    conversationId: string
    /** Caller label for log lines: 'scheduled-run' | 'microscript' | 'inbox-reply'. */
    surface: string
    /** request_logs id of the run that produced the content, when available. */
    parentRequestId?: string
    /** Scheduled task id, when the content came from a scheduled run. */
    scheduledTaskId?: string
    appOrigin?: string
    signal?: AbortSignal
}

/**
 * Validate + repair every strict-schema artifact in `content` using the
 * Artifact Repair agent. Never throws: on any unexpected failure it returns
 * the original content so the calling surface still delivers its message
 * (persist will then reject the broken artifact exactly as before).
 */
export async function repairMessageArtifactsWithAgent(
    args: RepairMessageWithAgentArgs,
): Promise<RepairMessageArtifactsResult> {
    const parentRequestId = args.parentRequestId ?? `artifact_repair_${randomUUID()}`
    try {
        return await repairMessageArtifacts({
            content: args.content,
            surface: args.surface,
            generate: async (userPrompt) => {
                const result = await runTextSubAgent({
                    target: artifactRepairAgent,
                    prompt: userPrompt,
                    parentCtx: {
                        callerAgentId: artifactRepairAgent.id,
                        depth: 0,
                        conversationId: args.conversationId,
                        parentRequestId,
                        signal: args.signal,
                        appOrigin: args.appOrigin,
                        scheduledTaskId: args.scheduledTaskId,
                    },
                })
                if (!result.success) return null
                const data = result.data as { output?: unknown } | undefined
                return typeof data?.output === 'string' ? data.output : null
            },
        })
    } catch (error) {
        console.warn(
            `[artifact-repair] surface=${args.surface} pass crashed; delivering original content`,
            error,
        )
        return { content: args.content, repaired: [], failed: [] }
    }
}
