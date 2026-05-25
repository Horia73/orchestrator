import fs from 'fs'
import path from 'path'

import type { AgentKind, ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import { MAX_AGENT_DEPTH } from '@/lib/ai/agents/types'
import { getAgent } from '@/lib/ai/agents/registry'
import { createAgentThread, getAgentThread, type AgentThread } from '@/lib/db'

// Lazy import for runner: it pulls in tools/registry, and we sit inside that
// graph too. Eager top-level import causes a circular evaluation deadlock —
// import on first delegation call instead.

export const delegateToTool: ToolDef = {
    id: 'delegate_to',
    name: 'delegate_to',
    description: [
        'Delegate a task to a specialist sub-agent and wait for its final answer.',
        'Use this when the task is outside your remit, when a specialist would do better, or when you want a fresh perspective on your own output.',
        'Returns the sub-agent\'s complete response and agent_thread_id. Pass thread_id to continue an existing parent↔agent thread; omit it to create a new one.',
        'For browser_agent, the prompt must be self-contained: site/link, goal, allowed data, forbidden data, account/session assumptions, exact stop boundary, confirmation status, screenshot/video needs, and expected evidence. Reuse thread_id to continue the same browser state.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            agent_id: {
                type: 'string',
                description: 'Id of the sub-agent to invoke. Must be one of the agents listed in <runtime_agents>.',
            },
            prompt: {
                type: 'string',
                description: 'Message to send into the parent↔agent thread. Include user-chat context only when the agent needs it; the agent sees this thread, not the user conversation.',
            },
            thread_id: {
                type: 'string',
                description: 'Optional existing agent_thread_id to continue. It must belong to this conversation, target agent, and caller scope.',
            },
            thread_title: {
                type: 'string',
                description: 'Optional short title for a new thread. Ignored when thread_id is provided.',
            },
            cwd: {
                type: 'string',
                description: 'Optional absolute working directory for CLI-backed agents such as coder. Use for isolated project worktrees prepared by the orchestrator.',
            },
        },
        required: ['agent_id', 'prompt'],
    },
    tags: ['delegation'],
}

export const delegateParallelTool: ToolDef = {
    id: 'delegate_parallel',
    name: 'delegate_parallel',
    description: [
        'Delegate multiple independent tasks to specialist sub-agents concurrently and wait for all final answers.',
        'Use only for workstreams that do not depend on each other and do not mutate the same files or external systems.',
        'Each job may pass thread_id to continue an existing parent↔agent thread, or omit it to create a new one.',
        'Browser_agent jobs must include a complete action contract and stop boundary. Reuse thread_id for the same browser flow; use separate threads only for independent flows. Do not parallelize browser jobs that can create duplicate orders/bookings/sends or mutate the same external account.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            jobs: {
                type: 'array',
                description: 'Independent delegation jobs. Maximum 6 per call; default concurrency is 6.',
                items: {
                    type: 'object',
                    properties: {
                        agent_id: {
                            type: 'string',
                            description: 'Id of the sub-agent to invoke. Must be one of the agents listed in <runtime_agents>.',
                        },
                        prompt: {
                            type: 'string',
                            description: 'Message to send into that parent↔agent thread.',
                        },
                        thread_id: {
                            type: 'string',
                            description: 'Optional existing agent_thread_id to continue.',
                        },
                        thread_title: {
                            type: 'string',
                            description: 'Optional short title for a new thread.',
                        },
                        cwd: {
                            type: 'string',
                            description: 'Optional absolute working directory for this job when invoking CLI-backed agents.',
                        },
                    },
                    required: ['agent_id', 'prompt'],
                },
            },
            max_concurrency: {
                type: 'integer',
                description: 'Optional concurrency limit. Defaults to 6 and is capped at 6.',
            },
        },
        required: ['jobs'],
    },
    tags: ['delegation'],
}

export async function executeDelegateTo(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext
): Promise<ToolResult> {
    const plan = planDelegation(args, ctx)
    if (!plan.ok) return { success: false, error: plan.error }
    const prepared = materializeDelegation(plan)

    const result = await runPreparedDelegation(prepared, ctx!)
    if (result.success && result.data && typeof result.data === 'object') {
        return {
            ...result,
            data: {
                ...(result.data as Record<string, unknown>),
                agentThreadId: prepared.thread.id,
                agent_thread_id: prepared.thread.id,
            },
        }
    }
    return result.success
        ? result
        : {
            ...result,
            error: `${result.error ?? 'Delegation failed'} (agent_thread_id: ${prepared.thread.id})`,
            data: {
                agentId: prepared.target.id,
                agentThreadId: prepared.thread.id,
                agent_thread_id: prepared.thread.id,
            },
        }
}

export async function executeDelegateParallel(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext
): Promise<ToolResult> {
    if (!ctx) {
        return { success: false, error: 'delegate_parallel requires an execution context (caller agent + depth)' }
    }
    if (ctx.depth >= MAX_AGENT_DEPTH) {
        return {
            success: false,
            error: `Delegation refused: depth ${ctx.depth} would exceed cap of ${MAX_AGENT_DEPTH}. Solve the task directly.`,
        }
    }

    const rawJobs = args.jobs
    if (!Array.isArray(rawJobs) || rawJobs.length === 0) {
        return { success: false, error: 'delegate_parallel expects a non-empty jobs array.' }
    }
    if (rawJobs.length > MAX_PARALLEL_DELEGATIONS) {
        return { success: false, error: `delegate_parallel accepts at most ${MAX_PARALLEL_DELEGATIONS} jobs per call.` }
    }

    const plans = rawJobs.map((job, index) => {
        if (!job || typeof job !== 'object') {
            return { ok: false as const, error: `Job ${index + 1} must be an object.` }
        }
        return planDelegation(job as Record<string, unknown>, ctx)
    })
    const invalid = plans.find(item => !item.ok)
    if (invalid && !invalid.ok) return { success: false, error: invalid.error }

    const validPlans = plans.filter((item): item is Extract<DelegationPlan, { ok: true }> => item.ok)
    const seenThreadIds = new Set<string>()
    for (const plan of validPlans) {
        if (!plan.thread?.id) continue
        if (seenThreadIds.has(plan.thread.id)) {
            return { success: false, error: `delegate_parallel cannot run multiple jobs against the same agent thread (${plan.thread.id}) at the same time.` }
        }
        seenThreadIds.add(plan.thread.id)
    }
    const jobs = validPlans.map(materializeDelegation)
    const requestedConcurrency = typeof args.max_concurrency === 'number'
        ? Math.floor(args.max_concurrency)
        : MAX_PARALLEL_DELEGATIONS
    const concurrency = Math.max(1, Math.min(requestedConcurrency, MAX_PARALLEL_DELEGATIONS, jobs.length))

    const results = await mapWithConcurrency(jobs, concurrency, async (job, index) => {
        const result = await runPreparedDelegation(job, ctx)
        return {
            index,
            success: result.success,
            agentId: job.target.id,
            agentThreadId: job.thread.id,
            agent_thread_id: job.thread.id,
            output: result.success && result.data && typeof result.data === 'object'
                ? (result.data as Record<string, unknown>).output
                : undefined,
            data: result.data,
            error: result.error,
        }
    })

    const failed = results.filter(result => !result.success)
    return {
        success: failed.length === 0,
        data: {
            concurrency,
            results,
        },
        error: failed.length > 0 ? `${failed.length} of ${results.length} delegated jobs failed.` : undefined,
    }
}

const MAX_PARALLEL_DELEGATIONS = 6

type PreparedDelegation =
    {
        target: NonNullable<ReturnType<typeof getAgent>>
        prompt: string
        thread: AgentThread
        cwd?: string
    }

type DelegationPlan =
    | {
        ok: true
        target: NonNullable<ReturnType<typeof getAgent>>
        prompt: string
        cwd?: string
        thread?: AgentThread
        newThread: {
            conversationId: string
            agentId: string
            createdByAgentId: string
            parentAgentThreadId: string | null
            title: string
        }
    }
    | {
        ok: false
        error: string
    }

function planDelegation(args: Record<string, unknown>, ctx?: ToolExecutionContext): DelegationPlan {
    if (!ctx) {
        return { ok: false, error: 'delegate_to requires an execution context (caller agent + depth)' }
    }
    if (ctx.depth >= MAX_AGENT_DEPTH) {
        return {
            ok: false,
            error: `Delegation refused: depth ${ctx.depth} would exceed cap of ${MAX_AGENT_DEPTH}. Solve the task directly.`,
        }
    }

    const agentId = args.agent_id
    const prompt = args.prompt
    const threadId = args.thread_id
    const threadTitle = args.thread_title
    const cwdPlan = normalizeDelegationCwd(args.cwd)
    if (!cwdPlan.ok) return { ok: false, error: cwdPlan.error }
    if (typeof agentId !== 'string' || typeof prompt !== 'string' || !prompt.trim()) {
        return { ok: false, error: 'delegate_to expects { agent_id: string, prompt: non-empty string }' }
    }

    const caller = getAgent(ctx.callerAgentId)
    if (!caller) {
        return { ok: false, error: `Caller agent ${ctx.callerAgentId} not found in registry` }
    }
    if (!caller.canCallAgents?.includes(agentId)) {
        return {
            ok: false,
            error: `${caller.id} cannot delegate to ${agentId}. Allowed: ${(caller.canCallAgents ?? []).join(', ') || 'none'}`,
        }
    }

    const target = getAgent(agentId)
    if (!target) {
        return { ok: false, error: `Unknown sub-agent: ${agentId}` }
    }
    if (target.status === 'planned') {
        return { ok: false, error: `Sub-agent ${agentId} is planned but not implemented yet.` }
    }

    let thread: AgentThread | undefined
    const newThread = {
        conversationId: ctx.conversationId,
        agentId: target.id,
        createdByAgentId: caller.id,
        parentAgentThreadId: ctx.agentThreadId ?? null,
        title: typeof threadTitle === 'string' && threadTitle.trim()
            ? threadTitle
            : prompt.trim().slice(0, 80),
    }
    if (typeof threadId === 'string' && threadId.trim()) {
        const existing = getAgentThread(threadId.trim())
        if (!existing) return { ok: false, error: `Unknown agent thread: ${threadId}` }
        if (existing.status !== 'active') return { ok: false, error: `Agent thread ${threadId} is archived.` }
        if (existing.conversationId !== ctx.conversationId) {
            return { ok: false, error: `Agent thread ${threadId} does not belong to this conversation.` }
        }
        if (existing.agentId !== target.id) {
            return { ok: false, error: `Agent thread ${threadId} belongs to ${existing.agentId}, not ${target.id}.` }
        }
        if (existing.createdByAgentId !== caller.id) {
            return { ok: false, error: `Agent thread ${threadId} was created by ${existing.createdByAgentId}, not ${caller.id}.` }
        }
        const expectedParent = ctx.agentThreadId ?? null
        if ((existing.parentAgentThreadId ?? null) !== expectedParent) {
            return { ok: false, error: `Agent thread ${threadId} is outside this caller's thread scope.` }
        }
        thread = existing
    }

    return { ok: true, target, prompt: prompt.trim(), cwd: cwdPlan.cwd, thread, newThread }
}

function materializeDelegation(plan: Extract<DelegationPlan, { ok: true }>): PreparedDelegation {
    return {
        target: plan.target,
        prompt: plan.prompt,
        cwd: plan.cwd,
        thread: plan.thread ?? createAgentThread(plan.newThread),
    }
}

async function runPreparedDelegation(
    prepared: PreparedDelegation,
    ctx: ToolExecutionContext
): Promise<ToolResult> {
    const runner = await import('@/lib/ai/agents/runner')
    return isTextRuntimeKind(prepared.target.kind)
        ? runner.runTextSubAgent({
            target: prepared.target,
            prompt: prepared.prompt,
            parentCtx: ctx,
            agentThreadId: prepared.thread.id,
            cwd: prepared.cwd,
        })
        : runner.runMediaSubAgent({
            target: prepared.target,
            prompt: prepared.prompt,
            parentCtx: ctx,
            agentThreadId: prepared.thread.id,
        })
}

function isTextRuntimeKind(kind: AgentKind): boolean {
    return kind === 'text' || kind === 'concierge'
}

function normalizeDelegationCwd(value: unknown): { ok: true; cwd?: string } | { ok: false; error: string } {
    if (value === undefined || value === null || value === '') return { ok: true }
    if (typeof value !== 'string') return { ok: false, error: 'cwd must be a string when provided.' }
    const clean = value.trim()
    if (!clean) return { ok: true }
    if (!path.isAbsolute(clean)) return { ok: false, error: 'cwd must be an absolute path.' }

    let stat: fs.Stats
    try {
        stat = fs.statSync(clean)
    } catch {
        return { ok: false, error: `cwd does not exist: ${clean}` }
    }
    if (!stat.isDirectory()) return { ok: false, error: `cwd is not a directory: ${clean}` }
    return { ok: true, cwd: path.resolve(clean) }
}

async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let next = 0
    async function worker() {
        for (;;) {
            const index = next++
            if (index >= items.length) return
            results[index] = await mapper(items[index], index)
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    return results
}
