import { randomUUID } from 'crypto'

import type { ToolExecutionContext } from '@/lib/ai/agents/types'
import { getActiveProfileId } from '@/lib/profiles/context'

export interface SynchronousDelegationJob {
    agentId: string
    agentThreadId: string
    assignedName?: string
    taskLabel?: string
}

export interface SynchronousDelegationSnapshot {
    id: string
    kind: 'synchronous'
    tool: 'delegate_to' | 'delegate_parallel'
    status: 'running' | 'cancelling'
    startedAt: number
    jobs: SynchronousDelegationJob[]
}

interface RuntimeSynchronousDelegation extends SynchronousDelegationSnapshot {
    profileId: string
    conversationId: string
    createdByAgentId: string
    parentAgentThreadId: string | null
    parentRequestId: string
    controller: AbortController
    cancelRequestedAt?: number
}

const globalForSynchronousDelegations = globalThis as unknown as {
    __orchestratorSynchronousDelegations?: Map<string, RuntimeSynchronousDelegation>
}

const activeDelegations = globalForSynchronousDelegations.__orchestratorSynchronousDelegations
    ?? new Map<string, RuntimeSynchronousDelegation>()
if (!globalForSynchronousDelegations.__orchestratorSynchronousDelegations) {
    globalForSynchronousDelegations.__orchestratorSynchronousDelegations = activeDelegations
}

function runtimeKey(profileId: string, id: string): string {
    return `${profileId}:${id}`
}

function inCallerScope(entry: RuntimeSynchronousDelegation, ctx: ToolExecutionContext): boolean {
    return entry.profileId === getActiveProfileId()
        && entry.conversationId === ctx.conversationId
        && entry.createdByAgentId === ctx.callerAgentId
        && entry.parentAgentThreadId === (ctx.agentThreadId ?? null)
        && entry.parentRequestId === ctx.parentRequestId
}

function snapshot(entry: RuntimeSynchronousDelegation): SynchronousDelegationSnapshot {
    return {
        id: entry.id,
        kind: 'synchronous',
        tool: entry.tool,
        status: entry.cancelRequestedAt ? 'cancelling' : 'running',
        startedAt: entry.startedAt,
        jobs: entry.jobs.map(job => ({ ...job })),
    }
}

/**
 * Register a structurally synchronous delegation while it is in flight.
 *
 * The child still returns through the original delegate tool call. The
 * registry exists solely so an explicitly steered root can inspect or cancel
 * obsolete child work while the provider keeps that tool request open.
 */
export function beginSynchronousDelegation(args: {
    ctx: ToolExecutionContext
    tool: 'delegate_to' | 'delegate_parallel'
    jobs: SynchronousDelegationJob[]
}): {
    id: string
    signal: AbortSignal
    finish: () => void
} {
    const profileId = getActiveProfileId()
    const id = `sdb_${randomUUID()}`
    const controller = new AbortController()
    const entry: RuntimeSynchronousDelegation = {
        id,
        kind: 'synchronous',
        tool: args.tool,
        status: 'running',
        startedAt: Date.now(),
        profileId,
        conversationId: args.ctx.conversationId,
        createdByAgentId: args.ctx.callerAgentId,
        parentAgentThreadId: args.ctx.agentThreadId ?? null,
        parentRequestId: args.ctx.parentRequestId,
        jobs: args.jobs.map(job => ({ ...job })),
        controller,
    }
    activeDelegations.set(runtimeKey(profileId, id), entry)

    const onParentAbort = () => controller.abort(args.ctx.signal?.reason)
    if (args.ctx.signal?.aborted) onParentAbort()
    else args.ctx.signal?.addEventListener('abort', onParentAbort, { once: true })

    let finished = false
    return {
        id,
        signal: controller.signal,
        finish() {
            if (finished) return
            finished = true
            args.ctx.signal?.removeEventListener('abort', onParentAbort)
            activeDelegations.delete(runtimeKey(profileId, id))
        },
    }
}

export function listSynchronousDelegationsForCaller(
    ctx: ToolExecutionContext,
): SynchronousDelegationSnapshot[] {
    return [...activeDelegations.values()]
        .filter(entry => inCallerScope(entry, ctx))
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(snapshot)
}

export function cancelSynchronousDelegation(
    id: string,
    ctx: ToolExecutionContext,
): SynchronousDelegationSnapshot | null {
    const entry = activeDelegations.get(runtimeKey(getActiveProfileId(), id))
    if (!entry || !inCallerScope(entry, ctx)) return null
    if (!entry.cancelRequestedAt) {
        entry.cancelRequestedAt = Date.now()
        entry.controller.abort(new Error('Cancelled by the parent orchestrator after user steering.'))
    }
    return snapshot(entry)
}

export const synchronousDelegationTestHooks = {
    clear() {
        for (const entry of activeDelegations.values()) entry.controller.abort()
        activeDelegations.clear()
    },
}
